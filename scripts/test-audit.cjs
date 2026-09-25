'use strict';

/**
 * S1-07 audit subsystem suites against a REAL, ephemeral, local-only
 * PostgreSQL database — hermetic: no Clerk instance, no Resend, no secrets,
 * no internet.
 *
 *   - creates a throwaway database and runs the full migration chain from
 *     empty (drizzle/*.sql via scripts/migrate.cjs — never drizzle-kit push);
 *   - creates two throwaway NOBYPASSRLS NOINHERIT logins, one member of
 *     tallermecario_api and one of tallermecario_worker (ADR-009 runtime
 *     roles; never owner/migrator/superuser);
 *   - compiles src/ to a temp dir and runs tests/audit/*.test.cjs
 *     sequentially (JWTs signed with per-run RSA keys, fake Backend API,
 *     recording email sender);
 *   - optional S107_MUTATION (scripts/audit-mutations.cjs) breaks the
 *     compiled JS / test DB on purpose; the mutation runner expects a FAIL;
 *   - tears everything down and fails if cleanup did not complete.
 *
 * Connects only to a local host (AGENTS.md §10).
 */

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');
const { applyMutation } = require('./audit-mutations.cjs');

const CANONICAL_ROLES = [
  'tallermecario_schema_owner',
  'tallermecario_migrator',
  'tallermecario_api',
  'tallermecario_worker',
  'tallermecario_bootstrap_resolver',
  'tallermecario_identity_sync',
];
const COMPILE_PREFIX = 'tallermecario-audit-test-';

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

function runChild(args, env, timeout = 600_000) {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env, stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CHILD_PROCESS_FAILED_${result.status}`);
}

/** Child env without any real Clerk/Resend credential: the suites must be hermetic. */
function hermeticEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const name of Object.keys(env)) {
    if (/CLERK|RESEND|MEMBERSHIP_INVITATION/iu.test(name)) delete env[name];
  }
  return env;
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const databaseName = `tallermecario_audit_${suffix}`;
  const apiLogin = `tm_test_auapi_${suffix}`;
  const workerLogin = `tm_test_auwrk_${suffix}`;
  const apiPassword = `rt_${randomUUID()}`;
  const workerPassword = `rt_${randomUUID()}`;
  const testUrl = new URL(sourceUrl.toString());
  testUrl.pathname = `/${databaseName}`;

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let testAdmin;
  let databaseCreated = false;
  const loginsCreated = [];
  let originalRoles = new Set();
  let testPassed = false;
  let cleanupPassed = false;
  let compiledRoot;

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
    const [migrationState] = await testAdmin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    if (migrationState.count !== expectedMigrationCount()) throw new Error('CLEAN_MIGRATION_INVALID');
    process.stdout.write('CLEAN_MIGRATION_PASS\n');
    await applyMutation('sql', { admin: testAdmin });

    for (const [login, password, role] of [
      [apiLogin, apiPassword, 'tallermecario_api'],
      [workerLogin, workerPassword, 'tallermecario_worker'],
    ]) {
      await testAdmin.unsafe(
        `CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      loginsCreated.push(login);
      await testAdmin.unsafe(`GRANT ${role} TO ${login}`);
    }

    compiledRoot = mkdtempSync(join(tmpdir(), COMPILE_PREFIX));
    runChild([
      resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--noEmit', 'false',
      '--rootDir', 'src', '--outDir', compiledRoot,
    ], process.env);
    await applyMutation('js', { compiledRoot });

    const files = readdirSync('tests/audit')
      .filter((name) => name.endsWith('.test.cjs'))
      .sort()
      .map((name) => `tests/audit/${name}`);
    const testArgs = ['--test', '--test-concurrency=1', '--test-timeout=90000'];
    if (process.env.TEST_NAME_PATTERN) testArgs.push(`--test-name-pattern=${process.env.TEST_NAME_PATTERN}`);
    testArgs.push(...files);
    runChild(testArgs, hermeticEnv({
      TEST_DATABASE_URL_ADMIN: testUrl.toString(),
      TEST_API_LOGIN: apiLogin,
      TEST_API_PASSWORD: apiPassword,
      TEST_WORKER_LOGIN: workerLogin,
      TEST_WORKER_PASSWORD: workerPassword,
      TEST_MODULE_ROOT: compiledRoot,
      NODE_PATH: resolve('node_modules'),
    }));
    testPassed = true;
  } finally {
    if (testAdmin) await testAdmin.end({ timeout: 5 }).catch(() => undefined);

    if (compiledRoot && compiledRoot.startsWith(join(tmpdir(), COMPILE_PREFIX))) {
      rmSync(compiledRoot, { recursive: true, force: true });
    }

    if (databaseCreated) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }
    for (const login of loginsCreated) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    }
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) {
        await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }

    if (databaseCreated) {
      const [remaining] = await maintenance`
        SELECT
          EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${databaseName}) AS database_present,
          EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY(${[apiLogin, workerLogin]})) AS login_present
      `;
      cleanupPassed = !remaining.database_present && !remaining.login_present;
    }
    await maintenance.end({ timeout: 5 });
  }

  if (!testPassed) throw new Error('AUDIT_TESTS_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('AUDIT_FIXTURE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safeMessages = new Set([
    'DATABASE_CONFIGURATION_REQUIRED',
    'REFUSING_NON_LOCAL_DATABASE',
    'DATABASE_CONNECTION_FAILED',
    'CLEAN_MIGRATION_INVALID',
    'AUDIT_TESTS_FAILED',
    'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  // Mutation tooling errors name only the mutant and file (no secrets): keep them visible.
  const mutationError = /^(MUTATION_ANCHOR_NOT_FOUND|UNKNOWN_MUTATION) /u.test(error.message);
  process.stderr.write(`${safeMessages.has(error.message) || mutationError ? error.message : 'AUDIT_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
