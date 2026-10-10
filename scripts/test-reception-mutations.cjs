'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Mutation anchors use LF; checked-in migrations may have CRLF on Windows.
const migrations = new Map([
  ['0019_s3_02_reception_invariants.sql',
    readFileSync('drizzle/0019_s3_02_reception_invariants.sql', 'utf8').replace(/\r\n/gu, '\n')],
  ['0020_s3_04_5_reception_privacy_contract.sql',
    readFileSync('drizzle/0020_s3_04_5_reception_privacy_contract.sql', 'utf8').replace(/\r\n/gu, '\n')],
  ['0021_s3_05_signature_media_single_use.sql',
    readFileSync('drizzle/0021_s3_05_signature_media_single_use.sql', 'utf8').replace(/\r\n/gu, '\n')],
  ['0022_s3_05_signed_media_quarantine.sql',
    readFileSync('drizzle/0022_s3_05_signed_media_quarantine.sql', 'utf8').replace(/\r\n/gu, '\n')],
  ['0023_s3_reception_signature_retention.sql',
    readFileSync('drizzle/0023_s3_reception_signature_retention.sql', 'utf8').replace(/\r\n/gu, '\n')],
  ['0024_reception_close_without_signature.sql',
    readFileSync('drizzle/0024_reception_close_without_signature.sql', 'utf8').replace(/\r\n/gu, '\n')],
]);
migrations.set('0029_s4_b06_media_delete_purge.sql',readFileSync('drizzle/0029_s4_b06_media_delete_purge.sql','utf8').replace(/\r\n/gu,'\n'));
const { cases, replaceMigration } = require('./reception-db-mutations.cjs');

const temporary = mkdtempSync(join(tmpdir(), 'tm-reception-mutants-'));
try {
  for (const [name, from, to, file = '0019_s3_02_reception_invariants.sql'] of cases) {
    const folder = join(temporary, name);
    cpSync('drizzle', folder, { recursive: true });
    const original = migrations.get(file);
    assert.ok(original, `${name} migration source missing`);
    const changed = replaceMigration(original, from, to, name);
    assert.ok(changed !== original, `${name} mutation target missing`);
    writeFileSync(join(folder, file), changed);
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
process.stdout.write(`RECEPTION_MUTATION_COUNTS killed=${cases.length} survived=0 invalid_apply_failures=0\n`);
