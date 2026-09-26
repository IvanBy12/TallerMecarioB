'use strict';

/**
 * S2-04 mutation definitions (test tooling only; never touches src/ or the
 * migration files). Selected with S204_MUTATION=<name>; each one rewrites the
 * COMPILED JS of the throwaway compile dir and/or the throwaway test database
 * AFTER a clean migration, so the suite runs against a deliberately broken
 * build. Every anchor must match exactly once, otherwise the run aborts
 * (MUTATION_ANCHOR_NOT_FOUND): a mutation can never silently become a no-op.
 *
 * scripts/test-crm-api-mutations.cjs runs each mutant and requires the suite
 * to FAIL (mutant killed).
 */

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SERVICE = 'customers/service.js';
const ROUTES = 'customers/routes.js';
const VALIDATION = 'customers/validation.js';

const MUTATIONS = {
  // Reads guarded by a permission every member holds (technician included).
  'read-permission': {
    js: [
      [ROUTES, "app.get('/api/v1/customers', {\n        config: { permission: 'customers.read' },", "app.get('/api/v1/customers', {\n        config: { permission: 'workshop.read' },"],
      [ROUTES, "app.get('/api/v1/customers/:customerId', {\n        config: { permission: 'customers.read' },", "app.get('/api/v1/customers/:customerId', {\n        config: { permission: 'workshop.read' },"],
    ],
  },
  // Writes guarded by a permission every member holds.
  'write-permission': {
    js: [
      [ROUTES, "config: { permission: 'customers.create' },", "config: { permission: 'workshop.read' },"],
      [ROUTES, "config: { permission: 'customers.update' },", "config: { permission: 'workshop.read' },"],
    ],
  },
  // Drop BOTH tenant layers: the app-level tenant predicates and the customers RLS policies.
  'tenant-isolation': {
    js: [
      [SERVICE, 'WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${customerId}\n    FOR NO KEY UPDATE OF c', 'WHERE c.id = ${customerId}\n    FOR NO KEY UPDATE OF c'],
      [SERVICE, "WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${customerId}\n  `;\n    if (!row)\n        throw customerError('CUSTOMER_NOT_FOUND');", "WHERE c.id = ${customerId}\n  `;\n    if (!row)\n        throw customerError('CUSTOMER_NOT_FOUND');"],
      [SERVICE, 'WHERE c.tenant_id = ${tenant.tenantId}\n      ${query.afterId', 'WHERE true\n      ${query.afterId'],
    ],
    sql: [
      'ALTER POLICY tenant_select ON public.customers USING (true)',
      'ALTER POLICY tenant_update ON public.customers USING (true) WITH CHECK (true)',
      'ALTER POLICY tenant_insert ON public.customers WITH CHECK (true)',
    ],
  },
  // OCC ignored: silent last-write-wins.
  'occ-check': {
    js: [[SERVICE, 'if (!current.version_matches)', 'if (false)']],
  },
  // Changed fields computed from the request only: no-op PATCHes write and audit.
  'noop-writes': {
    js: [[SERVICE, ' && input.changes[column] !== current[column]);', ');']],
  },
  // updated_at not forced strictly forward.
  'occ-monotonic': {
    js: [[SERVICE, "updated_at = GREATEST(pg_catalog.now(), c.updated_at + interval '1 microsecond')", 'updated_at = pg_catalog.now()']],
  },
  // OCC token round-tripped through a JS Date (milliseconds).
  'date-roundtrip': {
    js: [[SERVICE, 'updatedAt: row.updated_at,', 'updatedAt: new Date(row.updated_at).toISOString(),']],
  },
  // Audit leaks values next to the changed field names.
  'audit-values': {
    js: [[SERVICE, '{ changed_fields: changed }', '{ changed_fields: changed, values: Object.fromEntries(changed.map((column) => [column, merged[column]])) }']],
  },
  // Audit field list not in the canonical order.
  'audit-order': {
    js: [[SERVICE, '{ fields: [...input.fields] }', '{ fields: [...input.fields].reverse() }']],
  },
  // Document pair not re-checked on the merged PATCH state.
  'pair-rule': {
    js: [[SERVICE, 'if (!(0, validation_js_1.documentPairIsValid)(merged))', 'if (false)']],
  },
  // Empty strings stored instead of NULL.
  'empty-to-null': {
    js: [[VALIDATION, "const emptyToNull = (value) => (value === '' ? null : value);", 'const emptyToNull = (value) => value;']],
  },
  // notes loses its LF exception (general control-character rule).
  'notes-lf': {
    js: [[VALIDATION, String.raw`const NOTES_PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;`, String.raw`const NOTES_PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;`]],
  },
  // Name search becomes case-sensitive (no Unicode case mapping).
  'name-case': {
    js: [
      [SERVICE, 'pg_catalog.starts_with(pg_catalog.lower(c.first_name COLLATE "und-x-icu"), pg_catalog.lower(${query.name}::text COLLATE "und-x-icu"))', 'pg_catalog.starts_with(c.first_name, ${query.name}::text)'],
      [SERVICE, 'pg_catalog.starts_with(pg_catalog.lower(c.last_name COLLATE "und-x-icu"), pg_catalog.lower(${query.name}::text COLLATE "und-x-icu"))', 'pg_catalog.starts_with(c.last_name, ${query.name}::text)'],
    ],
  },
  // Keyset cursor includes the last row again (duplicates across pages).
  'cursor-inclusive': {
    js: [[SERVICE, 'AND c.id < ${query.afterId}::uuid', 'AND c.id <= ${query.afterId}::uuid']],
  },
  // POST accepts unknown/server-owned keys (mass assignment surface).
  'strict-body': {
    js: [
      [ROUTES, 'schema: { body: validation_js_1.createCustomerBodySchema },', ''],
      [VALIDATION, 'notes: notes.optional(),\n}).strict();\nconst patchSchema', 'notes: notes.optional(),\n}).passthrough();\nconst patchSchema'],
    ],
  },
  // Responses become cacheable.
  'no-store': {
    js: [[ROUTES, "reply.header('cache-control', 'no-store');", '']],
  },
  // Malformed ids answered differently from nonexistent/foreign ones (oracle).
  'malformed-oracle': {
    js: [[ROUTES, "if (id === undefined)\n        throw (0, service_js_1.customerError)('CUSTOMER_NOT_FOUND');", "if (id === undefined)\n        throw new app_js_1.ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request is invalid.');"]],
  },
  // Undo the 0018 column allowlist: table-level UPDATE for the api runtime.
  'column-grants': {
    sql: ['GRANT UPDATE ON TABLE public.customers TO tallermecario_api'],
  },
};

function selected() {
  const name = process.env.S204_MUTATION;
  if (!name) return null;
  const mutation = MUTATIONS[name];
  if (!mutation) throw new Error(`UNKNOWN_MUTATION ${name}`);
  return { name, mutation };
}

async function applyMutation(phase, { admin, compiledRoot } = {}) {
  const current = selected();
  if (!current) return;
  if (phase === 'sql') {
    for (const statement of current.mutation.sql ?? []) await admin.unsafe(statement);
  } else if (phase === 'js') {
    for (const [file, from, to] of current.mutation.js ?? []) {
      const path = join(compiledRoot, file);
      const source = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
      const occurrences = source.split(from).length - 1;
      if (occurrences !== 1) throw new Error(`MUTATION_ANCHOR_NOT_FOUND ${current.name} ${file} (${occurrences})`);
      // Replacer function: `to` may contain `$` sequences that String.replace would expand.
      writeFileSync(path, source.replace(from, () => to));
    }
  }
  process.stdout.write(`S204_MUTATION_APPLIED ${current.name} ${phase}\n`);
}

module.exports = { MUTATIONS, applyMutation };
