'use strict';

/** Each mutant runs in a fresh migrated local database and temporary JS build. */
const { spawnSync } = require('node:child_process');
const { MUTATIONS } = require('./cross-tenant-mutations.cjs');

const names = process.env.S108_MUTATIONS ? process.env.S108_MUTATIONS.split(',') : Object.keys(MUTATIONS);
const results = [];
for (const name of names) {
  const run = spawnSync(process.execPath, ['scripts/test-cross-tenant-final.cjs'], {
    cwd: process.cwd(), env: { ...process.env, S108_MUTATION: name, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8', timeout: 900_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
  const applied = output.includes(`S108_MUTATION_APPLIED ${name}`);
  const invalid = output.includes('MUTATION_ANCHOR_NOT_FOUND') || output.includes('UNKNOWN_MUTATION');
  const failedTests = [...new Set((output.match(/^\s*✖ .* \([\d.]+m?s\)$/gmu) ?? [])
    .map((line) => line.trim().replace(/^✖ /u, '').replace(/ \([\d.]+m?s\)$/u, '')))];
  const verdict = !applied || invalid || failedTests.length === 0 ? 'INVALID'
    : run.status === 0 ? 'SURVIVED' : 'KILLED';
  results.push({ name, verdict });
  process.stdout.write(`MUTANT ${name}: ${verdict}${failedTests.length ? ` (${failedTests.slice(0, 3).join(' | ')})` : ''}\n`);
}
const bad = results.filter((r) => r.verdict !== 'KILLED');
if (bad.length) {
  process.stderr.write(`MUTATION_RUN_FAILED ${bad.map((r) => `${r.name}=${r.verdict}`).join(',')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`MUTATION_RUN_PASS ${results.length}/${results.length} killed\n`);
