'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');

/**
 * S3 reception contract reads (docs/api/reception-contract.md): each mutant
 * breaks the compiled tree and must be killed by tests/reception-api/contract.test.cjs.
 * FORCE RLS masks omitted tenant predicates; a separate assertion pins that backstop.
 */
const MUTANTS = Object.freeze({
  list_remove_tenant: ['privacy/consent-service.js',
    'WHERE c.tenant_id = ${tenant.tenantId} AND c.customer_id = ${customerId}',
    'WHERE c.customer_id = ${customerId}'],
  list_remove_customer_tenant: ['privacy/consent-service.js',
    'WHERE tenant_id = ${tenant.tenantId} AND id = ${customerId}', 'WHERE id = ${customerId}'],
  notice_remove_tenant: ['privacy/consent-service.js',
    'WHERE w.id = ${tenant.tenantId}', 'WHERE true'],
  list_include_revoked: ['privacy/consent-service.js',
    "      AND c.status = 'granted' AND c.revoked_at IS NULL\n", ''],
  list_ignore_purpose: ['privacy/consent-service.js',
    'sql `AND c.purpose_code = ${purposeCode}`', 'sql ``'],
  list_skip_customer_check: ['privacy/consent-service.js',
    '    if (!customer)\n        throw customerNotFound();\n    const rows', '    const rows'],
  list_accept_any_status: ['privacy/validation.js', "if (status !== 'granted')", 'if (false)'],
  list_permission_widened: ['privacy/routes.js',
    "config: { permission: 'privacy_consents.read' }", "config: { permission: 'workshop.read' }"],
  notice_permission_widened: ['privacy/routes.js',
    "config: { permission: 'privacy_consents.capture' }, onRequest: noStore",
    "config: { permission: 'workshop.read' }, onRequest: noStore"],
  notice_skip_configured: ['privacy/consent-service.js',
    '    if (!snapshot)\n        throw noticeNotConfigured();\n    return { purposeCode,',
    '    return { purposeCode,'],
  notice_leak_hash: ['privacy/consent-service.js',
    'email: snapshot.email, rightsChannel: snapshot.rightsChannel } };',
    "email: snapshot.email, rightsChannel: snapshot.rightsChannel }, authorizationTextHash: 'leak' };"],
  query_accept_unknown_keys: ['privacy/validation.js', '!allowed.includes(key) || ', ''],
  acceptance_accept_query: ['receptions/routes.js',
    'if (Object.keys((request.query ?? {})).length > 0)', 'if (false)'],
  acceptance_accept_body: ['receptions/routes.js',
    "if (request.body !== undefined || request.headers['transfer-encoding'] !== undefined\n            || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))",
    'if (false)'],
  query_accept_duplicates: ['privacy/validation.js',
    'for (const [key, value] of Object.entries((query ?? {}))) {',
    'for (const [key, raw] of Object.entries((query ?? {}))) {\n        const value = Array.isArray(raw) ? raw[0] : raw;'],
  notice_no_store: ['privacy/routes.js',
    "config: { permission: 'privacy_consents.capture' }, onRequest: noStore",
    "config: { permission: 'privacy_consents.capture' }"],
  list_no_store: ['privacy/routes.js',
    "config: { permission: 'privacy_consents.read' }, onRequest: noStore",
    "config: { permission: 'privacy_consents.read' }"],
  acceptance_no_store: ['receptions/routes.js',
    "config: { permission: 'signatures.capture' }, onRequest: noStore",
    "config: { permission: 'signatures.capture' }"],
  acceptance_permission_widened: ['receptions/routes.js',
    "config: { permission: 'signatures.capture' }, onRequest: noStore",
    "config: { permission: 'workshop.read' }, onRequest: noStore"],
});

const MUTATION_NAMES = Object.freeze(Object.keys(MUTANTS));

function applyReceptionContractMutation(compiledRoot) {
  const name = process.env.S3C_MUTATION;
  if (!name) return;
  if (!Object.hasOwn(MUTANTS, name)) throw new Error(`UNKNOWN_S3C_MUTATION ${name}`);
  const [relative, anchor, value] = MUTANTS[name];
  const file = join(compiledRoot, relative);
  const source = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
  if (source.split(anchor).length !== 2) throw new Error(`S3C_MUTATION_ANCHOR_NOT_UNIQUE ${name}`);
  const changed = source.replace(anchor, value);
  try { new Script(changed, { filename: relative }); }
  catch { throw new Error(`S3C_MUTATION_SYNTAX_INVALID ${name}`); }
  writeFileSync(file, changed);
  process.stdout.write(`S3C_MUTATION_APPLIED ${name}\n`);
}

module.exports = { MUTATION_NAMES, applyReceptionContractMutation };
