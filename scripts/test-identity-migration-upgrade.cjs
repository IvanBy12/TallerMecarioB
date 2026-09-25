'use strict';

/**
 * S1-03 upgrade path: a database already at the previous head (0006) with
 * live identity data is upgraded to 0007 by the real migration runner.
 *
 *   1. disposable local DB; migrate with a COPY of drizzle/ whose journal is
 *      truncated right before 0007 (the real runner, MIGRATIONS_FOLDER);
 *   2. seed users (active + disabled), a workshop, an owner membership and a
 *      JIT-provisioned user through the pre-0007 bootstrap_provision_user;
 *   3. run the real runner on the real drizzle/ folder (upgrade), then again
 *      (must be a no-op);
 *   4. verify existing rows are byte-for-byte unchanged, the upgraded JIT
 *      function keeps its contract for existing and new identities, and the
 *      new objects exist with the expected owners.
 *
 * Local-only (AGENTS.md §10). Cleans up and fails if cleanup did not complete.
 */

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const postgres = require('postgres');

const UPGRADE_TAG = '0007_s1_03_clerk_identity_lifecycle';
const CANONICAL_ROLES = [
  'tallermecario_schema_owner', 'tallermecario_migrator', 'tallermecario_api',
  'tallermecario_worker', 'tallermecario_bootstrap_resolver', 'tallermecario_identity_sync',
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
  });
  if (result.status !== 0) throw new Error('MIGRATION_RUN_FAILED');
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');

  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const upgradeIndex = journal.entries.findIndex((entry) => entry.tag === UPGRADE_TAG);
  if (upgradeIndex < 1) throw new Error('UPGRADE_MIGRATION_NOT_IN_JOURNAL');

  const name = `tallermecario_idupgrade_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const target = new URL(sourceUrl.toString());
  target.pathname = `/${name}`;
  const maintenance = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
  `).map((row) => row.rolname));
  const previousFolder = mkdtempSync(join(tmpdir(), 'tallermecario-previous-head-'));
  let db;
  let created = false;
  let passed = false;

  try {
    cpSync('drizzle', previousFolder, { recursive: true });
    writeFileSync(join(previousFolder, 'meta', '_journal.json'), JSON.stringify({
      ...journal, entries: journal.entries.slice(0, upgradeIndex),
    }));

    await maintenance.unsafe(`CREATE DATABASE ${name}`);
    created = true;
    db = postgres(target.toString(), { max: 2, onnotice: () => {} });

    migrate(target.toString(), previousFolder);
    const [before] = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    assert.equal(before.n, upgradeIndex);
    const [{ table }] = await db`SELECT to_regclass('public.identity_sync_states') AS table`;
    assert.equal(table, null, 'previous head has no identity_sync_states');
    process.stdout.write(`PREVIOUS_HEAD_PASS (${before.n} migrations)\n`);

    // Live data at the previous head.
    const ownerRole = (await db`SELECT id FROM public.roles WHERE code = 'owner'`)[0].id;
    const userA = randomUUID();
    const userB = randomUUID();
    const tenant = randomUUID();
    const membership = randomUUID();
    await db.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO public.users ${tx([
        { id: userA, identity_provider: 'clerk', external_subject: 'user_upgradeA', email: 'a@upgrade.test', full_name: 'A', status: 'active' },
        { id: userB, identity_provider: 'clerk', external_subject: 'user_upgradeB', email: 'b@upgrade.test', full_name: null, status: 'disabled' },
      ])}`;
      await tx`INSERT INTO public.workshops ${tx({ id: tenant, slug: `up-${tenant}`, legal_name: 'L', display_name: 'D' })}`;
      await tx`INSERT INTO public.memberships ${tx({ id: membership, tenant_id: tenant, user_id: userA, status: 'active' })}`;
      await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: tenant, membership_id: membership, role_id: ownerRole, assigned_by_membership_id: membership })}`;
    });
    const [jitBefore] = await db`
      SELECT * FROM app.bootstrap_provision_user('clerk', 'user_upgradeJit', ${randomUUID()}::uuid, 'jit@upgrade.test', NULL, 'upgrade')
    `;
    assert.equal(jitBefore.provisioned, true);
    const snapshot = async () => db`
      SELECT (SELECT json_agg(u ORDER BY u.id) FROM public.users u) AS users,
        (SELECT json_agg(m ORDER BY m.id) FROM public.memberships m) AS memberships,
        (SELECT json_agg(r ORDER BY r.membership_id) FROM public.membership_roles r) AS roles,
        (SELECT count(*)::int FROM public.audit_logs) AS audits
    `;
    const [dataBefore] = await snapshot();

    // Upgrade with the real folder, then re-run (idempotent no-op).
    migrate(target.toString(), resolve('drizzle'));
    migrate(target.toString(), resolve('drizzle'));
    const [after] = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    assert.equal(after.n, journal.entries.length);

    const [dataAfter] = await snapshot();
    assert.deepEqual(dataAfter, dataBefore, 'existing identity/tenancy rows untouched by the upgrade');

    const [again] = await db`
      SELECT * FROM app.bootstrap_provision_user('clerk', 'user_upgradeJit', ${randomUUID()}::uuid, 'other@upgrade.test', NULL, 'upgrade-2')
    `;
    assert.deepEqual({ ...again }, { user_id: jitBefore.user_id, user_status: 'active', provisioned: false });
    const [fresh] = await db`
      SELECT * FROM app.bootstrap_provision_user('clerk', 'user_upgradeNew', ${randomUUID()}::uuid, 'new@upgrade.test', NULL, 'upgrade-3')
    `;
    assert.equal(fresh.provisioned, true);

    const owners = await db`
      SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname IN ('bootstrap_provision_user', 'identity_sync_apply', 'ingest_verified_clerk_webhook')
      ORDER BY 1
    `;
    assert.deepEqual(owners.map((row) => `${row.proname}:${row.owner}`), [
      'bootstrap_provision_user:tallermecario_bootstrap_resolver',
      'identity_sync_apply:tallermecario_identity_sync',
      'ingest_verified_clerk_webhook:tallermecario_identity_sync',
    ]);
    const [{ states }] = await db`SELECT count(*)::int AS states FROM public.identity_sync_states`;
    assert.equal(states, 0, 'no sync state is invented for existing users');
    passed = true;
    process.stdout.write('UPGRADE_FROM_PREVIOUS_HEAD_PASS\n');
  } finally {
    if (db) await db.end({ timeout: 5 }).catch(() => undefined);
    rmSync(previousFolder, { recursive: true, force: true });
    if (created) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [{ present }] = await maintenance`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${name}) AS present`;
    await maintenance.end({ timeout: 5 });
    if (present) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  }
  if (!passed) throw new Error('IDENTITY_UPGRADE_TEST_FAILED');
  process.stdout.write('IDENTITY_UPGRADE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set([
    'DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE', 'UPGRADE_MIGRATION_NOT_IN_JOURNAL',
    'MIGRATION_RUN_FAILED', 'IDENTITY_UPGRADE_TEST_FAILED', 'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  if (error instanceof assert.AssertionError) process.stderr.write(`ASSERTION_FAILED: ${error.message}\n`);
  process.stderr.write(`${safe.has(error.message) ? error.message : 'IDENTITY_UPGRADE_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
