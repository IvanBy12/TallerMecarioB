'use strict';

const h = require('./helpers.cjs');
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

function expectError(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.json));
  assert.equal(response.json?.error?.code, code);
  assert.equal(typeof response.json.error.request_id, 'string');
}

test('owner assigns a staff role: 201, assigned_by = actor membership, role.assigned audit', async () => {
  const { a } = await h.twoTenants();
  const response = await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.deepEqual(response.json.membership.roles.map((r) => r.role), ['service_advisor', 'technician']);
  assert.equal(response.json.membership.membershipId, a.advisor.membershipId);
  assert.equal(response.headers['cache-control'], 'no-store');

  const rows = await h.rolesOf(a.advisor.membershipId);
  assert.deepEqual(rows.find((row) => row.code === 'technician'), { code: 'technician', assigned_by_membership_id: a.owner.membershipId });

  const audits = await h.roleAudits(a.advisor.membershipId);
  assert.equal(audits.length, 1);
  const [audit] = audits;
  assert.equal(audit.action, 'role.assigned');
  assert.equal(audit.outcome, 'success');
  assert.equal(audit.tenant_id, a.tenantId);
  assert.equal(audit.actor_type, 'user');
  assert.equal(audit.actor_user_id, a.owner.user.id);
  assert.equal(audit.actor_membership_id, a.owner.membershipId);
  assert.equal(audit.entity_type, 'membership_role');
  assert.deepEqual(audit.before_json, { roles: ['service_advisor'] });
  assert.deepEqual(audit.after_json, { roles: ['service_advisor', 'technician'] });
  assert.deepEqual(audit.metadata_json, { role: 'technician' });
  assert.equal(typeof audit.request_id, 'string');
  assert.equal(audit.user_agent, null);
  const serialized = JSON.stringify(audit);
  for (const secret of [a.advisor.email, a.owner.email, 'Bearer', 'eyJ']) assert.equal(serialized.includes(secret), false, secret);
});

test('owner may assign and remove owner/admin on another membership', async () => {
  const { a } = await h.twoTenants();
  let response = await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'admin' });
  assert.equal(response.status, 201);
  response = await h.assignRole(app, a.owner, a.tenantId, a.technician.membershipId, { role_code: 'owner' });
  assert.equal(response.status, 201);
  assert.equal(await h.activeOwners(a.tenantId), 2);

  response = await h.removeRole(app, a.owner, a.tenantId, a.technician.membershipId, 'owner');
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.deepEqual(response.json.membership.roles.map((r) => r.role), ['technician']);
  response = await h.removeRole(app, a.owner, a.tenantId, a.admin.membershipId, 'admin');
  assert.equal(response.status, 200);
  assert.deepEqual(await h.roleCodes(a.admin.membershipId), []);

  const audits = await h.roleAudits(a.technician.membershipId);
  assert.deepEqual(audits.map((row) => [row.action, row.outcome]), [['role.assigned', 'success'], ['role.revoked', 'success']]);
  assert.deepEqual(audits[1].before_json, { roles: ['owner', 'technician'] });
  assert.deepEqual(audits[1].after_json, { roles: ['technician'] });
});

test('admin manages staff roles only; escalation attempts are 403 with a committed denied audit', async () => {
  const { a } = await h.twoTenants();
  let response = await h.assignRole(app, a.admin, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
  assert.equal(response.status, 201);
  response = await h.removeRole(app, a.admin, a.tenantId, a.advisor.membershipId, 'technician');
  assert.equal(response.status, 200);

  for (const role of ['admin', 'owner']) {
    response = await h.assignRole(app, a.admin, a.tenantId, a.technician.membershipId, { role_code: role });
    expectError(response, 403, 'ROLE_ASSIGNMENT_NOT_ALLOWED');
  }
  // Privileged targets: an admin can't touch an owner/admin membership at all.
  response = await h.assignRole(app, a.admin, a.tenantId, a.owner.membershipId, { role_code: 'technician' });
  expectError(response, 403, 'ROLE_ASSIGNMENT_NOT_ALLOWED');
  response = await h.removeRole(app, a.admin, a.tenantId, a.owner.membershipId, 'owner');
  expectError(response, 403, 'ROLE_ASSIGNMENT_NOT_ALLOWED');

  assert.deepEqual(await h.roleCodes(a.technician.membershipId), ['technician']);
  assert.deepEqual(await h.roleCodes(a.owner.membershipId), ['owner']);

  const denied = (await h.roleAudits(a.technician.membershipId)).filter((row) => row.outcome === 'denied');
  assert.equal(denied.length, 2);
  assert.deepEqual(denied.map((row) => row.metadata_json), [
    { role: 'admin', missing_permissions: ['roles.assign_admin'] },
    { role: 'owner', missing_permissions: ['roles.assign_owner'] },
  ]);
  assert.ok(denied.every((row) => row.reason_code === 'role_assignment_not_permitted' && row.actor_membership_id === a.admin.membershipId));
  const ownerDenied = (await h.roleAudits(a.owner.membershipId)).filter((row) => row.outcome === 'denied');
  assert.deepEqual(ownerDenied.map((row) => row.action), ['role.assigned', 'role.revoked']);
});

test('advisor and technician (no memberships.manage_staff / memberships.read) get 403 and change nothing', async () => {
  const { a } = await h.twoTenants();
  for (const actor of [a.advisor, a.technician]) {
    expectError(await h.assignRole(app, actor, a.tenantId, a.admin.membershipId, { role_code: 'technician' }), 403, 'PERMISSION_DENIED');
    expectError(await h.removeRole(app, actor, a.tenantId, a.owner.membershipId, 'owner'), 403, 'PERMISSION_DENIED');
    expectError(await h.listRoles(app, actor, a.tenantId, a.owner.membershipId), 403, 'PERMISSION_DENIED');
  }
  assert.deepEqual(await h.roleCodes(a.admin.membershipId), ['admin']);
  assert.deepEqual(await h.roleCodes(a.owner.membershipId), ['owner']);
  assert.equal((await h.roleAudits(a.admin.membershipId)).length, 0);
});

test('owner and admin read a membership\'s roles; unknown or malformed id is 404', async () => {
  const { a } = await h.twoTenants();
  for (const actor of [a.owner, a.admin]) {
    const response = await h.listRoles(app, actor, a.tenantId, a.technician.membershipId);
    assert.equal(response.status, 200);
    assert.equal(response.json.membership.status, 'active');
    assert.deepEqual(response.json.membership.roles.map((r) => r.role), ['technician']);
    assert.match(response.json.membership.roles[0].assignedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
  expectError(await h.listRoles(app, a.owner, a.tenantId, '00000000-0000-4000-8000-000000000000'), 404, 'MEMBERSHIP_NOT_FOUND');
  expectError(await h.listRoles(app, a.owner, a.tenantId, 'not-a-uuid'), 404, 'MEMBERSHIP_NOT_FOUND');
  expectError(await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'superuser' }), 400, 'REQUEST_VALIDATION_FAILED');
  expectError(await h.removeRole(app, a.owner, a.tenantId, a.advisor.membershipId, 'superuser'), 400, 'REQUEST_VALIDATION_FAILED');
});

test('cross-tenant: tenant A cannot read, assign or remove roles of a tenant B membership', async () => {
  const { a, b } = await h.twoTenants();
  expectError(await h.listRoles(app, a.owner, a.tenantId, b.technician.membershipId), 404, 'MEMBERSHIP_NOT_FOUND');
  expectError(await h.assignRole(app, a.owner, a.tenantId, b.technician.membershipId, { role_code: 'service_advisor' }), 404, 'MEMBERSHIP_NOT_FOUND');
  expectError(await h.removeRole(app, a.owner, a.tenantId, b.technician.membershipId, 'technician'), 404, 'MEMBERSHIP_NOT_FOUND');
  expectError(await h.removeRole(app, a.owner, a.tenantId, b.owner.membershipId, 'owner'), 404, 'MEMBERSHIP_NOT_FOUND');
  // Selecting the foreign tenant is refused before any route code runs.
  expectError(await h.listRoles(app, a.owner, b.tenantId, b.technician.membershipId), 403, 'TENANT_ACCESS_DENIED');
  expectError(await h.assignRole(app, a.owner, b.tenantId, b.technician.membershipId, { role_code: 'admin' }), 403, 'TENANT_ACCESS_DENIED');
  // Same role name in both tenants grants nothing across them.
  expectError(await h.removeRole(app, b.owner, b.tenantId, a.owner.membershipId, 'owner'), 404, 'MEMBERSHIP_NOT_FOUND');

  assert.deepEqual(await h.roleCodes(b.technician.membershipId), ['technician']);
  assert.deepEqual(await h.roleCodes(b.owner.membershipId), ['owner']);
  assert.deepEqual(await h.roleCodes(a.owner.membershipId), ['owner']);
  assert.equal((await h.roleAudits(b.technician.membershipId)).length, 0);
});

test('duplicate assign is 409 and duplicate remove is 404, without extra rows or audits', async () => {
  const { a } = await h.twoTenants();
  assert.equal((await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' })).status, 201);
  expectError(await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }), 409, 'ROLE_ALREADY_ASSIGNED');
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor', 'technician']);

  assert.equal((await h.removeRole(app, a.owner, a.tenantId, a.advisor.membershipId, 'technician')).status, 200);
  expectError(await h.removeRole(app, a.owner, a.tenantId, a.advisor.membershipId, 'technician'), 404, 'ROLE_NOT_ASSIGNED');
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
  assert.deepEqual((await h.roleAudits(a.advisor.membershipId)).map((row) => row.action), ['role.assigned', 'role.revoked']);
});

test('suspended/revoked memberships: roles readable, never changed, never reactivated', async () => {
  const { a } = await h.twoTenants([
    { label: 'susp', roles: ['technician'], status: 'suspended' },
    { label: 'revk', roles: ['service_advisor'], status: 'revoked' },
  ]);
  for (const [target, held, status] of [[a.susp, 'technician', 'suspended'], [a.revk, 'service_advisor', 'revoked']]) {
    const read = await h.listRoles(app, a.owner, a.tenantId, target.membershipId);
    assert.equal(read.status, 200);
    assert.equal(read.json.membership.status, status);
    expectError(await h.assignRole(app, a.owner, a.tenantId, target.membershipId, { role_code: 'admin' }), 409, 'MEMBERSHIP_NOT_ACTIVE');
    expectError(await h.removeRole(app, a.owner, a.tenantId, target.membershipId, held), 409, 'MEMBERSHIP_NOT_ACTIVE');
    assert.equal(await h.statusOf(target.membershipId), status);
    assert.deepEqual(await h.roleCodes(target.membershipId), [held]);
    assert.equal((await h.roleAudits(target.membershipId)).length, 0);
  }
});

test('self-modification is forbidden (even for an owner) and the denied attempt is audited', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  expectError(await h.assignRole(app, a.owner, a.tenantId, a.owner.membershipId, { role_code: 'admin' }), 403, 'SELF_ROLE_MODIFICATION_FORBIDDEN');
  expectError(await h.removeRole(app, a.owner, a.tenantId, a.owner.membershipId, 'owner'), 403, 'SELF_ROLE_MODIFICATION_FORBIDDEN');
  expectError(await h.assignRole(app, a.admin, a.tenantId, a.admin.membershipId, { role_code: 'owner' }), 403, 'SELF_ROLE_MODIFICATION_FORBIDDEN');
  assert.deepEqual(await h.roleCodes(a.owner.membershipId), ['owner']);
  assert.deepEqual(await h.roleCodes(a.admin.membershipId), ['admin']);
  const audits = await h.roleAudits(a.owner.membershipId);
  assert.deepEqual(audits.map((row) => [row.action, row.outcome, row.reason_code]), [
    ['role.assigned', 'denied', 'self_role_modification'],
    ['role.revoked', 'denied', 'self_role_modification'],
  ]);
});

test('last owner: an owner can demote another owner but never leaves the workshop without an active owner', async () => {
  const { a } = await h.twoTenants([
    { label: 'owner2', roles: ['owner'] },
    { label: 'owner3', roles: ['owner'], status: 'suspended' },
  ]);
  assert.equal(await h.activeOwners(a.tenantId), 2);
  const response = await h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner');
  assert.equal(response.status, 200);
  assert.equal(await h.activeOwners(a.tenantId), 1);
  // The only other owner row is on a suspended membership: it does not count,
  // and it cannot be touched either.
  expectError(await h.removeRole(app, a.owner, a.tenantId, a.owner3.membershipId, 'owner'), 409, 'MEMBERSHIP_NOT_ACTIVE');
  // owner2 (no role left) has no permission at all.
  expectError(await h.removeRole(app, a.owner2, a.tenantId, a.owner.membershipId, 'owner'), 403, 'PERMISSION_DENIED');
  assert.equal(await h.activeOwners(a.tenantId), 1);
});

test('assigned_by_membership_id, tenant_id, permissions and extra fields in the body are rejected (400)', async () => {
  const { a, b } = await h.twoTenants();
  for (const body of [
    { role_code: 'technician', assigned_by_membership_id: a.admin.membershipId },
    { role_code: 'technician', tenant_id: b.tenantId },
    { role_code: 'technician', permissions: ['roles.assign_owner'] },
    { role_code: 'technician', role: 'owner' },
    { role: 'technician' },
    {},
  ]) {
    expectError(await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, body), 400, 'REQUEST_VALIDATION_FAILED');
  }
  const wrongType = await h.call(app, {
    subject: a.owner.subject, method: 'POST', url: `/api/v1/memberships/${a.advisor.membershipId}/roles`,
    tenantId: a.tenantId, rawBody: 'role_code=technician', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expectError(wrongType, 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await h.rolesOf(a.advisor.membershipId), [{ code: 'service_advisor', assigned_by_membership_id: a.advisor.membershipId }]);

  const ok = await h.assignRole(app, a.admin, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
  assert.equal(ok.status, 201);
  const technicianRow = (await h.rolesOf(a.advisor.membershipId)).find((row) => row.code === 'technician');
  assert.equal(technicianRow.assigned_by_membership_id, a.admin.membershipId);
});

test('forged Clerk org_role / org_permissions / metadata claims grant nothing', async () => {
  const { a } = await h.twoTenants();
  const forged = {
    org_role: 'org:admin',
    org_permissions: ['org:sys_memberships:manage', 'roles.assign_owner', 'memberships.manage_staff'],
    org_id: 'org_forged',
    metadata: { roles: ['owner'], permissions: ['roles.assign_owner'] },
    public_metadata: { role: 'owner' },
    role: 'owner',
    permissions: ['memberships.manage_staff', 'roles.assign_owner'],
  };
  expectError(await h.assignRole(app, a.technician, a.tenantId, a.advisor.membershipId, { role_code: 'owner' }, { claims: forged }), 403, 'PERMISSION_DENIED');
  expectError(await h.assignRole(app, a.admin, a.tenantId, a.advisor.membershipId, { role_code: 'owner' }, { claims: forged }), 403, 'ROLE_ASSIGNMENT_NOT_ALLOWED');
  const whoami = await h.call(app, { subject: a.technician.subject, url: '/api/v1/__s105/whoami', tenantId: a.tenantId, claims: forged });
  assert.deepEqual(whoami.json.roles, ['technician']);
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
});

test('rollback: a failure after the role write leaves no role row and no success audit', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  const restore = await h.injectFailure('audit_logs', "NEW.action IN ('role.assigned', 'role.revoked') AND NEW.outcome = 'success'");
  try {
    expectError(await h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }), 500, 'INTERNAL_ERROR');
    expectError(await h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner'), 500, 'INTERNAL_ERROR');
  } finally {
    await restore();
  }
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
  assert.deepEqual(await h.roleCodes(a.owner2.membershipId), ['owner']);
  assert.equal((await h.roleAudits(a.advisor.membershipId)).length, 0);
  assert.equal((await h.roleAudits(a.owner2.membershipId)).length, 0);
});

test('tenant GUCs never leak: pooled runtime connections carry no app.* context after requests', async () => {
  const { a } = await h.twoTenants();
  for (let i = 0; i < 6; i += 1) {
    await h.listRoles(app, a.owner, a.tenantId, a.technician.membershipId);
    await h.assignRole(app, a.owner, a.tenantId, a.technician.membershipId, { role_code: 'service_advisor' });
    await h.removeRole(app, a.owner, a.tenantId, a.technician.membershipId, 'service_advisor');
    await h.removeRole(app, a.owner, a.tenantId, a.owner.membershipId, 'owner');
  }
  const probes = await Promise.all(Array.from({ length: 10 }, () => h.apiPool`
    SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
      NULLIF(current_setting('app.membership_id', true), '') AS membership,
      NULLIF(current_setting('app.user_id', true), '') AS "user",
      (SELECT count(*)::int FROM public.membership_roles) AS visible_roles
  `));
  for (const [row] of probes) assert.deepEqual({ ...row }, { tenant: null, membership: null, user: null, visible_roles: 0 });
});
