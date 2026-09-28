'use strict';

/** S2-05 HTTP + PostgreSQL contract, on the existing hermetic CRM API harness. */
const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { createVehicle: createVehicleService } = h.load('vehicles/service.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
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
const valid = (customerId, plate = 'ABC123', extra = {}) =>
  ({ customerId, plate, vehicleType: 'car', brand: 'Marca', model: 'Modelo', ...extra });
const create = (actor, tenantId, body) => h.call(app, {
  subject: actor.subject, method: 'POST', url: '/api/v1/vehicles', tenantId, body,
});
const get = (actor, tenantId, id) => h.call(app, {
  subject: actor.subject, url: `/api/v1/vehicles/${id}`, tenantId,
});
const list = (actor, tenantId, query = '') => h.call(app, {
  subject: actor.subject, url: `/api/v1/vehicles${query ? `?${query}` : ''}`, tenantId,
});
const patch = (actor, tenantId, id, body) => h.call(app, {
  subject: actor.subject, method: 'PATCH', url: `/api/v1/vehicles/${id}`, tenantId, body,
});
const cursor = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
async function customer(actor, tenantId) {
  const r = await h.createCustomer(app, actor, tenantId, h.validCustomer());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.customer.customerId;
}
async function vehicle(actor, tenantId, customerId, plate = `P${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`) {
  const r = await create(actor, tenantId, valid(customerId, plate));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.vehicle;
}
async function row(id) {
  const [r] = await h.admin`SELECT id, tenant_id, plate, model, xmin::text AS xmin,
    pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM public.vehicles WHERE id=${id}`;
  return r && { ...r };
}
async function audits(id) {
  return h.admin`SELECT action, tenant_id, actor_type, actor_user_id, actor_membership_id,
    before_json, after_json, metadata_json, user_agent, request_id FROM public.audit_logs
    WHERE entity_type='vehicle' AND entity_id=${id} ORDER BY created_at, id`;
}
async function vehicleAuditCount(tenantId) {
  const [result] = await h.admin`SELECT count(*)::int AS n FROM public.audit_logs
    WHERE tenant_id=${tenantId} AND action LIKE 'vehicle.%'`;
  return result.n;
}
async function count(tenantId) {
  const [r] = await h.admin`SELECT count(*)::int AS n FROM public.vehicles WHERE tenant_id=${tenantId}`;
  return r.n;
}
function errorShape(r) {
  return JSON.stringify({ status: r.status, code: code(r), message: r.json?.error?.message });
}

test('S2-05 POST: atomic vehicle, initial primary owner, two minimized audit events; same plate across tenants', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.advisor, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const created = await create(a.advisor, a.tenantId, valid(ca, ' abc-123 ', {
    brand: '  Mar\u0063a  ', model: ' M ', modelYear: null, color: '   ', vin: null, engineNumber: '',
  }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.headers['cache-control'], 'no-store');
  const { vehicle: v, ownership: o } = created.json;
  assert.deepEqual(Object.keys(v).sort(), [
    'vehicleId', 'plate', 'vehicleType', 'brand', 'model', 'modelYear', 'color', 'vin',
    'engineNumber', 'currentMileageKm', 'createdAt', 'updatedAt',
  ].sort());
  assert.equal(v.plate, 'ABC123');
  assert.equal(v.brand, 'Marca');
  assert.equal(v.model, 'M');
  for (const key of ['modelYear', 'color', 'vin', 'engineNumber', 'currentMileageKm']) assert.equal(v[key], null);
  assert.match(v.vehicleId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.match(v.updatedAt, h.TOKEN_FORMAT);
  assert.equal(o.vehicleId, v.vehicleId);
  assert.equal(o.customerId, ca);
  assert.equal(o.relationshipType, 'owner');
  assert.equal(o.isPrimary, true);
  assert.equal(o.validTo, null);
  const [dbOwner] = await h.admin`SELECT id, tenant_id, vehicle_id, customer_id, relationship_type,
    is_primary, valid_to FROM public.vehicle_owners WHERE vehicle_id=${v.vehicleId}`;
  assert.equal(dbOwner.id, o.ownershipId);
  assert.equal(dbOwner.tenant_id, a.tenantId);
  assert.equal(dbOwner.customer_id, ca);
  assert.equal(dbOwner.relationship_type, 'owner');
  assert.equal(dbOwner.is_primary, true);
  assert.equal(dbOwner.valid_to, null);
  const entries = await audits(v.vehicleId);
  assert.deepEqual(entries.map((e) => e.action).sort(), ['vehicle.created', 'vehicle.owner_changed']);
  const createdAudit = entries.find((e) => e.action === 'vehicle.created');
  const ownerAudit = entries.find((e) => e.action === 'vehicle.owner_changed');
  assert.deepEqual(createdAudit.metadata_json, { ownership_id: o.ownershipId, customer_id: ca });
  assert.deepEqual(ownerAudit.after_json, { ownership_id: o.ownershipId, customer_id: ca });
  assert.deepEqual(ownerAudit.metadata_json, { command: 'create' });
  assert.equal(ownerAudit.before_json, null);
  for (const e of entries) {
    assert.equal(e.actor_type, 'user');
    assert.equal(e.actor_user_id, a.advisor.user.id);
    assert.equal(e.actor_membership_id, a.advisor.membershipId);
    assert.equal(e.user_agent, null);
    assert.equal(JSON.stringify(e).includes('ABC123'), false);
  }
  const duplicate = await create(a.owner, a.tenantId, valid(ca, 'ABC.123'));
  assert.equal(duplicate.status, 409);
  assert.equal(code(duplicate), 'VEHICLE_PLATE_ALREADY_EXISTS');
  assert.equal((await create(b.owner, b.tenantId, valid(cb, 'ABC 123'))).status, 201);
  assert.equal((await get(a.owner, a.tenantId, v.vehicleId)).json.vehicle.plate, 'ABC123');
});

test('S2-05 POST rollback: invalid/foreign customer, owner insert failure, or either audit failure leaves no vehicle', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const before = await count(a.tenantId);
  for (const id of [cb, randomUUID(), 'not-a-uuid']) {
    const response = await create(a.owner, a.tenantId, valid(id, `Z${randomUUID().slice(0, 8)}`));
    assert.equal(response.status, 404);
    assert.equal(code(response), 'CUSTOMER_NOT_FOUND');
  }
  const foreignShape = errorShape(await create(a.owner, a.tenantId, valid(cb, 'ZFOREIGN')));
  assert.equal(foreignShape, errorShape(await create(a.owner, a.tenantId, valid(randomUUID(), 'ZMISSING'))));
  assert.equal(foreignShape, errorShape(await create(a.owner, a.tenantId, valid('bad', 'ZBAD'))));
  assert.equal(await count(a.tenantId), before);
  for (const [table, condition] of [
    ['vehicle_owners', 'true'],
    ['audit_logs', "NEW.action = 'vehicle.created'"],
    ['audit_logs', "NEW.action = 'vehicle.owner_changed'"],
  ]) {
    const remove = await h.injectFailure(table, condition);
    try {
      const response = await create(a.owner, a.tenantId, valid(ca, `Z${randomUUID().slice(0, 8)}`));
      assert.equal(response.status, 500, JSON.stringify(response.json));
      assert.equal(code(response), 'INTERNAL_ERROR');
    } finally { await remove(); }
    assert.equal(await count(a.tenantId), before, `${table} failure rolled vehicle back`);
  }
});

test('S2-05 boundary: one and sixteen character plates, model-year endpoints, media type and absent archive', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const single = await create(a.owner, a.tenantId, valid(ca, 'a', { modelYear: 1886 }));
  assert.equal(single.status, 201, JSON.stringify(single.json));
  assert.equal(single.json.vehicle.plate, 'A');
  assert.equal(single.json.vehicle.modelYear, 1886);
  assert.equal((await row(single.json.vehicle.vehicleId)).plate, 'A');
  assert.deepEqual((await list(a.owner, a.tenantId, 'plate=a')).json.vehicles.map((v) => v.vehicleId),
    [single.json.vehicle.vehicleId]);
  const longest = await create(a.owner, a.tenantId,
    valid(ca, 'ABCDEFGHIJKLMNOP', { modelYear: 2200 }));
  assert.equal(longest.status, 201, JSON.stringify(longest.json));
  assert.equal(longest.json.vehicle.plate, 'ABCDEFGHIJKLMNOP');
  assert.equal(longest.json.vehicle.modelYear, 2200);
  const firstPatch = await patch(a.owner, a.tenantId, single.json.vehicle.vehicleId,
    { expectedUpdatedAt: single.json.vehicle.updatedAt, modelYear: 2200 });
  assert.equal(firstPatch.status, 200, JSON.stringify(firstPatch.json));
  assert.equal(firstPatch.json.vehicle.modelYear, 2200);
  const secondPatch = await patch(a.owner, a.tenantId, longest.json.vehicle.vehicleId,
    { expectedUpdatedAt: longest.json.vehicle.updatedAt, modelYear: 1886 });
  assert.equal(secondPatch.status, 200, JSON.stringify(secondPatch.json));
  assert.equal(secondPatch.json.vehicle.modelYear, 1886);
  for (const year of [1885, 2201]) {
    assert.equal((await create(a.owner, a.tenantId,
      valid(ca, `Y${year}`, { modelYear: year }))).status, 400);
    const rejected = await patch(a.owner, a.tenantId, single.json.vehicle.vehicleId,
      { expectedUpdatedAt: firstPatch.json.vehicle.updatedAt, modelYear: year });
    assert.equal(rejected.status, 400);
    assert.equal(code(rejected), 'REQUEST_VALIDATION_FAILED');
  }
  const before = await audits(single.json.vehicle.vehicleId);
  const beforeTenantAudits = await vehicleAuditCount(a.tenantId);
  for (const [method, url] of [
    ['POST', '/api/v1/vehicles'],
    ['PATCH', `/api/v1/vehicles/${single.json.vehicle.vehicleId}`],
  ]) {
    const unsupported = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
      method, url, body: method === 'POST' ? valid(ca, 'MEDIA1') :
        { expectedUpdatedAt: firstPatch.json.vehicle.updatedAt, brand: 'Changed' },
      headers: { 'content-type': 'text/plain' } });
    assert.equal(unsupported.status, 415, JSON.stringify(unsupported.json));
    assert.equal(code(unsupported), 'UNSUPPORTED_MEDIA_TYPE');
  }
  assert.deepEqual(await audits(single.json.vehicle.vehicleId), before);
  assert.equal(await vehicleAuditCount(a.tenantId), beforeTenantAudits);
  assert.equal(app.hasRoute({ method: 'DELETE', url: '/api/v1/vehicles/:vehicleId' }), false);
  assert.equal(app.hasRoute({ method: 'POST', url: '/api/v1/vehicles/:vehicleId/archive' }), false);
  for (const [method, url] of [
    ['DELETE', `/api/v1/vehicles/${single.json.vehicle.vehicleId}`],
    ['POST', `/api/v1/vehicles/${single.json.vehicle.vehicleId}/archive`],
  ]) assert.equal((await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method, url })).status, 404);
  assert.deepEqual(await audits(single.json.vehicle.vehicleId), before);
  assert.equal(await vehicleAuditCount(a.tenantId), beforeTenantAudits);
});

test('S2-05 RBAC, anti-oracle, exact plate search and keyset pagination', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const created = [];
  for (let i = 0; i < 24; i++) created.push(await vehicle(a.owner, a.tenantId, ca, `Q${String(i).padStart(3, '0')}`));
  const foreign = await vehicle(b.owner, b.tenantId, cb, 'Q000');
  const expected = [...created].sort((x, y) => y.vehicleId.localeCompare(x.vehicleId));
  const first = await list(a.advisor, a.tenantId);
  assert.equal(first.status, 200);
  assert.equal(first.json.vehicles.length, 20);
  assert.deepEqual(first.json.vehicles.map((v) => v.vehicleId), expected.slice(0, 20).map((v) => v.vehicleId));
  const second = await list(a.admin, a.tenantId, `cursor=${first.json.nextCursor}`);
  assert.deepEqual(second.json.vehicles.map((v) => v.vehicleId), expected.slice(20).map((v) => v.vehicleId));
  assert.equal(second.json.nextCursor, null);
  assert.deepEqual((await list(a.owner, a.tenantId, 'plate=q-000')).json.vehicles.map((v) => v.vehicleId), [created[0].vehicleId]);
  assert.equal((await list(a.owner, a.tenantId, 'plate=Q00')).json.vehicles.length, 0);
  for (const query of ['limit=0', 'limit=101', 'cursor=bad', 'plate=%C3%B1', 'q=Q000', 'plate=Q000&plate=Q001'])
    assert.equal((await list(a.owner, a.tenantId, query)).status, 400, query);
  for (const payload of [
    { v: 2, id: created[0].vehicleId },
    { v: 1, id: created[0].vehicleId.toUpperCase() },
    { v: 1, id: created[0].vehicleId, extra: true },
    [1, created[0].vehicleId],
    'not-an-object',
  ]) {
    const response = await list(a.owner, a.tenantId, `cursor=${cursor(payload)}`);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  const foreignRead = await get(a.owner, a.tenantId, foreign.vehicleId);
  assert.equal(errorShape(foreignRead), errorShape(await get(a.owner, a.tenantId, randomUUID())));
  assert.equal(errorShape(foreignRead), errorShape(await get(a.owner, a.tenantId, 'bad')));
  assert.equal((await patch(a.owner, a.tenantId, foreign.vehicleId,
    { expectedUpdatedAt: foreign.updatedAt, brand: 'Robado' })).status, 404);
  for (const actor of [a.owner, a.admin, a.advisor]) {
    assert.equal((await get(actor, a.tenantId, created[0].vehicleId)).status, 200);
    assert.equal((await list(actor, a.tenantId, 'limit=1')).status, 200);
  }
  for (const attempt of [
    () => create(a.technician, a.tenantId, valid(ca, 'TECH1')),
    () => list(a.technician, a.tenantId),
    () => patch(a.technician, a.tenantId, created[0].vehicleId,
      { expectedUpdatedAt: created[0].updatedAt, brand: 'X' }),
  ]) {
    const r = await attempt();
    assert.equal(r.status, 403);
    assert.equal(code(r), 'PERMISSION_DENIED');
  }
  assert.equal((await get(a.technician, a.tenantId, created[0].vehicleId)).status, 404);
});

test('S2-05 technician detail: active lead/support only; released and QC-only return the same 404', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, ca);
  const receptionId = randomUUID();
  const orderId = randomUUID();
  await h.admin.begin(async (tx) => {
    const mediaId = randomUUID();
    await tx`INSERT INTO public.receptions
      (id,tenant_id,vehicle_id,customer_id,received_by_membership_id,mileage_km)
      VALUES (${receptionId},${a.tenantId},${v.vehicleId},${ca},${a.advisor.membershipId},0)`;
    await tx`INSERT INTO public.media_assets
      (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES (${mediaId},${a.tenantId},'fixture',${mediaId},'signature','image/png','active','operational','v1')`;
    await tx`INSERT INTO public.signatures
      (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at,document_version,document_hash)
      VALUES (${randomUUID()},${a.tenantId},${receptionId},'Fixture',${mediaId},now(),'v1',${'a'.repeat(64)})`;
    await tx`UPDATE public.receptions SET status='closed', closed_at=now() WHERE id=${receptionId}`;
    await tx`INSERT INTO public.service_orders
      (id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
      VALUES (${orderId},${a.tenantId},${receptionId},${v.vehicleId},${ca},
        ${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)},${a.advisor.membershipId})`;
    await tx`INSERT INTO public.order_status_history
      (id,tenant_id,order_id,to_status,request_id)
      VALUES (${randomUUID()},${a.tenantId},${orderId},'reception',${randomUUID()})`;
  });
  const makeAssignment = async (type) => {
    const id = randomUUID();
    await h.admin`INSERT INTO public.assignments
      (id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
      VALUES (${id},${a.tenantId},${orderId},${a.technician.membershipId},${type},${a.advisor.membershipId})`;
    return id;
  };
  const missing = await get(a.technician, a.tenantId, v.vehicleId);
  assert.equal(missing.status, 404);
  const lead = await makeAssignment('lead_technician');
  const leadRead = await get(a.technician, a.tenantId, v.vehicleId);
  assert.equal(leadRead.status, 200, JSON.stringify(leadRead.json));
  assert.deepEqual(Object.keys(leadRead.json.vehicle).sort(),
    ['vehicleId', 'plate', 'vehicleType', 'brand', 'model', 'modelYear', 'color'].sort());
  assert.equal(JSON.stringify(leadRead.json).includes(ca), false);
  await h.admin`UPDATE public.assignments SET released_at=pg_catalog.clock_timestamp() WHERE id=${lead}`;
  assert.equal(errorShape(await get(a.technician, a.tenantId, v.vehicleId)), errorShape(missing));
  const support = await makeAssignment('support_technician');
  assert.equal((await get(a.technician, a.tenantId, v.vehicleId)).status, 200);
  await h.admin`UPDATE public.assignments SET released_at=pg_catalog.clock_timestamp() WHERE id=${support}`;
  await makeAssignment('quality_control');
  assert.equal(errorShape(await get(a.technician, a.tenantId, v.vehicleId)), errorShape(missing));
  assert.equal((await list(a.technician, a.tenantId)).status, 403);
  assert.equal((await patch(a.technician, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: v.updatedAt, model: 'X' })).status, 403);
});

test('S2-05 PATCH: exact microsecond OCC, stale before no-op, no-op xmin and changed-fields order', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, ca);
  await h.admin`UPDATE public.vehicles SET updated_at='2026-03-04T05:06:07.123456Z' WHERE id=${v.vehicleId}`;
  const exact = (await get(a.owner, a.tenantId, v.vehicleId)).json.vehicle;
  assert.equal(exact.updatedAt, '2026-03-04T05:06:07.123456Z');
  const before = await row(v.vehicleId);
  const beforeAudit = (await audits(v.vehicleId)).length;
  const noOp = await patch(a.admin, a.tenantId, v.vehicleId, {
    expectedUpdatedAt: exact.updatedAt, plate: ` ${exact.plate} `, brand: ' Marca ', color: '  ',
  });
  assert.equal(noOp.status, 200, JSON.stringify(noOp.json));
  assert.deepEqual(noOp.json.vehicle, exact);
  assert.deepEqual(await row(v.vehicleId), before);
  assert.equal((await audits(v.vehicleId)).length, beforeAudit);
  const stale = await patch(a.owner, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: '2026-03-04T05:06:07.123000Z', brand: 'Marca' });
  assert.equal(stale.status, 409);
  assert.equal(code(stale), 'RESOURCE_VERSION_CONFLICT');
  const updated = await patch(a.advisor, a.tenantId, v.vehicleId, {
    expectedUpdatedAt: exact.updatedAt, engineNumber: ' E2 ', brand: 'Nuevo', plate: 'XYZ-789',
    modelYear: 2020, color: 'Rojo', vin: 'vin-low', vehicleType: 'motorcycle', model: 'M2',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.ok(updated.json.vehicle.updatedAt > exact.updatedAt);
  assert.equal(updated.json.vehicle.currentMileageKm, null);
  const ca2 = await customer(a.owner, a.tenantId);
  const other = await vehicle(a.owner, a.tenantId, ca2, 'DUP777');
  const plateConflict = await patch(a.owner, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: updated.json.vehicle.updatedAt, plate: 'DUP-777' });
  assert.equal(plateConflict.status, 409);
  assert.equal(code(plateConflict), 'VEHICLE_PLATE_ALREADY_EXISTS');
  assert.equal((await row(v.vehicleId)).plate, 'XYZ789');
  assert.equal((await row(other.vehicleId)).plate, 'DUP777');
  const entry = (await audits(v.vehicleId)).find((e) => e.action === 'vehicle.updated');
  assert.deepEqual(entry.metadata_json, { changed_fields: [
    'plate', 'vehicle_type', 'brand', 'model', 'model_year', 'color', 'vin', 'engine_number',
  ] });
  assert.equal(JSON.stringify(entry).includes('XYZ789'), false);
  assert.equal((await patch(a.owner, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: exact.updatedAt, plate: 'XYZ789' })).status, 409,
  'stale identical payload conflicts before semantic no-op');
});

async function blockedPatch(a, vehicleId, token, holderWrite, expectedStatus) {
  const holder = await h.admin.reserve();
  await holder.unsafe('BEGIN');
  const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
  await holder`SELECT id FROM public.vehicles WHERE tenant_id=${a.tenantId}
    AND id=${vehicleId} FOR NO KEY UPDATE`;
  let settled = false;
  try {
    const pending = patch(a.owner, a.tenantId, vehicleId,
      { expectedUpdatedAt: token, model: 'WaitingPatch' }).finally(() => { settled = true; });
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      const waits = await h.admin`SELECT pid FROM pg_catalog.pg_stat_activity
        WHERE datname=pg_catalog.current_database()
          AND ${backend.pid} = ANY(pg_catalog.pg_blocking_pids(pid))`;
      if (waits.length) { blocked = true; break; }
      if (settled) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, 'PATCH must have a PostgreSQL blocking edge to holder');
    assert.equal(settled, false, 'PATCH remains pending while holder owns row lock');
    if (holderWrite) await holder`UPDATE public.vehicles SET model='HolderChanged',
      updated_at=GREATEST(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
      WHERE tenant_id=${a.tenantId} AND id=${vehicleId}`;
    await holder.unsafe('COMMIT');
    const result = await pending;
    assert.equal(result.status, expectedStatus, JSON.stringify(result.json));
    return result;
  } finally {
    await holder.unsafe('ROLLBACK').catch(() => undefined);
    holder.release();
  }
}

test('S2-05 PATCH: lock-proven wait succeeds after unchanged holder and conflicts after holder update', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, ca);
  const originalAudit = (await audits(v.vehicleId)).length;
  const first = await blockedPatch(a, v.vehicleId, v.updatedAt, false, 200);
  assert.equal(first.json.vehicle.model, 'WaitingPatch');
  assert.equal((await audits(v.vehicleId)).length, originalAudit + 1);
  const token = first.json.vehicle.updatedAt;
  const conflict = await blockedPatch(a, v.vehicleId, token, true, 409);
  assert.equal(code(conflict), 'RESOURCE_VERSION_CONFLICT');
  assert.equal((await row(v.vehicleId)).model, 'HolderChanged');
  assert.equal((await audits(v.vehicleId)).length, originalAudit + 1);
});

test('S2-05 PATCH audit failure rolls back row, timestamp, xmin and audit', async () => {
  const { a } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, ca);
  const before = await row(v.vehicleId);
  const beforeAudit = await audits(v.vehicleId);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'vehicle.updated'");
  try {
    const response = await patch(a.owner, a.tenantId, v.vehicleId,
      { expectedUpdatedAt: v.updatedAt, brand: 'MustRollback' });
    assert.equal(response.status, 500, JSON.stringify(response.json));
    assert.equal(code(response), 'INTERNAL_ERROR');
  } finally { await remove(); }
  assert.deepEqual(await row(v.vehicleId), before);
  assert.deepEqual(await audits(v.vehicleId), beforeAudit);
});

test('S2-05 strict input and restricted runtime RLS/grants; ownership history route is registered', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, ca);
  for (const extra of [{ currentMileageKm: 1 }, { tenantId: b.tenantId },
    { relationshipType: 'owner' }, { id: randomUUID() }, { color: '\u202e' },
    { plate: 'ñ12345' }, { modelYear: 1800 }]) {
    const r = await create(a.owner, a.tenantId, valid(ca, `X${randomUUID().slice(0, 8)}`, extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal((await patch(a.owner, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: v.updatedAt, currentMileageKm: 5 })).status, 400);
  assert.equal((await patch(a.owner, a.tenantId, v.vehicleId,
    { expectedUpdatedAt: v.updatedAt, customerId: ca })).status, 400);
  const clear = await patch(a.owner, a.tenantId, v.vehicleId, {
    expectedUpdatedAt: v.updatedAt, color: null, vin: '  ', engineNumber: null, modelYear: null,
  });
  assert.equal(clear.status, 200, 'nullable values already NULL are a no-op');
  assert.equal(clear.json.vehicle.updatedAt, v.updatedAt);
  const [role] = await h.apiPool`SELECT current_user AS who, rolbypassrls,
    (SELECT relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='public.vehicles'::regclass) AS forced
    FROM pg_catalog.pg_roles WHERE rolname=current_user`;
  assert.equal(role.who, 'tallermecario_api');
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.forced, true);
  const bind = { tenantId: a.tenantId, userId: a.owner.user.id, membershipId: a.owner.membershipId };
  const foreign = await customer(b.owner, b.tenantId);
  const foreignVehicle = await vehicle(b.owner, b.tenantId, foreign);
  const fkProbeVehicle = randomUUID();
  await h.admin`INSERT INTO public.vehicles (id, tenant_id, plate, vehicle_type, brand, model)
    VALUES (${fkProbeVehicle}, ${a.tenantId}, 'FKPROBE', 'car', 'B', 'M')`;
  assert.equal((await h.asRuntime(h.apiPool, bind,
    (tx) => tx`SELECT id FROM public.vehicles WHERE id=${foreignVehicle.vehicleId}`)).length, 0);
  assert.equal((await h.asRuntime(h.apiPool, bind,
    (tx) => tx`UPDATE public.vehicles SET brand='X' WHERE id=${foreignVehicle.vehicleId} RETURNING id`)).length, 0);
  await assert.rejects(h.asRuntime(h.apiPool, bind, (tx) => tx`
    INSERT INTO public.vehicle_owners (id,tenant_id,vehicle_id,customer_id)
    VALUES (${randomUUID()},${a.tenantId},${fkProbeVehicle},${foreign})`),
  (e) => e.code === '23503');
  await assert.rejects(h.asRuntime(h.apiPool, bind,
    (tx) => tx`UPDATE public.vehicles SET current_mileage_km=0, tenant_id=${b.tenantId} WHERE id=${v.vehicleId}`),
  (e) => e.code === '42501');
  const none = await h.apiPool`SELECT count(*)::int AS n FROM public.vehicles`;
  assert.equal(none[0].n, 0);
  await assert.rejects(h.workerPool`SELECT id FROM public.vehicles`, (e) => e.code === '42501');
  assert.equal((await h.call(app, { subject: a.owner.subject, method: 'DELETE',
    url: `/api/v1/vehicles/${v.vehicleId}`, tenantId: a.tenantId })).status, 404);
  const history = await h.call(app, { subject: a.owner.subject,
    url: `/api/v1/vehicles/${v.vehicleId}/owners`, tenantId: a.tenantId });
  assert.equal(history.status, 200);
  assert.equal(history.json.owners.length, 1);
});

test('S2-05 service requires vehicle_owners.manage in addition to route vehicles.create', async () => {
  const context = { tenant: { permissions: new Map([['vehicles.create', { kind: 'tenant' }]]) },
    sql: () => { throw new Error('SQL_SHOULD_NOT_RUN'); } };
  await assert.rejects(createVehicleService(context,
    { customerId: randomUUID(), values: { plate: 'TEST123', vehicle_type: 'car', brand: 'B', model: 'M',
      model_year: null, color: null, vin: null, engine_number: null } },
    { requestId: randomUUID(), ipAddress: '127.0.0.1' }),
  (error) => error.code === 'PERMISSION_DENIED');
});
