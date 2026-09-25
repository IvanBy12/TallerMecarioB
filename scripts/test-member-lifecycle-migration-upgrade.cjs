'use strict';

/**
 * S1-06 upgrade paths with live tenancy data, by the real migration runner:
 *
 *   0014 head -> HEAD   (0015 lifecycle-column grants + 0016 state machine)
 *   0015 head -> HEAD   (0016 state machine)
 *   0015 head -> HEAD with a LEGACY incoherent row (active + suspended_at):
 *                        0016 must be rejected atomically (ledger stays at 0015,
 *                        rows unchanged); after repairing the row it applies.
 *
 * Each scenario: disposable local DB migrated with a COPY of drizzle/ whose
 * journal stops at the start head; seed memberships in every status (with
 * roles); upgrade with the real drizzle/ folder, then re-run (no-op); rows
 * unchanged; privileges = 0015 contract; runtime logins can still run the
 * contract transitions and row locks, cannot rewrite identity columns, cannot
 * reactivate (0016), and the owner invariant holds on the upgraded data.
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
const LIFECYCLE_COLUMNS = ['revoked_at', 'status', 'suspended_at', 'updated_at'];
const SCENARIOS = [
  { name: '0014', head: '0014_s1_05_owner_lock_missing_workshop', legacy: false },
  { name: '0015', head: '0015_s1_06_membership_lifecycle_grants', legacy: false },
  { name: '0015legacy', head: '0015_s1_06_membership_lifecycle_grants', legacy: true },
];

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

async function seed(sql, { legacy }) {
  const roles = Object.fromEntries((await sql`SELECT code, id FROM public.roles`).map((row) => [row.code, row.id]));
  const tenantId = randomUUID();
  const members = {};
  const rows = [
    ['owner', 'owner', 'active'],
    ['owner2', 'owner', 'active'],
    ['tech', 'technician', 'active'],
    ['susp', 'service_advisor', 'suspended'],
    ['gone', 'technician', 'revoked'],
  ];
  if (legacy) rows.push(['legacy', 'technician', 'active-with-suspended_at']);
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.workshops ${tx({ id: tenantId, slug: `up-${tenantId}`, legal_name: 'Legal', display_name: 'Upgrade' })}`;
    for (const [name, role, kind] of rows) {
      const status = kind === 'active-with-suspended_at' ? 'active' : kind;
      const userId = randomUUID();
      const membershipId = randomUUID();
      await tx`INSERT INTO public.users ${tx({ id: userId, identity_provider: 'clerk', external_subject: `user_up${randomUUID().replaceAll('-', '')}`, email: `${userId}@upgrade.test`, status: 'active' })}`;
      await tx`INSERT INTO public.memberships ${tx({
        id: membershipId, tenant_id: tenantId, user_id: userId, status,
        // Legacy shape the pre-0016 CHECK allowed (e.g. an old reactivation).
        suspended_at: status === 'suspended' || kind === 'active-with-suspended_at' ? new Date() : null,
        revoked_at: status === 'revoked' ? new Date() : null,
      })}`;
      await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: tenantId, membership_id: membershipId, role_id: roles[role], assigned_by_membership_id: membershipId })}`;
      members[name] = membershipId;
    }
  });
  return { tenantId, members };
}

async function snapshot(sql) {
  const rows = await sql`
    SELECT m.id, m.tenant_id, m.user_id, m.status, m.joined_at, m.suspended_at, m.revoked_at, m.updated_at, r.code
    FROM public.memberships m
    JOIN public.membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
    JOIN public.roles r ON r.id = mr.role_id
    ORDER BY m.id, r.code
  `;
  return rows.map((row) => JSON.stringify(row));
}

async function updatableColumns(sql, role) {
  const rows = await sql`
    SELECT a.attname FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = 'public.memberships'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.has_column_privilege(${role}, 'public.memberships', a.attname, 'UPDATE')
    ORDER BY a.attname
  `;
  return rows.map((row) => row.attname);
}

async function ledger(sql) {
  const [row] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return row.n;
}

/** Runs fn as a throwaway NOBYPASSRLS login, tenant-bound; rolls back unless commit. */
async function asRuntime(url, login, password, tenantId, fn, { commit = false } = {}) {
  const runtimeUrl = new URL(url);
  runtimeUrl.username = login;
  runtimeUrl.password = password;
  const sql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const conn = await sql.reserve();
    try {
      await conn.unsafe('BEGIN');
      await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
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

const denied = (error) => error?.code === '42501';
const violation = (constraint) => (error) => error?.code === '23514' && error?.constraint_name === constraint;

async function scenario({ name, head, legacy }, context) {
  const { journal, maintenance, sourceUrl, suffix, cleanup } = context;
  const index = journal.entries.findIndex((entry) => entry.tag === head);
  if (index < 0) throw new Error('UPGRADE_HEAD_NOT_FOUND');
  const folder = mkdtempSync(join(tmpdir(), 'tallermecario-member-lifecycle-upgrade-'));
  cleanup.folders.push(folder);
  cpSync('drizzle', folder, { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index + 1) }));

  const databaseName = `tallermecario_ml_up_${name}_${suffix}`;
  await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
  cleanup.databases.push(databaseName);
  const url = new URL(sourceUrl.toString());
  url.pathname = `/${databaseName}`;
  assert.ok(migrate(url.toString(), folder), `${name}: start head migrates`);

  const sql = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
  try {
    assert.equal(await ledger(sql), index + 1, `${name}: start ledger`);
    const { tenantId, members } = await seed(sql, { legacy });
    const seeded = await snapshot(sql);

    if (legacy) {
      assert.equal(migrate(url.toString(), 'drizzle'), false, `${name}: 0016 must reject incoherent legacy rows`);
      assert.equal(await ledger(sql), index + 1, `${name}: rejected atomically (ledger unchanged)`);
      assert.deepEqual(await snapshot(sql), seeded, `${name}: rows unchanged by the rejected upgrade`);
      const [check] = await sql`
        SELECT count(*)::int AS n FROM pg_catalog.pg_constraint WHERE conname = 'memberships_lifecycle_state_check'`;
      assert.equal(check.n, 0, `${name}: no partial 0016 objects`);
      // Operator repair of the legacy row (explicit maintenance), then the upgrade applies.
      await sql`UPDATE public.memberships SET suspended_at = NULL WHERE id = ${members.legacy}`;
    }

    assert.ok(migrate(url.toString(), 'drizzle'), `${name}: upgrade to HEAD`);
    assert.equal(await ledger(sql), journal.entries.length, `${name}: ledger at HEAD`);
    assert.ok(migrate(url.toString(), 'drizzle'), `${name}: re-run is a no-op`);
    assert.equal(await ledger(sql), journal.entries.length);
    if (!legacy) assert.deepEqual(await snapshot(sql), seeded, `${name}: rows unchanged by the upgrade`);

    for (const role of ['tallermecario_api', 'tallermecario_worker']) {
      assert.deepEqual(await updatableColumns(sql, role), LIFECYCLE_COLUMNS, `${name} ${role}`);
      const [table] = await sql`
        SELECT pg_catalog.has_table_privilege(${role}, 'public.memberships', 'UPDATE') AS update,
          pg_catalog.has_table_privilege(${role}, 'public.memberships', 'DELETE') AS delete
      `;
      assert.deepEqual({ ...table }, { update: false, delete: false });
    }
    const policies = (await sql`
      SELECT policyname FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'memberships'
    `).map((row) => row.policyname).sort();
    assert.deepEqual(policies, ['tenant_insert', 'tenant_select', 'tenant_update']);

    const login = { api: `tm_test_mlupa_${name}_${suffix}`, worker: `tm_test_mlupw_${name}_${suffix}` };
    const password = `rt_${randomUUID()}`;
    for (const [kind, role] of [['api', 'tallermecario_api'], ['worker', 'tallermecario_worker']]) {
      await sql.unsafe(`CREATE ROLE ${login[kind]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      cleanup.logins.push(login[kind]);
      await sql.unsafe(`GRANT ${role} TO ${login[kind]}`);
    }
    const run = (kind, fn, options) => asRuntime(url.toString(), login[kind], password, tenantId, async (conn) => {
      await conn.unsafe(`SET ROLE tallermecario_${kind}`);
      return fn(conn);
    }, options);

    for (const kind of ['api', 'worker']) {
      const locked = await run(kind, (conn) => conn`SELECT id FROM public.memberships WHERE id = ${members.tech} FOR UPDATE`);
      assert.equal(locked.length, 1, `${name} ${kind} row lock`);
      await assert.rejects(run(kind, (conn) => conn`UPDATE public.memberships SET user_id = user_id WHERE id = ${members.tech}`), denied, `${kind} user_id`);
      await assert.rejects(run(kind, (conn) => conn`
        UPDATE public.memberships SET status = 'active', revoked_at = NULL WHERE id = ${members.gone}`), violation('m_status_transition'), `${name} ${kind} reactivation`);
      await assert.rejects(run(kind, (conn) => conn`
        UPDATE public.memberships SET status = 'active', suspended_at = NULL WHERE id = ${members.susp}`), violation('m_status_transition'), `${name} ${kind} un-suspend`);
    }
    await assert.rejects(run('api', (conn) => conn`
      UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE id IN (${members.owner}, ${members.owner2})`), violation('m_last_active_owner'), `${name}: both owners at once`);
    await run('api', (conn) => conn`
      UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = ${members.tech}`, { commit: true });
    await run('worker', (conn) => conn`
      UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${members.susp}`, { commit: true });
    const rows = Object.fromEntries((await sql`
      SELECT id, status, suspended_at FROM public.memberships WHERE tenant_id = ${tenantId}`).map((row) => [row.id, row]));
    assert.equal(rows[members.tech].status, 'suspended');
    assert.equal(rows[members.susp].status, 'revoked');
    assert.ok(rows[members.susp].suspended_at, `${name}: suspended -> revoked keeps suspended_at`);
    assert.equal(rows[members.owner].status, 'active');
    assert.equal(rows[members.owner2].status, 'active');
    process.stdout.write(`UPGRADE_${name.toUpperCase()}_TO_HEAD_PASS\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
  `).map((row) => row.rolname));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const cleanup = { folders: [], databases: [], logins: [] };
  let passed = false;
  let cleanupPassed = false;

  try {
    for (const item of SCENARIOS) await scenario(item, { journal, maintenance, sourceUrl, suffix, cleanup });
    passed = true;
  } finally {
    for (const folder of cleanup.folders) rmSync(folder, { recursive: true, force: true });
    for (const databaseName of cleanup.databases) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }
    for (const name of cleanup.logins) await maintenance.unsafe(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [remaining] = await maintenance`
      SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ANY(${cleanup.databases})) AS database_present,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY(${cleanup.logins})) AS login_present
    `;
    cleanupPassed = !remaining.database_present && !remaining.login_present;
    await maintenance.end({ timeout: 5 });
  }
  if (!passed) throw new Error('MEMBER_LIFECYCLE_UPGRADE_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('MEMBER_LIFECYCLE_UPGRADE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set(['DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE', 'UPGRADE_HEAD_NOT_FOUND',
    'MEMBER_LIFECYCLE_UPGRADE_FAILED', 'TEST_DATABASE_CLEANUP_FAILED']);
  process.stderr.write(`${safe.has(error.message) ? error.message : `MEMBER_LIFECYCLE_UPGRADE_RUN_FAILED ${error.code ?? ''} ${error instanceof assert.AssertionError ? error.message : ''}`}\n`);
  process.exitCode = 1;
});
