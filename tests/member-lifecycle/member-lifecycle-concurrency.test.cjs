'use strict';

/**
 * S1-06 races on real PostgreSQL. Every interleaving is FORCED: competing
 * commands are parked behind a real lock (the tenant owner-set barrier, or a
 * privileged transaction that holds the owner gate in ACCESS EXCLUSIVE), the
 * test waits until pg_locks shows them waiting, then releases. No test may
 * produce a 500 (a 40P01 deadlock would surface as one).
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

const code = (response) => response.json?.error?.code;

function assertNo500(...responses) {
  for (const response of responses) {
    if (response && typeof response.status === 'number') assert.notEqual(response.status, 500, JSON.stringify(response.json));
  }
}

/** Rebuilds the success audit chain by content (created_at = tx start, not write order). */
async function assertChain(membershipId, from, to) {
  const audits = (await h.lifecycleAudits(membershipId)).filter((row) => row.outcome === 'success');
  let state = from;
  const pending = [...audits];
  while (pending.length > 0) {
    const next = pending.findIndex((row) => row.before_json.status === state);
    assert.ok(next >= 0, `audit chain broken at ${state}`);
    state = pending[next].after_json.status;
    pending.splice(next, 1);
  }
  assert.equal(state, to);
  return audits.length;
}

/* A ------------------------------------------------------------------------ */

test('A: suspend vs revoke of the same member, both forced orders: serialized, valid final state, consistent audit', async () => {
  for (const suspendFirst of [true, false]) {
    const { a } = await h.twoTenants();
    const runSuspend = () => h.suspend(app, a.owner, a.tenantId, a.advisor.membershipId);
    const runRevoke = () => h.revoke(app, a.admin, a.tenantId, a.advisor.membershipId);
    let suspended;
    let revoked;
    if (suspendFirst) [suspended, revoked] = await h.forcedOrder(a.tenantId, [runSuspend, runRevoke]);
    else [revoked, suspended] = await h.forcedOrder(a.tenantId, [runRevoke, runSuspend]);
    assertNo500(suspended, revoked);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
    assert.equal(await h.statusOf(a.advisor.membershipId), 'revoked');
    if (suspendFirst) {
      assert.equal(suspended.status, 200);
      assert.equal(await assertChain(a.advisor.membershipId, 'active', 'revoked'), 2);
    } else {
      assert.equal(suspended.status, 409);
      assert.equal(code(suspended), 'DOMAIN_INVALID_STATE_TRANSITION');
      assert.equal(await assertChain(a.advisor.membershipId, 'active', 'revoked'), 1);
    }
  }
});

test('A2: duplicate concurrent suspends / revokes: exactly one 200, the other 409, one success audit', async () => {
  for (const run of [h.suspend, h.revoke]) {
    const { a } = await h.twoTenants();
    const results = await h.forcedOrder(a.tenantId, [
      () => run(app, a.owner, a.tenantId, a.technician.membershipId),
      () => run(app, a.admin, a.tenantId, a.technician.membershipId),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await h.lifecycleAudits(a.technician.membershipId)).filter((row) => row.outcome === 'success').length, 1);
  }
});

/* B ------------------------------------------------------------------------ */

test('B: (reactivation is not a command) revoke vs role assignment on the same member, both forced orders', async () => {
  for (const revokeFirst of [true, false]) {
    const { a } = await h.twoTenants();
    const runRevoke = () => h.revoke(app, a.owner, a.tenantId, a.advisor.membershipId);
    const runAssign = () => h.assignRole(app, a.admin, a.tenantId, a.advisor.membershipId, { role_code: 'technician' });
    let revoked;
    let assigned;
    if (revokeFirst) [revoked, assigned] = await h.forcedOrder(a.tenantId, [runRevoke, runAssign]);
    else [assigned, revoked] = await h.forcedOrder(a.tenantId, [runAssign, runRevoke]);
    assertNo500(revoked, assigned);
    assert.equal(revoked.status, 200);
    assert.equal(await h.statusOf(a.advisor.membershipId), 'revoked');
    if (revokeFirst) {
      assert.equal(assigned.status, 409);
      assert.equal(code(assigned), 'MEMBERSHIP_NOT_ACTIVE');
      assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor']);
    } else {
      assert.equal(assigned.status, 201);
      assert.deepEqual(await h.roleCodes(a.advisor.membershipId), ['service_advisor', 'technician']);
      assert.deepEqual((await h.lifecycleAudits(a.advisor.membershipId))[0].metadata_json.roles, ['service_advisor', 'technician']);
    }
  }
});

/* C ------------------------------------------------------------------------ */

test('C: status change vs owner-role removal between two owners, both orders: never 0 active owners, loser denied', async () => {
  for (const statusCommand of [h.suspend, h.revoke]) {
    for (const statusFirst of [true, false]) {
      const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
      const runStatus = () => statusCommand(app, a.owner, a.tenantId, a.owner2.membershipId);
      const runRemove = () => h.removeRole(app, a.owner2, a.tenantId, a.owner.membershipId, 'owner');
      let status;
      let removal;
      if (statusFirst) [status, removal] = await h.forcedOrder(a.tenantId, [runStatus, runRemove]);
      else [removal, status] = await h.forcedOrder(a.tenantId, [runRemove, runStatus]);
      assertNo500(status, removal);
      assert.equal(await h.activeOwners(a.tenantId), 1);
      const winner = statusFirst ? status : removal;
      const loser = statusFirst ? removal : status;
      assert.equal(winner.status, 200, JSON.stringify(winner.json));
      assert.equal(loser.status, 403, JSON.stringify(loser.json));
      assert.equal(code(loser), 'PERMISSION_DENIED');
    }
  }
});

/* D ------------------------------------------------------------------------ */

test('D: two owners suspend/revoke each other at the same time: exactly one wins, an active owner always remains', async () => {
  const pairs = [[h.suspend, h.suspend], [h.revoke, h.revoke], [h.suspend, h.revoke], [h.revoke, h.suspend]];
  for (const [first, second] of pairs) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const [one, two] = await h.forcedOrder(a.tenantId, [
      () => first(app, a.owner, a.tenantId, a.owner2.membershipId),
      () => second(app, a.owner2, a.tenantId, a.owner.membershipId),
    ]);
    assertNo500(one, two);
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.equal(two.status, 403, JSON.stringify(two.json));
    assert.equal(code(two), 'PERMISSION_DENIED');
    assert.equal(await h.activeOwners(a.tenantId), 1);
    assert.equal(await h.statusOf(a.owner.membershipId), 'active');
  }
});

/* E ------------------------------------------------------------------------ */

test('E: the actor loses its permission (role removed / membership suspended) while its request waits: denied, nothing written', async () => {
  const demotions = [
    (tx, a) => tx`
      DELETE FROM public.membership_roles AS mr USING public.roles AS r
      WHERE r.id = mr.role_id AND r.code = 'admin' AND mr.membership_id = ${a.admin.membershipId}`,
    (tx, a) => tx`
      UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE id = ${a.admin.membershipId}`,
  ];
  for (const demote of demotions) {
    const { a } = await h.twoTenants();
    const privileged = await h.openPrivileged((tx) => demote(tx, a));
    let pending;
    try {
      pending = h.suspend(app, a.admin, a.tenantId, a.technician.membershipId);
      await h.waitForWaiters(1);
    } finally {
      await privileged.commit();
    }
    const response = await pending;
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(code(response), 'PERMISSION_DENIED');
    assert.equal(await h.statusOf(a.technician.membershipId), 'active');
    assert.equal((await h.lifecycleAudits(a.technician.membershipId)).length, 0);
  }
});

/* F ------------------------------------------------------------------------ */

test('F: the target changes while the command waits: status re-read (409) and authority re-evaluated on fresh roles (403)', async () => {
  {
    const { a } = await h.twoTenants();
    const privileged = await h.openPrivileged((tx) => tx`
      UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = ${a.technician.membershipId}`);
    let pending;
    try {
      pending = h.suspend(app, a.owner, a.tenantId, a.technician.membershipId);
      await h.waitForWaiters(1);
    } finally {
      await privileged.commit();
    }
    const response = await pending;
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(code(response), 'DOMAIN_INVALID_STATE_TRANSITION');
    assert.equal(await h.statusOf(a.technician.membershipId), 'revoked');
  }
  {
    // The target is promoted to owner while the admin's suspension waits.
    const { a } = await h.twoTenants();
    const ownerRole = await h.roleId('owner');
    const privileged = await h.openPrivileged(async (tx) => {
      await tx`UPDATE public.memberships SET updated_at = now() WHERE id = ${a.advisor.membershipId}`; // takes the gate
      await tx`INSERT INTO public.membership_roles ${tx({
        tenant_id: a.tenantId, membership_id: a.advisor.membershipId, role_id: ownerRole, assigned_by_membership_id: a.owner.membershipId,
      })}`;
    });
    let pending;
    try {
      pending = h.suspend(app, a.admin, a.tenantId, a.advisor.membershipId);
      await h.waitForWaiters(1);
    } finally {
      await privileged.commit();
    }
    const response = await pending;
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(code(response), 'DOMAIN_ACTION_FORBIDDEN');
    assert.equal(await h.statusOf(a.advisor.membershipId), 'active');
    const [denied] = (await h.lifecycleAudits(a.advisor.membershipId)).filter((row) => row.outcome === 'denied');
    assert.deepEqual(denied.metadata_json.missing_permissions, ['roles.assign_owner']);
  }
});

/* G ------------------------------------------------------------------------ */

test('G: tenants A and B progress in parallel: a parked tenant-A command never blocks a tenant-B command', async () => {
  const { a, b } = await h.twoTenants();
  const barrier = await h.holdTenantRoleLock(a.tenantId);
  let settledA = false;
  let pendingA;
  try {
    pendingA = h.suspend(app, a.owner, a.tenantId, a.technician.membershipId).then((response) => {
      settledA = true;
      return response;
    });
    await h.waitForWaiters(1);
    const started = Date.now();
    const responseB = await h.suspend(app, b.owner, b.tenantId, b.technician.membershipId);
    assert.equal(responseB.status, 200, JSON.stringify(responseB.json));
    assert.ok(Date.now() - started < 3000, 'tenant B was not delayed by tenant A');
    assert.equal(settledA, false, 'tenant A is still parked on its own lock');
    assert.equal(await h.statusOf(b.technician.membershipId), 'suspended');
  } finally {
    await barrier.release();
  }
  const responseA = await pendingA;
  assert.equal(responseA.status, 200);
  assert.equal(await h.statusOf(a.technician.membershipId), 'suspended');
});

/* H — S1-03 revocation handler ---------------------------------------------- */

test('H1: API suspend of an owner races the S1-03 revocation of that owner, both orders: no deadlock, valid end state', async () => {
  for (const apiFirst of [true, false, true, false]) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const runApi = () => h.suspend(app, a.owner2, a.tenantId, a.owner.membershipId);
    const runHandler = () => h.settle(h.runRevocationHandler(a.tenantId, a.owner));
    let api;
    let handler;
    if (apiFirst) [api, handler] = await h.forcedOrder(a.tenantId, [runApi, runHandler]);
    else [handler, api] = await h.forcedOrder(a.tenantId, [runHandler, runApi]);
    assertNo500(api);
    assert.ok(Array.isArray(handler), `handler must not fail: ${handler}`);
    assert.deepEqual(handler, ['revoked']);
    assert.equal(await h.statusOf(a.owner.membershipId), 'revoked');
    assert.equal(await h.activeOwners(a.tenantId), 1);
    if (apiFirst) {
      assert.equal(api.status, 200);
    } else {
      assert.equal(api.status, 409);
      assert.equal(code(api), 'DOMAIN_INVALID_STATE_TRANSITION');
    }
  }
});

test('H2: API revoke of a co-owner races the S1-03 revocation of the acting owner: never 0 owners (kept_last_owner or denied)', async () => {
  for (const apiFirst of [true, false, true, false]) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const runApi = () => h.revoke(app, a.owner, a.tenantId, a.owner2.membershipId);
    const runHandler = () => h.settle(h.runRevocationHandler(a.tenantId, a.owner));
    let api;
    let handler;
    if (apiFirst) [api, handler] = await h.forcedOrder(a.tenantId, [runApi, runHandler]);
    else [handler, api] = await h.forcedOrder(a.tenantId, [runHandler, runApi]);
    assertNo500(api);
    assert.ok(Array.isArray(handler), `handler must not fail: ${handler}`);
    assert.equal(await h.activeOwners(a.tenantId), 1);
    if (apiFirst) {
      assert.equal(api.status, 200);
      assert.deepEqual(handler, ['kept_last_owner']);
      assert.equal(await h.statusOf(a.owner.membershipId), 'active');
    } else {
      assert.deepEqual(handler, ['revoked']);
      assert.equal(api.status, 403);
      assert.equal(code(api), 'PERMISSION_DENIED');
      assert.equal(await h.statusOf(a.owner2.membershipId), 'active');
    }
  }
});
