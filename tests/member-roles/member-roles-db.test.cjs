'use strict';

/**
 * S1-05 database layer (0011), exercised directly as the NOBYPASSRLS runtime
 * roles with the TenantContext GUCs bound — i.e. WITHOUT the API guard: the
 * trigger and the RLS policies must hold on their own.
 */

const h = require('./helpers.cjs');
const { test, after } = require('node:test');

const { assert } = h;

after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

const lastOwner = (error) => error?.code === '23514' && error?.constraint_name === 'mr_last_active_owner';
const notActive = (error) => error?.code === '23514' && error?.constraint_name === 'mr_membership_not_active';
const insufficientPrivilege = (error) => error?.code === '42501';

async function deleteRole(conn, tenantId, membershipId, role) {
  return conn`
    DELETE FROM public.membership_roles AS mr USING public.roles AS r
    WHERE r.id = mr.role_id AND r.code = ${role} AND mr.tenant_id = ${tenantId} AND mr.membership_id = ${membershipId}
  `;
}

async function insertRole(conn, tenantId, membershipId, role, assignedBy) {
  return conn`
    INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
    SELECT ${tenantId}, ${membershipId}, r.id, ${assignedBy} FROM public.roles AS r WHERE r.code = ${role}
  `;
}

test('trigger: the last active owner row cannot be deleted by the runtime, even bypassing the API', async () => {
  const { a } = await h.twoTenants([{ label: 'owner3', roles: ['owner'], status: 'suspended' }]);
  await assert.rejects(
    h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => deleteRole(tx, a.tenantId, a.owner.membershipId, 'owner')),
    lastOwner,
  );
  assert.deepEqual(await h.roleCodes(a.owner.membershipId), ['owner']);
  // A non-owner role and an owner row on a suspended membership are not guarded by it.
  await h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => deleteRole(tx, a.tenantId, a.technician.membershipId, 'technician'));
  await h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => deleteRole(tx, a.tenantId, a.owner3.membershipId, 'owner'));
  assert.equal(await h.activeOwners(a.tenantId), 1);
});

test('trigger: concurrent raw deletes of the two owners serialize; one fails, one active owner remains', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
    const barrier = await h.holdTenantRoleLock(a.tenantId);
    let results;
    try {
      const pending = [a.owner, a.owner2].map((target) => h.asRuntime(h.apiPool, { tenantId: a.tenantId },
        (tx) => deleteRole(tx, a.tenantId, target.membershipId, 'owner')).then(() => 'ok', (error) => error));
      await h.waitForLockWaiters(2);
      await barrier.release();
      results = await Promise.all(pending);
    } catch (error) {
      await barrier.release().catch(() => undefined);
      throw error;
    }
    assert.equal(results.filter((result) => result === 'ok').length, 1, String(results));
    assert.ok(results.some((result) => lastOwner(result)), String(results));
    assert.equal(await h.activeOwners(a.tenantId), 1);
  }
});

test('trigger: owner removal outside READ COMMITTED fails closed', async () => {
  const { a } = await h.twoTenants([{ label: 'owner2', roles: ['owner'] }]);
  for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
    await assert.rejects(
      h.asRuntime(h.apiPool, { tenantId: a.tenantId, isolation }, (tx) => deleteRole(tx, a.tenantId, a.owner2.membershipId, 'owner')),
      lastOwner,
      isolation,
    );
  }
  assert.equal(await h.activeOwners(a.tenantId), 2);
});

test('trigger: roles can only be inserted on an active membership (no reactivation by assignment)', async () => {
  const { a } = await h.twoTenants([
    { label: 'susp', roles: ['technician'], status: 'suspended' },
    { label: 'revk', roles: [], status: 'revoked' },
  ]);
  for (const target of [a.susp, a.revk]) {
    await assert.rejects(
      h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => insertRole(tx, a.tenantId, target.membershipId, 'admin', a.owner.membershipId)),
      notActive,
    );
  }
  assert.equal(await h.statusOf(a.susp.membershipId), 'suspended');
  assert.deepEqual(await h.roleCodes(a.revk.membershipId), []);
});

test('RLS: with tenant A context the runtime neither sees nor deletes nor inserts tenant B role rows', async () => {
  const { a, b } = await h.twoTenants();
  const result = await h.asRuntime(h.apiPool, { tenantId: a.tenantId }, async (tx) => {
    const visible = await tx`SELECT count(*)::int AS n FROM public.membership_roles WHERE tenant_id = ${b.tenantId}`;
    const deleted = await deleteRole(tx, b.tenantId, b.technician.membershipId, 'technician');
    const deletedNoFilter = await tx`DELETE FROM public.membership_roles WHERE membership_id = ${b.owner.membershipId}`;
    return { visible: visible[0].n, deleted: deleted.count, deletedNoFilter: deletedNoFilter.count };
  });
  assert.deepEqual(result, { visible: 0, deleted: 0, deletedNoFilter: 0 });
  await assert.rejects(
    h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => insertRole(tx, b.tenantId, b.technician.membershipId, 'admin', b.owner.membershipId)),
    (error) => error?.code === '42501',
  );
  // assigned_by from another tenant is refused by the composite FK.
  await assert.rejects(
    h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => insertRole(tx, a.tenantId, a.advisor.membershipId, 'technician', b.owner.membershipId)),
    (error) => error?.code === '23503',
  );
  // No tenant context at all: nothing is visible or deletable.
  const [none] = await h.apiPool`SELECT count(*)::int AS n FROM public.membership_roles`;
  assert.equal(none.n, 0);
  assert.equal((await h.apiPool`DELETE FROM public.membership_roles`).count, 0);
  assert.deepEqual(await h.roleCodes(b.technician.membershipId), ['technician']);
  assert.deepEqual(await h.roleCodes(b.owner.membershipId), ['owner']);
});

test('runtime privileges: api DELETE only via tenant policy, no UPDATE/TRUNCATE; worker cannot change roles', async () => {
  const privileges = await h.admin`
    SELECT r.role,
      has_table_privilege(r.role, 'public.membership_roles', 'SELECT') AS "select",
      has_table_privilege(r.role, 'public.membership_roles', 'INSERT') AS "insert",
      has_table_privilege(r.role, 'public.membership_roles', 'UPDATE') AS "update",
      has_table_privilege(r.role, 'public.membership_roles', 'DELETE') AS "delete",
      has_table_privilege(r.role, 'public.membership_roles', 'TRUNCATE') AS "truncate",
      has_any_column_privilege(r.role, 'public.membership_roles', 'UPDATE') AS column_update
    FROM (VALUES ('tallermecario_api'), ('tallermecario_worker')) AS r(role) ORDER BY r.role
  `;
  assert.deepEqual(privileges.map((row) => ({ ...row })), [
    { role: 'tallermecario_api', select: true, insert: true, update: false, delete: true, truncate: false, column_update: false },
    { role: 'tallermecario_worker', select: true, insert: true, update: false, delete: false, truncate: false, column_update: false },
  ]);

  const policies = await h.admin`
    SELECT policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'membership_roles' ORDER BY policyname
  `;
  assert.deepEqual(policies.map((row) => ({ ...row, roles: [...row.roles].sort() })), [
    { policyname: 'tenant_delete', cmd: 'DELETE', roles: ['tallermecario_api'], qual: '(tenant_id = app.current_tenant_id())', with_check: null },
    { policyname: 'tenant_insert', cmd: 'INSERT', roles: ['tallermecario_api', 'tallermecario_worker'], qual: null, with_check: '(tenant_id = app.current_tenant_id())' },
    { policyname: 'tenant_select', cmd: 'SELECT', roles: ['tallermecario_api', 'tallermecario_worker'], qual: '(tenant_id = app.current_tenant_id())', with_check: null },
  ]);

  const { a } = await h.twoTenants();
  await assert.rejects(
    h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => tx`UPDATE public.membership_roles SET assigned_at = now() WHERE tenant_id = ${a.tenantId}`),
    insufficientPrivilege,
  );
  await assert.rejects(
    h.asRuntime(h.workerPool, { tenantId: a.tenantId }, (tx) => deleteRole(tx, a.tenantId, a.technician.membershipId, 'technician')),
    insufficientPrivilege,
  );
  await assert.rejects(h.apiPool`TRUNCATE public.membership_roles`, insufficientPrivilege);
  assert.deepEqual(await h.roleCodes(a.technician.membershipId), ['technician']);
});

test('PUBLIC privileges and trigger function hygiene: no PUBLIC access, invoker rights, fixed search_path', async () => {
  const [table] = await h.admin`
    SELECT
      has_table_privilege('public', 'public.membership_roles', 'SELECT') AS "select",
      has_table_privilege('public', 'public.membership_roles', 'INSERT') AS "insert",
      has_table_privilege('public', 'public.membership_roles', 'UPDATE') AS "update",
      has_table_privilege('public', 'public.membership_roles', 'DELETE') AS "delete"
  `;
  assert.deepEqual({ ...table }, { select: false, insert: false, update: false, delete: false });

  const [fn] = await h.admin`
    SELECT p.prosecdef, p.proconfig, owner.rolname AS owner,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
      pg_catalog.array_to_string(p.proacl, ',') AS acl
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles AS owner ON owner.oid = p.proowner
    WHERE n.nspname = 'app' AND p.proname = 'enforce_membership_role_invariants'
  `;
  assert.equal(fn.prosecdef, false, 'SECURITY INVOKER');
  assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, public']);
  assert.equal(fn.owner, 'tallermecario_schema_owner');
  assert.equal(fn.public_execute, false);

  const [trigger] = await h.admin`
    SELECT count(*)::int AS n FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'membership_roles' AND t.tgname = 'membership_roles_invariants_trg' AND t.tgenabled = 'O'
  `;
  assert.equal(trigger.n, 1);

  const [roles] = await h.admin`
    SELECT count(*)::int AS n FROM pg_catalog.pg_roles
    WHERE rolname IN ('tallermecario_api', 'tallermecario_worker') AND (rolbypassrls OR rolsuper)
  `;
  assert.equal(roles.n, 0, 'runtime roles stay NOBYPASSRLS / non-superuser');
});
