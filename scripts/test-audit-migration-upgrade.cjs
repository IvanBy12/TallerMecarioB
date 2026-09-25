'use strict';

/**
 * S1-07 upgrade path with live audit history, by the real migration runner:
 *
 *   0016 head -> HEAD   (0017 audit_logs column grants + actor guard)
 *
 * Disposable local DB migrated with a COPY of drizzle/ whose journal stops at
 * 0016; seed a tenant and an audit history that includes a LEGACY row with a
 * raw user_agent (pre-S1-04 shape), a tenant-less JIT row, provider and system
 * rows; upgrade with the real drizzle/ folder, then re-run (no-op). Then:
 * history byte-identical (append-only: 0017 never rewrites rows), privileges =
 * 0017 contract, and runtime logins (NOBYPASSRLS, via SET ROLE) can still
 * write contract rows but can no longer spoof the actor, write user_agent /
 * created_at, UPDATE or DELETE history.
 *
 * Local-only (AGENTS.md §10). Cleans up and fails if cleanup did not complete.
 */

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const postgres = require('postgres');

const CANONICAL_ROLES = [
  'tallermecario_schema_owner', 'tallermecario_migrator', 'tallermecario_api',
  'tallermecario_worker', 'tallermecario_bootstrap_resolver', 'tallermecario_identity_sync',
];
const START_HEAD = '0016_s1_06_membership_state_machine';
const COMMON = ['action', 'actor_membership_id', 'actor_type', 'actor_user_id', 'after_json', 'before_json', 'entity_id',
  'entity_type', 'id', 'metadata_json', 'outcome', 'reason_code', 'request_id', 'tenant_id', 'trace_id'];

function databaseUrlFromEnvironment() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const url = new URL('postgresql://localhost');
  url.hostname = process.env.PGHOST;
  url.port = process.env.PGPORT || '5432';
  url.pathname = `/${encodeURIComponent(process.env.PGDATABASE)}`;
  url.username = process.env.PGUSER;
  url.password = process.env.PGPASSWORD || '';
  return url;
}

function migrate(databaseUrl, folder) {
  const result = spawnSync(process.execPath, ['scripts/migrate.cjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, MIGRATIONS_FOLDER: folder },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 300_000,
  });
  return result.status === 0;
}

async function ledger(sql) {
  const [row] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return row.n;
}

async function seed(sql) {
  const roles = Object.fromEntries((await sql`SELECT code, id FROM public.roles`).map((row) => [row.code, row.id]));
  const tenantId = randomUUID();
  const owner = { user: randomUUID(), membership: randomUUID() };
  const tech = { user: randomUUID(), membership: randomUUID() };
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.workshops ${tx({ id: tenantId, slug: `au-${tenantId}`, legal_name: 'Legal', display_name: 'Upgrade' })}`;
    for (const [person, role] of [[owner, 'owner'], [tech, 'technician']]) {
      await tx`INSERT INTO public.users ${tx({ id: person.user, identity_provider: 'clerk', external_subject: `user_au${randomUUID().replaceAll('-', '')}`, email: `${person.user}@upgrade.test`, status: 'active' })}`;
      await tx`INSERT INTO public.memberships ${tx({ id: person.membership, tenant_id: tenantId, user_id: person.user, status: 'active' })}`;
      await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: tenantId, membership_id: person.membership, role_id: roles[role], assigned_by_membership_id: owner.membership })}`;
    }
    const rows = [
      // LEGACY (pre-S1-04): a raw User-Agent was persisted by onboarding.
      { tenant_id: tenantId, actor_type: 'user', actor_user_id: owner.user, actor_membership_id: owner.membership, action: 'workshop.created', outcome: 'success', entity_type: 'workshop', entity_id: tenantId, reason_code: 'workshop_onboarding', after_json: tx.json({ status: 'trialing' }), request_id: randomUUID(), ip_address: '10.1.2.3', user_agent: 'Mozilla/5.0 (legacy)' },
      { tenant_id: null, actor_type: 'user', actor_user_id: owner.user, action: 'identity.user_provisioned_jit', outcome: 'success', entity_type: 'user', entity_id: owner.user, metadata_json: tx.json({ identity_provider: 'clerk' }), request_id: randomUUID() },
      { tenant_id: tenantId, actor_type: 'provider', action: 'membership.revoked', outcome: 'denied', entity_type: 'membership', entity_id: owner.membership, reason_code: 'last_owner_invariant', before_json: tx.json({ status: 'active' }), after_json: tx.json({ status: 'active' }), request_id: randomUUID() },
      { tenant_id: tenantId, actor_type: 'system', action: 'membership.invitation_expired', outcome: 'success', entity_type: 'membership_invitation', entity_id: randomUUID(), reason_code: 'membership_invitation', request_id: randomUUID() },
    ];
    for (const row of rows) await tx`INSERT INTO public.audit_logs ${tx({ id: randomUUID(), ...row })}`;
  });
  return { tenantId, owner, tech };
}

async function history(sql) {
  const rows = await sql`SELECT row_to_json(a)::text AS row FROM public.audit_logs a ORDER BY id`;
  return rows.map((row) => row.row);
}

async function insertColumns(sql, role) {
  const rows = await sql`
    SELECT a.attname FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.audit_logs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.has_column_privilege(${role}, 'public.audit_logs', a.attname, 'INSERT')
    ORDER BY a.attname`;
  return rows.map((row) => row.attname);
}

const denied = (error) => error?.code === '42501';
const guard = (error) => error?.code === '42501' && error?.constraint_name === 'audit_logs_actor_guard';

/** Runs fn as a throwaway NOBYPASSRLS login (SET ROLE runtime), GUC-bound; rolls back unless commit. */
async function asRuntime(url, login, password, kind, gucs, fn, { commit = false } = {}) {
  const runtimeUrl = new URL(url);
  runtimeUrl.username = login;
  runtimeUrl.password = password;
  const sql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const conn = await sql.reserve();
    try {
      await conn.unsafe('BEGIN');
      await conn.unsafe(`SET LOCAL ROLE tallermecario_${kind}`);
      for (const [name, value] of Object.entries(gucs)) await conn`SELECT set_config(${`app.${name}`}, ${value}, true)`;
      const result = await fn(conn);
      await conn.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await conn.unsafe('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const index = journal.entries.findIndex((entry) => entry.tag === START_HEAD);
  if (index < 0) throw new Error('UPGRADE_HEAD_NOT_FOUND');
  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})`).map((row) => row.rolname));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const folder = mkdtempSync(join(tmpdir(), 'tallermecario-audit-upgrade-'));
  const databaseName = `tallermecario_audit_up_${suffix}`;
  const logins = { api: `tm_test_auupa_${suffix}`, worker: `tm_test_auupw_${suffix}` };
  const created = { database: false, logins: [] };
  let passed = false;
  let cleanupPassed = false;

  try {
    cpSync('drizzle', folder, { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index + 1) }));
    await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
    created.database = true;
    const url = new URL(sourceUrl.toString());
    url.pathname = `/${databaseName}`;
    assert.ok(migrate(url.toString(), folder), '0016 head migrates');

    const sql = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
    try {
      assert.equal(await ledger(sql), index + 1, 'start ledger at 0016');
      assert.equal((await insertColumns(sql, 'tallermecario_api')).includes('user_agent'), true, 'pre-0017: runtime could write user_agent');
      const { tenantId, owner, tech } = await seed(sql);
      const seeded = await history(sql);

      assert.ok(migrate(url.toString(), 'drizzle'), 'upgrade to HEAD');
      assert.equal(await ledger(sql), journal.entries.length, 'ledger at HEAD');
      assert.ok(migrate(url.toString(), 'drizzle'), 're-run is a no-op');
      assert.equal(await ledger(sql), journal.entries.length);
      assert.deepEqual(await history(sql), seeded, 'audit history byte-identical (legacy user_agent row preserved, never rewritten)');

      assert.deepEqual(await insertColumns(sql, 'tallermecario_api'), [...COMMON, 'ip_address'].sort());
      assert.deepEqual(await insertColumns(sql, 'tallermecario_worker'), [...COMMON].sort());
      const [trigger] = await sql`
        SELECT tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND tgname = 'audit_logs_actor_guard_trg'`;
      assert.equal(trigger?.tgenabled, 'O');

      const password = `rt_${randomUUID()}`;
      for (const [kind, role] of [['api', 'tallermecario_api'], ['worker', 'tallermecario_worker']]) {
        await sql.unsafe(`CREATE ROLE ${logins[kind]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        created.logins.push(logins[kind]);
        await sql.unsafe(`GRANT ${role} TO ${logins[kind]}`);
      }
      const run = (kind, gucs, fn, options) => asRuntime(url.toString(), logins[kind], password, kind, gucs, fn, options);
      const requestId = randomUUID();
      const apiGucs = { tenant_id: tenantId, user_id: owner.user, membership_id: owner.membership, request_id: requestId };
      const row = (extra) => ({
        id: randomUUID(), tenant_id: tenantId, actor_type: 'user', actor_user_id: owner.user, actor_membership_id: owner.membership,
        action: 'membership.suspended', outcome: 'success', entity_type: 'membership', entity_id: tech.membership,
        reason_code: 'member_status_management', request_id: requestId, ...extra,
      });

      await run('api', apiGucs, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({}))}`, { commit: true });
      await assert.rejects(run('api', apiGucs, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({ actor_membership_id: tech.membership, actor_user_id: tech.user }))}`), guard, 'actor spoof');
      await assert.rejects(run('api', apiGucs, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({ user_agent: 'Mozilla/5.0' }))}`), denied, 'user_agent');
      await assert.rejects(run('api', apiGucs, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({ created_at: new Date(0) }))}`), denied, 'created_at');
      await assert.rejects(run('worker', { tenant_id: tenantId }, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({}))}`), guard, 'worker as user');
      await run('worker', { tenant_id: tenantId }, (conn) => conn`INSERT INTO public.audit_logs ${conn(row({ actor_type: 'provider', actor_user_id: null, actor_membership_id: null, action: 'membership.revoked', reason_code: 'identity_provider_user_deleted', request_id: randomUUID() }))}`, { commit: true });
      for (const kind of ['api', 'worker']) {
        const gucs = kind === 'api' ? apiGucs : { tenant_id: tenantId };
        await assert.rejects(run(kind, gucs, (conn) => conn`UPDATE public.audit_logs SET user_agent = NULL WHERE tenant_id = ${tenantId}`), denied, `${kind} UPDATE`);
        await assert.rejects(run(kind, gucs, (conn) => conn`DELETE FROM public.audit_logs WHERE tenant_id = ${tenantId}`), denied, `${kind} DELETE`);
        await assert.rejects(run(kind, gucs, (conn) => conn`TRUNCATE public.audit_logs`), denied, `${kind} TRUNCATE`);
        const visible = await run(kind, gucs, (conn) => conn`SELECT DISTINCT tenant_id FROM public.audit_logs`);
        assert.deepEqual(visible.map((item) => item.tenant_id), [tenantId], `${kind} sees only its tenant`);
      }
      const after = await history(sql);
      assert.equal(after.length, seeded.length + 2);
      assert.deepEqual(after.filter((item) => seeded.includes(item)), seeded, 'seeded history still intact');
      process.stdout.write('UPGRADE_0016_TO_HEAD_PASS\n');
    } finally {
      await sql.end({ timeout: 5 });
    }
    passed = true;
  } finally {
    rmSync(folder, { recursive: true, force: true });
    if (created.database) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()`.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }
    for (const login of created.logins) await maintenance.unsafe(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [remaining] = await maintenance`
      SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${databaseName}) AS database_present,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY(${Object.values(logins)})) AS login_present`;
    cleanupPassed = !remaining.database_present && !remaining.login_present;
    await maintenance.end({ timeout: 5 });
  }
  if (!passed) throw new Error('AUDIT_UPGRADE_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('AUDIT_UPGRADE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set(['DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE', 'UPGRADE_HEAD_NOT_FOUND',
    'AUDIT_UPGRADE_FAILED', 'TEST_DATABASE_CLEANUP_FAILED']);
  process.stderr.write(`${safe.has(error.message) ? error.message : `AUDIT_UPGRADE_RUN_FAILED ${error.code ?? ''} ${error instanceof assert.AssertionError ? error.message : ''}`}\n`);
  process.exitCode = 1;
});
