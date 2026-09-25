'use strict';

/** Mutations affect only the disposable database or temporary compiled JS. */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MUTATIONS = Object.freeze({
  'disable-memberships-rls': { sql: ['ALTER TABLE public.memberships DISABLE ROW LEVEL SECURITY'] },
  'remove-memberships-force-rls': { sql: ['ALTER TABLE public.memberships NO FORCE ROW LEVEL SECURITY'] },
  'omit-tenant-guc': { js: [['tenancy/tenant-context-db.js',
    "THEN pg_catalog.set_config('app.tenant_id', ${membership.tenantId}, true) END AS tenant_id,",
    'THEN ${membership.tenantId} END AS tenant_id,']] },
  'trust-request-tenant-header': { js: [['api/tenant-request.js',
    'const bound = await (0, tenant_context_db_js_1.bindTenantContext)(sql, validation.membership, { requestId: request.id });',
    "const bound = await (0, tenant_context_db_js_1.bindTenantContext)(sql, validation.membership, { requestId: request.id });\n        await sql`SELECT set_config('app.tenant_id', ${request.headers['x-audit-tenant-id'] ?? bound.tenantId}, true)`;"]] },
  'remove-assigned-by-composite-fk': { sql: ['ALTER TABLE public.membership_roles DROP CONSTRAINT membership_roles_assigned_by_fk'] },
  'session-guc-after-error': { js: [['tenancy/tenant-context-db.js',
    "THEN pg_catalog.set_config('app.tenant_id', ${membership.tenantId}, true) END AS tenant_id,",
    "THEN pg_catalog.set_config('app.tenant_id', ${membership.tenantId}, false) END AS tenant_id,"]] },
  'arbitrary-tenant-lock-helper': { sql: [
    `CREATE FUNCTION app.lock_tenant_owner_set(p_tenant_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog AS $fn$ SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text, 0)) $fn$`,
    'REVOKE ALL ON FUNCTION app.lock_tenant_owner_set(uuid) FROM PUBLIC',
    'GRANT EXECUTE ON FUNCTION app.lock_tenant_owner_set(uuid) TO tallermecario_api, tallermecario_worker',
  ] },
  'worker-claim-tenant-check-removed': { js: [['worker/outbox-worker.js',
    'if (job.outboxEventId !== event.id || job.tenantId !== event.tenantId) {', 'if (false) {']] },
});

async function applyMutation(phase, { admin, compiledRoot } = {}) {
  const name = process.env.S108_MUTATION;
  if (!name) return;
  const mutation = MUTATIONS[name];
  if (!mutation) throw new Error(`UNKNOWN_MUTATION ${name}`);
  if (phase === 'sql') {
    for (const command of mutation.sql ?? []) await admin.unsafe(command);
  } else if (phase === 'js') {
    for (const [file, from, to] of mutation.js ?? []) {
      const path = join(compiledRoot, file);
      const source = readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n');
      const count = source.split(from).length - 1;
      if (count !== 1) throw new Error(`MUTATION_ANCHOR_NOT_FOUND ${name} ${file} (${count})`);
      writeFileSync(path, source.replace(from, () => to));
    }
  }
  process.stdout.write(`S108_MUTATION_APPLIED ${name} ${phase}\n`);
}

module.exports = { MUTATIONS, applyMutation };
