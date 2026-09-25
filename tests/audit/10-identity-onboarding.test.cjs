'use strict';

/**
 * S1-07 — audit events of S1-01 (onboarding + JIT) and S1-03 (Clerk identity
 * lifecycle: webhook ingest, worker sync, per-tenant membership revocation),
 * through the real routes and the real worker. Every row is checked field by
 * field against the inventory (docs/S1-07-DOC-CHANGES.md §1).
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert } = h;
let app;
const sensitive = [];
const UA = `Mozilla/5.0 (s107-ua-${randomUUID()})`;

before(async () => { app = await h.buildAuditApp(); });
after(async () => {
  await app.close();
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await h.admin.end();
});

async function localUser(subject) {
  const [row] = await h.admin`SELECT id, status FROM public.users WHERE identity_provider = 'clerk' AND external_subject = ${subject}`;
  return row ?? null;
}

async function outboxIdFor(providerEventId) {
  const [row] = await h.admin`
    SELECT id FROM public.outbox_events WHERE payload_json ->> 'provider_event_id' = ${providerEventId}`;
  return row?.id ?? null;
}

describe('S1-01 onboarding + JIT', () => {
  test('success: identity.user_provisioned_jit + workshop.created + membership.activated + role.assigned, one request, exact fields', async () => {
    const founder = h.identity('founder');
    sensitive.push(founder.email, founder.subject);
    const forgedRequestId = `forged-${randomUUID()}`;
    const response = await h.onboard(app, founder, 'Audit', { headers: { 'user-agent': UA, 'x-request-id': forgedRequestId, referer: 'https://evil.test/?token=abc' } });
    assert.equal(response.status, 201);
    const { workshop, membership } = response.json;
    const user = await localUser(founder.subject);

    const rows = await h.auditsByRequest(response.requestId);
    assert.deepEqual(rows.map((row) => row.action).sort(), [
      'identity.user_provisioned_jit', 'membership.activated', 'role.assigned', 'workshop.created',
    ]);
    assert.equal((await h.auditsByRequest(forgedRequestId)).length, 0, 'request_id is server generated, never the client header');
    for (const row of rows) {
      assert.equal(row.user_agent, null, `${row.action}: user_agent stays NULL`);
      assert.equal(row.outcome, 'success');
      assert.equal(row.actor_type, 'user');
      assert.equal(row.actor_user_id, user.id);
    }
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row]));
    const jit = byAction['identity.user_provisioned_jit'];
    assert.equal(jit.tenant_id, null);
    assert.equal(jit.actor_membership_id, null);
    assert.equal(jit.entity_type, 'user');
    assert.equal(jit.entity_id, user.id);
    assert.deepEqual(jit.metadata_json, { identity_provider: 'clerk' });

    for (const action of ['workshop.created', 'membership.activated', 'role.assigned']) {
      const row = byAction[action];
      assert.equal(row.tenant_id, workshop.id, `${action}: tenant = the new workshop`);
      assert.equal(row.actor_membership_id, membership.id, `${action}: actor = the new owner membership`);
      assert.equal(row.reason_code, 'workshop_onboarding');
      assert.equal(row.ip_address, '127.0.0.1');
    }
    assert.deepEqual([byAction['workshop.created'].entity_type, byAction['workshop.created'].entity_id], ['workshop', workshop.id]);
    assert.deepEqual(byAction['workshop.created'].after_json, {
      status: 'trialing', timezone: workshop.timezone, currency: workshop.currency, primary_location_id: response.json.primaryLocation.id,
    });
    assert.deepEqual([byAction['membership.activated'].entity_type, byAction['membership.activated'].entity_id], ['membership', membership.id]);
    assert.deepEqual(byAction['membership.activated'].after_json, { status: 'active', user_id: user.id });
    assert.deepEqual([byAction['role.assigned'].entity_type, byAction['role.assigned'].entity_id], ['membership_role', membership.id]);
    assert.deepEqual(byAction['role.assigned'].before_json, { roles: [] });
    assert.deepEqual(byAction['role.assigned'].after_json, { roles: ['owner'] });
    assert.deepEqual(byAction['role.assigned'].metadata_json, { assigned_by_membership_id: membership.id, bootstrap: true });
  });

  test('retry: a second onboarding is 409 and writes no audit row (no duplicate events)', async () => {
    const founder = h.identity('founder2');
    const first = await h.onboard(app, founder, 'Twice');
    assert.equal(first.status, 201);
    const before = await h.auditCount();
    const second = await h.onboard(app, founder, 'Twice');
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'ONBOARDING_ALREADY_COMPLETED');
    assert.equal(await h.auditCount(), before);
    assert.equal((await h.auditsByRequest(second.requestId)).length, 0);
  });

  test('JIT of an existing local user is not re-audited', async () => {
    const existing = await h.member('existing');
    const response = await h.onboard(app, existing, 'Existing');
    assert.equal(response.status, 201);
    const rows = await h.auditsByRequest(response.requestId);
    assert.equal(rows.filter((row) => row.action === 'identity.user_provisioned_jit').length, 0);
    assert.equal(rows.length, 3);
  });
});

describe('S1-03 identity lifecycle', () => {
  const base = Date.now() - 120_000;

  test('webhook -> worker: provisioned / profile_synced / disabled rows are provider rows, tenant-less, minimized, correlated to the outbox job', async () => {
    const subject = h.newSubject('lifecycle');
    const email = `life-${randomUUID().slice(0, 8)}@identity.test`;
    sensitive.push(email, subject);
    h.clerkUsers.put(h.clerkUser(subject, { email }));
    const created = await h.webhook(app, 'user.created', subject, base + 1000);
    assert.equal(created.status, 204);
    await h.drain();
    const user = await localUser(subject);
    assert.ok(user, 'provisioned');

    h.clerkUsers.put(h.clerkUser(subject, { email, firstName: 'Beatriz' }));
    const updated = await h.webhook(app, 'user.updated', subject, base + 2000);
    assert.equal(updated.status, 204);
    await h.drain();
    h.clerkUsers.put(h.clerkUser(subject, { email, firstName: 'Beatriz', banned: true }));
    const banned = await h.webhook(app, 'user.updated', subject, base + 3000);
    assert.equal(banned.status, 204);
    await h.drain();

    const rows = await h.auditsForEntity(user.id, 'identity.');
    assert.deepEqual(rows.map((row) => row.action), [
      'identity.user_provisioned_webhook', 'identity.user_profile_synced', 'identity.user_disabled',
    ]);
    const jobs = [await outboxIdFor(created.delivery.id), await outboxIdFor(updated.delivery.id), await outboxIdFor(banned.delivery.id)];
    rows.forEach((row, index) => {
      assert.equal(row.tenant_id, null);
      assert.equal(row.actor_type, 'provider');
      assert.equal(row.actor_user_id, null, 'a provider action is never attributed to a user');
      assert.equal(row.actor_membership_id, null);
      assert.equal(row.outcome, 'success');
      assert.equal(row.entity_type, 'user');
      assert.equal(row.request_id, jobs[index], 'correlated to the outbox job that applied it');
      assert.equal(row.user_agent, null);
      assert.equal(row.ip_address, null);
    });
    assert.deepEqual(rows[0].metadata_json, { identity_provider: 'clerk', provider_event_type: 'user.created', status: 'active' });
    assert.deepEqual(rows[1].metadata_json, { identity_provider: 'clerk', provider_event_type: 'user.updated', changed_fields: ['full_name'] });
    assert.deepEqual(rows[2].metadata_json, { identity_provider: 'clerk', provider_event_type: 'user.updated', reason: 'provider_banned' });
  });

  test('webhook replay: same svix-id + same body is a duplicate without audit; different body is a durable denied conflict row', async () => {
    const subject = h.newSubject('replay');
    h.clerkUsers.put(h.clerkUser(subject));
    const first = await h.webhook(app, 'user.created', subject, base + 5000);
    assert.equal(first.status, 204);
    const before = await h.auditCount();
    const replay = await h.webhook(app, 'user.created', subject, base + 5000, { id: first.delivery.id, body: first.delivery.body });
    assert.equal(replay.status, 204);
    assert.equal(await h.auditCount(), before, 'duplicate delivery: no audit');

    const conflict = await h.webhook(app, 'user.updated', subject, base + 6000, { id: first.delivery.id });
    assert.equal(conflict.status, 409);
    const rows = await h.auditsByRequest(conflict.requestId);
    assert.equal(rows.length, 1);
    const [webhookEvent] = await h.admin`SELECT id FROM public.webhook_events WHERE provider = 'clerk' AND provider_event_id = ${first.delivery.id}`;
    assert.deepEqual(
      [rows[0].action, rows[0].outcome, rows[0].actor_type, rows[0].tenant_id, rows[0].entity_type, rows[0].entity_id, rows[0].actor_user_id],
      ['identity.webhook_event_conflict', 'denied', 'provider', null, 'webhook_event', webhookEvent.id, null],
    );
    assert.deepEqual(rows[0].metadata_json, { identity_provider: 'clerk', reason: 'payload_hash_mismatch' });
    await h.drain();
  });

  test('user.deleted: identity.user_deleted + one provider membership.revoked per tenant; sole owner kept as denied last_owner_invariant; job retry adds nothing', async () => {
    const doomed = await h.member('doomed');
    const coOwner = await h.member('coowner');
    const shared = await h.createWorkshop([{ user: coOwner.user, roles: ['owner'] }, { user: doomed.user, roles: ['technician'] }]);
    const solo = await h.createWorkshop([{ user: doomed.user, roles: ['owner'] }]);
    const deleted = await h.webhook(app, 'user.deleted', doomed.subject, base + 9000);
    assert.equal(deleted.status, 204);
    const outcomes = [];
    await h.drain(undefined, outcomes);

    const identityRows = await h.auditsForEntity(doomed.user.id, 'identity.');
    assert.deepEqual(identityRows.map((row) => row.action), ['identity.user_deleted']);
    assert.equal(identityRows[0].metadata_json.membership_revocations_enqueued, 2);

    const revokedRows = await h.auditsForEntity(shared.memberships[1], 'membership.');
    assert.equal(revokedRows.length, 1);
    const jobs = await h.admin`
      SELECT id, tenant_id FROM public.outbox_events
      WHERE event_type = ${h.MEMBERSHIP_REVOCATION_EVENT_TYPE} AND payload_json ->> 'user_id' = ${doomed.user.id}`;
    const jobFor = Object.fromEntries(jobs.map((job) => [job.tenant_id, job.id]));
    assert.deepEqual(
      [revokedRows[0].action, revokedRows[0].outcome, revokedRows[0].actor_type, revokedRows[0].tenant_id, revokedRows[0].reason_code, revokedRows[0].request_id],
      ['membership.revoked', 'success', 'provider', shared.tenantId, 'identity_provider_user_deleted', jobFor[shared.tenantId]],
    );
    assert.equal(revokedRows[0].actor_user_id, null);
    assert.deepEqual(revokedRows[0].before_json, { status: 'active' });
    assert.deepEqual(revokedRows[0].after_json, { status: 'revoked' });
    assert.deepEqual(Object.keys(revokedRows[0].metadata_json).sort(), ['reason', 'user_id', 'webhook_event_id']);

    const keptRows = await h.auditsForEntity(solo.memberships[0], 'membership.');
    assert.equal(keptRows.length, 1);
    assert.deepEqual(
      [keptRows[0].outcome, keptRows[0].actor_type, keptRows[0].reason_code, keptRows[0].tenant_id],
      ['denied', 'provider', 'last_owner_invariant', solo.tenantId],
    );
    assert.equal(await h.membershipStatus(solo.memberships[0]), 'active');

    // The same job delivered again (at-least-once): already_revoked -> no second row.
    const again = await h.runRevocation({ ...h.revocationJob(shared.tenantId, shared.memberships[1], doomed.user.id), id: jobFor[shared.tenantId] });
    assert.deepEqual(again, ['already_revoked']);
    assert.equal((await h.auditsForEntity(shared.memberships[1], 'membership.')).length, 1);
  });
});

test('data rules: no secret, token, email, name or client header in any row of this file; catalog invariants hold', async () => {
  const rows = await h.allAudits();
  assert.ok(rows.length > 0);
  assert.deepEqual(h.scanAudits(rows, [...sensitive, UA, 'Beatriz', 'Gómez', 'evil.test']), []);
  assert.deepEqual(await h.catalogViolations(), []);
  assert.deepEqual(await h.duplicateSuccessRows(), []);
});
