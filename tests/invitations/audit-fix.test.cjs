'use strict';

/**
 * S1-04 audit fix regressions (S104-01..04) against the REAL PostgreSQL
 * runtime roles (NOBYPASSRLS logins; admin only for fixtures, time travel
 * and catalog inspection). Hermetic: Resend is a recording sender or a fake
 * fetch behind the real ResendEmailSender; the global fetch trap stays at 0.
 *
 *   T-AUDIT-SECRET            live token in User-Agent never persisted
 *   T-RESEND-STABLE-REQUEST   retry = identical request under the same key
 *   T-SEND-REVOKE-RACE        revoke during an in-flight send
 *   T-SEND-ACCEPT-RACE        accept during an in-flight send
 *   T-TERMINAL-FIRST          revoke/accept first => no provider call
 *   T-SEND-LEASE-RECOVERY     dead worker: lease expires, nothing blocked forever
 *   T-SAME-JOB-IDEMPOTENT     re-running a job never repeats internal effects
 *   T-LEASE-DEADLINE          no send starts once the local lease window closed
 *   T-DELIVERY-ISOLATION      lease table: RLS, no worker grant, tenant from job
 *   T-DELIVERY-COMPLETE-TENANT  another tenant's job cannot complete/release a lease
 */

const test = require('node:test');
const { randomUUID } = require('node:crypto');
const h = require('./helpers.cjs');

const { assert, worker, email } = h;

let app;
let t;

class RecordingSender {
  constructor() {
    this.calls = [];
    this.behaviors = [];
    this.onSend = null;
  }

  next(behavior) {
    this.behaviors.push(behavior);
  }

  async send(message, idempotencyKey, options) {
    this.calls.push({ message, idempotencyKey, options });
    if (this.onSend) await this.onSend(message, idempotencyKey);
    const behavior = this.behaviors.shift();
    if (behavior) return behavior();
    return { providerMessageId: `re_msg_${randomUUID()}` };
  }

  for(invitationId) {
    return this.calls.filter((call) => call.idempotencyKey === email.invitationEmailIdempotencyKey(invitationId));
  }
}

function handlerOptions(sender, handler = {}) {
  return {
    database: h.workerPool,
    handlers: {},
    phasedHandlers: {
      [h.EMAIL_EVENT]: email.createInvitationEmailHandler({ config: { tokenKey: h.tokenKey }, sender, ...handler }),
    },
    baseDelaySeconds: 1,
  };
}

const drain = (sender, handler) => h.drainOutbox(worker, handlerOptions(sender, handler));

async function jobOf(invitationId) {
  const [row] = await h.admin`SELECT id, status, attempts, last_error FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
  return row;
}

async function makeDue(invitationId) {
  await h.admin`UPDATE public.outbox_events SET available_at = now() - interval '1 second' WHERE aggregate_id = ${invitationId}`;
}

async function invite(address = h.uniqueEmail('fix'), role = 'technician', headers = {}) {
  const response = await h.call(app, {
    subject: t.a.owner.subject, method: 'POST', url: '/api/v1/membership-invitations',
    body: { email: address, role }, tenantId: t.a.tenantId, headers,
  });
  assert.equal(response.status, 201, response.body);
  return { id: response.json.invitation.id, email: address };
}

const actionsOf = async (id) => (await h.auditsFor(id)).map((a) => a.action);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Admin session holding an exclusive advisory lock the test releases explicitly. */
async function holdGate(key) {
  const conn = await h.admin.reserve();
  await conn`SELECT pg_catalog.pg_advisory_lock(${key}::bigint)`;
  return {
    async open() {
      try { await conn`SELECT pg_catalog.pg_advisory_unlock(${key}::bigint)`; } finally { conn.release(); }
    },
  };
}

/** Test-only BEFORE INSERT trigger that parks the inserting transaction on `key`. */
async function injectBlocker(table, whenSql, key) {
  const name = `s104_block_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await h.admin.unsafe(`
    CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF ${whenSql} THEN PERFORM pg_catalog.pg_advisory_xact_lock_shared(${key}::bigint); END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${name} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}();
  `);
  return async () => {
    await h.admin.unsafe(`DROP TRIGGER IF EXISTS ${name} ON public.${table}; DROP FUNCTION IF EXISTS public.${name}();`);
  };
}

test.before(async () => {
  app = await h.buildTestApp();
  t = await h.twoTenants();
});

test.after(async () => {
  if (app) await app.close();
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

/* -------------------------------------------------------------------------- */
/* S104-01                                                                    */
/* -------------------------------------------------------------------------- */

test('T-AUDIT-SECRET: a live token sent in User-Agent is never persisted (audit or anywhere)', async () => {
  const intended = h.invitee('uaowner');
  const { id } = await invite(intended.email);
  const raw = await h.tokenFromOutbox(id);
  const tokenHash = h.token.hashInvitationToken(raw);
  const [{ payload_json: payload }] = await h.admin`SELECT payload_json FROM public.outbox_events WHERE aggregate_id = ${id}`;
  const headers = { 'user-agent': raw, referer: `https://x.test/#token=${raw}` };

  // Wrong verified email + the still-valid token in User-Agent: the denied
  // attempt IS audited (committed), but without any client header.
  const wrong = h.invitee('uawrong');
  const mismatch = await h.call(app, {
    subject: wrong.subject, method: 'POST', url: '/api/v1/membership-invitations/accept', body: { token: raw }, headers,
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.error.code, 'INVITATION_EMAIL_MISMATCH');
  assert.equal((await h.invitationRow(id)).status, 'pending', 'token still valid');

  // Same header on every other audited invitation command.
  const other = await invite(h.uniqueEmail('uaother'), 'technician', headers);
  assert.equal((await h.call(app, {
    subject: t.a.owner.subject, method: 'POST', url: `/api/v1/membership-invitations/${other.id}/revoke`, tenantId: t.a.tenantId, headers,
  })).status, 200);
  assert.equal((await h.call(app, {
    subject: t.a.admin.subject, method: 'POST', url: '/api/v1/membership-invitations', tenantId: t.a.tenantId, headers,
    body: { email: h.uniqueEmail('uadenied'), role: 'owner' },
  })).status, 403, 'denied escalation (committed audit)');
  const accepted = await h.call(app, {
    subject: intended.subject, method: 'POST', url: '/api/v1/membership-invitations/accept', body: { token: raw }, headers,
  });
  assert.equal(accepted.status, 201);

  const denied = (await h.auditsFor(id)).filter((a) => a.outcome === 'denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason_code, 'invitation_email_mismatch');

  const rows = await h.admin`
    SELECT id, user_agent, before_json::text AS before, after_json::text AS after, metadata_json::text AS metadata,
      reason_code, request_id, a::text AS whole
    FROM public.audit_logs a WHERE a.tenant_id = ${t.a.tenantId}
  `;
  assert.ok(rows.length >= 6);
  for (const row of rows) {
    assert.equal(row.user_agent, null, 'no client header persisted');
    for (const secret of [raw, tokenHash, payload.token_nonce]) {
      for (const field of ['before', 'after', 'metadata', 'reason_code', 'request_id', 'whole']) {
        assert.ok(!String(row[field] ?? '').includes(secret), `${field} carries token material`);
      }
    }
  }

  await drain(new RecordingSender()); // leave no pending job behind

  // Whole database: the raw token appears in no row of any public table.
  const tables = await h.admin`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  assert.ok(tables.length > 60);
  for (const { table_name: table } of tables) {
    const [hit] = await h.admin.unsafe(`SELECT count(*)::int AS n FROM public."${table}" AS r WHERE r::text LIKE $1`, [`%${raw}%`]);
    assert.equal(hit.n, 0, `raw token found in ${table}`);
  }
});

/* -------------------------------------------------------------------------- */
/* S104-02                                                                    */
/* -------------------------------------------------------------------------- */

test('T-RESEND-STABLE-REQUEST: retry sends the identical request under the same key despite mutations', async () => {
  await drain(new RecordingSender()); // clean slate: only this test's job reaches the fake provider
  const { id, email: address } = await invite();
  const [{ display_name: originalName }] = await h.admin`SELECT display_name FROM public.workshops WHERE id = ${t.a.tenantId}`;

  const wire = [];
  const responses = [
    () => new Response(JSON.stringify({ name: 'internal_server_error' }), { status: 503 }),
    () => new Response(JSON.stringify({ id: 're_stable_1' }), { status: 200 }),
  ];
  const sender = new email.ResendEmailSender(
    { resendApiKey: `re_test_${randomUUID()}`, resendBaseUrl: 'https://api.resend.test', resendTimeoutMs: 5_000 },
    async (url, init) => {
      wire.push({
        url,
        method: init.method,
        idempotencyKey: init.headers['idempotency-key'],
        contentType: init.headers['content-type'],
        body: init.body,
      });
      return responses.shift()();
    },
  );

  // Attempt 1: transient (ambiguous) provider failure.
  await drain(sender, { sendTimeoutMs: 5_000 });
  assert.equal((await jobOf(id)).last_error, 'RESEND_HTTP_503');

  // Everything mutable changes before the retry: the workshop name, the
  // API's message configuration (sender + accept URL: a redeployed API), the
  // worker's own configuration (timeout, stray config keys).
  await h.admin`UPDATE public.workshops SET display_name = ${`Renombrado ${randomUUID().slice(0, 6)}`} WHERE id = ${t.a.tenantId}`;
  const altConfig = { ...h.apiConfig, acceptUrl: 'https://otro.tallermecario.test/aceptar', from: 'otro@tallermecario.test' };
  const redeployed = await h.buildTestApp(altConfig);
  // The recipient is re-read: prove it cannot change (0008 trigger, runtime role).
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`UPDATE public.membership_invitations SET email = 'attacker@evil.test' WHERE id = ${id}`;
  }), (error) => error.constraint_name === 'mi_immutable_columns');
  assert.equal(await h.expireDeliveryLease(id), 1, 'lease of attempt 1 ran out');
  await makeDue(id);
  await drain(sender, {
    sendTimeoutMs: 7_000,
    config: { tokenKey: h.tokenKey, acceptUrl: altConfig.acceptUrl, from: altConfig.from },
  });

  assert.equal((await jobOf(id)).status, 'processed');
  assert.equal(wire.length, 2);
  assert.deepStrictEqual(wire[1], wire[0], 'byte-identical provider request');
  assert.equal(wire[0].idempotencyKey, `membership-invitation/${id}`);
  const body = JSON.parse(wire[0].body);
  assert.deepEqual(body.to, [address]);
  assert.equal(body.from, h.FROM);
  assert.ok(body.subject.includes(originalName), 'workshop name frozen at creation');
  assert.ok(body.text.includes(`${h.ACCEPT_URL}#token=${await h.tokenFromOutbox(id)}`));
  assert.equal(h.network.calls, 0);

  // Control: the mutations were real -- an invitation created by the
  // redeployed API froze the new name, sender and accept URL into ITS snapshot.
  const control = await h.createInvitation(redeployed, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('redeployed'), role: 'technician' });
  assert.equal(control.status, 201);
  await redeployed.close();
  const [{ payload_json: freshPayload }] = await h.admin`SELECT payload_json FROM public.outbox_events WHERE aggregate_id = ${control.json.invitation.id}`;
  assert.ok(freshPayload.delivery.workshop_name.startsWith('Renombrado'));
  assert.equal(freshPayload.delivery.from, altConfig.from);
  assert.equal(freshPayload.delivery.accept_url, altConfig.acceptUrl);
  await h.admin`UPDATE public.workshops SET display_name = ${originalName} WHERE id = ${t.a.tenantId}`;
  await drain(new RecordingSender());
});

/* -------------------------------------------------------------------------- */
/* S104-03                                                                    */
/* -------------------------------------------------------------------------- */

test('T-SEND-REVOKE-RACE: revoke during an in-flight send is refused, then succeeds after it', async () => {
  const { id } = await invite();
  const sender = new RecordingSender();
  const during = [];
  sender.onSend = async (message, key) => {
    if (key !== email.invitationEmailIdempotencyKey(id)) return;
    const response = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id);
    during.push({ status: response.status, code: response.json?.error?.code });
    during.push({ invitation: (await h.invitationRow(id)).status, audits: await actionsOf(id) });
  };
  await drain(sender);
  assert.equal(sender.for(id).length, 1);
  assert.deepEqual(during[0], { status: 409, code: 'INVITATION_IN_PROGRESS' });
  assert.deepEqual(during[1], { invitation: 'pending', audits: ['membership.invited'] }, 'no terminal state, no revoke audit');

  const sent = (await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].metadata_json.lease_state, 'held');
  assert.equal((await h.deliveryRow(id)).lease_id, null, 'lease released with the completion');

  const retry = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.invitation.status, 'revoked');
  assert.deepEqual(await actionsOf(id), ['membership.invited', 'membership.invitation_email_sent', 'membership.invitation_revoked']);
});

test('T-SEND-ACCEPT-RACE: accept during an in-flight send is refused (nothing created), then succeeds after it', async () => {
  const person = h.invitee('raceaccept');
  const { id } = await invite(person.email);
  const raw = await h.tokenFromOutbox(id);
  const sender = new RecordingSender();
  const during = [];
  sender.onSend = async (message, key) => {
    if (key !== email.invitationEmailIdempotencyKey(id)) return;
    const response = await h.acceptInvitation(app, person, raw);
    during.push({ status: response.status, code: response.json?.error?.code });
    during.push({ invitation: (await h.invitationRow(id)).status, user: await h.localUserId(person.subject) });
  };
  await drain(sender);
  assert.deepEqual(during[0], { status: 409, code: 'INVITATION_IN_PROGRESS' });
  assert.deepEqual(during[1], { invitation: 'pending', user: null }, 'accept rolled back entirely (no JIT user, no membership)');
  assert.equal((await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 1);

  const retry = await h.acceptInvitation(app, person, raw);
  assert.equal(retry.status, 201, retry.body);
  const userId = await h.localUserId(person.subject);
  const memberships = await h.membershipsOf(t.a.tenantId, userId);
  assert.equal(memberships.length, 1);
  assert.deepEqual(memberships[0].roles, ['technician']);
  assert.deepEqual((await actionsOf(id)).slice(0, 3), [
    'membership.invited', 'membership.invitation_email_sent', 'membership.invitation_accepted',
  ]);
});

test('T-TERMINAL-FIRST (sequential): revoked / accepted before the job runs => no provider call', async () => {
  const sender = new RecordingSender();
  const revoked = await invite();
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, revoked.id)).status, 200);
  const person = h.invitee('seqaccept');
  const accepted = await invite(person.email);
  assert.equal((await h.acceptInvitation(app, person, await h.tokenFromOutbox(accepted.id))).status, 201);
  await drain(sender);
  for (const [id, reason] of [[revoked.id, 'revoked'], [accepted.id, 'accepted']]) {
    assert.equal(sender.for(id).length, 0, reason);
    const skipped = (await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].metadata_json.reason, reason);
    assert.equal((await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 0);
  }
});

for (const kind of ['revoke', 'accept']) {
  test(`T-TERMINAL-FIRST (concurrent): an uncommitted ${kind} blocks the lease; once it commits the worker never calls Resend`, async () => {
    const person = h.invitee(`conc${kind}`);
    const { id } = await invite(person.email);
    const raw = await h.tokenFromOutbox(id);
    const key = 7_104_000_000 + Math.floor(Math.random() * 1_000_000);
    const action = kind === 'revoke' ? 'membership.invitation_revoked' : 'membership.invitation_accepted';
    const gate = await holdGate(key);
    const remove = await injectBlocker('audit_logs', `NEW.action = '${action}' AND NEW.outcome = 'success'`, key);
    const sender = new RecordingSender();
    let terminal;
    let drained;
    try {
      // The terminal transaction passes the lifecycle trigger (takes the
      // invitation's delivery lock) and parks on its audit insert.
      terminal = kind === 'revoke'
        ? h.revokeInvitation(app, t.a.owner, t.a.tenantId, id)
        : h.acceptInvitation(app, person, raw);
      await h.waitForLockWaiters(1);
      // The worker reads "pending", then waits on the same lock to lease.
      drained = drain(sender);
      await h.waitForLockWaiters(2);
      assert.equal(sender.calls.length, 0, 'no provider call while the terminal transaction is open');
    } finally {
      await gate.open();
    }
    const response = await terminal;
    await drained;
    await remove();
    assert.equal(response.status, kind === 'revoke' ? 200 : 201, response.body);
    assert.equal(sender.for(id).length, 0, 'worker never called Resend');
    const skipped = (await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].metadata_json.reason, kind === 'revoke' ? 'revoked' : 'accepted');
    assert.equal((await jobOf(id)).status, 'processed');
  });
}

test('T-SEND-LEASE-RECOVERY: a worker dying after the lease blocks nothing forever (retry or terminal both recover)', async () => {
  const retried = await invite();
  const terminal = await invite();
  const LEASE_SECONDS = 4;
  let unfreeze;
  const frozen = new Promise((_, reject) => { unfreeze = reject; });
  const dying = new RecordingSender();
  dying.onSend = () => frozen; // the process "dies" inside the provider call

  // Both jobs get a lease, then their worker stops forever (jobs stay 'processing').
  const zombie = drain(dying, { leaseSeconds: LEASE_SECONDS, sendTimeoutMs: 1_000 }).catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (dying.calls.length < 1 && Date.now() < deadline) await sleep(20);
  assert.equal(dying.calls.length, 1, 'the zombie is parked inside its first provider call');
  // The zombie is parked on its first job. The other invitation's job gets its
  // lease from the same function the handler uses, on a job claimed by the
  // same (about to die) worker -- then nothing else happens to it either.
  const heldFor = dying.for(retried.id).length === 1 ? retried : terminal;
  const otherHeld = heldFor === retried ? terminal : retried;
  const otherJob = await jobOf(otherHeld.id);
  if (otherJob.status === 'pending') {
    const claimed = await worker.claimBatch(h.workerPool, 20);
    assert.ok(claimed.some((job) => job.outboxEventId === otherJob.id));
  }
  assert.equal((await jobOf(otherHeld.id)).status, 'processing');
  const [otherLease] = await h.workerPool`
    SELECT * FROM app.worker_acquire_invitation_email_lease(${otherJob.id}, ${randomUUID()}, ${LEASE_SECONDS})
  `;
  assert.equal(otherLease.lease_outcome, 'acquired');
  for (const held of [heldFor, otherHeld]) {
    assert.ok((await h.deliveryRow(held.id))?.lease_id, 'lease held by the dead worker');
    const refused = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, held.id);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, 'INVITATION_IN_PROGRESS');
  }

  // Real clock: wait for the leases to expire.
  await sleep(LEASE_SECONDS * 1000 + 300);

  // Recovery path 1: the terminal transition is no longer blocked.
  const revoked = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, otherHeld.id);
  assert.equal(revoked.status, 200);
  // Recovery path 2: the stalled job is requeued and a new attempt delivers.
  await worker.requeueStalled(h.workerPool, 0);
  const healthy = new RecordingSender();
  await drain(healthy);
  assert.equal(healthy.for(heldFor.id).length, 1, 'new attempt re-leased and sent (same key)');
  assert.equal(healthy.for(otherHeld.id).length, 0, 'revoked meanwhile: never sent');
  const sent = (await h.auditsFor(heldFor.id)).filter((a) => a.action === 'membership.invitation_email_sent');
  assert.equal(sent.length, 1);
  const skipped = (await h.auditsFor(otherHeld.id)).filter((a) => a.action === 'membership.invitation_email_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].metadata_json.prior_attempt_unconfirmed, true, 'the lost attempt is reported, not hidden');
  assert.equal((await h.deliveryRow(heldFor.id)).lease_id, null);
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, heldFor.id)).status, 200, 'no permanent block');

  // The zombie wakes up late: its completion cannot record a second effect.
  unfreeze(new worker.TransientDispatchError('RESEND_NETWORK_ERROR'));
  await zombie;
  assert.equal((await h.auditsFor(heldFor.id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 1);
  assert.equal((await jobOf(heldFor.id)).status, 'processed');
});

test('T-SAME-JOB-IDEMPOTENT: re-running an already delivered job never repeats a send or an audit', async () => {
  const { id } = await invite();
  const sender = new RecordingSender();
  await drain(sender);
  assert.equal(sender.for(id).length, 1);
  const auditsBefore = await actionsOf(id);
  // Operator/queue duplicate of the same job.
  await h.admin`UPDATE public.outbox_events SET status = 'pending', available_at = now() - interval '1 second', processed_at = NULL WHERE aggregate_id = ${id}`;
  await drain(sender);
  assert.equal(sender.for(id).length, 1, 'already_sent: no provider call');
  assert.deepEqual(await actionsOf(id), auditsBefore, 'no second internal effect');
  assert.equal((await jobOf(id)).status, 'processed');
  const delivery = await h.deliveryRow(id);
  assert.equal(delivery.lease_count, 1);
  assert.ok(delivery.sent_at);
});

test('T-LEASE-DEADLINE: once the local lease window has closed, no provider request starts and the lease is freed', async () => {
  const { id } = await invite();
  const sender = new RecordingSender();
  let clock = 0;
  // The monotonic clock jumps past the lease between acquire and send
  // (e.g. a long GC pause): the attempt must not start the request.
  const now = () => {
    clock += 60_000;
    return clock;
  };
  await drain(sender, { now });
  assert.equal(sender.for(id).length, 0);
  assert.equal((await jobOf(id)).last_error, 'INVITATION_EMAIL_LEASE_WINDOW_TOO_SHORT');
  assert.equal((await h.deliveryRow(id)).lease_id, null, 'no request in flight: lease released at once');
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id)).status, 200);

  // Each request is bounded by the remaining lease window.
  const bounded = await invite();
  const recorder = new RecordingSender();
  await drain(recorder, { sendTimeoutMs: 3_000 });
  const [call] = recorder.for(bounded.id);
  assert.ok(call.options.timeoutMs <= 3_000 && call.options.timeoutMs >= 1_000);
});

test('T-LEASE-REJECTION: a definitive provider refusal frees the invitation at once; an ambiguous one keeps the lease', async () => {
  await drain(new RecordingSender()); // clean slate: behaviors below apply to these two jobs only
  const rejected = await invite();
  const ambiguous = await invite();
  const sender = new RecordingSender();
  sender.next(() => { throw email.markProviderRejection(new worker.TransientDispatchError('RESEND_HTTP_429')); });
  sender.next(() => { throw new worker.TransientDispatchError('RESEND_NETWORK_ERROR'); });
  await drain(sender);
  assert.equal((await h.deliveryRow(rejected.id)).lease_id, null);
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, rejected.id)).status, 200);
  assert.ok((await h.deliveryRow(ambiguous.id)).lease_id);
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, ambiguous.id)).status, 409);
  await h.expireDeliveryLease(ambiguous.id);
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, ambiguous.id)).status, 200);
});

test('T-DELIVERY-ISOLATION: lease rows are tenant-isolated, worker has no grant, tenant comes from the claimed job', async () => {
  const { id } = await invite();
  await drain(new RecordingSender());
  assert.ok(await h.deliveryRow(id));

  // API role under RLS: own tenant only.
  const seen = async (tenantId) => h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return tx`SELECT invitation_id FROM public.membership_invitation_deliveries WHERE invitation_id = ${id}`;
  });
  assert.equal((await seen(t.a.tenantId)).length, 1);
  assert.equal((await seen(t.b.tenantId)).length, 0, 'tenant B cannot read tenant A leases');
  // API cannot write, worker cannot even read.
  const denied = (error) => error.code === '42501';
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`UPDATE public.membership_invitation_deliveries SET lease_expires_at = NULL WHERE invitation_id = ${id}`;
  }), denied);
  await assert.rejects(h.workerPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`SELECT * FROM public.membership_invitation_deliveries`;
  }), denied);
  // The API cannot call the worker lease functions.
  await assert.rejects(h.apiPool`SELECT * FROM app.worker_acquire_invitation_email_lease(${randomUUID()}, ${randomUUID()}, 10)`, denied);

  // A job of tenant B pointing at tenant A's invitation cannot lease it.
  const victim = await invite();
  const forged = randomUUID();
  await h.admin`INSERT INTO public.outbox_events ${h.admin({
    id: forged, tenant_id: t.b.tenantId, aggregate_type: 'membership_invitation', aggregate_id: victim.id,
    event_type: h.EMAIL_EVENT, event_version: 2, payload_json: h.admin.json({}), idempotency_key: forged, status: 'processing', attempts: 1,
  })}`;
  const [forgedLease] = await h.workerPool`SELECT * FROM app.worker_acquire_invitation_email_lease(${forged}, ${randomUUID()}, 10)`;
  assert.equal(forgedLease.lease_outcome, 'not_found');
  assert.equal(await h.deliveryRow(victim.id), null);
  // An unclaimed job cannot lease anything.
  const [victimJob] = await h.admin`SELECT id FROM public.outbox_events WHERE aggregate_id = ${victim.id}`;
  const [unclaimed] = await h.workerPool`SELECT * FROM app.worker_acquire_invitation_email_lease(${victimJob.id}, ${randomUUID()}, 10)`;
  assert.equal(unclaimed.lease_outcome, 'not_claimed');
  await h.admin`UPDATE public.outbox_events SET status = 'failed' WHERE id = ${forged}`;
  await drain(new RecordingSender());

  // Lease bounds are enforced by PostgreSQL.
  await assert.rejects(h.workerPool`SELECT * FROM app.worker_acquire_invitation_email_lease(${victimJob.id}, ${randomUUID()}, 121)`,
    (error) => error.code === '22023');
  await assert.rejects(h.admin`
    INSERT INTO public.membership_invitation_deliveries (tenant_id, invitation_id, lease_id)
    VALUES (${t.a.tenantId}, ${victim.id}, ${randomUUID()})
  `, (error) => error.constraint_name === 'mid_lease_coherence_check');
});

test('T-DELIVERY-COMPLETE-TENANT: a job of another tenant can neither complete nor release a lease; the lease stays intact', async () => {
  await drain(new RecordingSender()); // clean slate
  const { id } = await invite();
  const [job] = await h.admin`SELECT id FROM public.outbox_events WHERE aggregate_id = ${id}`;
  const claimed = await worker.claimBatch(h.workerPool, 50);
  assert.ok(claimed.some((row) => row.outboxEventId === job.id), 'tenant A job claimed');
  const leaseA = randomUUID();
  const [acquired] = await h.workerPool`SELECT * FROM app.worker_acquire_invitation_email_lease(${job.id}, ${leaseA}, 30)`;
  assert.equal(acquired.lease_outcome, 'acquired');

  // A claimed job of tenant B that points at tenant A's invitation (the
  // tenant of every lease function comes from the job, never a parameter).
  const forged = randomUUID();
  await h.admin`INSERT INTO public.outbox_events ${h.admin({
    id: forged, tenant_id: t.b.tenantId, aggregate_type: 'membership_invitation', aggregate_id: id,
    event_type: h.EMAIL_EVENT, event_version: 2, payload_json: h.admin.json({}), idempotency_key: forged, status: 'processing', attempts: 1,
  })}`;
  try {
    // complete: stable refusal (no lease row for (tenant B, invitation)).
    await assert.rejects(
      h.workerPool`SELECT * FROM app.worker_complete_invitation_email_delivery(${forged}, ${leaseA}, 're_forged_completion')`,
      (error) => error.code === '55000',
    );
    // release: no-op.
    const [released] = await h.workerPool`SELECT app.worker_release_invitation_email_lease(${forged}, ${leaseA}) AS released`;
    assert.equal(released.released, false);

    // Tenant A's lease is exactly as acquired: not recorded, not released.
    const delivery = await h.deliveryRow(id);
    assert.equal(delivery.tenant_id, t.a.tenantId);
    assert.equal(delivery.lease_id, leaseA);
    assert.equal(delivery.lease_outbox_event_id, job.id);
    assert.equal(delivery.sent_at, null);
    assert.equal(delivery.provider_message_id, null);
    assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id)).status, 409, 'lease still blocks terminal transitions');
    assert.equal((await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 0);
  } finally {
    await h.admin`UPDATE public.outbox_events SET status = 'failed' WHERE id = ${forged}`;
  }

  // The legitimate job still completes normally afterwards.
  await h.expireDeliveryLease(id);
  await worker.requeueStalled(h.workerPool, 0);
  await makeDue(id);
  const sender = new RecordingSender();
  await drain(sender);
  assert.equal(sender.for(id).length, 1);
  // By id: the forged row shares the aggregate_id.
  const [legit] = await h.admin`SELECT status FROM public.outbox_events WHERE id = ${job.id}`;
  assert.equal(legit.status, 'processed');
});

/* -------------------------------------------------------------------------- */
/* S104-04                                                                   */
/* -------------------------------------------------------------------------- */

test('T-WORKER-LEAST-PRIVILEGE: worker can only SELECT invitations, has no lease-table grant, and the email flow still works', async () => {
  const [privileges] = await h.admin`
    SELECT
      has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'SELECT') AS "select",
      has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'INSERT') AS "insert",
      has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'UPDATE') AS "update",
      has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'DELETE') AS "delete",
      has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'TRUNCATE') AS "truncate",
      has_any_column_privilege('tallermecario_worker', 'public.membership_invitations', 'INSERT') AS column_insert,
      has_any_column_privilege('tallermecario_worker', 'public.membership_invitations', 'UPDATE') AS column_update,
      has_any_column_privilege('tallermecario_worker', 'public.membership_invitation_deliveries', 'SELECT') AS delivery_select,
      has_any_column_privilege('tallermecario_worker', 'public.membership_invitation_deliveries', 'INSERT') AS delivery_insert,
      has_any_column_privilege('tallermecario_worker', 'public.membership_invitation_deliveries', 'UPDATE') AS delivery_update,
      has_table_privilege('tallermecario_api', 'public.membership_invitation_deliveries', 'SELECT') AS api_delivery_select,
      has_any_column_privilege('tallermecario_api', 'public.membership_invitation_deliveries', 'INSERT') AS api_delivery_insert,
      has_any_column_privilege('tallermecario_api', 'public.membership_invitation_deliveries', 'UPDATE') AS api_delivery_update,
      has_any_column_privilege('tallermecario_bootstrap_resolver', 'public.membership_invitations', 'UPDATE') AS resolver_invitation_update,
      has_any_column_privilege('tallermecario_bootstrap_resolver', 'public.membership_invitations', 'INSERT') AS resolver_invitation_insert
  `;
  assert.deepEqual({ ...privileges }, {
    select: true, insert: false, update: false, delete: false, truncate: false,
    column_insert: false, column_update: false,
    delivery_select: false, delivery_insert: false, delivery_update: false,
    api_delivery_select: true, api_delivery_insert: false, api_delivery_update: false,
    resolver_invitation_update: false, resolver_invitation_insert: false,
  });

  const policies = await h.admin`
    SELECT tablename, policyname, cmd, roles FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename IN ('membership_invitations', 'membership_invitation_deliveries')
    ORDER BY tablename, policyname
  `;
  assert.deepEqual(policies.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}:${[...p.roles].sort().join('+')}`), [
    'membership_invitation_deliveries.tenant_insert:INSERT:tallermecario_api+tallermecario_worker',
    'membership_invitation_deliveries.tenant_select:SELECT:tallermecario_api+tallermecario_worker',
    'membership_invitations.tenant_insert:INSERT:tallermecario_api+tallermecario_worker',
    'membership_invitations.tenant_select:SELECT:tallermecario_api+tallermecario_worker',
    'membership_invitations.tenant_update:UPDATE:tallermecario_api',
  ]);

  // Functional, as the real worker login (NOBYPASSRLS, correct tenant context).
  const [who] = await h.workerPool`
    SELECT current_user AS role, (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass
  `;
  assert.deepEqual({ ...who }, { role: 'tallermecario_worker', bypass: false });
  await drain(new RecordingSender()); // clean slate
  const { id } = await invite();
  const denied = (error) => error.code === '42501';
  const statements = [
    (tx) => tx`UPDATE public.membership_invitations SET status = 'revoked' WHERE id = ${id}`,
    (tx) => tx`UPDATE public.membership_invitations SET email = 'x@evil.test' WHERE id = ${id}`,
    (tx) => tx`DELETE FROM public.membership_invitations WHERE id = ${id}`,
    (tx) => tx`
      INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, expires_at, invited_by_membership_id)
      SELECT ${randomUUID()}, tenant_id, 'y@evil.test', 'y@evil.test', target_role_id, ${'a'.repeat(64)}, expires_at, invited_by_membership_id
      FROM public.membership_invitations WHERE id = ${id}
    `,
    (tx) => tx`SELECT id FROM public.membership_invitations WHERE id = ${id} FOR UPDATE`,
  ];
  for (const statement of statements) {
    await assert.rejects(h.workerPool.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
      await statement(tx);
    }), denied);
  }
  const visible = await h.workerPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    return tx`SELECT id FROM public.membership_invitations WHERE id = ${id}`;
  });
  assert.equal(visible.length, 1, 'SELECT under tenant RLS still works');

  // Lease functions: minimal SECURITY DEFINER surface.
  const functions = await h.admin`
    SELECT p.proname, p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proconfig,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
      has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker_execute,
      has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname IN (
      'worker_acquire_invitation_email_lease', 'worker_complete_invitation_email_delivery', 'worker_release_invitation_email_lease')
    ORDER BY p.proname
  `;
  assert.equal(functions.length, 3);
  for (const fn of functions) {
    const { proname, ...rest } = fn;
    assert.deepEqual(rest, {
      prosecdef: true, owner: 'tallermecario_bootstrap_resolver', proconfig: ['search_path=pg_catalog, public'],
      public_execute: false, worker_execute: true, api_execute: false,
    }, proname);
  }
  const resolverGrants = await h.admin`
    SELECT column_name, privilege_type FROM information_schema.role_column_grants
    WHERE grantee = 'tallermecario_bootstrap_resolver' AND table_name = 'membership_invitation_deliveries'
    ORDER BY privilege_type, column_name
  `;
  const byPrivilege = (type) => resolverGrants.filter((g) => g.privilege_type === type).map((g) => g.column_name);
  assert.deepEqual(byPrivilege('INSERT'), ['invitation_id', 'lease_acquired_at', 'lease_attempt', 'lease_count', 'lease_expires_at', 'lease_id', 'lease_outbox_event_id', 'tenant_id']);
  assert.deepEqual(byPrivilege('UPDATE'), ['lease_acquired_at', 'lease_attempt', 'lease_count', 'lease_expires_at', 'lease_id', 'lease_outbox_event_id', 'provider_message_id', 'sent_at', 'updated_at']);
  const [{ table_grants: tableGrants }] = await h.admin`
    SELECT count(*)::int AS table_grants FROM information_schema.role_table_grants
    WHERE grantee IN ('tallermecario_bootstrap_resolver', 'tallermecario_worker') AND table_name = 'membership_invitation_deliveries'
  `;
  assert.equal(tableGrants, 0, 'no table-level grant to resolver or worker');

  // The email flow still passes end to end with the reduced worker role.
  const sender = new RecordingSender();
  await drain(sender);
  assert.equal(sender.for(id).length, 1);
  assert.equal((await jobOf(id)).status, 'processed');
  assert.equal((await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 1);
});
