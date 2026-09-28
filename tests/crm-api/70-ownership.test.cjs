'use strict';

/** S2-06 ownership contract against the real tenant-scoped API and PostgreSQL. */
const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { listOwnerHistory, mapVehicleDbError } = h.load('vehicles/service.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool, identityProvider: provider,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) { registerCustomerRoutes(server); registerVehicleRoutes(server); },
  });
});
after(async () => h.closeAll(app));
const code = (r) => r.json?.error?.code;
const shape = (r) => ({ status: r.status, code: code(r), message: r.json?.error?.message });
const path = (id) => `/api/v1/vehicles/${id}/owners`;
const history = (actor, tenantId, id) => h.call(app, {
  subject: actor.subject, tenantId, url: path(id),
});
const transfer = (actor, tenantId, id, body, extra = {}) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST', url: path(id), body, ...extra,
});
const body = (customerId, expectedCurrentOwnershipId) => ({ customerId, expectedCurrentOwnershipId });
async function customer(actor, tenantId, overrides = {}) {
  const r = await h.createCustomer(app, actor, tenantId, h.validCustomer(overrides));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.customer.customerId;
}
async function vehicle(actor, tenantId, customerId) {
  const r = await h.call(app, { subject: actor.subject, tenantId, method: 'POST',
    url: '/api/v1/vehicles', body: { customerId,
      plate: `P${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      vehicleType: 'car', brand: 'Marca', model: 'Modelo' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const rows = (id) => h.admin`SELECT id, customer_id, relationship_type, is_primary, valid_from, valid_to
  FROM public.vehicle_owners WHERE vehicle_id=${id} ORDER BY valid_from, id`;
const audits = (id) => h.admin`SELECT action, outcome, actor_type, actor_user_id, actor_membership_id,
  before_json, after_json, metadata_json, request_id, user_agent
  FROM public.audit_logs WHERE entity_id=${id} AND action='vehicle.owner_changed' ORDER BY created_at, id`;
const snapshot = async (id) => (await h.admin`SELECT updated_at, xmin::text AS xmin
  FROM public.vehicles WHERE id=${id}`)[0];
const ownerDtoKeys = ['ownershipId', 'vehicleId', 'customerId', 'relationshipType',
  'isPrimary', 'validFrom', 'validTo'].sort();
const historyKeys = ['ownershipId', 'customerId', 'customer', 'relationshipType',
  'isPrimary', 'validFrom', 'validTo'].sort();

test('S2-06 transfer and retry preserve vehicle, history and minimized audit', async () => {
  const { a } = await h.twoTenants();
  const first = await customer(a.advisor, a.tenantId, { firstName: 'PrivateName' });
  const second = await customer(a.advisor, a.tenantId, { firstName: 'SecondName' });
  const { vehicle: v, ownership: original } = await vehicle(a.advisor, a.tenantId, first);
  const beforeVehicle = await snapshot(v.vehicleId);
  const beforeAudit = (await audits(v.vehicleId)).length;
  const changed = await transfer(a.advisor, a.tenantId, v.vehicleId,
    body(second, original.ownershipId.toUpperCase()));
  assert.equal(changed.status, 201, JSON.stringify(changed.json));
  assert.equal(changed.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(changed.json), ['ownership']);
  const o = changed.json.ownership;
  assert.deepEqual(Object.keys(o).sort(), ownerDtoKeys);
  assert.equal(o.vehicleId, v.vehicleId);
  assert.equal(o.customerId, second);
  assert.equal(o.relationshipType, 'owner');
  assert.equal(o.isPrimary, true);
  assert.equal(o.validTo, null);
  assert.match(o.ownershipId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.match(o.validFrom, h.TOKEN_FORMAT);
  assert.deepEqual(await snapshot(v.vehicleId), beforeVehicle);
  const db = await rows(v.vehicleId);
  assert.equal(db.length, 2);
  assert.equal(db[0].id, original.ownershipId);
  assert.equal(db[1].id, o.ownershipId);
  const [equal] = await h.admin`SELECT (a.valid_to = b.valid_from) AS same,
    (b.valid_from > a.valid_from) AS later FROM public.vehicle_owners a
    JOIN public.vehicle_owners b ON b.id=${o.ownershipId} WHERE a.id=${original.ownershipId}`;
  assert.equal(equal.same, true);
  assert.equal(equal.later, true);
  assert.equal(db[1].relationship_type, 'owner');
  assert.equal(db[1].is_primary, true);
  const log = (await audits(v.vehicleId)).at(-1);
  assert.equal((await audits(v.vehicleId)).length, beforeAudit + 1);
  assert.equal(log.outcome, 'success');
  assert.equal(log.actor_type, 'user');
  assert.equal(log.actor_user_id, a.advisor.user.id);
  assert.equal(log.actor_membership_id, a.advisor.membershipId);
  assert.deepEqual(log.before_json, { ownership_id: original.ownershipId, customer_id: first });
  assert.deepEqual(log.after_json, { ownership_id: o.ownershipId, customer_id: second });
  assert.deepEqual(log.metadata_json, { command: 'transfer' });
  assert.ok(log.request_id);
  assert.equal(log.user_agent, null);
  assert.doesNotMatch(JSON.stringify(log), /PrivateName|SecondName|Marca|Modelo|3001234567/u);
  const retry = await transfer(a.advisor, a.tenantId, v.vehicleId, body(second, original.ownershipId));
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, changed.json);
  assert.equal((await rows(v.vehicleId)).length, 2);
  assert.equal((await audits(v.vehicleId)).length, beforeAudit + 1);
  assert.deepEqual(await snapshot(v.vehicleId), beforeVehicle);
  const listed = await history(a.advisor, a.tenantId, v.vehicleId);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(listed.json), ['owners']);
  assert.deepEqual(listed.json.owners.map((x) => x.ownershipId), [o.ownershipId, original.ownershipId]);
  for (const item of listed.json.owners) {
    assert.deepEqual(Object.keys(item).sort(), historyKeys);
    assert.deepEqual(Object.keys(item.customer).sort(), ['firstName', 'lastName']);
  }
  assert.equal((await audits(v.vehicleId)).length, beforeAudit + 1);
  assert.doesNotMatch(JSON.stringify(listed.json), /3001234567|Marca|Modelo|documentNumber|email|notes/u);
});

test('S2-06 empty current ownership, validation precedence, anti-oracle and media type', async () => {
  const { a, b } = await h.twoTenants();
  const c1 = await customer(a.owner, a.tenantId);
  const c2 = await customer(b.owner, b.tenantId);
  const { vehicle: v, ownership: original } = await vehicle(a.owner, a.tenantId, c1);
  const { vehicle: foreign, ownership: foreignOwnership } = await vehicle(b.owner, b.tenantId, c2);
  const foreignBefore = await audits(foreign.vehicleId);
  const localAuditBefore = await audits(v.vehicleId);
  const unknown = randomUUID();
  const missing = shape(await history(a.owner, a.tenantId, unknown));
  for (const id of [foreign.vehicleId, 'bad']) {
    assert.deepEqual(shape(await history(a.owner, a.tenantId, id)), missing);
    assert.deepEqual(shape(await transfer(a.owner, a.tenantId, id, body('bad', null))),
      { ...missing });
  }
  assert.equal((await audits(foreign.vehicleId)).length, foreignBefore.length);
  const noCustomer = shape(await transfer(a.owner, a.tenantId, v.vehicleId, body(randomUUID(), original.ownershipId)));
  for (const id of [c2, 'bad']) assert.deepEqual(
    shape(await transfer(a.owner, a.tenantId, v.vehicleId, body(id, original.ownershipId))), noCustomer);
  assert.equal(noCustomer.code, 'CUSTOMER_NOT_FOUND');
  for (const bad of [
    { customerId: c1 }, { expectedCurrentOwnershipId: null },
    body(c1, 'bad'), { ...body(c1, null), tenantId: a.tenantId },
    { ...body(c1, null), validFrom: '2020-01-01' },
  ]) {
    const r = await transfer(a.owner, a.tenantId, v.vehicleId, bad);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(code(r), 'REQUEST_VALIDATION_FAILED');
  }
  const unsupported = await transfer(a.owner, a.tenantId, v.vehicleId,
    body(c1, original.ownershipId), { headers: { 'content-type': 'text/plain' } });
  assert.equal(unsupported.status, 415);
  assert.equal(code(unsupported), 'UNSUPPORTED_MEDIA_TYPE');
  const badJson = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
    method: 'POST', url: path(v.vehicleId), rawBody: '{' });
  assert.equal(badJson.status, 400);
  assert.equal(code(badJson), 'REQUEST_BODY_MALFORMED');
  const conflict = await transfer(a.owner, a.tenantId, v.vehicleId, body(c2, null));
  assert.equal(conflict.status, 404); // foreign customer is resolved before the premise
  const c3 = await customer(a.owner, a.tenantId);
  for (const expected of [null, randomUUID(), foreignOwnership.ownershipId]) {
    const r = await transfer(a.owner, a.tenantId, v.vehicleId, body(c3, expected));
    assert.equal(r.status, 409);
    assert.equal(code(r), 'VEHICLE_OWNERSHIP_CONFLICT');
  }
  await h.admin`UPDATE public.vehicle_owners SET valid_to=pg_catalog.clock_timestamp()
    WHERE id=${original.ownershipId}`;
  const wrongEmptyPremise = await transfer(a.owner, a.tenantId, v.vehicleId,
    body(c3, original.ownershipId));
  assert.equal(wrongEmptyPremise.status, 409);
  assert.equal(code(wrongEmptyPremise), 'VEHICLE_OWNERSHIP_CONFLICT');
  assert.equal((await audits(v.vehicleId)).length, localAuditBefore.length);
  const empty = await transfer(a.owner, a.tenantId, v.vehicleId, body(c3, null));
  assert.equal(empty.status, 201, JSON.stringify(empty.json));
  assert.equal((await audits(v.vehicleId)).at(-1).before_json, null);
  assert.equal((await rows(v.vehicleId)).length, 2);
});

test('S2-06 history cap, timestamp tie-break, RLS and service tenant permission', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const { vehicle: v } = await vehicle(a.owner, a.tenantId, ca);
  const { vehicle: foreign } = await vehicle(b.owner, b.tenantId, cb);
  const ids = Array.from({ length: 201 }, () => randomUUID());
  const seed = ids.map((id) => ({ id, tenant_id: a.tenantId, vehicle_id: v.vehicleId,
    customer_id: ca, relationship_type: 'owner', is_primary: false,
    valid_from: '2020-01-01T00:00:00.123456Z', valid_to: '2021-01-01T00:00:00.123456Z' }));
  await h.admin`INSERT INTO public.vehicle_owners ${h.admin(seed)}`;
  const listed = await history(a.owner, a.tenantId, v.vehicleId);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.owners.length, 200);
  assert.deepEqual(listed.json.owners.slice(1).map((x) => x.ownershipId),
    ids.sort().reverse().slice(0, 199));
  const bind = { tenantId: a.tenantId, userId: a.owner.user.id, membershipId: a.owner.membershipId };
  assert.equal((await h.asRuntime(h.apiPool, bind,
    (tx) => tx`SELECT id FROM public.vehicle_owners WHERE vehicle_id=${foreign.vehicleId}`)).length, 0);
  assert.equal((await h.apiPool`SELECT id FROM public.vehicle_owners`).length, 0);
  const [rls] = await h.apiPool`SELECT relrowsecurity, relforcerowsecurity
    FROM pg_catalog.pg_class WHERE oid='public.vehicle_owners'::regclass`;
  assert.equal(rls.relrowsecurity, true);
  assert.equal(rls.relforcerowsecurity, true);
  await assert.rejects(listOwnerHistory({ tenant: { permissions: new Map([
    ['vehicles.read', { kind: 'restricted', scopes: new Set(['assigned']) }],
  ]) } }, v.vehicleId),
    (e) => e.code === 'PERMISSION_DENIED');
  assert.equal(mapVehicleDbError({ code: '23505', constraint: 'vehicle_owners_one_primary_uq' }).code,
    'VEHICLE_OWNERSHIP_CONFLICT');
});

test('S2-06 RBAC guard survives vehicles.update; technician denied even when assigned', async () => {
  const { a } = await h.twoTenants();
  const c1 = await customer(a.owner, a.tenantId);
  const c2 = await customer(a.owner, a.tenantId);
  const { vehicle: v, ownership: o } = await vehicle(a.owner, a.tenantId, c1);
  for (const action of [() => history(a.technician, a.tenantId, v.vehicleId),
    () => transfer(a.technician, a.tenantId, v.vehicleId, body(c2, o.ownershipId))]) {
    const r = await action(); assert.equal(r.status, 403); assert.equal(code(r), 'PERMISSION_DENIED');
  }
  const receptionId = randomUUID(); const orderId = randomUUID();
  await h.admin.begin(async (tx) => {
    const mediaId = randomUUID();
    await tx`INSERT INTO public.receptions
      (id,tenant_id,vehicle_id,customer_id,received_by_membership_id,mileage_km)
      VALUES (${receptionId},${a.tenantId},${v.vehicleId},${c1},${a.advisor.membershipId},0)`;
    await tx`INSERT INTO public.media_assets
      (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES (${mediaId},${a.tenantId},'fixture',${mediaId},'signature','image/png','active','operational','v1')`;
    await tx`INSERT INTO public.signatures
      (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at,document_version,document_hash)
      VALUES (${randomUUID()},${a.tenantId},${receptionId},'Fixture',${mediaId},now(),'v1',${'a'.repeat(64)})`;
    await tx`UPDATE public.receptions SET status='closed', closed_at=now() WHERE id=${receptionId}`;
    await tx`INSERT INTO public.service_orders
      (id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
      VALUES (${orderId},${a.tenantId},${receptionId},${v.vehicleId},${c1},
        ${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)},${a.advisor.membershipId})`;
    await tx`INSERT INTO public.order_status_history
      (id,tenant_id,order_id,to_status,request_id)
      VALUES (${randomUUID()},${a.tenantId},${orderId},'reception',${randomUUID()})`;
  });
  await h.admin`INSERT INTO public.assignments
    (id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
    VALUES (${randomUUID()},${a.tenantId},${orderId},${a.technician.membershipId},
      'lead_technician',${a.advisor.membershipId})`;
  assert.equal((await h.call(app, { subject: a.technician.subject, tenantId: a.tenantId,
    url: `/api/v1/vehicles/${v.vehicleId}` })).status, 200);
  assert.equal((await history(a.technician, a.tenantId, v.vehicleId)).status, 403);
  assert.equal((await transfer(a.technician, a.tenantId, v.vehicleId, body(c2, o.ownershipId))).status, 403);
  const [role] = await h.admin`SELECT id FROM public.roles WHERE code='service_advisor'`;
  const [permission] = await h.admin`SELECT id FROM public.permissions WHERE code='vehicle_owners.manage'`;
  const [vehicleUpdate] = await h.admin`SELECT id FROM public.permissions WHERE code='vehicles.update'`;
  const [savedGrant] = await h.admin`SELECT resource_scope FROM public.role_permissions
    WHERE role_id=${role.id} AND permission_id=${permission.id}`;
  await h.admin`DELETE FROM public.role_permissions WHERE role_id=${role.id} AND permission_id=${permission.id}`;
  try {
    const [still] = await h.admin`SELECT count(*)::int AS n FROM public.role_permissions
      WHERE role_id=${role.id} AND permission_id=${vehicleUpdate.id}`;
    assert.equal(still.n, 1);
    const denied = await transfer(a.advisor, a.tenantId, v.vehicleId, body(c2, o.ownershipId));
    assert.equal(denied.status, 403); assert.equal(code(denied), 'PERMISSION_DENIED');
  } finally {
    await h.admin`INSERT INTO public.role_permissions (role_id,permission_id,resource_scope)
      VALUES (${role.id},${permission.id},${savedGrant.resource_scope}) ON CONFLICT DO NOTHING`;
  }
  assert.equal((await rows(v.vehicleId)).length, 1);
  assert.equal((await audits(v.vehicleId)).length, 1);
});

test('S2-06 GET owners independently requires customers.read while vehicle detail retains vehicles.read', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const { vehicle: v } = await vehicle(a.owner, a.tenantId, ca);
  const [role] = await h.admin`SELECT id FROM public.roles WHERE code='service_advisor'`;
  const [customerPermission] = await h.admin`SELECT id FROM public.permissions WHERE code='customers.read'`;
  const [vehiclePermission] = await h.admin`SELECT id FROM public.permissions WHERE code='vehicles.read'`;
  const [grant] = await h.admin`SELECT resource_scope FROM public.role_permissions
    WHERE role_id=${role.id} AND permission_id=${customerPermission.id}`;
  assert.ok(grant, 'service_advisor must initially have customers.read');
  await h.admin`DELETE FROM public.role_permissions
    WHERE role_id=${role.id} AND permission_id=${customerPermission.id}`;
  try {
    const [retained] = await h.admin`SELECT count(*)::int AS n FROM public.role_permissions
      WHERE role_id=${role.id} AND permission_id=${vehiclePermission.id}`;
    assert.equal(retained.n, 1);
    const denied = await history(a.advisor, a.tenantId, v.vehicleId);
    assert.equal(denied.status, 403);
    assert.equal(code(denied), 'PERMISSION_DENIED');
    const detail = await h.call(app, { subject: a.advisor.subject, tenantId: a.tenantId,
      url: `/api/v1/vehicles/${v.vehicleId}` });
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
  } finally {
    await h.admin`INSERT INTO public.role_permissions (role_id,permission_id,resource_scope)
      VALUES (${role.id},${customerPermission.id},${grant.resource_scope}) ON CONFLICT DO NOTHING`;
  }
});

test('S2-06 transfers preserve exact PostgreSQL microseconds across consecutive owners', async () => {
  const clock = await h.admin`SELECT pg_catalog.to_char(
    pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
    FROM pg_catalog.generate_series(1, 64)`;
  const hasSubMillisecond = (value) => Number(value.slice(-4, -1)) !== 0;
  assert.ok(clock.some((sample) => hasSubMillisecond(sample.t)),
    'POSTGRES_CLOCK_LACKS_SUB_MS_PRECISION');
  const { a } = await h.twoTenants();
  const customers = [];
  for (let i = 0; i < 4; i++) customers.push(await customer(a.owner, a.tenantId));
  const { vehicle: v, ownership: first } = await vehicle(a.owner, a.tenantId, customers[0]);
  let priorId = first.ownershipId;
  let sawSubMillisecond = false;
  for (const nextCustomer of customers.slice(1)) {
    const result = await transfer(a.owner, a.tenantId, v.vehicleId, body(nextCustomer, priorId));
    assert.equal(result.status, 201, JSON.stringify(result.json));
    const nextId = result.json.ownership.ownershipId;
    const [boundary] = await h.admin`SELECT previous.valid_to = successor.valid_from AS same,
      pg_catalog.to_char(previous.valid_to AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS closed,
      pg_catalog.to_char(successor.valid_from AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opened
      FROM public.vehicle_owners AS previous
      JOIN public.vehicle_owners AS successor ON successor.id=${nextId}
      WHERE previous.id=${priorId}`;
    assert.equal(boundary.same, true, 'close and successor must share one exact database timestamp');
    assert.equal(boundary.closed, boundary.opened);
    assert.equal(result.json.ownership.validFrom, boundary.opened);
    sawSubMillisecond ||= hasSubMillisecond(boundary.opened);
    priorId = nextId;
  }
  assert.ok(sawSubMillisecond, 'transfers must retain real sub-millisecond precision');
});

test('S2-06 audit failure rolls back close and successor', async () => {
  const { a } = await h.twoTenants();
  const c1 = await customer(a.owner, a.tenantId); const c2 = await customer(a.owner, a.tenantId);
  const { vehicle: v, ownership: o } = await vehicle(a.owner, a.tenantId, c1);
  const before = await audits(v.vehicleId);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'vehicle.owner_changed'");
  try {
    const r = await transfer(a.owner, a.tenantId, v.vehicleId, body(c2, o.ownershipId));
    assert.equal(r.status, 500); assert.equal(code(r), 'INTERNAL_ERROR');
  } finally { await remove(); }
  assert.equal((await rows(v.vehicleId)).length, 1);
  assert.equal((await rows(v.vehicleId))[0].valid_to, null);
  assert.equal((await audits(v.vehicleId)).length, before.length);
});

/** Assert an actual PostgreSQL wait edge; elapsed time is never the evidence. */
async function blockedBy(holderPid, unsettled) {
  for (let i = 0; i < 200; i++) {
    const blocked = await h.admin`SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND ${holderPid} = ANY(pg_catalog.pg_blocking_pids(pid))`;
    if (blocked.length) { assert.equal(unsettled(), true); return blocked[0].pid; }
    if (!unsettled()) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('request did not show a PostgreSQL blocking edge to holder');
}
async function holderLock(tenantId, vehicleId, mode = 'FOR NO KEY UPDATE') {
  const holder = await h.admin.reserve();
  await holder.unsafe('BEGIN');
  const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
  await holder.unsafe(`SELECT id FROM public.vehicles WHERE tenant_id=$1 AND id=$2 ${mode}`,
    [tenantId, vehicleId]);
  return { holder, pid: backend.pid };
}
async function holderSuccessor(holder, tenantId, vehicleId, currentId, customerId, nextId = randomUUID()) {
  const [t] = await holder`SELECT pg_catalog.clock_timestamp() AS value`;
  await holder`UPDATE public.vehicle_owners SET valid_to=${t.value} WHERE id=${currentId}`;
  await holder`INSERT INTO public.vehicle_owners
    (id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary,valid_from)
    VALUES (${nextId},${tenantId},${vehicleId},${customerId},'owner',true,${t.value})`;
  return nextId;
}
async function lockedRequest(a, vehicleId, requested, expected, mode, holderWrite, expectedStatus) {
  const { holder, pid } = await holderLock(a.tenantId, vehicleId, mode);
  let settled = false;
  try {
    const pending = transfer(a.owner, a.tenantId, vehicleId, body(requested, expected))
      .finally(() => { settled = true; });
    await blockedBy(pid, () => !settled);
    if (holderWrite) await holderWrite(holder);
    await holder.unsafe('COMMIT');
    const result = await pending;
    assert.equal(result.status, expectedStatus, JSON.stringify(result.json));
    return result;
  } finally {
    await holder.unsafe('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}

test('S2-06 C1-C4 and C6: lock-proven serialization, retry, stale premise and timestamp', async () => {
  const { a } = await h.twoTenants();
  const c0 = await customer(a.owner, a.tenantId);
  const c1 = await customer(a.owner, a.tenantId);
  const c2 = await customer(a.owner, a.tenantId);
  const c3 = await customer(a.owner, a.tenantId);
  const c4 = await customer(a.owner, a.tenantId);
  const c5 = await customer(a.owner, a.tenantId);
  const { vehicle: v, ownership: start } = await vehicle(a.owner, a.tenantId, c0);
  const r1 = await lockedRequest(a, v.vehicleId, c1, start.ownershipId,
    'FOR NO KEY UPDATE', null, 201); // C1
  let current = r1.json.ownership.ownershipId;
  const countBeforeRetry = (await rows(v.vehicleId)).length;
  const auditBeforeRetry = (await audits(v.vehicleId)).length;
  const holderId = randomUUID();
  const r2 = await lockedRequest(a, v.vehicleId, c2, current, 'FOR NO KEY UPDATE',
    (holder) => holderSuccessor(holder, a.tenantId, v.vehicleId, current, c2, holderId), 200); // C2
  assert.equal(r2.json.ownership.ownershipId, holderId);
  assert.equal((await rows(v.vehicleId)).length, countBeforeRetry + 1);
  assert.equal((await audits(v.vehicleId)).length, auditBeforeRetry);
  current = holderId;
  const nextId = randomUUID();
  const r3 = await lockedRequest(a, v.vehicleId, c3, current, 'FOR NO KEY UPDATE',
    (holder) => holderSuccessor(holder, a.tenantId, v.vehicleId, current, c4, nextId), 409); // C3
  assert.equal(code(r3), 'VEHICLE_OWNERSHIP_CONFLICT');
  current = nextId;
  const known = randomUUID();
  const r4 = await lockedRequest(a, v.vehicleId, c3, known, 'FOR NO KEY UPDATE',
    (holder) => holderSuccessor(holder, a.tenantId, v.vehicleId, current, c5, known), 201); // C4
  const [later] = await h.admin`SELECT b.valid_from > a.valid_from AS later
    FROM public.vehicle_owners a JOIN public.vehicle_owners b ON b.id=${r4.json.ownership.ownershipId}
    WHERE a.id=${known}`;
  assert.equal(later.later, true);
  const r6 = await lockedRequest(a, v.vehicleId, c4, r4.json.ownership.ownershipId,
    'FOR SHARE', null, 201); // C6: FOR SHARE blocks FOR NO KEY UPDATE
  assert.equal(r6.json.ownership.customerId, c4);
});

test('S2-06 C5: two competing transfers both blocked, one successor and one conflict', async () => {
  const { a } = await h.twoTenants();
  const c0 = await customer(a.owner, a.tenantId);
  const c1 = await customer(a.owner, a.tenantId);
  const c2 = await customer(a.owner, a.tenantId);
  const { vehicle: v, ownership: start } = await vehicle(a.owner, a.tenantId, c0);
  const beforeRows = (await rows(v.vehicleId)).length;
  const beforeAudit = (await audits(v.vehicleId)).length;
  const { holder, pid } = await holderLock(a.tenantId, v.vehicleId);
  let settled1 = false; let settled2 = false;
  try {
    const first = transfer(a.owner, a.tenantId, v.vehicleId, body(c1, start.ownershipId))
      .finally(() => { settled1 = true; });
    const second = transfer(a.advisor, a.tenantId, v.vehicleId, body(c2, start.ownershipId))
      .finally(() => { settled2 = true; });
    for (let i = 0; i < 200; i++) {
      const waits = await h.admin`SELECT pid, pg_catalog.pg_blocking_pids(pid) AS blockers
        FROM pg_catalog.pg_stat_activity WHERE datname=pg_catalog.current_database()
          AND pid<>pg_catalog.pg_backend_pid() AND pid<>${pid}`;
      const direct = waits.filter((row) => row.blockers.includes(pid));
      const queued = waits.filter((row) => row.blockers.some((blocker) =>
        blocker === pid || direct.some((firstWaiter) => firstWaiter.pid === blocker)));
      if (queued.length >= 2) break;
      if (i === 199) assert.fail('both transfer requests must be blocked by the holder');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled1, false); assert.equal(settled2, false);
    await holder.unsafe('COMMIT');
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [201, 409]);
    assert.equal(code(outcomes.find((r) => r.status === 409)), 'VEHICLE_OWNERSHIP_CONFLICT');
  } finally {
    await holder.unsafe('ROLLBACK').catch(() => undefined); holder.release();
  }
  assert.equal((await rows(v.vehicleId)).length, beforeRows + 1);
  assert.equal((await audits(v.vehicleId)).length, beforeAudit + 1);
});

test('S2-06 EPQ: out-of-protocol child close blocks API close, then returns conflict', async () => {
  const { a } = await h.twoTenants();
  const c0 = await customer(a.owner, a.tenantId);
  const c1 = await customer(a.owner, a.tenantId);
  const { vehicle: v, ownership: start } = await vehicle(a.owner, a.tenantId, c0);
  const beforeAudit = (await audits(v.vehicleId)).length;
  const writer = await h.admin.reserve();
  await writer.unsafe('BEGIN');
  const [backend] = await writer`SELECT pg_catalog.pg_backend_pid() AS pid`;
  await writer`UPDATE public.vehicle_owners SET valid_to=pg_catalog.clock_timestamp()
    WHERE id=${start.ownershipId}`;
  let settled = false;
  try {
    const pending = transfer(a.owner, a.tenantId, v.vehicleId, body(c1, start.ownershipId))
      .finally(() => { settled = true; });
    await blockedBy(backend.pid, () => !settled);
    await writer.unsafe('COMMIT');
    const result = await pending;
    assert.equal(result.status, 409, JSON.stringify(result.json));
    assert.equal(code(result), 'VEHICLE_OWNERSHIP_CONFLICT');
  } finally {
    await writer.unsafe('ROLLBACK').catch(() => undefined); writer.release();
  }
  assert.equal((await rows(v.vehicleId)).length, 1);
  assert.equal((await audits(v.vehicleId)).length, beforeAudit);
});
