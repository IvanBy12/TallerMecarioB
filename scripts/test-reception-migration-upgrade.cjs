'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');

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
// S3-04.5: 0020 preflight = SET ROLE, lock_timeout, LOCK, NO FORCE x2, DO block.
const privacyPreflightStatements = readFileSync('drizzle/0020_s3_04_5_reception_privacy_contract.sql', 'utf8')
  .split('--> statement-breakpoint').slice(0, 6).map((s) => s.trim())
  .map((s) => s.replace('SET ROLE tallermecario_schema_owner;',
    'SET LOCAL ROLE tallermecario_schema_owner;'));
const retentionPreflightStatements = readFileSync('drizzle/0023_s3_reception_signature_retention.sql', 'utf8')
  .split('--> statement-breakpoint').slice(0, 8).map((s) => s.trim())
  .map((s) => s.replace('SET ROLE tallermecario_schema_owner;',
    'SET LOCAL ROLE tallermecario_schema_owner;'));
async function preflightError(sql, statements = preflightStatements) {
  try {
    await sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });
  } catch (e) { return e; }
  return null;
}
async function dataSnapshot(sql, tenant) {
  const result = {};
  for (const table of ['vehicles', 'receptions', 'service_orders', 'order_status_history',
    'media_assets', 'signatures']) {
    result[table] = (await sql.unsafe(`SELECT row_to_json(t)::text AS value FROM public.${table} t
      WHERE tenant_id=$1 ORDER BY id`, [tenant])).map((r) => {
        if (table !== 'media_assets') return r.value;
        const row = JSON.parse(r.value);
        if ('quarantined_at' in row) {
          assert.equal(row.quarantined_at, null, 'upgrade must not invent historical quarantine clocks');
          assert.equal(row.integrity_failure_code, null, 'upgrade must not invent integrity findings');
          delete row.quarantined_at; delete row.integrity_failure_code;
        }
        return JSON.stringify(row);
      });
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
/** 0019-shaped legacy data: no privacy_consent_id, no hash/snapshot columns exist yet. */
async function seedPrivacy(sql, kind) {
  const tenant = randomUUID(), vehicle = randomUUID(), customer = randomUUID();
  const user = randomUUID(), member = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO workshops (id,slug,legal_name,display_name)
      VALUES (${tenant},${`priv-up-${tenant}`},'Test','Test')`;
    await tx`INSERT INTO users (id,external_subject,email) VALUES (${user},${user},${`${user}@example.test`})`;
    await tx`INSERT INTO memberships (id,tenant_id,user_id) VALUES (${member},${tenant},${user})`;
    await tx`INSERT INTO customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant},'A','B','3000000000')`;
    await tx`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
      VALUES (${vehicle},${tenant},${`P${vehicle.slice(0, 6).toUpperCase()}`},'car','B','M')`;
    await tx`INSERT INTO vehicle_owners (id,tenant_id,vehicle_id,customer_id)
      VALUES (${randomUUID()},${tenant},${vehicle},${customer})`;
    if (kind === 'legacy_reception' || kind === 'legacy_both') await tx`INSERT INTO receptions
      (id,tenant_id,vehicle_id,customer_id,received_by_membership_id,mileage_km)
      VALUES (${randomUUID()},${tenant},${vehicle},${customer},${member},0)`;
    if (kind === 'legacy_consent' || kind === 'legacy_both') await tx`INSERT INTO privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,channel,captured_at)
      VALUES (${randomUUID()},${tenant},${customer},'service_provision','legacy','legacy','in_person',now())`;
  });
  return tenant;
}
/** 0020-shaped evidence, including a deliberate legacy reuse only in the duplicate case. */
async function seedSingleUse(sql, duplicate, retention = 'authorization_evidence') {
  const tenant = await seedPrivacy(sql, 'clean');
  const [vehicle] = await sql`SELECT id FROM vehicles WHERE tenant_id=${tenant}`;
  const [customer] = await sql`SELECT id FROM customers WHERE tenant_id=${tenant}`;
  const [member] = await sql`SELECT id FROM memberships WHERE tenant_id=${tenant}`;
  const media = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO media_assets
      (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES (${media},${tenant},'fixture',${media},'signature','image/png','active',${retention},'v1')`;
    for (let i = 0; i < (duplicate ? 2 : 1); i += 1) {
      const reception = randomUUID();
      const signedVehicle = i === 0 ? vehicle.id : randomUUID();
      if (i > 0) await tx`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
        VALUES (${signedVehicle},${tenant},${`D${signedVehicle.slice(0, 6).toUpperCase()}`},'car','B','M')`;
      await tx`INSERT INTO receptions
        (id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
        VALUES (${reception},${tenant},${signedVehicle},${customer.id},${randomUUID()},${member.id},0)`;
      await tx`INSERT INTO signatures
        (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at,document_version,document_hash)
        VALUES (${randomUUID()},${tenant},${reception},'Legacy',${media},now(),'v1',${'a'.repeat(64)})`;
    }
  });
  return { tenant, media };
}
async function privacySnapshot(sql, tenant) {
  const result = {};
  for (const table of ['customers', 'vehicles', 'vehicle_owners', 'receptions', 'privacy_consents']) {
    result[table] = (await sql.unsafe(`SELECT row_to_json(t)::text AS value FROM public.${table} t
      WHERE tenant_id=$1 ORDER BY id`, [tenant])).map((r) => r.value);
  }
  return result;
}
/** Every object 0020 touches: columns, triggers, guard functions, constraints, grants. */
async function privacySchema(sql) {
  const columns = (await sql`SELECT table_name, column_name, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name='privacy_consents' AND column_name IN
      ('authorization_text_hash','controller_notice_snapshot')) OR (table_name='receptions'
      AND column_name='privacy_consent_id')) ORDER BY table_name, column_name`)
    .map((r) => [r.table_name, r.column_name, r.is_nullable]);
  const triggers = (await sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
    ('public.receptions'::regclass, 'public.privacy_consents'::regclass)
    AND (tgname LIKE 'receptions_guard_%' OR tgname LIKE 'privacy_consents_%') ORDER BY tgname`)
    .map((r) => r.tgname);
  const functions = (await sql`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='app'::regnamespace
    AND p.proname IN ('enforce_privacy_consent_evidence','enforce_reception_current_owner',
      'enforce_reception_privacy_consent') ORDER BY p.proname`).map((r) => r.proname);
  const constraints = (await sql`SELECT conname FROM pg_constraint WHERE conrelid IN
    ('public.receptions'::regclass, 'public.privacy_consents'::regclass) ORDER BY conname`)
    .map((r) => r.conname);
  const [grants] = await sql`SELECT has_table_privilege('tallermecario_api','public.privacy_consents','UPDATE') AS api_update,
    has_table_privilege('tallermecario_worker','public.privacy_consents','UPDATE') AS worker_update,
    to_regclass('public.receptions_privacy_consent_idx') IS NOT NULL AS consent_index`;
  return { columns, triggers, functions, constraints, grants: { ...grants } };
}
async function main() {
  const source = sourceUrl();
  if (!['localhost','127.0.0.1','::1','[::1]'].includes(source.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const maintenance = postgres(source.toString(), { max: 1, prepare: false, onnotice: () => {} });
  const original = new Set((await maintenance`SELECT rolname FROM pg_roles WHERE rolname = ANY(${ROLES})`).map((r) => r.rolname));
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json','utf8'));
  assert.equal(journal.entries.length, expectedMigrationCount());
  // 0019 cases upgrade to a 0019 head: their valid fixture holds a legacy
  // reception, which 0020 deliberately refuses (fail closed, covered below).
  const head19 = mkdtempSync(join(tmpdir(), 'tm-reception-head19-'));
  const head20 = mkdtempSync(join(tmpdir(), 'tm-reception-head20-'));
  const head22 = mkdtempSync(join(tmpdir(), 'tm-reception-head22-'));
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
  const privacyCases = [
    ['clean', null],
    ['legacy_reception', 'receptions_privacy_consent_preflight'],
    ['legacy_consent', 'privacy_consents_evidence_preflight'],
    // Both present: the reception check reports first, deterministically.
    ['legacy_both', 'receptions_privacy_consent_preflight'],
  ];
  const privacyNames = privacyCases.map(([kind]) =>
    `tm_test_recup_p${kind.slice(0, 10)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  names.push(...privacyNames);
  const singleUseNames = [false, true].map((duplicate) =>
    `tm_test_recup_s${duplicate ? 'dup' : 'clean'}_${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  names.push(...singleUseNames);
  const retentionCases = ['clean', 'valid', 'wrong', 'quarantined', 'delivery'];
  const retentionNames = retentionCases.map((kind) =>
    `tm_test_recup_r${kind}_${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  names.push(...retentionNames);
  const created = [];
  let failure;
  try {
    cpSync('drizzle', temp, { recursive: true });
    writeFileSync(join(temp, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 19) }));
    cpSync('drizzle', head19, { recursive: true });
    writeFileSync(join(head19, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 20) }));
    cpSync('drizzle', head20, { recursive: true });
    writeFileSync(join(head20, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 21) }));
    cpSync('drizzle', head22, { recursive: true });
    writeFileSync(join(head22, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 23) }));
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
        const upgraded = migrate(target.toString(), head19);
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
          assert.equal(migrate(target.toString(), head19).status, 0);
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
    // ---- S3-04.5: 0019 -> 0020 fails closed on unverifiable legacy evidence ----
    for (const [index, [kind, expectedConstraint]] of privacyCases.entries()) {
      const name = privacyNames[index];
      await maintenance.unsafe(`CREATE DATABASE ${name}`); created.push(name);
      const target = new URL(source); target.pathname = `/${name}`;
      const sql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        assert.equal(migrate(target.toString(), head19).status, 0, '0019 baseline migration');
        assert.equal(await ledger(sql), 20);
        const tenant = await seedPrivacy(sql, kind);
        const before = await privacySnapshot(sql, tenant);
        const schemaBefore = await privacySchema(sql);
        const diagnostic = await preflightError(sql, privacyPreflightStatements);
        const forced = async () => {
          const rows = await sql`SELECT relforcerowsecurity FROM pg_class WHERE relname IN
            ('receptions','privacy_consents') AND relnamespace='public'::regnamespace`;
          assert.equal(rows.length, 2);
          assert.ok(rows.every((row) => row.relforcerowsecurity), 'FORCE RLS restored');
        };
        const upgraded = migrate(target.toString(), 'drizzle');
        if (!expectedConstraint) {
          assert.equal(diagnostic, null, 'clean preflight');
          assert.equal(upgraded.status, 0, upgraded.stderr);
          assert.equal(await ledger(sql), expectedMigrationCount());
          await forced();
          assert.deepEqual(await privacySnapshot(sql, tenant), before);
          const schemaAfter = await privacySchema(sql);
          assert.deepEqual(schemaAfter.columns, [['privacy_consents', 'authorization_text_hash', 'NO'],
            ['privacy_consents', 'controller_notice_snapshot', 'NO'], ['receptions', 'privacy_consent_id', 'NO']]);
          assert.deepEqual(schemaAfter.triggers, ['privacy_consents_evidence_guard_trg',
            'privacy_consents_evidence_truncate_trg', 'receptions_guard_10_current_owner_trg',
            'receptions_guard_20_privacy_consent_trg']);
          assert.equal(migrate(target.toString(), 'drizzle').status, 0);
          assert.equal(await ledger(sql), expectedMigrationCount());
          assert.deepEqual(await privacySchema(sql), schemaAfter, 'rerun is a no-op');
          process.stdout.write(`UPGRADE_PRIVACY_${kind.toUpperCase()}_PASS 0019 -> 0020; data unchanged; rerun no-op\n`);
        } else {
          assert.ok(diagnostic, `${kind} preflight must reject`);
          assert.equal(diagnostic.code, '23514', `${kind}: ${diagnostic.message}`);
          assert.equal(diagnostic.constraint_name, expectedConstraint, `${kind}: ${diagnostic.message}`);
          assert.notEqual(upgraded.status, 0, `${kind} must fail closed`);
          assert.match(upgraded.stderr, /Migration failed\./u);
          assert.equal(await ledger(sql), 20);
          await forced();
          assert.deepEqual(await privacySnapshot(sql, tenant), before);
          assert.deepEqual(await privacySchema(sql), schemaBefore, 'no partial column/trigger/function/grant');
          // Deterministic: a re-run fails the same way and changes nothing.
          assert.notEqual(migrate(target.toString(), 'drizzle').status, 0);
          assert.equal(await ledger(sql), 20);
          assert.deepEqual(await privacySchema(sql), schemaBefore);
          assert.equal((await preflightError(sql, privacyPreflightStatements))?.constraint_name, expectedConstraint);
          process.stdout.write(`UPGRADE_PRIVACY_${kind.toUpperCase()}_FAIL_CLOSED_PASS ledger=20; rollback complete\n`);
        }
      } finally { await sql.end({ timeout: 5 }); }
    }
    // D-SIG-01: 0021 must fail closed on reused legacy media with no dedupe.
    for (const [index, duplicate] of [false, true].entries()) {
      const name = singleUseNames[index];
      await maintenance.unsafe(`CREATE DATABASE ${name}`); created.push(name);
      const target = new URL(source); target.pathname = `/${name}`;
      const sql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        const baseline = migrate(target.toString(), head20);
        assert.equal(baseline.status, 0, baseline.stderr);
        assert.equal(await ledger(sql), 21);
        const { tenant, media } = await seedSingleUse(sql, duplicate);
        const before = await dataSnapshot(sql, tenant);
        const upgrade = migrate(target.toString(), 'drizzle');
        if (duplicate) {
          assert.notEqual(upgrade.status, 0, 'legacy duplicate must fail 0021');
          assert.match(upgrade.stderr, /Migration failed\./u);
          assert.equal(await ledger(sql), 21);
          const [state] = await sql`SELECT to_regclass('public.signatures_one_media_uq') IS NULL AS no_index`;
          assert.equal(state.no_index, true);
          assert.deepEqual(await dataSnapshot(sql, tenant), before);
          assert.equal((await sql`SELECT id FROM signatures WHERE tenant_id=${tenant}
            AND signature_media_id=${media}`).length, 2);
          assert.notEqual(migrate(target.toString(), 'drizzle').status, 0);
          assert.equal(await ledger(sql), 21);
          assert.deepEqual(await dataSnapshot(sql, tenant), before);
          process.stdout.write('UPGRADE_SINGLE_USE_DUPLICATE_FAIL_CLOSED_PASS ledger=21; rows intact; rollback complete\n');
        } else {
          assert.equal(upgrade.status, 0, upgrade.stderr);
          assert.equal(await ledger(sql), expectedMigrationCount());
          const [state] = await sql`SELECT to_regclass('public.signatures_one_media_uq') IS NOT NULL AS indexed`;
          assert.equal(state.indexed, true);
          assert.deepEqual(await dataSnapshot(sql, tenant), before);
          assert.equal(migrate(target.toString(), 'drizzle').status, 0);
          assert.equal(await ledger(sql), expectedMigrationCount());
          process.stdout.write('UPGRADE_SINGLE_USE_CLEAN_PASS 0020 -> 0022; rows intact; rerun no-op\n');
        }
      } finally { await sql.end({ timeout: 5 }); }
    }
    // 0022 -> 0023: inspect all tenants, fail without rewriting evidence, preserve quarantine.
    for (const [index, kind] of retentionCases.entries()) {
      const name = retentionNames[index];
      await maintenance.unsafe(`CREATE DATABASE ${name}`); created.push(name);
      const target = new URL(source); target.pathname = `/${name}`;
      const sql = postgres(target.toString(), { max: 2, prepare: false, onnotice: () => {} });
      try {
        const baseline = migrate(target.toString(), head22);
        assert.equal(baseline.status, 0, baseline.stderr);
        assert.equal(await ledger(sql), 23);
        const tenants = [];
        if (kind !== 'clean') {
          // A valid first tenant must never hide incompatible evidence in a second tenant.
          const valid = await seedSingleUse(sql, false); tenants.push(valid.tenant);
          const fixture = await seedSingleUse(sql, false,
            ['wrong', 'delivery'].includes(kind) ? 'operational' : 'authorization_evidence');
          tenants.push(fixture.tenant);
          if (kind === 'quarantined') await sql`UPDATE media_assets SET status='quarantined' WHERE id=${fixture.media}`;
          if (kind === 'delivery') await sql.begin(async (tx) => {
            await tx`SET LOCAL session_replication_role = replica`;
            await tx`UPDATE signatures SET reception_id=NULL,delivery_id=${randomUUID()}
              WHERE tenant_id=${fixture.tenant}`;
          });
        }
        const snapshots = async () => Promise.all(tenants.map((tenant) => dataSnapshot(sql, tenant)));
        const before = await snapshots();
        const schema = async () => {
          const functions = await sql`SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
            WHERE pronamespace='app'::regnamespace
              AND proname IN ('enforce_reception_signature','enforce_signed_media_active') ORDER BY proname`;
          const trigger = await sql`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
            WHERE tgrelid='public.media_assets'::regclass AND tgname='media_signed_active_trg'`;
          const rls = await sql`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
            WHERE oid IN ('public.signatures'::regclass,'public.media_assets'::regclass) ORDER BY relname`;
          const grants = await sql`SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name IN ('signatures','media_assets')
              ORDER BY grantee,table_name,privilege_type`;
          return { functions: [...functions], trigger: [...trigger], rls: [...rls], grants: [...grants] };
        };
        const beforeSchema = await schema();
        const diagnostic = await preflightError(sql, retentionPreflightStatements);
        assert.deepEqual(await schema(), beforeSchema, 'diagnostic restores FORCE RLS');
        const upgraded = migrate(target.toString(), 'drizzle');
        if (kind === 'wrong') {
          assert.equal(diagnostic?.code, '23514');
          assert.equal(diagnostic?.constraint_name, 'reception_signature_retention_preflight');
          assert.notEqual(upgraded.status, 0, 'wrong historical retention must fail');
          assert.equal(await ledger(sql), 23);
          assert.deepEqual(await schema(), beforeSchema, 'full rollback of guards, trigger, RLS and grants');
          assert.notEqual(migrate(target.toString(), 'drizzle').status, 0, 'rerun fails deterministically');
          assert.equal(await ledger(sql), 23);
        } else {
          assert.equal(diagnostic, null);
          assert.equal(upgraded.status, 0, upgraded.stderr);
          assert.equal(await ledger(sql), expectedMigrationCount());
          const afterSchema = await schema();
          assert.deepEqual(afterSchema.rls, beforeSchema.rls);
          assert.ok(afterSchema.rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
          // This scenario upgrades through HEAD: 0027 intentionally replaces only
          // media_assets API/worker broad UPDATE. All other grants remain intact.
          assert.deepEqual(afterSchema.grants, beforeSchema.grants.filter(g => !(g.table_name==='media_assets'
            && g.privilege_type==='UPDATE' && ['tallermecario_api','tallermecario_worker'].includes(g.grantee))));
          const columns = await sql`SELECT attname FROM pg_attribute WHERE attrelid='public.media_assets'::regclass
            AND attnum>0 AND NOT attisdropped`;
          const allowed = ['status','size_bytes','checksum_sha256','uploaded_at','quarantined_at',
            'integrity_failure_code','updated_at','retention_until'];
          for (const role of ['tallermecario_api','tallermecario_worker']) {
            const [table] = await sql`SELECT has_table_privilege(${role},'public.media_assets','UPDATE') broad`;
            assert.equal(table.broad,false);
            for (const {attname} of columns) {
              const [column] = await sql`SELECT has_column_privilege(${role},'public.media_assets',${attname},'UPDATE') allowed`;
              assert.equal(column.allowed,role==='tallermecario_api' && allowed.includes(attname),`${role}.${attname}`);
            }
          }
          assert.match(afterSchema.trigger[0].definition, /retention_class/u);
          assert.equal(migrate(target.toString(), 'drizzle').status, 0, 'rerun no-op');
          assert.deepEqual(await schema(), afterSchema);
        }
        assert.deepEqual(await snapshots(), before, 'all historical evidence remains byte-for-byte unchanged');
        process.stdout.write(`UPGRADE_RETENTION_${kind.toUpperCase()}_PASS ledger=${kind === 'wrong' ? 23 : expectedMigrationCount()}; evidence unchanged\n`);
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
    rmSync(head19, { recursive: true, force: true });
    rmSync(head20, { recursive: true, force: true });
    rmSync(head22, { recursive: true, force: true });
    process.stdout.write(`RECEPTION_UPGRADE_TEARDOWN dbs=${left.n}\n`);
    await maintenance.end({ timeout: 5 });
    if (cleanupError || left.n !== 0) failure ||= new Error('RECEPTION_UPGRADE_TEARDOWN_FAILED');
  }
  if (failure) throw failure;
}
main().catch((e) => { process.stderr.write(`${e.stack || e.message}\n`); process.exitCode = 1; });
