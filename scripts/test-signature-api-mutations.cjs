'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { MUTANTS } = require('./signature-api-mutations.cjs');

for (const name of Object.keys(MUTANTS)) {
  const result = spawnSync(process.execPath, ['scripts/test-reception-api.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, S305_MUTATION: name, TEST_FILE_FILTER: 'signature.test.cjs' },
    encoding: 'utf8', stdio: 'pipe', timeout: 120_000, maxBuffer: 10_000_000,
  });
  if (result.error) throw result.error;
  assert.match(result.stdout, new RegExp(`S305_MUTATION_APPLIED ${name}`));
  const match = result.stdout.match(/(?:#|ℹ) fail (\d+)/u);
  assert.notEqual(result.status, 0, `${name}: mutant survived`);
  assert.ok(match && Number(match[1]) > 0,
    `${name}: normal test assertion did not kill mutant\n${result.stdout.slice(-2500)}\n${result.stderr}`);
  process.stdout.write(`SIGNATURE_MUTANT_${name.toUpperCase()}_KILLED fail=${match[1]}\n`);
}
process.stdout.write(`SIGNATURE_MUTATION_COUNTS killed=${Object.keys(MUTANTS).length} survived=0 invalid_apply_failures=0\n`);
