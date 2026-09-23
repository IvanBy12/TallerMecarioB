'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test } = require('node:test');

const root = process.env.TEST_AUTHZ_MODULE_ROOT;
if (!root) throw new Error('TEST_AUTHZ_MODULE_ROOT is required');
const {
  parseTenantSelection,
  parseCanonicalUuid,
  selectTenantCandidate,
  NO_TENANT_SELECTION,
  TenantSelectionInvalidError,
  ActiveMembershipRequiredError,
  TenantSelectionRequiredError,
  TenantAccessDeniedError,
  TenantCandidateInvalidError,
  TenantResolutionError,
} = require(join(root, 'tenancy/tenant-selection.js'));

// UUIDv7 fixtures (lowercase = canonical form emitted by PostgreSQL / uuidV7()).
const TENANT_A = '0192f0e1-7c3a-7abc-8def-0123456789ab';
const TENANT_B = '0192f0e1-7c3a-7abc-9def-0123456789ac';
const TENANT_C = '0192f0e1-7c3a-7abc-adef-0123456789ad';
const FOREIGN_TENANT = '0192f0e1-7c3a-7abc-bdef-0123456789ae';
const MEMBERSHIP_A = '0192f0e2-0000-7000-8000-00000000000a';
const MEMBERSHIP_B = '0192f0e2-0000-7000-8000-00000000000b';
const MEMBERSHIP_C = '0192f0e2-0000-7000-8000-00000000000c';

function assertInvalid(value) {
  assert.throws(() => parseTenantSelection(value), (error) => {
    assert.ok(error instanceof TenantSelectionInvalidError);
    assert.ok(error instanceof TenantResolutionError);
    assert.equal(error.code, 'TENANT_SELECTION_INVALID');
    return true;
  });
}

function assertCode(fn, ErrorClass, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ErrorClass, `expected ${ErrorClass.name}, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

/* --------------------------------- parser --------------------------------- */

test('parser: header absent (undefined) -> none', () => {
  assert.deepEqual(parseTenantSelection(undefined), { kind: 'none' });
  assert.equal(parseTenantSelection(undefined), NO_TENANT_SELECTION);
});

test('parser: null (WHATWG Headers.get absence) -> none', () => {
  assert.deepEqual(parseTenantSelection(null), { kind: 'none' });
});

test('parser: valid lowercase UUID -> explicit', () => {
  assert.deepEqual(parseTenantSelection(TENANT_A), { kind: 'explicit', tenantId: TENANT_A });
});

test('parser: uppercase / mixed-case UUID is canonicalized to lowercase', () => {
  assert.deepEqual(parseTenantSelection(TENANT_A.toUpperCase()), { kind: 'explicit', tenantId: TENANT_A });
  assert.deepEqual(parseTenantSelection('0192F0E1-7c3a-7ABC-8def-0123456789AB'), { kind: 'explicit', tenantId: TENANT_A });
});

test('parser: selection result is frozen', () => {
  const selection = parseTenantSelection(TENANT_A);
  assert.ok(Object.isFrozen(selection));
  assert.ok(Object.isFrozen(NO_TENANT_SELECTION));
});

test('parser: invalid UUIDs are rejected', () => {
  for (const value of [
    'not-a-uuid',
    '0192f0e1-7c3a-0abc-8def-0123456789ab', // version 0
    '0192f0e1-7c3a-7abc-0def-0123456789ab', // bad variant
    '0192f0e17c3a7abc8def0123456789ab', // compact form
    '{0192f0e1-7c3a-7abc-8def-0123456789a}', // braces
    'urn:uuid:0192f0e1-7c3a-7abc-8def-0123456789ab',
    '0192f0e1-7c3a-7abc-8def-0123456789ag', // non-hex
    '00000000-0000-0000-0000-000000000000', // nil sentinel
    'ffffffff-ffff-ffff-ffff-ffffffffffff', // max sentinel
  ]) {
    assertInvalid(value);
  }
});

test('parser: empty string is rejected', () => {
  assertInvalid('');
});

test('parser: whitespace-only is rejected', () => {
  assertInvalid(' ');
  assertInvalid('   ');
  assertInvalid('\t');
  assertInvalid(' '.repeat(36));
});

test('parser: surrounding whitespace is rejected, never trimmed', () => {
  assertInvalid(` ${TENANT_A}`);
  assertInvalid(`${TENANT_A} `);
  assertInvalid(` ${TENANT_A} `);
  assertInvalid(`${TENANT_A}\n`);
  assertInvalid(`\t${TENANT_A}`);
  // Same-length variant: one leading space replacing the last char.
  assertInvalid(` ${TENANT_A.slice(0, 35)}`);
});

test('parser: value longer than 36 chars is rejected', () => {
  assertInvalid(`${TENANT_A}0`);
  assertInvalid('a'.repeat(37));
  assertInvalid('a'.repeat(10_000));
});

test('parser: multiple header values (array) are rejected, even when identical', () => {
  assertInvalid([TENANT_A, TENANT_B]);
  assertInvalid([TENANT_A, TENANT_A]);
  assertInvalid([]);
});

test('parser: single-element array (headersDistinct) behaves like the string', () => {
  assert.deepEqual(parseTenantSelection([TENANT_A]), { kind: 'explicit', tenantId: TENANT_A });
  assertInvalid(['']);
  assertInvalid([` ${TENANT_A}`]);
  assertInvalid([undefined]);
});

test('parser: comma-separated / joined duplicate headers are rejected', () => {
  assertInvalid(`${TENANT_A}, ${TENANT_B}`); // Node joins duplicate headers with ", "
  assertInvalid(`${TENANT_A},${TENANT_B}`);
  assertInvalid(`${TENANT_A}, ${TENANT_A}`);
  assertInvalid(`${TENANT_A.slice(0, 17)},${TENANT_A.slice(18)}`); // 36 chars with comma
});

test('parser: non-string values are rejected', () => {
  for (const value of [0, 1, true, false, {}, { tenantId: TENANT_A }, Symbol('x'), 12n]) {
    assertInvalid(value);
  }
});

test('parser: error never carries the rejected value', () => {
  try {
    parseTenantSelection(`${TENANT_A},${FOREIGN_TENANT}`);
    assert.fail('expected throw');
  } catch (error) {
    assert.ok(!String(error.message).includes(TENANT_A));
    assert.ok(!JSON.stringify(error).includes(TENANT_A));
  }
});

test('parseCanonicalUuid: returns canonical lowercase or undefined', () => {
  assert.equal(parseCanonicalUuid(TENANT_A.toUpperCase()), TENANT_A);
  assert.equal(parseCanonicalUuid(` ${TENANT_A}`), undefined);
  assert.equal(parseCanonicalUuid(null), undefined);
});

/* ------------------------------ resolution -------------------------------- */

const one = [{ tenantId: TENANT_A, membershipId: MEMBERSHIP_A }];
const many = [
  { tenantId: TENANT_A, membershipId: MEMBERSHIP_A },
  { tenantId: TENANT_B, membershipId: MEMBERSHIP_B },
  { tenantId: TENANT_C, membershipId: MEMBERSHIP_C },
];

test('0 memberships + no selection -> ACTIVE_MEMBERSHIP_REQUIRED', () => {
  assertCode(() => selectTenantCandidate([], NO_TENANT_SELECTION), ActiveMembershipRequiredError, 'ACTIVE_MEMBERSHIP_REQUIRED');
});

test('0 memberships + explicit selection -> TENANT_ACCESS_DENIED (not ACTIVE_MEMBERSHIP_REQUIRED)', () => {
  assertCode(
    () => selectTenantCandidate([], parseTenantSelection(TENANT_A)),
    TenantAccessDeniedError,
    'TENANT_ACCESS_DENIED',
  );
});

test('1 membership + no selection -> auto-select', () => {
  assert.deepEqual(selectTenantCandidate(one, NO_TENANT_SELECTION), one[0]);
});

test('1 membership + matching selection -> selected (case-insensitive header)', () => {
  assert.deepEqual(selectTenantCandidate(one, parseTenantSelection(TENANT_A)), one[0]);
  assert.deepEqual(selectTenantCandidate(one, parseTenantSelection(TENANT_A.toUpperCase())), one[0]);
});

test('1 membership + forged selection -> TENANT_ACCESS_DENIED, never falls back to the only membership', () => {
  assertCode(
    () => selectTenantCandidate(one, parseTenantSelection(FOREIGN_TENANT)),
    TenantAccessDeniedError,
    'TENANT_ACCESS_DENIED',
  );
});

test('2+ memberships + no selection -> TENANT_SELECTION_REQUIRED', () => {
  assertCode(() => selectTenantCandidate(many.slice(0, 2), NO_TENANT_SELECTION), TenantSelectionRequiredError, 'TENANT_SELECTION_REQUIRED');
  assertCode(() => selectTenantCandidate(many, NO_TENANT_SELECTION), TenantSelectionRequiredError, 'TENANT_SELECTION_REQUIRED');
});

test('2+ memberships + matching selection -> exact match selected', () => {
  assert.deepEqual(selectTenantCandidate(many, parseTenantSelection(TENANT_B)), many[1]);
  assert.deepEqual(selectTenantCandidate(many, parseTenantSelection(TENANT_C)), many[2]);
  assert.deepEqual(selectTenantCandidate(many, parseTenantSelection(TENANT_A)), many[0]);
});

test('2+ memberships + unknown selection -> TENANT_ACCESS_DENIED, no fallback to first/any', () => {
  assertCode(
    () => selectTenantCandidate(many, parseTenantSelection(FOREIGN_TENANT)),
    TenantAccessDeniedError,
    'TENANT_ACCESS_DENIED',
  );
});

test('no enumeration: nonexistent, suspended, revoked and foreign tenants are indistinguishable', () => {
  // The DB layer only returns ACTIVE memberships of the caller, so every one of
  // these cases reaches the core as "not in the candidate list".
  const errors = [];
  for (const candidates of [[], one, many]) {
    try {
      selectTenantCandidate(candidates, parseTenantSelection(FOREIGN_TENANT));
    } catch (error) {
      errors.push({ name: error.name, code: error.code, message: error.message, keys: Object.keys(error).sort() });
    }
  }
  assert.equal(errors.length, 3);
  for (const error of errors) assert.deepEqual(error, errors[0]);
  assert.equal(errors[0].code, 'TENANT_ACCESS_DENIED');
});

test('selected candidate is a frozen canonical copy (mutating input afterwards has no effect)', () => {
  const input = [{ tenantId: TENANT_A.toUpperCase(), membershipId: MEMBERSHIP_A.toUpperCase() }];
  const selected = selectTenantCandidate(input, NO_TENANT_SELECTION);
  input[0].tenantId = FOREIGN_TENANT;
  assert.deepEqual(selected, { tenantId: TENANT_A, membershipId: MEMBERSHIP_A });
  assert.ok(Object.isFrozen(selected));
});

test('malformed DB candidates fail closed (invalid UUID, duplicate tenant)', () => {
  assertCode(
    () => selectTenantCandidate([{ tenantId: 'x', membershipId: MEMBERSHIP_A }], NO_TENANT_SELECTION),
    TenantCandidateInvalidError,
    'TENANT_CANDIDATE_INVALID',
  );
  assertCode(
    () => selectTenantCandidate([{ tenantId: TENANT_A, membershipId: null }], parseTenantSelection(TENANT_A)),
    TenantCandidateInvalidError,
    'TENANT_CANDIDATE_INVALID',
  );
  assertCode(
    () => selectTenantCandidate(
      [{ tenantId: TENANT_A, membershipId: MEMBERSHIP_A }, { tenantId: TENANT_A, membershipId: MEMBERSHIP_B }],
      parseTenantSelection(TENANT_A),
    ),
    TenantCandidateInvalidError,
    'TENANT_CANDIDATE_INVALID',
  );
});

test('hand-built selection objects are re-validated', () => {
  assertCode(() => selectTenantCandidate(one, { kind: 'explicit', tenantId: ` ${TENANT_A}` }), TenantSelectionInvalidError, 'TENANT_SELECTION_INVALID');
  assertCode(() => selectTenantCandidate(one, { kind: 'bogus' }), TenantSelectionInvalidError, 'TENANT_SELECTION_INVALID');
  assertCode(() => selectTenantCandidate(one, undefined), TenantSelectionInvalidError, 'TENANT_SELECTION_INVALID');
});
