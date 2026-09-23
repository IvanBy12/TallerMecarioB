'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const {
  createResourceAuthorizationState,
  markResourceAuthorizationSatisfied,
  assertResourceAuthorizationComplete,
  getResourceAuthorizationStatus,
  ResourceAuthorizationCheckMissingError,
  ResourceAuthorizationStateError,
} = require(join(root, 'authz/resource-authorization.js'));
const { resolvePermissionDecision, PermissionDeniedError } = require(join(root, 'authz/authorize.js'));
const { createTenantContext } = require(join(root, 'tenancy/tenant-context.js'));
const { listRolePermissionRows } = require(join(root, 'authz/rbac-matrix.js'));

function contextFor(roleCodes) {
  return createTenantContext({
    tenantId: '0192f0e1-7c3a-7abc-8def-0123456789ab',
    userId: '0192f0e1-7c3a-7abc-9def-00000000000a',
    membershipId: '0192f0e2-0000-7000-8000-00000000000a',
    roleCodes,
    permissionRows: listRolePermissionRows()
      .filter((row) => roleCodes.includes(row.roleCode))
      .map((row) => ({ permissionCode: row.permissionCode, resourceScope: row.resourceScope })),
    requestId: '0192f0e3-0000-7000-8000-000000000001',
  });
}

const owner = contextFor(['owner']);
const technician = contextFor(['technician']);

function stateFor(ctx, permission) {
  return createResourceAuthorizationState(permission, resolvePermissionDecision(ctx, permission));
}

test('tenant grant -> not_required; assert passes without any check', () => {
  const state = stateFor(owner, 'orders.read');
  assert.equal(getResourceAuthorizationStatus(state), 'not_required');
  assert.doesNotThrow(() => assertResourceAuthorizationComplete(state));
});

test('restricted grant -> required_pending', () => {
  const state = stateFor(technician, 'orders.read');
  assert.equal(getResourceAuthorizationStatus(state), 'required_pending');
  assert.deepEqual([...state.grantedScopes], ['assigned']);
});

test('TRIPWIRE: handler forgets the resource check -> assert throws (no accidental 200)', () => {
  const state = stateFor(technician, 'orders.read');
  assert.throws(() => assertResourceAuthorizationComplete(state), (error) => {
    assert.ok(error instanceof ResourceAuthorizationCheckMissingError);
    assert.equal(error.code, 'RESOURCE_AUTHORIZATION_CHECK_MISSING');
    assert.equal(error.permission, 'orders.read');
    return true;
  });
});

test('mark via a granted scope -> satisfied; assert passes', () => {
  const state = stateFor(technician, 'orders.read');
  assert.equal(markResourceAuthorizationSatisfied(state, 'assigned'), 'satisfied');
  assert.equal(getResourceAuthorizationStatus(state), 'satisfied');
  assert.doesNotThrow(() => assertResourceAuthorizationComplete(state));
});

test('QC grant is satisfied only via quality_control', () => {
  const state = stateFor(technician, 'quality_checks.perform');
  assert.throws(() => markResourceAuthorizationSatisfied(state, 'assigned'), (error) => {
    assert.ok(error instanceof ResourceAuthorizationStateError);
    assert.equal(error.code, 'RESOURCE_AUTHORIZATION_STATE_INVALID');
    return true;
  });
  assert.equal(getResourceAuthorizationStatus(state), 'required_pending');
  assert.throws(() => assertResourceAuthorizationComplete(state), ResourceAuthorizationCheckMissingError);
  assert.equal(markResourceAuthorizationSatisfied(state, 'quality_control'), 'satisfied');
  assert.doesNotThrow(() => assertResourceAuthorizationComplete(state));
});

test('double mark is deterministic (idempotent satisfied)', () => {
  const state = stateFor(technician, 'orders.read');
  assert.equal(markResourceAuthorizationSatisfied(state, 'assigned'), 'satisfied');
  assert.equal(markResourceAuthorizationSatisfied(state, 'assigned'), 'satisfied');
  assert.equal(getResourceAuthorizationStatus(state), 'satisfied');
});

test('mark on not_required is a no-op', () => {
  const state = stateFor(owner, 'orders.read');
  assert.equal(markResourceAuthorizationSatisfied(state, 'assigned'), 'not_required');
  assert.equal(getResourceAuthorizationStatus(state), 'not_required');
});

test('denied decision never produces a state (PermissionDeniedError)', () => {
  assert.throws(() => stateFor(technician, 'customers.read'), PermissionDeniedError);
  assert.throws(() => createResourceAuthorizationState('orders.read', undefined), PermissionDeniedError);
  assert.throws(() => createResourceAuthorizationState('orders.read', { kind: 'bogus' }), PermissionDeniedError);
  assert.throws(
    () => createResourceAuthorizationState('orders.read', { kind: 'resource', scopes: new Set() }),
    PermissionDeniedError,
  );
});

test('no mutable state leakage between requests', () => {
  const requestA = stateFor(technician, 'orders.read');
  const requestB = stateFor(technician, 'orders.read');
  assert.notEqual(requestA, requestB);
  markResourceAuthorizationSatisfied(requestA, 'assigned');
  assert.equal(getResourceAuthorizationStatus(requestA), 'satisfied');
  assert.equal(getResourceAuthorizationStatus(requestB), 'required_pending');
  assert.throws(() => assertResourceAuthorizationComplete(requestB), ResourceAuthorizationCheckMissingError);
});

test('state handle cannot be forged or mutated into satisfied', () => {
  const state = stateFor(technician, 'orders.read');
  assert.ok(Object.isFrozen(state));
  assert.throws(() => { state.status = 'satisfied'; }, TypeError);
  assert.throws(() => state.grantedScopes.add('quality_control'), TypeError);
  assert.equal(getResourceAuthorizationStatus(state), 'required_pending');

  const forged = { permission: 'orders.read', grantedScopes: new Set(['assigned']) };
  assert.throws(() => getResourceAuthorizationStatus(forged), ResourceAuthorizationStateError);
  assert.throws(() => markResourceAuthorizationSatisfied(forged, 'assigned'), ResourceAuthorizationStateError);
  assert.throws(() => assertResourceAuthorizationComplete(forged), ResourceAuthorizationStateError);
  const copy = { ...state };
  assert.throws(() => assertResourceAuthorizationComplete(copy), ResourceAuthorizationStateError);
});

test('state scopes are a copy: mutating the source decision set has no effect', () => {
  const scopes = new Set(['assigned']);
  const state = createResourceAuthorizationState('orders.read', { kind: 'resource', scopes });
  scopes.add('quality_control');
  assert.throws(() => markResourceAuthorizationSatisfied(state, 'quality_control'), ResourceAuthorizationStateError);
});
