'use strict';

const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');

function connectionConfigFromEnvironment() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const candidates = [
    ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
    ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
  ];

  for (const [hostKey, portKey, databaseKey, userKey, passwordKey] of candidates) {
    if (process.env[hostKey] && process.env[databaseKey] && process.env[userKey]) {
      return {
        host: process.env[hostKey],
        port: process.env[portKey] ? Number(process.env[portKey]) : 5432,
        database: process.env[databaseKey],
        username: process.env[userKey],
        password: process.env[passwordKey],
      };
    }
  }

  throw new Error('DATABASE_CONFIGURATION_REQUIRED');
}

let connectionConfig;
try {
  connectionConfig = connectionConfigFromEnvironment();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const clientOptions = {
  max: 1,
  prepare: false,
};
const client = typeof connectionConfig === 'string'
  ? postgres(connectionConfig, clientOptions)
  : postgres({ ...connectionConfig, ...clientOptions });

async function run() {
  let lockAcquired = false;

  try {
    const [lock] = await client`
      SELECT pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended('tallermecario:migration-runner', 0)
      ) AS acquired
    `;
    lockAcquired = lock.acquired;

    if (!lockAcquired) {
      throw new Error('MIGRATION_LOCK_UNAVAILABLE');
    }

    await migrate(drizzle(client), {
      migrationsFolder: process.env.MIGRATIONS_FOLDER || './drizzle',
    });
    process.stdout.write('Migrations applied successfully.\n');
  } finally {
    if (lockAcquired) {
      await client`
        SELECT pg_catalog.pg_advisory_unlock(
          pg_catalog.hashtextextended('tallermecario:migration-runner', 0)
        )
      `.catch(() => undefined);
    }
    await client.end({ timeout: 5 });
  }
}

run().catch((error) => {
  const safeMessage = error?.message === 'MIGRATION_LOCK_UNAVAILABLE'
    ? error.message
    : 'Migration failed.';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
