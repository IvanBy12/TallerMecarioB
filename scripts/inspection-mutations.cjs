'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const cases = Object.freeze([
  ['remove_occ', 'inspection.js', 'if (!row.version_matches)', 'if (false)'],
  ['remove_open_check', 'inspection.js', "if (row.status !== 'open')", 'if (false)'],
  ['remove_parent_lock', 'inspection.js', ' FOR NO KEY UPDATE OF r', ''],
  ['freeze_version', 'inspection.js', "GREATEST(pg_catalog.now(), r.updated_at + interval '1 microsecond')", 'r.updated_at'],
  ['remove_damage_reception', 'inspection.js', 'AND reception_id = ${id} AND id = ${item.damageId}', 'AND id = ${item.damageId}'],
  ['drop_checklist_notes', 'inspection.js', 'notes = EXCLUDED.notes', 'notes = NULL'],
  ['omit_audit', 'inspection.js', 'await sql `INSERT INTO public.audit_logs', 'if (false) await sql `INSERT INTO public.audit_logs'],
]);
function applyInspectionMutation(compiledRoot) {
  const name = process.env.S3I_MUTATION;
  if (!name) return;
  const target = cases.find(item => item[0] === name);
  if (!target) throw new Error('UNKNOWN_MUTATION ' + name);
  const [, file, anchor, replacement] = target;
  const path = join(compiledRoot, 'receptions', file);
  const source = readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
  if (!source.includes(anchor)) throw new Error('MUTATION_ANCHOR_NOT_FOUND ' + name);
  writeFileSync(path, source.replace(anchor, replacement));
  process.stdout.write('S3I_MUTATION_APPLIED ' + name + '\n');
}
module.exports = { cases, applyInspectionMutation };
