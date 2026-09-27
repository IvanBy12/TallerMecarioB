'use strict';

/** Mutate throwaway compiled JS or the ephemeral test DB only. */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const SERVICE = 'vehicles/service.js';
const ROUTES = 'vehicles/routes.js';
const VALIDATION = 'vehicles/validation.js';
const MUTATIONS = {
  'owner-manage-permission': { js: [[SERVICE,
    "(0, authorize_js_1.requireTenantPermission)(context.tenant, 'vehicle_owners.manage');",
    '/* owner permission deliberately removed */']] },
  'initial-owner-primary': { js: [[SERVICE, "'owner', true, pg_catalog.clock_timestamp()", "'owner', false, pg_catalog.clock_timestamp()"]] },
  'initial-owner-audit': { js: [[SERVICE,
    "await audit(sql, context, meta, 'vehicle.owner_changed', vehicle.id, { command: 'create' }, { ownership_id: owner.id, customer_id: input.customerId });",
    '/* audit deliberately removed */']] },
  'plate-normalization': { js: [[VALIDATION, "replace(/[ .-]/gu, '')", "replace(/[ ]/gu, '')"]] },
  'plate-min-length-two': { js: [[VALIDATION, '/^[A-Z0-9]{1,16}$/u', '/^[A-Z0-9]{2,16}$/u']] },
  'model-year-endpoints-narrowed': { js: [[VALIDATION, '.min(1886).max(2200)', '.min(1887).max(2199)']] },
  'cursor-version-ignored': { js: [[VALIDATION, 'if (v !== 1 || typeof id !== \'string\')',
    'if (typeof id !== \'string\')']] },
  'cursor-extra-property-accepted': { js: [[VALIDATION,
    "if (keys.length !== 2 || !keys.includes('v') || !keys.includes('id'))",
    "if (!keys.includes('v') || !keys.includes('id'))"]] },
  'media-type-guard-removed': { js: [[ROUTES,
    "throw new app_js_1.ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');",
    'return;']] },
  'delete-route-added': { js: [[ROUTES, "app.post('/api/v1/vehicles', {",
    "app.delete('/api/v1/vehicles/:vehicleId', { config: { permission: 'vehicles.update' } }, async () => ({}));\n    app.post('/api/v1/vehicles', {"]] },
  'archive-route-added': { js: [[ROUTES, "app.post('/api/v1/vehicles', {",
    "app.post('/api/v1/vehicles/:vehicleId/archive', { config: { permission: 'vehicles.update' } }, async () => ({}));\n    app.post('/api/v1/vehicles', {"]] },
  'technician-route-scope': { js: [[ROUTES, "permissionScope: 'resource'", "permissionScope: 'tenant'"]] },
  'technician-released': { js: [[SERVICE, 'a.released_at IS NULL', 'a.released_at IS NOT NULL']] },
  'technician-full-dto': { js: [[SERVICE, 'return assigned ? toTechDto(row) : toDto(row);', 'return toDto(row);']] },
  'vehicle-update-permission': { js: [[ROUTES, "config: { permission: 'vehicles.update' }", "config: { permission: 'workshop.read' }"]] },
  'cursor-inclusive': { js: [[SERVICE, 'AND v.id < ${query.afterId}::uuid', 'AND v.id <= ${query.afterId}::uuid']] },
  'occ-check': { js: [[SERVICE, 'if (!current.version_matches)', 'if (false)']] },
  'patch-lock-and-occ-weakened': { js: [[SERVICE, 'FOR NO KEY UPDATE OF v', ''],
    [SERVICE, 'if (!current.version_matches)', 'if (false)'],
    [SERVICE, "AND pg_catalog.to_char(v.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) = ${input.expectedUpdatedAt}",
      'AND true']] },
  'noop-writes': { js: [[SERVICE, 'if (changed.length === 0)', 'if (false)']] },
  'audit-values': { js: [[SERVICE, '{ changed_fields: changed }', '{ changed_fields: changed, plate: row.plate }']] },
  'vehicle-updated-audit-removed': { js: [[SERVICE,
    "await audit(sql, context, meta, 'vehicle.updated', row.id, { changed_fields: changed });",
    '/* vehicle.updated audit deliberately removed */']] },
  'tenant-rls': { sql: ['ALTER POLICY tenant_select ON public.vehicles USING (true)'] },
};
async function applyVehicleMutation(phase, { admin, compiledRoot } = {}) {
  const name = process.env.S205_MUTATION;
  if (!name) return;
  const mutation = MUTATIONS[name];
  if (!mutation) throw new Error(`UNKNOWN_MUTATION ${name}`);
  if (phase === 'sql') {
    for (const statement of mutation.sql ?? []) await admin.unsafe(statement);
  } else {
    for (const [file, from, to] of mutation.js ?? []) {
      const path = join(compiledRoot, file);
      const source = readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n');
      const occurrences = source.split(from).length - 1;
      if (occurrences !== 1) throw new Error(`MUTATION_ANCHOR_NOT_FOUND ${name} ${file} (${occurrences})`);
      writeFileSync(path, source.replace(from, () => to));
    }
  }
  process.stdout.write(`S205_MUTATION_APPLIED ${name} ${phase}\n`);
}
module.exports = { MUTATIONS, applyVehicleMutation };
