'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const postgres = require('postgres');
const { assertMediaIntegritySchema } = require('../dist/media/deployment.js');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const source = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('REFUSING_NON_LOCAL_DATABASE');
  const maintenance = postgres(source.toString(), { max: 1, onnotice: () => {} });
  const previous = mkdtempSync(join(tmpdir(), 'tm-media-upgrade-'));
  const names = [];
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  assert.equal(journal.entries.at(-1).tag, '0025_s4_b02_media_integrity');
  const count = journal.entries.length;
  cpSync('drizzle', previous, { recursive: true });
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }));
  const migrate = (url, folder = 'drizzle') => {
    const result = spawnSync(process.execPath, ['scripts/migrate.cjs'], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: folder } });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    for (const mode of ['fresh', 'upgrade']) {
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
        const before = mode === 'upgrade' ? await sql`SELECT row_to_json(us) AS value FROM upload_sessions us ORDER BY id` : [];
        migrate(url.toString());
        await assertMediaIntegritySchema(sql);
        const [ledger] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(ledger.n, count);
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
        migrate(url.toString());
        const [rerun] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
        assert.equal(rerun.n, count);
        const rls = await sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN
          ('public.media_assets'::regclass,'public.upload_sessions'::regclass)`;
        assert.ok(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
        const [role] = await sql`SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='tallermecario_api'`;
        assert.equal(role.rolbypassrls || role.rolsuper, false);
        process.stdout.write(`MEDIA_${mode.toUpperCase()}_PASS ledger=${count}; rerun no-op; RLS retained\n`);
      } finally { await sql.end({ timeout: 5 }); }
    }
  } finally {
    for (const name of names) await maintenance.unsafe(`DROP DATABASE ${name}`);
    rmSync(previous, { recursive: true, force: true });
    const [remaining] = await maintenance`SELECT count(*)::int AS n FROM pg_database WHERE datname=ANY(${names})`;
    assert.equal(remaining.n, 0); await maintenance.end({ timeout: 5 });
    process.stdout.write('MEDIA_UPGRADE_CLEANUP_PASS databases=0\n');
  }
}
main().catch((error) => { process.stderr.write(`MEDIA_UPGRADE_FAILED ${error.code ?? error.message} ${error.constraint_name ?? ''}\n`); process.exitCode = 1; });
