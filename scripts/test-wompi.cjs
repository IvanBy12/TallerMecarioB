'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const sandbox = process.argv.includes('--sandbox');
if (sandbox) {
  const required = [
    'WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET',
  ];
  const credentialsReady = process.env.WOMPI_ENABLED?.toLowerCase() === 'true'
    && required.every((name) => Boolean(process.env[name]));
  if (!credentialsReady) {
    process.stderr.write(`WOMPI_SANDBOX=BLOCKED_CREDENTIALS required=${required.join(',')}\n`);
    process.exit(2);
  }
}

function run(args, env, timeout = 60_000) {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env, stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

const compiledRoot = mkdtempSync(join(tmpdir(), 'tallermecario-wompi-test-'));
try {
  run([
    resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false',
    '--rootDir', 'src', '--outDir', compiledRoot,
  ], process.env);
  const testFile = sandbox
    ? 'tests/wompi/sandbox.test.cjs'
    : 'tests/wompi/wompi.test.cjs';
  run(['--test', '--test-concurrency=1', '--test-timeout=30000', testFile], {
    ...process.env,
    TEST_WOMPI_MODULE_ROOT: compiledRoot,
    NODE_PATH: resolve('node_modules'),
  }, sandbox ? 120_000 : 60_000);
} finally {
  if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-wompi-test-'))) {
    rmSync(compiledRoot, { recursive: true, force: true });
  }
}
