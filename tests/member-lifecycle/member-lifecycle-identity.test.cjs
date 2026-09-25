'use strict';

/**
 * S1-06 x S1-03: the administrative lifecycle commands and the identity
 * revocation handler (`identity.membership_revocation_requested`) share the
 * same memberships, lock hierarchy and owner invariant. The handler's
 * semantics must be unchanged: kept_last_owner, already_revoked, not_found for
 * a vanished tenant, and user disabled != membership revoked.
 */

const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');

const { assert } = h;
let app;

before(async () => {
  app = await h.buildTestApp();
});

after(async () => {
  await app?.close();
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

test('handler after an API suspension: suspended -> revoked (provider audit), suspension history kept', async () => {
  const { a } = await h.twoTenants();
  assert.equal((await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId)).status, 200);
  const suspendedAt = (await h.membershipRow(a.advisor.membershipId)).suspended_at.toISOString();
  assert.deepEqual(await h.runRevocationHandler(a.tenantId, a.advisor), ['revoked']);
  const row = await h.membershipRow(a.advisor.membershipId);
  assert.equal(row.status, 'revoked');
  assert.equal(row.suspended_at.toISOString(), suspendedAt);
  const audits = await h.lifecycleAudits(a.advisor.membershipId);
  assert.deepEqual(audits.map((audit) => [audit.action, audit.actor_type, audit.outcome]), [
    ['membership.suspended', 'user', 'success'],
    ['membership.revoked', 'provider', 'success'],
  ]);
});

test('handler after an API revocation: already_revoked, no second audit; API revoke after the handler: 409', async () => {
  const { a } = await h.twoTenants();
  assert.equal((await h.revoke(app, a.owner, a.tenantId, a.technician.membershipId)).status, 200);
  assert.deepEqual(await h.runRevocationHandler(a.tenantId, a.technician), ['already_revoked']);
  assert.equal((await h.lifecycleAudits(a.technician.membershipId)).length, 1);

  assert.deepEqual(await h.runRevocationHandler(a.tenantId, a.advisor), ['revoked']);
  const again = await h.revoke(app, a.owner, a.tenantId, a.advisor.membershipId);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'DOMAIN_INVALID_STATE_TRANSITION');
});

test('kept_last_owner still applies when the co-owner was suspended through the API', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  assert.equal((await h.suspend(app, a.owner, a.tenantId, a.owner2.membershipId)).status, 200);
  assert.deepEqual(await h.runRevocationHandler(a.tenantId, a.owner), ['kept_last_owner']);
  assert.equal(await h.statusOf(a.owner.membershipId), 'active');
  assert.equal(await h.activeOwners(a.tenantId), 1);
  const [denied] = (await h.lifecycleAudits(a.owner.membershipId)).filter((row) => row.outcome === 'denied');
  assert.equal(denied.reason_code, 'last_owner_invariant');
  assert.equal(denied.actor_type, 'provider');
});

test('handler for a tenant that no longer exists still ends in not_found (0014 contract) with the 0015 grants', async () => {
  const outcomes = [];
  const { createMembershipRevocationHandler } = h.load('identity/sync/membership-revocation.js');
  const handler = createMembershipRevocationHandler({ onOutcome: (outcome) => outcomes.push(outcome.outcome) });
  const tenantId = randomUUID();
  const membershipId = randomUUID();
  const userId = randomUUID();
  await h.asRuntime(h.workerPool, { tenantId }, (tx) => handler({
    id: randomUUID(), tenantId, aggregateId: membershipId, eventType: 'identity.membership_revocation_requested', attempts: 1,
    payload: {
      type: 'identity.membership_revocation_requested', version: 1, reason: 'identity_provider_user_deleted',
      user_id: userId, membership_id: membershipId, webhook_event_id: randomUUID(),
    },
  }, tx));
  assert.deepEqual(outcomes, ['not_found']);
});

test('user disabled != membership revoked: a disabled user keeps an active membership; admin commands change only the membership', async () => {
  const { a } = await h.twoTenants();
  await h.admin`UPDATE public.users SET status = 'disabled' WHERE id = ${a.technician.user.id}`;
  assert.equal(await h.statusOf(a.technician.membershipId), 'active', 'disabling the user does not touch the membership');
  const denied = await h.whoami(app, a.technician, a.tenantId);
  assert.equal(denied.status, 403, 'a disabled user has no access');

  const listed = await h.listMembers(app, a.owner, a.tenantId);
  assert.equal(listed.json.memberships.find((row) => row.membershipId === a.technician.membershipId).status, 'active');

  assert.equal((await h.suspend(app, a.admin, a.tenantId, a.technician.membershipId)).status, 200);
  assert.equal((await h.revoke(app, a.admin, a.tenantId, a.technician.membershipId)).status, 200);
  assert.equal(await h.userStatus(a.technician.user.id), 'disabled', 'membership commands never write users');
  assert.equal(await h.userStatus(a.advisor.user.id), 'active');
  assert.equal((await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId)).status, 200);
  assert.equal(await h.userStatus(a.advisor.user.id), 'active', 'suspension does not disable the user');
});
