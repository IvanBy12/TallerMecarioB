'use strict';

// End-to-end role contract in a disposable local database. The canonical
// cluster-global login must not exist before this test; never rotate a real one.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const postgres = require('postgres');

const ROLE = 'tallermecario_runtime';
const CANONICAL_ROLES = [
  'tallermecario_schema_owner', 'tallermecario_migrator',
  'tallermecario_api', 'tallermecario_worker',
  'tallermecario_bootstrap_resolver', 'tallermecario_identity_sync',
];

function sourceUrl() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER)
    throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const url = new URL('postgresql://localhost');
  url.hostname = process.env.PGHOST;
  url.port = process.env.PGPORT || '5432';
  url.pathname = `/${encodeURIComponent(process.env.PGDATABASE)}`;
  url.username = process.env.PGUSER;
  url.password = process.env.PGPASSWORD || '';
  return url;
}

function child(script, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(), env, stdio: 'inherit', timeout: 60000,
  });
  if (result.error || result.status !== 0) throw new Error('RUNTIME_FIXTURE_SETUP_FAILED');
}

async function main() {
  const source = sourceUrl();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(source.hostname))
    throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const name = `tm_runtime_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = `rt_${randomUUID()}`;
  const admin = postgres(source.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const testUrl = new URL(source);
  testUrl.pathname = `/${name}`;
  let testAdmin;
  let api;
  let worker;
  let raw;
  let databaseCreated = false;
  let originalRoles;
  let passed = false;

  try {
    const existing = await admin`SELECT rolname FROM pg_catalog.pg_roles
      WHERE rolname = ANY(${[ROLE, ...CANONICAL_ROLES]})`;
    originalRoles = new Set(existing.map((row) => row.rolname));
    if (originalRoles.has(ROLE)) throw new Error('RUNTIME_LOGIN_ALREADY_PRESENT');
    await admin.unsafe(`CREATE DATABASE ${name}`);
    databaseCreated = true;
    testAdmin = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    child('scripts/migrate.cjs', { ...process.env, DATABASE_URL: testUrl.toString() });
    child('scripts/provision-staging-runtime-login.cjs', {
      ...process.env, DATABASE_URL: testUrl.toString(), STAGING_RUNTIME_DB_PASSWORD: password,
    });

    const runtimeUrl = new URL(testUrl);
    runtimeUrl.username = ROLE;
    runtimeUrl.password = password;
    process.env.DATABASE_URL = runtimeUrl.toString();
    const { runtimeDatabase } = require('../dist/platform/runtime-database.js');
    api = await runtimeDatabase('api', 2);
    worker = await runtimeDatabase('worker', 2);

    for (const [pool, role] of [[api, 'tallermecario_api'], [worker, 'tallermecario_worker']]) {
      const [identity] = await pool`SELECT session_user AS login, current_user AS effective,
        r.rolbypassrls AS bypass FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
      assert.deepEqual({ ...identity }, { login: ROLE, effective: role, bypass: false });
    }
    const [apiGrant] = await api`SELECT pg_catalog.has_function_privilege(current_user,
      'app.bootstrap_claim_outbox_events(integer)', 'EXECUTE') AS allowed`;
    const [workerGrant] = await worker`SELECT pg_catalog.has_table_privilege(current_user,
      'public.customers', 'INSERT') AS allowed`;
    assert.equal(apiGrant.allowed, false);
    assert.equal(workerGrant.allowed, false);
    const [directGrants] = await testAdmin`
      SELECT count(*)::int AS n FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantee
      WHERE ns.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND r.rolname = ${ROLE}`;
    assert.equal(directGrants.n, 0);

    const reserved = await api.reserve();
    let transactionOpen = false;
    try {
      await reserved.unsafe('BEGIN');
      transactionOpen = true;
      await reserved.unsafe('SET LOCAL ROLE tallermecario_worker');
      assert.equal((await reserved`SELECT current_user AS role`)[0].role, 'tallermecario_worker');
      await reserved.unsafe('ROLLBACK');
      transactionOpen = false;
      assert.equal((await reserved`SELECT current_user AS role`)[0].role, 'tallermecario_api');
      await reserved.unsafe('BEGIN');
      transactionOpen = true;
      await reserved.unsafe('SET LOCAL ROLE tallermecario_worker');
      await reserved.unsafe('COMMIT');
      transactionOpen = false;
      assert.equal((await reserved`SELECT current_user AS role`)[0].role, 'tallermecario_api');
    } finally {
      if (transactionOpen) await reserved.unsafe('ROLLBACK').catch(() => undefined);
      reserved.release();
    }
    assert.equal((await api`SELECT current_user AS role`)[0].role, 'tallermecario_api');
    assert.equal((await worker`SELECT current_user AS role`)[0].role, 'tallermecario_worker');

    raw = postgres(runtimeUrl.toString(), { max: 1, onnotice: () => {},
      connection: { role: 'tallermecario_migrator' } });
    await assert.rejects(raw`SELECT 1`, (error) => error.code === '42501');
    await raw.end();
    raw = undefined;

    delete process.env.DATABASE_URL;
    for (const kind of ['api', 'worker']) {
      await assert.rejects(runtimeDatabase(kind, 1), /DATABASE_CONFIGURATION_REQUIRED/u);
    }
    process.env.DATABASE_URL = testUrl.toString();
    await assert.rejects(runtimeDatabase('api', 1), /DATABASE_RUNTIME_ROLE_INVALID/u);
    passed = true;
    process.stdout.write('RUNTIME_DATABASE_ROLE_BOUNDARY_PASS\n');
  } finally {
    await Promise.all([api?.end(), worker?.end(), raw?.end()].filter(Boolean).map((p) => p.catch(() => undefined)));
    if (testAdmin) await testAdmin.end({ timeout: 5 }).catch(() => undefined);
    if (databaseCreated) {
      await admin`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_catalog.pg_backend_pid()`;
      await admin.unsafe(`DROP DATABASE ${name}`);
    }
    if (databaseCreated && originalRoles) {
      if (!originalRoles.has(ROLE)) await admin.unsafe(`DROP ROLE IF EXISTS ${ROLE}`);
      for (const role of [...CANONICAL_ROLES].reverse()) {
        if (!originalRoles.has(role)) await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
      }
    }
    await admin.end({ timeout: 5 });
  }
  if (!passed) throw new Error('RUNTIME_DATABASE_TEST_FAILED');
}

main().catch((error) => {
  const safe = new Set(['DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE',
    'RUNTIME_LOGIN_ALREADY_PRESENT', 'RUNTIME_DATABASE_TEST_FAILED', 'RUNTIME_FIXTURE_SETUP_FAILED']);
  process.stderr.write(`${safe.has(error.message) ? error.message : 'RUNTIME_DATABASE_TEST_FAILED'}\n`);
  process.exitCode = 1;
});
