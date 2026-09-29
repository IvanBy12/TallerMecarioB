'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MUTANTS = Object.freeze({
  open_guard: ["if (reception.status !== 'open')", 'if (false)'],
  version_guard: ['if (!document)', 'if (false)'],
  client_owned_fields: ['if (Object.keys(raw).some((key) => ![', 'if (false && Object.keys(raw).some((key) => !['],
  reception_lock: ['FOR NO KEY UPDATE', ''],
  audit_rollback: ['await sql `INSERT INTO public.audit_logs', 'if (false) await sql `INSERT INTO public.audit_logs'],
});

function applySignatureMutation(compiledRoot) {
  const name = process.env.S305_MUTATION;
  if (!name) return;
  const pair = MUTANTS[name];
  if (!pair) throw new Error(`UNKNOWN_S305_MUTATION ${name}`);
  const file = join(compiledRoot, 'receptions', 'signature.js');
  const original = readFileSync(file, 'utf8');
  if (!original.includes(pair[0])) throw new Error(`S305_MUTATION_ANCHOR_MISSING ${name}`);
  writeFileSync(file, original.replace(pair[0], pair[1]));
  if (name === 'client_owned_fields') {
    const route = join(compiledRoot, 'receptions', 'signature.js');
    const source = readFileSync(route, 'utf8');
    const anchor = "exports.signatureBodySchema = { type: 'object', additionalProperties: false,";
    if (!source.includes(anchor)) throw new Error('S305_MUTATION_ANCHOR_MISSING strict_schema');
    writeFileSync(route, source.replace(anchor,
      "exports.signatureBodySchema = { type: 'object', additionalProperties: true,"));
  }
  process.stdout.write(`S305_MUTATION_APPLIED ${name}\n`);
}

module.exports = { MUTANTS, applySignatureMutation };
