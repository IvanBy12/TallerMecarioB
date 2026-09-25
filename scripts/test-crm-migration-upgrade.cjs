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
  const u = new URL('postgresql://localhost');
  u.hostname = process.env.PGHOST; u.port = process.env.PGPORT || '5432';
  u.pathname = `/${encodeURIComponent(process.env.PGDATABASE)}`;
  u.username = process.env.PGUSER; u.password = process.env.PGPASSWORD || '';
  return u;
}
function migrate(url, folder) {
  const r = spawnSync(process.execPath, ['scripts/migrate.cjs'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: folder },
    encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
  });
  return r.status === 0;
}
async function verifyPreflight(sql, folder) {
  const migration = readFileSync(join(folder,'0018_s2_03_crm_hardening.sql'),'utf8');
  const parts = migration.split('--> statement-breakpoint').map((part) => part.trim());
  const force = parts.findIndex((part) => part.startsWith('ALTER TABLE public.vehicles FORCE ROW LEVEL SECURITY'));
  assert.ok(force > 0, 'preflight FORCE marker');
  let failure;
  try {
    await sql.begin(async (tx) => {
      for (const part of parts.slice(0,force)) await tx.unsafe(part);
    });
  } catch (e) { failure=e; }
  assert.equal(failure?.code,'23514','preflight must see legacy rows before ADD CONSTRAINT');
  assert.equal(failure?.constraint_name,'vehicles_plate_normalized_check');
  assert.match(failure.message,/legacy plate requires explicit remediation/u);
}
async function ledger(sql) {
  const [r] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
  return r.n;
}
async function rows(sql) {
  const result = [];
  for (const table of ['customers','vehicles','vehicle_owners']) {
    const data = await sql.unsafe(`SELECT row_to_json(t)::text AS value FROM public.${table} t ORDER BY id`);
    result.push(data.map((r) => r.value));
  }
  return result;
}
async function seed(sql, plates) {
  const tenant = randomUUID(), customer = randomUUID();
  const vehicles = plates.map(() => randomUUID());
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO workshops (id,slug,legal_name,display_name)
      VALUES (${tenant},${`crm-up-${tenant}`},'CRM','CRM')`;
    await tx`INSERT INTO customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant},'A','B','3000000000')`;
    for (let i = 0; i < plates.length; i++) {
      await tx`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
        VALUES (${vehicles[i]},${tenant},${plates[i]},'car','B','M')`;
    }
    await tx`INSERT INTO vehicle_owners (id,tenant_id,vehicle_id,customer_id)
      VALUES (${randomUUID()},${tenant},${vehicles[0]},${customer})`;
  });
}
async function verify(sql) {
  const [flags] = await sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.vehicles'::regclass`;
  assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
  const [check] = await sql`SELECT convalidated FROM pg_constraint
    WHERE conrelid='public.vehicles'::regclass AND conname='vehicles_plate_normalized_check'`;
  assert.equal(check?.convalidated, true);
  const [trigger] = await sql`SELECT tgenabled FROM pg_trigger
    WHERE tgrelid='public.vehicle_owners'::regclass AND tgname='vehicle_owners_history_guard_trg'`;
  assert.equal(trigger?.tgenabled, 'O');
  const [worker] = await sql`SELECT has_table_privilege('tallermecario_worker','public.customers','SELECT') AS yes`;
  assert.equal(worker.yes, false);
  const [api] = await sql`SELECT has_column_privilege('tallermecario_api','public.vehicle_owners','valid_to','UPDATE') AS yes`;
  assert.equal(api.yes, true);
}
async function verifyRollback(sql, before) {
  assert.equal(await ledger(sql), 18);
  assert.deepEqual(await rows(sql), before);
  const [flags] = await sql`SELECT relforcerowsecurity FROM pg_class WHERE oid='public.vehicles'::regclass`;
  assert.equal(flags.relforcerowsecurity, true);
  const [objects] = await sql`SELECT
    (SELECT count(*)::int FROM pg_constraint WHERE conrelid='public.vehicles'::regclass AND conname='vehicles_plate_normalized_check') AS checks,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='public.vehicle_owners'::regclass AND tgname='vehicle_owners_history_guard_trg') AS triggers,
    (SELECT count(*)::int FROM pg_proc WHERE oid=to_regprocedure('app.enforce_vehicle_owner_history()')) AS functions`;
  assert.deepEqual(objects, { checks: 0, triggers: 0, functions: 0 });
  const [worker] = await sql`SELECT has_table_privilege('tallermecario_worker','public.customers','SELECT') AS yes`;
  const [api] = await sql`SELECT has_table_privilege('tallermecario_api','public.vehicle_owners','UPDATE') AS yes`;
  assert.equal(worker.yes, true);
  assert.equal(api.yes, true);
}
async function main() {
  const source = sourceUrl();
  if (!['localhost','127.0.0.1','::1','[::1]'].includes(source.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const maintenance = postgres(source.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const original = new Set((await maintenance`SELECT rolname FROM pg_roles WHERE rolname = ANY(${ROLES})`).map((r) => r.rolname));
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
  assert.equal(journal.entries.length,19);
  const headFolder = process.env.CRM_HEAD_FOLDER || 'drizzle';
  const temp = mkdtempSync(join(tmpdir(),'tm-crm-upgrade-'));
  const suffix = randomUUID().replaceAll('-','').slice(0,12);
  const dbs = ['u0','u1','u2','u3'].map((x) => `tm_test_crm_${x}_${suffix}`);
  const created = [];
  let failure;
  try {
    cpSync('drizzle',temp,{recursive:true});
    writeFileSync(join(temp,'meta','_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0,18) }));
    for (let i=0;i<4;i++) {
      const name = dbs[i];
      await maintenance.unsafe(`CREATE DATABASE ${name}`); created.push(name);
      const target = new URL(source); target.pathname = `/${name}`;
      const sql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        if (i===0) {
          assert.ok(migrate(target.toString(),headFolder));
          assert.equal(await ledger(sql),19); await verify(sql);
          process.stdout.write('U0 PASS fresh 0000..0018 ledger=19\n');
        } else {
          assert.ok(migrate(target.toString(),temp));
          assert.equal(await ledger(sql),18);
          await seed(sql, i===1 ? ['ABC123'] : i===2 ? ['abc123'] : ['ABC123','abc123']);
          const before = await rows(sql);
          if (i===1) {
            assert.ok(migrate(target.toString(),headFolder));
            assert.equal(await ledger(sql),19);
            assert.deepEqual(await rows(sql),before);
            await verify(sql);
            assert.ok(migrate(target.toString(),headFolder));
            assert.equal(await ledger(sql),19);
            process.stdout.write('U1 PASS valid history unchanged, privileges/RLS/guards, rerun no-op\n');
          } else {
            await verifyPreflight(sql,headFolder);
            assert.equal(migrate(target.toString(),headFolder),false);
            await verifyRollback(sql,before);
            process.stdout.write(`${i===2?'U2':'U3'} PASS fail-closed, ledger=18, rollback complete\n`);
          }
        }
      } finally { await sql.end({timeout:5}); }
    }
  } catch (e) { failure=e; }
  finally {
    let cleanupError;
    for (const name of created.reverse()) {
      await maintenance`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${name} AND pid<>pg_backend_pid()`;
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch((e) => { cleanupError ||= e; });
    }
    for (const role of [...ROLES].reverse()) if (!original.has(role)) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch((e) => { cleanupError ||= e; });
    }
    const [left] = await maintenance`SELECT count(*)::int AS n FROM pg_database WHERE datname=ANY(${dbs})`;
    rmSync(temp,{recursive:true,force:true});
    process.stdout.write(`CRM_UPGRADE_TEARDOWN dbs=${left.n}\n`);
    await maintenance.end({timeout:5});
    if (cleanupError || left.n!==0) failure ||= new Error('CRM_UPGRADE_TEARDOWN_FAILED');
  }
  if (failure) throw failure;
}
main().catch((e) => { process.stderr.write(`${e.code === 'ERR_ASSERTION' ? e.message : e.code || e.message}\n`); process.exitCode=1; });
