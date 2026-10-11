'use strict';
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
// Test-only changes to the temporary compiled artifact; production source and
// historical migrations are never changed by this runner.
const CASES = Object.freeze({
  accept_released: { anchor:'AND membership_id=${tenant.membershipId} AND released_at IS NULL', value:'AND membership_id=${tenant.membershipId}', pattern:'released: 404' },
  accept_qc: { anchor:"assignment_type IN ('lead_technician','support_technician')", value:"assignment_type IN ('lead_technician','support_technician','quality_control')", pattern:'quality_control: 404' },
  ignore_sensitive_graph: { anchor:'if (disallowed)', value:'if (false && disallowed)', pattern:'mixed signature reference' },
  ignore_binding_consensus: { anchor:'sessions.some(s => s.reception_id !== sessions[0].reception_id || s.damage_id !== sessions[0].damage_id)', value:'false', pattern:'two assigned orders with conflicting' },
  omit_tripwire_mark: { anchor:"(0, resource_authorization_js_1.markResourceAuthorizationSatisfied)(context.resourceAuthorization, 'assigned');", value:'void context.resourceAuthorization;', pattern:'lead_technician can list and download' },
  omit_assignment_lock: { anchor:'ORDER BY id FOR SHARE', value:'ORDER BY id', pattern:'issuance wins assignment lock' },
});
function applyMediaAssignmentMutation(compiledRoot) {
  const name=process.env.S4B07_MUTATION;
  if(!name)return;
  const change=CASES[name];
  if(!change)throw new Error(`UNKNOWN_MUTATION ${name}`);
  const file=join(compiledRoot,'media','assigned-authorization.js');
  const source=readFileSync(file,'utf8');
  if(!source.includes(change.anchor))throw new Error(`MUTATION_ANCHOR_NOT_FOUND ${name}`);
  writeFileSync(file,source.replace(change.anchor,change.value));
  process.stdout.write(`S4B07_MUTATION_APPLIED ${name}\n`);
}
module.exports={CASES,applyMediaAssignmentMutation};
