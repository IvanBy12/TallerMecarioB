'use strict';

/**
 * S1-07 mutation definitions (test tooling only; never touches src/ or the
 * migration files). Selected with S107_MUTATION=<name>; each one rewrites the
 * COMPILED JS of the throwaway compile dir and/or the throwaway test database
 * AFTER a clean migration, so the audit suite runs against a deliberately
 * broken build. Every anchor must match exactly once, otherwise the run aborts
 * (MUTATION_ANCHOR_NOT_FOUND): a mutation can never silently become a no-op.
 *
 * scripts/test-audit-mutations.cjs runs each mutant and requires the suite to
 * FAIL (mutant killed).
 */

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const LIFECYCLE = 'memberships/lifecycle-service.js';
const LIFECYCLE_ROUTES = 'memberships/lifecycle-routes.js';
const ROLES = 'memberships/roles-service.js';
const INVITATIONS = 'invitations/service.js';
const ONBOARDING = 'onboarding/service.js';
const ONBOARDING_ROUTES = 'onboarding/routes.js';
const REVOCATION = 'identity/sync/membership-revocation.js';

const LIFECYCLE_ACTOR = "${(0, uuid_v7_js_1.uuidV7)()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},";

const MUTATIONS = {
  // 1. A critical operation without its success audit (S1-06 suspend/revoke).
  'drop-lifecycle-success-audit': {
    js: [[LIFECYCLE, "reasonCode: REASON_CODE,\n        before: { status: target.status },", "reasonCode: REASON_CODE, __skip: true,\n        before: { status: target.status },"],
      [LIFECYCLE, 'async function insertAudit(sql, context, meta, row) {\n    const { tenant } = context;', 'async function insertAudit(sql, context, meta, row) {\n    if (row.__skip) return;\n    const { tenant } = context;']],
  },
  // 1b. Same for S1-05 role assignment (the only role.assigned of a command).
  'drop-role-success-audit': {
    js: [[ROLES, "await insertAudit(sql, context, meta, {\n        action: 'role.assigned',\n        outcome: 'success',", "if (false) await insertAudit(sql, context, meta, {\n        action: 'role.assigned',\n        outcome: 'success',"]],
  },
  // 2. Runtime may UPDATE audit_logs (privilege layer; the 0002 trigger stays).
  'grant-update': {
    sql: ['GRANT UPDATE ON TABLE public.audit_logs TO tallermecario_api, tallermecario_worker'],
  },
  // 3. Runtime may DELETE audit_logs (privilege layer; the 0002 trigger stays).
  'grant-delete': {
    sql: ['GRANT DELETE ON TABLE public.audit_logs TO tallermecario_api, tallermecario_worker'],
  },
  // 2+3 behavioural: both layers gone (grant + defensive trigger).
  'append-only-removed': {
    sql: [
      'GRANT UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs TO tallermecario_api, tallermecario_worker',
      'DROP TRIGGER audit_logs_append_only_row_trg ON public.audit_logs',
      'DROP TRIGGER audit_logs_append_only_truncate_trg ON public.audit_logs',
    ],
  },
  // 4. The audited actor is taken from the request (header) instead of the TenantContext.
  'actor-from-request': {
    js: [[LIFECYCLE_ROUTES, 'return { requestId: request.id, ipAddress: request.ip };', "return { requestId: request.id, ipAddress: request.ip, actorMembershipId: request.headers['x-actor-membership-id'] };"],
      [LIFECYCLE, LIFECYCLE_ACTOR, "${(0, uuid_v7_js_1.uuidV7)()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${meta.actorMembershipId ?? tenant.membershipId},"]],
  },
  // 4b. Database layer only: the 0017 actor guard is gone.
  'db-actor-guard': {
    sql: ['DROP TRIGGER audit_logs_actor_guard_trg ON public.audit_logs'],
  },
  // 5. The audited tenant is taken from the request (header) instead of the TenantContext.
  'tenant-from-request': {
    js: [[LIFECYCLE_ROUTES, 'return { requestId: request.id, ipAddress: request.ip };', "return { requestId: request.id, ipAddress: request.ip, auditTenantId: request.headers['x-audit-tenant-id'] };"],
      [LIFECYCLE, LIFECYCLE_ACTOR, "${(0, uuid_v7_js_1.uuidV7)()}, ${meta.auditTenantId ?? tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},"]],
  },
  // 5b. Database layer only: audit_logs INSERT policy no longer binds the tenant.
  'db-tenant-policy': {
    sql: ['ALTER POLICY tenant_insert ON public.audit_logs WITH CHECK (true)'],
  },
  // 6. Secrets in the audit log: the invitation token hash in membership.invited.
  'store-token-hash': {
    js: [[INVITATIONS, "after: { status: 'pending', target_role: role, expires_at: iso(created.expires_at) },", "after: { status: 'pending', target_role: role, expires_at: iso(created.expires_at), token_hash: tokenHash },"]],
  },
  // 6b. Secrets in the audit log: the Authorization header in lifecycle metadata.
  'store-authorization': {
    js: [[LIFECYCLE_ROUTES, 'return { requestId: request.id, ipAddress: request.ip };', 'return { requestId: request.id, ipAddress: request.ip, authorization: request.headers.authorization };'],
      [LIFECYCLE, 'metadata: { command, roles: heldRoles },\n    });\n    return toDto(updated, roles);', 'metadata: { command, roles: heldRoles, authorization: meta.authorization },\n    });\n    return toDto(updated, roles);']],
  },
  // 6c. Raw User-Agent persisted (S1-04 hardening undone in code AND grant).
  'persist-user-agent': {
    sql: ['GRANT INSERT (user_agent) ON TABLE public.audit_logs TO tallermecario_api'],
    js: [[ONBOARDING_ROUTES, 'requestId: request.id,', "requestId: request.id, userAgent: request.headers['user-agent'],"],
      [ONBOARDING, "before_json, after_json, metadata_json, request_id,\n          ip_address\n        ) VALUES", "before_json, after_json, metadata_json, request_id,\n          ip_address, user_agent\n        ) VALUES"],
      [ONBOARDING, "${input.requestId}, ${input.ipAddress}::inet\n          ),\n          (\n            ${(0, uuid_v7_js_1.uuidV7)()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},\n            'membership.activated'", "${input.requestId}, ${input.ipAddress}::inet, ${input.userAgent ?? null}\n          ),\n          (\n            ${(0, uuid_v7_js_1.uuidV7)()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},\n            'membership.activated'"],
      [ONBOARDING, "${input.requestId}, ${input.ipAddress}::inet\n          ),\n          (\n            ${(0, uuid_v7_js_1.uuidV7)()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},\n            'role.assigned'", "${input.requestId}, ${input.ipAddress}::inet, ${input.userAgent ?? null}\n          ),\n          (\n            ${(0, uuid_v7_js_1.uuidV7)()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},\n            'role.assigned'"],
      [ONBOARDING, "${input.requestId}, ${input.ipAddress}::inet\n          )\n      `;", "${input.requestId}, ${input.ipAddress}::inet, ${input.userAgent ?? null}\n          )\n      `;"]],
  },
  // 6d. Only the column grant of user_agent comes back (privilege layer).
  'grant-user-agent': {
    sql: ['GRANT INSERT (user_agent) ON TABLE public.audit_logs TO tallermecario_api, tallermecario_worker'],
  },
  // 7. Success audit committed BEFORE the business write/commit (own transaction).
  'audit-before-commit': {
    js: [[LIFECYCLE, '    let updated;\n    try {\n        updated = await writeStatus(sql, tenant.tenantId, target, transition.to);',
      "    await insertAudit(sql, context, meta, {\n        action: transition.action,\n        outcome: 'success',\n        targetMembershipId: target.id,\n        reasonCode: REASON_CODE,\n        before: { status: target.status },\n        after: { status: transition.to },\n        metadata: { command, roles: heldRoles },\n    });\n    await sql.unsafe('COMMIT');\n    await sql.unsafe('BEGIN');\n    await sql`SELECT set_config('app.tenant_id', ${tenant.tenantId}, true), set_config('app.user_id', ${tenant.userId}, true), set_config('app.membership_id', ${tenant.membershipId}, true), set_config('app.request_id', ${meta.requestId}, true)`;\n    await (0, membership_access_js_1.lockCurrentTenantOwnerSet)(sql);\n    let updated;\n    try {\n        updated = await writeStatus(sql, tenant.tenantId, target, transition.to);"],
      [LIFECYCLE, "reasonCode: REASON_CODE,\n        before: { status: target.status },\n        after: { status: updated.status },", "reasonCode: REASON_CODE, __skip: true,\n        before: { status: target.status },\n        after: { status: updated.status },"],
      [LIFECYCLE, 'async function insertAudit(sql, context, meta, row) {\n    const { tenant } = context;', 'async function insertAudit(sql, context, meta, row) {\n    if (row.__skip) return;\n    const { tenant } = context;']],
  },
  // Worker attributes a provider action to the (deleted) user.
  'worker-user-actor': {
    js: [[REVOCATION, "${(0, uuid_v7_js_1.uuidV7)()}, ${input.tenantId}, 'provider', NULL, NULL,", "${(0, uuid_v7_js_1.uuidV7)()}, ${input.tenantId}, 'user', ${input.metadata.user_id}, NULL,"]],
  },
};

function selected() {
  const name = process.env.S107_MUTATION;
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
  process.stdout.write(`S107_MUTATION_APPLIED ${current.name} ${phase}\n`);
}

module.exports = { MUTATIONS, applyMutation };
