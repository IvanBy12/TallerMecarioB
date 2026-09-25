'use strict';

/**
 * Runs the pure S1-02 tenant-context core suite: X-Tenant-Id parsing,
 * membership selection, permission grant map, authorization decisions and the
 * resource-authorization tripwire. No PostgreSQL, no Fastify.
 */

const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

function run(args, env, timeout = 60_000) {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env, stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

const compiledRoot = mkdtempSync(join(tmpdir(), 'tallermecario-tenant-context-test-'));
try {
  run([
    resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false',
    '--rootDir', 'src', '--outDir', compiledRoot,
  ], process.env);

  run(
    [
      '--test', '--test-concurrency=1', '--test-timeout=30000',
      'tests/tenancy/tenant-selection.test.cjs',
      'tests/authz/authorization-core.test.cjs',
      'tests/authz/resource-authorization.test.cjs',
    ],
    { ...process.env, TEST_AUTHZ_MODULE_ROOT: compiledRoot, NODE_PATH: resolve('node_modules') },
  );
} finally {
  if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-tenant-context-test-'))) {
    rmSync(compiledRoot, { recursive: true, force: true });
  }
}
