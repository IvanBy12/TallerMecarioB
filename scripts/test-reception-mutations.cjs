'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Mutation anchors use LF; checked-in migrations may have CRLF on Windows.
const original = readFileSync('drizzle/0019_s3_02_reception_invariants.sql', 'utf8').replace(/\r\n/gu, '\n');
const cases = [
  ['transition', "IF OLD.status <> 'open' OR NEW.status NOT IN ('open', 'closed')", 'IF false'],
  ['parent_open', "IF v_status IS DISTINCT FROM 'open' THEN", 'IF false THEN'],
  ['signature_append_only', "IF TG_OP <> 'INSERT' THEN", 'IF false THEN'],
  ['signature_media', "IF v_type IS DISTINCT FROM 'signature' OR v_media_status IS DISTINCT FROM 'active'\n    OR v_deleted_at IS NOT NULL OR v_purged_at IS NOT NULL THEN", 'IF false THEN'],
  ['open_unique', "CREATE UNIQUE INDEX receptions_one_open_vehicle_uq\n  ON public.receptions (tenant_id, vehicle_id) WHERE status = 'open';", 'SELECT 1;'],
  ['mileage', 'IF v_mileage IS NOT NULL AND NEW.mileage_km < v_mileage THEN', 'IF false THEN'],
  ['initial_order_state', "IF TG_OP = 'INSERT' AND (NEW.status IS DISTINCT FROM 'reception'\n    OR NEW.version IS DISTINCT FROM 1 OR NEW.closed_at IS NOT NULL) THEN", 'IF false THEN'],
  ['insert_must_start_open', "IF TG_OP = 'INSERT' AND NEW.status <> 'open' THEN", 'IF false THEN'],
  ['media_share_lock_removed', 'AND m.id = NEW.signature_media_id FOR SHARE;', 'AND m.id = NEW.signature_media_id;'],
];

const temporary = mkdtempSync(join(tmpdir(), 'tm-reception-mutants-'));
try {
  for (const [name, from, to] of cases) {
    const folder = join(temporary, name);
    cpSync('drizzle', folder, { recursive: true });
    const changed = original.replace(from, to);
    assert.ok(changed !== original, `${name} mutation target missing`);
    writeFileSync(join(folder, '0019_s3_02_reception_invariants.sql'), changed);
    const r = spawnSync(process.execPath,
      ['scripts/test-reception-db.cjs'], {
        cwd: process.cwd(), env: { ...process.env, MIGRATIONS_FOLDER: folder },
        encoding: 'utf8', stdio: 'pipe', timeout: 120_000, maxBuffer: 10_000_000,
      });
    if (r.error) throw r.error;
    const match = r.stdout?.match(/RECEPTION_TEST_COUNTS PASS=(\d+) FAIL=(\d+) SKIP=(\d+) TODO=(\d+)/u);
    assert.notEqual(r.status, 0, `${name}: mutant survived`);
    assert.ok(match && Number(match[2]) > 0, `${name}: tests did not kill mutant\n${r.stderr}`);
    assert.match(r.stdout, /RECEPTION_TEARDOWN dbs=0 logins=0/u);
    process.stdout.write(`RECEPTION_MUTANT_${name.toUpperCase()}_KILLED fail=${match[2]}\n`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
