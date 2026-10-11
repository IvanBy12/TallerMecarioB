'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { CASES } = require('./media-assignment-mutations.cjs');

function childEnvironment(environment = process.env) {
  const env = { ...environment, TEST_FILE_FILTER: 'assigned-authorization.test.cjs' };
  delete env.S4B07_MUTATION;
  delete env.TEST_NAME_PATTERN;
  // Pin only this runner's child tree to TAP: CI's ambient spec reporter stays
  // unchanged for other runners. TAP includes structured assertion diagnostics,
  // which let us prove the intended failure instead of counting arbitrary exits.
  env.NODE_OPTIONS = '--test-reporter=tap';
  env.NO_COLOR = '1';
  delete env.FORCE_COLOR;
  return env;
}

function summary(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)\\r?$`, 'gmu'))];
    assert.equal(matches.length, 1, `missing or ambiguous test summary: ${key}`);
    counts[key] = Number(matches[0][1]);
  }
  assert.ok(counts.tests > 0, 'no tests executed');
  assert.equal(counts.cancelled + counts.skipped + counts.todo, 0, 'incomplete test run');
  assert.equal(counts.tests, counts.pass + counts.fail, 'inconsistent test summary');
  return counts;
}

function validate(result, name) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'test process terminated by signal');
  assert.match(result.stdout, /^CLEAN_MIGRATION_PASS$/mu, 'clean migration must pass');
  assert.match(result.stdout, /^CRM_API_FIXTURE_CLEANUP_PASS$/mu, 'fixture cleanup must pass');
  const counts = summary(result.stdout);
  if (!name) {
    assert.equal(result.status, 0, 'control test process failed');
    assert.equal(result.stderr.trim(), '', 'control infrastructure failed');
    assert.equal(counts.fail, 0, 'control tests failed');
    return counts;
  }

  assert.ok(Object.hasOwn(CASES, name), 'unknown mutant');
  assert.match(result.stdout, new RegExp(`^S4B07_MUTATION_APPLIED ${name}$`, 'mu'));
  assert.equal(result.status, 1, `${name}: mutant survived or process failed unexpectedly`);
  assert.equal(result.stderr.trim(), 'CRM_API_TEST_RUN_FAILED', `${name}: infrastructure failed`);
  const failures = [...result.stdout.matchAll(/^not ok \d+ - ([^\r\n]+)\r?\n  ---\r?\n([\s\S]*?)^  \.\.\.\r?$/gmu)];
  assert.equal(failures.length, name === 'omit_tripwire_mark' ? 2 : 1, `${name}: unexpected failing tests`);
  assert.equal(counts.fail, failures.length, `${name}: unaccounted test failures`);
  assert.equal(counts.pass, 0, `${name}: expected mutation was not detected by every selected test`);
  for (const [, title, diagnostic] of failures) {
    assert.match(title, new RegExp(CASES[name].pattern, 'u'), `${name}: unrelated test failed`);
    assert.match(diagnostic, /^  failureType: 'testCodeFailure'$/mu);
    assert.match(diagnostic, /assigned-authorization\.test\.cjs/u);
    if (name === 'omit_assignment_lock') {
      // This test's explicit pg_blocking_pids barrier proves the assignment row
      // lock; dropping FOR SHARE must fail that barrier, never a query/DB error.
      assert.match(diagnostic, /^  error: 'PostgreSQL barrier timeout'$/mu);
      assert.match(diagnostic, /^    until \(/mu);
      assert.match(diagnostic, /^  code: 'ERR_TEST_FAILURE'$/mu);
    } else {
      assert.match(diagnostic, /^  code: 'ERR_ASSERTION'$/mu);
      assert.match(diagnostic, /^  operator: 'strictEqual'$/mu);
      const tripwire = name === 'omit_tripwire_mark';
      assert.match(diagnostic, new RegExp(`^  expected: ${tripwire ? 200 : 404}$`, 'mu'));
      assert.match(diagnostic, new RegExp(`^  actual: ${tripwire ? 500 : 200}$`, 'mu'));
    }
  }
  return counts;
}

function main() {
  const env = childEnvironment();
  function run(extra = {}) {
    const result = spawnSync(process.execPath, ['scripts/test-media-integrity-api.cjs'], {
      cwd: process.cwd(), env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, maxBuffer: 10000000,
    });
    try { return validate(result, extra.S4B07_MUTATION); }
    catch (error) {
      // Keep the original harness diagnostics when an INVALID/surviving mutant
      // or a failing control stops the gate; do not print the child environment.
      process.stderr.write(`${result.stdout?.slice(-3500) ?? ''}\n${result.stderr?.slice(-1000) ?? ''}\n`);
      throw error;
    }
  }
  run();
  process.stdout.write('S4B07_NORMAL_BASELINE_PASS normal_failures=0\n');
  for (const [name, change] of Object.entries(CASES)) {
    const counts = run({ S4B07_MUTATION: name, TEST_NAME_PATTERN: change.pattern });
    process.stdout.write(`S4B07_MUTANT_KILLED ${name} failures=${counts.fail}\n`);
  }
  process.stdout.write(`S4B07_MUTATION_COUNTS killed=${Object.keys(CASES).length} survived=0 normal_failures=0 invalid_apply_failures=0\n`);
}

if (require.main === module) main();
module.exports = { childEnvironment, summary, validate, main };
