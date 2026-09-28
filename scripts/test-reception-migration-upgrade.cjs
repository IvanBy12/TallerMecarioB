'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const postgres = require('postgres');

const ROLES = ['tallermecario_schema_owner','tallermecario_migrator','tallermecario_api',
  'tallermecario_worker','tallermecario_bootstrap_resolver','tallermecario_identity_sync'];
function sourceUrl() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);
  if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const url = new URL('postgresql://localhost');
  url.hostname = process.env.PGHOST; url.port = process.env.PGPORT || '5432';
  url.pathname = `/${encodeURIComponent(process.env.PGDATABASE)}`;
  url.username = process.env.PGUSER; url.password = process.env.PGPASSWORD || '';
  return url;
}
function migrate(url, folder) {
  const r = spawnSync(process.execPath, ['scripts/migrate.cjs'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: folder },
    encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
  });
  return r;
}
const preflightStatements = readFileSync('drizzle/0019_s3_02_reception_invariants.sql', 'utf8')
  .split('--> statement-breakpoint').slice(0, 9).map((s) => s.trim())
  .map((s) => s.replace('SET ROLE tallermecario_schema_owner;',
    'SET LOCAL ROLE tallermecario_schema_owner;'));
async function preflightError(sql) {
  try {
    await sql.begin(async (tx) => {
      for (const statement of preflightStatements) await tx.unsafe(statement);
    });
  } catch (e) { return e; }
  return null;
}
async function dataSnapshot(sql, tenant) {
  const result = {};
  for (const table of ['vehicles', 'receptions', 'service_orders', 'order_status_history',
    'media_assets', 'signatures']) {
    result[table] = (await sql.unsafe(`SELECT row_to_json(t)::text AS value FROM public.${table} t
      WHERE tenant_id=$1 ORDER BY id`, [tenant])).map((r) => r.value);
  }
  return result;
}
async function ledger(sql) {
  const [r] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return r.n;
}
async function seed(sql, kind) {
  const tenant = randomUUID(), vehicle = randomUUID(), customer = randomUUID();
  const user = randomUUID(), member = randomUUID(), reception = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO workshops (id,slug,legal_name,display_name)
      VALUES (${tenant},${`rec-up-${tenant}`},'Test','Test')`;
    await tx`INSERT INTO users (id,external_subject,email)
      VALUES (${user},${user},${`${user}@example.test`})`;
    await tx`INSERT INTO memberships (id,tenant_id,user_id) VALUES (${member},${tenant},${user})`;
    await tx`INSERT INTO customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant},'A','B','3000000000')`;
    await tx`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model,current_mileage_km)
      VALUES (${vehicle},${tenant},${`U${vehicle.slice(0, 6).toUpperCase()}`},'car','B','M',0)`;
    await tx`INSERT INTO receptions (id,tenant_id,vehicle_id,customer_id,received_by_membership_id,mileage_km)
      VALUES (${reception},${tenant},${vehicle},${customer},${member},0)`;
    if (kind === 'duplicate') await tx`INSERT INTO receptions
      (id,tenant_id,vehicle_id,customer_id,received_by_membership_id,mileage_km)
      VALUES (${randomUUID()},${tenant},${vehicle},${customer},${member},0)`;
    if (kind === 'signature') {
      const media = randomUUID();
      await tx`INSERT INTO media_assets
        (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
        VALUES (${media},${tenant},'fixture',${media},'signature','image/png','active','operational','v1')`;
      await tx`INSERT INTO signatures
        (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at)
        VALUES (${randomUUID()},${tenant},${reception},'Fixture',${media},now())`;
    }
    if (['closed','order_open','missing_history'].includes(kind)) {
      const order = randomUUID();
      if (kind !== 'order_open') await tx`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${reception}`;
      await tx`INSERT INTO service_orders
        (id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
        VALUES (${order},${tenant},${reception},${vehicle},${customer},1,${member})`;
      if (kind !== 'missing_history') await tx`INSERT INTO order_status_history
        (id,tenant_id,order_id,to_status,request_id)
        VALUES (${randomUUID()},${tenant},${order},'reception',${randomUUID()})`;
    }
    if (kind === 'mileage') await tx`UPDATE vehicles SET current_mileage_km=1 WHERE id=${vehicle}`;
    if (kind === 'cancelled') await tx`UPDATE receptions SET status='cancelled', closed_at=now() WHERE id=${reception}`;
  });
  return { tenant, reception };
}
async function main() {
  const source = sourceUrl();
  if (!['localhost','127.0.0.1','::1','[::1]'].includes(source.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const maintenance = postgres(source.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const original = new Set((await maintenance`SELECT rolname FROM pg_roles WHERE rolname = ANY(${ROLES})`).map((r) => r.rolname));
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
  assert.equal(journal.entries.length, 20);
  const temp = mkdtempSync(join(tmpdir(), 'tm-reception-upgrade-'));
  const cases = [
    ['valid', null, null],
    ['duplicate', '23505', 'receptions_one_open_vehicle_uq'],
    ['signature', '23514', 'signatures_acceptance_evidence_check'],
    ['closed', '23514', 'receptions_signature_required'],
    ['order_open', '23514', 'service_orders_reception_guard'],
    ['missing_history', '23514', 'service_orders_initial_history_guard'],
    ['mileage', '23514', 'receptions_vehicle_mileage_guard'],
    ['cancelled', '23514', 'receptions_cancelled_preflight'],
  ];
  const names = cases.map(([kind]) =>
    `tm_test_recup_${kind}_${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  const created = [];
  let failure;
  try {
    cpSync('drizzle', temp, { recursive: true });
    writeFileSync(join(temp, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 19) }));
    for (const [index, [kind, expectedCode, expectedConstraint]] of cases.entries()) {
      const name = names[index];
      await maintenance.unsafe(`CREATE DATABASE ${name}`); created.push(name);
      const target = new URL(source); target.pathname = `/${name}`;
      const sql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        assert.equal(migrate(target.toString(), temp).status, 0, '0018 baseline migration');
        assert.equal(await ledger(sql), 19);
        const fixture = await seed(sql, kind);
        const before = await dataSnapshot(sql, fixture.tenant);
        const diagnostic = await preflightError(sql);
        if (expectedCode) {
          assert.ok(diagnostic, `${kind} preflight must reject`);
          assert.equal(diagnostic.code, expectedCode, `${kind}: ${diagnostic.message}`);
          assert.equal(diagnostic.constraint_name, expectedConstraint, `${kind}: ${diagnostic.message}`);
        } else assert.equal(diagnostic, null, 'valid preflight');
        const upgraded = migrate(target.toString(), 'drizzle');
        const rls = async () => {
          const rows = await sql`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN
            ('receptions','signatures','service_orders','order_status_history','vehicles')
            AND relnamespace='public'::regnamespace`;
          assert.equal(rows.length, 5);
          assert.ok(rows.every((row) => row.relforcerowsecurity), 'FORCE RLS restored');
        };
        if (kind === 'valid') {
          assert.equal(upgraded.status, 0, upgraded.stderr);
          assert.equal(await ledger(sql), 20);
          await rls();
          assert.deepEqual(await dataSnapshot(sql, fixture.tenant), before);
          assert.equal(migrate(target.toString(), 'drizzle').status, 0);
          assert.equal(await ledger(sql), 20);
          process.stdout.write('UPGRADE_VALID_PASS 0018 -> 0019; data unchanged; rerun no-op\n');
        } else {
          assert.notEqual(upgraded.status, 0, `${kind} must fail closed`);
          assert.match(upgraded.stderr, /Migration failed\./u);
          assert.equal(await ledger(sql), 19);
          await rls();
          assert.deepEqual(await dataSnapshot(sql, fixture.tenant), before);
          const [objects] = await sql`SELECT
            to_regclass('public.receptions_one_open_vehicle_uq') IS NULL AS no_index,
            NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='signatures'
                AND column_name='document_version') AS no_column`;
          assert.equal(objects.no_index && objects.no_column, true);
          process.stdout.write(`UPGRADE_${kind.toUpperCase()}_FAIL_CLOSED_PASS ledger=19; rollback complete\n`);
        }
      } finally { await sql.end({ timeout: 5 }); }
    }
  } catch (e) { failure = e; }
  finally {
    let cleanupError;
    for (const name of created.reverse()) {
      await maintenance`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=${name} AND pid<>pg_backend_pid()`;
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch((e) => { cleanupError ||= e; });
    }
    for (const role of [...ROLES].reverse()) if (!original.has(role)) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch((e) => { cleanupError ||= e; });
    }
    const [left] = await maintenance`SELECT count(*)::int AS n FROM pg_database WHERE datname=ANY(${names})`;
    rmSync(temp, { recursive: true, force: true });
    process.stdout.write(`RECEPTION_UPGRADE_TEARDOWN dbs=${left.n}\n`);
    await maintenance.end({ timeout: 5 });
    if (cleanupError || left.n !== 0) failure ||= new Error('RECEPTION_UPGRADE_TEARDOWN_FAILED');
  }
  if (failure) throw failure;
}
main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exitCode = 1; });
