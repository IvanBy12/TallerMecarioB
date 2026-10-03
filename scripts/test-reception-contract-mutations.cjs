'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { MUTATION_NAMES: cases } = require('./reception-contract-mutations.cjs');
const MUTATION_KEYS = ['S305_MUTATION', 'S306_MUTATION', 'S307_MUTATION', 'S3C_MUTATION'];
const suiteEnv = (mutation) => {
  const env = { ...process.env, TEST_SUITE_DIR: 'reception-api', TEST_FILE_FILTER: 'contract.test.cjs' };
  for (const key of Object.keys(env)) {
    if (MUTATION_KEYS.includes(key) || /^(?:S\d.*MUTATION|TEST_NAME_PATTERN)$/u.test(key)) delete env[key];
  }
  return mutation ? { ...env, S3C_MUTATION: mutation } : env;
};
const run = (mutation) => {
  const result = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    maxBuffer: 10_000_000, env: suiteEnv(mutation),
  });
  if (result.error) throw result.error;
  return result;
};
// A control run distinguishes ordinary suite failures from mutation kills.
const normal = run();
assert.equal(normal.status, 0, `S3C normal suite failed\n${normal.stdout.slice(-3500)}\n${normal.stderr.slice(-1000)}`);
assert.match(normal.stdout, /(?:#|ℹ) fail 0\b/u);
assert.match(normal.stdout, /CRM_API_FIXTURE_CLEANUP_PASS/u);
for (const label of ['cancelled', 'skipped', 'todo'])
  assert.match(normal.stdout, new RegExp(`(?:#|ℹ) ${label} 0\\b`, 'u'));
process.stdout.write('S3C_NORMAL_BASELINE_PASS normal_failures=0\n');
for (const name of cases) {
  const result = run(name);
  assert.match(result.stdout, new RegExp(`S3C_MUTATION_APPLIED ${name}`));
  assert.match(result.stdout, /CRM_API_FIXTURE_CLEANUP_PASS/u, `${name}: fixture cleanup unverified`);
  const counts = result.stdout.match(/(?:#|ℹ) fail (\d+)/u);
  assert.notEqual(result.status, 0, `${name}: mutant survived`);
  assert.ok(counts && Number(counts[1]) > 0,
    `${name}: no behavioral test killed mutant\n${result.stdout.slice(-3500)}\n${result.stderr.slice(-1000)}`);
  process.stdout.write(`S3C_MUTANT_${name.toUpperCase()}_KILLED fail=${counts[1]}\n`);
}
process.stdout.write(`S3C_MUTATION_COUNTS killed=${cases.length} survived=0 normal_failures=0 invalid_apply_failures=0\n`);
