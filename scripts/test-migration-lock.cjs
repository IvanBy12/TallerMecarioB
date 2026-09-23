'use strict';

// Operación v1 §7.1/§7.7: "solo un runner de migraciones opera por
// ambiente/release... dos runners concurrentes no pueden migrar al mismo
// tiempo." scripts/migrate.cjs already guards this with
// pg_try_advisory_lock(hashtextextended('tallermecario:migration-runner', 0))
// -- this script proves it, deterministically (no timing race):
//
//  1. Hold that exact advisory lock from a separate connection, simulating
//     "a migration is already running".
//  2. Run the real scripts/migrate.cjs against a fresh empty database while
//     the lock is held -> it must refuse (MIGRATION_LOCK_UNAVAILABLE, exit
//     1) and must NOT have created/applied anything.
//  3. Release the lock, run scripts/migrate.cjs again -> it must now
//     succeed, with the correct migration count and no leftover corruption
//     from step 2.

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');

const LOCK_SQL = `pg_catalog.hashtextextended('tallermecario:migration-runner', 0)`;

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

function runMigrate(databaseUrl) {
  return spawnSync(process.execPath, ['scripts/migrate.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    timeout: 30000,
    encoding: 'utf8',
  });
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const dbName = `tallermecario_lock_e2e_${suffix}`;
  const dbUrl = new URL(sourceUrl.toString());
  dbUrl.pathname = `/${dbName}`;

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let created = false;
  let lockHolder;
  let testPassed = false;
  let cleanupPassed = false;

  try {
    await maintenance.unsafe(`CREATE DATABASE ${dbName}`);
    created = true;
    process.stdout.write('DB_CREATED\n');

    // Step 1: hold the exact lock migrate.cjs uses, from a pinned connection.
    // `pg_advisory_lock` blocks until acquired and returns void; since
    // nobody else holds this key yet, it returns immediately.
    lockHolder = postgres(dbUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    await lockHolder.unsafe(`SELECT pg_catalog.pg_advisory_lock(${LOCK_SQL})`);
    process.stdout.write('LOCK_HELD_BY_SIMULATED_RUNNER\n');

    // Step 2: the real migrate.cjs must refuse while the lock is held.
    const blocked = runMigrate(dbUrl.toString());
    if (blocked.status === 0) throw new Error('MIGRATION_RAN_WHILE_LOCK_HELD');
    if (!blocked.stderr.includes('MIGRATION_LOCK_UNAVAILABLE')) {
      throw new Error(`UNEXPECTED_BLOCKED_FAILURE: ${blocked.stderr}`);
    }
    process.stdout.write('CONCURRENT_MIGRATION_CORRECTLY_REJECTED\n');

    const probe = postgres(dbUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const [{ exists: migrationsTableExists }] = await probe`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
    `;
    await probe.end({ timeout: 5 });
    if (migrationsTableExists) throw new Error('BLOCKED_RUN_LEFT_PARTIAL_STATE');
    process.stdout.write('NO_PARTIAL_STATE_FROM_BLOCKED_RUN\n');

    // Step 3: release, then a normal run must succeed cleanly.
    await lockHolder.unsafe(`SELECT pg_catalog.pg_advisory_unlock(${LOCK_SQL})`);
    await lockHolder.end({ timeout: 5 });
    lockHolder = undefined;
    process.stdout.write('LOCK_RELEASED\n');

    const succeeded = runMigrate(dbUrl.toString());
    if (succeeded.status !== 0) throw new Error(`MIGRATION_FAILED_AFTER_LOCK_RELEASE: ${succeeded.stderr}`);

    const verify = postgres(dbUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const [{ count }] = await verify`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    await verify.end({ timeout: 5 });
    if (count !== expectedMigrationCount()) throw new Error(`UNEXPECTED_MIGRATION_COUNT_${count}`);
    process.stdout.write(`MIGRATION_SUCCEEDED_AFTER_LOCK_RELEASE count=${count}\n`);

    testPassed = true;
  } finally {
    if (lockHolder) await lockHolder.end({ timeout: 5 }).catch(() => undefined);
    if (created) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE datname = ${dbName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined);
    }
    const [remaining] = await maintenance`
      SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${dbName}) AS present
    `;
    cleanupPassed = !remaining.present;
    await maintenance.end({ timeout: 5 });
  }

  if (!testPassed) throw new Error('MIGRATION_LOCK_TEST_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('MIGRATION_LOCK_TEST_PASS\n');
}

main().catch((error) => {
  const safeMessages = new Set([
    'DATABASE_CONFIGURATION_REQUIRED',
    'REFUSING_NON_LOCAL_DATABASE',
    'MIGRATION_LOCK_TEST_FAILED',
    'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${safeMessages.has(message) ? message : message}\n`);
  process.exitCode = 1;
});
