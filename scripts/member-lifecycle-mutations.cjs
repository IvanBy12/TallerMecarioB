'use strict';

/**
 * S1-06 mutation definitions (test tooling only; never touches src/ or the
 * migration files). Selected with S106_MUTATION=<name>; each one rewrites the
 * COMPILED JS of the throwaway compile dir and/or the throwaway test database
 * AFTER a clean migration, so the suite runs against a deliberately broken
 * build. Every anchor must match exactly once, otherwise the run aborts
 * (MUTATION_ANCHOR_NOT_FOUND): a mutation can never silently become a no-op.
 *
 * scripts/test-member-lifecycle-mutations.cjs runs each mutant and requires
 * the suite to FAIL (mutant killed).
 */

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SERVICE = 'memberships/lifecycle-service.js';
const ROUTES = 'memberships/lifecycle-routes.js';

const MUTATIONS = {
  // Drop the manage permission everywhere: route guard (-> a permission every
  // member holds) AND the fresh service check.
  'permission-check': {
    js: [
      [ROUTES, "config: { permission: 'memberships.manage_staff', durableErrorCodes: DURABLE_CODES, rateLimit },", "config: { permission: 'workshop.read', durableErrorCodes: DURABLE_CODES, rateLimit },"],
      [SERVICE, 'if (!permissions.has(MANAGE_PERMISSION))', 'if (false)'],
    ],
  },
  // Reads guarded by a permission every member holds instead of memberships.read.
  'read-permission': {
    js: [
      [ROUTES, "app.get('/api/v1/memberships', {\n        config: { permission: 'memberships.read' },", "app.get('/api/v1/memberships', {\n        config: { permission: 'workshop.read' },"],
      [ROUTES, "app.get('/api/v1/memberships/:membershipId', {\n        config: { permission: 'memberships.read' },", "app.get('/api/v1/memberships/:membershipId', {\n        config: { permission: 'workshop.read' },"],
    ],
  },
  // Drop the target-authority rule (admin could manage owner/admin memberships).
  'target-authority': {
    js: [[SERVICE, 'if (missing.length > 0) {', 'if (false) {']],
  },
  // Drop BOTH tenant layers: the app-level tenant predicates and the RLS
  // policies of memberships / membership_roles.
  'tenant-isolation': {
    js: [
      [SERVICE, 'WHERE m.tenant_id = ${tenant.tenantId}\n    ORDER BY m.joined_at, m.id', 'WHERE true\n    ORDER BY m.joined_at, m.id'],
      [SERVICE, 'WHERE m.id = ${membershipId} AND m.tenant_id = ${tenant.tenantId}', 'WHERE m.id = ${membershipId}'],
      [SERVICE, 'WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}\n    FOR UPDATE OF m', 'WHERE m.id = ${membershipId}\n    FOR UPDATE OF m'],
    ],
    sql: [
      'ALTER POLICY tenant_select ON public.memberships USING (true)',
      'ALTER POLICY tenant_update ON public.memberships USING (true) WITH CHECK (true)',
      'ALTER POLICY tenant_select ON public.membership_roles USING (true)',
    ],
  },
  // Last-owner coordination (1/2): drop the 0012-0014 memberships status guard.
  'owner-status-guard': {
    sql: ['DROP TRIGGER memberships_owner_invariant_trg ON public.memberships'],
  },
  // Last-owner coordination (2/2): no owner-set lock before the row locks
  // (lock-order inversion against the S1-05 commands / S1-03 handler).
  'status-lock-order': {
    js: [[SERVICE, 'await (0, membership_access_js_1.lockCurrentTenantOwnerSet)(sql);', '']],
  },
  // Allow any transition from any state (e.g. suspended -> suspended, revoked -> revoked/suspended).
  'invalid-transition': {
    js: [[SERVICE, 'if (!transition.from.includes(target.status))', 'if (false)']],
  },
  // Trust the request: accept any body and take the audited actor from it.
  'actor-from-request': {
    js: [
      [ROUTES, 'if (body === undefined)\n        return;', 'globalThis.__s106Body = body;\n    return;'],
      [SERVICE, "${(0, uuid_v7_js_1.uuidV7)()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},", "${(0, uuid_v7_js_1.uuidV7)()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${globalThis.__s106Body?.actor_membership_id ?? tenant.membershipId},"],
    ],
  },
  // Authorize from the request-start TenantContext snapshot instead of fresh rows.
  'stale-permissions': {
    js: [[SERVICE, 'const permissions = await (0, membership_access_js_1.freshActorPermissions)(sql, context);', 'const permissions = new Set(context.tenant.permissions.keys());']],
  },
  // Allow self-management.
  'self-management': {
    js: [[SERVICE, 'if (membershipId === tenant.membershipId) {', 'if (false) {']],
  },
  // Undo 0015: table-level UPDATE on memberships for both runtimes again.
  'column-grants': {
    sql: ['GRANT UPDATE ON TABLE public.memberships TO tallermecario_api, tallermecario_worker'],
  },
};

function selected() {
  const name = process.env.S106_MUTATION;
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
  process.stdout.write(`S106_MUTATION_APPLIED ${current.name} ${phase}\n`);
}

module.exports = { MUTATIONS, applyMutation };
