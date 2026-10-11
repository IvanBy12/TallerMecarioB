'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { childEnvironment, validate } = require('../../scripts/test-media-assignment-mutations.cjs');
const { CASES } = require('../../scripts/media-assignment-mutations.cjs');

function counts(fail = 0, pass = 1, reporter = '#') {
  return ['tests ' + (pass + fail), 'pass ' + pass, 'fail ' + fail,
    'cancelled 0', 'skipped 0', 'todo 0'].map(line => `${reporter} ${line}\n`).join('');
}
function control(reporter = '#') {
  return { status: 0, signal: null, stdout: 'CLEAN_MIGRATION_PASS\n' + counts(0, 45, reporter)
    + 'CRM_API_FIXTURE_CLEANUP_PASS\n', stderr: '' };
}
function mutant(name) {
  const tripwire = name === 'omit_tripwire_mark', lock = name === 'omit_assignment_lock';
  const n = tripwire ? 2 : 1;
  const diagnostic = "  failureType: 'testCodeFailure'\n"
    + (lock ? "  error: 'PostgreSQL barrier timeout'\n  code: 'ERR_TEST_FAILURE'\n"
      : `  code: 'ERR_ASSERTION'\n  expected: ${tripwire ? 200 : 404}\n  actual: ${tripwire ? 500 : 200}\n  operator: 'strictEqual'\n`)
    + '  stack: |-\n' + (lock ? '    until (assigned-authorization.test.cjs:183:9)\n'
      : '    error (assigned-authorization.test.cjs:52:38)\n');
  return { status: 1, signal: null, stderr: 'CRM_API_TEST_RUN_FAILED\n',
    stdout: `CLEAN_MIGRATION_PASS\nS4B07_MUTATION_APPLIED ${name}\n`
      + Array.from({ length: n }, (_, i) => `not ok ${i + 1} - ${CASES[name].pattern} fixture ${i}\n  ---\n${diagnostic}  ...\n`).join('')
      + counts(n, 0) + 'CRM_API_FIXTURE_CLEANUP_PASS\n' };
}
for (const reporter of ['#', 'ℹ']) {
  test(`${reporter}: successful control summary accepted`, () => assert.equal(validate(control(reporter)).fail, 0));
  test(`${reporter}: child reporter explicitly pinned regardless of ambient setting`, () => {
    const environment = { NODE_OPTIONS: reporter === '#' ? '' : '--test-reporter=spec',
      S4B07_MUTATION: 'accept_qc', TEST_NAME_PATTERN: 'unrelated', FORCE_COLOR: '1', DATABASE_URL: 'fixture' };
    const child = childEnvironment(environment);
    assert.equal(child.NODE_OPTIONS, '--test-reporter=tap');
    assert.equal(child.TEST_FILE_FILTER, 'assigned-authorization.test.cjs');
    assert.equal(child.DATABASE_URL, 'fixture');
    for (const key of ['S4B07_MUTATION', 'TEST_NAME_PATTERN', 'FORCE_COLOR']) assert.equal(child[key], undefined);
    assert.equal(environment.NODE_OPTIONS, reporter === '#' ? '' : '--test-reporter=spec');
  });
  for (const [name, change] of Object.entries({
    'nonzero process exit with passing summary': r => { r.status = 1; },
    'failed control with zero exit': r => { r.stdout = r.stdout.replace(`${reporter} pass 45`, `${reporter} pass 44`).replace(`${reporter} fail 0`, `${reporter} fail 1`); },
    'missing summary': r => { r.stdout = 'CLEAN_MIGRATION_PASS\nCRM_API_FIXTURE_CLEANUP_PASS\n'; },
    'no executed tests': r => { r.stdout = 'CLEAN_MIGRATION_PASS\n' + counts(0, 0, reporter) + 'CRM_API_FIXTURE_CLEANUP_PASS\n'; },
    'cancelled test': r => { r.stdout = r.stdout.replace(`${reporter} cancelled 0`, `${reporter} cancelled 1`); },
    'ambiguous summary': r => { r.stdout += `${reporter} fail 0\n`; },
    'inconsistent summary': r => { r.stdout = r.stdout.replace(`${reporter} tests 45`, `${reporter} tests 46`); },
    'cleanup failure': r => { r.stdout = r.stdout.replace('CRM_API_FIXTURE_CLEANUP_PASS', ''); },
    'infrastructure stderr': r => { r.stderr = 'DATABASE_CONNECTION_FAILED'; },
    'signal termination': r => { r.status = null; r.signal = 'SIGTERM'; },
    'spawn timeout': r => { r.error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  })) test(`${reporter}: reject ${name}`, () => {
    const result = control(reporter); change(result); assert.throws(() => validate(result));
  });
}
for (const name of Object.keys(CASES)) {
  test(`${name}: only intended behavioral diagnostic is accepted`, () => assert.ok(validate(mutant(name), name).fail > 0));
}
for (const [name, change] of Object.entries({
  'surviving mutant': r => { r.status = 0; },
  'unexpected exit code': r => { r.status = 7; },
  'missing application proof': r => { r.stdout = r.stdout.replace('S4B07_MUTATION_APPLIED accept_released', ''); },
  'anchor failure': r => { r.stderr = 'MUTATION_ANCHOR_NOT_FOUND accept_released'; },
  'cleanup failure after intended assertion': r => { r.stdout = r.stdout.replace('CRM_API_FIXTURE_CLEANUP_PASS', ''); },
  'infrastructure failure after intended assertion': r => { r.stderr += 'DATABASE_CONNECTION_FAILED\n'; },
  'missing migration proof': r => { r.stdout = r.stdout.replace('CLEAN_MIGRATION_PASS', ''); },
  'unrelated test': r => { r.stdout = r.stdout.replace('released: 404', 'unrelated infrastructure test'); },
  'non-assertion failure': r => { r.stdout = r.stdout.replace('ERR_ASSERTION', 'ECONNREFUSED'); },
  'hook failure': r => { r.stdout = r.stdout.replace('testCodeFailure', 'hookFailed'); },
  'unrelated assertion': r => { r.stdout = r.stdout.replace('expected: 404', 'expected: 201'); },
  'file-level crash': r => { r.stdout = r.stdout.replace('assigned-authorization.test.cjs', 'unrelated.test.cjs'); },
  'unaccounted failure': r => { r.stdout = r.stdout.replace('# fail 1', '# fail 2').replace('# tests 1', '# tests 2'); },
  'no recognizable summary': r => { r.stdout = r.stdout.replace(/^# .*\n/gmu, ''); },
})) test(`mutant: reject ${name}`, () => {
  const result = mutant('accept_released'); change(result); assert.throws(() => validate(result, 'accept_released'));
});
test('lock mutant: query/infrastructure error cannot count as barrier detection', () => {
  const result = mutant('omit_assignment_lock');
  result.stdout = result.stdout.replace("  error: 'PostgreSQL barrier timeout'", "  error: 'connection closed'\n  code: 'ECONNRESET'");
  assert.throws(() => validate(result, 'omit_assignment_lock'));
});
