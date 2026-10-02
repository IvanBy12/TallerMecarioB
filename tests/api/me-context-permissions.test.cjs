'use strict';

/**
 * GET /api/v1/me/context — pure permission serialization (no Fastify, no
 * PostgreSQL). The input is a real TenantContext built by createTenantContext
 * from role_permissions-shaped rows, so the effective-grant rules (union,
 * tenant dominates) are the production ones, not re-implemented here.
 * The DB-backed route tests live in tests/api/tenant-context-integration.test.cjs.
 */

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const { serializeTenantPermissions } = require(join(root, 'api/me-context.js'));
const { createTenantContext } = require(join(root, 'tenancy/tenant-context.js'));
const { FrozenMap } = require(join(root, 'platform/readonly-collections.js'));
const { listRolePermissionRows, PERMISSION_CODES } = require(join(root, 'authz/rbac-matrix.js'));

function rowsForRoles(...roles) {
  return listRolePermissionRows()
    .filter((row) => roles.includes(row.roleCode))
    .map((row) => ({ permissionCode: row.permissionCode, resourceScope: row.resourceScope }));
}

function contextFor(roleCodes, permissionRows = rowsForRoles(...roleCodes)) {
  return createTenantContext({
    tenantId: '0192f0e1-7c3a-7abc-8def-0123456789ab',
    userId: '0192f0e1-7c3a-7abc-9def-00000000000a',
    membershipId: '0192f0e2-0000-7000-8000-00000000000a',
    roleCodes,
    permissionRows,
    requestId: '0192f0e3-0000-7000-8000-000000000001',
  });
}

const serialize = (context) => serializeTenantPermissions(context.permissions);
const byCode = (serialized) => Object.fromEntries(serialized.map((entry) => [entry.code, entry.scopes]));
const sortedCodes = (codes) => [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Expected effective scopes straight from the matrix rows: tenant dominates, else the restricted union. */
function expectedFromMatrix(...roles) {
  const scopes = new Map();
  for (const row of rowsForRoles(...roles)) {
    scopes.set(row.permissionCode, [...(scopes.get(row.permissionCode) ?? []), row.resourceScope]);
  }
  const expected = {};
  for (const [code, list] of scopes) {
    expected[code] = list.includes('tenant')
      ? ['tenant']
      : ['assigned', 'quality_control'].filter((scope) => list.includes(scope));
  }
  return expected;
}

test('single role (owner): every grant is tenant, codes sorted, one entry per granted permission', () => {
  const serialized = serialize(contextFor(['owner']));
  assert.equal(serialized.length, PERMISSION_CODES.length);
  assert.deepEqual(serialized.map((entry) => entry.code), sortedCodes(PERMISSION_CODES));
  for (const entry of serialized) {
    assert.deepEqual(Object.keys(entry), ['code', 'scopes']);
    assert.deepEqual(entry.scopes, ['tenant'], entry.code);
  }
});

test('multiple roles: effective union of the active roles, nothing more', () => {
  const context = contextFor(['service_advisor', 'technician']);
  const serialized = serialize(context);
  assert.deepEqual(byCode(serialized), expectedFromMatrix('service_advisor', 'technician'));
  assert.equal(serialized.length, context.permissions.size);
  // A permission no active role grants is absent (roles.assign_admin is owner-only).
  assert.equal(serialized.some((entry) => entry.code === 'roles.assign_admin'), false);
});

test('tenant dominates restricted scopes of another role for the same permission', () => {
  const technician = byCode(serialize(contextFor(['technician'])));
  assert.deepEqual(technician['vehicles.read'], ['assigned']);
  const combined = byCode(serialize(contextFor(['service_advisor', 'technician'])));
  assert.deepEqual(combined['vehicles.read'], ['tenant']);

  const rows = [
    { permissionCode: 'orders.read', resourceScope: 'assigned' },
    { permissionCode: 'orders.read', resourceScope: 'quality_control' },
    { permissionCode: 'orders.read', resourceScope: 'tenant' },
  ];
  assert.deepEqual(serialize(contextFor(['technician'], rows)), [{ code: 'orders.read', scopes: ['tenant'] }]);
});

test('only assigned → scopes ["assigned"]', () => {
  const serialized = byCode(serialize(contextFor(['technician'])));
  for (const code of ['vehicles.read', 'receptions.read', 'orders.read', 'diagnostics.write']) {
    assert.deepEqual(serialized[code], ['assigned'], code);
  }
  assert.deepEqual(serialized['workshop.read'], ['tenant']);
});

test('assigned + quality_control → both, canonical order regardless of row order', () => {
  for (const order of [['quality_control', 'assigned'], ['assigned', 'quality_control', 'assigned']]) {
    const rows = order.map((resourceScope) => ({ permissionCode: 'orders.read', resourceScope }));
    assert.deepEqual(serialize(contextFor(['technician'], rows)), [
      { code: 'orders.read', scopes: ['assigned', 'quality_control'] },
    ]);
  }
  const qualityOnly = [{ permissionCode: 'quality_checks.perform', resourceScope: 'quality_control' }];
  assert.deepEqual(serialize(contextFor(['technician'], qualityOnly)), [
    { code: 'quality_checks.perform', scopes: ['quality_control'] },
  ]);
});

test('deterministic: row order and role order do not change the output', () => {
  const rows = rowsForRoles('service_advisor', 'technician');
  const reversed = [...rows].reverse();
  const first = JSON.stringify(serialize(contextFor(['service_advisor', 'technician'], rows)));
  assert.equal(JSON.stringify(serialize(contextFor(['technician', 'service_advisor'], reversed))), first);
  assert.equal(JSON.stringify(serialize(contextFor(['service_advisor', 'technician']))), first);
});

test('only real grants: no rows → [], a restricted grant without scopes is omitted', () => {
  assert.deepEqual(serialize(contextFor([], [])), []);
  const permissions = new FrozenMap([
    ['workshop.read', { kind: 'tenant' }],
    ['orders.read', { kind: 'restricted', scopes: new Set() }],
  ]);
  assert.deepEqual(serializeTenantPermissions(permissions), [{ code: 'workshop.read', scopes: ['tenant'] }]);
});

test('scope order is canonical even if a grant set is not (serializer does not rely on the builder)', () => {
  const permissions = new FrozenMap([
    ['orders.read', { kind: 'restricted', scopes: new Set(['quality_control', 'assigned']) }],
  ]);
  assert.deepEqual(serializeTenantPermissions(permissions), [{ code: 'orders.read', scopes: ['assigned', 'quality_control'] }]);
});
