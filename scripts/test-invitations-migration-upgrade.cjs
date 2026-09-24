'use strict';

/**
 * S1-04 upgrade path: a database at the previous head (0007) with live
 * tenancy/invitation data is upgraded to 0008 by the real migration runner.
 *
 *   1. disposable local DB migrated with a COPY of drizzle/ whose journal
 *      stops right before 0008;
 *   2. seed users, a workshop, memberships and coherent invitations
 *      (pending + accepted + revoked);
 *   3. upgrade with the real drizzle/ folder, then re-run (must be a no-op);
 *   4. existing rows unchanged; new constraints/trigger/resolver present with
 *      the expected owners and grants; a pre-existing pending invitation
 *      resolves by its hash;
 *   5. a second DB holding a row the new CHECKs reject (raw token in
 *      token_hash) must FAIL the upgrade atomically: still at 0007, no
 *      partial 0008 objects.
 *
 * Local-only (AGENTS.md §10). Cleans up and fails if cleanup did not complete.
 */

const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const postgres = require('postgres');

const UPGRADE_TAG = '0008_s1_04_membership_invitations';
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
  return result.status === 0;
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function seedPreviousHead(db) {
  const roles = Object.fromEntries((await db`SELECT id, code FROM public.roles`).map((row) => [row.code, row.id]));
  const tenant = randomUUID();
  const owner = { user: randomUUID(), membership: randomUUID() };
  const joined = { user: randomUUID(), membership: randomUUID() };
  const pendingToken = randomBytes(32).toString('base64url');
  const invitations = {
    pending: randomUUID(),
    accepted: randomUUID(),
    revoked: randomUUID(),
  };
  await db.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.users ${tx([
      { id: owner.user, identity_provider: 'clerk', external_subject: 'user_upg_owner', email: 'owner@upgrade.test', status: 'active' },
      { id: joined.user, identity_provider: 'clerk', external_subject: 'user_upg_joined', email: 'joined@upgrade.test', status: 'active' },
    ])}`;
    await tx`INSERT INTO public.workshops ${tx({ id: tenant, slug: `upg-${tenant}`, legal_name: 'L', display_name: 'D' })}`;
    await tx`INSERT INTO public.memberships ${tx([
      { id: owner.membership, tenant_id: tenant, user_id: owner.user, status: 'active' },
      { id: joined.membership, tenant_id: tenant, user_id: joined.user, status: 'active' },
    ])}`;
    await tx`INSERT INTO public.membership_roles ${tx([
      { tenant_id: tenant, membership_id: owner.membership, role_id: roles.owner, assigned_by_membership_id: owner.membership },
      { tenant_id: tenant, membership_id: joined.membership, role_id: roles.technician, assigned_by_membership_id: owner.membership },
    ])}`;
    const base = { tenant_id: tenant, target_role_id: roles.technician, invited_by_membership_id: owner.membership };
    // One INSERT per row: a multi-row helper would take the column list from
    // the first object only and silently drop accepted_*/revoked_*.
    for (const row of [
      { ...base, id: invitations.pending, email: 'New@Upgrade.test', email_normalized: 'new@upgrade.test', token_hash: sha256(pendingToken), status: 'pending', expires_at: new Date(Date.now() + 86_400_000) },
      { ...base, id: invitations.accepted, email: 'joined@upgrade.test', email_normalized: 'joined@upgrade.test', token_hash: sha256(randomUUID()), status: 'accepted', expires_at: new Date(Date.now() + 86_400_000), accepted_at: new Date(), accepted_by_user_id: joined.user, accepted_membership_id: joined.membership },
      { ...base, id: invitations.revoked, email: 'gone@upgrade.test', email_normalized: 'gone@upgrade.test', token_hash: sha256(randomUUID()), status: 'revoked', expires_at: new Date(Date.now() + 86_400_000), revoked_at: new Date(), revoked_by_membership_id: owner.membership },
    ]) {
      await tx`INSERT INTO public.membership_invitations ${tx(row)}`;
    }
  });
  return { tenant, invitations, pendingHash: sha256(pendingToken) };
}

async function main() {
  const sourceUrl = databaseUrlFromEnvironment();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(sourceUrl.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');

  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const upgradeIndex = journal.entries.findIndex((entry) => entry.tag === UPGRADE_TAG);
  if (upgradeIndex < 1) throw new Error('UPGRADE_MIGRATION_NOT_IN_JOURNAL');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const names = [`tallermecario_invupgrade_${suffix}`, `tallermecario_invupgbad_${suffix}`];
  const urls = names.map((name) => {
    const url = new URL(sourceUrl.toString());
    url.pathname = `/${name}`;
    return url.toString();
  });
  const maintenance = postgres(sourceUrl.toString(), { max: 1, onnotice: () => {} });
  const originalRoles = new Set((await maintenance`
    SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
  `).map((row) => row.rolname));
  const previousFolder = mkdtempSync(join(tmpdir(), 'tallermecario-inv-previous-head-'));
  const created = [];
  const pools = [];
  let passed = false;

  try {
    cpSync('drizzle', previousFolder, { recursive: true });
    writeFileSync(join(previousFolder, 'meta', '_journal.json'), JSON.stringify({
      ...journal, entries: journal.entries.slice(0, upgradeIndex),
    }));

    /* ---------------------------- clean upgrade ---------------------------- */
    await maintenance.unsafe(`CREATE DATABASE ${names[0]}`);
    created.push(names[0]);
    const db = postgres(urls[0], { max: 2, onnotice: () => {} });
    pools.push(db);
    assert.ok(migrate(urls[0], previousFolder), 'previous head migrates');
    const [before] = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    assert.equal(before.n, upgradeIndex);
    const [{ fn }] = await db`SELECT to_regprocedure('app.bootstrap_resolve_membership_invitation(text)') AS fn`;
    assert.equal(fn, null, 'previous head has no invitation resolver');
    process.stdout.write(`PREVIOUS_HEAD_PASS (${before.n} migrations)\n`);

    const seeded = await seedPreviousHead(db);
    const snapshot = async () => db`
      SELECT (SELECT json_agg(i ORDER BY i.id) FROM public.membership_invitations i) AS invitations,
        (SELECT json_agg(m ORDER BY m.id) FROM public.memberships m) AS memberships,
        (SELECT json_agg(r ORDER BY r.membership_id) FROM public.membership_roles r) AS roles,
        (SELECT count(*)::int FROM public.audit_logs) AS audits
    `;
    const [dataBefore] = await snapshot();

    assert.ok(migrate(urls[0], resolve('drizzle')), 'upgrade to 0008');
    assert.ok(migrate(urls[0], resolve('drizzle')), 're-run is a no-op');
    const [after] = await db`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    assert.equal(after.n, journal.entries.length);
    const [dataAfter] = await snapshot();
    assert.deepEqual(dataAfter, dataBefore, 'existing rows untouched by the upgrade');

    const constraints = await db`
      SELECT conname FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.membership_invitations'::regclass AND contype = 'c' ORDER BY conname
    `;
    assert.deepEqual(constraints.map((row) => row.conname), [
      'mi_accepted_coherence_check', 'mi_expiry_after_creation_check', 'mi_revoked_coherence_check',
      'mi_status_check', 'mi_token_hash_format_check',
    ]);
    const objects = await db`
      SELECT p.proname, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname IN ('bootstrap_resolve_membership_invitation', 'enforce_membership_invitation_lifecycle')
      ORDER BY 1
    `;
    assert.deepEqual(objects.map((row) => `${row.proname}:${row.owner}:${row.prosecdef}`), [
      'bootstrap_resolve_membership_invitation:tallermecario_bootstrap_resolver:true',
      'enforce_membership_invitation_lifecycle:tallermecario_schema_owner:false',
    ]);
    const [{ triggers }] = await db`SELECT count(*)::int AS triggers FROM pg_catalog.pg_trigger WHERE tgname = 'membership_invitations_lifecycle_trg'`;
    assert.equal(triggers, 1);
    const [{ schemaCreate }] = await db`SELECT has_schema_privilege('tallermecario_bootstrap_resolver', 'app', 'CREATE') AS "schemaCreate"`;
    assert.equal(schemaCreate, false, 'temporary CREATE on app revoked again');

    const resolved = await db`SELECT * FROM app.bootstrap_resolve_membership_invitation(${seeded.pendingHash})`;
    assert.deepEqual(resolved.map((row) => ({ ...row })), [{ invitation_id: seeded.invitations.pending, tenant_id: seeded.tenant }]);
    // Terminal pre-existing rows are protected from now on.
    await assert.rejects(db`UPDATE public.membership_invitations SET status = 'pending', revoked_at = NULL, revoked_by_membership_id = NULL WHERE id = ${seeded.invitations.revoked}`,
      (error) => error.constraint_name === 'mi_terminal_state');
    passed = true;
    process.stdout.write('UPGRADE_FROM_PREVIOUS_HEAD_PASS\n');

    /* ------------------------ invalid legacy data -------------------------- */
    passed = false;
    await maintenance.unsafe(`CREATE DATABASE ${names[1]}`);
    created.push(names[1]);
    const bad = postgres(urls[1], { max: 2, onnotice: () => {} });
    pools.push(bad);
    assert.ok(migrate(urls[1], previousFolder));
    const legacy = await seedPreviousHead(bad);
    await bad.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.membership_invitations SET token_hash = ${randomBytes(32).toString('base64url')} WHERE id = ${legacy.invitations.pending}`;
    });
    assert.equal(migrate(urls[1], resolve('drizzle')), false, 'upgrade refuses a raw token stored as token_hash');
    const [state] = await bad`
      SELECT (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
        to_regprocedure('app.bootstrap_resolve_membership_invitation(text)') IS NOT NULL AS resolver,
        (SELECT count(*)::int FROM pg_catalog.pg_constraint WHERE conname = 'mi_accepted_coherence_check') AS constraints
    `;
    assert.deepEqual({ ...state }, { migrations: upgradeIndex, resolver: false, constraints: 0 }, 'failed upgrade leaves no partial 0008');
    passed = true;
    process.stdout.write('INVALID_LEGACY_DATA_UPGRADE_REJECTED_ATOMICALLY_PASS\n');
  } finally {
    for (const pool of pools) await pool.end({ timeout: 5 }).catch(() => undefined);
    rmSync(previousFolder, { recursive: true, force: true });
    for (const name of created) {
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }
    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    const [{ present }] = await maintenance`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ANY(${names})) AS present`;
    await maintenance.end({ timeout: 5 });
    if (present) throw new Error('TEST_DATABASE_CLEANUP_FAILED');
  }
  if (!passed) throw new Error('INVITATION_UPGRADE_TEST_FAILED');
  process.stdout.write('INVITATION_UPGRADE_CLEANUP_PASS\n');
}

main().catch((error) => {
  const safe = new Set([
    'DATABASE_CONFIGURATION_REQUIRED', 'REFUSING_NON_LOCAL_DATABASE', 'UPGRADE_MIGRATION_NOT_IN_JOURNAL',
    'INVITATION_UPGRADE_TEST_FAILED', 'TEST_DATABASE_CLEANUP_FAILED',
  ]);
  if (error instanceof assert.AssertionError) process.stderr.write(`ASSERTION_FAILED: ${error.message}\n`);
  process.stderr.write(`${safe.has(error.message) ? error.message : 'INVITATION_UPGRADE_TEST_RUN_FAILED'}\n`);
  process.exitCode = 1;
});
