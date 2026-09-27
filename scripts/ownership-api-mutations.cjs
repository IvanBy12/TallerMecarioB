'use strict';

/** Mutations apply only to throwaway compiled JS or the ephemeral CRM test DB. */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const SERVICE = 'vehicles/service.js';
const ROUTES = 'vehicles/routes.js';
const currentRead = `const [current] = await sql \`SELECT \${ownerColumns(sql)} FROM public.vehicle_owners AS o
    WHERE o.tenant_id = \${tenant.tenantId} AND o.vehicle_id = \${vehicleId}
      AND o.is_primary = true AND o.valid_to IS NULL\`;`;
const vehicleLock = `const [vehicle] = await sql \`SELECT id FROM public.vehicles
    WHERE tenant_id = \${tenant.tenantId} AND id = \${vehicleId} FOR NO KEY UPDATE\`;`;
const noOp = `if (current?.customer_id === customerId)
        return { ownership: ownershipDto(current), changed: false };`;
const premise = `if ((current?.id ?? null) !== input.expectedCurrentOwnershipId)
        throw ownershipConflict();`;
const MUTATIONS = {
  'vehicle-lock-removed': { js: [[SERVICE,
    'AND id = ${vehicleId} FOR NO KEY UPDATE`;', 'AND id = ${vehicleId}`;']] },
  'vehicle-lock-weakened': { js: [[SERVICE,
    'AND id = ${vehicleId} FOR NO KEY UPDATE`;', 'AND id = ${vehicleId} FOR SHARE`;']] },
  'current-read-before-lock': { js: [[SERVICE, vehicleLock,
    `${currentRead}\n    ${vehicleLock}`], [SERVICE, `    ${currentRead}\n    if (current?.customer_id`,
    '    if (current?.customer_id']] },
  'premise-check-removed': { js: [[SERVICE, premise, 'if (false)\n        throw ownershipConflict();']] },
  'noop-premise-swapped': { js: [[SERVICE, `${noOp}\n    ${premise}`, `${premise}\n    ${noOp}`]] },
  'noop-check-removed': { js: [[SERVICE, noOp,
    `if (false)\n        return { ownership: ownershipDto(current), changed: false };`]] },
  'separate-timestamps': { js: [[SERVICE,
    "'owner', true, ${time.t})", "'owner', true, pg_catalog.clock_timestamp())"]] },
  'close-valid-to-guard-removed': { js: [[SERVICE,
    'AND id = ${current.id} AND valid_to IS NULL RETURNING id',
    'AND id = ${current.id} RETURNING id']] },
  'history-order-reversed': { js: [[SERVICE,
    'ORDER BY o.valid_from DESC, o.id DESC LIMIT 200',
    'ORDER BY o.valid_from ASC, o.id ASC LIMIT 200']] },
  'history-tiebreak-removed': { js: [[SERVICE,
    'ORDER BY o.valid_from DESC, o.id DESC LIMIT 200',
    'ORDER BY o.valid_from DESC LIMIT 200']] },
  'history-limit-raised': { js: [[SERVICE,
    'ORDER BY o.valid_from DESC, o.id DESC LIMIT 200',
    'ORDER BY o.valid_from DESC, o.id DESC LIMIT 201']] },
  'history-pii-added': { js: [[SERVICE,
    'SELECT ${ownerColumns(sql)}, c.first_name, c.last_name',
    'SELECT ${ownerColumns(sql)}, c.first_name, c.last_name, c.phone'],
    [SERVICE, 'customer: { firstName: row.first_name, lastName: row.last_name },',
      'customer: { firstName: row.first_name, lastName: row.last_name, phone: row.phone },']] },
  'vehicle-existence-removed': { js: [[SERVICE,
    "if (!vehicle)\n        throw notFound('VEHICLE');\n    const rows = await sql",
    'const rows = await sql']] },
  'owner-rls-tenant-weakened': { sql: [
    'ALTER POLICY tenant_select ON public.vehicle_owners USING (true)',
  ] },
  'post-route-permission-weakened': { js: [[ROUTES,
    "config: { permission: 'vehicle_owners.manage' },",
    "config: { permission: 'vehicles.update' },"]] },
};
async function applyOwnershipMutation(phase, { admin, compiledRoot } = {}) {
  const name = process.env.S206_MUTATION;
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
  process.stdout.write(`S206_MUTATION_APPLIED ${name} ${phase}\n`);
}
module.exports = { MUTATIONS, applyOwnershipMutation };
