'use strict';

/**
 * S1-02 TenantContext DB foundation, against a real migrated PostgreSQL.
 *
 * Every request-path assertion runs as the `tallermecario_api` RUNTIME role
 * (NOBYPASSRLS, non-owner) through src/tenancy/tenant-context-db.ts. The
 * admin (superuser) connection is used only to seed fixtures, to mutate
 * membership state from "another session" (TOCTOU), and to read catalogs.
 *
 * Contract under test (see the module header): discovery → BEGIN →
 * revalidation → transaction-local bind → authorization rows → tenant queries
 * under RLS → COMMIT/ROLLBACK, all on ONE caller-owned client.
 *
 * Requires TEST_DATABASE_URL_ADMIN / TEST_RUNTIME_LOGIN / TEST_RUNTIME_PASSWORD
 * (tests/db/helpers.cjs) and TEST_TENANCY_MODULE_ROOT — provided by
 * scripts/test-tenant-context-db.cjs.
 */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { after, before, describe, test } = require('node:test');
const postgres = require('postgres');
const h = require('../db/helpers.cjs');

const root = process.env.TEST_TENANCY_MODULE_ROOT;
if (!root) throw new Error('TEST_TENANCY_MODULE_ROOT is required');
const db = require(join(root, 'tenancy/tenant-context-db.js'));

const { admin, fixture, id } = h;

const DENIED = Object.freeze({ ok: false, code: 'TENANT_ACCESS_DENIED' });
const EMPTY_CONTEXT = Object.freeze({ tenant_id: '', user_id: '', membership_id: '', request_id: '' });
const NO_TENANT_ROWS = Object.freeze({ workshops: 0, customers: 0, memberships: 0, membership_roles: 0 });

const insufficientPrivilege = (error) => {
  assert.equal(error.code, '42501', `expected insufficient_privilege, got ${error.code}: ${error.message}`);
  return true;
};
const contextError = (code) => (error) => {
  assert.equal(error.name, 'TenantContextDbError', `unexpected error: ${error.message}`);
  assert.equal(error.code, code);
  return true;
};

let api;
const T = {};
const U = {};
const M = {};
const C = {};

function identityOf(userKey) {
  return { identityProvider: 'clerk', externalSubject: `subject-${U[userKey]}` };
}

function candidate(userKey, membershipKey, tenantKey) {
  return { userId: U[userKey], membershipId: M[membershipKey], tenantId: T[tenantKey] };
}

/** Separate runtime pool with its own size, same NOINHERIT login as helpers.runtime(). */
function runtimeClient(options) {
  const url = new URL(process.env.TEST_DATABASE_URL_ADMIN);
  url.username = process.env.TEST_RUNTIME_LOGIN;
  url.password = process.env.TEST_RUNTIME_PASSWORD;
  return postgres(url.toString(), { ...options, onnotice: () => {}, connection: { role: 'tallermecario_api' } });
}

/** What the future HTTP integration does: reserve → BEGIN → fn → end → release. */
async function inRequestTransaction(client, fn, end = 'COMMIT') {
  const conn = await client.reserve();
  try {
    await conn.unsafe('BEGIN');
    const result = await fn(conn);
    await conn.unsafe(end);
    return result;
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

async function openContext(conn, userKey, membershipKey, tenantKey, requestId = `req-${id()}`) {
  const validation = await db.validateActiveMembership(conn, identityOf(userKey), candidate(userKey, membershipKey, tenantKey));
  assert.equal(validation.ok, true, `${membershipKey} must validate`);
  return db.bindTenantContext(conn, validation.membership, { requestId });
}

async function currentContext(conn) {
  const [row] = await conn`
    SELECT
      COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant_id,
      COALESCE(pg_catalog.current_setting('app.user_id', true), '') AS user_id,
      COALESCE(pg_catalog.current_setting('app.membership_id', true), '') AS membership_id,
      COALESCE(pg_catalog.current_setting('app.request_id', true), '') AS request_id
  `;
  return { ...row };
}

async function visibleTenantRows(conn) {
  const [row] = await conn`
    SELECT
      (SELECT count(*)::int FROM public.workshops) AS workshops,
      (SELECT count(*)::int FROM public.customers) AS customers,
      (SELECT count(*)::int FROM public.memberships) AS memberships,
      (SELECT count(*)::int FROM public.membership_roles) AS membership_roles
  `;
  return { ...row };
}

/** role_permissions as stored in PostgreSQL (read by the admin, not the TS matrix). */
async function storedGrantKeys(roleCodes) {
  const rows = await admin`
    SELECT r.code AS role_code, p.code AS permission_code, rp.resource_scope
    FROM public.role_permissions AS rp
    JOIN public.roles AS r ON r.id = rp.role_id
    JOIN public.permissions AS p ON p.id = rp.permission_id
    WHERE r.code = ANY(${roleCodes})
  `;
  return new Set(rows.map((row) => `${row.role_code}|${row.permission_code}|${row.resource_scope}`));
}

const grantKey = (grant) => `${grant.roleCode}|${grant.permissionCode}|${grant.resourceScope}`;
const byteCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assertGrantOrder(grants) {
  for (let index = 1; index < grants.length; index += 1) {
    const previous = grants[index - 1];
    const current = grants[index];
    const order = byteCompare(previous.permissionCode, current.permissionCode)
      || byteCompare(previous.roleCode, current.roleCode)
      || byteCompare(previous.resourceScope, current.resourceScope);
    assert.ok(order < 0, `grants not in deterministic order at ${index}`);
  }
}

function countByScope(grants) {
  const counts = { tenant: 0, assigned: 0, quality_control: 0 };
  for (const grant of grants) counts[grant.resourceScope] += 1;
  return counts;
}

before(async () => {
  await h.setupRoles();
  api = h.runtime('tallermecario_api');

  for (const key of ['T1', 'T2', 'T3', 'T4']) T[key] = id();
  for (const key of ['A', 'B', 'D', 'E', 'F', 'G', 'H']) U[key] = id();
  for (const key of ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'D1', 'E1', 'F1', 'G1', 'H1']) M[key] = id();
  C.T1 = id();
  C.T2 = id();

  const roleRows = await admin`SELECT id, code FROM public.roles`;
  const roleId = Object.fromEntries(roleRows.map((row) => [row.code, row.id]));
  const now = new Date();

  // user, tenant, status, roles
  const memberships = {
    A1: ['A', 'T1', 'active', ['owner']],
    A2: ['A', 'T2', 'active', ['technician']],
    A3: ['A', 'T3', 'suspended', ['owner']],
    A4: ['A', 'T4', 'revoked', ['owner']],
    B1: ['B', 'T1', 'active', ['technician']],
    B2: ['B', 'T2', 'active', ['service_advisor', 'technician']],
    D1: ['D', 'T1', 'active', ['owner']],
    E1: ['E', 'T1', 'active', ['owner']],
    F1: ['F', 'T1', 'active', []],
    G1: ['G', 'T1', 'active', ['owner']],
    H1: ['H', 'T2', 'active', ['owner']],
  };

  await fixture(async (tx) => {
    for (const key of Object.keys(T)) {
      await tx`INSERT INTO workshops ${tx({ id: T[key], slug: `w-${T[key]}`, legal_name: `Legal ${key}`, display_name: `Taller ${key}` })}`;
    }
    for (const key of Object.keys(U)) {
      await tx`INSERT INTO users ${tx({
        id: U[key],
        external_subject: `subject-${U[key]}`,
        email: `${U[key]}@tenant-context.test`,
        full_name: `User ${key}`,
        status: key === 'D' ? 'disabled' : 'active',
      })}`;
    }
    for (const [key, [userKey, tenantKey, status, roles]] of Object.entries(memberships)) {
      await tx`INSERT INTO memberships ${tx({
        id: M[key],
        tenant_id: T[tenantKey],
        user_id: U[userKey],
        status,
        suspended_at: status === 'suspended' ? now : null,
        revoked_at: status === 'revoked' ? now : null,
      })}`;
      for (const role of roles) {
        await tx`INSERT INTO membership_roles ${tx({
          tenant_id: T[tenantKey],
          membership_id: M[key],
          role_id: roleId[role],
          assigned_by_membership_id: M[key],
        })}`;
      }
    }
    await tx`INSERT INTO customers ${tx({ id: C.T1, tenant_id: T.T1, first_name: 'Cliente', last_name: 'Uno', phone: '3000000001' })}`;
    await tx`INSERT INTO customers ${tx({ id: C.T2, tenant_id: T.T2, first_name: 'Cliente', last_name: 'Dos', phone: '3000000002' })}`;
  });
});

after(async () => {
  await api.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

describe('runtime role, bootstrap ACL and catalog prerequisites', () => {
  test('request path runs as tallermecario_api: NOSUPERUSER, NOBYPASSRLS, owns nothing, no privileged SET ROLE', async () => {
    const [role] = await api`
      SELECT
        current_user AS current_role,
        r.rolsuper,
        r.rolbypassrls,
        (SELECT count(*)::int FROM pg_catalog.pg_class AS c WHERE c.relowner = r.oid) AS owned_relations,
        (SELECT count(*)::int FROM pg_catalog.pg_proc AS p WHERE p.proowner = r.oid) AS owned_functions
      FROM pg_catalog.pg_roles AS r
      WHERE r.rolname = current_user
    `;
    assert.deepEqual({ ...role }, {
      current_role: 'tallermecario_api',
      rolsuper: false,
      rolbypassrls: false,
      owned_relations: 0,
      owned_functions: 0,
    });

    for (const privileged of ['tallermecario_schema_owner', 'tallermecario_migrator', 'tallermecario_bootstrap_resolver']) {
      const [membership] = await api`SELECT pg_catalog.pg_has_role(current_user, ${privileged}, 'SET') AS allowed`;
      assert.equal(membership.allowed, false, `runtime must not SET ROLE ${privileged}`);
      await assert.rejects(api.unsafe(`SET ROLE ${privileged}`), insufficientPrivilege);
    }
  });

  test('discovery/revalidation bootstrap functions keep ADR-009 §8 hardening (pg_catalog)', async () => {
    const functions = await admin`
      SELECT
        p.proname,
        p.prosecdef,
        p.provolatile,
        l.lanname,
        owner.rolname AS owner,
        p.proconfig,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_catalog.pg_get_function_result(p.oid) AS result,
        pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
        pg_catalog.has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_execute,
        pg_catalog.has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker_execute,
        ARRAY(
          SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname::text END
          FROM pg_catalog.aclexplode(p.proacl) AS acl
          LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = acl.grantee
          WHERE acl.privilege_type = 'EXECUTE'
        ) AS execute_grantees
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = p.proowner
      WHERE n.nspname = 'app'
        AND p.proname IN ('bootstrap_list_active_memberships', 'bootstrap_validate_active_membership')
      ORDER BY p.proname
    `;
    assert.equal(functions.length, 2, 'exactly one overload of each function');

    const expectedArguments = {
      bootstrap_list_active_memberships: 'p_identity_provider text, p_external_subject text',
      bootstrap_validate_active_membership: 'p_identity_provider text, p_external_subject text, p_tenant_id uuid',
    };
    for (const fn of functions) {
      assert.equal(fn.prosecdef, true, `${fn.proname} SECURITY DEFINER`);
      assert.equal(fn.owner, 'tallermecario_bootstrap_resolver', `${fn.proname} owner`);
      assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, public'], `${fn.proname} fixed search_path`);
      assert.equal(fn.lanname, 'sql', `${fn.proname} static SQL, no dynamic EXECUTE`);
      assert.equal(fn.provolatile, 's', `${fn.proname} STABLE (read-only)`);
      assert.equal(fn.arguments, expectedArguments[fn.proname]);
      assert.equal(fn.result, 'TABLE(user_id uuid, membership_id uuid, tenant_id uuid)', `${fn.proname} minimal output`);
      assert.equal(fn.public_execute, false, `${fn.proname} PUBLIC EXECUTE`);
      assert.equal(fn.api_execute, true, `${fn.proname} api EXECUTE`);
      assert.equal(fn.worker_execute, false, `${fn.proname} worker EXECUTE`);
      assert.deepEqual([...fn.execute_grantees].sort(), ['tallermecario_api', 'tallermecario_bootstrap_resolver']);
    }
  });

  test('bootstrap resolver is NOLOGIN and cannot create objects or assume owner/migrator', async () => {
    const [resolver] = await admin`
      SELECT
        r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
        pg_catalog.has_schema_privilege(r.rolname, 'public', 'CREATE') AS create_public,
        pg_catalog.has_schema_privilege(r.rolname, 'app', 'CREATE') AS create_app,
        pg_catalog.has_database_privilege(r.rolname, pg_catalog.current_database(), 'CREATE') AS create_database,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_schema_owner', 'MEMBER') AS member_owner,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_migrator', 'MEMBER') AS member_migrator,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_api', 'MEMBER') AS member_api,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_worker', 'MEMBER') AS member_worker,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_schema_owner', 'SET') AS set_owner,
        pg_catalog.pg_has_role(r.rolname, 'tallermecario_migrator', 'SET') AS set_migrator
      FROM pg_catalog.pg_roles AS r
      WHERE r.rolname = 'tallermecario_bootstrap_resolver'
    `;
    assert.deepEqual({ ...resolver }, {
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      // Pre-existing, ADR-009 §2: "BYPASSRLS excepcional y mínimo".
      rolbypassrls: true,
      create_public: false,
      create_app: false,
      create_database: false,
      member_owner: false,
      member_migrator: false,
      member_api: false,
      member_worker: false,
      set_owner: false,
      set_migrator: false,
    });

    // Functional DDL check with the resolver's own object privileges (superuser
    // SET ROLE for inspection only; nothing is created). A SET ROLE probe is
    // deliberately absent: PostgreSQL authorizes SET ROLE against session_user
    // (the superuser here), so it would prove nothing. The resolver is NOLOGIN
    // and never a session_user; the SET/MEMBER catalog checks above are the
    // authoritative proof that it cannot assume owner/migrator.
    await admin.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE tallermecario_bootstrap_resolver');
      for (const statement of [
        'CREATE TABLE public.resolver_ddl_probe (id integer)',
        'CREATE TABLE app.resolver_ddl_probe (id integer)',
        "CREATE FUNCTION app.resolver_fn_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
        'CREATE SCHEMA resolver_schema_probe',
      ]) {
        await assert.rejects(tx.savepoint((sp) => sp.unsafe(statement)), insufficientPrivilege, statement);
      }
      const [who] = await tx`SELECT current_user AS role`;
      assert.equal(who.role, 'tallermecario_bootstrap_resolver');
    });
  });

  test('RBAC catalogs stay read-only for runtime: SELECT works, INSERT/UPDATE/DELETE denied', async () => {
    const tables = ['roles', 'permissions', 'role_permissions'];
    for (const role of ['tallermecario_api', 'tallermecario_worker']) {
      for (const table of tables) {
        const [privileges] = await admin`
          SELECT
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'SELECT') AS select,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'INSERT') AS insert,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'UPDATE') AS update,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'DELETE') AS delete,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'TRUNCATE') AS truncate,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'REFERENCES') AS references,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'TRIGGER') AS trigger
        `;
        assert.deepEqual({ ...privileges }, {
          select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false,
        }, `${role} ${table}`);
      }
    }

    const [counts] = await api`
      SELECT
        (SELECT count(*)::int FROM public.roles) AS roles,
        (SELECT count(*)::int FROM public.permissions) AS permissions,
        (SELECT count(*)::int FROM public.role_permissions) AS role_permissions
    `;
    assert.deepEqual({ ...counts }, { roles: 4, permissions: 103, role_permissions: 290 });

    await assert.rejects(api`INSERT INTO public.roles (id, code, name, scope, is_system) VALUES (${id()}, 'owner', 'x', 'tenant', true)`, insufficientPrivilege);
    await assert.rejects(api`INSERT INTO public.permissions (id, code, description) VALUES (${id()}, 'rogue.permission', 'x')`, insufficientPrivilege);
    await assert.rejects(api`
      INSERT INTO public.role_permissions (role_id, permission_id, resource_scope)
      SELECT r.id, p.id, 'tenant' FROM public.roles AS r CROSS JOIN public.permissions AS p LIMIT 1
    `, insufficientPrivilege);
    for (const table of tables) {
      await assert.rejects(api.unsafe(`UPDATE public.${table} SET created_at = created_at WHERE false`), insufficientPrivilege);
      await assert.rejects(api.unsafe(`DELETE FROM public.${table} WHERE false`), insufficientPrivilege);
    }
  });

  test('RLS catalog: tables read by this layer keep ENABLE+FORCE, owner and tenant-only policies', async () => {
    const tables = ['workshops', 'memberships', 'membership_roles', 'customers'];
    const relations = await admin`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, owner.rolname AS owner
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relname = ANY(${tables})
    `;
    assert.equal(relations.length, tables.length);
    for (const relation of relations) {
      assert.equal(relation.relrowsecurity, true, `${relation.relname} ENABLE RLS`);
      assert.equal(relation.relforcerowsecurity, true, `${relation.relname} FORCE RLS`);
      assert.equal(relation.owner, 'tallermecario_schema_owner', `${relation.relname} owner`);
    }

    const policies = await admin`
      SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${tables})
    `;
    for (const table of tables) {
      const predicate = table === 'workshops'
        ? '(id = app.current_tenant_id())'
        : '(tenant_id = app.current_tenant_id())';
      const own = policies.filter((policy) => policy.tablename === table);
      // S1-05 (0011): membership_roles changes only by INSERT/DELETE; DELETE is api-only.
      const expectedNames = table === 'membership_roles'
        ? ['tenant_delete', 'tenant_insert', 'tenant_select']
        : ['tenant_insert', 'tenant_select', 'tenant_update'];
      assert.deepEqual(own.map((policy) => policy.policyname).sort(), expectedNames, table);
      for (const policy of own) {
        assert.equal(policy.permissive, 'PERMISSIVE');
        assert.deepEqual([...policy.roles].sort(), policy.cmd === 'DELETE'
          ? ['tallermecario_api']
          : ['tallermecario_api', 'tallermecario_worker']);
        assert.equal(policy.qual, policy.cmd === 'INSERT' ? null : predicate, `${table}.${policy.policyname} USING`);
        assert.equal(policy.with_check, policy.cmd === 'SELECT' || policy.cmd === 'DELETE' ? null : predicate, `${table}.${policy.policyname} WITH CHECK`);
      }
    }

    const [permissive] = await admin`
      SELECT count(*)::int AS count
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public' AND (qual = 'true' OR with_check = 'true')
    `;
    assert.equal(permissive.count, 0, 'no USING (true) / WITH CHECK (true) policy');
  });

  test('module is PostgreSQL-only: no network/provider imports, no connection or transaction ownership', () => {
    // core.autocrlf checkouts are CRLF; canonicalize so `$` anchors match.
    const source = readFileSync(resolve('src/tenancy/tenant-context-db.ts'), 'utf8').replace(/\r\n?/g, '\n');
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';$/gm)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ['../authz/rbac-matrix.js', '../identity/identity-provider.js', 'postgres']);
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\brequire\s*\(/,
      /node:(http|https|net|dns|tls)/,
      /\.reserve\s*\(/,
      /\.begin\s*\(/,
      /\.release\s*\(/,
      /\.unsafe\s*\(/,
      /'(BEGIN|COMMIT|ROLLBACK)'/,
      /set_config\([^)]*,\s*false\)/,
    ]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});

describe('membership discovery (pre-tenant bootstrap)', () => {
  test('returns exactly the active memberships of the verified identity, minimal and deterministic', async () => {
    const discovered = await db.discoverActiveMemberships(api, identityOf('A'));
    assert.deepEqual(discovered.map((row) => ({ ...row })), [
      candidate('A', 'A1', 'T1'),
      candidate('A', 'A2', 'T2'),
    ].sort((a, b) => byteCompare(a.tenantId, b.tenantId)));
    for (const row of discovered) {
      assert.deepEqual(Object.keys(row).sort(), ['membershipId', 'tenantId', 'userId']);
    }
    const ids = discovered.map((row) => row.membershipId);
    for (const excluded of ['A3', 'A4', 'B1', 'B2', 'D1']) {
      assert.ok(!ids.includes(M[excluded]), `${excluded} must not be discovered for user A`);
    }

    const forB = await db.discoverActiveMemberships(api, identityOf('B'));
    assert.deepEqual(new Set(forB.map((row) => row.membershipId)), new Set([M.B1, M.B2]));
    assert.ok(forB.every((row) => row.userId === U.B));
  });

  test('unknown subject, other provider and disabled user discover nothing; malformed identity throws', async () => {
    assert.deepEqual(await db.discoverActiveMemberships(api, { identityProvider: 'clerk', externalSubject: 'subject-unknown' }), []);
    assert.deepEqual(await db.discoverActiveMemberships(api, { identityProvider: 'other', externalSubject: `subject-${U.A}` }), []);
    assert.deepEqual(await db.discoverActiveMemberships(api, identityOf('D')), []);
    for (const identity of [
      null,
      { identityProvider: '', externalSubject: 'x' },
      { identityProvider: 'clerk', externalSubject: '' },
      { identityProvider: 'x'.repeat(33), externalSubject: 'x' },
      { identityProvider: 'clerk', externalSubject: 'x'.repeat(256) },
    ]) {
      await assert.rejects(db.discoverActiveMemberships(api, identity), contextError('TENANT_CONTEXT_ARGUMENT_INVALID'));
    }
  });

  test('pre-tenant runtime has no direct path: users is not readable, memberships invisible without context', async () => {
    await assert.rejects(api`SELECT id FROM public.users`, insufficientPrivilege);
    assert.deepEqual(await visibleTenantRows(api), NO_TENANT_ROWS);
  });
});

describe('membership revalidation inside the request transaction', () => {
  test('the exact active (user, membership, tenant) triple validates', async () => {
    await inRequestTransaction(api, async (conn) => {
      const result = await db.validateActiveMembership(conn, identityOf('A'), candidate('A', 'A1', 'T1'));
      assert.equal(result.ok, true);
      assert.deepEqual({ ...result.membership }, candidate('A', 'A1', 'T1'));
      assert.deepEqual(Object.keys(result.membership).sort(), ['membershipId', 'tenantId', 'userId']);
      // Validation alone binds nothing.
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
    });
  });

  test('wrong tenant, wrong user, suspended, revoked, unknown, disabled user and malformed ids are indistinguishable denials', async () => {
    const cases = [
      ['own membership presented for another tenant', identityOf('A'), { ...candidate('A', 'A1', 'T1'), tenantId: T.T2 }],
      ['tenant without any membership', identityOf('A'), { ...candidate('A', 'A1', 'T1'), tenantId: id() }],
      ["another user's membership in the same tenant", identityOf('A'), { ...candidate('A', 'B1', 'T1') }],
      ["candidate userId of another user", identityOf('A'), { ...candidate('A', 'A1', 'T1'), userId: U.B }],
      ["another identity presenting A's candidate", identityOf('B'), candidate('A', 'A1', 'T1')],
      ['suspended membership', identityOf('A'), candidate('A', 'A3', 'T3')],
      ['revoked membership', identityOf('A'), candidate('A', 'A4', 'T4')],
      ['unknown membership id', identityOf('A'), { ...candidate('A', 'A1', 'T1'), membershipId: id() }],
      ['disabled user with an active membership', identityOf('D'), candidate('D', 'D1', 'T1')],
      ['unknown identity', { identityProvider: 'clerk', externalSubject: 'subject-unknown' }, candidate('A', 'A1', 'T1')],
      ['malformed tenant id', identityOf('A'), { ...candidate('A', 'A1', 'T1'), tenantId: 'not-a-uuid' }],
      ['malformed membership id', identityOf('A'), { ...candidate('A', 'A1', 'T1'), membershipId: "' OR true --" }],
      ['missing candidate', identityOf('A'), null],
    ];

    await inRequestTransaction(api, async (conn) => {
      const serialized = new Set();
      for (const [label, identity, input] of cases) {
        const result = await db.validateActiveMembership(conn, identity, input);
        assert.deepEqual(result, DENIED, label);
        assert.deepEqual(Object.keys(result).sort(), ['code', 'ok'], label);
        serialized.add(JSON.stringify(result));
      }
      assert.equal(serialized.size, 1, 'every denial must serialize identically');
      // No denial raised a database error (the transaction is still usable) or bound anything.
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
      assert.deepEqual(await visibleTenantRows(conn), NO_TENANT_ROWS);
    });
  });

  test('TOCTOU: a membership suspended after discovery fails closed at revalidation', async () => {
    const discovered = await db.discoverActiveMemberships(api, identityOf('E'));
    assert.deepEqual(discovered.map((row) => row.membershipId), [M.E1]);

    await admin`
      UPDATE public.memberships
      SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE id = ${M.E1}
    `;

    await inRequestTransaction(api, async (conn) => {
      assert.deepEqual(await db.validateActiveMembership(conn, identityOf('E'), discovered[0]), DENIED);
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
      assert.deepEqual(await visibleTenantRows(conn), NO_TENANT_ROWS);
    });
    assert.deepEqual(await db.discoverActiveMemberships(api, identityOf('E')), []);
  });

  test('TOCTOU: a membership revoked after discovery fails closed at revalidation', async () => {
    const [discovered] = await db.discoverActiveMemberships(api, identityOf('G'));
    assert.equal(discovered.membershipId, M.G1);

    await admin`
      UPDATE public.memberships
      SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE id = ${M.G1}
    `;

    await inRequestTransaction(api, async (conn) => {
      assert.deepEqual(await db.validateActiveMembership(conn, identityOf('G'), discovered), DENIED);
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
    });
  });

  test('TOCTOU: a membership suspended after bind yields no authorization rows (fresh snapshot re-check)', async () => {
    // H1 is T2's only owner. A valid fixture (triggers ON) first gives T2 a
    // second active owner, so suspending H1 respects the S1-05 owner
    // invariant instead of bypassing it.
    const coOwnerUser = id();
    const coOwner = id();
    await admin.begin(async (tx) => {
      const [owner] = await tx`SELECT id FROM public.roles WHERE code = 'owner'`;
      await tx`INSERT INTO users ${tx({
        id: coOwnerUser, external_subject: `subject-${coOwnerUser}`, email: `${coOwnerUser}@tenant-context.test`,
        full_name: 'Co-owner T2', status: 'active',
      })}`;
      await tx`INSERT INTO memberships ${tx({ id: coOwner, tenant_id: T.T2, user_id: coOwnerUser, status: 'active' })}`;
      await tx`INSERT INTO membership_roles ${tx({
        tenant_id: T.T2, membership_id: coOwner, role_id: owner.id, assigned_by_membership_id: coOwner,
      })}`;
    });

    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'H', 'H1', 'T2');
      const before = await db.loadMembershipAuthorization(conn, context);
      assert.equal(before.ok, true);
      assert.equal(before.grants.length, 103);

      await admin`
        UPDATE public.memberships
        SET status = 'suspended', suspended_at = now(), updated_at = now()
        WHERE id = ${M.H1}
      `;
      assert.deepEqual(await db.loadMembershipAuthorization(conn, context), DENIED);
    }, 'ROLLBACK');
  });
});

describe('transaction-local tenant context and RLS', () => {
  test('after revalidation + bind: tenant A rows visible, tenant B rows invisible, writes cannot target B', async () => {
    await inRequestTransaction(api, async (conn) => {
      await openContext(conn, 'A', 'A1', 'T1');

      assert.deepEqual((await conn`SELECT id FROM public.workshops`).map((row) => row.id), [T.T1]);
      assert.deepEqual((await conn`SELECT id FROM public.customers`).map((row) => row.id), [C.T1]);
      assert.equal((await conn`SELECT id FROM public.customers WHERE id = ${C.T2}`).length, 0);

      const memberships = await conn`SELECT id, tenant_id FROM public.memberships`;
      assert.ok(memberships.length > 0 && memberships.every((row) => row.tenant_id === T.T1));
      const visibleIds = new Set(memberships.map((row) => row.id));
      assert.ok(visibleIds.has(M.A1) && visibleIds.has(M.B1));
      for (const hidden of ['A2', 'A3', 'A4', 'B2', 'H1']) assert.ok(!visibleIds.has(M[hidden]), hidden);
      assert.ok((await conn`SELECT tenant_id FROM public.membership_roles`).every((row) => row.tenant_id === T.T1));

      assert.equal((await conn`UPDATE public.customers SET first_name = first_name WHERE id = ${C.T2}`).count, 0);
      await assert.rejects(
        conn`INSERT INTO public.customers ${conn({ id: id(), tenant_id: T.T2, first_name: 'X', last_name: 'Y', phone: '3000000009' })}`,
        insufficientPrivilege,
      );
    }, 'ROLLBACK');
  });

  test('without a bind no tenant row is visible, in a transaction or autocommit', async () => {
    await inRequestTransaction(api, async (conn) => {
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
      assert.deepEqual(await visibleTenantRows(conn), NO_TENANT_ROWS);
    });
    assert.deepEqual(await visibleTenantRows(api), NO_TENANT_ROWS);
  });

  test('a context bound to tenant B cannot reach tenant A rows', async () => {
    await inRequestTransaction(api, async (conn) => {
      await openContext(conn, 'A', 'A2', 'T2');
      assert.deepEqual((await conn`SELECT id FROM public.workshops`).map((row) => row.id), [T.T2]);
      assert.deepEqual((await conn`SELECT id FROM public.customers`).map((row) => row.id), [C.T2]);
      assert.equal((await conn`SELECT id FROM public.customers WHERE id = ${C.T1}`).length, 0);
      assert.equal((await conn`SELECT id FROM public.memberships WHERE id = ${M.A1}`).length, 0);
    });
  });

  for (const end of ['COMMIT', 'ROLLBACK']) {
    test(`app.tenant_id/user_id/membership_id/request_id are transaction-local and clear after ${end}`, async () => {
      const conn = await api.reserve();
      try {
        await conn.unsafe('BEGIN');
        const context = await openContext(conn, 'A', 'A1', 'T1', `req-lifetime-${end}`);
        assert.deepEqual(await currentContext(conn), {
          tenant_id: T.T1,
          user_id: U.A,
          membership_id: M.A1,
          request_id: `req-lifetime-${end}`,
        });
        assert.equal((await visibleTenantRows(conn)).customers, 1);
        await conn.unsafe(end);

        // Same connection, autocommit statement.
        assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
        assert.deepEqual(await visibleTenantRows(conn), NO_TENANT_ROWS);

        // Same connection, next transaction without bind.
        await conn.unsafe('BEGIN');
        assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
        assert.deepEqual(await visibleTenantRows(conn), NO_TENANT_ROWS);
        await assert.rejects(db.loadMembershipAuthorization(conn, context), contextError('TENANT_CONTEXT_TRANSACTION_MISMATCH'));
        await conn.unsafe('ROLLBACK');
      } finally {
        await conn.unsafe('ROLLBACK').catch(() => undefined);
        conn.release();
      }
    });
  }

  test('a pooled connection reused by the next request does not inherit the previous context', async () => {
    const pool = runtimeClient({ max: 1 });
    try {
      let firstPid;
      const first = await pool.reserve();
      try {
        await first.unsafe('BEGIN');
        await openContext(first, 'A', 'A1', 'T1');
        [{ pid: firstPid }] = await first`SELECT pg_catalog.pg_backend_pid() AS pid`;
        assert.equal((await visibleTenantRows(first)).customers, 1);
        await first.unsafe('COMMIT');
      } finally {
        first.release();
      }

      const second = await pool.reserve();
      try {
        const [{ pid }] = await second`SELECT pg_catalog.pg_backend_pid() AS pid`;
        assert.equal(pid, firstPid, 'a single-connection pool must hand back the same backend');
        await second.unsafe('BEGIN');
        assert.deepEqual(await currentContext(second), EMPTY_CONTEXT);
        assert.deepEqual(await visibleTenantRows(second), NO_TENANT_ROWS);
        await second.unsafe('COMMIT');
      } finally {
        second.release();
      }

      // A request that fails mid-transaction and rolls back.
      const third = await pool.reserve();
      try {
        await third.unsafe('BEGIN');
        await openContext(third, 'B', 'B2', 'T2');
        await assert.rejects(third`SELECT 1 / 0`, (error) => error.code === '22012');
        await third.unsafe('ROLLBACK');
      } finally {
        third.release();
      }

      const [afterRequests] = await pool`
        SELECT
          pg_catalog.pg_backend_pid() AS pid,
          COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant_id,
          COALESCE(pg_catalog.current_setting('app.membership_id', true), '') AS membership_id,
          (SELECT count(*)::int FROM public.customers) AS customers
      `;
      assert.deepEqual({ ...afterRequests }, { pid: firstPid, tenant_id: '', membership_id: '', customers: 0 });
    } finally {
      await pool.end({ timeout: 5 });
    }
  });

  test('bind refuses to run outside the transaction and client that performed revalidation', async () => {
    const conn = await api.reserve();
    try {
      // Autocommit: validation and bind are two different implicit transactions.
      const autocommit = await db.validateActiveMembership(conn, identityOf('A'), candidate('A', 'A1', 'T1'));
      assert.equal(autocommit.ok, true);
      await assert.rejects(
        db.bindTenantContext(conn, autocommit.membership, { requestId: 'req-autocommit' }),
        contextError('TENANT_CONTEXT_TRANSACTION_MISMATCH'),
      );
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);

      // Validated before BEGIN, bound after BEGIN.
      const early = await db.validateActiveMembership(conn, identityOf('A'), candidate('A', 'A1', 'T1'));
      await conn.unsafe('BEGIN');
      await assert.rejects(
        db.bindTenantContext(conn, early.membership, { requestId: 'req-early' }),
        contextError('TENANT_CONTEXT_TRANSACTION_MISMATCH'),
      );
      assert.deepEqual(await currentContext(conn), EMPTY_CONTEXT);
      await conn.unsafe('ROLLBACK');
    } finally {
      await conn.unsafe('ROLLBACK').catch(() => undefined);
      conn.release();
    }

    // Validated on one reserved connection, bound on another.
    const one = await api.reserve();
    const two = await api.reserve();
    try {
      await one.unsafe('BEGIN');
      await two.unsafe('BEGIN');
      const validation = await db.validateActiveMembership(one, identityOf('A'), candidate('A', 'A1', 'T1'));
      await assert.rejects(
        db.bindTenantContext(two, validation.membership, { requestId: 'req-other-connection' }),
        contextError('TENANT_CONTEXT_CLIENT_MISMATCH'),
      );
      assert.deepEqual(await currentContext(two), EMPTY_CONTEXT);
    } finally {
      for (const reserved of [one, two]) {
        await reserved.unsafe('ROLLBACK').catch(() => undefined);
        reserved.release();
      }
    }

    // Validated through the pool itself (no reserved transaction).
    const pooled = await db.validateActiveMembership(api, identityOf('A'), candidate('A', 'A1', 'T1'));
    await assert.rejects(
      db.bindTenantContext(api, pooled.membership, { requestId: 'req-pool' }),
      contextError('TENANT_CONTEXT_TRANSACTION_MISMATCH'),
    );

    // Discovery output, copies and hand-made objects are not validation proof.
    const [discovered] = await db.discoverActiveMemberships(api, identityOf('A'));
    await assert.rejects(db.bindTenantContext(api, discovered, { requestId: 'req-discovered' }), contextError('TENANT_CONTEXT_NOT_VALIDATED'));
    await assert.rejects(db.bindTenantContext(api, { ...pooled.membership }, { requestId: 'req-copy' }), contextError('TENANT_CONTEXT_NOT_VALIDATED'));
    await assert.rejects(db.bindTenantContext(api, candidate('A', 'A3', 'T3'), { requestId: 'req-forged' }), contextError('TENANT_CONTEXT_NOT_VALIDATED'));

    await inRequestTransaction(api, async (tx) => {
      const validation = await db.validateActiveMembership(tx, identityOf('A'), candidate('A', 'A1', 'T1'));
      for (const requestId of ['', 'x'.repeat(129), undefined]) {
        await assert.rejects(
          db.bindTenantContext(tx, validation.membership, { requestId }),
          contextError('TENANT_CONTEXT_ARGUMENT_INVALID'),
        );
      }
      assert.deepEqual(await currentContext(tx), EMPTY_CONTEXT);
    }, 'ROLLBACK');
  });

  test('bind refuses to replace an already-bound context in the same transaction', async () => {
    await inRequestTransaction(api, async (conn) => {
      const first = await openContext(conn, 'A', 'A1', 'T1', 'req-rebind');

      const other = await db.validateActiveMembership(conn, identityOf('A'), candidate('A', 'A2', 'T2'));
      assert.equal(other.ok, true);
      await assert.rejects(
        db.bindTenantContext(conn, other.membership, { requestId: 'req-rebind' }),
        contextError('TENANT_CONTEXT_ALREADY_BOUND'),
      );
      // The guard runs before set_config: nothing was partially overwritten.
      assert.deepEqual(await currentContext(conn), {
        tenant_id: T.T1, user_id: U.A, membership_id: M.A1, request_id: 'req-rebind',
      });
      assert.deepEqual((await conn`SELECT id FROM public.customers`).map((row) => row.id), [C.T1]);

      const same = await db.validateActiveMembership(conn, identityOf('A'), candidate('A', 'A1', 'T1'));
      await assert.rejects(
        db.bindTenantContext(conn, same.membership, { requestId: 'req-rebind-other' }),
        contextError('TENANT_CONTEXT_ALREADY_BOUND'),
      );
      const rebound = await db.bindTenantContext(conn, same.membership, { requestId: 'req-rebind' });
      assert.deepEqual({ ...rebound }, { ...first });
    }, 'ROLLBACK');
  });
});

describe('authorization rows loaded from PostgreSQL', () => {
  test('owner: 103 raw rows, all tenant scope, equal to stored role_permissions', async () => {
    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'A', 'A1', 'T1');
      const auth = await db.loadMembershipAuthorization(conn, context);
      assert.equal(auth.ok, true);
      assert.equal(auth.membershipId, M.A1);
      assert.deepEqual([...auth.roles], ['owner']);
      assert.equal(auth.grants.length, 103);
      assert.deepEqual(countByScope(auth.grants), { tenant: 103, assigned: 0, quality_control: 0 });
      assert.ok(auth.grants.every((grant) => grant.roleCode === 'owner'));
      assert.equal(new Set(auth.grants.map((grant) => grant.permissionCode)).size, 103);
      for (const code of ['ownership.transfer', 'roles.assign_owner', 'workshop.read', 'subscription.manage']) {
        assert.ok(auth.grants.some((grant) => grant.permissionCode === code), code);
      }
      assert.deepEqual(Object.keys(auth.grants[0]).sort(), ['permissionCode', 'resourceScope', 'roleCode']);
      assert.deepEqual(new Set(auth.grants.map(grantKey)), await storedGrantKeys(['owner']));
      assertGrantOrder(auth.grants);
    });
  });

  test('technician: 6 tenant + 18 assigned + 1 quality_control; restricted grants never become tenant', async () => {
    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'A', 'A2', 'T2');
      const auth = await db.loadMembershipAuthorization(conn, context);
      assert.equal(auth.ok, true);
      assert.deepEqual([...auth.roles], ['technician']);
      assert.equal(auth.grants.length, 25);
      assert.deepEqual(countByScope(auth.grants), { tenant: 6, assigned: 18, quality_control: 1 });

      const scopeOf = new Map(auth.grants.map((grant) => [grant.permissionCode, grant.resourceScope]));
      assert.equal(scopeOf.size, 25, 'one row per permission for a single role');
      assert.equal(scopeOf.get('workshop.read'), 'tenant');
      assert.equal(scopeOf.get('locations.read'), 'tenant');
      assert.equal(scopeOf.get('inventory.read'), 'tenant');
      assert.equal(scopeOf.get('vehicles.read'), 'assigned');
      assert.equal(scopeOf.get('orders.read'), 'assigned');
      assert.equal(scopeOf.get('media.upload'), 'assigned');
      assert.equal(scopeOf.get('quality_checks.perform'), 'quality_control');
      for (const absent of ['customers.read', 'orders.assign', 'quotes.send', 'customer_payments.read']) {
        assert.ok(!scopeOf.has(absent), `${absent} must not be granted to technician`);
      }

      const tenantCodes = new Set(auth.grants.filter((grant) => grant.resourceScope === 'tenant').map((grant) => grant.permissionCode));
      for (const grant of auth.grants.filter((row) => row.resourceScope !== 'tenant')) {
        assert.ok(!tenantCodes.has(grant.permissionCode), `${grant.permissionCode} restricted grant leaked as tenant`);
      }
      assert.deepEqual(new Set(auth.grants.map(grantKey)), await storedGrantKeys(['technician']));
      assertGrantOrder(auth.grants);
    });
  });

  test('multi-role membership: rows for every assigned role, duplicates preserved per role, deterministic order', async () => {
    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'B', 'B2', 'T2');
      const auth = await db.loadMembershipAuthorization(conn, context);
      assert.equal(auth.ok, true);
      assert.deepEqual([...auth.roles], ['service_advisor', 'technician']);
      assert.equal(auth.grants.length, 65 + 25);

      const advisor = auth.grants.filter((grant) => grant.roleCode === 'service_advisor');
      const technician = auth.grants.filter((grant) => grant.roleCode === 'technician');
      assert.deepEqual(countByScope(advisor), { tenant: 65, assigned: 0, quality_control: 0 });
      assert.deepEqual(countByScope(technician), { tenant: 6, assigned: 18, quality_control: 1 });

      const rowsFor = (code) => auth.grants
        .filter((grant) => grant.permissionCode === code)
        .map((grant) => ({ ...grant }));
      assert.deepEqual(rowsFor('vehicles.read'), [
        { roleCode: 'service_advisor', permissionCode: 'vehicles.read', resourceScope: 'tenant' },
        { roleCode: 'technician', permissionCode: 'vehicles.read', resourceScope: 'assigned' },
      ]);
      assert.deepEqual(rowsFor('quality_checks.perform'), [
        { roleCode: 'service_advisor', permissionCode: 'quality_checks.perform', resourceScope: 'tenant' },
        { roleCode: 'technician', permissionCode: 'quality_checks.perform', resourceScope: 'quality_control' },
      ]);

      assert.deepEqual(new Set(auth.grants.map(grantKey)), await storedGrantKeys(['service_advisor', 'technician']));
      assertGrantOrder(auth.grants);
      const again = await db.loadMembershipAuthorization(conn, context);
      assert.deepEqual(again, auth);
    });
  });

  test('active membership without roles loads no grants (deny-by-default downstream)', async () => {
    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'F', 'F1', 'T1');
      const auth = await db.loadMembershipAuthorization(conn, context);
      assert.deepEqual({ ...auth, roles: [...auth.roles], grants: [...auth.grants] }, {
        ok: true, membershipId: M.F1, roles: [], grants: [],
      });
    });
  });

  test('loader fails closed on tampered GUCs, forged or foreign contexts', async () => {
    for (const [label, name, value] of [
      ['membership GUC pointed at another membership', 'app.membership_id', () => M.B1],
      ['membership GUC pointed at a suspended owner membership', 'app.membership_id', () => M.A3],
      ['user GUC pointed at another user', 'app.user_id', () => U.B],
      ['tenant GUC pointed at another tenant', 'app.tenant_id', () => T.T2],
    ]) {
      await inRequestTransaction(api, async (conn) => {
        const context = await openContext(conn, 'A', 'A1', 'T1');
        await conn`SELECT pg_catalog.set_config(${name}, ${value()}, true)`;
        assert.deepEqual(await db.loadMembershipAuthorization(conn, context), DENIED, label);
      }, 'ROLLBACK');
    }

    await inRequestTransaction(api, async (conn) => {
      const context = await openContext(conn, 'A', 'A1', 'T1');
      await assert.rejects(db.loadMembershipAuthorization(conn, { ...context }), contextError('TENANT_CONTEXT_NOT_BOUND'));
      await assert.rejects(
        db.loadMembershipAuthorization(conn, { ...candidate('A', 'A3', 'T3'), requestId: 'req-forged' }),
        contextError('TENANT_CONTEXT_NOT_BOUND'),
      );
      await assert.rejects(db.loadMembershipAuthorization(api, context), contextError('TENANT_CONTEXT_CLIENT_MISMATCH'));
    }, 'ROLLBACK');
  });
});
