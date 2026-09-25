'use strict';

// Staging-only: creates (or rotates the password of) a single, real LOGIN
// role that the API/worker containers connect as, then `SET ROLE` into
// `tallermecario_api`/`tallermecario_worker` per request (ADR-009: runtime
// never connects as owner/migrator/superuser). Idempotent -- safe to run on
// every deploy. Never prints the password; it only ever reads it from the
// environment (Security Baseline §1: secrets live in env/secret store only).

const postgres = require('postgres');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function main() {
  const adminUrl = requiredEnv('DATABASE_URL');
  const loginRole = process.env.STAGING_RUNTIME_DB_ROLE || 'tallermecario_staging_runtime';
  const password = requiredEnv('STAGING_RUNTIME_DB_PASSWORD');

  const sql = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${loginRole}`;
    if (existing) {
      await sql.unsafe(`ALTER ROLE ${loginRole} WITH PASSWORD '${password}'`);
      process.stdout.write(`RUNTIME_LOGIN_PASSWORD_ROTATED ${loginRole}\n`);
    } else {
      await sql.unsafe(
        `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
      process.stdout.write(`RUNTIME_LOGIN_CREATED ${loginRole}\n`);
    }
    await sql.unsafe(`GRANT tallermecario_api TO ${loginRole}`);
    await sql.unsafe(`GRANT tallermecario_worker TO ${loginRole}`);
    process.stdout.write('RUNTIME_LOGIN_PROVISION_PASS\n');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
