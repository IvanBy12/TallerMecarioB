'use strict';

/**
 * S1-03 — lifecycle worker end to end against the migrated disposable DB:
 * signed webhook -> ingest (tallermecario_api) -> outbox -> phased worker
 * (tallermecario_worker) -> identity_sync_apply -> per-tenant revocation jobs
 * under TenantContext + RLS -> access decisions through the real S1-02 API.
 *
 * The Clerk Backend API is a scripted fake behind the REAL snapshot mapping
 * (ClerkIdentitySnapshotSource). The worker pool is instrumented so the
 * "no DB transaction across the network" rule is asserted at the exact moment
 * the fake provider call is in flight, from two independent vantage points
 * (client-side transaction/connection bookkeeping and pg_stat_activity).
 */

const h = require('./helpers.cjs');
const { after, before, beforeEach, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

const { assert, admin, load } = h;
const workerModule = load('worker/outbox-worker.js');
const { buildApi, getTenantRequestContext } = load('api/app.js');
const { ClerkIdentityProvider, ClerkIdentitySnapshotSource } = load('identity/clerk/clerk-identity-provider.js');
const { PostgresClerkWebhookRepository, registerClerkWebhookRoute } = load('identity/webhook-routes.js');
const { createIdentityLifecycleHandler, IDENTITY_LIFECYCLE_EVENT_TYPE } = load('identity/sync/lifecycle-sync.js');
const { createMembershipRevocationHandler, MEMBERSHIP_REVOCATION_EVENT_TYPE } = load('identity/sync/membership-revocation.js');

const WORKER_LOGIN = process.env.TEST_WORKER_LOGIN;
const apiPool = h.runtimePool('api', 6);
const rawWorkerPool = h.runtimePool('worker', 6);
const users = new h.FakeClerkUsers();
const source = new ClerkIdentitySnapshotSource({ secretKey: 'sk_test_hermetic', backendApiTimeoutMs: 200 }, { usersApi: users });
const webhookSecret = h.newWebhookSecret();
const repository = new PostgresClerkWebhookRepository(apiPool);

/* -------------------------------------------------------------------------- */
/* Instrumented worker pool: open transactions + held connections             */
/* -------------------------------------------------------------------------- */

const probe = { reservedHeld: 0, openTransactions: 0 };

function instrument(pool) {
  function wrapReserved(connection) {
    let released = false;
    return new Proxy(connection, {
      get(target, prop) {
        if (prop === 'unsafe') {
          return async (query, ...rest) => {
            const command = String(query).trim().toUpperCase();
            if (command === 'COMMIT' || command === 'ROLLBACK') {
              try {
                return await target.unsafe(query, ...rest);
              } finally {
                probe.openTransactions -= 1;
              }
            }
            const result = await target.unsafe(query, ...rest);
            if (command === 'BEGIN') probe.openTransactions += 1;
            return result;
          };
        }
        if (prop === 'release') {
          return () => {
            if (!released) {
              released = true;
              probe.reservedHeld -= 1;
            }
            return target.release();
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === 'reserve') {
        return async () => {
          const connection = await target.reserve();
          probe.reservedHeld += 1;
          return wrapReserved(connection);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const workerPool = instrument(rawWorkerPool);

/** Evidence captured while a provider call is in flight. */
async function transactionEvidence() {
  const client = { reservedHeld: probe.reservedHeld, openTransactions: probe.openTransactions };
  const server = await admin`
    SELECT pid, state, xact_start IS NOT NULL AS in_transaction
    FROM pg_catalog.pg_stat_activity
    WHERE usename = ${WORKER_LOGIN} AND datname = pg_catalog.current_database()
  `;
  return { client, serverInTransaction: server.filter((row) => row.in_transaction || row.state === 'idle in transaction').length };
}

/* -------------------------------------------------------------------------- */
/* Worker options, ingest, API                                                */
/* -------------------------------------------------------------------------- */

const applied = [];
const revocations = [];
function workerOptions(overrides = {}) {
  return {
    database: workerPool,
    handlers: { [MEMBERSHIP_REVOCATION_EVENT_TYPE]: createMembershipRevocationHandler({ onOutcome: (o) => revocations.push(o) }) },
    phasedHandlers: {
      [IDENTITY_LIFECYCLE_EVENT_TYPE]: createIdentityLifecycleHandler({
        source, workerId: 'worker-test', onApplied: (result) => applied.push(result),
      }),
    },
    maxAttempts: 3,
    baseDelaySeconds: 3600,
    ...overrides,
  };
}

const drain = (overrides) => h.drainOutbox(workerModule, workerOptions(overrides));

/** Ingest exactly like the webhook route does after signature verification. */
async function ingest(type, subject, occurredAtMs, providerEventId = `msg_${randomUUID().replaceAll('-', '')}`) {
  const result = await repository.ingest({
    kind: 'supported',
    providerEventId,
    eventType: type,
    externalSubject: subject,
    occurredAt: new Date(occurredAtMs),
    payloadHash: h.sha256Hex(`${providerEventId}|${type}|${subject}|${occurredAtMs}`),
    headers: { svix_id: providerEventId, svix_timestamp: String(Math.floor(occurredAtMs / 1000)) },
  }, { webhookEventId: randomUUID(), outboxEventId: randomUUID(), requestId: randomUUID() });
  assert.equal(result, 'accepted');
  return providerEventId;
}

const handlerCalls = { read: 0 };
let app;

async function tenantRead(subject, tenantId) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/__s103/read',
    headers: { authorization: `Bearer ${h.sessionToken(subject)}`, ...(tenantId ? { 'x-tenant-id': tenantId } : {}) },
  });
}

async function userRow(subject) {
  const [row] = await admin`
    SELECT id, email, full_name, status FROM public.users
    WHERE identity_provider = 'clerk' AND external_subject = ${subject}
  `;
  return row ?? null;
}

async function syncState(subject) {
  const [row] = await admin`
    SELECT user_id, lifecycle_state, last_event_id, last_event_type, last_event_rank, deleted_at
    FROM public.identity_sync_states WHERE identity_provider = 'clerk' AND external_subject = ${subject}
  `;
  return row ?? null;
}

async function outboxFor(providerEventId) {
  const [row] = await admin`
    SELECT id, status, attempts, available_at, last_error
    FROM public.outbox_events WHERE payload_json ->> 'provider_event_id' = ${providerEventId}
  `;
  return row;
}

async function membershipStatus(membershipId) {
  const [row] = await admin`SELECT status, revoked_at FROM public.memberships WHERE id = ${membershipId}`;
  return row;
}

async function auditActions(entityId) {
  return admin`
    SELECT tenant_id, actor_type, action, outcome, reason_code, before_json, after_json, metadata_json
    FROM public.audit_logs WHERE entity_id = ${entityId} ORDER BY created_at, id
  `;
}

before(async () => {
  app = await buildApi({
    database: apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: users }),
    rateLimit: { max: 10_000, timeWindow: '1 minute' },
    registerPublicRoutes(server) {
      registerClerkWebhookRoute(server, { signingSecret: webhookSecret, repository });
    },
    registerRoutes(server) {
      server.get('/api/v1/__s103/read', { config: { permission: 'workshop.read' } }, async (request) => {
        handlerCalls.read += 1;
        return { tenantId: getTenantRequestContext(request).tenant.tenantId };
      });
    },
  });
});

beforeEach(async () => {
  // Isolate each test's outbox: nothing claimable is left from earlier tests/suites.
  await admin`
    UPDATE public.outbox_events SET status = 'processed', processed_at = now(), updated_at = now()
    WHERE status IN ('pending', 'processing')
  `;
});

after(async () => {
  if (app) await app.close();
  await apiPool.end({ timeout: 5 });
  await rawWorkerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('phases: the provider call never runs inside a PostgreSQL transaction', () => {
  test('PROOF: while getUser is pending there is no open transaction and no held connection (client + pg_stat_activity)', async () => {
    const subject = h.newSubject('proof');
    users.put(h.clerkUser(subject));
    let evidence;
    const release = h.deferred();
    const inFlight = h.deferred();
    users.script(subject, async () => {
      evidence = await transactionEvidence();
      inFlight.resolve();
      await release.promise;
      return users.users.get(subject);
    });
    await ingest('user.created', subject, Date.now());

    const draining = drain();
    await inFlight.promise;
    // A second, independent look while the call is still pending.
    const whilePending = await transactionEvidence();
    release.resolve();
    await draining;

    for (const snapshot of [evidence.client, whilePending.client]) {
      assert.deepEqual(snapshot, { reservedHeld: 0, openTransactions: 0 }, 'no BEGIN without COMMIT/ROLLBACK and no reserved connection');
    }
    assert.equal(evidence.serverInTransaction, 0, 'pg_stat_activity: no worker backend inside a transaction');
    assert.equal(whilePending.serverInTransaction, 0);
    assert.equal((await userRow(subject)).status, 'active', 'PHASE C still applied afterwards');
    assert.deepEqual(probe, { reservedHeld: 0, openTransactions: 0 });
  });

  test('NEGATIVE CONTROL: the same detector flags a handler that fetches between BEGIN and COMMIT', async () => {
    const subject = h.newSubject('negative');
    users.put(h.clerkUser(subject));
    let evidence;
    users.script(subject, async () => {
      evidence = await transactionEvidence();
      return users.users.get(subject);
    });
    await ingest('user.created', subject, Date.now());
    // Deliberately wrong: the provider call inside the classic single-transaction path.
    const wrong = async () => { await source.fetchIdentitySnapshot(subject); };
    await h.drainOutbox(workerModule, { database: workerPool, handlers: { [IDENTITY_LIFECYCLE_EVENT_TYPE]: wrong } });
    assert.equal(evidence.client.openTransactions, 1, 'detector sees the open transaction');
    assert.equal(evidence.client.reservedHeld, 1);
    assert.equal(evidence.serverInTransaction, 1, 'pg_stat_activity sees it too');
  });

  test('RECHECK AFTER NETWORK: a newer event applied while an older fetch was pending wins; the old snapshot is discarded', async () => {
    const subject = h.newSubject('recheck');
    users.put(h.clerkUser(subject, { email: 'newest@example.test' }));
    const t0 = Date.now();
    const olderId = await ingest('user.updated', subject, t0);
    const newerId = await ingest('user.updated', subject, t0 + 1000);
    const jobs = await workerModule.claimBatch(workerPool, 10);
    assert.equal(jobs.length, 2);

    const release = h.deferred();
    const inFlight = h.deferred();
    users.script(subject, async () => {
      inFlight.resolve();
      await release.promise;
      return h.clerkUser(subject, { email: 'stale-snapshot@example.test' });
    });

    const byEvent = {};
    for (const job of jobs) {
      const [row] = await admin`SELECT payload_json ->> 'provider_event_id' AS id FROM public.outbox_events WHERE id = ${job.outboxEventId}`;
      byEvent[row.id] = job;
    }
    const olderRun = workerModule.processClaimedJob(workerOptions(), byEvent[olderId]);
    await inFlight.promise;
    const newer = await workerModule.processClaimedJob(workerOptions(), byEvent[newerId]);
    assert.equal(newer.outcome, 'processed');
    release.resolve();
    const older = await olderRun;
    assert.equal(older.outcome, 'processed', 'stale work completes as a no-op, it is not retried');

    const results = applied.filter((entry) => [byEvent[olderId].outboxEventId, byEvent[newerId].outboxEventId].includes(entry.outboxEventId));
    assert.equal(results.find((entry) => entry.outboxEventId === byEvent[olderId].outboxEventId).result, 'stale');
    assert.equal((await userRow(subject)).email, 'newest@example.test');
    assert.equal((await syncState(subject)).last_event_id, newerId);
  });
});

describe('fetch-on-process and profile projection', () => {
  test('user.created end to end: signed webhook payload says old@, Clerk now says new@ -> new@ is persisted; no tenant/membership/role created', async () => {
    const subject = h.newSubject('fop');
    users.put(h.clerkUser(subject, { email: '  New.Address@Example.TEST ', firstName: '  María  ', lastName: 'José' }));
    const delivery = h.signedDelivery(webhookSecret, h.clerkEventBody('user.created', subject, Date.now(), { email: 'old@example.test' }));
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/clerk', headers: delivery.headers, payload: delivery.body });
    assert.equal(response.statusCode, 204);
    const callsBefore = users.calls.length;
    await drain();
    assert.equal(users.calls.length - callsBefore, 1, 'exactly one Backend API fetch per lifecycle event');

    const row = await userRow(subject);
    assert.equal(row.email, 'new.address@example.test');
    assert.equal(row.full_name, 'María José'.normalize('NFC'), 'NFC + trim + whitespace collapse');
    assert.equal(row.status, 'active');
    const [{ memberships }] = await admin`SELECT count(*)::int AS memberships FROM public.memberships WHERE user_id = ${row.id}`;
    assert.equal(memberships, 0, 'provider data never creates memberships');
    const audits = await auditActions(row.id);
    assert.deepEqual(audits.map((a) => a.action), ['identity.user_provisioned_webhook']);
    assert.equal(audits[0].tenant_id, null);
    assert.equal(audits[0].actor_type, 'provider');
    assert.deepEqual(Object.keys(audits[0].metadata_json).sort(), ['identity_provider', 'provider_event_type', 'status']);
    const state = await syncState(subject);
    assert.equal(state.lifecycle_state, 'active');
    assert.equal(state.last_event_id, delivery.id);
    const [attempt] = await admin`
      SELECT a.status, a.attempt_number FROM public.webhook_processing_attempts AS a
      JOIN public.webhook_events AS w ON w.id = a.webhook_event_id WHERE w.provider_event_id = ${delivery.id}
    `;
    assert.deepEqual({ ...attempt }, { status: 'succeeded', attempt_number: 1 });
  });

  test('snapshot mapping uses the PRIMARY address and only when verified; metadata/phones/avatars/orgs are not part of it', async () => {
    const subject = h.newSubject('map');
    users.put(h.clerkUser(subject, { email: 'primary@example.test', decoyFirst: 'first@example.test' }));
    const snapshot = await source.fetchIdentitySnapshot(subject);
    assert.deepEqual(Object.keys(snapshot).sort(), ['banned', 'fullName', 'kind', 'locked', 'verifiedPrimaryEmail']);
    assert.equal(snapshot.verifiedPrimaryEmail, 'primary@example.test');

    const unverified = h.newSubject('mapu');
    users.put(h.clerkUser(unverified, { email: 'primary-unverified@example.test', verified: false, decoyFirst: 'verified@example.test' }));
    assert.equal((await source.fetchIdentitySnapshot(unverified)).verifiedPrimaryEmail, null);
    const none = h.newSubject('mapn');
    users.put(h.clerkUser(none, { email: null }));
    assert.equal((await source.fetchIdentitySnapshot(none)).verifiedPrimaryEmail, null);
  });

  test('user.created without a verified primary email creates no local user (JIT/onboarding still require one)', async () => {
    const subject = h.newSubject('noverify');
    users.put(h.clerkUser(subject, { verified: false }));
    await ingest('user.created', subject, Date.now());
    await drain();
    assert.equal(await userRow(subject), null);
    assert.equal((await syncState(subject)).lifecycle_state, 'active');
  });

  test('user.updated syncs only verified primary email + sanitized name; audit carries field names, never values', async () => {
    const subject = h.newSubject('upd');
    users.put(h.clerkUser(subject, { email: 'before@example.test', firstName: 'Before', lastName: null }));
    await ingest('user.created', subject, Date.now() - 5000);
    await drain();
    users.put(h.clerkUser(subject, { email: 'after@example.test', firstName: `Bad${String.fromCodePoint(0x2066)}Name`, lastName: null }));
    await ingest('user.updated', subject, Date.now());
    await drain();
    const row = await userRow(subject);
    assert.equal(row.email, 'after@example.test');
    assert.equal(row.full_name, null, 'problematic provider name -> NULL');
    const synced = (await auditActions(row.id)).filter((a) => a.action === 'identity.user_profile_synced');
    assert.equal(synced.length, 1);
    assert.deepEqual(synced[0].metadata_json.changed_fields.sort(), ['email', 'full_name']);
    const serialized = JSON.stringify(synced[0]);
    assert.equal(serialized.includes('after@example.test') || serialized.includes('before@example.test'), false);
  });
});

describe('lifecycle semantics', () => {
  async function activeMemberFixture(label) {
    const subject = h.newSubject(label);
    users.put(h.clerkUser(subject));
    const user = await h.createUser({ subject });
    const other = await h.createUser();
    const workshop = await h.createWorkshop([{ user: other, roles: ['owner'] }, { user, roles: ['service_advisor'] }]);
    return { subject, user, workshop };
  }

  test('user.banned -> local user disabled, access blocked before the handler; memberships untouched', async () => {
    const f = await activeMemberFixture('ban');
    assert.equal((await tenantRead(f.subject)).statusCode, 200);
    users.put(h.clerkUser(f.subject, { banned: true }));
    await ingest('user.banned', f.subject, Date.now());
    await drain();

    assert.equal((await userRow(f.subject)).status, 'disabled');
    assert.equal((await syncState(f.subject)).lifecycle_state, 'blocked');
    assert.equal((await membershipStatus(f.workshop.memberships[1])).status, 'active');
    const before = handlerCalls.read;
    const response = await tenantRead(f.subject);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'ACTIVE_MEMBERSHIP_REQUIRED');
    assert.equal(handlerCalls.read, before, 'rejected before the handler');
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${h.sessionToken(f.subject)}` } });
    assert.equal(me.json().user, null);
    assert.ok((await auditActions(f.user.id)).some((a) => a.action === 'identity.user_disabled' && a.metadata_json.reason === 'provider_banned'));
  });

  test('user.updated carrying banned=true (how Clerk reports a ban) also disables', async () => {
    const f = await activeMemberFixture('banupd');
    users.put(h.clerkUser(f.subject, { banned: true }));
    await ingest('user.updated', f.subject, Date.now());
    await drain();
    assert.equal((await userRow(f.subject)).status, 'disabled');
  });

  test('NO AUTO-REACTIVATION: user.unbanned after a ban leaves the local user disabled', async () => {
    const f = await activeMemberFixture('unban');
    users.put(h.clerkUser(f.subject, { banned: true }));
    await ingest('user.banned', f.subject, Date.now() - 2000);
    await drain();
    users.put(h.clerkUser(f.subject, { banned: false, email: 'still-synced@example.test' }));
    await ingest('user.unbanned', f.subject, Date.now());
    await drain();
    const row = await userRow(f.subject);
    assert.equal(row.status, 'disabled');
    assert.equal(row.email, 'still-synced@example.test', 'profile keeps syncing; status does not');
    assert.equal((await syncState(f.subject)).lifecycle_state, 'blocked');
    assert.equal((await tenantRead(f.subject)).statusCode, 403);
  });

  test('user.locked is temporary: no durable local change, access continues', async () => {
    const f = await activeMemberFixture('lock');
    users.put(h.clerkUser(f.subject, { locked: true }));
    await ingest('user.locked', f.subject, Date.now());
    await drain();
    assert.equal((await userRow(f.subject)).status, 'active');
    assert.equal((await syncState(f.subject)).lifecycle_state, 'active');
    assert.equal((await tenantRead(f.subject)).statusCode, 200);
  });

  test('user.unlocked never activates a disabled local user', async () => {
    const subject = h.newSubject('unlock');
    users.put(h.clerkUser(subject, { locked: false }));
    await h.createUser({ subject, status: 'disabled' });
    await ingest('user.unlocked', subject, Date.now());
    await drain();
    assert.equal((await userRow(subject)).status, 'disabled');
  });

  test('user.deleted: no hard delete; user disabled + tombstone; memberships revoked per tenant except the single last owner', async () => {
    const subject = h.newSubject('del');
    users.put(h.clerkUser(subject));
    const target = await h.createUser({ subject });
    const coOwner = await h.createUser();
    const staff = await h.createUser();
    const single = await h.createWorkshop([{ user: target, roles: ['owner'] }, { user: staff, roles: ['technician'] }]);
    const shared = await h.createWorkshop([{ user: target, roles: ['owner'] }, { user: coOwner, roles: ['owner'] }]);
    const asTech = await h.createWorkshop([{ user: coOwner, roles: ['owner'] }, { user: target, roles: ['technician'] }]);
    const suspended = await h.createWorkshop([{ user: coOwner, roles: ['owner'] }, { user: target, roles: ['service_advisor'], status: 'suspended' }]);
    await admin`INSERT INTO public.audit_logs ${admin({
      id: randomUUID(), tenant_id: single.tenantId, actor_type: 'user', actor_user_id: target.id,
      action: 'historical.fixture', outcome: 'success', entity_type: 'user', entity_id: target.id, request_id: 'fixture',
    })}`;

    const deletedAt = Date.now();
    await ingest('user.deleted', subject, deletedAt);
    const callsBefore = users.calls.length;
    revocations.length = 0;
    await drain();
    assert.equal(users.calls.length, callsBefore, 'user.deleted needs no Backend API call');

    const row = await userRow(subject);
    assert.ok(row, 'users row is never deleted');
    assert.equal(row.status, 'disabled');
    const state = await syncState(subject);
    assert.equal(state.lifecycle_state, 'deleted');
    assert.equal(new Date(state.deleted_at).getTime(), deletedAt);

    assert.equal((await membershipStatus(single.memberships[0])).status, 'active', 'single last owner membership is kept');
    assert.equal((await membershipStatus(shared.memberships[0])).status, 'revoked', 'two owners: the deleted one is revoked');
    assert.equal((await membershipStatus(shared.memberships[1])).status, 'active', 'the remaining owner keeps ownership');
    assert.equal((await membershipStatus(asTech.memberships[1])).status, 'revoked');
    assert.equal((await membershipStatus(suspended.memberships[1])).status, 'revoked');
    assert.equal(revocations.length, 4);

    const kept = await auditActions(single.memberships[0]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].tenant_id, single.tenantId);
    assert.deepEqual([kept[0].action, kept[0].outcome, kept[0].reason_code], ['membership.revoked', 'denied', 'last_owner_invariant']);
    const revoked = await auditActions(shared.memberships[0]);
    assert.deepEqual([revoked[0].action, revoked[0].outcome, revoked[0].reason_code], ['membership.revoked', 'success', 'identity_provider_user_deleted']);
    assert.deepEqual(revoked[0].after_json, { status: 'revoked' });
    const history = await auditActions(target.id);
    assert.ok(history.some((a) => a.action === 'historical.fixture'), 'operational history preserved');
    assert.ok(history.some((a) => a.action === 'identity.user_deleted'));

    for (const workshop of [single, shared, asTech]) {
      assert.equal((await tenantRead(subject, workshop.tenantId)).statusCode, 403);
    }
    assert.equal((await tenantRead(coOwner.subject, shared.tenantId)).statusCode, 200);
  });

  test('two owners deleted concurrently: the revocation jobs serialize and exactly one owner membership remains', async () => {
    const a = h.newSubject('cownA');
    const b = h.newSubject('cownB');
    const userA = await h.createUser({ subject: a });
    const userB = await h.createUser({ subject: b });
    const workshop = await h.createWorkshop([{ user: userA, roles: ['owner'] }, { user: userB, roles: ['owner'] }]);
    await ingest('user.deleted', a, Date.now());
    await ingest('user.deleted', b, Date.now());
    const lifecycleJobs = await workerModule.claimBatch(workerPool, 10);
    for (const job of lifecycleJobs) await workerModule.processClaimedJob(workerOptions(), job);
    const revocationJobs = await workerModule.claimBatch(workerPool, 10);
    assert.equal(revocationJobs.length, 2);
    await Promise.all(revocationJobs.map((job) => workerModule.processClaimedJob(workerOptions(), job)));
    const statuses = await Promise.all(workshop.memberships.map(membershipStatus));
    assert.deepEqual(statuses.map((s) => s.status).sort(), ['active', 'revoked']);
  });
});

describe('ordering, idempotency, tombstones', () => {
  test('stale: an older event processed after a newer one changes nothing', async () => {
    const subject = h.newSubject('stale');
    users.put(h.clerkUser(subject, { email: 'current@example.test' }));
    const t = Date.now();
    const newer = await ingest('user.updated', subject, t);
    await drain();
    users.put(h.clerkUser(subject, { email: 'would-overwrite@example.test' }));
    await ingest('user.created', subject, t - 60_000);
    const callsBefore = users.calls.length;
    await drain();
    assert.equal(users.calls.length, callsBefore, 'stale event skipped before any network call');
    assert.equal((await userRow(subject)).email, 'current@example.test');
    assert.equal((await syncState(subject)).last_event_id, newer);
  });

  test('duplicate: re-queued job is a no-op without network; direct re-apply returns duplicate', async () => {
    const subject = h.newSubject('dupe');
    users.put(h.clerkUser(subject));
    const eventId = await ingest('user.created', subject, Date.now());
    await drain();
    const job = await outboxFor(eventId);
    await admin`UPDATE public.outbox_events SET status = 'pending', available_at = now() WHERE id = ${job.id}`;
    const callsBefore = users.calls.length;
    await drain();
    assert.equal(users.calls.length, callsBefore);
    assert.equal(applied.at(-1).result, 'duplicate');
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'identity.user_provisioned_webhook' AND entity_id = ${(await userRow(subject)).id}`;
    assert.equal(n, 1);

    const [event] = await admin`SELECT payload_json FROM public.outbox_events WHERE id = ${job.id}`;
    const p = event.payload_json;
    const tx = await rawWorkerPool.reserve();
    try {
      await tx.unsafe('BEGIN');
      const [row] = await tx`
        SELECT result FROM app.identity_sync_apply('clerk', ${subject}, ${eventId}, 'user.created', ${p.occurred_at}::timestamptz,
          ${p.webhook_event_id}::uuid, 'snapshot', 'x@example.test', NULL, false, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'test')
      `;
      assert.equal(row.result, 'duplicate');
      await tx.unsafe('ROLLBACK');
    } finally {
      tx.release();
    }
  });

  test('delete (T2) before create (T1): no resurrection; a later update is ignored; JIT cannot recreate it', async () => {
    const subject = h.newSubject('dbc');
    users.put(h.clerkUser(subject));
    const t = Date.now();
    await ingest('user.deleted', subject, t);
    await drain();
    await ingest('user.created', subject, t - 1000);
    await ingest('user.updated', subject, t - 500);
    await drain();
    assert.equal(await userRow(subject), null, 'no resurrection');
    assert.equal((await syncState(subject)).lifecycle_state, 'deleted');

    await ingest('user.updated', subject, t + 5000);
    await drain();
    assert.equal(await userRow(subject), null, 'tombstone is terminal');
    assert.equal(applied.at(-1).result, 'tombstoned');

    const [jit] = await apiPool`
      SELECT user_id, user_status, provisioned FROM app.bootstrap_provision_user(
        'clerk', ${subject}, ${randomUUID()}::uuid, 'late@example.test', NULL, ${randomUUID()})
    `;
    assert.deepEqual({ ...jit }, { user_id: null, user_status: 'disabled', provisioned: false });
    assert.equal(await userRow(subject), null);
  });

  test('equal timestamps: user.deleted dominates user.updated in either processing order', async () => {
    for (const order of [['user.updated', 'user.deleted'], ['user.deleted', 'user.updated']]) {
      const subject = h.newSubject('tie');
      users.put(h.clerkUser(subject));
      await h.createUser({ subject });
      const t = Date.now();
      for (const type of order) {
        await ingest(type, subject, t);
        await drain();
      }
      assert.equal((await syncState(subject)).lifecycle_state, 'deleted', order.join(' -> '));
      assert.equal((await userRow(subject)).status, 'disabled');
    }
  });

  test('concurrent events for one subject serialize: one row, final position = newest event', async () => {
    const subject = h.newSubject('conc');
    users.put(h.clerkUser(subject, { email: 'conc@example.test' }));
    const t = Date.now();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await ingest(i === 0 ? 'user.created' : 'user.updated', subject, t + i * 10));
    const jobs = await workerModule.claimBatch(workerPool, 10);
    assert.equal(jobs.length, 4);
    const results = await Promise.all(jobs.map((job) => workerModule.processClaimedJob(workerOptions(), job)));
    assert.ok(results.every((r) => r.outcome === 'processed'));
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(n, 1);
    assert.equal((await syncState(subject)).last_event_id, ids[3]);
  });
});

describe('provider failures', () => {
  test('404 on user.updated (deleted before the worker ran) -> tombstone, no retry loop', async () => {
    const subject = h.newSubject('gone');
    const user = await h.createUser({ subject });
    const other = await h.createUser();
    const workshop = await h.createWorkshop([{ user: other, roles: ['owner'] }, { user, roles: ['technician'] }]);
    const eventId = await ingest('user.updated', subject, Date.now());
    await drain();
    const job = await outboxFor(eventId);
    assert.equal(job.status, 'processed');
    assert.equal(job.attempts, 1);
    assert.equal((await syncState(subject)).lifecycle_state, 'deleted');
    assert.equal((await userRow(subject)).status, 'disabled');
    assert.equal((await membershipStatus(workshop.memberships[1])).status, 'revoked');
  });

  for (const [label, behavior] of [
    ['429', () => Promise.reject(h.httpError(429))],
    ['500', () => Promise.reject(h.httpError(500))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout (never settles)', () => new Promise(() => {})],
  ]) {
    test(`transient Backend API failure (${label}) -> retry scheduled, no mutation, attempt recorded; later success applies`, async () => {
      const subject = h.newSubject('transient');
      users.put(h.clerkUser(subject));
      users.script(subject, behavior);
      const eventId = await ingest('user.created', subject, Date.now());
      await drain();

      const job = await outboxFor(eventId);
      assert.equal(job.status, 'pending');
      assert.equal(job.attempts, 1);
      assert.ok(new Date(job.available_at).getTime() > Date.now(), 'backoff scheduled');
      assert.equal(job.last_error, 'IDENTITY_PROVIDER_UNAVAILABLE');
      assert.equal(await userRow(subject), null, 'no partial mutation');
      assert.equal(await syncState(subject), null);
      const [attempt] = await admin`
        SELECT a.status, a.last_error_code FROM public.webhook_processing_attempts AS a
        JOIN public.webhook_events AS w ON w.id = a.webhook_event_id WHERE w.provider_event_id = ${eventId}
      `;
      assert.deepEqual({ ...attempt }, { status: 'retryable_error', last_error_code: 'IDENTITY_PROVIDER_UNAVAILABLE' });

      await admin`UPDATE public.outbox_events SET available_at = now() WHERE id = ${job.id}`;
      await drain();
      assert.equal((await outboxFor(eventId)).status, 'processed');
      assert.equal((await userRow(subject)).status, 'active');
    });
  }

  test('a PHASE C database failure rolls back atomically and only a stable code reaches last_error', async () => {
    const subject = h.newSubject('dbfail');
    users.put(h.clerkUser(subject));
    await admin.unsafe(`
      CREATE FUNCTION public.test_fail_identity_sync() RETURNS trigger LANGUAGE plpgsql
      AS 'BEGIN RAISE EXCEPTION ''injected failure for %'', NEW.external_subject; END';
      CREATE TRIGGER test_fail_identity_sync_trg BEFORE INSERT ON public.identity_sync_states
      FOR EACH ROW EXECUTE FUNCTION public.test_fail_identity_sync();
    `);
    try {
      const eventId = await ingest('user.created', subject, Date.now());
      await drain();
      const job = await outboxFor(eventId);
      assert.equal(job.status, 'pending', 'retryable, not processed');
      assert.match(job.last_error, /^[A-Z0-9_]+$/u);
      assert.equal(job.last_error.includes(subject), false);
      assert.equal(await userRow(subject), null, 'the users insert rolled back with the failed state write');
      assert.deepEqual(probe, { reservedHeld: 0, openTransactions: 0 });
    } finally {
      await admin.unsafe(`
        DROP TRIGGER IF EXISTS test_fail_identity_sync_trg ON public.identity_sync_states;
        DROP FUNCTION IF EXISTS public.test_fail_identity_sync();
      `);
    }
  });

  test('retries are bounded: persistent outage ends in dead_letter, never processed', async () => {
    const subject = h.newSubject('dlq');
    users.put(h.clerkUser(subject));
    for (let i = 0; i < 3; i += 1) users.script(subject, () => Promise.reject(h.httpError(503)));
    const eventId = await ingest('user.created', subject, Date.now());
    for (let i = 0; i < 3; i += 1) {
      await drain();
      const job = await outboxFor(eventId);
      await admin`UPDATE public.outbox_events SET available_at = now() WHERE id = ${job.id} AND status = 'pending'`;
    }
    const job = await outboxFor(eventId);
    assert.equal(job.status, 'dead_letter');
    assert.equal(job.attempts, 3);
    assert.equal(await userRow(subject), null);
  });
});

describe('JIT (S1-01) vs webhook reconciliation', () => {
  const jit = (subject, email = 'jit@example.test') => apiPool`
    SELECT user_id, user_status, provisioned FROM app.bootstrap_provision_user(
      'clerk', ${subject}, ${randomUUID()}::uuid, ${email}, 'Jit Name', ${randomUUID()})
  `;
  async function provisioningAudits(subject) {
    const row = await userRow(subject);
    const [{ n }] = await admin`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE entity_id = ${row.id} AND action IN ('identity.user_provisioned_jit', 'identity.user_provisioned_webhook')
    `;
    return n;
  }

  test('JIT first, then user.created: one row, reconciled to the provider snapshot', async () => {
    const subject = h.newSubject('jitfirst');
    users.put(h.clerkUser(subject, { email: 'provider@example.test' }));
    const [first] = await jit(subject);
    assert.equal(first.provisioned, true);
    await ingest('user.created', subject, Date.now());
    await drain();
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(n, 1);
    assert.equal((await userRow(subject)).id, first.user_id);
    assert.equal((await userRow(subject)).email, 'provider@example.test');
    assert.equal(await provisioningAudits(subject), 1);
  });

  test('user.created first, then JIT: one row, JIT does not provision again', async () => {
    const subject = h.newSubject('whfirst');
    users.put(h.clerkUser(subject));
    await ingest('user.created', subject, Date.now());
    await drain();
    const [second] = await jit(subject);
    assert.equal(second.provisioned, false);
    assert.equal(second.user_id, (await userRow(subject)).id);
    assert.equal(await provisioningAudits(subject), 1);
  });

  test('forced interleaving (both blocked on the per-identity lock, then released together): one row, one provisioning audit', async () => {
    const subject = h.newSubject('race');
    users.put(h.clerkUser(subject, { email: 'race@example.test' }));
    await ingest('user.created', subject, Date.now());
    const [job] = await workerModule.claimBatch(workerPool, 1);

    const holder = await admin.reserve();
    try {
      await holder.unsafe('BEGIN');
      await holder`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`tallermecario:identity:clerk:${subject}`}, 0))`;
      const settled = { jit: false, worker: false };
      const racing = Promise.all([
        jit(subject, 'race-jit@example.test').then((rows) => { settled.jit = true; return rows; }),
        workerModule.processClaimedJob(workerOptions(), job).then((result) => { settled.worker = true; return result; }),
      ]);
      let blocked = 0;
      for (let i = 0; i < 200 && blocked < 2; i += 1) {
        [{ blocked }] = await admin`
          SELECT count(*)::int AS blocked FROM pg_catalog.pg_stat_activity
          WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'
            AND usename IN (${process.env.TEST_API_LOGIN}, ${process.env.TEST_WORKER_LOGIN})
        `;
        if (blocked < 2) await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(blocked, 2, 'JIT (api) and PHASE C (worker) were both waiting on the same identity lock');
      assert.deepEqual(settled, { jit: false, worker: false }, 'neither side could proceed while the lock was held');
      await holder.unsafe('COMMIT');
      const [[jitRow], workerResult] = await racing;
      assert.equal(workerResult.outcome, 'processed');
      assert.ok(jitRow.user_id);
    } finally {
      holder.release();
    }
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(n, 1);
    assert.equal(await provisioningAudits(subject), 1);
  });

  test('free-running concurrency x10: always one row and exactly one provisioning audit', async () => {
    for (let i = 0; i < 10; i += 1) {
      const subject = h.newSubject(`free${i}`);
      users.put(h.clerkUser(subject));
      await ingest('user.created', subject, Date.now());
      const [job] = await workerModule.claimBatch(workerPool, 1);
      await Promise.all([jit(subject), workerModule.processClaimedJob(workerOptions(), job), jit(subject)]);
      const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
      assert.equal(n, 1);
      assert.equal(await provisioningAudits(subject), 1);
    }
  });

  test('JIT after a ban never provisions an active identity', async () => {
    const subject = h.newSubject('jitban');
    users.put(h.clerkUser(subject, { banned: true }));
    await ingest('user.banned', subject, Date.now());
    await drain();
    const row = await userRow(subject);
    assert.equal(row.status, 'disabled', 'banned before first login: provisioned disabled');
    const [result] = await jit(subject);
    assert.equal(result.user_status, 'disabled');
  });
});

describe('database privileges and static guards', () => {
  const NEW_FUNCTIONS = [
    'ingest_verified_clerk_webhook', 'identity_sync_classify', 'identity_sync_apply', 'identity_sync_record_attempt',
    'bootstrap_list_user_memberships_for_revocation', 'bootstrap_append_identity_audit', 'bootstrap_provision_user',
  ];

  test('new SECURITY DEFINER functions: owner, fixed search_path, no PUBLIC EXECUTE, least-privilege grants', async () => {
    const rows = await admin`
      SELECT p.proname, p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proconfig,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_x,
        has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_x,
        has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker_x
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = ANY(${NEW_FUNCTIONS})
    `;
    const byName = Object.fromEntries(rows.map((row) => [row.proname, row]));
    assert.equal(rows.length, NEW_FUNCTIONS.length);
    for (const row of rows) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.equal(row.public_x, false, `${row.proname} PUBLIC EXECUTE`);
      assert.ok(row.proconfig.some((c) => c.startsWith('search_path=pg_catalog')), row.proname);
    }
    for (const name of ['ingest_verified_clerk_webhook', 'identity_sync_classify', 'identity_sync_apply', 'identity_sync_record_attempt']) {
      assert.equal(byName[name].owner, 'tallermecario_identity_sync', name);
    }
    for (const name of ['bootstrap_list_user_memberships_for_revocation', 'bootstrap_append_identity_audit', 'bootstrap_provision_user']) {
      assert.equal(byName[name].owner, 'tallermecario_bootstrap_resolver', name);
    }
    assert.deepEqual([byName.ingest_verified_clerk_webhook.api_x, byName.ingest_verified_clerk_webhook.worker_x], [true, false]);
    for (const name of ['identity_sync_classify', 'identity_sync_apply', 'identity_sync_record_attempt']) {
      assert.deepEqual([byName[name].api_x, byName[name].worker_x], [false, true], name);
    }
    for (const name of ['bootstrap_list_user_memberships_for_revocation', 'bootstrap_append_identity_audit']) {
      assert.deepEqual([byName[name].api_x, byName[name].worker_x], [false, false], name);
    }
  });

  test('identity_sync role: NOLOGIN, NOBYPASSRLS, unreachable from runtime; no new BYPASSRLS role; sync table private', async () => {
    const [role] = await admin`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
      FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_identity_sync'
    `;
    assert.deepEqual({ ...role }, { rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
    const bypass = await admin`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'tallermecario_%' AND rolbypassrls ORDER BY 1`;
    assert.deepEqual(bypass.map((r) => r.rolname), ['tallermecario_bootstrap_resolver']);
    const [paths] = await admin`
      SELECT pg_catalog.pg_has_role('tallermecario_api', 'tallermecario_identity_sync', 'MEMBER') AS api_member,
        pg_catalog.pg_has_role('tallermecario_worker', 'tallermecario_identity_sync', 'MEMBER') AS worker_member,
        has_table_privilege('tallermecario_api', 'public.identity_sync_states', 'SELECT') AS api_select,
        has_table_privilege('tallermecario_worker', 'public.identity_sync_states', 'SELECT') AS worker_select,
        has_table_privilege('tallermecario_worker', 'public.users', 'SELECT') AS worker_users,
        has_table_privilege('tallermecario_identity_sync', 'public.users', 'DELETE') AS sync_delete_users
    `;
    assert.deepEqual({ ...paths }, {
      api_member: false, worker_member: false, api_select: false, worker_select: false, worker_users: false, sync_delete_users: false,
    });
    await assert.rejects(rawWorkerPool`SELECT 1 FROM public.identity_sync_states`, (e) => e.code === '42501');
    await assert.rejects(rawWorkerPool`SET ROLE tallermecario_identity_sync`, (e) => e.code === '42501');
  });

  test('worker cannot apply membership revocation outside the job tenant (RLS)', async () => {
    const owner = await h.createUser();
    const member = await h.createUser();
    const workshop = await h.createWorkshop([{ user: owner, roles: ['owner'] }, { user: member, roles: ['technician'] }]);
    const tx = await rawWorkerPool.reserve();
    try {
      await tx.unsafe('BEGIN');
      await tx`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`;
      const result = await tx`UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = ${workshop.memberships[1]}`;
      assert.equal(result.count, 0);
      await tx.unsafe('ROLLBACK');
    } finally {
      tx.release();
    }
    assert.equal((await membershipStatus(workshop.memberships[1])).status, 'active');
  });

  function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
  }
  const srcRoot = resolve('src');
  const files = sourceFiles(srcRoot).map((path) => ({
    path: relative(srcRoot, path).replace(/\\/g, '/'),
    text: readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'),
  }));

  test('only the Clerk adapter imports the Clerk SDK (domain and routes stay provider-neutral)', () => {
    const importers = files.filter((f) => /from '@clerk\//u.test(f.text) || /require\('@clerk\//u.test(f.text)).map((f) => f.path).sort();
    assert.deepEqual(importers, ['identity/clerk/clerk-identity-provider.ts', 'identity/clerk/webhook.ts']);
  });

  test('Clerk Organizations / roles / permissions are never read for authorization', () => {
    const offenders = files.filter((f) => /\b(orgId|orgRole|orgPermissions|organizationId|orgSlug|org_role|org_permissions|org_id)\b|\.has\(\s*\{\s*(role|permission)/u.test(f.text));
    assert.deepEqual(offenders.map((f) => f.path), []);
  });

  test('identity code never logs secrets, tokens or provider payloads', () => {
    const identityFiles = files.filter((f) => f.path.startsWith('identity/'));
    for (const f of identityFiles) {
      assert.equal(/console\.|\.log\(|process\.stdout|process\.stderr/u.test(f.text), false, f.path);
    }
  });
});
