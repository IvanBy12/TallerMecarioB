'use strict';

// A deliberately unsafe compiled-only mutation must be caught by the real
// in-process CRM privacy test. The source tree is never rewritten.
const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, ['scripts/test-crm-api.cjs'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 600_000,
  env: { ...process.env, S208_LOG_MUTATION: 'request-url', TEST_NAME_PATTERN: '^S2-08',
    NO_COLOR: '1', FORCE_COLOR: '0' },
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
const applied = output.includes('S208_LOG_MUTATION_APPLIED request-url');
const privacyFailed = /(?:✖|not ok) S2-08 request logging:/u.test(output);
const invalid = output.includes('MUTATION_ANCHOR_NOT_FOUND') || output.includes('UNKNOWN_MUTATION');
const verdict = applied && privacyFailed && !invalid && result.status !== 0 ? 'KILLED' : 'INVALID';
process.stdout.write(`MUTANT request-url: ${verdict}\n`);
if (verdict === 'KILLED') process.stdout.write('S208_LOG_MUTATION_PASS 1/1 killed\n');
else process.exitCode = 1;
