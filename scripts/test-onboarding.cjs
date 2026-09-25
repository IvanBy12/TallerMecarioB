'use strict';

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
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

function runChild(args, env, timeout = 90000) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env, stdio: 'inherit', timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

const ONBOARDING_MIGRATION_TAG = '0005_s1_01_onboarding';

function readJournal() {
  return JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8'));
}

/**
 * Locate the onboarding migration by its stable journal tag, never by position:
 * later migrations (0006, 0007, ...) are appended after it.
 */
function onboardingMigrationIndex(journal) {
  const index = journal.entries.findIndex((entry) => entry.tag === ONBOARDING_MIGRATION_TAG);
  if (index < 0) throw new Error('ONBOARDING_MIGRATION_NOT_FOUND');
  return index;
}

function makeMigrationFolder(journal, entries) {
  const root = mkdtempSync(join(tmpdir(), 'tallermecario-onboarding-migrations-'));
  const meta = join(root, 'meta');
  mkdirSync(meta);
  writeFileSync(join(meta, '_journal.json'), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
  for (const entry of entries) {
    copyFileSync(resolve(`drizzle/${entry.tag}.sql`), join(root, `${entry.tag}.sql`));
  }
  return root;
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);
  const journal = readJournal();
  const onboardingIndex = onboardingMigrationIndex(journal);
  const migrationsBeforeOnboarding = journal.entries.slice(0, onboardingIndex);
  const migrationsThroughOnboarding = journal.entries.slice(0, onboardingIndex + 1);
  const fullMigrationChain = journal.entries;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const databaseName = `tallermecario_onboarding_${suffix}`;
  const loginRole = `tm_onboarding_${suffix}`;
  const loginPassword = `rt_${randomUUID()}`;
  const testUrl = new URL(sourceUrl.toString());
  testUrl.pathname = `/${databaseName}`;
  const runtimeUrl = new URL(testUrl.toString());
  runtimeUrl.username = loginRole;
  runtimeUrl.password = loginPassword;

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let testAdmin;
  let databaseCreated = false;
  let loginCreated = false;
  let testPassed = false;
  let cleanupPassed = false;
  let originalRoles = new Set();
  const compiledRoot = mkdtempSync(join(tmpdir(), 'tallermecario-onboarding-build-'));
  const previousMigrations = makeMigrationFolder(journal, migrationsBeforeOnboarding);
  const onboardingMigrations = makeMigrationFolder(journal, migrationsThroughOnboarding);

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

    runChild(['scripts/migrate.cjs'], {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      MIGRATIONS_FOLDER: previousMigrations,
    });
    let [migrationState] = await testAdmin`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS count,
        to_regprocedure('app.bootstrap_provision_user(text,text,uuid,text,text,text)') IS NOT NULL AS has_onboarding
    `;
    if (migrationState.count !== migrationsBeforeOnboarding.length || migrationState.has_onboarding) {
      throw new Error('PREVIOUS_MIGRATION_STATE_INVALID');
    }

    runChild(['scripts/migrate.cjs'], {
      ...process.env,
      DATABASE_URL: testUrl.toString(),
      MIGRATIONS_FOLDER: onboardingMigrations,
    });
    [migrationState] = await testAdmin`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS count,
        to_regprocedure('app.bootstrap_provision_user(text,text,uuid,text,text,text)') IS NOT NULL AS has_onboarding,
        (SELECT count(*)::int FROM public.roles WHERE code IN ('owner','admin','service_advisor','technician')) AS roles
    `;
    if (migrationState.count !== migrationsThroughOnboarding.length
      || !migrationState.has_onboarding
      || migrationState.roles !== 4) {
      throw new Error('ONBOARDING_MIGRATION_INVALID');
    }
    process.stdout.write('UPGRADE_TO_0005_PASS\n');

    // Apply the remainder of the real chain (0006+) so the suite runs against the full schema.
    runChild(['scripts/migrate.cjs'], { ...process.env, DATABASE_URL: testUrl.toString() });
    [migrationState] = await testAdmin`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS count,
        to_regprocedure('app.bootstrap_provision_user(text,text,uuid,text,text,text)') IS NOT NULL AS has_onboarding
    `;
    if (migrationState.count !== fullMigrationChain.length || !migrationState.has_onboarding) {
      throw new Error('FULL_MIGRATION_CHAIN_INVALID');
    }
    process.stdout.write('FULL_MIGRATION_CHAIN_PASS\n');

    await testAdmin.unsafe(
      `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`,
    );
    loginCreated = true;
    await testAdmin.unsafe(`GRANT tallermecario_api TO ${loginRole}`);

    runChild([
      resolve('node_modules/typescript/bin/tsc'),
      '-p', 'tsconfig.json', '--noEmit', 'false', '--rootDir', 'src', '--outDir', compiledRoot,
    ], process.env);

    runChild(
      ['--test', '--test-concurrency=1', '--test-timeout=30000', 'tests/onboarding/onboarding.test.cjs'],
      {
        ...process.env,
        TEST_DATABASE_URL_ADMIN: testUrl.toString(),
        TEST_DATABASE_URL_RUNTIME: runtimeUrl.toString(),
        TEST_API_APP_MODULE: join(compiledRoot, 'api', 'app.js'),
        TEST_ONBOARDING_ROUTES_MODULE: join(compiledRoot, 'onboarding', 'routes.js'),
        TEST_ONBOARDING_SERVICE_MODULE: join(compiledRoot, 'onboarding', 'service.js'),
        NODE_PATH: resolve('node_modules'),
      },
      120000,
    );
    testPassed = true;
  } finally {
    if (testAdmin) await testAdmin.end({ timeout: 5 }).catch(() => undefined);
    if (loginCreated) await maintenance.unsafe(`DROP ROLE IF EXISTS ${loginRole}`).catch(() => undefined);
    if (databaseCreated) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    rmSync(compiledRoot, { recursive: true, force: true });
    rmSync(previousMigrations, { recursive: true, force: true });
    rmSync(onboardingMigrations, { recursive: true, force: true });

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

  if (!testPassed) throw new Error('ONBOARDING_TEST_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('FIXTURE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set([
    'DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE',
    'DATABASE_CONNECTION_FAILED', 'ONBOARDING_TEST_FAILED', 'TEST_DATABASE_CLEANUP_FAILED',
    'ONBOARDING_MIGRATION_NOT_FOUND', 'PREVIOUS_MIGRATION_STATE_INVALID', 'ONBOARDING_MIGRATION_INVALID',
    'FULL_MIGRATION_CHAIN_INVALID',
  ]);
  process.stderr.write(`${safe.has(error.message) ? error.message : 'ONBOARDING_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
