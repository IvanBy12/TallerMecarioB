'use strict';

/**
 * S1-06 database layer: 0015 privileges on public.memberships, the owner
 * invariant (0012-0014) as seen by lifecycle writes, and RLS. Always through
 * the NOBYPASSRLS runtime logins; the admin connection only inspects catalogs
 * and seeds fixtures.
 */

const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

const { assert } = h;

after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

const LIFECYCLE_COLUMNS = ['revoked_at', 'status', 'suspended_at', 'updated_at'];
const insufficientPrivilege = (error) => error?.code === '42501';
const ownerViolation = (error) => error?.code === '23514' && error?.constraint_name === 'm_last_active_owner';

test('0015: api and worker hold UPDATE only on the lifecycle columns; no table UPDATE/DELETE/TRUNCATE; PUBLIC nothing', async () => {
  const columns = (await h.admin`
    SELECT a.attname FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.memberships'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  `).map((row) => row.attname);
  assert.ok(columns.length >= 9);
  for (const role of ['tallermecario_api', 'tallermecario_worker']) {
    const [table] = await h.admin`
      SELECT
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'SELECT') AS select,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'INSERT') AS insert,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'UPDATE') AS update,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'DELETE') AS delete,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'TRUNCATE') AS truncate,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'REFERENCES') AS references,
        pg_catalog.has_table_privilege(${role}, 'public.memberships', 'TRIGGER') AS trigger
    `;
    assert.deepEqual({ ...table }, {
      select: true, insert: true, update: false, delete: false, truncate: false, references: false, trigger: false,
    }, role);
    const updatable = [];
    for (const column of columns) {
      const [row] = await h.admin`SELECT pg_catalog.has_column_privilege(${role}, 'public.memberships', ${column}, 'UPDATE') AS ok`;
      if (row.ok) updatable.push(column);
    }
    assert.deepEqual(updatable.sort(), LIFECYCLE_COLUMNS, role);
  }
  const [pub] = await h.admin`
    SELECT
      pg_catalog.has_any_column_privilege('public', 'public.memberships', 'SELECT') AS select,
      pg_catalog.has_any_column_privilege('public', 'public.memberships', 'INSERT') AS insert,
      pg_catalog.has_any_column_privilege('public', 'public.memberships', 'UPDATE') AS update
  `;
  assert.deepEqual({ ...pub }, { select: false, insert: false, update: false });
});

test('0015: RLS stays ENABLE+FORCE with the same tenant policies; no new function, SECURITY DEFINER or BYPASSRLS role', async () => {
  const [relation] = await h.admin`
    SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_catalog.pg_class AS c
    WHERE c.oid = 'public.memberships'::regclass
  `;
  assert.deepEqual({ ...relation }, { relrowsecurity: true, relforcerowsecurity: true });
  const policies = (await h.admin`
    SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'memberships'
  `).map((row) => row.policyname).sort();
  assert.deepEqual(policies, ['tenant_insert', 'tenant_select', 'tenant_update']);

  const bypass = (await h.admin`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolname LIKE 'tallermecario%'
  `).map((row) => row.rolname);
  assert.deepEqual(bypass, ['tallermecario_bootstrap_resolver']);
  for (const role of ['tallermecario_api', 'tallermecario_worker']) {
    const [flags] = await h.admin`SELECT rolbypassrls, rolsuper FROM pg_catalog.pg_roles WHERE rolname = ${role}`;
    assert.deepEqual({ ...flags }, { rolbypassrls: false, rolsuper: false });
  }
  // No app function is executable by PUBLIC (0015 adds none).
  const [publicExec] = await h.admin`
    SELECT count(*)::int AS n FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
      AND p.prokind = 'f' AND p.prorettype <> 'trigger'::regtype
      AND p.proname NOT IN ('current_tenant_id')
  `;
  assert.equal(publicExec.n, 0);
});

test('runtime cannot rewrite identity columns of a membership of its own tenant (42501)', async () => {
  const { a } = await h.twoTenants();
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const [column, value] of [
      ['user_id', a.owner.user.id],
      ['tenant_id', a.tenantId],
      ['id', randomUUID()],
      ['joined_at', new Date(0)],
      ['created_at', new Date(0)],
    ]) {
      await assert.rejects(
        h.asRuntime(pool, { tenantId: a.tenantId }, (tx) => tx.unsafe(
          `UPDATE public.memberships SET ${column} = $1 WHERE id = $2`, [value, a.technician.membershipId],
        )),
        insufficientPrivilege,
        column,
      );
    }
  }
  const row = await h.membershipRow(a.technician.membershipId);
  assert.equal(row.user_id, a.technician.user.id);
});

test('row locks still work for both runtimes with column-level UPDATE (FOR UPDATE / NO KEY UPDATE / SHARE)', async () => {
  const { a } = await h.twoTenants();
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const mode of ['FOR UPDATE', 'FOR NO KEY UPDATE', 'FOR SHARE', 'FOR KEY SHARE']) {
      const rows = await h.asRuntime(pool, { tenantId: a.tenantId }, (tx) => tx.unsafe(
        `SELECT id FROM public.memberships WHERE id = $1 ${mode}`, [a.technician.membershipId],
      ));
      assert.equal(rows.length, 1, mode);
    }
  }
});

test('lifecycle writes by runtime: the sole active owner cannot become suspended/revoked (23514 m_last_active_owner); a co-owner can', async () => {
  const { a } = await h.twoTenants();
  const write = (status, id) => (tx) => (status === 'suspended'
    ? tx`UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = ${id}`
    : tx`UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${id}`);
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const status of ['suspended', 'revoked']) {
      await assert.rejects(h.asRuntime(pool, { tenantId: a.tenantId }, write(status, a.owner.membershipId)), ownerViolation, status);
    }
  }
  assert.equal(await h.activeOwners(a.tenantId), 1);

  const { a: pair } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  await h.asRuntime(h.apiPool, { tenantId: pair.tenantId }, write('suspended', pair.owner2.membershipId));
  await assert.rejects(h.asRuntime(h.apiPool, { tenantId: pair.tenantId }, write('revoked', pair.owner.membershipId)), ownerViolation);
  await h.asRuntime(h.apiPool, { tenantId: pair.tenantId }, write('revoked', pair.owner2.membershipId));
  assert.equal(await h.activeOwners(pair.tenantId), 1);
});

test('RLS: a runtime bound to tenant A cannot see or change a tenant B membership, even naming its id', async () => {
  const { a, b } = await h.twoTenants();
  for (const pool of [h.apiPool, h.workerPool]) {
    const result = await h.asRuntime(pool, { tenantId: a.tenantId }, async (tx) => ({
      seen: await tx`SELECT id FROM public.memberships WHERE id = ${b.technician.membershipId}`,
      updated: await tx`UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${b.technician.membershipId}`,
      locked: await tx`SELECT id FROM public.memberships WHERE id = ${b.technician.membershipId} FOR UPDATE`,
    }));
    assert.equal(result.seen.length, 0);
    assert.equal(result.updated.count, 0);
    assert.equal(result.locked.length, 0);
  }
  assert.equal(await h.statusOf(b.technician.membershipId), 'active');
  // Without a tenant context nothing is visible.
  const conn = await h.apiPool.reserve();
  try {
    await conn.unsafe('BEGIN');
    assert.equal((await conn`SELECT id FROM public.memberships`).length, 0);
    await conn.unsafe('ROLLBACK');
  } finally {
    conn.release();
  }
});
