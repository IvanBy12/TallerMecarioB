'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// Exercise runner error precedence without creating another database: failed
// assertions must never hide failed cleanup or claim that cleanup succeeded.
async function simulate(testStatus, cleanupComplete) {
  let stdout = '', stderr = '', exitCode = 0, connections = 0;
  const output = { env: { PGHOST: 'localhost', PGDATABASE: 'fixture', PGUSER: 'fixture',
    TEST_SUITE_DIR: 'reception-api' }, execPath: process.execPath, cwd: () => process.cwd(),
  stdout: { write: (text) => { stdout += text; } },
  stderr: { write: (text) => { stderr += text; } } };
  Object.defineProperty(output, 'exitCode', { set: (value) => { exitCode = value; } });
  function postgres() {
    const admin = connections++ > 0;
    const sql = async (parts) => {
      const query = parts.join('');
      if (admin && query.includes('drizzle.__drizzle_migrations')) return [{ count: 24 }];
      if (query.includes('current_database()')) return [{ database: 'fixture' }];
      if (query.includes('database_present')) return [{ database_present: !cleanupComplete,
        login_present: !cleanupComplete }];
      return [];
    };
    sql.unsafe = async () => [];
    sql.end = async () => {};
    return sql;
  }
  const modules = {
    postgres,
    'node:child_process': { spawnSync: (_exe, args) => ({ status: args.includes('--test') ? testStatus : 0 }) },
    'node:fs': { mkdtempSync: () => join(tmpdir(), 'tallermecario-crm-api-test-fixture'),
      readdirSync: () => ['fixture.test.cjs'], rmSync: () => {} },
    './migration-count.cjs': { expectedMigrationCount: () => 24 },
  };
  const source = readFileSync('scripts/test-crm-api.cjs', 'utf8')
    .replace('main().catch((error) => {', 'return main().catch((error) => {');
  const requireFixture = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    if (name.endsWith('-mutations.cjs')) return new Proxy({}, { get: () => async () => {} });
    return require(name);
  };
  const run = vm.compileFunction(source, ['require', 'process'], { filename: 'fixture-cleanup-simulation.cjs' });
  await run(requireFixture, output);
  return { stdout, stderr, exitCode };
}

for (const testStatus of [0, 1]) {
  for (const cleanupComplete of [true, false]) {
    test(`API fixture testExit=${testStatus} cleanup=${cleanupComplete}`, async () => {
      const result = await simulate(testStatus, cleanupComplete);
      assert.equal(result.exitCode, testStatus === 0 && cleanupComplete ? 0 : 1);
      assert.equal(result.stdout.includes('CRM_API_FIXTURE_CLEANUP_PASS'), cleanupComplete);
      if (!cleanupComplete) assert.match(result.stderr, /TEST_DATABASE_CLEANUP_FAILED/u);
      else if (testStatus !== 0) assert.match(result.stderr, /CRM_API_TEST_RUN_FAILED/u);
    });
  }
}
