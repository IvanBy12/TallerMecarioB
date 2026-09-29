'use strict';

// Staging-only: creates (or rotates the password of) a single, real LOGIN
// role that the API/worker containers connect as, then select the fixed
// `tallermecario_api`/`tallermecario_worker` role when each pool connection opens (ADR-009: runtime
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
  const loginRole = 'tallermecario_runtime';
  const password = requiredEnv('STAGING_RUNTIME_DB_PASSWORD');
  const quotedPassword = password.replaceAll("'", "''");

  const sql = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [existing] = await sql`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${loginRole}`;
    if (existing) {
      await sql.unsafe(`ALTER ROLE ${loginRole} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${quotedPassword}'`);
      process.stdout.write(`RUNTIME_LOGIN_PASSWORD_ROTATED ${loginRole}\n`);
    } else {
      await sql.unsafe(
        `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${quotedPassword}'`,
      );
      process.stdout.write(`RUNTIME_LOGIN_CREATED ${loginRole}\n`);
    }
    await sql.unsafe(`GRANT tallermecario_api TO ${loginRole} WITH INHERIT FALSE, SET TRUE`);
    await sql.unsafe(`GRANT tallermecario_worker TO ${loginRole} WITH INHERIT FALSE, SET TRUE`);
    const [boundary] = await sql`
      SELECT r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolbypassrls,
        r.rolcreatedb, r.rolcreaterole,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_api', 'SET') AS api_set,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_worker', 'SET') AS worker_set,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_api', 'USAGE') AS api_inherited,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_worker', 'USAGE') AS worker_inherited,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_migrator', 'SET') AS migrator_set,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_schema_owner', 'SET') AS owner_set,
        pg_catalog.pg_has_role(${loginRole}, 'tallermecario_bootstrap_resolver', 'SET') AS bootstrap_set,
        pg_catalog.has_schema_privilege(${loginRole}, 'app', 'USAGE') AS app_usage,
        pg_catalog.has_schema_privilege(${loginRole}, 'public', 'USAGE') AS public_usage,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
          WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND acl.grantee = r.oid
        ) AS direct_table_grants,
        pg_catalog.has_database_privilege(${loginRole}, pg_catalog.current_database(), 'CREATE') AS create_database
      FROM pg_catalog.pg_roles r WHERE r.rolname = ${loginRole}`;
    if (!boundary || !boundary.rolcanlogin || boundary.rolinherit || boundary.rolsuper
      || boundary.rolbypassrls || boundary.rolcreatedb || boundary.rolcreaterole
      || !boundary.api_set || !boundary.worker_set || boundary.api_inherited
      || boundary.worker_inherited || boundary.migrator_set || boundary.owner_set
      || boundary.bootstrap_set || boundary.app_usage || boundary.public_usage
      || boundary.direct_table_grants
      || boundary.create_database) throw new Error('RUNTIME_LOGIN_PRIVILEGE_INVALID');
    process.stdout.write('RUNTIME_LOGIN_PROVISION_PASS\n');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
