'use strict';

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');

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
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHosts.has(url.hostname)) {
    throw new Error('REFUSING_NON_LOCAL_DATABASE');
  }
}

function runChild(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    timeout: 45000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

function makeMigrationSubset(entryCount) {
  const root = mkdtempSync(join(tmpdir(), 'tallermecario-migrations-'));
  const meta = join(root, 'meta');
  mkdirSync(meta);
  const journal = JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8'));
  journal.entries = journal.entries.slice(0, entryCount);
  writeFileSync(join(meta, '_journal.json'), `${JSON.stringify(journal, null, 2)}\n`);
  for (const entry of journal.entries) {
    copyFileSync(resolve(`drizzle/${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  }
  return root;
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const databaseName = `tallermecario_cross_row_${suffix}`;
  const loginRole = `tm_test_api_${suffix}`;
  const loginPassword = `rt_${randomUUID()}`;
  const testUrl = new URL(sourceUrl.toString());
  testUrl.pathname = `/${databaseName}`;

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let testAdmin;
  let databaseCreated = false;
  let loginCreated = false;
  let originalRoles = new Set();
  let testPassed = false;
  let cleanupPassed = false;
  const temporaryMigrationFolders = [];

  try {
    const [server] = await maintenance`SELECT pg_catalog.current_database() AS database, pg_catalog.inet_server_addr()::text AS address`;
    if (!server) throw new Error('DATABASE_CONNECTION_FAILED');
    process.stdout.write('DB_ENV_CONNECTED\n');

    const existingRoles = await maintenance`
      SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
    `;
    originalRoles = new Set(existingRoles.map((row) => row.rolname));

    await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;

    testAdmin = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });

    const migration0000 = makeMigrationSubset(1);
    const migration0000To0001 = makeMigrationSubset(2);
    temporaryMigrationFolders.push(migration0000, migration0000To0001);

    runChild(['scripts/migrate.cjs'], {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      MIGRATIONS_FOLDER: migration0000,
    });
    let [migrationState] = await testAdmin`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS count,
        to_regprocedure('app.enforce_workshop_primary_location()') IS NOT NULL AS has_0001
    `;
    if (migrationState.count !== 1 || migrationState.has_0001) throw new Error('MIGRATION_0000_STATE_INVALID');

    runChild(['scripts/migrate.cjs'], {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      MIGRATIONS_FOLDER: migration0000To0001,
    });
    [migrationState] = await testAdmin`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS count,
        to_regprocedure('app.enforce_workshop_primary_location()') IS NOT NULL AS has_0001
    `;
    if (migrationState.count !== 2 || !migrationState.has_0001) throw new Error('MIGRATION_UPGRADE_INVALID');
    process.stdout.write('UPGRADE_0000_TO_0001_PASS\n');

    runChild(['scripts/migrate.cjs'], { ...process.env, DATABASE_URL: testUrl.toString() });
    [migrationState] = await testAdmin`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    if (migrationState.count !== expectedMigrationCount()) throw new Error('FULL_MIGRATION_STATE_INVALID');

    await testAdmin`
      SELECT pg_catalog.pg_advisory_lock(
        pg_catalog.hashtextextended('tallermecario:migration-runner', 0)
      )
    `;
    let blockedRunner;
    try {
      blockedRunner = spawnSync(process.execPath, ['scripts/migrate.cjs'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: testUrl.toString() },
        encoding: 'utf8',
        timeout: 15000,
      });
    } finally {
      await testAdmin`
        SELECT pg_catalog.pg_advisory_unlock(
          pg_catalog.hashtextextended('tallermecario:migration-runner', 0)
        )
      `;
    }
    if (blockedRunner.error || blockedRunner.status !== 1
      || !blockedRunner.stderr.includes('MIGRATION_LOCK_UNAVAILABLE')) {
      throw new Error('MIGRATION_LOCK_TEST_FAILED');
    }
    runChild(['scripts/migrate.cjs'], { ...process.env, DATABASE_URL: testUrl.toString() });
    process.stdout.write('MIGRATION_RUNNER_EXCLUSION_PASS\n');

    await testAdmin.unsafe(
      `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`,
    );
    loginCreated = true;
    await testAdmin.unsafe(`GRANT tallermecario_api, tallermecario_worker TO ${loginRole}`);

    const testArgs = ['--test', '--test-concurrency=1', '--test-timeout=15000'];
    if (process.env.TEST_NAME_PATTERN) {
      testArgs.push(`--test-name-pattern=${process.env.TEST_NAME_PATTERN}`);
    }
    testArgs.push('tests/db/cross-row-integrity.test.cjs', 'tests/db/sprint0-db-gates.test.cjs');
    runChild(
      testArgs,
      {
        ...process.env,
        TEST_DATABASE_URL_ADMIN: testUrl.toString(),
        TEST_RUNTIME_LOGIN: loginRole,
        TEST_RUNTIME_PASSWORD: loginPassword,
      },
    );
    testPassed = true;
  } finally {
    if (testAdmin) await testAdmin.end({ timeout: 5 }).catch(() => undefined);

    for (const folder of temporaryMigrationFolders) {
      if (folder.startsWith(join(tmpdir(), 'tallermecario-migrations-'))) {
        rmSync(folder, { recursive: true, force: true });
      }
    }

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

    for (const role of [
      'tallermecario_migrator',
      'tallermecario_api',
      'tallermecario_worker',
      'tallermecario_bootstrap_resolver',
      'tallermecario_schema_owner',
    ]) {
      if (!originalRoles.has(role)) {
        await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }

    if (databaseCreated) {
      const [remaining] = await maintenance`
        SELECT
          EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${databaseName}) AS database_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${loginRole}) AS login_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname LIKE 'tallermecario_cross_row_%') AS fixture_database_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname LIKE 'tm_test_api_%') AS fixture_login_present
      `;
      cleanupPassed = !remaining.database_present
        && !remaining.login_present
        && !remaining.fixture_database_present
        && !remaining.fixture_login_present;
    }
    await maintenance.end({ timeout: 5 });
  }

  if (!testPassed) throw new Error('CROSS_ROW_TESTS_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('FIXTURE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safeMessages = new Set([
    'DATABASE_CONFIGURATION_REQUIRED',
    'REFUSING_NON_LOCAL_DATABASE',
    'DATABASE_CONNECTION_FAILED',
    'CROSS_ROW_TESTS_FAILED',
    'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  process.stderr.write(`${safeMessages.has(error.message) ? error.message : 'CROSS_ROW_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
