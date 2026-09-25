'use strict';

const h = require('../audit/helpers.cjs');
const { randomUUID } = require('node:crypto');
const { before, after, test } = require('node:test');

const { assert, admin } = h;
let app;
let t;
let invitationB;
let tokenB;

before(async () => {
  app = await h.buildAuditApp();
  t = await h.tenants();
  const created = await h.invite(app, t.b.owner, t.b.tenantId, { email: h.uniqueEmail('s108-b'), role: 'technician' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  invitationB = created.json.invitation.id;
  tokenB = await h.tokenFromOutbox(invitationB);
});

after(async () => {
  await app?.close();
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

const code = (response) => response.json?.error?.code;
const get = (actor, tenantId, url) => h.call(app, { subject: actor.subject, tenantId, url });

test('real B resource IDs are invisible through every tenant read/list route from A', async () => {
  for (const [url, collection] of [
    ['/api/v1/memberships', 'memberships'],
    ['/api/v1/membership-invitations', 'invitations'],
  ]) {
    const response = await get(t.a.owner, t.a.tenantId, url);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const serialized = JSON.stringify(response.json[collection]);
    for (const id of [t.b.tenantId, t.b.owner.membershipId, t.b.technician.membershipId, invitationB]) {
      assert.equal(serialized.includes(id), false, `${url} exposed ${id}`);
    }
  }
  for (const url of [
    `/api/v1/memberships/${t.b.owner.membershipId}`,
    `/api/v1/memberships/${t.b.owner.membershipId}/roles`,
  ]) {
    const response = await get(t.a.owner, t.a.tenantId, url);
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal(code(response), 'MEMBERSHIP_NOT_FOUND');
  }
});

test('B UUID versus nonexistent UUID has the same documented error on GET, roles and invitation revoke', async () => {
  const unknown = randomUUID();
  const pairs = [
    [() => get(t.a.owner, t.a.tenantId, `/api/v1/memberships/${t.b.owner.membershipId}`),
      () => get(t.a.owner, t.a.tenantId, `/api/v1/memberships/${unknown}`)],
    [() => get(t.a.owner, t.a.tenantId, `/api/v1/memberships/${t.b.owner.membershipId}/roles`),
      () => get(t.a.owner, t.a.tenantId, `/api/v1/memberships/${unknown}/roles`)],
    [() => h.revokeInvite(app, t.a.owner, t.a.tenantId, invitationB),
      () => h.revokeInvite(app, t.a.owner, t.a.tenantId, unknown)],
  ];
  for (const [foreign, absent] of pairs) {
    const [left, right] = await Promise.all([foreign(), absent()]);
    assert.equal(left.status, 404, JSON.stringify(left.json));
    assert.equal(right.status, 404, JSON.stringify(right.json));
    assert.deepEqual([code(left), left.json.error.message], [code(right), right.json.error.message]);
  }
});

test('A cannot run role, membership or invitation commands on B; B and audits remain untouched', async () => {
  const beforeB = await admin`SELECT status FROM public.memberships WHERE id = ${t.b.technician.membershipId}`;
  const auditsBefore = await h.auditsForTenant(t.b.tenantId);
  const operations = [
    () => h.assignRole(app, t.a.owner, t.a.tenantId, t.b.technician.membershipId, 'service_advisor'),
    () => h.removeRole(app, t.a.owner, t.a.tenantId, t.b.technician.membershipId, 'technician'),
    () => h.suspend(app, t.a.owner, t.a.tenantId, t.b.technician.membershipId),
    () => h.revoke(app, t.a.owner, t.a.tenantId, t.b.technician.membershipId),
    () => h.revokeInvite(app, t.a.owner, t.a.tenantId, invitationB),
  ];
  for (const operation of operations) {
    const response = await operation();
    assert.equal(response.status, 404, JSON.stringify(response.json));
  }
  const afterB = await admin`SELECT status FROM public.memberships WHERE id = ${t.b.technician.membershipId}`;
  assert.deepEqual(afterB, beforeB);
  assert.deepEqual(await h.roleCodes(t.b.technician.membershipId), ['technician']);
  const [invite] = await admin`SELECT status FROM public.membership_invitations WHERE id = ${invitationB}`;
  assert.equal(invite.status, 'pending');
  assert.equal((await h.auditsForTenant(t.b.tenantId)).length, auditsBefore.length);
  for (const row of await h.auditsForTenant(t.a.tenantId)) {
    assert.notEqual(row.entity_id, t.b.technician.membershipId);
    assert.notEqual(row.entity_id, invitationB);
  }
});

test('verified A JWT plus B selection and forged provider claims never grants B context', async () => {
  const forged = h.sessionToken(t.a.owner.subject, {
    org_role: 'org:owner', org_permissions: ['*'],
    public_metadata: { tenant_id: t.b.tenantId, roles: ['owner'] },
    private_metadata: { membership_id: t.b.owner.membershipId },
  });
  const before = (await h.auditsForTenant(t.b.tenantId)).length;
  const denied = await h.call(app, { bearer: forged, tenantId: t.b.tenantId, url: '/api/v1/memberships' });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  const context = await h.call(app, { bearer: forged, tenantId: t.a.tenantId, url: '/api/v1/__s107/whoami' });
  assert.equal(context.status, 200, JSON.stringify(context.json));
  assert.deepEqual(context.json, { tenantId: t.a.tenantId, userId: t.a.owner.user.id, membershipId: t.a.owner.membershipId });
  assert.equal((await h.auditsForTenant(t.b.tenantId)).length, before);
});

test('untrusted tenant header outside X-Tenant-Id cannot replace validated A context', async () => {
  const response = await h.call(app, { subject: t.a.owner.subject, tenantId: t.a.tenantId,
    url: '/api/v1/__s107/whoami', headers: { 'x-audit-tenant-id': t.b.tenantId } });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.tenantId, t.a.tenantId);
});

test('suspended/revoked membership and nonexistent membership do not pass tenant selection', async () => {
  const inactive = await h.member('s108-inactive');
  const rows = await h.createWorkshop([{ user: inactive.user, roles: ['owner'], status: 'suspended' }]);
  const noMembership = await h.member('s108-none');
  for (const [subject, tenantId] of [[inactive.subject, rows.tenantId], [noMembership.subject, t.b.tenantId]]) {
    const response = await h.call(app, { subject, tenantId, url: '/api/v1/memberships' });
    assert.equal(response.status, 403, JSON.stringify(response.json));
  }
});

test('onboarding identity-only creates its own tenant; A cannot nominate or modify B', async () => {
  const newcomer = h.identity('s108-onboard');
  const beforeB = await admin`SELECT status, display_name FROM public.workshops WHERE id = ${t.b.tenantId}`;
  const response = await h.onboard(app, newcomer, 'CrossTenant');
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.notEqual(response.json.workshop.id, t.b.tenantId);
  const afterB = await admin`SELECT status, display_name FROM public.workshops WHERE id = ${t.b.tenantId}`;
  assert.deepEqual(afterB, beforeB);
});

test('invitation acceptance uses exact token and verified email, not caller tenant/claims', async () => {
  const before = await admin`SELECT status FROM public.membership_invitations WHERE id = ${invitationB}`;
  const wrong = await h.accept(app, t.a.owner, tokenB, { headers: { 'x-tenant-id': t.a.tenantId } });
  assert.equal(wrong.status, 403, JSON.stringify(wrong.json));
  assert.equal(code(wrong), 'INVITATION_EMAIL_MISMATCH');
  const after = await admin`SELECT status FROM public.membership_invitations WHERE id = ${invitationB}`;
  assert.deepEqual(after, before);
  const denial = (await h.auditsForEntity(invitationB)).filter((row) => row.action === 'membership.invitation_accepted' && row.outcome === 'denied');
  assert.equal(denial.length, 1);
  assert.equal(denial[0].tenant_id, t.b.tenantId, 'valid token resolves B by design');
  assert.equal(denial[0].actor_membership_id, null);
  assert.equal(JSON.stringify(denial[0]).includes(t.a.tenantId), false);
});
