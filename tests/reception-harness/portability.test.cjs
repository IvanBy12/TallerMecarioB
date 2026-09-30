'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cases: dbCases, replaceMigration } = require('../../scripts/reception-db-mutations.cjs');
const signature = require('../../scripts/signature-api-mutations.cjs');
const close = require('../../scripts/close-api-mutations.cjs');
const queries = require('../../scripts/reception-queries-mutations.cjs');

const variant = (source, newline) => source.replace(/\r\n/gu, '\n').replace(/\n/gu, newline);
for (const [name, from, to, file = '0019_s3_02_reception_invariants.sql'] of dbCases) {
  for (const newline of ['\n', '\r\n']) {
    test(`DB ${name} applies with ${newline === '\n' ? 'LF' : 'CRLF'}`, () => {
      const source = variant(readFileSync(join('drizzle', file), 'utf8'), newline);
      const changed = replaceMigration(source, from, to, name);
      assert.notEqual(changed, source.replace(/\r\n/gu, '\n'));
      assert.ok(changed.includes(to));
    });
  }
  test(`DB ${name} fails for an absent anchor`, () => {
    assert.throws(() => replaceMigration('SELECT 1;', from, to, name),
      /RECEPTION_MUTATION_ANCHOR_NOT_FOUND/u);
  });
}

const harnesses = [
  ['S305_MUTATION', Object.keys(signature.MUTANTS), signature.applySignatureMutation],
  ['S306_MUTATION', close.MUTATION_NAMES, close.applyCloseMutation],
  ['S307_MUTATION', queries.MUTATION_NAMES, queries.applyReceptionQueriesMutation],
];
const files = ['signature.js', 'close.js', 'queries.js', 'queries-validation.js', 'routes.js'];
function withFixture(envKey, name, newline, absent, apply) {
  const folder = mkdtempSync(join(tmpdir(), 'tm-s3-harness-'));
  const previous = process.env[envKey];
  try {
    mkdirSync(join(folder, 'receptions'));
    const originals = new Map();
    for (const file of files) {
      const source = absent ? '' : variant(readFileSync(join('dist/receptions', file), 'utf8'), newline);
      originals.set(file, source);
      writeFileSync(join(folder, 'receptions', file), source);
    }
    process.env[envKey] = name;
    if (absent) assert.throws(() => apply(folder), /MUTATION_ANCHOR_(?:NOT_FOUND|MISSING)/u);
    else {
      apply(folder);
      assert.ok(files.some((file) => readFileSync(join(folder, 'receptions', file), 'utf8')
        .replace(/\r\n/gu, '\n') !== originals.get(file).replace(/\r\n/gu, '\n')),
      `${name}: mutation must actually change compiled code`);
    }
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    rmSync(folder, { recursive: true, force: true });
  }
}
for (const [envKey, names, apply] of harnesses) {
  for (const name of names) {
    for (const newline of ['\n', '\r\n']) {
      test(`${envKey} ${name} applies with ${newline === '\n' ? 'LF' : 'CRLF'}`, () => {
        withFixture(envKey, name, newline, false, apply);
      });
    }
    test(`${envKey} ${name} fails for an absent anchor`, () => {
      withFixture(envKey, name, '\n', true, apply);
    });
  }
}
