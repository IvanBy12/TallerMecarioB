'use strict';

/**
 * Runs the non-DB authz test suite: RBAC matrix <-> migration parity, matrix
 * totals, and the pure permission-scope combination model. No PostgreSQL
 * connection is used here; see scripts/test-authz-db.cjs for the DB <->
 * matrix parity check against a real database.
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

const compiledRoot = mkdtempSync(join(tmpdir(), 'tallermecario-authz-test-'));
try {
  run([
    resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false',
    '--rootDir', 'src', '--outDir', compiledRoot,
  ], process.env);

  run(
    [
      '--test', '--test-concurrency=1', '--test-timeout=30000',
      'tests/authz/permission-grants.test.cjs',
      'tests/authz/rbac-matrix.test.cjs',
      'tests/authz/rbac-seed-parity.test.cjs',
    ],
    { ...process.env, TEST_AUTHZ_MODULE_ROOT: compiledRoot, NODE_PATH: resolve('node_modules') },
  );
} finally {
  if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-authz-test-'))) {
    rmSync(compiledRoot, { recursive: true, force: true });
  }
}
