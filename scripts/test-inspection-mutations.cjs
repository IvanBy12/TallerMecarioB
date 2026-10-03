'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cases } = require('./inspection-mutations.cjs');
function run(mutation) {
  const result = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 120000, maxBuffer: 10000000,
    env: { ...process.env, TEST_SUITE_DIR: 'reception-api', TEST_FILE_FILTER: 'inspection.test.cjs',
      S3I_MUTATION: mutation },
  });
  if (result.error) throw result.error;
  assert.match(result.stdout, /CRM_API_FIXTURE_CLEANUP_PASS/u);
  return result;
}
const baseline = run('');
assert.equal(baseline.status, 0, baseline.stdout.slice(-4000) + baseline.stderr);
assert.match(baseline.stdout, /(?:#|ℹ) fail 0\b/u);
process.stdout.write('S3I_NORMAL_BASELINE_PASS\n');
for (const [name] of cases) {
  const result = run(name);
  assert.match(result.stdout, new RegExp('S3I_MUTATION_APPLIED ' + name));
  const counts = result.stdout.match(/(?:#|ℹ) fail (\d+)/u);
  assert.notEqual(result.status, 0, name + ': survived');
  assert.ok(counts && Number(counts[1]) > 0, name + ': no behavioral kill\n' + result.stdout.slice(-3000) + result.stderr);
  process.stdout.write('S3I_MUTANT_' + name.toUpperCase() + '_KILLED\n');
}
process.stdout.write('S3I_MUTATION_COUNTS killed=' + cases.length + ' survived=0 invalid_apply_failures=0\n');
