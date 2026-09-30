'use strict';

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function applyReceptionQueriesMutation(compiledRoot) {
  const name = process.env.S307_MUTATION;
  if (!name) return;
  const fileName = ['allow_assigned_list'].includes(name) ? 'routes.js'
    : ['accept_unknown_query'].includes(name) ? 'queries-validation.js' : 'queries.js';
  const file = join(compiledRoot, 'receptions', fileName);
  let source = readFileSync(file, 'utf8');
  const replace = (anchor, value) => {
    const match = source.includes(anchor) ? anchor : anchor.replace(/\n/gu, '\r\n');
    if (!source.includes(match)) throw new Error(`S307_MUTATION_ANCHOR_NOT_FOUND ${name}`);
    source = source.replace(match, value);
  };
  const changes = {
    remove_list_tenant: () => replace('WHERE r.tenant_id = ${tenant.tenantId}\n      ${query.afterId',
      'WHERE true\n      ${query.afterId'),
    allow_assigned_list: () => replace("config: { permission: 'receptions.read' }, onRequest: noStore,",
      "config: { permission: 'receptions.read', permissionScope: 'resource' }, onRequest: noStore,"),
    remove_detail_assignment: () => replace('const restricted = resourceAuthorization.grantedScopes.size > 0;',
      'const restricted = false;'),
    accept_released_assignment: () => replace('AND a.released_at IS NULL', 'AND true'),
    accept_qc_assignment: () => replace("a.assignment_type IN ('lead_technician', 'support_technician')",
      "a.assignment_type IN ('lead_technician', 'support_technician', 'quality_control')"),
    remove_assignment_tenant: () => replace('AND a.tenant_id = ${tenant.tenantId} AND a.membership_id',
      'AND a.membership_id'),
    omit_resource_mark: () => replace("(0, app_js_1.markResourceAuthorizationSatisfied)(resourceAuthorization, 'assigned');",
      'void resourceAuthorization;'),
    staff_dto_for_restricted: () => replace('if (restricted)\n        return { receptionId: row.id, vehicleId: row.vehicle_id,',
      'if (false && restricted)\n        return { receptionId: row.id, vehicleId: row.vehicle_id,'),
    leak_customer_to_tech: () => replace('return { receptionId: row.id, vehicleId: row.vehicle_id,\n            mileageKm:',
      'return { receptionId: row.id, customerId: row.customer_id, advisorNotes: row.advisor_notes, vehicleId: row.vehicle_id,\n            mileageKm:'),
    accept_unknown_query: () => replace('!QUERY_KEYS.has(key) || ', ''),
    break_cursor_boundary: () => replace('r.id < ${query.afterId}::uuid', 'r.id <= ${query.afterId}::uuid'),
    leak_order_field: () => replace('return { receptionId: row.id, vehicleId: row.vehicle_id,\n            mileageKm:',
      "return { receptionId: row.id, serviceOrderId: 'leak', vehicleId: row.vehicle_id,\n            mileageKm:"),
  };
  if (!Object.hasOwn(changes, name)) throw new Error(`UNKNOWN_S307_MUTATION ${name}`);
  changes[name]();
  writeFileSync(file, source);
  process.stdout.write(`S307_MUTATION_APPLIED ${name}\n`);
}

module.exports = { applyReceptionQueriesMutation };
