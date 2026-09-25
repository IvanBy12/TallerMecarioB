'use strict';

/**
 * S1-06 mutation run: executes the member-lifecycle suite once per mutant
 * (scripts/member-lifecycle-mutations.cjs) and requires every run to FAIL.
 * A surviving mutant fails this script. Local database only (same guards as
 * scripts/test-member-lifecycle.cjs).
 */

const { spawnSync } = require('node:child_process');
const { MUTATIONS } = require('./member-lifecycle-mutations.cjs');

const names = process.env.S106_MUTATIONS ? process.env.S106_MUTATIONS.split(',') : Object.keys(MUTATIONS);
const results = [];

for (const name of names) {
  const run = spawnSync(process.execPath, ['scripts/test-member-lifecycle.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, S106_MUTATION: name, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 600_000,
  });
  // Strip ANSI colors in case the reporter still emits them.
  // eslint-disable-next-line no-control-regex
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
  const applied = output.includes(`S106_MUTATION_APPLIED ${name}`);
  const anchorBroken = output.includes('MUTATION_ANCHOR_NOT_FOUND') || output.includes('UNKNOWN_MUTATION');
  // spec reporter: "✖ <name> (12.3ms)"; the trailing summary repeats them.
  const failedTests = [...new Set((output.match(/^✖ .* \([\d.]+m?s\)$/gmu) ?? [])
    .map((line) => line.replace(/^✖ /u, '').replace(/ \([\d.]+m?s\)$/u, '')))];
  let verdict;
  if (!applied || anchorBroken) verdict = 'INVALID';
  else if (run.status === 0) verdict = 'SURVIVED';
  // A crash with no failing assertion is not a kill: the suite must say why.
  else if (failedTests.length === 0) verdict = 'INVALID';
  else verdict = 'KILLED';
  results.push({ name, verdict, failedTests: failedTests.slice(0, 4) });
  process.stdout.write(`MUTANT ${name}: ${verdict}${failedTests.length ? ` (${failedTests.length} failing: ${failedTests.slice(0, 2).join(' | ')})` : ''}\n`);
}

const bad = results.filter((result) => result.verdict !== 'KILLED');
if (bad.length > 0) {
  process.stderr.write(`MUTATION_RUN_FAILED ${bad.map((result) => `${result.name}=${result.verdict}`).join(',')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`MUTATION_RUN_PASS ${results.length}/${results.length} killed\n`);
}
