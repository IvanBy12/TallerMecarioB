'use strict';

/**
 * S1-07 mutation run: executes the audit suite once per mutant
 * (scripts/audit-mutations.cjs) and requires every run to FAIL with at least
 * one failing assertion. A surviving mutant fails this script. Local database
 * only (same guards as scripts/test-audit.cjs).
 */

const { spawnSync } = require('node:child_process');
const { MUTATIONS } = require('./audit-mutations.cjs');

const names = process.env.S107_MUTATIONS ? process.env.S107_MUTATIONS.split(',') : Object.keys(MUTATIONS);
const results = [];

for (const name of names) {
  const run = spawnSync(process.execPath, ['scripts/test-audit.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, S107_MUTATION: name, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 900_000,
  });
  // Strip ANSI colors in case the reporter still emits them.
  // eslint-disable-next-line no-control-regex
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
  const applied = output.includes(`S107_MUTATION_APPLIED ${name}`);
  const anchorBroken = output.includes('MUTATION_ANCHOR_NOT_FOUND') || output.includes('UNKNOWN_MUTATION');
  // spec reporter: "✖ <name> (12.3ms)"; the trailing summary repeats them.
  const failedTests = [...new Set((output.match(/^\s*✖ .* \([\d.]+m?s\)$/gmu) ?? [])
    .map((line) => line.trim().replace(/^✖ /u, '').replace(/ \([\d.]+m?s\)$/u, '')))];
  let verdict;
  if (!applied || anchorBroken) verdict = 'INVALID';
  else if (run.status === 0) verdict = 'SURVIVED';
  // A crash with no failing assertion is not a kill: the suite must say why.
  else if (failedTests.length === 0) verdict = 'INVALID';
  else verdict = 'KILLED';
  results.push({ name, verdict, failedTests });
  process.stdout.write(`MUTANT ${name}: ${verdict}${failedTests.length ? ` (${failedTests.length} failing: ${failedTests.slice(0, 3).join(' | ')})` : ''}\n`);
}

const bad = results.filter((result) => result.verdict !== 'KILLED');
if (bad.length > 0) {
  process.stderr.write(`MUTATION_RUN_FAILED ${bad.map((result) => `${result.name}=${result.verdict}`).join(',')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`MUTATION_RUN_PASS ${results.length}/${results.length} killed\n`);
}
