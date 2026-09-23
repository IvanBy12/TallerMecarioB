'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const { combinePermissionScopes } = require(join(root, 'authz/permission-grants.js'));

function scopesArray(grant) {
  assert.equal(grant?.kind, 'restricted');
  return [...grant.scopes].sort();
}

test('empty scope list -> undefined (no grant)', () => {
  assert.equal(combinePermissionScopes([]), undefined);
});

test('single tenant scope -> tenant', () => {
  assert.deepEqual(combinePermissionScopes(['tenant']), { kind: 'tenant' });
});

test('single assigned scope -> restricted({assigned})', () => {
  const grant = combinePermissionScopes(['assigned']);
  assert.equal(grant.kind, 'restricted');
  assert.deepEqual(scopesArray(grant), ['assigned']);
});

test('single quality_control scope -> restricted({quality_control})', () => {
  const grant = combinePermissionScopes(['quality_control']);
  assert.equal(grant.kind, 'restricted');
  assert.deepEqual(scopesArray(grant), ['quality_control']);
});

test('assigned + quality_control -> restricted union of both', () => {
  const grant = combinePermissionScopes(['assigned', 'quality_control']);
  assert.equal(grant.kind, 'restricted');
  assert.deepEqual(scopesArray(grant), ['assigned', 'quality_control']);
});

test('assigned + tenant -> tenant dominates', () => {
  assert.deepEqual(combinePermissionScopes(['assigned', 'tenant']), { kind: 'tenant' });
});

test('quality_control + tenant -> tenant dominates', () => {
  assert.deepEqual(combinePermissionScopes(['quality_control', 'tenant']), { kind: 'tenant' });
});

test('assigned + quality_control + tenant -> tenant dominates', () => {
  assert.deepEqual(combinePermissionScopes(['assigned', 'quality_control', 'tenant']), { kind: 'tenant' });
});

test('duplicate scopes collapse (no duplicate entries in restricted set)', () => {
  const grant = combinePermissionScopes(['assigned', 'assigned', 'quality_control', 'quality_control']);
  assert.equal(grant.kind, 'restricted');
  assert.equal(grant.scopes.size, 2);
  assert.deepEqual(scopesArray(grant), ['assigned', 'quality_control']);
});

test('duplicate tenant scopes still resolve to a single tenant grant', () => {
  assert.deepEqual(combinePermissionScopes(['tenant', 'tenant', 'tenant']), { kind: 'tenant' });
});

test('result is independent of input order (restricted case)', () => {
  const a = combinePermissionScopes(['assigned', 'quality_control']);
  const b = combinePermissionScopes(['quality_control', 'assigned']);
  assert.deepEqual(scopesArray(a), scopesArray(b));
});

test('result is independent of input order (tenant-dominates case)', () => {
  const a = combinePermissionScopes(['assigned', 'tenant', 'quality_control']);
  const b = combinePermissionScopes(['quality_control', 'tenant', 'assigned']);
  const c = combinePermissionScopes(['tenant', 'assigned', 'quality_control']);
  assert.deepEqual(a, { kind: 'tenant' });
  assert.deepEqual(b, { kind: 'tenant' });
  assert.deepEqual(c, { kind: 'tenant' });
});

test('two independent restricted grants for the same inputs do not share mutable state', () => {
  const a = combinePermissionScopes(['assigned']);
  const b = combinePermissionScopes(['assigned']);
  a.scopes.add('quality_control');
  assert.deepEqual(scopesArray(b), ['assigned']);
});
