'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function replaceExact(source, anchor, replacement, name) {
  if (!source.includes(anchor)) throw new Error(`MUTATION_ANCHOR_NOT_FOUND ${name}`);
  return source.replace(anchor, replacement);
}

function applyCloseMutation(compiledRoot) {
  const name = process.env.S306_MUTATION;
  if (!name) return;
  const file = join(compiledRoot, 'receptions',
    name === 'bodyless_empty_object_allowed' ? 'routes.js' : 'close.js');
  let source = readFileSync(file, 'utf8');
  const changes = {
    bodyless_empty_object_allowed: () => {
      source = replaceExact(source, 'if (request.body !== undefined)',
        "if (request.body !== undefined && Object.keys(request.body ?? {}).length !== 0)", name);
    },
    reception_lock_removed: () => {
      source = replaceExact(source, 'FOR NO KEY UPDATE OF r`;', '`;', name);
    },
    signature_precheck_removed: () => {
      source = replaceExact(source, 'if (!signature)', 'if (false && !signature)', name);
    },
    mileage_revalidation_removed: () => {
      source = replaceExact(source, '&& reception.mileage_km < vehicle.current_mileage_km)',
        '&& false)', name);
    },
    vehicle_mileage_update_skipped: () => {
      source = replaceExact(source, 'if (vehicle.current_mileage_km !== reception.mileage_km) {',
        'if (false) {', name);
    },
    advisory_lock_removed: () => {
      source = replaceExact(source, `await sql \`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'service_order_number:' || \${tenant.tenantId}::text, 0))\`;`,
      'await sql `SELECT 1`;', name);
    },
    allocation_before_advisory: () => {
      source = replaceExact(source, 'await sql `SELECT pg_catalog.pg_advisory_xact_lock',
        `const [allocation] = await sql \`SELECT COALESCE(MAX(order_number),0)+1 AS number
          FROM public.service_orders WHERE tenant_id = \${tenant.tenantId}\`;
    await sql \`SELECT pg_catalog.pg_advisory_xact_lock`, name);
      source = replaceExact(source, 'COALESCE(MAX(existing.order_number), 0) + 1,',
        '${allocation.number},', name);
    },
    idempotent_branch_removed: () => {
      source = replaceExact(source, "if (reception.status === 'closed') {", 'if (false) {', name);
    },
    duplicate_audit_on_retry: () => {
      source = replaceExact(source, 'return response(reception, order);', `await sql \`INSERT INTO public.audit_logs
        (id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
          entity_type, entity_id, request_id)
        VALUES (\${(0, uuid_v7_js_1.uuidV7)()}, \${tenant.tenantId}, 'user', \${tenant.userId},
          \${tenant.membershipId}, 'reception.closed', 'success', 'reception',
          \${reception.id}, \${meta.requestId})\`;
        return response(reception, order);`, name);
    },
    initial_history_skipped: () => {
      source = replaceExact(source, 'await sql `INSERT INTO public.order_status_history',
        'if (false) await sql `INSERT INTO public.order_status_history', name);
    },
    audit_outside_transaction: () => {
      source = replaceExact(source, 'await sql `INSERT INTO public.audit_logs',
        `const auditSql = require('postgres')(process.env.TEST_DATABASE_URL_ADMIN, { max: 1 });
    try { await auditSql \`INSERT INTO public.audit_logs`, name);
      source = replaceExact(source, '${sql.json({ service_order_id:',
        '${auditSql.json({ service_order_id:', name);
      source = replaceExact(source, 'return response(closed, order);',
        '} finally { await auditSql.end({ timeout: 5 }); }\n    return response(closed, order);', name);
    },
  };
  if (!Object.hasOwn(changes, name)) throw new Error(`UNKNOWN_MUTATION ${name}`);
  changes[name]();
  writeFileSync(file, source);
  process.stdout.write(`S306_MUTATION_APPLIED ${name}\n`);
}

module.exports = { applyCloseMutation };
