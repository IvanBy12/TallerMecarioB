'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { MUTATION_NAMES: cases } = require('./reception-queries-mutations.cjs');
// A control run distinguishes ordinary suite failures from mutation kills.
const normalEnv = { ...process.env, TEST_SUITE_DIR: 'reception-api', TEST_FILE_FILTER: 'queries.test.cjs' };
for (const key of ['S305_MUTATION', 'S306_MUTATION', 'S307_MUTATION']) delete normalEnv[key];
const normal = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
  cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
  maxBuffer: 10_000_000, env: normalEnv,
});
if (normal.error) throw normal.error;
assert.equal(normal.status, 0, `S307 normal suite failed\n${normal.stdout.slice(-3500)}\n${normal.stderr.slice(-1000)}`);
assert.match(normal.stdout, /(?:#|ℹ) fail 0\b/u);
process.stdout.write('S307_NORMAL_BASELINE_PASS normal_failures=0\n');
for (const name of cases) {
  const result = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    maxBuffer: 10_000_000,
    env: { ...process.env, TEST_SUITE_DIR: 'reception-api',
      TEST_FILE_FILTER: 'queries.test.cjs', S307_MUTATION: name },
  });
  if (result.error) throw result.error;
  assert.match(result.stdout, new RegExp(`S307_MUTATION_APPLIED ${name}`));
  const counts = result.stdout.match(/(?:#|ℹ) fail (\d+)/u);
  assert.notEqual(result.status, 0, `${name}: mutant survived`);
  assert.ok(counts && Number(counts[1]) > 0,
    `${name}: no behavioral test killed mutant\n${result.stdout.slice(-3500)}\n${result.stderr.slice(-1000)}`);
  process.stdout.write(`S307_MUTANT_${name.toUpperCase()}_KILLED fail=${counts[1]}\n`);
}
process.stdout.write(`S307_MUTATION_COUNTS killed=${cases.length} survived=0 normal_failures=0 invalid_apply_failures=0\n`);
