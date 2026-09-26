'use strict';

// S2-01: local PostgreSQL 18, disposable database and runtime logins only.
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');

const CANONICAL_ROLES = [
  'tallermecario_schema_owner', 'tallermecario_migrator',
  'tallermecario_api', 'tallermecario_worker',
  'tallermecario_bootstrap_resolver', 'tallermecario_identity_sync',
];

function sourceUrl() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  for (const [h, p, d, u, pw] of [
    ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
    ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
  ]) {
    if (process.env[h] && process.env[d] && process.env[u]) {
      const url = new URL('postgresql://localhost');
      url.hostname = process.env[h];
      url.port = process.env[p] || '5432';
      url.pathname = `/${encodeURIComponent(process.env[d])}`;
      url.username = process.env[u];
      url.password = process.env[pw] || '';
      return url;
    }
  }
  throw new Error('DATABASE_CONFIGURATION_REQUIRED');
}

function localOnly(url) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('REFUSING_NON_LOCAL_DATABASE');
  }
}

function child(args, env, capture = false) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env, encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit', timeout: 600_000,
  });
  if (capture) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  }
  if (result.error || result.status !== 0) throw new Error('CRM_CHILD_PROCESS_FAILED');
  return result.stdout;
}

function testChild(args, env) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => processChild.kill(), 600_000);
    let output = '';
    processChild.stdout.on('data', (chunk) => { const part = chunk.toString(); output += part; process.stdout.write(part); });
    processChild.stderr.on('data', (chunk) => process.stderr.write(chunk));
    processChild.on('error', (error) => { clearTimeout(timer); reject(error); });
    processChild.on('close', (code) => { clearTimeout(timer); resolve({ output, code }); });
  });
}

async function main() {
  const source = sourceUrl();
  localOnly(source);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const dbName = `tm_test_crm_${suffix}`;
  const apiLogin = `tm_test_crma_${suffix}`;
  const workerLogin = `tm_test_crmw_${suffix}`;
  const testUrl = new URL(source);
  testUrl.pathname = `/${dbName}`;
  const maintenance = postgres(source.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let admin;
  let createdDb = false;
  const createdLogins = [];
  let originalRoles = new Set();
  let resultError;
  let cleanupError;
  try {
    const [server] = await maintenance`SELECT current_setting('server_version_num')::int AS version`;
    if (Math.floor(server.version / 10000) !== 18) throw new Error('POSTGRESQL_18_REQUIRED');
    const roles = await maintenance`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})`;
    originalRoles = new Set(roles.map((row) => row.rolname));
    await maintenance.unsafe(`CREATE DATABASE ${dbName}`);
    createdDb = true;
    admin = postgres(testUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
    child(['scripts/migrate.cjs'], { ...process.env, DATABASE_URL: testUrl.toString() });
    const [ledger] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    if (expectedMigrationCount() !== 19 || ledger.count !== 19) throw new Error('CRM_MIGRATION_LEDGER_INVALID');
    process.stdout.write('CRM_MIGRATION_LEDGER_PASS 19 (0000..0018)\n');
    for (const [login, password, role] of [
      [apiLogin, `rt_${randomUUID()}`, 'tallermecario_api'],
      [workerLogin, `rt_${randomUUID()}`, 'tallermecario_worker'],
    ]) {
      await admin.unsafe(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      createdLogins.push(login);
      await admin.unsafe(`GRANT ${role} TO ${login}`);
      if (role === 'tallermecario_api') process.env.TEST_API_PASSWORD = password;
      else process.env.TEST_WORKER_PASSWORD = password;
    }
    const files = readdirSync('tests/crm').filter((f) => f.endsWith('.test.cjs')).sort().map((f) => `tests/crm/${f}`);
    if (!files.length) throw new Error('CRM_TEST_FILES_MISSING');
    const testEnv = {
      ...process.env, NO_COLOR: '1', TEST_DATABASE_URL_ADMIN: testUrl.toString(),
      TEST_API_LOGIN: apiLogin, TEST_WORKER_LOGIN: workerLogin,
    };
    delete testEnv.FORCE_COLOR;
    const { output, code } = await testChild(['--test', '--test-concurrency=1', '--test-timeout=90000', ...files], testEnv);
    const count = (name) => Number(output.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+)$`, 'mu'))?.[1] ?? -1);
    const pass = count('pass'), fail = count('fail'), skip = count('skipped'), todo = count('todo');
    process.stdout.write(`CRM_TEST_COUNTS PASS=${pass} FAIL=${fail} SKIP=${skip} TODO=${todo}\n`);
    if (code !== 0 || pass <= 0 || fail !== 0 || skip !== 0 || todo !== 0) throw new Error('CRM_TEST_COUNTS_INVALID');
  } catch (error) {
    resultError = error;
  } finally {
    delete process.env.TEST_API_PASSWORD;
    delete process.env.TEST_WORKER_PASSWORD;
    if (admin) await admin.end({ timeout: 5 }).catch(() => undefined);
    if (createdDb) {
      await maintenance`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${dbName} AND pid <> pg_backend_pid()`
        .catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${dbName}`).catch((e) => { cleanupError ||= e; });
    }
    for (const login of createdLogins.reverse()) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${login}`).catch((e) => { cleanupError ||= e; });
    }
    if (createdDb) {
      for (const role of [...CANONICAL_ROLES].reverse()) {
        if (!originalRoles.has(role)) {
          await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch((e) => { cleanupError ||= e; });
        }
      }
    }
    const [remaining] = await maintenance`
      SELECT (SELECT count(*)::int FROM pg_database WHERE datname = ${dbName}) AS dbs,
        (SELECT count(*)::int FROM pg_roles WHERE rolname = ANY(${[apiLogin, workerLogin]})) AS logins
    `.catch((e) => { cleanupError ||= e; return [{}]; });
    if (remaining.dbs !== 0 || remaining.logins !== 0) cleanupError ||= new Error('CRM_TEARDOWN_RESIDUE');
    process.stdout.write(`CRM_TEARDOWN dbs=${remaining.dbs ?? 'unknown'} logins=${remaining.logins ?? 'unknown'}\n`);
    await maintenance.end({ timeout: 5 }).catch(() => undefined);
  }
  if (cleanupError) throw new Error('CRM_TEARDOWN_FAILED');
  if (resultError) throw resultError;
}

main().catch((error) => {
  const allowed = /^(DATABASE_CONFIGURATION_REQUIRED|REFUSING_NON_LOCAL_DATABASE|POSTGRESQL_18_REQUIRED|CRM_[A-Z_]+)$/u;
  process.stderr.write(`${allowed.test(error.message) ? error.message : 'CRM_DB_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
