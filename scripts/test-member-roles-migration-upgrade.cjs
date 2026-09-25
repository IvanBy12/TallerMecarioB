'use strict';

/**
 * S1-05 upgrade paths with live tenancy data, by the real migration runner:
 *
 *   0010 head -> HEAD   (applies 0011 + 0012 + 0013 in one run)
 *   0011 head -> HEAD   (applies 0012 + 0013)
 *   0012 head -> HEAD   (applies 0013 lock hierarchy + 0014)
 *   0013 head -> HEAD   (applies 0014: no-op lock for a missing workshop)
 *
 * For each start head: disposable local DB migrated with a COPY of drizzle/
 * whose journal stops at that head; seed a single-owner tenant, a two-owner
 * tenant and a legacy tenant with NO active owner (suspended owner + staff);
 * upgrade with the real drizzle/ folder, then re-run (must be a no-op);
 * rows unchanged; 0011/0012 objects present; the invariant is enforced on the
 * upgraded data (single owner cannot be revoked, one of two can, legacy
 * tenant's staff still changes status).
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

const START_HEADS = [
  '0010_s1_04_worker_invitation_privileges',
  '0011_s1_05_member_role_management',
  '0012_s1_05_owner_status_invariant',
  '0013_s1_05_owner_lock_hierarchy',
];
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
    timeout: 300_000,
  });
  return result.status === 0;
}

async function seed(sql) {
  const roles = Object.fromEntries((await sql`SELECT code, id FROM public.roles`).map((row) => [row.code, row.id]));
  const tenants = {};
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const [name, members] of Object.entries({
      single: [['owner', 'active'], ['technician', 'active']],
      pair: [['owner', 'active'], ['owner', 'active']],
      legacy: [['owner', 'suspended'], ['technician', 'active']],
    })) {
      const tenantId = randomUUID();
      await tx`INSERT INTO public.workshops ${tx({ id: tenantId, slug: `up-${tenantId}`, legal_name: 'Legal', display_name: name })}`;
      const memberships = [];
      for (const [role, status] of members) {
        const userId = randomUUID();
        const membershipId = randomUUID();
        await tx`INSERT INTO public.users ${tx({ id: userId, identity_provider: 'clerk', external_subject: `user_up${randomUUID().replaceAll('-', '')}`, email: `${userId}@upgrade.test`, status: 'active' })}`;
        await tx`INSERT INTO public.memberships ${tx({ id: membershipId, tenant_id: tenantId, user_id: userId, status, suspended_at: status === 'suspended' ? new Date() : null })}`;
        await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: tenantId, membership_id: membershipId, role_id: roles[role], assigned_by_membership_id: membershipId })}`;
        memberships.push(membershipId);
      }
      tenants[name] = { tenantId, memberships };
    }
  });
  return tenants;
}

async function snapshot(sql) {
  const rows = await sql`
    SELECT m.id, m.tenant_id, m.status, r.code
    FROM public.memberships m
    JOIN public.membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
    JOIN public.roles r ON r.id = mr.role_id
    ORDER BY m.id, r.code
  `;
  return rows.map((row) => ({ ...row }));
}

const violation = (constraint) => (error) => error?.code === '23514' && error?.constraint_name === constraint;

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
  `).map((row) => row.rolname));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const databases = [];
  const folders = [];
  let passed = false;
  let cleanupPassed = false;

  try {
    for (const head of START_HEADS) {
      const index = journal.entries.findIndex((entry) => entry.tag === head);
      if (index < 0) throw new Error('UPGRADE_HEAD_NOT_FOUND');
      const folder = mkdtempSync(join(tmpdir(), 'tallermecario-member-roles-upgrade-'));
      folders.push(folder);
      cpSync('drizzle', folder, { recursive: true });
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index + 1) }));

      const name = `tallermecario_mr_upgrade_${head.slice(0, 4)}_${suffix}`;
      await maintenance.unsafe(`CREATE DATABASE ${name}`);
      databases.push(name);
      const url = new URL(sourceUrl.toString());
      url.pathname = `/${name}`;
      assert.ok(migrate(url.toString(), folder), `${head} head migrates`);

      const sql = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        const [before] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(before.n, index + 1, `${head}: start ledger`);
        const tenants = await seed(sql);
        const seeded = await snapshot(sql);

        assert.ok(migrate(url.toString(), resolve('drizzle')), `${head} -> HEAD`);
        assert.ok(migrate(url.toString(), resolve('drizzle')), `${head}: re-run is a no-op`);
        const [after] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(after.n, journal.entries.length, `${head}: HEAD ledger`);
        assert.deepEqual(await snapshot(sql), seeded, `${head}: rows unchanged`);

        const objects = await sql`
          SELECT
            (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
              WHERE c.relname IN ('memberships', 'membership_roles') AND t.tgname IN (
                'membership_roles_invariants_trg', 'memberships_owner_invariant_trg',
                'memberships_owner_set_lock_trg', 'membership_roles_owner_set_lock_trg')) AS triggers,
            (SELECT pg_catalog.array_agg(policyname::text ORDER BY policyname) FROM pg_catalog.pg_policies
              WHERE tablename = 'membership_roles') AS policies,
            has_table_privilege('tallermecario_api', 'public.membership_roles', 'UPDATE') AS api_update,
            has_table_privilege('tallermecario_api', 'public.membership_roles', 'DELETE') AS api_delete,
            (to_regclass('app.owner_mutation_gate') IS NOT NULL) AS gate,
            (SELECT pg_catalog.array_agg(p.oid::regprocedure::text ORDER BY 1) FROM pg_catalog.pg_proc p
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname ~ 'owner'
                AND (has_function_privilege('tallermecario_api', p.oid, 'EXECUTE')
                  OR has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE'))) AS runtime_owner_functions
        `;
        assert.deepEqual({ ...objects[0] }, {
          triggers: 4, policies: ['tenant_delete', 'tenant_insert', 'tenant_select'], api_update: false, api_delete: true,
          gate: true, runtime_owner_functions: ['app.lock_current_tenant_owner_set()'],
        }, `${head}: HEAD objects`);

        // 0014: a valid context whose workshop does not exist is a no-op, not 55000.
        await sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${randomUUID()}, true)`;
          await tx`SELECT app.lock_current_tenant_owner_set()`;
        });

        // Invariant on upgraded data (privileged session: triggers apply to everyone).
        await assert.rejects(sql`UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = ${tenants.single.memberships[0]}`,
          violation('m_last_active_owner'), `${head}: single owner`);
        await sql`UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = ${tenants.pair.memberships[0]}`;
        await assert.rejects(sql`UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = ${tenants.pair.memberships[1]}`,
          violation('m_last_active_owner'), `${head}: remaining owner`);
        await sql`UPDATE public.memberships SET status = 'revoked', revoked_at = now() WHERE id = ${tenants.legacy.memberships[1]}`;
        await assert.rejects(sql`
          DELETE FROM public.membership_roles AS mr USING public.roles AS r
          WHERE r.id = mr.role_id AND r.code = 'owner' AND mr.membership_id = ${tenants.single.memberships[0]}
        `, violation('mr_last_active_owner'), `${head}: single owner role`);
        process.stdout.write(`UPGRADE_FROM_${head.slice(0, 4)}_TO_HEAD_PASS\n`);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    passed = true;
  } finally {
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    for (const name of databases) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [remaining] = await maintenance`
      SELECT count(*)::int AS n FROM pg_catalog.pg_database WHERE datname = ANY(${databases})
    `;
    cleanupPassed = remaining.n === 0;
    await maintenance.end({ timeout: 5 });
  }
  if (!passed) throw new Error('MEMBER_ROLE_UPGRADE_FAILED');
  if (!cleanupPassed) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  process.stdout.write('MEMBER_ROLE_UPGRADE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set([
    'DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE', 'UPGRADE_HEAD_NOT_FOUND',
    'MEMBER_ROLE_UPGRADE_FAILED', 'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  process.stderr.write(`${safe.has(error.message) ? error.message : `MEMBER_ROLE_UPGRADE_RUN_FAILED ${error.code ?? ''} ${error.constraint_name ?? ''}`.trim()}\n`);
  if (error instanceof assert.AssertionError) process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
