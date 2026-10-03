'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { MUTATION_NAMES, applyReceptionContractMutation } = require('../../scripts/reception-contract-mutations.cjs');
const files = ['privacy/consent-service.js', 'privacy/routes.js', 'privacy/validation.js', 'receptions/routes.js'];
for (const name of MUTATION_NAMES) {
  for (const mode of ['LF', 'CRLF', 'absent', 'duplicate']) {
    test('S3C ' + name + ' ' + mode, () => {
      const folder = mkdtempSync(join(tmpdir(), 'tm-s3-contract-harness-'));
      const previous = process.env.S3C_MUTATION;
      try {
        mkdirSync(join(folder, 'privacy'));
        mkdirSync(join(folder, 'receptions'));
        const originals = new Map();
        for (const file of files) {
          let source = readFileSync(join('dist', file), 'utf8').replace(/\r\n/gu, '\n');
          if (mode === 'CRLF') source = source.replace(/\n/gu, '\r\n');
          if (mode === 'absent') source = '';
          if (mode === 'duplicate') source += source;
          originals.set(file, source);
          writeFileSync(join(folder, file), source);
        }
        process.env.S3C_MUTATION = name;
        if (['absent', 'duplicate'].includes(mode)) {
          assert.throws(() => applyReceptionContractMutation(folder), /S3C_MUTATION_ANCHOR_NOT_UNIQUE/u);
        } else {
          applyReceptionContractMutation(folder);
          assert.equal(files.filter((file) => readFileSync(join(folder, file), 'utf8')
            .replace(/\r\n/gu, '\n') !== originals.get(file).replace(/\r\n/gu, '\n')).length, 1);
        }
      } finally {
        if (previous === undefined) delete process.env.S3C_MUTATION;
        else process.env.S3C_MUTATION = previous;
        rmSync(folder, { recursive: true, force: true });
      }
    });
  }
}
