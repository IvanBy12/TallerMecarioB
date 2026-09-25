'use strict';

/**
 * S1-06 membership lifecycle through the real HTTP pipeline: Clerk JWT ->
 * TenantContext transaction -> RBAC route guard -> service -> PostgreSQL
 * (NOBYPASSRLS api runtime, FORCE RLS).
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

const DTO_KEYS = ['joinedAt', 'membershipId', 'revokedAt', 'roles', 'status', 'suspendedAt'];

function errorCode(response) {
  return response.json?.error?.code;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

test('list: owner and admin see every membership of their tenant (all statuses), minimized DTO, no-store', async () => {
  const { a, b } = await h.twoTenants([
    { label: 'susp', roles: ['technician'], status: 'suspended' },
    { label: 'gone', roles: ['service_advisor'], status: 'revoked' },
  ]);
  for (const actor of [a.owner, a.admin]) {
    const response = await h.listMembers(app, actor, a.tenantId);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.headers['cache-control'], 'no-store');
    const byId = new Map(response.json.memberships.map((row) => [row.membershipId, row]));
    const expected = [a.owner, a.admin, a.advisor, a.technician, a.susp, a.gone].map((member) => member.membershipId);
    assert.deepEqual([...byId.keys()].sort(), [...expected].sort());
    for (const foreign of [b.owner, b.technician]) assert.equal(byId.has(foreign.membershipId), false);
    for (const row of byId.values()) assert.deepEqual(Object.keys(row).sort(), DTO_KEYS);
    assert.deepEqual(byId.get(a.owner.membershipId).roles.map((role) => role.role), ['owner']);
    assert.equal(byId.get(a.susp.membershipId).status, 'suspended');
    assert.ok(byId.get(a.susp.membershipId).suspendedAt);
    assert.equal(byId.get(a.gone.membershipId).status, 'revoked');
    assert.ok(byId.get(a.gone.membershipId).revokedAt);
    const serialized = JSON.stringify(response.json);
    for (const member of [a.owner, a.admin, a.advisor]) {
      assert.equal(serialized.includes(member.email), false, 'no email');
      assert.equal(serialized.includes(member.user.id), false, 'no user id');
    }
  }
});

test('list/read: advisor and technician are denied (memberships.read)', async () => {
  const { a } = await h.twoTenants();
  for (const actor of [a.advisor, a.technician]) {
    const list = await h.listMembers(app, actor, a.tenantId);
    assert.equal(list.status, 403);
    assert.equal(errorCode(list), 'PERMISSION_DENIED');
    const one = await h.getMember(app, actor, a.tenantId, a.owner.membershipId);
    assert.equal(one.status, 403);
    assert.equal(errorCode(one), 'PERMISSION_DENIED');
  }
});

test('read: one membership with roles; foreign, nonexistent and malformed ids are the same 404', async () => {
  const { a, b } = await h.twoTenants();
  const ok = await h.getMember(app, a.owner, a.tenantId, a.technician.membershipId);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.json.membership.membershipId, a.technician.membershipId);
  assert.equal(ok.json.membership.status, 'active');
  assert.deepEqual(ok.json.membership.roles.map((role) => role.role), ['technician']);

  const bodies = [];
  for (const id of [b.technician.membershipId, randomUUID(), 'not-a-uuid', b.owner.membershipId.toUpperCase()]) {
    const response = await h.getMember(app, a.owner, a.tenantId, id);
    assert.equal(response.status, 404, id);
    bodies.push({ code: errorCode(response), message: response.json.error.message });
  }
  for (const body of bodies) assert.deepEqual(body, { code: 'MEMBERSHIP_NOT_FOUND', message: bodies[0].message });
});

/* -------------------------------------------------------------------------- */
/* Commands: happy paths + audit                                              */
/* -------------------------------------------------------------------------- */

test('owner suspends staff: 200, status + suspended_at, roles and users.status untouched, success audit', async () => {
  const { a } = await h.twoTenants();
  const before = await h.membershipRow(a.advisor.membershipId);
  const response = await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.headers['cache-control'], 'no-store');
  const dto = response.json.membership;
  assert.deepEqual(Object.keys(dto).sort(), DTO_KEYS);
  assert.equal(dto.status, 'suspended');
  assert.ok(dto.suspendedAt);
  assert.equal(dto.revokedAt, null);
  assert.deepEqual(dto.roles.map((role) => role.role), ['service_advisor']);

  const row = await h.membershipRow(a.advisor.membershipId);
  assert.equal(row.status, 'suspended');
  assert.ok(row.suspended_at);
  assert.equal(row.revoked_at, null);
  for (const column of ['id', 'tenant_id', 'user_id']) assert.equal(row[column], before[column], column);
  assert.equal(row.joined_at.toISOString(), before.joined_at.toISOString());
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
  assert.equal(await h.userStatus(a.advisor.user.id), 'active', 'membership suspension never disables the user');

  const audits = await h.lifecycleAudits(a.advisor.membershipId);
  assert.equal(audits.length, 1);
  const [audit] = audits;
  assert.equal(audit.action, 'membership.suspended');
  assert.equal(audit.outcome, 'success');
  assert.equal(audit.tenant_id, a.tenantId);
  assert.equal(audit.actor_type, 'user');
  assert.equal(audit.actor_user_id, a.owner.user.id);
  assert.equal(audit.actor_membership_id, a.owner.membershipId);
  assert.equal(audit.entity_type, 'membership');
  assert.equal(audit.reason_code, 'member_status_management');
  assert.deepEqual(audit.before_json, { status: 'active' });
  assert.deepEqual(audit.after_json, { status: 'suspended' });
  assert.deepEqual(audit.metadata_json, { command: 'suspend', roles: ['service_advisor'] });
  assert.equal(audit.user_agent, null);
  assert.match(audit.request_id, /^[0-9a-f-]{36}$/u);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes(a.advisor.email), false);
  assert.equal(serialized.includes(a.owner.email), false);
  assert.equal(/bearer|eyJ/iu.test(serialized), false, 'no JWT');
});

test('the suspended/revoked member loses access on the next request (no cached authorization)', async () => {
  const { a } = await h.twoTenants();
  assert.equal((await h.whoami(app, a.advisor, a.tenantId)).status, 200);
  assert.equal((await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId)).status, 200);
  const suspended = await h.whoami(app, a.advisor, a.tenantId);
  assert.equal(suspended.status, 403);
  assert.equal(errorCode(suspended), 'TENANT_ACCESS_DENIED');

  assert.equal((await h.revoke(app, a.admin, a.tenantId, a.technician.membershipId)).status, 200);
  const revoked = await h.whoami(app, a.technician, a.tenantId);
  assert.equal(revoked.status, 403);
  assert.equal(errorCode(revoked), 'TENANT_ACCESS_DENIED');
});

test('admin revokes staff (active -> revoked) and owner revokes a suspended member (suspended -> revoked keeps suspended_at)', async () => {
  const { a } = await h.twoTenants();
  const revoked = await h.revoke(app, a.admin, a.tenantId, a.technician.membershipId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(revoked.json.membership.status, 'revoked');
  assert.equal(revoked.json.membership.suspendedAt, null);
  assert.ok(revoked.json.membership.revokedAt);
  assert.deepEqual(await h.roleCodes(a.technician.membershipId), ['technician'], 'roles kept as history');

  assert.equal((await h.suspend(app, a.admin, a.tenantId, a.advisor.membershipId)).status, 200);
  const suspendedAt = (await h.membershipRow(a.advisor.membershipId)).suspended_at.toISOString();
  const final = await h.revoke(app, a.owner, a.tenantId, a.advisor.membershipId);
  assert.equal(final.status, 200, JSON.stringify(final.json));
  const row = await h.membershipRow(a.advisor.membershipId);
  assert.equal(row.status, 'revoked');
  assert.equal(row.suspended_at.toISOString(), suspendedAt, 'suspension history kept');
  assert.ok(row.revoked_at);
  const chain = (await h.lifecycleAudits(a.advisor.membershipId)).map((audit) => [audit.action, audit.before_json.status, audit.after_json.status]);
  assert.deepEqual(chain, [['membership.suspended', 'active', 'suspended'], ['membership.revoked', 'suspended', 'revoked']]);
});

/* -------------------------------------------------------------------------- */
/* Status machine                                                             */
/* -------------------------------------------------------------------------- */

test('invalid transitions are 409 DOMAIN_INVALID_STATE_TRANSITION with no effect and no success audit', async () => {
  const { a } = await h.twoTenants([
    { label: 'susp', roles: ['technician'], status: 'suspended' },
    { label: 'gone', roles: ['technician'], status: 'revoked' },
  ]);
  const cases = [
    [h.suspend, a.susp, 'suspended'],
    [h.suspend, a.gone, 'revoked'],
    [h.revoke, a.gone, 'revoked'],
  ];
  for (const [run, target, status] of cases) {
    const before = await h.membershipRow(target.membershipId);
    const response = await run(app, a.owner, a.tenantId, target.membershipId);
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(errorCode(response), 'DOMAIN_INVALID_STATE_TRANSITION');
    const after = await h.membershipRow(target.membershipId);
    assert.equal(after.status, status);
    assert.deepEqual(after, before);
  }
  assert.equal((await h.tenantLifecycleAudits(a.tenantId)).length, 0);
});

test('there is no reactivation command (DECISION_REQUIRED): suspended/revoked stay as they are', async () => {
  const { a } = await h.twoTenants([
    { label: 'susp', roles: ['technician'], status: 'suspended' },
    { label: 'gone', roles: ['technician'], status: 'revoked' },
  ]);
  for (const target of [a.susp, a.gone]) {
    for (const path of ['reactivate', 'activate', 'restore']) {
      const response = await h.call(app, {
        subject: a.owner.subject, method: 'POST', tenantId: a.tenantId,
        url: `/api/v1/memberships/${target.membershipId}/${path}`,
      });
      assert.equal(response.status, 404, path);
    }
    // No generic status write either (Estados §1).
    for (const method of ['PATCH', 'PUT']) {
      const response = await h.call(app, {
        subject: a.owner.subject, method, tenantId: a.tenantId,
        url: `/api/v1/memberships/${target.membershipId}`, body: { status: 'active' },
      });
      assert.ok([404, 405].includes(response.status), `${method} ${response.status}`);
    }
  }
  assert.equal(await h.statusOf(a.susp.membershipId), 'suspended');
  assert.equal(await h.statusOf(a.gone.membershipId), 'revoked');
});

test('S1-05 role commands keep rejecting suspended/revoked targets (409 MEMBERSHIP_NOT_ACTIVE); reading roles still works', async () => {
  const { a } = await h.twoTenants();
  assert.equal((await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId)).status, 200);
  assert.equal((await h.revoke(app, a.owner, a.tenantId, a.technician.membershipId)).status, 200);
  for (const target of [a.advisor, a.technician]) {
    const assign = await h.assignRole(app, a.owner, a.tenantId, target.membershipId, { role_code: 'service_advisor' });
    assert.equal(assign.status, 409);
    assert.equal(errorCode(assign), 'MEMBERSHIP_NOT_ACTIVE');
    const read = await h.listRoles(app, a.owner, a.tenantId, target.membershipId);
    assert.equal(read.status, 200);
  }
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                              */
/* -------------------------------------------------------------------------- */

test('advisor and technician cannot suspend/revoke (403 PERMISSION_DENIED, nothing written), even with forged Clerk claims', async () => {
  const { a } = await h.twoTenants();
  const forged = { org_role: 'org:admin', org_permissions: ['memberships.manage_staff'], metadata: { role: 'owner' } };
  for (const actor of [a.advisor, a.technician]) {
    for (const run of [h.suspend, h.revoke]) {
      for (const claims of [undefined, forged]) {
        const response = await run(app, actor, a.tenantId, a.admin.membershipId, { claims });
        assert.equal(response.status, 403);
        assert.equal(errorCode(response), 'PERMISSION_DENIED');
      }
    }
  }
  assert.equal(await h.statusOf(a.admin.membershipId), 'active');
  assert.equal((await h.tenantLifecycleAudits(a.tenantId)).length, 0);
});

test('target authority: admin cannot suspend/revoke an owner or another admin (403 DOMAIN_ACTION_FORBIDDEN, durable denied audit); owner can manage an admin', async () => {
  const { a } = await h.twoTenants([{ label: 'admin2', roles: ['admin'] }]);
  const cases = [
    [h.suspend, a.owner, 'membership.suspended', ['roles.assign_owner']],
    [h.revoke, a.owner, 'membership.revoked', ['roles.assign_owner']],
    [h.suspend, a.admin2, 'membership.suspended', ['roles.assign_admin']],
    [h.revoke, a.admin2, 'membership.revoked', ['roles.assign_admin']],
  ];
  for (const [run, target, action, missing] of cases) {
    const response = await run(app, a.admin, a.tenantId, target.membershipId);
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(errorCode(response), 'DOMAIN_ACTION_FORBIDDEN');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(await h.statusOf(target.membershipId), 'active');
    const denied = (await h.lifecycleAudits(target.membershipId)).filter((row) => row.action === action);
    assert.equal(denied.length, 1, action);
    assert.equal(denied[0].outcome, 'denied');
    assert.equal(denied[0].reason_code, 'membership_management_not_permitted');
    assert.equal(denied[0].actor_membership_id, a.admin.membershipId);
    assert.deepEqual(denied[0].metadata_json.missing_permissions, missing);
    assert.equal(denied[0].user_agent, null);
  }
  assert.equal(await h.activeOwners(a.tenantId), 1);

  const ok = await h.suspend(app, a.owner, a.tenantId, a.admin2.membershipId);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('self-management is forbidden and audited: owner/admin cannot suspend or revoke their own membership', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  for (const actor of [a.owner, a.admin]) {
    for (const [run, action] of [[h.suspend, 'membership.suspended'], [h.revoke, 'membership.revoked']]) {
      const response = await run(app, actor, a.tenantId, actor.membershipId);
      assert.equal(response.status, 403, JSON.stringify(response.json));
      assert.equal(errorCode(response), 'DOMAIN_ACTION_FORBIDDEN');
      assert.equal(await h.statusOf(actor.membershipId), 'active');
      const rows = (await h.lifecycleAudits(actor.membershipId)).filter((row) => row.action === action);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, 'denied');
      assert.equal(rows[0].reason_code, 'self_membership_modification');
    }
  }
  // Even with a co-owner present (the invariant would allow it), self-exit is closed.
  assert.equal(await h.activeOwners(a.tenantId), 2);
});

test('last owner: the sole owner can be neither suspended nor revoked through the API', async () => {
  const { a } = await h.twoTenants();
  for (const run of [h.suspend, h.revoke]) {
    assert.equal((await run(app, a.owner, a.tenantId, a.owner.membershipId)).status, 403); // self
    assert.equal((await run(app, a.admin, a.tenantId, a.owner.membershipId)).status, 403); // authority
  }
  assert.equal(await h.activeOwners(a.tenantId), 1);
  assert.equal(await h.statusOf(a.owner.membershipId), 'active');
});

test('two owners: one can suspend then revoke the other; the tenant keeps exactly one active owner', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  const suspended = await h.suspend(app, a.owner, a.tenantId, a.owner2.membershipId);
  assert.equal(suspended.status, 200, JSON.stringify(suspended.json));
  assert.equal(await h.activeOwners(a.tenantId), 1);
  const revoked = await h.revoke(app, a.owner, a.tenantId, a.owner2.membershipId);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(await h.activeOwners(a.tenantId), 1);
  // The revoked co-owner has no access left to strike back.
  const back = await h.revoke(app, a.owner2, a.tenantId, a.owner.membershipId);
  assert.equal(back.status, 403);
  assert.equal(await h.statusOf(a.owner.membershipId), 'active');
});

/* -------------------------------------------------------------------------- */
/* Tenant isolation and request manipulation                                  */
/* -------------------------------------------------------------------------- */

test('cross-tenant: tenant A cannot read, suspend or revoke a tenant B membership (404, no effect, no audit)', async () => {
  const { a, b } = await h.twoTenants();
  const nonexistent = await h.suspend(app, a.owner, a.tenantId, randomUUID());
  for (const target of [b.technician, b.owner]) {
    for (const run of [h.getMember, h.suspend, h.revoke]) {
      const response = await run(app, a.owner, a.tenantId, target.membershipId);
      assert.equal(response.status, 404, JSON.stringify(response.json));
      assert.equal(errorCode(response), 'MEMBERSHIP_NOT_FOUND');
      assert.equal(response.json.error.message, nonexistent.json.error.message, 'indistinguishable from nonexistent');
    }
    assert.equal(await h.statusOf(target.membershipId), 'active');
  }
  assert.equal((await h.tenantLifecycleAudits(b.tenantId)).length, 0);
  // Selecting tenant B through the header is refused before any handler runs.
  const spoof = await h.suspend(app, a.owner, b.tenantId, b.technician.membershipId);
  assert.equal(spoof.status, 403);
  assert.equal(errorCode(spoof), 'TENANT_ACCESS_DENIED');
});

test('commands accept no input: tenant/actor/status/roles in the body are rejected (400) and change nothing', async () => {
  const { a, b } = await h.twoTenants();
  const bodies = [
    { tenant_id: b.tenantId },
    { actor_membership_id: a.owner.membershipId },
    { status: 'active' },
    { roles: ['owner'] },
    { permissions: ['memberships.manage_staff'] },
    { reason: 'x' },
  ];
  for (const body of bodies) {
    const response = await h.suspend(app, a.admin, a.tenantId, a.technician.membershipId, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(errorCode(response), 'REQUEST_VALIDATION_FAILED');
  }
  for (const rawBody of ['[]', 'null', '"x"', '1']) {
    const response = await h.revoke(app, a.admin, a.tenantId, a.technician.membershipId, { rawBody });
    assert.equal(response.status, 400, rawBody);
  }
  const text = await h.revoke(app, a.admin, a.tenantId, a.technician.membershipId, {
    rawBody: 'x', headers: { 'content-type': 'text/plain' },
  });
  assert.equal(text.status, 415);
  assert.equal(errorCode(text), 'UNSUPPORTED_MEDIA_TYPE');
  const noBody = await h.call(app, {
    subject: a.admin.subject, method: 'POST', tenantId: a.tenantId,
    url: `/api/v1/memberships/${a.technician.membershipId}/revoke`, headers: { 'content-type': 'application/json' }, rawBody: '',
  });
  assert.equal(noBody.status, 400, 'an empty application/json body is malformed JSON');
  assert.equal(await h.statusOf(a.technician.membershipId), 'active');
  assert.equal((await h.tenantLifecycleAudits(a.tenantId)).length, 0);

  const empty = await h.suspend(app, a.admin, a.tenantId, a.technician.membershipId, { body: {} });
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
});

/* -------------------------------------------------------------------------- */
/* Atomicity and connection hygiene                                           */
/* -------------------------------------------------------------------------- */

test('rollback: a failure writing the success audit leaves the membership unchanged (500, no partial effect)', async () => {
  const { a } = await h.twoTenants();
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'membership.suspended' AND NEW.outcome = 'success'");
  try {
    const response = await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId);
    assert.equal(response.status, 500);
    assert.equal(errorCode(response), 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(response.json).includes('TEST_INJECTED_FAILURE'), false, 'sanitized');
  } finally {
    await remove();
  }
  const row = await h.membershipRow(a.advisor.membershipId);
  assert.equal(row.status, 'active');
  assert.equal(row.suspended_at, null);
  assert.equal((await h.lifecycleAudits(a.advisor.membershipId)).length, 0);
});

test('tenant GUCs never leak to pooled connections after success, durable denial, conflict or failure', async () => {
  const { a } = await h.twoTenants([{ label: 'gone', roles: ['technician'], status: 'revoked' }]);
  await h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId); // 200
  await h.suspend(app, a.admin, a.tenantId, a.owner.membershipId); // 403 durable commit
  await h.revoke(app, a.owner, a.tenantId, a.gone.membershipId); // 409 rollback
  await h.suspend(app, a.owner, a.tenantId, a.owner.membershipId); // 403 self (durable)
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'membership.revoked'");
  try {
    await h.revoke(app, a.owner, a.tenantId, a.technician.membershipId); // 500 rollback
  } finally {
    await remove();
  }
  const probes = await Promise.all(Array.from({ length: 30 }, () => h.apiPool`
    SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.membership_id', true) AS membership,
      current_setting('app.user_id', true) AS "user", pg_catalog.txid_current_if_assigned() AS xid,
      (SELECT count(*)::int FROM public.memberships) AS visible
  `));
  for (const [probe] of probes) {
    assert.ok(probe.tenant === null || probe.tenant === '', `leaked tenant ${probe.tenant}`);
    assert.ok(probe.membership === null || probe.membership === '');
    assert.ok(probe.user === null || probe.user === '');
    assert.equal(probe.visible, 0, 'no rows visible without context');
  }
});
