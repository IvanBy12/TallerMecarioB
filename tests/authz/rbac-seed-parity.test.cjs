'use strict';

const assert = require('node:assert/strict');
const { readdirSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  buildGeneratedBlock,
  extractGeneratedBlock,
  BEGIN_MARKER,
} = require('../../scripts/generate-rbac-seed-sql.cjs');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const rbac = require(join(root, 'authz/rbac-matrix.js'));

const DRIZZLE_DIR = resolve(__dirname, '../../drizzle');

/**
 * Locate the migration carrying the GENERATED RBAC V1 block by content, not
 * by filename. The migration number is expected to change when this branch
 * is rebased/reconciled onto the final S1-01 base (see task instructions);
 * pinning a literal filename here would make the parity test silently stop
 * covering the real migration after a rename.
 */
function findRbacMigrationPath() {
  const candidates = readdirSync(DRIZZLE_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => resolve(DRIZZLE_DIR, name))
    .filter((path) => readFileSync(path, 'utf8').includes(BEGIN_MARKER));

  if (candidates.length === 0) {
    throw new Error('RBAC_MIGRATION_NOT_FOUND: no drizzle/*.sql contains BEGIN GENERATED RBAC V1');
  }
  if (candidates.length > 1) {
    throw new Error(`RBAC_MIGRATION_AMBIGUOUS: multiple files contain BEGIN GENERATED RBAC V1: ${candidates.join(', ')}`);
  }
  return candidates[0];
}

test('migration GENERATED RBAC V1 block matches RBAC_MATRIX_V1 exactly', () => {
  const migrationPath = findRbacMigrationPath();
  const expected = buildGeneratedBlock(rbac);
  const actual = extractGeneratedBlock(readFileSync(migrationPath, 'utf8'));

  assert.ok(actual, `no GENERATED RBAC V1 block found in ${migrationPath}`);
  assert.equal(
    actual,
    expected,
    `GENERATED RBAC V1 block in ${migrationPath} is stale — regenerate with:\n` +
      '  node scripts/generate-rbac-seed-sql.cjs',
  );
});

test('RBAC_MATRIX_V1 totals match the S1-02 canonical counts (103 permissions, 290 role_permissions)', () => {
  assert.equal(rbac.PERMISSION_CODES.length, 103);

  const rows = rbac.listRolePermissionRows();
  assert.equal(rows.length, 290);

  const countFor = (roleCode, scope) =>
    rows.filter((r) => r.roleCode === roleCode && r.resourceScope === scope).length;

  assert.equal(countFor('owner', 'tenant'), 103);
  assert.equal(countFor('admin', 'tenant'), 97);
  assert.equal(countFor('service_advisor', 'tenant'), 65);
  assert.equal(countFor('technician', 'tenant'), 6);
  assert.equal(countFor('technician', 'assigned'), 18);
  assert.equal(countFor('technician', 'quality_control'), 1);

  // No other (role, scope) combination should have any rows.
  const expectedTotal = 103 + 97 + 65 + 6 + 18 + 1;
  assert.equal(rows.length, expectedTotal);
});

test('generator output is deterministic across two independent builds', () => {
  const first = buildGeneratedBlock(rbac);
  const second = buildGeneratedBlock(rbac);
  assert.equal(first, second);
});
