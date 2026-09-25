'use strict';

/**
 * DB <-> RBAC_MATRIX_V1 parity, against a real migrated PostgreSQL database.
 *
 * Connects as the `tallermecario_api` RUNTIME role (NOBYPASSRLS, non-owner —
 * see AGENTS.md §10 and ADR-009), the same role the application uses to read
 * `roles` / `permissions` / `role_permissions` (granted SELECT-only in
 * drizzle/0000_initial_schema.sql). Never connects as owner/migrator/superuser.
 *
 * Requires TEST_DATABASE_URL_ADMIN / TEST_RUNTIME_LOGIN / TEST_RUNTIME_PASSWORD
 * (see tests/db/helpers.cjs) — provided by scripts/test-authz-db.cjs, which
 * provisions a throwaway local database and runs the full migration chain.
 */

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { runtime } = require('../db/helpers.cjs');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const rbac = require(join(root, 'authz/rbac-matrix.js'));

const sql = runtime('tallermecario_api');
after(async () => {
  await sql.end({ timeout: 5 });
});

test('database role_permissions matches RBAC_MATRIX_V1 exactly: no missing, extra, or wrong-scope cells', async () => {
  const dbRows = await sql`
    SELECT r.code AS role_code, p.code AS permission_code, rp.resource_scope
    FROM public.role_permissions rp
    JOIN public.roles r ON r.id = rp.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
  `;

  const dbCellByKey = new Map(
    dbRows.map((row) => [`${row.permission_code}::${row.role_code}`, row.resource_scope]),
  );

  const expectedRows = rbac.listRolePermissionRows();
  const expectedCellByKey = new Map(
    expectedRows.map((row) => [`${row.permissionCode}::${row.roleCode}`, row.resourceScope]),
  );

  const missing = [];
  const wrongScope = [];
  for (const [key, expectedScope] of expectedCellByKey) {
    const actualScope = dbCellByKey.get(key);
    if (actualScope === undefined) {
      missing.push(key);
    } else if (actualScope !== expectedScope) {
      wrongScope.push(`${key} expected=${expectedScope} actual=${actualScope}`);
    }
  }

  const extra = [...dbCellByKey.keys()].filter((key) => !expectedCellByKey.has(key));

  assert.deepEqual(missing, [], 'role_permissions rows present in RBAC_MATRIX_V1 but missing from the database');
  assert.deepEqual(extra, [], 'role_permissions rows present in the database but not granted by RBAC_MATRIX_V1');
  assert.deepEqual(wrongScope, [], 'role_permissions rows whose DB resource_scope differs from RBAC_MATRIX_V1');

  assert.equal(dbRows.length, 290);
});

test('database permissions catalog matches PERMISSION_CODES exactly: no missing, extra, or unknown codes', async () => {
  const dbPermissions = await sql`SELECT code FROM public.permissions ORDER BY code`;
  const dbCodes = new Set(dbPermissions.map((row) => row.code));
  const expectedCodes = new Set(rbac.PERMISSION_CODES);

  const missing = [...expectedCodes].filter((code) => !dbCodes.has(code));
  const unknown = [...dbCodes].filter((code) => !expectedCodes.has(code));

  assert.deepEqual(missing, [], 'permission codes in RBAC_MATRIX_V1 missing from the database');
  assert.deepEqual(unknown, [], 'unknown permission codes present in the database (not in RBAC_MATRIX_V1)');
  assert.equal(dbCodes.size, 103);
});

test('database roles catalog matches ROLE_CODES exactly: no missing, extra, or unknown codes', async () => {
  const dbRoles = await sql`SELECT code, scope, is_system FROM public.roles ORDER BY code`;
  const dbCodes = new Set(dbRoles.map((row) => row.code));
  const expectedCodes = new Set(rbac.ROLE_CODES);

  const missing = [...expectedCodes].filter((code) => !dbCodes.has(code));
  const unknown = [...dbCodes].filter((code) => !expectedCodes.has(code));

  assert.deepEqual(missing, [], 'role codes in ROLE_CODES missing from the database');
  assert.deepEqual(unknown, [], 'unknown role codes present in the database (not in ROLE_CODES)');

  for (const row of dbRoles) {
    assert.equal(row.scope, 'tenant', `role ${row.code} must have scope='tenant'`);
    assert.equal(row.is_system, true, `role ${row.code} must be is_system=true`);
  }
});

test('runtime role tallermecario_api can only SELECT roles/permissions/role_permissions (read-only RBAC catalog)', async () => {
  // PostgreSQL error code 42501 = insufficient_privilege. Matching on the
  // code (not the message) keeps this assertion independent of server locale.
  await assert.rejects(
    sql`INSERT INTO public.roles (id, code, name, scope, is_system) VALUES (uuidv7(), 'rogue', 'Rogue', 'tenant', true)`,
    (error) => error.code === '42501',
  );
  await assert.rejects(
    sql`UPDATE public.role_permissions SET resource_scope = 'tenant' WHERE true`,
    (error) => error.code === '42501',
  );
});
