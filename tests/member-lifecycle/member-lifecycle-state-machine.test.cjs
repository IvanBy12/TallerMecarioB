'use strict';

/**
 * S1-06 audit fix (0016): PostgreSQL enforces the membership lifecycle
 * contract against DIRECT SQL of the NOBYPASSRLS runtime roles (api and
 * worker), not only through the API commands.
 *
 *   allowed:   active -> suspended, active -> revoked, suspended -> revoked
 *   rejected:  every other status write (incl. same-state) -> 23514 m_status_transition
 *   timestamps: per-state CHECK memberships_lifecycle_state_check; history
 *              (only the entered state's timestamp may change) -> 23514 m_lifecycle_history
 *
 * Fixtures are seeded by h.createWorkshop (superuser, triggers off, coherent
 * timestamps); every write under test runs as a runtime login with the
 * TenantContext GUCs bound (h.asRuntime).
 */

const h = require('./helpers.cjs');
const { test, after } = require('node:test');

const { assert } = h;

after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

const RUNTIMES = [['api', h.apiPool], ['worker', h.workerPool]];
const violation = (constraint) => (error) => error?.code === '23514' && error?.constraint_name === constraint;
const transitionViolation = violation('m_status_transition');
const historyViolation = violation('m_lifecycle_history');
const stateCheckViolation = violation('memberships_lifecycle_state_check');
const anyCheckViolation = (error) => error?.code === '23514';

/** A tenant with an active owner and one target membership in `status`. */
async function tenantWith(status, roles = ['technician']) {
  const owner = await h.member('smowner');
  const target = await h.member('smtarget');
  const workshop = await h.createWorkshop([
    { user: owner.user, roles: ['owner'] },
    { user: target.user, roles, status },
  ]);
  return { tenantId: workshop.tenantId, ownerId: workshop.memberships[0], targetId: workshop.memberships[1] };
}

const run = (pool, tenantId, fn) => h.asRuntime(pool, { tenantId }, fn);

async function snapshot(membershipId) {
  const [row] = await h.admin`
    SELECT status, suspended_at, revoked_at FROM public.memberships WHERE id = ${membershipId}
  `;
  return { status: row.status, suspendedAt: row.suspended_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null };
}

/** Runs `sql` (with $1 = target id) as the runtime and expects `matcher`; the row must be unchanged. */
async function expectRejected(pool, fixture, sql, matcher, label) {
  const before = await snapshot(fixture.targetId);
  await assert.rejects(run(pool, fixture.tenantId, (tx) => tx.unsafe(sql, [fixture.targetId])), matcher, label);
  assert.deepEqual(await snapshot(fixture.targetId), before, `${label}: row unchanged`);
}

/* Allowed transitions (A, B, C) ------------------------------------------- */

test('A/B/C: active -> suspended, active -> revoked, suspended -> revoked succeed for api and worker with the right timestamps', async () => {
  for (const [name, pool] of RUNTIMES) {
    const a = await tenantWith('active');
    await run(pool, a.tenantId, (tx) => tx`
      UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = ${a.targetId}`);
    const suspended = await snapshot(a.targetId);
    assert.equal(suspended.status, 'suspended', name);
    assert.ok(suspended.suspendedAt);
    assert.equal(suspended.revokedAt, null);

    const b = await tenantWith('active');
    await run(pool, b.tenantId, (tx) => tx`
      UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${b.targetId}`);
    const revoked = await snapshot(b.targetId);
    assert.equal(revoked.status, 'revoked', name);
    assert.equal(revoked.suspendedAt, null, 'revoked directly: suspended_at stays NULL');
    assert.ok(revoked.revokedAt);

    const c = await tenantWith('suspended');
    const cBefore = await snapshot(c.targetId);
    await run(pool, c.tenantId, (tx) => tx`
      UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${c.targetId}`);
    const cAfter = await snapshot(c.targetId);
    assert.equal(cAfter.status, 'revoked', name);
    assert.equal(cAfter.suspendedAt, cBefore.suspendedAt, 'suspended_at kept from suspended');
    assert.ok(cAfter.revokedAt);
  }
});

/* Forbidden transitions (D-I) ---------------------------------------------- */

test('D-I: reactivation, revoked -> suspended and same-state status writes are rejected (m_status_transition) for api and worker', async () => {
  const cases = [
    ['D suspended -> active', 'suspended', [
      "UPDATE public.memberships SET status = 'active' WHERE id = $1",
      "UPDATE public.memberships SET status = 'active', suspended_at = NULL, updated_at = now() WHERE id = $1",
    ]],
    ['E revoked -> active', 'revoked', [
      "UPDATE public.memberships SET status = 'active' WHERE id = $1",
      "UPDATE public.memberships SET status = 'active', revoked_at = NULL, suspended_at = NULL, updated_at = now() WHERE id = $1",
    ]],
    ['F revoked -> suspended', 'revoked', [
      "UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = $1",
      "UPDATE public.memberships SET status = 'suspended', suspended_at = now(), revoked_at = NULL WHERE id = $1",
    ]],
    ['G active -> active', 'active', [
      "UPDATE public.memberships SET status = 'active' WHERE id = $1",
      "UPDATE public.memberships SET status = 'active', updated_at = now() WHERE id = $1",
    ]],
    ['H suspended -> suspended', 'suspended', [
      "UPDATE public.memberships SET status = 'suspended' WHERE id = $1",
      "UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = $1",
    ]],
    ['I revoked -> revoked', 'revoked', [
      "UPDATE public.memberships SET status = 'revoked' WHERE id = $1",
      "UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = $1",
    ]],
  ];
  for (const [name, pool] of RUNTIMES) {
    for (const [label, from, statements] of cases) {
      const fixture = await tenantWith(from);
      for (const sql of statements) await expectRejected(pool, fixture, sql, transitionViolation, `${name} ${label}: ${sql}`);
    }
  }
});

/* Timestamp invariants (J-N) and history ----------------------------------- */

test('J-N: runtime cannot produce inconsistent timestamps by UPDATE (history guard or state CHECK)', async () => {
  const cases = [
    ['J active + suspended_at', 'active', 'UPDATE public.memberships SET suspended_at = now() WHERE id = $1', historyViolation],
    ['K active + revoked_at', 'active', 'UPDATE public.memberships SET revoked_at = now() WHERE id = $1', historyViolation],
    ['L suspended without suspended_at', 'suspended', 'UPDATE public.memberships SET suspended_at = NULL WHERE id = $1', historyViolation],
    ['L2 active -> suspended without suspended_at', 'active', "UPDATE public.memberships SET status = 'suspended' WHERE id = $1", anyCheckViolation],
    ['M suspended + revoked_at', 'suspended', 'UPDATE public.memberships SET revoked_at = now() WHERE id = $1', historyViolation],
    ['N revoked without revoked_at', 'revoked', 'UPDATE public.memberships SET revoked_at = NULL WHERE id = $1', historyViolation],
    ['N2 active -> revoked without revoked_at', 'active', "UPDATE public.memberships SET status = 'revoked' WHERE id = $1", anyCheckViolation],
    ['suspended -> revoked clearing suspended_at', 'suspended', "UPDATE public.memberships SET status = 'revoked', revoked_at = now(), suspended_at = NULL WHERE id = $1", historyViolation],
    ['active -> suspended also writing revoked_at', 'active', "UPDATE public.memberships SET status = 'suspended', suspended_at = now(), revoked_at = now() WHERE id = $1", historyViolation],
    ['suspended_at rewritten while suspended', 'suspended', "UPDATE public.memberships SET suspended_at = now() - interval '1 day' WHERE id = $1", historyViolation],
    ['revoked_at rewritten while revoked', 'revoked', "UPDATE public.memberships SET revoked_at = now() - interval '1 day' WHERE id = $1", historyViolation],
  ];
  for (const [name, pool] of RUNTIMES) {
    for (const [label, from, sql, matcher] of cases) {
      await expectRejected(pool, await tenantWith(from), sql, matcher, `${name} ${label}`);
    }
  }
});

test('J-M on INSERT: runtime cannot create a membership with inconsistent timestamps (memberships_lifecycle_state_check)', async () => {
  for (const [name, pool] of RUNTIMES) {
    const fixture = await tenantWith('active');
    const cases = [
      ['active + suspended_at', "'active'", 'now()', 'NULL'],
      ['suspended + revoked_at', "'suspended'", 'now()', 'now()'],
    ];
    for (const [label, status, suspendedAt, revokedAt] of cases) {
      const user = await h.createUser();
      await assert.rejects(run(pool, fixture.tenantId, (tx) => tx.unsafe(`
        INSERT INTO public.memberships (id, tenant_id, user_id, status, suspended_at, revoked_at)
        VALUES (gen_random_uuid(), $1, $2, ${status}, ${suspendedAt}, ${revokedAt})
      `, [fixture.tenantId, user.id])), stateCheckViolation, `${name} ${label}`);
    }
  }
});

test('an UPDATE of updated_at alone stays allowed in every state, timestamps untouched', async () => {
  for (const [name, pool] of RUNTIMES) {
    for (const status of ['active', 'suspended', 'revoked']) {
      const fixture = await tenantWith(status);
      const before = await snapshot(fixture.targetId);
      const result = await run(pool, fixture.tenantId, (tx) => tx`UPDATE public.memberships SET updated_at = now() WHERE id = ${fixture.targetId}`);
      assert.equal(result.count, 1, `${name} ${status}`);
      assert.deepEqual(await snapshot(fixture.targetId), before);
    }
  }
});

/* Interplay with the owner invariant, RLS and privileged sessions ---------- */

test('owner invariant unchanged: the sole active owner still cannot leave (m_last_active_owner); a revoked owner cannot be reactivated', async () => {
  for (const [name, pool] of RUNTIMES) {
    const fixture = await tenantWith('active');
    for (const sql of [
      "UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = $1",
      "UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = $1",
    ]) {
      await assert.rejects(run(pool, fixture.tenantId, (tx) => tx.unsafe(sql, [fixture.ownerId])), violation('m_last_active_owner'), name);
    }
    assert.equal(await h.activeOwners(fixture.tenantId), 1);

    const revokedOwner = await tenantWith('revoked', ['owner']);
    await assert.rejects(run(pool, revokedOwner.tenantId, (tx) => tx.unsafe(
      "UPDATE public.memberships SET status = 'active', revoked_at = NULL WHERE id = $1", [revokedOwner.targetId],
    )), transitionViolation, name);
    assert.equal(await h.activeOwners(revokedOwner.tenantId), 1);
  }
});

test('cross-tenant: a runtime bound to tenant A matches zero rows of tenant B for any status write', async () => {
  const a = await tenantWith('active');
  const b = await tenantWith('revoked');
  const bActive = await tenantWith('active');
  for (const [name, pool] of RUNTIMES) {
    const reactivate = await run(pool, a.tenantId, (tx) => tx`
      UPDATE public.memberships SET status = 'active', revoked_at = NULL WHERE id = ${b.targetId}`);
    const suspend = await run(pool, a.tenantId, (tx) => tx`
      UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = ${bActive.targetId}`);
    assert.equal(reactivate.count, 0, name);
    assert.equal(suspend.count, 0, name);
  }
  assert.equal((await snapshot(b.targetId)).status, 'revoked');
  assert.equal((await snapshot(bActive.targetId)).status, 'active');
});

test('privileged sessions go through the same guard; only superuser setup with triggers off (replica) bypasses it', async () => {
  const fixture = await tenantWith('revoked');
  await assert.rejects(h.admin.begin((tx) => tx`
    UPDATE public.memberships SET status = 'active', revoked_at = NULL WHERE id = ${fixture.targetId}`), transitionViolation);
  // Documented maintenance boundary (ADR-009 §10.1): triggers off, the CHECK still applies.
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE public.memberships SET status = 'active' WHERE id = ${fixture.targetId}`;
  }), stateCheckViolation);
  assert.equal((await snapshot(fixture.targetId)).status, 'revoked');
});

test('0016 catalog: CHECK validated, triggers enabled, invoker functions without EXECUTE for anyone; 0015 grants preserved', async () => {
  const [check] = await h.admin`
    SELECT convalidated FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.memberships'::regclass AND conname = 'memberships_lifecycle_state_check'
  `;
  assert.equal(check?.convalidated, true);
  const triggers = await h.admin`
    SELECT t.tgname, t.tgenabled, p.proname, p.prosecdef, p.proconfig
    FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'public.memberships'::regclass
      AND t.tgname IN ('memberships_status_transition_trg', 'memberships_timestamp_history_trg')
    ORDER BY t.tgname
  `;
  assert.deepEqual(triggers.map((row) => [row.tgname, row.tgenabled, row.prosecdef]), [
    ['memberships_status_transition_trg', 'O', false],
    ['memberships_timestamp_history_trg', 'O', false],
  ]);
  for (const row of triggers) {
    assert.deepEqual(row.proconfig, ['search_path=pg_catalog, public']);
    for (const role of ['public', 'tallermecario_api', 'tallermecario_worker']) {
      const [exec] = await h.admin`SELECT pg_catalog.has_function_privilege(${role}, ${`app.${row.proname}()`}, 'EXECUTE') AS ok`;
      assert.equal(exec.ok, false, `${role} EXECUTE ${row.proname}`);
    }
  }
  for (const role of ['tallermecario_api', 'tallermecario_worker']) {
    const columns = (await h.admin`
      SELECT a.attname FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = 'public.memberships'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_catalog.has_column_privilege(${role}, 'public.memberships', a.attname, 'UPDATE')
      ORDER BY a.attname
    `).map((row) => row.attname);
    assert.deepEqual(columns, ['revoked_at', 'status', 'suspended_at', 'updated_at'], role);
  }
});
