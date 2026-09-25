'use strict';

/**
 * S1-05 mutation definitions (test tooling only; never touches src/ or the
 * migration files). Selected with S105_MUTATION=<name>; each one rewrites the
 * COMPILED JS of the throwaway compile dir and/or the throwaway test database
 * AFTER a clean migration, so the suite runs against a deliberately broken
 * build. Every anchor must match exactly once, otherwise the run aborts
 * (MUTATION_ANCHOR_NOT_FOUND): a mutation can never silently become a no-op.
 *
 * scripts/test-member-roles-mutations.cjs runs each mutant and requires the
 * suite to FAIL (mutant killed).
 */

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SERVICE = 'memberships/roles-service.js';
const ROUTES = 'memberships/roles-routes.js';

const MUTATIONS = {
  // Drop the RBAC permission checks of the role commands (route guard stays).
  'permission-check': {
    js: [
      [SERVICE, 'if (!permissions.has(MANAGE_PERMISSION))', 'if (false)'],
      [SERVICE, 'if (missing.length > 0) {', 'if (false) {'],
    ],
  },
  // Drop BOTH tenant layers: the app-level tenant predicates and the RLS
  // policies of memberships / membership_roles.
  'tenant-isolation': {
    js: [
      [SERVICE, 'WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}\n    FOR UPDATE OF m', 'WHERE m.id = ${membershipId}\n    FOR UPDATE OF m'],
      [SERVICE, 'WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}\n  `;', 'WHERE m.id = ${membershipId}\n  `;'],
    ],
    sql: [
      'ALTER POLICY tenant_select ON public.memberships USING (true)',
      'ALTER POLICY tenant_select ON public.membership_roles USING (true)',
      'ALTER POLICY tenant_delete ON public.membership_roles USING (true)',
      'ALTER POLICY tenant_insert ON public.membership_roles WITH CHECK (true)',
    ],
  },
  // Drop only the database layer (RLS) of membership_roles.
  'tenant-isolation-rls': {
    sql: [
      'ALTER POLICY tenant_select ON public.membership_roles USING (true)',
      'ALTER POLICY tenant_delete ON public.membership_roles USING (true)',
      'ALTER POLICY tenant_insert ON public.membership_roles WITH CHECK (true)',
    ],
  },
  // Drop the last-owner guard everywhere: app check + 0011 trigger.
  'last-owner-guard': {
    js: [
      // S1-06: helpers moved to membership-access.ts; compiled as (0, mod.fn)(...).
      [SERVICE, 'if (role === membership_access_js_1.OWNER_ROLE && await (0, membership_access_js_1.remainingActiveOwners)(sql, tenant.tenantId, target.id) === 0) {', 'if (false) {'],
    ],
    sql: ['DROP TRIGGER membership_roles_invariants_trg ON public.membership_roles'],
  },
  // Trust an assigned_by_membership_id supplied in the request body.
  'assigned-by-from-request': {
    js: [
      [ROUTES, 'additionalProperties: false,\n    required: [\'role_code\'],', 'additionalProperties: true,\n    required: [\'role_code\'],'],
      [ROUTES, 'const { role_code: role } = request.body;', 'const { role_code: role } = request.body; globalThis.__s105AssignedBy = request.body.assigned_by_membership_id;'],
      [SERVICE, 'SELECT ${tenant.tenantId}, ${target.id}, r.id, ${tenant.membershipId}', 'SELECT ${tenant.tenantId}, ${target.id}, r.id, ${globalThis.__s105AssignedBy ?? tenant.membershipId}'],
    ],
  },
  // Allow self role modification.
  'self-modification': {
    js: [[SERVICE, 'if (membershipId === tenant.membershipId) {', 'if (false) {']],
  },
  // 0012: drop the memberships status guard (the S1-03 handler keeps its own check).
  'owner-status-guard': {
    sql: ['DROP TRIGGER memberships_owner_invariant_trg ON public.memberships'],
  },
  // 0012: drop the lock-before-row-locks statement triggers (lock-order inversion).
  'owner-set-lock-order': {
    sql: [
      'DROP TRIGGER memberships_owner_set_lock_trg ON public.memberships',
      'DROP TRIGGER membership_roles_owner_set_lock_trg ON public.membership_roles',
    ],
  },
  // S1-03 handler: drop its owner-set lock taken before the owner row locks.
  'handler-lock-order': {
    js: [['identity/sync/membership-revocation.js', 'await tx `SELECT app.lock_current_tenant_owner_set()`;', '']],
  },
  // 0013 (round 2, A): expose again a runtime-executable owner-set lock that
  // takes an arbitrary tenant id (definer rights => can lock another tenant).
  'runtime-tenant-lock-helper': {
    sql: [
      `CREATE FUNCTION app.lock_tenant_owner_set(p_tenant_id uuid) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
        BEGIN
          LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE;
          PERFORM 1 FROM public.workshops WHERE id = p_tenant_id FOR NO KEY UPDATE;
        END $f$`,
      'GRANT EXECUTE ON FUNCTION app.lock_tenant_owner_set(uuid) TO tallermecario_api, tallermecario_worker',
    ],
  },
  // 0013 (round 2, B): privileged / unscoped statements no longer take the
  // EXCLUSIVE owner gate before their row locks (the 0012 ordering).
  'privileged-gate': {
    sql: [
      `CREATE OR REPLACE FUNCTION app.enforce_owner_set_lock_order() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$
        BEGIN
          IF app.current_tenant_id() IS NOT NULL
            AND NOT (SELECT r.rolsuper OR r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
            PERFORM app.lock_current_tenant_owner_set();
          END IF;
          RETURN NULL;
        END $f$`,
    ],
  },
  // 0014 (round 3): restore the 0013 RAISE when the context's workshop is not visible.
  'nonexistent-tenant-raise': {
    sql: [
      `CREATE OR REPLACE FUNCTION app.lock_current_tenant_owner_set() RETURNS void
        LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $f$
        DECLARE v_tenant_id uuid := app.current_tenant_id();
        BEGIN
          IF v_tenant_id IS NULL THEN
            RAISE EXCEPTION 'owner-set lock requires a tenant context' USING ERRCODE = 'object_not_in_prerequisite_state';
          END IF;
          LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE;
          PERFORM 1 FROM public.workshops AS w WHERE w.id = v_tenant_id FOR NO KEY UPDATE OF w;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'workshop of the tenant context is not visible' USING ERRCODE = 'object_not_in_prerequisite_state';
          END IF;
        END $f$`,
    ],
  },
  // Authorize from the request-start TenantContext snapshot instead of fresh rows.
  'stale-permissions': {
    js: [[SERVICE, 'const permissions = await (0, membership_access_js_1.freshActorPermissions)(sql, context);', 'const permissions = new Set(context.tenant.permissions.keys());']],
  },
};

function selected() {
  const name = process.env.S105_MUTATION;
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
      writeFileSync(path, source.replace(from, to));
    }
  }
  process.stdout.write(`S105_MUTATION_APPLIED ${current.name} ${phase}\n`);
}

module.exports = { MUTATIONS, applyMutation };
