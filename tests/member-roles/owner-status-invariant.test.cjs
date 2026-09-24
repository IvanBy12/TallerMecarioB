'use strict';

/**
 * S1-05 audit fix (0012): the active-owner invariant holds across
 * membership_roles AND memberships.status writes, enforced by PostgreSQL.
 * Every write here runs as a NOBYPASSRLS runtime role with the TenantContext
 * GUCs bound (h.asRuntime), i.e. without any Fastify guard in front of it.
 * Races park real transactions on the tenant owner-set advisory lock and
 * prove the wait through pg_locks before releasing.
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

const ownerViolation = (error) => error?.code === '23514' && error?.constraint_name === 'm_last_active_owner';
const roleOwnerViolation = (error) => error?.code === '23514' && error?.constraint_name === 'mr_last_active_owner';
const anyOwnerViolation = (error) => ownerViolation(error) || roleOwnerViolation(error);

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

const runtime = (pool, tenantId, fn, isolation) => h.asRuntime(pool, { tenantId, isolation }, fn);
const settle = (promise) => promise.then(() => 'ok', (error) => error);

/** Backends currently waiting on the tenant owner-set advisory lock. */
async function waitForAdvisoryWaiters(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`
      SELECT count(*)::int AS n FROM pg_catalog.pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
    `;
    if (row.n >= count) return;
    if (Date.now() > deadline) throw new Error(`ADVISORY_WAITERS_NOT_REACHED ${row.n}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Opens a runtime transaction, runs `fn`, and keeps it open until commit()/rollback(). */
async function openRuntime(pool, tenantId, fn) {
  const conn = await pool.reserve();
  await conn.unsafe('BEGIN');
  await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  try {
    await fn(conn);
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    conn.release();
    throw error;
  }
  return {
    async commit() { try { await conn.unsafe('COMMIT'); } finally { conn.release(); } },
    async rollback() { try { await conn.unsafe('ROLLBACK'); } finally { conn.release(); } },
  };
}

function revocationEvent(tenantId, membershipId, userId) {
  return {
    id: randomUUID(),
    tenantId,
    aggregateId: membershipId,
    eventType: MEMBERSHIP_REVOCATION_EVENT_TYPE,
    attempts: 1,
    payload: {
      type: MEMBERSHIP_REVOCATION_EVENT_TYPE,
      version: 1,
      reason: 'identity_provider_user_deleted',
      user_id: userId,
      membership_id: membershipId,
      webhook_event_id: randomUUID(),
    },
  };
}

async function runRevocation(tenantId, target) {
  const outcomes = [];
  const handler = createMembershipRevocationHandler({ onOutcome: (outcome) => outcomes.push(outcome.outcome) });
  await runtime(h.workerPool, tenantId, (tx) => handler(revocationEvent(tenantId, target.membershipId, target.user.id), tx));
  return outcomes;
}

/* A / B / I — single active owner ------------------------------------------ */

test('A/B: the only active owner cannot go active -> revoked or active -> suspended (api and worker runtimes)', async () => {
  const { a } = await h.twoTenants();
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const status of ['revoked', 'suspended']) {
      await assert.rejects(runtime(pool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, status)), ownerViolation, status);
    }
  }
  assert.equal(await h.statusOf(a.owner.membershipId), 'active');
  assert.equal(await h.activeOwners(a.tenantId), 1);
});

test('I: a suspended/revoked owner does not count as an active owner', async () => {
  const { a } = await h.twoTenants([
    { label: 'suspowner', roles: ['owner'], status: 'suspended' },
    { label: 'revkowner', roles: ['owner'], status: 'revoked' },
  ]);
  await assert.rejects(runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, 'revoked')), ownerViolation);
  // Reactivating an owner is an addition: no lock needed, always allowed by this guard.
  await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.suspowner.membershipId, 'active'));
  assert.equal(await h.activeOwners(a.tenantId), 2);
  await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, 'revoked'));
  assert.equal(await h.activeOwners(a.tenantId), 1);
});

/* C / H / J ------------------------------------------------------------------ */

test('C: with two active owners one may be suspended or revoked; the second one then cannot', async () => {
  for (const status of ['suspended', 'revoked']) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    await runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.owner2.membershipId, status));
    assert.equal(await h.statusOf(a.owner2.membershipId), status);
    await assert.rejects(runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, status)), ownerViolation);
    assert.equal(await h.activeOwners(a.tenantId), 1);
  }
});

test('H: non-owner memberships change status freely, even in a tenant that already has no active owner', async () => {
  const { a } = await h.twoTenants([{ label: 'extra', roles: ['service_advisor', 'admin'] }]);
  await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.technician.membershipId, 'suspended'));
  await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.technician.membershipId, 'active'));
  await runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.extra.membershipId, 'revoked'));
  assert.equal(await h.statusOf(a.technician.membershipId), 'active');
  assert.equal(await h.statusOf(a.extra.membershipId), 'revoked');

  // Legacy/broken tenant with zero active owners: the guard never blocks non-owners.
  const orphanOwner = await h.member('orphan');
  const staff = await h.member('staff');
  const orphan = await h.createWorkshop([
    { user: orphanOwner.user, roles: ['owner'], status: 'suspended' },
    { user: staff.user, roles: ['technician'] },
  ]);
  await runtime(h.apiPool, orphan.tenantId, (tx) => setStatus(tx, orphan.memberships[1], 'revoked'));
  assert.equal(await h.statusOf(orphan.memberships[1]), 'revoked');
});

test('J: tenants are independent; tenant A context cannot change tenant B memberships at all', async () => {
  const { a, b } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  // A has two owners: one may go; B's single owner may not.
  await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.owner2.membershipId, 'revoked'));
  await assert.rejects(runtime(h.apiPool, b.tenantId, (tx) => setStatus(tx, b.owner.membershipId, 'revoked')), ownerViolation);
  // RLS: with A's context the UPDATE of B's owner matches zero rows.
  const result = await runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, b.owner.membershipId, 'revoked'));
  assert.equal(result.count, 0);
  assert.equal(await h.statusOf(b.owner.membershipId), 'active');
  assert.equal(await h.activeOwners(b.tenantId), 1);
});

/* F — direct SQL ------------------------------------------------------------- */

test('F: direct runtime SQL cannot break the invariant (multi-row, mixed, in-transaction sequences)', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  // Both owners in ONE statement.
  await assert.rejects(runtime(h.apiPool, a.tenantId, (tx) => tx`
    UPDATE public.memberships SET status = 'revoked', revoked_at = now()
    WHERE id IN (${a.owner.membershipId}, ${a.owner2.membershipId})
  `), ownerViolation);
  // Role removal of one + status revoke of the other in one transaction.
  await assert.rejects(runtime(h.apiPool, a.tenantId, async (tx) => {
    await deleteOwnerRole(tx, a.owner.membershipId);
    await setStatus(tx, a.owner2.membershipId, 'suspended');
  }), ownerViolation);
  // Status first, then the role of the other one.
  await assert.rejects(runtime(h.apiPool, a.tenantId, async (tx) => {
    await setStatus(tx, a.owner2.membershipId, 'revoked');
    await deleteOwnerRole(tx, a.owner.membershipId);
  }), roleOwnerViolation);
  // Outside READ COMMITTED an owner reduction fails closed.
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await assert.rejects(runtime(h.apiPool, a.tenantId, (tx) => setStatus(tx, a.owner2.membershipId, 'revoked'), isolation), ownerViolation, isolation);
  }
  // Even a privileged (non-runtime) session goes through the trigger.
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE tenant_id = ${a.tenantId}`;
  }), ownerViolation);
  assert.equal(await h.activeOwners(a.tenantId), 2);
  // Runtime roles have no DELETE on memberships.
  await assert.rejects(runtime(h.apiPool, a.tenantId, (tx) => tx`DELETE FROM public.memberships WHERE id = ${a.technician.membershipId}`), (e) => e?.code === '42501');
  await assert.rejects(runtime(h.workerPool, a.tenantId, (tx) => tx`DELETE FROM public.memberships WHERE id = ${a.technician.membershipId}`), (e) => e?.code === '42501');
});

/* D / E — real concurrency ---------------------------------------------------- */

test('D: two owners revoked concurrently (status): exactly one commits, never 0 active owners', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const barrier = await h.holdTenantRoleLock(a.tenantId);
    let results;
    try {
      const pending = [a.owner, a.owner2].map((target, index) => settle(
        runtime(index === 0 ? h.apiPool : h.workerPool, a.tenantId, (tx) => setStatus(tx, target.membershipId, 'revoked')),
      ));
      await waitForAdvisoryWaiters(2);
      await barrier.release();
      results = await Promise.all(pending);
    } catch (error) {
      await barrier.release().catch(() => undefined);
      throw error;
    }
    assert.equal(results.filter((result) => result === 'ok').length, 1, String(results));
    assert.ok(results.some(ownerViolation), String(results));
    assert.equal(await h.activeOwners(a.tenantId), 1);
  }
});

test('no stale snapshot: a reducer that waited on the lock sees the reduction committed during its wait', async () => {
  // Every combination of {status revoke, owner-role delete} x {first, second}.
  const reducers = {
    status: (tx, target) => setStatus(tx, target.membershipId, 'revoked'),
    role: (tx, target) => deleteOwnerRole(tx, target.membershipId),
  };
  // Second reducer as the api runtime (waits in the BEFORE STATEMENT lock,
  // before touching rows) and as a privileged session without tenant context
  // (row already updated and row-locked, waits INSIDE the AFTER ROW trigger:
  // the check must still use a snapshot taken after the wait).
  const secondRunners = {
    runtime: (a, fn) => runtime(h.apiPool, a.tenantId, fn),
    privileged: (a, fn) => h.admin.begin(fn),
  };
  for (const [firstKind, secondKind] of [['status', 'status'], ['status', 'role'], ['role', 'status'], ['role', 'role']]) {
    for (const [runnerName, runSecond] of Object.entries(secondRunners)) {
      const label = `${firstKind}->${secondKind} (${runnerName})`;
      const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
      // First reducer: its trigger takes the lock and passes (owner2 still active), then stays OPEN.
      const first = await openRuntime(h.apiPool, a.tenantId, (tx) => reducers[firstKind](tx, a.owner));
      // Second reducer starts BEFORE the first commits and blocks on the lock.
      const second = settle(runSecond(a, (tx) => reducers[secondKind](tx, a.owner2)));
      await waitForAdvisoryWaiters(1);
      await first.commit();
      const outcome = await second;
      assert.ok(anyOwnerViolation(outcome), `${label}: ${outcome}`);
      assert.equal(await h.activeOwners(a.tenantId), 1, label);
    }
  }
});

test('E: owner-role removal via the API races a status revoke: never 0 active owners, no deadlock', async () => {
  for (const apiFirst of [true, false]) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const barrier = await h.holdTenantRoleLock(a.tenantId);
    let api;
    let status;
    try {
      // owner removes owner2's owner role (API) while owner's own membership is revoked (runtime SQL).
      const runApi = () => h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner');
      const runStatus = () => settle(runtime(h.workerPool, a.tenantId, (tx) => setStatus(tx, a.owner.membershipId, 'revoked')));
      if (apiFirst) {
        api = runApi();
        await waitForAdvisoryWaiters(1);
        status = runStatus();
      } else {
        status = runStatus();
        await waitForAdvisoryWaiters(1);
        api = runApi();
      }
      await waitForAdvisoryWaiters(2);
    } finally {
      await barrier.release();
    }
    const [apiResult, statusResult] = await Promise.all([api, status]);
    assert.equal(await h.activeOwners(a.tenantId), 1, `apiFirst=${apiFirst}`);
    assert.notEqual(apiResult.status, 500, JSON.stringify(apiResult.json));
    assert.ok(statusResult === 'ok' || ownerViolation(statusResult), String(statusResult));
    assert.ok(apiResult.status === 200 || statusResult === 'ok', 'at least one of the two reductions applies');
    assert.ok(!(apiResult.status === 200 && statusResult === 'ok'), 'never both');
  }
});

test('E: owner-role removal via the API races the S1-03 revocation handler: never 0 owners, no deadlock', async () => {
  // Both queue orders, forced: the first request is parked on the lock before
  // the second one starts (the API-first order is the one a lock-order
  // inversion in the handler would deadlock).
  for (const apiFirst of [true, false, true, false]) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const barrier = await h.holdTenantRoleLock(a.tenantId);
    let api;
    let handler;
    try {
      const runApi = () => h.removeRole(app, a.owner, a.tenantId, a.owner2.membershipId, 'owner');
      const runHandler = () => runRevocation(a.tenantId, a.owner).catch((error) => error);
      if (apiFirst) {
        api = runApi();
        await waitForAdvisoryWaiters(1);
        handler = runHandler();
      } else {
        handler = runHandler();
        await waitForAdvisoryWaiters(1);
        api = runApi();
      }
      await waitForAdvisoryWaiters(2);
    } finally {
      await barrier.release();
    }
    const [apiResult, handlerResult] = await Promise.all([api, handler]);
    assert.notEqual(apiResult.status, 500, JSON.stringify(apiResult.json));
    assert.ok(Array.isArray(handlerResult), `handler must not fail: ${handlerResult}`);
    assert.equal(await h.activeOwners(a.tenantId), 1);
    if (apiResult.status === 200) {
      assert.deepEqual(handlerResult, ['kept_last_owner']);
      assert.equal(await h.statusOf(a.owner.membershipId), 'active');
    } else {
      assert.deepEqual(handlerResult, ['revoked']);
    }
  }
});

/* G — S1-03 semantics preserved ------------------------------------------------ */

test('G: S1-03 revocation keeps the last owner (denied audit), revokes co-owners and staff; user disable alone changes no membership', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  assert.deepEqual(await runRevocation(a.tenantId, a.technician), ['revoked']);
  assert.deepEqual(await runRevocation(a.tenantId, a.owner2), ['revoked']);
  assert.deepEqual(await runRevocation(a.tenantId, a.owner), ['kept_last_owner']);
  assert.equal(await h.statusOf(a.owner.membershipId), 'active');
  const [kept] = await h.admin`
    SELECT outcome, reason_code FROM public.audit_logs
    WHERE entity_id = ${a.owner.membershipId} AND action = 'membership.revoked'
  `;
  assert.deepEqual({ ...kept }, { outcome: 'denied', reason_code: 'last_owner_invariant' });

  // users.status = 'disabled' does not imply memberships.status = 'revoked'.
  const { b } = await h.twoTenants();
  await h.admin`UPDATE public.users SET status = 'disabled' WHERE id = ${b.technician.user.id}`;
  await h.admin`UPDATE public.users SET status = 'disabled' WHERE id = ${b.owner.user.id}`;
  assert.equal(await h.statusOf(b.technician.membershipId), 'active');
  assert.equal(await h.statusOf(b.owner.membershipId), 'active');
});

/* Hygiene -------------------------------------------------------------------- */

test('0012 functions: invoker rights, fixed search_path, no PUBLIC EXECUTE, runtime-only EXECUTE; trigger installed', async () => {
  const functions = await h.admin`
    SELECT p.proname, p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
      has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_exec,
      has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker_exec
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname IN (
      'lock_tenant_owner_set', 'assert_tenant_keeps_active_owner',
      'enforce_membership_owner_invariant', 'enforce_membership_role_invariants')
    ORDER BY p.proname
  `;
  assert.equal(functions.length, 4);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false, fn.proname);
    assert.equal(fn.owner, 'tallermecario_schema_owner', fn.proname);
    assert.equal(fn.public_exec, false, fn.proname);
    assert.ok(fn.proconfig.some((setting) => setting.startsWith('search_path=pg_catalog')), fn.proname);
    if (['lock_tenant_owner_set', 'assert_tenant_keeps_active_owner'].includes(fn.proname)) {
      assert.deepEqual([fn.api_exec, fn.worker_exec], [true, true], fn.proname);
    }
  }
  const triggers = await h.admin`
    SELECT c.relname, t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname IN ('memberships_owner_invariant_trg', 'membership_roles_invariants_trg') AND t.tgenabled = 'O'
    ORDER BY c.relname
  `;
  assert.deepEqual(triggers.map((row) => `${row.relname}.${row.tgname}`), [
    'membership_roles.membership_roles_invariants_trg',
    'memberships.memberships_owner_invariant_trg',
  ]);
  const [bypass] = await h.admin`
    SELECT count(*)::int AS n FROM pg_catalog.pg_roles
    WHERE rolname IN ('tallermecario_api', 'tallermecario_worker') AND (rolbypassrls OR rolsuper)
  `;
  assert.equal(bypass.n, 0);
});
