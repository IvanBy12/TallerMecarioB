'use strict';

/**
 * Pinned-cell regression tests for RBAC_MATRIX_V1.
 *
 * These lists are intentionally independent literals (NOT derived from
 * rbac-matrix.ts). Comparing RAW_MATRIX against itself would be a tautology
 * that can never fail; pinning the expected technician/owner-only cells here
 * separately means an accidental edit to a single cell in rbac-matrix.ts
 * (e.g. a technician A/Q permission silently becoming 'tenant') makes this
 * suite fail, per the S1-02 "technician security" and "owner/admin/advisor"
 * requirements.
 */

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const rbac = require(join(root, 'authz/rbac-matrix.js'));

// technician 'assigned' — 18 codes (RBAC matrix v1, §5-10 y §15).
const TECHNICIAN_ASSIGNED_CODES = [
  'vehicles.read',
  'receptions.read',
  'media.read',
  'media.upload',
  'orders.read',
  'order_items.read',
  'diagnostics.read',
  'diagnostics.write',
  'diagnostics.close',
  'inventory.movements.read',
  'inventory.consume_assigned',
  'quotes.propose_labor_adjustment',
  'work_activities.read',
  'work_activities.manage',
  'technician_logs.read',
  'technician_logs.create',
  'quality_checks.read',
  'dashboard.operational.read',
];

// technician 'quality_control' — 1 code (RBAC matrix v1, §10).
const TECHNICIAN_QUALITY_CONTROL_CODES = ['quality_checks.perform'];

// technician 'tenant' — 6 codes (RBAC matrix v1, §4, §9, §15).
const TECHNICIAN_TENANT_CODES = [
  'workshop.read',
  'locations.read',
  'catalog.read',
  'inventory.read',
  'notifications.read',
  'notifications.preferences.update_self',
];

// owner-only permissions (admin/advisor/technician must all be denied).
const OWNER_ONLY_CODES = [
  'workshop.legal.update',
  'roles.assign_admin',
  'roles.assign_owner',
  'ownership.transfer',
  'subscription.manage',
  'legal_acceptances.accept_for_tenant',
];

test('technician: assigned-scope codes match the pinned 18-code list exactly', () => {
  assert.equal(TECHNICIAN_ASSIGNED_CODES.length, 18);
  for (const code of TECHNICIAN_ASSIGNED_CODES) {
    assert.equal(
      rbac.RBAC_MATRIX_V1[code].technician.grant,
      'assigned',
      `expected technician grant for ${code} to be 'assigned'`,
    );
  }
});

test('technician: quality_control-scope codes match the pinned 1-code list exactly', () => {
  assert.equal(TECHNICIAN_QUALITY_CONTROL_CODES.length, 1);
  for (const code of TECHNICIAN_QUALITY_CONTROL_CODES) {
    assert.equal(
      rbac.RBAC_MATRIX_V1[code].technician.grant,
      'quality_control',
      `expected technician grant for ${code} to be 'quality_control'`,
    );
  }
});

test('technician: tenant-scope codes match the pinned 6-code list exactly', () => {
  assert.equal(TECHNICIAN_TENANT_CODES.length, 6);
  for (const code of TECHNICIAN_TENANT_CODES) {
    assert.equal(
      rbac.RBAC_MATRIX_V1[code].technician.grant,
      'tenant',
      `expected technician grant for ${code} to be 'tenant'`,
    );
  }
});

test('technician: every other permission code is denied (no accidental grant)', () => {
  const grantedElsewhere = new Set([
    ...TECHNICIAN_ASSIGNED_CODES,
    ...TECHNICIAN_QUALITY_CONTROL_CODES,
    ...TECHNICIAN_TENANT_CODES,
  ]);
  assert.equal(grantedElsewhere.size, 25, 'the three pinned lists must not overlap');

  const unexpectedGrants = rbac.PERMISSION_CODES
    .filter((code) => !grantedElsewhere.has(code))
    .filter((code) => rbac.RBAC_MATRIX_V1[code].technician.grant !== 'deny');

  assert.deepEqual(unexpectedGrants, [], 'technician has an ungranted-by-doc permission');
});

test('technician: never receives customer PII (customers.*) or financial permissions', () => {
  const forbiddenPrefixes = ['customers.', 'customer_payments.', 'quotes.send', 'quotes.override_price'];
  for (const code of rbac.PERMISSION_CODES) {
    if (forbiddenPrefixes.some((prefix) => code.startsWith(prefix))) {
      assert.equal(
        rbac.RBAC_MATRIX_V1[code].technician.grant,
        'deny',
        `technician must not be granted ${code}`,
      );
    }
  }
});

test('owner-only codes: owner=tenant, admin/advisor/technician=deny', () => {
  for (const code of OWNER_ONLY_CODES) {
    const cell = rbac.RBAC_MATRIX_V1[code];
    assert.equal(cell.owner.grant, 'tenant', `${code}: owner should be granted tenant`);
    assert.equal(cell.admin.grant, 'deny', `${code}: admin should be denied`);
    assert.equal(cell.service_advisor.grant, 'deny', `${code}: service_advisor should be denied`);
    assert.equal(cell.technician.grant, 'deny', `${code}: technician should be denied`);
  }
});

test('owner: granted tenant on every one of the 103 permission codes', () => {
  for (const code of rbac.PERMISSION_CODES) {
    assert.equal(rbac.RBAC_MATRIX_V1[code].owner.grant, 'tenant', `owner should be granted ${code}`);
  }
});

test('admin: can never assign owner/admin roles nor transfer ownership', () => {
  assert.equal(rbac.RBAC_MATRIX_V1['roles.assign_admin'].admin.grant, 'deny');
  assert.equal(rbac.RBAC_MATRIX_V1['roles.assign_owner'].admin.grant, 'deny');
  assert.equal(rbac.RBAC_MATRIX_V1['ownership.transfer'].admin.grant, 'deny');
});

test('admin: can assign staff (service_advisor/technician) but not manage SaaS subscription', () => {
  assert.equal(rbac.RBAC_MATRIX_V1['roles.assign_staff'].admin.grant, 'tenant');
  assert.equal(rbac.RBAC_MATRIX_V1['subscription.manage'].admin.grant, 'deny');
});

test('service_advisor: cannot manage memberships, roles, audit or SaaS billing', () => {
  const deniedForAdvisor = [
    'memberships.read',
    'memberships.invite_staff',
    'memberships.manage_staff',
    'roles.assign_staff',
    'audit.read',
    'subscription.read',
    'subscription.manage',
  ];
  for (const code of deniedForAdvisor) {
    assert.equal(
      rbac.RBAC_MATRIX_V1[code].service_advisor.grant,
      'deny',
      `service_advisor should be denied ${code}`,
    );
  }
});
