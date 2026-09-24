'use strict';

/**
 * S1-05 audit fix round 2 (0013): owner-set lock hierarchy.
 *
 *   gate (app.owner_mutation_gate)  ->  tenant workshop row  ->  membership rows
 *
 * - No runtime can lock another tenant's owner set (grants + behavior).
 * - Privileged/unscoped writers take the gate EXCLUSIVE before any row, so the
 *   0012 privileged/runtime 40P01 cannot happen (forced interleavings, both
 *   orders, repeated).
 * - Every writer path parks on the hierarchy BEFORE holding any
 *   memberships / membership_roles row: proven with a third connection that
 *   row-locks the target rows with NOWAIT while the path is parked.
 */

const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');

const { assert } = h;
const { createMembershipRevocationHandler, MEMBERSHIP_REVOCATION_EVENT_TYPE } = h.load('identity/sync/membership-revocation.js');

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

const ROUNDS = 4;
const deadlock = (error) => error?.code === '40P01';
const ownerViolation = (error) => error?.code === '23514' && ['m_last_active_owner', 'mr_last_active_owner'].includes(error?.constraint_name);
const insufficientPrivilege = (error) => error?.code === '42501';
const settle = (promise) => promise.then(() => 'ok', (error) => error);
const TIMEOUT = Symbol('timeout');
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms))]);

function setStatus(conn, membershipId, status) {
  return conn`
    UPDATE public.memberships
    SET status = ${status},
      suspended_at = CASE WHEN ${status} = 'suspended' THEN now() ELSE NULL END,
      revoked_at = CASE WHEN ${status} = 'revoked' THEN now() ELSE NULL END,
      updated_at = now()
    WHERE id = ${membershipId}
  `;
}

function deleteOwnerRole(conn, membershipId) {
  return conn`
    DELETE FROM public.membership_roles AS mr USING public.roles AS r
    WHERE r.id = mr.role_id AND r.code = 'owner' AND mr.membership_id = ${membershipId}
  `;
}

const runtime = (pool, tenantId, fn) => h.asRuntime(pool, { tenantId }, fn);

/** Runs one statement inside SAVEPOINT on a manually-begun reserved connection. */
async function inSavepoint(conn, fn) {
  await conn.unsafe('SAVEPOINT s105_probe');
  try {
    await fn(conn);
    await conn.unsafe('RELEASE SAVEPOINT s105_probe');
  } catch (error) {
    await conn.unsafe('ROLLBACK TO SAVEPOINT s105_probe');
    throw error;
  }
}
const privileged = (fn) => h.admin.begin(fn);

/** Opens a transaction (runtime with tenant context, or privileged), runs fn, keeps it open. */
async function openTx(kind, tenantId, fn) {
  const conn = kind === 'privileged' ? await h.admin.reserve() : await (kind === 'worker' ? h.workerPool : h.apiPool).reserve();
  await conn.unsafe('BEGIN');
  if (kind !== 'privileged') await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  try {
    if (fn) await fn(conn);
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    conn.release();
    throw error;
  }
  return {
    conn,
    async commit() { try { await conn.unsafe('COMMIT'); } finally { conn.release(); } },
    async rollback() { try { await conn.unsafe('ROLLBACK'); } finally { conn.release(); } },
  };
}

/** Admin transaction holding a membership row lock only (SELECT FOR UPDATE fires no trigger). */
const holdRow = (membershipId) => openTx('privileged', null, (conn) => conn`SELECT id FROM public.memberships WHERE id = ${membershipId} FOR UPDATE`);

function revocationEvent(tenantId, target) {
  return {
    id: randomUUID(), tenantId, aggregateId: target.membershipId, eventType: MEMBERSHIP_REVOCATION_EVENT_TYPE, attempts: 1,
    payload: {
      type: MEMBERSHIP_REVOCATION_EVENT_TYPE, version: 1, reason: 'identity_provider_user_deleted',
      user_id: target.user.id, membership_id: target.membershipId, webhook_event_id: randomUUID(),
    },
  };
}

async function runRevocation(tenantId, target) {
  const outcomes = [];
  const handler = createMembershipRevocationHandler({ onOutcome: (outcome) => outcomes.push(outcome.outcome) });
  await runtime(h.workerPool, tenantId, (tx) => handler(revocationEvent(tenantId, target), tx));
  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* 1. Cross-tenant lock exposure                                              */
/* -------------------------------------------------------------------------- */

test('grants: the only runtime-executable owner-set function takes no tenant argument; the gate is ACCESS-SHARE-only for runtimes', async () => {
  const runtimeOwnerFunctions = await h.admin`
    SELECT p.oid::regprocedure::text AS signature, r.grantee
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    CROSS JOIN (VALUES ('tallermecario_api'), ('tallermecario_worker'), ('public')) AS r(grantee)
    WHERE n.nspname = 'app' AND p.proname ~ 'owner'
      AND has_function_privilege(r.grantee, p.oid, 'EXECUTE')
    ORDER BY 1, 2
  `;
  assert.deepEqual(runtimeOwnerFunctions.map((row) => `${row.grantee}:${row.signature}`), [
    'tallermecario_api:app.lock_current_tenant_owner_set()',
    'tallermecario_worker:app.lock_current_tenant_owner_set()',
  ]);

  const routinePrivileges = await h.admin`
    SELECT grantee, privilege_type FROM information_schema.routine_privileges
    WHERE routine_schema = 'app' AND routine_name = 'lock_current_tenant_owner_set'
      AND grantee IN ('tallermecario_api', 'tallermecario_worker', 'PUBLIC')
    ORDER BY grantee
  `;
  assert.deepEqual(routinePrivileges.map((row) => `${row.grantee}:${row.privilege_type}`), [
    'tallermecario_api:EXECUTE', 'tallermecario_worker:EXECUTE',
  ]);

  const gatePrivileges = await h.admin`
    SELECT grantee, privilege_type FROM information_schema.table_privileges
    WHERE table_schema = 'app' AND table_name = 'owner_mutation_gate'
      AND grantee IN ('tallermecario_api', 'tallermecario_worker', 'PUBLIC')
    ORDER BY grantee, privilege_type
  `;
  assert.deepEqual(gatePrivileges.map((row) => `${row.grantee}:${row.privilege_type}`), [
    'tallermecario_api:SELECT', 'tallermecario_worker:SELECT',
  ]);
  const [acl] = await h.admin`SELECT relacl::text[] AS acl FROM pg_catalog.pg_class WHERE oid = 'app.owner_mutation_gate'::regclass`;
  assert.ok(!acl.acl.some((entry) => entry.startsWith('=')), `no PUBLIC entry in ${acl.acl}`);
});

test('cross-tenant: a tenant-A runtime cannot lock tenant B by any supported means; B keeps working meanwhile', async () => {
  for (const kind of ['api', 'worker']) {
    const { a, b } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const holder = await openTx(kind, a.tenantId, async (conn) => {
      await conn`SELECT app.lock_current_tenant_owner_set()`;
      // Direct row lock of B's workshop: invisible under RLS, nothing locked.
      const rows = await conn`SELECT id FROM public.workshops WHERE id = ${b.tenantId} FOR NO KEY UPDATE`;
      assert.equal(rows.length, 0);
      // Any gate mode stronger than ACCESS SHARE is refused.
      for (const mode of ['ROW SHARE', 'ROW EXCLUSIVE', 'SHARE UPDATE EXCLUSIVE', 'SHARE', 'SHARE ROW EXCLUSIVE', 'EXCLUSIVE', 'ACCESS EXCLUSIVE']) {
        await assert.rejects(inSavepoint(conn, (sp) => sp.unsafe(`LOCK TABLE app.owner_mutation_gate IN ${mode} MODE`)), insufficientPrivilege, mode);
      }
      // The 0012 tenant-uuid helpers no longer exist.
      await assert.rejects(inSavepoint(conn, (sp) => sp`SELECT app.lock_tenant_owner_set(${b.tenantId}::uuid)`), (e) => e?.code === '42883');
      await assert.rejects(inSavepoint(conn, (sp) => sp`SELECT app.assert_tenant_keeps_active_owner(${b.tenantId}::uuid, 'x')`), (e) => e?.code === '42883');
      // The old 0012 advisory key is a public built-in, but nothing uses it anymore.
      await conn`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${'tallermecario.membership_roles.owner_set/' + b.tenantId}, 0))`;
    });
    let controlA;
    try {
      // While A holds everything it can, B's role command, status change and S1-03 job complete.
      const assign = await within(h.assignRole(app, b.owner, b.tenantId, b.technician.membershipId, { role_code: 'service_advisor' }), 3000);
      assert.notEqual(assign, TIMEOUT, `${kind}: B role command blocked by A`);
      assert.equal(assign.status, 201);
      const status = await within(settle(runtime(h.workerPool, b.tenantId, (tx) => setStatus(tx, b.technician.membershipId, 'suspended'))), 3000);
      assert.equal(status, 'ok', `${kind}: B status change`);
      const revoke = await within(runRevocation(b.tenantId, b.owner), 3000);
      assert.deepEqual(revoke, ['kept_last_owner'], `${kind}: B S1-03 job`);
      // Control: A's own owner set IS locked by the holder.
      controlA = h.assignRole(app, a.owner, a.tenantId, a.technician.membershipId, { role_code: 'service_advisor' });
      assert.equal(await within(controlA, 600), TIMEOUT, `${kind}: A's own owner set must be held`);
    } finally {
      await holder.commit();
    }
    assert.equal((await controlA).status, 201, `${kind}: A's command proceeds once its own lock is released`);
  }
});

test('cross-tenant: the runtime lock refuses to run without a tenant context', async () => {
  await assert.rejects(h.apiPool.begin((tx) => tx`SELECT app.lock_current_tenant_owner_set()`), (e) => e?.code === '55000');
  await assert.rejects(h.workerPool.begin((tx) => tx`SELECT app.lock_current_tenant_owner_set()`), (e) => e?.code === '55000');
});

/* -------------------------------------------------------------------------- */
/* 2. Privileged / runtime deadlock (the 0012 40P01), forced interleavings    */
/* -------------------------------------------------------------------------- */

test('runtime first: API owner-role removal (tenant lock held) vs privileged no-context write -> no 40P01', async () => {
  for (const privilegedOp of ['status', 'delete-role']) {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }, { label: 'owner3', roles: ['owner'] }]);
      // Park the API command after it took gate + tenant row: hold the ACTOR row.
      const barrier = await holdRow(a.owner.membershipId);
      let api;
      let priv;
      try {
        api = h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner');
        await h.waitForLockWaiters(1);
        priv = settle(privileged((tx) => (privilegedOp === 'status'
          ? setStatus(tx, a.owner2.membershipId, 'suspended')
          : deleteOwnerRole(tx, a.owner3.membershipId))));
        await h.waitForLockWaiters(2);
      } finally {
        await barrier.commit();
      }
      const [apiResult, privResult] = await Promise.all([api, priv]);
      assert.ok(!deadlock(privResult), `${privilegedOp}#${round}: privileged 40P01`);
      assert.notEqual(apiResult.status, 500, `${privilegedOp}#${round}: api ${JSON.stringify(apiResult.json)}`);
      assert.equal(apiResult.status, 200);
      assert.ok(privResult === 'ok' || ownerViolation(privResult), `${privilegedOp}#${round}: ${privResult}`);
      assert.ok(await h.activeOwners(a.tenantId) >= 1);
    }
  }
});

test('privileged first: open privileged reduction vs runtime reduction -> the runtime waits, then fails on the invariant; never 0 owners', async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const priv = await openTx('privileged', null, (conn) => setStatus(conn, a.owner2.membershipId, 'suspended'));
    let raw;
    let api;
    try {
      raw = settle(runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, 'revoked')));
      api = h.assignRole(app, a.owner, a.tenantId, a.technician.membershipId, { role_code: 'service_advisor' });
      await h.waitForLockWaiters(2);
    } finally {
      await priv.commit();
    }
    const [rawResult, apiResult] = await Promise.all([raw, api]);
    assert.ok(!deadlock(rawResult), `#${round}: runtime 40P01`);
    assert.ok(ownerViolation(rawResult), `#${round}: ${rawResult}`);
    assert.equal(apiResult.status, 201, JSON.stringify(apiResult.json));
    assert.equal(await h.activeOwners(a.tenantId), 1);
  }
});

test('S1-03 revocation vs privileged status UPDATE, both orders -> no 40P01, invariant held', async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    // Handler first: parked on owner2's row after taking gate + tenant row.
    {
      const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
      const barrier = await holdRow(a.owner2.membershipId);
      let handler;
      let priv;
      try {
        handler = runRevocation(a.tenantId, a.owner).catch((error) => error);
        await h.waitForLockWaiters(1);
        priv = settle(privileged((tx) => setStatus(tx, a.owner2.membershipId, 'suspended')));
        await h.waitForLockWaiters(2);
      } finally {
        await barrier.commit();
      }
      const [handlerResult, privResult] = await Promise.all([handler, priv]);
      assert.ok(!deadlock(handlerResult) && !deadlock(privResult), `handler-first#${round}: 40P01`);
      assert.deepEqual(handlerResult, ['revoked']);
      assert.ok(ownerViolation(privResult), `handler-first#${round}: ${privResult}`);
      assert.equal(await h.activeOwners(a.tenantId), 1);
    }
    // Privileged first.
    {
      const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
      const priv = await openTx('privileged', null, (conn) => setStatus(conn, a.owner2.membershipId, 'suspended'));
      let handler;
      try {
        handler = runRevocation(a.tenantId, a.owner).catch((error) => error);
        await h.waitForLockWaiters(1);
      } finally {
        await priv.commit();
      }
      const handlerResult = await handler;
      assert.ok(!deadlock(handlerResult), `privileged-first#${round}: 40P01`);
      assert.deepEqual(handlerResult, ['kept_last_owner']);
      assert.equal(await h.statusOf(a.owner.membershipId), 'active');
      assert.equal(await h.activeOwners(a.tenantId), 1);
    }
  }
});

test('privileged multi-row UPDATE across two tenants vs runtime owner work in both -> no 40P01', async () => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const { a, b } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const barrier = await holdRow(a.owner.membershipId);
    let api;
    let priv;
    let rawB;
    try {
      api = h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner');
      await h.waitForLockWaiters(1);
      priv = settle(privileged((tx) => tx`
        UPDATE public.memberships SET status = 'suspended', suspended_at = now()
        WHERE id IN (${a.technician.membershipId}, ${a.owner2.membershipId}, ${b.technician.membershipId})
      `));
      await h.waitForLockWaiters(2);
      rawB = settle(runtime(h.workerPool, b.tenantId, (tx) => setStatus(tx, b.owner.membershipId, 'revoked')));
    } finally {
      await barrier.commit();
    }
    const [apiResult, privResult, rawBResult] = await Promise.all([api, priv, rawB]);
    for (const result of [privResult, rawBResult]) assert.ok(!deadlock(result), `#${round}: 40P01`);
    assert.equal(apiResult.status, 200);
    assert.equal(privResult, 'ok');
    assert.ok(ownerViolation(rawBResult), `#${round}: B's single owner stays: ${rawBResult}`);
    assert.equal(await h.activeOwners(a.tenantId), 1);
    assert.equal(await h.activeOwners(b.tenantId), 1);
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Real lock order per path, reproduced with a third connection            */
/* -------------------------------------------------------------------------- */

test('every writer parks on the hierarchy BEFORE holding any membership / membership_roles row', async () => {
  // Each path: how to park it (holder kind) and the rows it will eventually write.
  const paths = [
    { name: 'POST role (API)', holder: 'tenant', run: (a) => h.assignRole(app, a.owner, a.tenantId, a.advisor.membershipId, { role_code: 'technician' }), rows: (a) => [a.advisor, a.owner] },
    { name: 'DELETE role (API)', holder: 'tenant', run: (a) => h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner'), rows: (a) => [a.owner2, a.owner] },
    { name: 'S1-03 revocation handler', holder: 'tenant', run: (a) => runRevocation(a.tenantId, a.owner2), rows: (a) => [a.owner, a.owner2] },
    { name: 'UPDATE memberships (api runtime)', holder: 'tenant', run: (a) => runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.owner2.membershipId, 'suspended')), rows: (a) => [a.owner2] },
    { name: 'UPDATE memberships (worker runtime)', holder: 'tenant', run: (a) => runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.owner2.membershipId, 'suspended')), rows: (a) => [a.owner2] },
    { name: 'UPDATE memberships (privileged, no context)', holder: 'gate', run: (a) => privileged((tx) => setStatus(tx, a.owner2.membershipId, 'suspended')), rows: (a) => [a.owner2] },
    { name: 'multi-row UPDATE (privileged)', holder: 'gate', run: (a) => privileged((tx) => tx`UPDATE public.memberships SET updated_at = now(), status = 'suspended', suspended_at = now() WHERE id IN (${a.technician.membershipId}, ${a.advisor.membershipId})`), rows: (a) => [a.technician, a.advisor] },
    { name: 'DELETE membership_roles (privileged fixture)', holder: 'gate', run: (a) => privileged((tx) => deleteOwnerRole(tx, a.owner2.membershipId)), rows: (a) => [a.owner2], roleRows: true },
  ];
  for (const path of paths) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    // Park: 'tenant' = a runtime-style holder of gate(SHARE)+workshop row;
    //       'gate'   = a holder of gate ACCESS SHARE only (blocks the EXCLUSIVE request).
    const holder = path.holder === 'tenant'
      ? await h.holdTenantRoleLock(a.tenantId)
      : await openTx('privileged', null, (conn) => conn`LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE`);
    let pending;
    try {
      pending = settle(Promise.resolve().then(() => path.run(a)));
      await h.waitForLockWaiters(1);
      // Third connection: every row the parked path will write must still be free.
      for (const target of path.rows(a)) {
        const probe = await openTx('privileged', null);
        try {
          const locked = await probe.conn`SELECT id FROM public.memberships WHERE id = ${target.membershipId} FOR UPDATE NOWAIT`;
          assert.equal(locked.length, 1, `${path.name}: membership row already held by the parked path`);
          if (path.roleRows) {
            await probe.conn`SELECT membership_id FROM public.membership_roles WHERE membership_id = ${target.membershipId} FOR UPDATE NOWAIT`;
          }
        } finally {
          await probe.rollback();
        }
      }
    } finally {
      if (holder.release) await holder.release(); else await holder.commit();
    }
    const outcome = await pending;
    assert.ok(!deadlock(outcome), `${path.name}: 40P01`);
    assert.ok(await h.activeOwners(a.tenantId) >= 1, path.name);
  }
});
