'use strict';

const { spawnSync } = require('node:child_process');
const { MUTATIONS } = require('./vehicle-api-mutations.cjs');
const names = process.env.S205_MUTATIONS ? process.env.S205_MUTATIONS.split(',') : Object.keys(MUTATIONS);
let killed = 0;
for (const name of names) {
  const result = spawnSync(process.execPath, ['scripts/test-crm-api.cjs'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 600_000,
    env: { ...process.env, S205_MUTATION: name, TEST_NAME_PATTERN: '^S2-05',
      NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
  const applied = output.includes(`S205_MUTATION_APPLIED ${name}`);
  const failures = (output.match(/^✖ S2-05 .* \([\d.]+m?s\)$/gmu) ?? []).length;
  const invalid = output.includes('MUTATION_ANCHOR_NOT_FOUND') || output.includes('UNKNOWN_MUTATION');
  const verdict = !applied || invalid ? 'INVALID' : result.status === 0 ? 'SURVIVED'
    : failures === 0 ? 'INVALID' : 'KILLED';
  process.stdout.write(`MUTANT ${name}: ${verdict} (${failures} failing tests)\n`);
  if (verdict === 'KILLED') killed++;
  else process.exitCode = 1;
}
if (killed === names.length) process.stdout.write(`S205_MUTATION_PASS ${killed}/${names.length} killed\n`);
