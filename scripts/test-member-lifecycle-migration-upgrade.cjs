'use strict';

/**
 * S1-06 upgrade path with live tenancy data, by the real migration runner:
 *
 *   0014 head -> HEAD   (applies 0015: lifecycle-column UPDATE grants on memberships)
 *
 * Disposable local DB migrated with a COPY of drizzle/ whose journal stops at
 * 0014; seed memberships in every status (with roles); upgrade with the real
 * drizzle/ folder, then re-run (must be a no-op); rows unchanged; privileges
 * are exactly the 0015 contract; a runtime login can still run the lifecycle
 * writes and row locks, cannot rewrite identity columns, and the owner
 * invariant still holds on the upgraded data.
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

const START_HEAD = '0014_s1_05_owner_lock_missing_workshop';
const CANONICAL_ROLES = [
  'tallermecario_schema_owner', 'tallermecario_migrator', 'tallermecario_api',
  'tallermecario_worker', 'tallermecario_bootstrap_resolver', 'tallermecario_identity_sync',
];
const LIFECYCLE_COLUMNS = ['revoked_at', 'status', 'suspended_at', 'updated_at'];

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

async function seed(sql) {
  const roles = Object.fromEntries((await sql`SELECT code, id FROM public.roles`).map((row) => [row.code, row.id]));
  const tenantId = randomUUID();
  const members = {};
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.workshops ${tx({ id: tenantId, slug: `up-${tenantId}`, legal_name: 'Legal', display_name: 'Upgrade' })}`;
    for (const [name, role, status] of [
      ['owner', 'owner', 'active'],
      ['owner2', 'owner', 'active'],
      ['tech', 'technician', 'active'],
      ['susp', 'service_advisor', 'suspended'],
      ['gone', 'technician', 'revoked'],
    ]) {
      const userId = randomUUID();
      const membershipId = randomUUID();
      await tx`INSERT INTO public.users ${tx({ id: userId, identity_provider: 'clerk', external_subject: `user_up${randomUUID().replaceAll('-', '')}`, email: `${userId}@upgrade.test`, status: 'active' })}`;
      await tx`INSERT INTO public.memberships ${tx({
        id: membershipId, tenant_id: tenantId, user_id: userId, status,
        suspended_at: status === 'suspended' ? new Date() : null,
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

/** Runs fn as a throwaway NOBYPASSRLS login of `role`, tenant-bound, then rolls back or commits. */
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
const ownerViolation = (error) => error?.code === '23514' && error?.constraint_name === 'm_last_active_owner';

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
  `).map((row) => row.rolname));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseName = `tallermecario_ml_upgrade_${suffix}`;
  const login = { api: `tm_test_mlupa_${suffix}`, worker: `tm_test_mlupw_${suffix}` };
  const password = `rt_${randomUUID()}`;
  let folder;
  let databaseCreated = false;
  const loginsCreated = [];
  let passed = false;
  let cleanupPassed = false;

  try {
    const index = journal.entries.findIndex((entry) => entry.tag === START_HEAD);
    if (index < 0) throw new Error('UPGRADE_HEAD_NOT_FOUND');
    assert.equal(journal.entries[index + 1]?.tag, '0015_s1_06_membership_lifecycle_grants', '0015 follows 0014');
    folder = mkdtempSync(join(tmpdir(), 'tallermecario-member-lifecycle-upgrade-'));
    cpSync('drizzle', folder, { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index + 1) }));

    await maintenance.unsafe(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    const url = new URL(sourceUrl.toString());
    url.pathname = `/${databaseName}`;
    assert.ok(migrate(url.toString(), folder), '0014 head migrates');

    const sql = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
    try {
      const [start] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      assert.equal(start.n, index + 1, 'start ledger at 0014');
      assert.equal((await updatableColumns(sql, 'tallermecario_api')).length > LIFECYCLE_COLUMNS.length, true, 'pre-0015: table-wide UPDATE');
      const { tenantId, members } = await seed(sql);
      const seeded = await snapshot(sql);

      assert.ok(migrate(url.toString(), 'drizzle'), 'upgrade to HEAD');
      const [upgraded] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      assert.equal(upgraded.n, journal.entries.length, 'ledger at HEAD');
      assert.ok(migrate(url.toString(), 'drizzle'), 're-run is a no-op');
      const [rerun] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      assert.equal(rerun.n, journal.entries.length);
      assert.deepEqual(await snapshot(sql), seeded, 'rows unchanged by the upgrade');

      for (const role of ['tallermecario_api', 'tallermecario_worker']) {
        assert.deepEqual(await updatableColumns(sql, role), LIFECYCLE_COLUMNS, role);
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

      for (const [kind, role] of [['api', 'tallermecario_api'], ['worker', 'tallermecario_worker']]) {
        await sql.unsafe(`CREATE ROLE ${login[kind]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        loginsCreated.push(login[kind]);
        await sql.unsafe(`GRANT ${role} TO ${login[kind]}`);
      }
      const run = (kind, fn, options) => asRuntime(url.toString(), login[kind], password, tenantId, async (conn) => {
        await conn.unsafe(`SET ROLE tallermecario_${kind}`);
        return fn(conn);
      }, options);

      for (const kind of ['api', 'worker']) {
        const locked = await run(kind, (conn) => conn`SELECT id FROM public.memberships WHERE id = ${members.tech} FOR UPDATE`);
        assert.equal(locked.length, 1, `${kind} row lock`);
        await assert.rejects(run(kind, (conn) => conn`UPDATE public.memberships SET user_id = user_id WHERE id = ${members.tech}`), denied, `${kind} user_id`);
      }
      await assert.rejects(run('api', (conn) => conn`
        UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now()
        WHERE id IN (${members.owner}, ${members.owner2})`), ownerViolation, 'both owners at once');
      await run('api', (conn) => conn`
        UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = ${members.tech}`, { commit: true });
      await run('worker', (conn) => conn`
        UPDATE public.memberships SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${members.susp}`, { commit: true });
      const statuses = Object.fromEntries((await sql`SELECT id, status FROM public.memberships WHERE tenant_id = ${tenantId}`)
        .map((row) => [row.id, row.status]));
      assert.equal(statuses[members.tech], 'suspended');
      assert.equal(statuses[members.susp], 'revoked');
      assert.equal(statuses[members.owner], 'active');
      assert.equal(statuses[members.owner2], 'active');
      process.stdout.write('UPGRADE_0014_TO_HEAD_PASS\n');
    } finally {
      await sql.end({ timeout: 5 });
    }
    passed = true;
  } finally {
    if (folder) rmSync(folder, { recursive: true, force: true });
    if (databaseCreated) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => undefined);
    }
    for (const name of loginsCreated) await maintenance.unsafe(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [remaining] = await maintenance`
      SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${databaseName}) AS database_present,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ANY(${Object.values(login)})) AS login_present
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
