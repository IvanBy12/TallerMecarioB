'use strict';

/**
 * S1-05 races. Every test parks the competing requests behind a real lock
 * held by an admin transaction (tenant role-change advisory lock or the
 * target membership row), waits until PostgreSQL reports them blocked, then
 * releases: the interleaving is proven, not hoped for.
 */

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

async function race(tenantId, requests) {
  const barrier = await h.holdTenantRoleLock(tenantId);
  let pending;
  try {
    pending = requests.map((run) => run());
    await h.waitForLockWaiters(requests.length);
  } finally {
    await barrier.release();
  }
  return Promise.all(pending);
}

test('two owners demote each other concurrently: exactly one wins, an active owner always remains', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const [first, second] = await race(a.tenantId, [
      () => h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner'),
      () => h.removeRole(app, a.owner2, a.tenantId, a.owner.membershipId, 'owner'),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.equal(statuses[0], 200, JSON.stringify([first.json, second.json]));
    assert.ok(statuses[1] === 403 || statuses[1] === 409, JSON.stringify([first.json, second.json]));
    assert.equal(await h.activeOwners(a.tenantId), 1);
    const success = await h.admin`
      SELECT count(*)::int AS n FROM public.audit_logs
      WHERE tenant_id = ${a.tenantId} AND action = 'role.revoked' AND outcome = 'success'
    `;
    assert.equal(success[0].n, 1);
  }
});

test('permissions are re-read under the lock: an actor demoted while its request waits is denied', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  // Uncommitted demotion of owner2: its trigger holds the tenant owner-set
  // lock until COMMIT. owner2's request loads its (still owner) TenantContext,
  // then parks on that lock; after COMMIT it must re-read its real roles.
  const demotion = await h.admin.reserve();
  let pending;
  try {
    await demotion.unsafe('BEGIN');
    await demotion`
      DELETE FROM public.membership_roles AS mr USING public.roles AS r
      WHERE r.id = mr.role_id AND r.code = 'owner' AND mr.membership_id = ${a.owner2.membershipId}
    `;
    pending = h.assignRole(app, a.owner2, a.tenantId, a.technician.membershipId, { role_code: 'admin' });
    await h.waitForLockWaiters(1);
    await demotion.unsafe('COMMIT');
  } catch (error) {
    await demotion.unsafe('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    demotion.release();
  }
  const escalate = await pending;
  assert.equal(escalate.status, 403, JSON.stringify(escalate.json));
  assert.equal(escalate.json.error.code, 'PERMISSION_DENIED');
  assert.deepEqual(await h.roleCodes(a.technician.membershipId), ['technician']);
  assert.deepEqual(await h.roleCodes(a.owner2.membershipId), []);
});

test('duplicate concurrent assigns: one 201, one 409, one row, one success audit', async () => {
  const { a } = await h.twoTenants();
  const results = await race(a.tenantId, [
    () => h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }),
    () => h.assignRole(app, a.admin, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).json.error.code, 'ROLE_ALREADY_ASSIGNED');
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor', 'technician']);
  assert.equal((await h.roleAudits(a.advisor.membershipId)).filter((row) => row.outcome === 'success').length, 1);
});

test('duplicate concurrent removes: one 200, one 404, one success audit', async () => {
  const { a } = await h.twoTenants();
  const results = await race(a.tenantId, [
    () => h.removeRole(app, a.owner, a.tenantId, a.advisor.membershipId, 'service_advisor'),
    () => h.removeRole(app, a.admin, a.tenantId, a.advisor.membershipId, 'service_advisor'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
  assert.equal(results.find((r) => r.status === 404).json.error.code, 'ROLE_NOT_ASSIGNED');
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), []);
  assert.equal((await h.roleAudits(a.advisor.membershipId)).filter((row) => row.outcome === 'success').length, 1);
});

test('assign vs remove of the same role race: final state matches the serialized outcomes and the audit chain', async () => {
  const { a } = await h.twoTenants();
  const [assign, remove] = await race(a.tenantId, [
    () => h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }),
    () => h.removeRole(app, a.admin, a.tenantId, a.advisor.membershipId, 'technician'),
  ]);
  assert.equal(assign.status, 201);
  const roles = await h.roleCodes(a.advisor.membershipId);
  if (remove.status === 200) {
    assert.deepEqual(roles, ['service_advisor']);
  } else {
    assert.equal(remove.status, 404);
    assert.deepEqual(roles, ['service_advisor', 'technician']);
  }
  // Rebuild the audit chain by content: audit_logs.created_at is now() = the
  // TRANSACTION START, and the transaction that started first may take the
  // lock and write second, so timestamp order is not write order.
  const audits = (await h.roleAudits(a.advisor.membershipId)).filter((row) => row.outcome === 'success');
  assert.equal(audits.length, remove.status === 200 ? 2 : 1);
  let state = { roles: ['service_advisor'] };
  const pending = [...audits];
  while (pending.length > 0) {
    const next = pending.findIndex((row) => JSON.stringify(row.before_json) === JSON.stringify(state));
    assert.ok(next >= 0, `audit chain broken at ${JSON.stringify(state)}`);
    state = pending[next].after_json;
    pending.splice(next, 1);
  }
  assert.deepEqual(state, { roles });
});

test('assign vs remove of different roles on one membership: both apply, nothing is lost', async () => {
  const { a } = await h.twoTenants();
  const results = await race(a.tenantId, [
    () => h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }),
    () => h.removeRole(app, a.admin, a.tenantId, a.advisor.membershipId, 'service_advisor'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['technician']);
});

test('target status change race: a concurrent suspension wins the row lock, the assignment then fails 409', async () => {
  const { a } = await h.twoTenants();
  const suspension = await h.holdMembershipLock(a.advisor.membershipId, 'suspended');
  let pending;
  try {
    pending = h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
    await h.waitForLockWaiters(1);
  } finally {
    await suspension.release();
  }
  const response = await pending;
  assert.equal(response.status, 409, JSON.stringify(response.json));
  assert.equal(response.json.error.code, 'MEMBERSHIP_NOT_ACTIVE');
  assert.equal(await h.statusOf(a.advisor.membershipId), 'suspended');
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
});

test('target status change race, other order: the role change holds the row, the suspension waits for it', async () => {
  const { a } = await h.twoTenants();
  const barrier = await h.holdTenantRoleLock(a.tenantId);
  let assign;
  try {
    assign = h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
    await h.waitForLockWaiters(1);
  } finally {
    await barrier.release();
  }
  assert.equal((await assign).status, 201);
  await h.admin`UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = ${a.advisor.membershipId}`;
  assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor', 'technician']);
  const again = await h.removeRole(app, a.owner, a.tenantId, a.advisor.membershipId, 'technician');
  assert.equal(again.status, 409);
});
