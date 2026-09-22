'use strict';

// Sprint 0: health/readiness, CORS, rate limiting and security headers.
// Same disposable-database pattern as scripts/test-api-multitenant.cjs.

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const postgres = require('postgres');

const CANONICAL_ROLES = [
  'tallermecario_schema_owner',
  'tallermecario_migrator',
  'tallermecario_api',
  'tallermecario_worker',
  'tallermecario_bootstrap_resolver',
];

function databaseUrlFromEnvironment() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);

  const candidates = [
    ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
    ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
  ];
  for (const [hostKey, portKey, databaseKey, userKey, passwordKey] of candidates) {
    if (process.env[hostKey] && process.env[databaseKey] && process.env[userKey]) {
      const url = new URL('postgresql://localhost');
      url.hostname = process.env[hostKey];
      url.port = process.env[portKey] || '5432';
      url.pathname = `/${encodeURIComponent(process.env[databaseKey])}`;
      url.username = process.env[userKey];
      url.password = process.env[passwordKey] || '';
      return url;
    }
  }
  throw new Error('DATABASE_CONFIGURATION_REQUIRED');
}

function assertLocal(url) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('REFUSING_NON_LOCAL_DATABASE');
  }
}

function runChild(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const databaseName = `tallermecario_security_e2e_${suffix}`;
  const loginRole = `tm_security_e2e_${suffix}`;
  const loginPassword = `rt_${randomUUID()}`;
  const testUrl = new URL(sourceUrl.toString());
  testUrl.pathname = `/${databaseName}`;

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let testAdmin;
  let databaseCreated = false;
  let loginCreated = false;
  let testPassed = false;
  let cleanupPassed = false;
  let originalRoles = new Set();
  const compiledRoot = mkdtempSync(join(tmpdir(), 'tallermecario-security-test-'));

  try {
    const [server] = await maintenance`SELECT pg_catalog.current_database() AS database`;
    if (!server) throw new Error('DATABASE_CONNECTION_FAILED');
    process.stdout.write('DB_ENV_CONNECTED\n');

    const existingRoles = await maintenance`
      SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
    `;
    originalRoles = new Set(existingRoles.map((row) => row.rolname));

    await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    testAdmin = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

    runChild(['scripts/migrate.cjs'], { ...process.env, DATABASE_URL: testUrl.toString() });
    const [migrationState] = await testAdmin`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    if (migrationState.count !== 4) throw new Error('CLEAN_MIGRATION_INVALID');
    process.stdout.write('CLEAN_MIGRATION_PASS\n');

    await testAdmin.unsafe(
      `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`,
    );
    loginCreated = true;
    await testAdmin.unsafe(`GRANT tallermecario_api TO ${loginRole}`);

    runChild(
      [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        'tsconfig.json',
        '--noEmit',
        'false',
        '--rootDir',
        'src',
        '--outDir',
        compiledRoot,
      ],
      process.env,
    );

    runChild(
      ['--test', '--test-concurrency=1', '--test-timeout=30000', 'tests/api/security.test.cjs'],
      {
        ...process.env,
        TEST_DATABASE_URL_ADMIN: testUrl.toString(),
        TEST_RUNTIME_LOGIN: loginRole,
        TEST_RUNTIME_PASSWORD: loginPassword,
        TEST_API_APP_MODULE: join(compiledRoot, 'api', 'app.js'),
        TEST_API_HEALTH_MODULE: join(compiledRoot, 'api', 'health.js'),
        NODE_PATH: resolve('node_modules'),
      },
    );
    testPassed = true;
  } finally {
    if (testAdmin) await testAdmin.end({ timeout: 5 }).catch(() => undefined);

    if (loginCreated) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${loginRole}`).catch(() => undefined);
    }
    if (databaseCreated) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }

    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) {
        await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }

    if (compiledRoot.startsWith(join(tmpdir(), 'tallermecario-security-test-'))) {
      rmSync(compiledRoot, { recursive: true, force: true });
    }

    if (databaseCreated) {
      const [remaining] = await maintenance`
        SELECT
          EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${databaseName}) AS database_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${loginRole}) AS login_present
      `;
      cleanupPassed = !remaining.database_present && !remaining.login_present;
    }
    await maintenance.end({ timeout: 5 });
  }

  if (!testPassed) throw new Error('API_SECURITY_TEST_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('FIXTURE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safeMessages = new Set([
    'DATABASE_CONFIGURATION_REQUIRED',
    'REFUSING_NON_LOCAL_DATABASE',
    'DATABASE_CONNECTION_FAILED',
    'API_SECURITY_TEST_FAILED',
    'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  process.stderr.write(`${safeMessages.has(error.message) ? error.message : 'API_SECURITY_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
