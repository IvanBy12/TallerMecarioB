'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { MUTATION_NAMES: cases } = require('./close-api-mutations.cjs');
for (const name of cases) {
  const result = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    maxBuffer: 10_000_000,
    env: { ...process.env, TEST_SUITE_DIR: 'reception-api',
      TEST_FILE_FILTER: 'close.test.cjs', S306_MUTATION: name },
  });
  if (result.error) throw result.error;
  assert.match(result.stdout, new RegExp(`S306_MUTATION_APPLIED ${name}`));
  const counts = result.stdout.match(/(?:#|ℹ) fail (\d+)/u);
  assert.notEqual(result.status, 0, `${name}: mutant survived`);
  assert.ok(counts && Number(counts[1]) > 0,
    `${name}: no behavioral test killed mutant\n${result.stdout.slice(-3500)}\n${result.stderr.slice(-1000)}`);
  process.stdout.write(`S306_MUTANT_${name.toUpperCase()}_KILLED fail=${counts[1]}\n`);
}
process.stdout.write(`S306_MUTATION_COUNTS killed=${cases.length} survived=0 normal_failures=0\n`);
