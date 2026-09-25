'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const authz = require(join(root, 'authz/authorize.js'));
const { createTenantContext, TenantContextInvalidError } = require(join(root, 'tenancy/tenant-context.js'));
const { listRolePermissionRows, PERMISSION_CODES } = require(join(root, 'authz/rbac-matrix.js'));

const {
  buildPermissionGrantMap,
  resolvePermissionDecision,
  requireTenantPermission,
  authorizePermissionRequirement,
  definePermissionRequirement,
  parsePermissionCode,
  PermissionDeniedError,
  AuthzUnknownPermissionError,
  AuthzUnknownResourceScopeError,
  AuthzUnknownRoleError,
  AuthzInvalidRequirementError,
} = authz;

const TENANT_ID = '0192f0e1-7c3a-7abc-8def-0123456789ab';
const USER_ID = '0192f0e1-7c3a-7abc-9def-00000000000a';
const MEMBERSHIP_ID = '0192f0e2-0000-7000-8000-00000000000a';
const REQUEST_ID = '0192f0e3-0000-7000-8000-000000000001';

/** role_permissions rows of the given roles, as the DB join will return them (no role code attached). */
function rowsForRoles(...roles) {
  return listRolePermissionRows()
    .filter((row) => roles.includes(row.roleCode))
    .map((row) => ({ permissionCode: row.permissionCode, resourceScope: row.resourceScope }));
}

function contextFor(roleCodes, permissionRows = rowsForRoles(...roleCodes)) {
  return createTenantContext({
    tenantId: TENANT_ID,
    userId: USER_ID,
    membershipId: MEMBERSHIP_ID,
    roleCodes,
    permissionRows,
    requestId: REQUEST_ID,
  });
}

function scopesOf(decision) {
  return [...decision.scopes].sort();
}

function assertCode(fn, ErrorClass, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ErrorClass, `expected ${ErrorClass.name}, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

const owner = contextFor(['owner']);
const admin = contextFor(['admin']);
const technician = contextFor(['technician']);

/* --------------------------- permission decisions ------------------------- */

test('owner + orders.read -> tenant; requireTenantPermission passes', () => {
  assert.deepEqual(resolvePermissionDecision(owner, 'orders.read'), { kind: 'tenant' });
  assert.doesNotThrow(() => requireTenantPermission(owner, 'orders.read'));
});

test('owner has a tenant grant for all 103 permission codes', () => {
  assert.equal(owner.permissions.size, 103);
  for (const code of PERMISSION_CODES) assert.equal(resolvePermissionDecision(owner, code).kind, 'tenant', code);
});

test('admin tenant grant (orders.read) and admin missing grant (roles.assign_admin)', () => {
  assert.equal(admin.permissions.size, 97);
  assert.deepEqual(resolvePermissionDecision(admin, 'orders.read'), { kind: 'tenant' });
  assert.deepEqual(resolvePermissionDecision(admin, 'roles.assign_admin'), { kind: 'denied' });
});

test('technician + orders.read -> resource {assigned}', () => {
  const decision = resolvePermissionDecision(technician, 'orders.read');
  assert.equal(decision.kind, 'resource');
  assert.deepEqual(scopesOf(decision), ['assigned']);
});

test('technician + quality_checks.perform -> resource {quality_control}', () => {
  const decision = resolvePermissionDecision(technician, 'quality_checks.perform');
  assert.equal(decision.kind, 'resource');
  assert.deepEqual(scopesOf(decision), ['quality_control']);
});

test('technician grant counts: 6 tenant + 18 assigned + 1 quality_control', () => {
  const counts = { tenant: 0, assigned: 0, quality_control: 0 };
  for (const grant of technician.permissions.values()) {
    if (grant.kind === 'tenant') counts.tenant += 1;
    else for (const scope of grant.scopes) counts[scope] += 1;
  }
  assert.deepEqual(counts, { tenant: 6, assigned: 18, quality_control: 1 });
});

test('missing permission -> denied; requireTenantPermission throws PERMISSION_DENIED', () => {
  assert.deepEqual(resolvePermissionDecision(technician, 'customers.read'), { kind: 'denied' });
  assertCode(() => requireTenantPermission(technician, 'customers.read'), PermissionDeniedError, 'PERMISSION_DENIED');
});

test('CRITICAL: technician orders.read=assigned cannot be used as a tenant-wide read', () => {
  assertCode(() => requireTenantPermission(technician, 'orders.read'), PermissionDeniedError, 'PERMISSION_DENIED');
  const decision = authorizePermissionRequirement(technician, { permission: 'orders.read', scope: 'tenant' });
  assert.equal(decision.kind, 'denied');
});

test('CRITICAL: no technician restricted grant is ever elevated to tenant', () => {
  let restricted = 0;
  for (const [code, grant] of technician.permissions) {
    if (grant.kind !== 'restricted') continue;
    restricted += 1;
    assert.equal(resolvePermissionDecision(technician, code).kind, 'resource', code);
    assert.throws(() => requireTenantPermission(technician, code), PermissionDeniedError, code);
    assert.equal(authorizePermissionRequirement(technician, { permission: code, scope: 'tenant' }).kind, 'denied', code);
  }
  assert.equal(restricted, 19);
});

/* ------------------------------ unknown values ---------------------------- */

test('unknown permission code at a dynamic boundary -> AUTHZ_UNKNOWN_PERMISSION (fail closed)', () => {
  for (const value of ['orders.delete_everything', '', 'ORDERS.READ', ' orders.read', 'constructor', '__proto__', null, undefined, 42]) {
    assertCode(() => parsePermissionCode(value), AuthzUnknownPermissionError, 'AUTHZ_UNKNOWN_PERMISSION');
    assertCode(() => resolvePermissionDecision(owner, value), AuthzUnknownPermissionError, 'AUTHZ_UNKNOWN_PERMISSION');
    assertCode(() => requireTenantPermission(owner, value), AuthzUnknownPermissionError, 'AUTHZ_UNKNOWN_PERMISSION');
  }
  assert.equal(parsePermissionCode('orders.read'), 'orders.read');
});

test('unknown permission row from DB -> whole map rejected (no partial map)', () => {
  assertCode(
    () => buildPermissionGrantMap([
      { permissionCode: 'orders.read', resourceScope: 'tenant' },
      { permissionCode: 'orders.nuke', resourceScope: 'tenant' },
    ]),
    AuthzUnknownPermissionError,
    'AUTHZ_UNKNOWN_PERMISSION',
  );
});

test('unknown resource scope from DB -> AUTHZ_UNKNOWN_RESOURCE_SCOPE (fail closed)', () => {
  for (const resourceScope of ['global', 'TENANT', '', ' tenant', null, undefined]) {
    assertCode(
      () => buildPermissionGrantMap([{ permissionCode: 'orders.read', resourceScope }]),
      AuthzUnknownResourceScopeError,
      'AUTHZ_UNKNOWN_RESOURCE_SCOPE',
    );
  }
});

test('createTenantContext fails closed on unknown role / permission / scope', () => {
  assertCode(() => contextFor(['superadmin'], []), AuthzUnknownRoleError, 'AUTHZ_UNKNOWN_ROLE');
  assertCode(() => contextFor(['Owner'], []), AuthzUnknownRoleError, 'AUTHZ_UNKNOWN_ROLE');
  assertCode(
    () => contextFor(['owner'], [{ permissionCode: 'platform.impersonate', resourceScope: 'tenant' }]),
    AuthzUnknownPermissionError,
    'AUTHZ_UNKNOWN_PERMISSION',
  );
  assertCode(
    () => contextFor(['technician'], [{ permissionCode: 'orders.read', resourceScope: 'everything' }]),
    AuthzUnknownResourceScopeError,
    'AUTHZ_UNKNOWN_RESOURCE_SCOPE',
  );
});

test('createTenantContext rejects malformed ids and request id', () => {
  const base = { tenantId: TENANT_ID, userId: USER_ID, membershipId: MEMBERSHIP_ID, roleCodes: [], permissionRows: [], requestId: REQUEST_ID };
  for (const [field, value] of [
    ['tenantId', 'nope'], ['tenantId', ` ${TENANT_ID}`], ['userId', ''], ['membershipId', undefined],
    ['requestId', ''], ['requestId', 'has space'], ['requestId', 'x'.repeat(129)], ['requestId', 7],
  ]) {
    assert.throws(() => createTenantContext({ ...base, [field]: value }), (error) => {
      assert.ok(error instanceof TenantContextInvalidError);
      assert.equal(error.code, 'TENANT_CONTEXT_INVALID');
      assert.equal(error.field, field);
      return true;
    });
  }
  assert.equal(createTenantContext({ ...base, tenantId: TENANT_ID.toUpperCase() }).tenantId, TENANT_ID);
});

/* --------------------------- multi-role combination ----------------------- */

test('tenant dominates restricted: [orders.read|assigned, orders.read|tenant] -> tenant', () => {
  const map = buildPermissionGrantMap([
    { permissionCode: 'orders.read', resourceScope: 'assigned' },
    { permissionCode: 'orders.read', resourceScope: 'tenant' },
  ]);
  assert.deepEqual(map.get('orders.read'), { kind: 'tenant' });
});

test('assigned + QC union: quality_checks.perform -> restricted {assigned, quality_control}', () => {
  const map = buildPermissionGrantMap([
    { permissionCode: 'quality_checks.perform', resourceScope: 'assigned' },
    { permissionCode: 'quality_checks.perform', resourceScope: 'quality_control' },
  ]);
  const grant = map.get('quality_checks.perform');
  assert.equal(grant.kind, 'restricted');
  assert.deepEqual([...grant.scopes], ['assigned', 'quality_control']);
});

test('technician + service_advisor membership: union per permission, tenant dominates', () => {
  const ctx = contextFor(['technician', 'service_advisor']);
  assert.deepEqual(resolvePermissionDecision(ctx, 'orders.read'), { kind: 'tenant' });
  assert.deepEqual(resolvePermissionDecision(ctx, 'quality_checks.perform'), { kind: 'tenant' });

  // Expected per code, derived from the matrix rows of each role independently.
  const scopesByCode = new Map();
  for (const row of listRolePermissionRows()) {
    if (row.roleCode !== 'technician' && row.roleCode !== 'service_advisor') continue;
    scopesByCode.set(row.permissionCode, [...(scopesByCode.get(row.permissionCode) ?? []), row.resourceScope]);
  }
  for (const code of PERMISSION_CODES) {
    const scopes = scopesByCode.get(code) ?? [];
    const decision = resolvePermissionDecision(ctx, code);
    if (scopes.length === 0) assert.equal(decision.kind, 'denied', code);
    else if (scopes.includes('tenant')) assert.equal(decision.kind, 'tenant', code);
    else assert.deepEqual(scopesOf(decision), [...new Set(scopes)].sort(), code);
  }
});

test('duplicates and input order are irrelevant (deterministic map, canonical order)', () => {
  const rows = rowsForRoles('technician', 'admin');
  const a = buildPermissionGrantMap(rows);
  const b = buildPermissionGrantMap([...rows].reverse().concat(rows));
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [code, grant] of a) {
    const other = b.get(code);
    assert.equal(other.kind, grant.kind);
    if (grant.kind === 'restricted') assert.deepEqual([...other.scopes], [...grant.scopes]);
  }
  const order = PERMISSION_CODES.filter((code) => a.has(code));
  assert.deepEqual([...a.keys()], order);
});

test('empty rows -> empty map -> every permission denied', () => {
  const ctx = contextFor([], []);
  assert.equal(ctx.permissions.size, 0);
  assert.deepEqual(resolvePermissionDecision(ctx, 'workshop.read'), { kind: 'denied' });
});

/* --------------------------- route requirements --------------------------- */

test('tenant requirement + tenant grant -> allowed', () => {
  assert.deepEqual(
    authorizePermissionRequirement(owner, { permission: 'orders.read', scope: 'tenant' }),
    { kind: 'allowed', permission: 'orders.read' },
  );
});

test('tenant requirement + restricted grant -> denied', () => {
  assert.deepEqual(
    authorizePermissionRequirement(technician, { permission: 'orders.read', scope: 'tenant' }),
    { kind: 'denied', permission: 'orders.read' },
  );
});

test('resource requirement + tenant grant -> allowed immediately (no resource check)', () => {
  assert.deepEqual(
    authorizePermissionRequirement(admin, { permission: 'orders.read', scope: 'resource' }),
    { kind: 'allowed', permission: 'orders.read' },
  );
});

test('resource requirement + restricted grant -> resource_check_required with scopes', () => {
  const decision = authorizePermissionRequirement(technician, { permission: 'quality_checks.perform', scope: 'resource' });
  assert.equal(decision.kind, 'resource_check_required');
  assert.equal(decision.permission, 'quality_checks.perform');
  assert.deepEqual(scopesOf(decision), ['quality_control']);
});

test('resource requirement + no grant -> denied', () => {
  assert.deepEqual(
    authorizePermissionRequirement(technician, { permission: 'customers.read', scope: 'resource' }),
    { kind: 'denied', permission: 'customers.read' },
  );
});

test('invalid requirement scope / unknown permission fail closed', () => {
  assertCode(() => authorizePermissionRequirement(owner, { permission: 'orders.read', scope: 'any' }), AuthzInvalidRequirementError, 'AUTHZ_INVALID_REQUIREMENT');
  assertCode(() => authorizePermissionRequirement(owner, { permission: 'orders.read' }), AuthzInvalidRequirementError, 'AUTHZ_INVALID_REQUIREMENT');
  assertCode(() => authorizePermissionRequirement(owner, { permission: 'orders.x', scope: 'tenant' }), AuthzUnknownPermissionError, 'AUTHZ_UNKNOWN_PERMISSION');
  assertCode(() => definePermissionRequirement('orders.x'), AuthzUnknownPermissionError, 'AUTHZ_UNKNOWN_PERMISSION');
  assertCode(() => definePermissionRequirement('orders.read', 'assigned'), AuthzInvalidRequirementError, 'AUTHZ_INVALID_REQUIREMENT');
  assert.deepEqual(definePermissionRequirement('orders.read'), { permission: 'orders.read', scope: 'tenant' });
  assert.deepEqual(definePermissionRequirement('orders.read', 'resource'), { permission: 'orders.read', scope: 'resource' });
});

/* ------------------------------ immutability ------------------------------ */

test('TenantContext is immutable: object, roles and permissions cannot be mutated', () => {
  const ctx = contextFor(['technician']);
  assert.ok(Object.isFrozen(ctx));
  assert.throws(() => { ctx.tenantId = 'x'; }, TypeError);
  assert.throws(() => { ctx.permissions = new Map(); }, TypeError);
  assert.throws(() => ctx.roles.add('owner'), TypeError);
  assert.throws(() => ctx.roles.delete('technician'), TypeError);
  assert.throws(() => ctx.roles.clear(), TypeError);
  assert.throws(() => ctx.permissions.set('customers.read', { kind: 'tenant' }), TypeError);
  assert.throws(() => ctx.permissions.delete('orders.read'), TypeError);
  assert.throws(() => ctx.permissions.clear(), TypeError);
  assert.throws(() => Set.prototype.add.call(ctx.roles, 'owner'), TypeError);
  assert.throws(() => Map.prototype.set.call(ctx.permissions, 'customers.read', { kind: 'tenant' }), TypeError);
  assert.throws(() => { Object.getPrototypeOf(ctx.roles).add = () => {}; }, TypeError);

  const grant = ctx.permissions.get('orders.read');
  assert.ok(Object.isFrozen(grant));
  assert.throws(() => { grant.kind = 'tenant'; }, TypeError);
  assert.throws(() => grant.scopes.add('quality_control'), TypeError);

  assert.deepEqual([...ctx.roles], ['technician']);
  assert.deepEqual(resolvePermissionDecision(ctx, 'customers.read'), { kind: 'denied' });
  assert.equal(resolvePermissionDecision(ctx, 'orders.read').kind, 'resource');
});

test('TenantContext does not change when external input references are mutated afterwards', () => {
  const roleCodes = ['technician'];
  const permissionRows = rowsForRoles('technician');
  const orderRow = permissionRows.find((row) => row.permissionCode === 'orders.read');
  const ctx = contextFor(roleCodes, permissionRows);
  const before = { roles: [...ctx.roles], size: ctx.permissions.size };

  roleCodes.push('owner');
  orderRow.resourceScope = 'tenant';
  permissionRows.push({ permissionCode: 'customers.read', resourceScope: 'tenant' });

  assert.deepEqual([...ctx.roles], before.roles);
  assert.equal(ctx.roles.has('owner'), false);
  assert.equal(ctx.permissions.size, before.size);
  assert.equal(resolvePermissionDecision(ctx, 'orders.read').kind, 'resource');
  assert.deepEqual(resolvePermissionDecision(ctx, 'customers.read'), { kind: 'denied' });
});

test('decisions and grants expose no mutable collection', () => {
  const decision = resolvePermissionDecision(technician, 'orders.read');
  assert.ok(Object.isFrozen(decision));
  assert.throws(() => decision.scopes.add('quality_control'), TypeError);
  assert.deepEqual(scopesOf(resolvePermissionDecision(technician, 'orders.read')), ['assigned']);
});

/* ------------------------ roles are not authorization --------------------- */

test('authorization ignores role codes: owner role without permission rows is denied', () => {
  const ctx = contextFor(['owner'], []);
  assert.deepEqual(resolvePermissionDecision(ctx, 'workshop.read'), { kind: 'denied' });
  assertCode(() => requireTenantPermission(ctx, 'workshop.read'), PermissionDeniedError, 'PERMISSION_DENIED');
});

test('authorization ignores role codes: no roles but a tenant permission row is allowed', () => {
  const ctx = contextFor([], [{ permissionCode: 'orders.read', resourceScope: 'tenant' }]);
  assert.doesNotThrow(() => requireTenantPermission(ctx, 'orders.read'));
});

test('static: authorization / tenancy core never compares role names', () => {
  const files = [
    'src/authz/authorize.ts',
    'src/authz/resource-authorization.ts',
    'src/tenancy/tenant-context.ts',
    'src/tenancy/tenant-selection.ts',
  ];
  const forbidden = [
    /['"`](owner|admin|service_advisor|technician)['"`]/,
    /\broles?\s*(===|!==|==|!=)/,
    /(===|!==|==|!=)\s*\broles?\b/,
    /\broles\s*\.\s*(has|includes|some|every|find|indexOf)\s*\(/,
    /\broleCodes?\s*\.\s*(includes|some|every|find|indexOf)\s*\(/,
  ];
  for (const file of files) {
    const source = readFileSync(resolve(file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not authorize by role name (${pattern})`);
    }
  }
});
