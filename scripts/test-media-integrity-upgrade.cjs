'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const postgres = require('postgres');
const { assertMediaIntegritySchema } = require('../dist/media/deployment.js');

// Explicit pre-binding (0025) history. Includes an unbound operational
// fixture to prove 0026 does not silently turn fixtures into authorization.
async function seedBindingUpgrade(sql) {
  const tenant = randomUUID(), user = randomUUID(), member = randomUUID();
  const customer = randomUUID(), vehicle = randomUUID(), consent = randomUUID(), reception = randomUUID();
  await sql.begin(async tx => {
    await tx`INSERT INTO workshops(id,slug,legal_name,display_name) VALUES(${tenant},${tenant},'Test','Test')`;
    await tx`INSERT INTO workshop_locations(id,tenant_id,name,address_line,city,department,is_primary)
      VALUES(${randomUUID()},${tenant},'Test','Test','Test','Test',true)`;
    await tx`INSERT INTO users(id,external_subject,email) VALUES(${user},${user},${user+'@example.test'})`;
    await tx`INSERT INTO memberships(id,tenant_id,user_id) VALUES(${member},${tenant},${user})`;
    await tx`INSERT INTO customers(id,tenant_id,first_name,last_name,phone) VALUES(${customer},${tenant},'Test','Test','3000000000')`;
    await tx`INSERT INTO vehicles(id,tenant_id,plate,vehicle_type,brand,model)
      VALUES(${vehicle},${tenant},${'B'+vehicle.replaceAll('-','').slice(0,12).toUpperCase()},'car','Test','Test')`;
    await tx`INSERT INTO vehicle_owners(id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES(${randomUUID()},${tenant},${vehicle},${customer},'owner',true)`;
    await tx`INSERT INTO privacy_consents(id,tenant_id,customer_id,purpose_code,privacy_notice_version,
      authorization_text_version,authorization_text_hash,controller_notice_snapshot,channel,captured_at)
      VALUES(${consent},${tenant},${customer},'service_provision','test','test',${'a'.repeat(64)},
      ${tx.json({legalName:'TEST-ONLY',address:'TEST-ONLY',phone:'+5700000000',email:null,rightsChannel:'TEST-ONLY'})},'in_person',now())`;
    await tx`INSERT INTO receptions(id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
      VALUES(${reception},${tenant},${vehicle},${customer},${consent},${member},0)`;
    await tx`INSERT INTO vehicle_damages(id,tenant_id,reception_id,zone_code,damage_type)
      VALUES(${randomUUID()},${tenant},${reception},'front','scratch')`;
    for (const type of ['signature','photo']) {
      const media = randomUUID(), session = randomUUID();
      await tx`INSERT INTO media_assets(id,tenant_id,bucket,object_key,media_type,mime_type,retention_class,retention_policy_version)
        VALUES(${media},${tenant},'test',${media},${type},'image/png',${type==='photo'?'operational':'authorization_evidence'},'v1')`;
      await tx`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,expires_at,expected_size_bytes)
        VALUES(${session},${tenant},${media},${randomUUID()},now()+interval '1 hour',68)`;
      await tx`INSERT INTO audit_logs(id,tenant_id,actor_type,action,outcome,entity_type,entity_id,metadata_json,request_id)
        VALUES(${randomUUID()},${tenant},'system','media.upload_session_created','success','media_asset',${media},
          ${tx.json({upload_session_id:session})},${randomUUID()})`;
    }
  });
}
async function bindingHistorySnapshot(sql, retention = false, associations = false) {
  const result = {};
  for (const table of ['media_assets','upload_sessions','receptions','privacy_consents','vehicle_damages','audit_logs', ...(retention ? ['signatures','media_upload_bindings'] : []), ...(associations ? ['reception_media','damage_media'] : [])]) {
    result[table] = (await sql.unsafe(`SELECT row_to_json(t)::text AS row FROM public.${table} t ORDER BY ${table === 'media_upload_bindings' ? 'tenant_id,upload_session_id' : table === 'reception_media' ? 'tenant_id,reception_id,media_asset_id,purpose' : table === 'damage_media' ? 'tenant_id,damage_id,media_asset_id,purpose' : 'id'}`)).map(r=>r.row);
  }
  return result;
}

// 0027 history: real pending authorization, completion, canonical association.
// No guard bypass is needed; 0028 preserves every durable row exactly.
async function seedAssociationUpgrade(sql, incompatible) {
  await seedBindingUpgrade(sql);
  const [p]=await sql`SELECT m.id,m.tenant_id,us.id session,r.id reception,r.privacy_consent_id consent,d.id damage
    FROM media_assets m JOIN upload_sessions us ON us.tenant_id=m.tenant_id AND us.media_asset_id=m.id
    JOIN receptions r ON r.tenant_id=m.tenant_id JOIN vehicle_damages d ON d.tenant_id=r.tenant_id AND d.reception_id=r.id
    WHERE m.media_type='photo'`;
  const media=randomUUID(),session=randomUUID();
  await sql`INSERT INTO media_assets(id,tenant_id,bucket,object_key,media_type,mime_type,retention_class,retention_policy_version)
    VALUES(${media},${p.tenant_id},'test',${media},'photo','image/png','operational','historical-v0')`;
  await sql`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,expires_at,expected_size_bytes)
    VALUES(${session},${p.tenant_id},${media},${randomUUID()},now()+interval '1 hour',68)`;
  for(const [asset,us,damage] of [[p.id,p.session,null],[media,session,p.damage]]) {
    await sql`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,damage_id,privacy_consent_id)
      VALUES(${p.tenant_id},${us},${p.reception},${damage},${p.consent})`;
    await sql`UPDATE upload_sessions SET status='completed',completed_at=now() WHERE id=${us}`;
    await sql`UPDATE media_assets SET status='active',uploaded_at=now(),retention_until='2040-01-01',legal_hold_until='2041-01-01' WHERE id=${asset}`;
  }
  await sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose,sort_order)
    VALUES(${p.tenant_id},${p.reception},${p.id},${incompatible==='reception'?'legacy-custom':'intake_evidence'},3)`;
  await sql`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose,sort_order)
    VALUES(${p.tenant_id},${p.damage},${media},${incompatible==='damage'?'legacy-custom':'damage_evidence'},3)`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const source = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const maintenance = postgres(source.toString(), { max: 1, onnotice: () => {} });
  const previous = mkdtempSync(join(tmpdir(), 'tm-media-upgrade-'));
  const bindingPrevious = mkdtempSync(join(tmpdir(), 'tm-binding-upgrade-'));
  const retentionPrevious = mkdtempSync(join(tmpdir(), 'tm-retention-upgrade-'));
  const associationPrevious = mkdtempSync(join(tmpdir(), 'tm-association-upgrade-'));
  const names = [];
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const index0025 = journal.entries.findIndex(entry => entry.tag === '0025_s4_b02_media_integrity');
  const index0026 = journal.entries.findIndex(entry => entry.tag === '0026_s4_b04_media_upload_bindings');
  assert.ok(index0025 >= 0, 'pre-binding migration exists');
  assert.ok(index0026 >= 0, 'binding migration exists');
  assert.equal(index0026, index0025 + 1, 'B04 immediately follows the B02 boundary');
  const index0027 = journal.entries.findIndex(entry => entry.tag === '0027_s4_b05_media_retention_guards');
  assert.equal(index0027, index0026 + 1);
  const index0028=journal.entries.findIndex(entry=>entry.tag==='0028_s4_b04_media_associations');
  assert.equal(index0028,index0027+1);
  const latest = journal.entries.at(-1);
  assert.ok(latest, 'migration journal is not empty');
  const count = journal.entries.length;
  cpSync('drizzle', previous, { recursive: true });
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index0025) }));
  cpSync('drizzle', bindingPrevious, { recursive: true });
  writeFileSync(join(bindingPrevious, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index0026) }));
  cpSync('drizzle', retentionPrevious, { recursive: true });
  writeFileSync(join(retentionPrevious, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, index0027) }));
  cpSync('drizzle', associationPrevious, { recursive:true });
  writeFileSync(join(associationPrevious,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,index0028)}));
  const migrate = (url, folder = 'drizzle') => {
    const result = spawnSync(process.execPath, ['scripts/migrate.cjs'], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: folder } });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const mode of ['fresh', 'upgrade', 'binding_upgrade', 'retention_upgrade', 'association_upgrade', 'association_incompatible_reception', 'association_incompatible_damage']) {
      const name = `tm_media_${mode}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await maintenance.unsafe(`CREATE DATABASE ${name}`); names.push(name);
      const url = new URL(source); url.pathname = `/${name}`;
      const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
      try {
        let ids = [];
        if (mode === 'upgrade') {
          migrate(url.toString(), previous);
          await assert.rejects(assertMediaIntegritySchema(sql), /MEDIA_INTEGRITY_SCHEMA_INCOMPATIBLE/);
          const tenant = randomUUID();
          await sql.begin(async (tx) => {
            await tx`INSERT INTO workshops (id,slug,legal_name,display_name) VALUES (${tenant},${tenant},'Upgrade','Upgrade')`;
            await tx`INSERT INTO workshop_locations (id,tenant_id,name,address_line,city,department,is_primary)
              VALUES (${randomUUID()},${tenant},'Primary','Test address','Test city','Test department',true)`;
          });
          for (const [sessionStatus, assetStatus] of [['pending', 'pending_upload'], ['completed', 'active'], ['failed', 'quarantined']]) {
            const media = randomUUID(), session = randomUUID(); ids.push(session);
            await sql`INSERT INTO media_assets (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
              VALUES (${media},${tenant},'fixture',${media},'signature','image/png',${assetStatus},'authorization_evidence','v1')`;
            await sql`INSERT INTO upload_sessions (id,tenant_id,media_asset_id,idempotency_key,status,expires_at,completed_at)
              VALUES (${session},${tenant},${media},${randomUUID()},${sessionStatus},now()+interval '1 hour',
                ${sessionStatus === 'completed' ? new Date() : null})`;
          }
        }
        let bindingBefore, retentionBefore, signedGuardBefore, associationBefore;
        if (mode === 'binding_upgrade') {
          migrate(url.toString(), bindingPrevious);
          await seedBindingUpgrade(sql);
          bindingBefore = await bindingHistorySnapshot(sql);
        }
        const signedGuard = async () => (await sql`SELECT pg_get_triggerdef(t.oid) trigger,
          pg_get_functiondef(t.tgfoid) function FROM pg_trigger t
          WHERE t.tgrelid='public.media_assets'::regclass AND t.tgname='media_signed_active_trg'`)[0];
        if (mode === 'retention_upgrade') {
          migrate(url.toString(), retentionPrevious);
          await seedBindingUpgrade(sql);
          const [photo] = await sql`SELECT m.id,m.tenant_id,us.id session,r.id reception,r.privacy_consent_id consent
            FROM media_assets m JOIN upload_sessions us ON us.media_asset_id=m.id AND us.tenant_id=m.tenant_id
            JOIN receptions r ON r.tenant_id=m.tenant_id WHERE m.media_type='photo'`;
          await sql`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,privacy_consent_id)
            VALUES(${photo.tenant_id},${photo.session},${photo.reception},${photo.consent})`;
          await sql`UPDATE media_assets SET retention_policy_version='historical-v0',retention_until='2040-01-01',legal_hold_until='2041-01-01'
            WHERE id=${photo.id}`;
          const [signature] = await sql`SELECT id FROM media_assets WHERE media_type='signature'`;
          await sql`UPDATE media_assets SET status='active',uploaded_at=now() WHERE id=${signature.id}`;
          await sql`UPDATE upload_sessions SET status='completed',completed_at=now() WHERE media_asset_id=${signature.id}`;
          await sql`INSERT INTO signatures(id,tenant_id,reception_id,signature_media_id,signed_by_name,document_version,document_hash,signed_at)
            VALUES(${randomUUID()},${photo.tenant_id},${photo.reception},${signature.id},'TEST','TEST','TEST',now())`;
          retentionBefore = await bindingHistorySnapshot(sql, true);
          signedGuardBefore = await signedGuard();
        }
        if(mode.startsWith('association_')) {
          migrate(url.toString(),associationPrevious);
          await seedAssociationUpgrade(sql,mode==='association_incompatible_reception'?'reception':mode==='association_incompatible_damage'?'damage':null);
          associationBefore=await bindingHistorySnapshot(sql,true,true);
          if(mode.includes('incompatible')) {
            const {drizzle}=require('drizzle-orm/postgres-js');
            const {migrate:runMigration}=require('drizzle-orm/postgres-js/migrator');
            await assert.rejects(runMigration(drizzle(sql),{migrationsFolder:'drizzle'}),error=>{
              const cause=error.cause??error;
              assert.equal(cause.code,'23514');
              assert.equal(cause.constraint_name,mode.endsWith('reception')?'reception_media_purpose_preflight':'damage_media_purpose_preflight');return true;
            });
            assert.deepEqual(await bindingHistorySnapshot(sql,true,true),associationBefore,'preflight does not coerce history');
            const [ledger]=await sql`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`;
            assert.equal(ledger.n,index0028,'migration rollback keeps 0027 ledger');
            const [policy]=await sql`SELECT count(*)::int n FROM pg_policies WHERE policyname='b04_owner_preflight'`;
            assert.equal(policy.n,0,'temporary preflight policies roll back');
            process.stdout.write(`MEDIA_${mode.toUpperCase()}_PASS clear preflight abort; no data/ledger/privilege rewrite\n`);
            continue;
          }
        }
        const before = mode === 'upgrade'  ? await sql`SELECT row_to_json(us) AS value FROM upload_sessions us ORDER BY id` : [];
        migrate(url.toString());
        await assertMediaIntegritySchema(sql);
        const [ledger] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(ledger.n, count);
        const [latestLedger] = await sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1`;
        assert.equal(Number(latestLedger.created_at), latest.when, `latest migration ${latest.tag}`);
        if (mode === 'upgrade') {
          const after = await sql`SELECT row_to_json(us) AS value FROM upload_sessions us ORDER BY id`;
          assert.equal(after.length, ids.length);
          after.forEach((row, i) => {
            assert.equal(row.value.integrity_version, 'legacy'); assert.equal(row.value.expected_size_bytes, null);
            const { integrity_version: _version, expected_size_bytes: _expected, ...legacy } = row.value;
            assert.deepEqual(legacy, before[i].value);
          });
          const assets = await sql`SELECT quarantined_at,integrity_failure_code FROM media_assets`;
          assert.ok(assets.every((r) => r.quarantined_at === null && r.integrity_failure_code === null), 'no fabricated historical quarantine clock');
        }
        if (bindingBefore) {
          assert.deepEqual(await bindingHistorySnapshot(sql), bindingBefore);
          process.stdout.write('MEDIA_PRE_BINDING_HISTORY_PRESERVED_PASS no fabricated authorization\n');
        }
        const [bindings] = await sql`SELECT count(*)::int AS n FROM media_upload_bindings`;
        assert.equal(bindings.n, mode === 'association_upgrade' ? 2 : mode === 'retention_upgrade' ? 1 : 0, 'no fabricated historical binding/authorization');
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          const [grant] = await sql`SELECT has_table_privilege('tallermecario_api','public.media_upload_bindings',${privilege}) AS allowed`;
          assert.equal(grant.allowed, false);
        }
        const [guard] = await sql`SELECT p.prosecdef FROM pg_proc p
          WHERE p.oid='app.authorize_media_upload_binding()'::regprocedure`;
        assert.equal(guard.prosecdef, false);
        if (retentionBefore) {
          assert.deepEqual(await bindingHistorySnapshot(sql, true), retentionBefore);
          assert.deepEqual(await signedGuard(), signedGuardBefore);
          const [historic] = await sql`SELECT retention_policy_version,retention_until::text,legal_hold_until::text
            FROM media_assets WHERE media_type='photo'`;
          assert.equal(historic.retention_policy_version,'historical-v0');
          assert.match(historic.retention_until,/^2040-01-01/);assert.match(historic.legal_hold_until,/^2041-01-01/);
          process.stdout.write('MEDIA_RETENTION_HISTORY_PRESERVED_PASS assets/signatures/sessions/bindings/audits unchanged\n');
        }
        if(associationBefore) {
          assert.deepEqual(await bindingHistorySnapshot(sql,true,true),associationBefore);
          process.stdout.write('MEDIA_ASSOCIATION_HISTORY_PRESERVED_PASS assets/associations/bindings/sessions/audits unchanged\n');
        }
        const [associationFunction]=await sql`SELECT p.prosecdef,p.proconfig,owner.rolname owner FROM pg_proc p
          JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid='app.guard_operational_media_association()'::regprocedure`;
        assert.equal(associationFunction.prosecdef,false);assert.equal(associationFunction.owner,'tallermecario_schema_owner');
        assert.ok(associationFunction.proconfig.includes('search_path=pg_catalog'));
        for(const table of ['reception_media','damage_media']) {
          for(const role of ['tallermecario_api','tallermecario_worker'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
            const [r]=await sql`SELECT has_table_privilege(${role},${'public.'+table},${privilege}) allowed`;
            assert.equal(r.allowed,role==='tallermecario_api'&&['SELECT','INSERT'].includes(privilege));
          }
        }
        const functions = await sql`SELECT p.prosecdef,p.proconfig,owner.rolname owner FROM pg_proc p
          JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid IN
          ('app.enforce_media_retention_monotonic()'::regprocedure,'app.enforce_media_delete_lifecycle_unavailable()'::regprocedure)`;
        assert.equal(functions.length,2);
        assert.ok(functions.every(f=>!f.prosecdef&&f.owner==='tallermecario_schema_owner'&&f.proconfig.includes('search_path=pg_catalog')));
        for (const role of ['tallermecario_api','tallermecario_worker']) {
          const [privilege] = await sql`SELECT has_table_privilege(${role},'public.media_assets','UPDATE') broad`;
          assert.equal(privilege.broad,false);
        }
        migrate(url.toString());
        if (associationBefore) assert.deepEqual(await bindingHistorySnapshot(sql,true,true),associationBefore);
        if (retentionBefore) assert.deepEqual(await bindingHistorySnapshot(sql, true), retentionBefore);
        if (bindingBefore) assert.deepEqual(await bindingHistorySnapshot(sql), bindingBefore);
        const [rerun] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(rerun.n, count);
        const rls = await sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN
          ('public.media_assets'::regclass,'public.upload_sessions'::regclass,'public.media_upload_bindings'::regclass,'public.reception_media'::regclass,'public.damage_media'::regclass)`;
        assert.ok(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
        const [role] = await sql`SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='tallermecario_api'`;
        assert.equal(role.rolbypassrls || role.rolsuper, false);
        process.stdout.write(`MEDIA_${mode.toUpperCase()}_PASS ledger=${count}; rerun no-op; RLS retained\n`);
      } finally { await sql.end({ timeout: 5 }); }
    }
  } finally {
    for (const name of names) await maintenance.unsafe(`DROP DATABASE ${name}`);
    rmSync(previous, { recursive: true, force: true });
    rmSync(bindingPrevious, { recursive: true, force: true });
    rmSync(retentionPrevious, { recursive: true, force: true });
    rmSync(associationPrevious, {recursive:true,force:true});
    const [remaining] = await maintenance`SELECT count(*)::int AS n FROM pg_database WHERE datname=ANY(${names})`;
    assert.equal(remaining.n, 0); await maintenance.end({ timeout: 5 });
    process.stdout.write('MEDIA_UPGRADE_CLEANUP_PASS databases=0\n');
  }
}
main().catch((error) => { process.stderr.write(`MEDIA_UPGRADE_FAILED ${error.code ?? error.message} ${error.constraint_name ?? ''}\n`); process.exitCode = 1; });
