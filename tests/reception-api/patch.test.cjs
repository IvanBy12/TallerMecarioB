'use strict';

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const privacy = require('./privacy-helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool, identityProvider: provider,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerCustomerRoutes(server);
      registerVehicleRoutes(server);
      privacy.registerTestPrivacyRoutes(server);
      registerReceptionRoutes(server);
    },
  });
});
after(async () => h.closeAll(app));

const code = (response) => response.json?.error?.code;
const patch = (actor, tenantId, id, body, extra = {}) => h.call(app, {
  subject: actor?.subject, tenantId, method: 'PATCH', url: `/api/v1/receptions/${id}`, body, ...extra,
});
async function created(tenant, extra = {}) {
  const c = await h.createCustomer(app, tenant.owner, tenant.tenantId, h.validCustomer());
  assert.equal(c.status, 201);
  const v = await h.call(app, { subject: tenant.owner.subject, tenantId: tenant.tenantId,
    method: 'POST', url: '/api/v1/vehicles', body: {
      customerId: c.json.customer.customerId, plate: `R${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      vehicleType: 'car', brand: 'Marca', model: 'Modelo',
    } });
  assert.equal(v.status, 201);
  // S3-04.5: every reception needs the owner's service_provision consent.
  const privacyConsentId = await privacy.serviceConsent(app, tenant.owner, tenant.tenantId,
    c.json.customer.customerId);
  const r = await h.call(app, { subject: tenant.owner.subject, tenantId: tenant.tenantId,
    method: 'POST', url: '/api/v1/receptions', body: {
      vehicleId: v.json.vehicle.vehicleId, customerId: c.json.customer.customerId, privacyConsentId,
      mileageKm: 1000, ...extra,
    } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.reception;
}
async function row(id) {
  const [r] = await h.admin`SELECT *, xmin::text AS xmin,
    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_token
    FROM public.receptions WHERE id=${id}`;
  return r;
}
const audits = (id) => h.admin`SELECT * FROM public.audit_logs
  WHERE entity_id=${id} AND action='reception.updated' ORDER BY id`;
async function references(tenant, reception) {
  const appointmentId = randomUUID();
  const locationId = randomUUID();
  await h.admin`INSERT INTO public.workshop_locations
    (id, tenant_id, name, address_line, city, department, is_primary)
    VALUES (${locationId}, ${tenant.tenantId}, 'Sucursal', 'Calle 1', 'Bogotá', 'Bogotá', false)`;
  await h.admin`INSERT INTO public.appointments
    (id, tenant_id, customer_id, vehicle_id, scheduled_start, scheduled_end, reason)
    VALUES (${appointmentId}, ${tenant.tenantId}, ${reception.customerId}, ${reception.vehicleId},
      now() + interval '1 day', now() + interval '2 days', 'Visita')`;
  return { appointmentId, locationId };
}
async function closeFixture(tx, tenant, reception) {
  // DB-only fixture follows the existing reception DB suite. All 0019 guards
  // remain enabled, including signature, order lineage and initial history.
  const mediaId = randomUUID();
  const orderId = randomUUID();
  await tx`INSERT INTO public.media_assets ${tx({ id: mediaId, tenant_id: tenant.tenantId,
    bucket: 'test', object_key: mediaId, media_type: 'signature', mime_type: 'image/png',
    status: 'active', retention_class: 'authorization_evidence', retention_policy_version: 'v1' })}`;
  await tx`INSERT INTO public.signatures ${tx({ id: randomUUID(), tenant_id: tenant.tenantId,
    reception_id: reception.receptionId, signed_by_name: 'Customer', signature_media_id: mediaId,
    signed_at: new Date(), document_version: 'v1', document_hash: 'a'.repeat(64) })}`;
  await tx`UPDATE public.receptions SET status='closed', closed_at=now() WHERE id=${reception.receptionId}`;
  await tx`INSERT INTO public.service_orders ${tx({ id: orderId, tenant_id: tenant.tenantId,
    reception_id: reception.receptionId, vehicle_id: reception.vehicleId, customer_id: reception.customerId,
    order_number: 1, created_by_membership_id: tenant.owner.membershipId })}`;
  await tx`INSERT INTO public.order_status_history ${tx({ id: randomUUID(), tenant_id: tenant.tenantId,
    order_id: orderId, from_status: null, to_status: 'reception',
    changed_by_membership_id: tenant.owner.membershipId, request_id: randomUUID() })}`;
}
// Scope the barrier to the holder and the reception SELECT, including indirect
// tuple-lock waiters. Both requests must reach the lock before it is released.
async function waitForBlockedOn(holderPid, expected, queryPart) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [r] = await h.admin`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND ${holderPid}=ANY(pg_catalog.pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_catalog.pg_stat_activity a
      JOIN waiting w ON w.pid=ANY(pg_catalog.pg_blocking_pids(a.pid))
      WHERE a.datname=pg_catalog.current_database()
    ) SELECT count(DISTINCT a.pid)::int AS n FROM waiting w
      JOIN pg_catalog.pg_stat_activity a ON a.pid=w.pid
      WHERE a.wait_event_type='Lock' AND a.query LIKE ${`%${queryPart}%`}`;
    if (r.n >= expected) return;
    if (Date.now() > deadline) throw new Error(`RECEPTION_PATCH_BARRIER_TIMEOUT ${r.n}/${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('PATCH all approved fields: same DTO, immutable identity, one minimized audit, no note logging', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  // An appointment associated with different same-tenant CRM resources is valid.
  const other = await created(a);
  const refs = await references(a, other);
  const secret = `private-${randomUUID()}`;
  let response;
  const output = await h.captureOutput(async () => {
    response = await patch(a.advisor, a.tenantId, r.receptionId.toUpperCase(), {
      advisorNotes: `  ${secret}  `, customerNotes: `  e\u0301\r\n${secret}  `,
      fuelLevelPct: 0, mileageKm: 1200, locationId: refs.locationId.toUpperCase(),
      appointmentId: refs.appointmentId, expectedUpdatedAt: r.updatedAt,
    });
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.headers['cache-control'], 'no-store');
  const updated = response.json.reception;
  assert.deepEqual(Object.keys(updated).sort(), Object.keys(r).sort());
  for (const key of ['receptionId', 'vehicleId', 'customerId', 'receivedByMembershipId',
    'receivedAt', 'createdAt', 'closedAt', 'status']) assert.equal(updated[key], r[key]);
  assert.equal(updated.mileageKm, 1200);
  assert.equal(updated.fuelLevelPct, 0);
  assert.equal(updated.appointmentId, refs.appointmentId);
  assert.equal(updated.locationId, refs.locationId);
  assert.equal(updated.customerNotes, `é\n${secret}`);
  assert.equal(updated.advisorNotes, secret);
  assert.match(updated.updatedAt, h.TOKEN_FORMAT);
  assert.ok(updated.updatedAt > r.updatedAt);
  assert.equal((await row(r.receptionId)).updated_token, updated.updatedAt);
  const [audit] = await audits(r.receptionId);
  assert.equal((await audits(r.receptionId)).length, 1);
  assert.equal(audit.tenant_id, a.tenantId);
  assert.equal(audit.actor_type, 'user');
  assert.equal(audit.actor_user_id, a.advisor.user.id);
  assert.equal(audit.actor_membership_id, a.advisor.membershipId);
  assert.equal(audit.entity_type, 'reception');
  assert.equal(audit.entity_id, r.receptionId);
  assert.equal(audit.outcome, 'success');
  assert.equal(audit.before_json, null);
  assert.equal(audit.after_json, null);
  assert.deepEqual(audit.metadata_json, { changed_fields: [
    'appointment_id', 'location_id', 'mileage_km', 'fuel_level_pct', 'customer_notes', 'advisor_notes',
  ] });
  assert.equal(output.includes(secret), false);
  assert.equal(JSON.stringify(audit).includes(secret), false);
});

test('OCC microseconds, future monotonic token, stale and reused tokens lose even for identical payload', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const exact = '2999-01-01T00:00:00.123456Z';
  await h.admin`UPDATE public.receptions SET updated_at=${exact}::text::timestamptz WHERE id=${r.receptionId}`;
  const snapshot = await row(r.receptionId);
  assert.equal(snapshot.updated_token, exact, 'the DB fixture must retain all six fractional digits');
  for (const token of ['2999-01-01T00:00:00.123000Z', '2999-01-01T00:00:00.123455Z',
    '2999-01-01T00:00:00.123457Z', r.updatedAt]) {
    const response = await patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: token, mileageKm: r.mileageKm });
    assert.equal(response.status, 409);
    assert.equal(code(response), 'RESOURCE_VERSION_CONFLICT');
  }
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
  const changed = await patch(a.owner, a.tenantId, r.receptionId,
    { expectedUpdatedAt: exact, advisorNotes: 'Nuevo' });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.reception.updatedAt, '2999-01-01T00:00:00.123457Z');
  const after = await row(r.receptionId);
  for (const advisorNotes of ['Otro', 'Nuevo']) {
    const stale = await patch(a.owner, a.tenantId, r.receptionId, { expectedUpdatedAt: exact, advisorNotes });
    assert.equal(stale.status, 409);
    assert.equal(code(stale), 'RESOURCE_VERSION_CONFLICT');
  }
  assert.deepEqual(await row(r.receptionId), after);
  assert.equal((await audits(r.receptionId)).length, 1);
});

test('current-token normalized no-op preserves updatedAt, xmin and audit; null/empty clears nullable fields', async () => {
  const { a } = await h.twoTenants();
  let r = await created(a, { customerNotes: 'é\nnota', fuelLevelPct: 0 });
  const refs = await references(a, r);
  const set = await patch(a.owner, a.tenantId, r.receptionId, { expectedUpdatedAt: r.updatedAt, ...refs });
  assert.equal(set.status, 200);
  r = set.json.reception;
  const snapshot = await row(r.receptionId);
  const noop = await patch(a.admin, a.tenantId, r.receptionId, {
    expectedUpdatedAt: r.updatedAt, appointmentId: refs.appointmentId.toUpperCase(),
    locationId: refs.locationId.toUpperCase(), mileageKm: r.mileageKm, fuelLevelPct: 0,
    customerNotes: '  e\u0301\r\nnota  ', advisorNotes: '  ',
  });
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.json.reception, r);
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 1);
  const cleared = await patch(a.owner, a.tenantId, r.receptionId, {
    expectedUpdatedAt: r.updatedAt, appointmentId: null, locationId: null,
    fuelLevelPct: null, customerNotes: '', advisorNotes: null,
  });
  assert.equal(cleared.status, 200);
  r = cleared.json.reception;
  for (const key of ['appointmentId', 'locationId', 'fuelLevelPct', 'customerNotes', 'advisorNotes'])
    assert.equal(r[key], null);
  assert.deepEqual((await audits(r.receptionId))[1].metadata_json, {
    changed_fields: ['appointment_id', 'location_id', 'fuel_level_pct', 'customer_notes'],
  });
});

test('PATCH strict validation, immutable/server fields, numeric bounds, Unicode notes and 16 KiB limit', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const token = r.updatedAt;
  const invalid = [
    {}, { expectedUpdatedAt: token }, { mileageKm: 1001 }, null, [],
    ...['', 'bad', '2026-01-01T00:00:00.123Z', '2026-01-01T00:00:00.123456+00:00', null, 1]
      .map((expectedUpdatedAt) => ({ expectedUpdatedAt, mileageKm: 1001 })),
    ...['unknown', 'tenantId', 'status', 'receivedByMembershipId', 'receivedAt', 'closedAt',
      'createdAt', 'updatedAt', 'vehicleId', 'customerId', 'receptionId', 'id',
      // S3-04.5: the covering consent is immutable after INSERT.
      'privacyConsentId', 'privacy_consent_id']
      .map((key) => ({ expectedUpdatedAt: token, mileageKm: 1001, [key]: 'forged' })),
    ...[-1, 1.5, '100', null, 2147483648].map((mileageKm) => ({ expectedUpdatedAt: token, mileageKm })),
    ...[-1, 101, 0.5, '50'].map((fuelLevelPct) => ({ expectedUpdatedAt: token, fuelLevelPct })),
    ...['customerNotes', 'advisorNotes'].flatMap((key) => [
      '😀'.repeat(2001), 'a'.repeat(2001), 'tab\tx', 'bidi\u202Ex', '\u0000', '\ud800',
    ].map((value) => ({ expectedUpdatedAt: token, [key]: value }))),
    ...['appointmentId', 'locationId'].flatMap((key) => ['', 'bad', 2].map((value) =>
      ({ expectedUpdatedAt: token, [key]: value }))),
  ];
  const snapshot = await row(r.receptionId);
  for (const payload of invalid) {
    const response = await patch(a.owner, a.tenantId, r.receptionId, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
    assert.deepEqual(Object.keys(response.json.error).sort(), ['code', 'message', 'request_id']);
  }
  const oversized = await patch(a.owner, a.tenantId, r.receptionId,
    { expectedUpdatedAt: token, customerNotes: 'x'.repeat(17000) });
  assert.equal(oversized.status, 413);
  assert.equal(code(oversized), 'PAYLOAD_TOO_LARGE');
  const media = await patch(a.owner, a.tenantId, r.receptionId, undefined,
    { rawBody: JSON.stringify({ expectedUpdatedAt: token, mileageKm: 1001 }),
      headers: { 'content-type': 'text/plain' } });
  assert.equal(media.status, 415);
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
  const allowed = await patch(a.owner, a.tenantId, r.receptionId, {
    expectedUpdatedAt: token, customerNotes: '😀'.repeat(2000), advisorNotes: 'a\rb\r\nc', fuelLevelPct: 100,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.reception.advisorNotes, 'a\nb\nc');
  assert.equal((await row(r.receptionId)).privacy_consent_id, snapshot.privacy_consent_id);
});

test('tenant anti-oracle: foreign, missing and malformed reception; optional foreign references', async () => {
  const { a, b } = await h.twoTenants();
  const r = await created(a);
  const rb = await created(b);
  const refs = await references(b, rb);
  const snapshot = await row(r.receptionId);
  const foreign = await patch(b.owner, b.tenantId, r.receptionId,
    { expectedUpdatedAt: r.updatedAt, mileageKm: 1001 });
  assert.equal(foreign.status, 404);
  assert.equal(code(foreign), 'RECEPTION_NOT_FOUND');
  for (const id of [randomUUID(), 'bad', r.receptionId.replaceAll('-', ''), ` ${r.receptionId}`]) {
    const missing = await patch(b.owner, b.tenantId, id,
      { expectedUpdatedAt: r.updatedAt, mileageKm: 1001 });
    assert.equal(missing.status, 404);
    assert.equal(h.errorShape(missing), h.errorShape(foreign));
  }
  for (const field of ['appointmentId', 'locationId']) {
    const denied = await patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, [field]: refs[field] });
    const missing = await patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, [field]: randomUUID() });
    assert.equal(denied.status, 404);
    assert.equal(code(denied), field === 'appointmentId' ? 'APPOINTMENT_NOT_FOUND' : 'LOCATION_NOT_FOUND');
    assert.equal(h.errorShape(denied), h.errorShape(missing));
  }
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
});

test('canonical RBAC update_open: owner/admin/advisor allowed, technician denied before validation, 401', async () => {
  const { a } = await h.twoTenants();
  let r = await created(a);
  for (const actor of [a.owner, a.admin, a.advisor]) {
    const response = await patch(actor, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, advisorNotes: actor.membershipId });
    assert.equal(response.status, 200);
    r = response.json.reception;
  }
  const snapshot = await row(r.receptionId);
  for (const payload of [{ expectedUpdatedAt: r.updatedAt, mileageKm: 1001 }, { bogus: true }]) {
    const denied = await patch(a.technician, a.tenantId, r.receptionId, payload);
    assert.equal(denied.status, 403);
    assert.equal(code(denied), 'PERMISSION_DENIED');
  }
  const unauth = await patch(null, a.tenantId, r.receptionId,
    { expectedUpdatedAt: r.updatedAt, mileageKm: 1001 });
  assert.equal(unauth.status, 401);
  assert.equal(code(unauth), 'AUTHENTICATION_REQUIRED');
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 3);
});

test('non-open reception conflicts before OCC/no-op with no changes or audit (test-only DB fixture)', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  await h.admin.begin((tx) => closeFixture(tx, a, r));
  const snapshot = await row(r.receptionId);
  for (const expectedUpdatedAt of [r.updatedAt, '2000-01-01T00:00:00.000000Z']) {
    const response = await patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt, mileageKm: r.mileageKm });
    assert.equal(response.status, 409);
    assert.equal(code(response), 'RECEPTION_NOT_EDITABLE');
    assert.equal(response.json.error.message.includes('closed'), false);
  }
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
});

test('mileage database guard: lower bound conflicts, equal accepted, zero/null vehicle mileage supported', async () => {
  const { a } = await h.twoTenants();
  let r = await created(a);
  await h.admin`UPDATE public.vehicles SET current_mileage_km=500 WHERE id=${r.vehicleId}`;
  const snapshot = await row(r.receptionId);
  const low = await patch(a.owner, a.tenantId, r.receptionId, { expectedUpdatedAt: r.updatedAt, mileageKm: 499 });
  assert.equal(low.status, 409);
  assert.equal(code(low), 'RECEPTION_MILEAGE_CONFLICT');
  assert.deepEqual(Object.keys(low.json.error).sort(), ['code', 'message', 'request_id']);
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
  const equal = await patch(a.owner, a.tenantId, r.receptionId, { expectedUpdatedAt: r.updatedAt, mileageKm: 500 });
  assert.equal(equal.status, 200);
  assert.equal(equal.json.reception.mileageKm, 500);
  const [v] = await h.admin`SELECT current_mileage_km FROM public.vehicles WHERE id=${r.vehicleId}`;
  assert.equal(v.current_mileage_km, 500, 'PATCH never writes the vehicle mileage');
  r = await created(a);
  assert.equal((await patch(a.owner, a.tenantId, r.receptionId,
    { expectedUpdatedAt: r.updatedAt, mileageKm: 0 })).status, 200);
});

test('audit INSERT failure rolls back UPDATE and token; sanitized 500 does not log notes', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const snapshot = await row(r.receptionId);
  const secret = `private-${randomUUID()}`;
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'reception.updated'");
  try {
    let response;
    const output = await h.captureOutput(async () => {
      response = await patch(a.owner, a.tenantId, r.receptionId,
        { expectedUpdatedAt: r.updatedAt, advisorNotes: secret });
    });
    assert.equal(response.status, 500);
    assert.equal(code(response), 'INTERNAL_ERROR');
    assert.deepEqual(Object.keys(response.json.error).sort(), ['code', 'message', 'request_id']);
    for (const forbidden of [secret, 'TEST_INJECTED_FAILURE', '235', 'INSERT', 'audit_logs'])
      assert.equal(JSON.stringify(response.json).includes(forbidden), false);
    assert.equal(output.includes(secret), false);
  } finally { await remove(); }
  assert.deepEqual(await row(r.receptionId), snapshot);
  assert.equal((await audits(r.receptionId)).length, 0);
  assert.equal((await patch(a.owner, a.tenantId, r.receptionId,
    { expectedUpdatedAt: r.updatedAt, advisorNotes: 'Retry' })).status, 200);
});

test('OCC concurrency: forced reception-lock race produces one 200, one 409, winner only and one audit', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const holder = await h.admin.reserve();
  let pending;
  let barrierError;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE`;
    pending = [patch(a.owner, a.tenantId, r.receptionId, { expectedUpdatedAt: r.updatedAt, advisorNotes: 'Uno' }),
      patch(a.advisor, a.tenantId, r.receptionId, { expectedUpdatedAt: r.updatedAt, advisorNotes: 'Dos' })];
    await waitForBlockedOn(backend.pid, 2, 'FOR NO KEY UPDATE OF r');
  } catch (error) { barrierError = error; }
  finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
  }
  const results = pending ? await Promise.all(pending) : [];
  if (barrierError) throw barrierError;
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(code(results.find((result) => result.status === 409)), 'RESOURCE_VERSION_CONFLICT');
  const winner = results.find((result) => result.status === 200).json.reception;
  const stored = await row(r.receptionId);
  assert.equal(stored.advisor_notes, winner.advisorNotes);
  assert.equal(stored.updated_token, winner.updatedAt);
  assert.equal((await audits(r.receptionId)).length, 1);
});

test('lock order: reception stays locked while lifecycle trigger waits for vehicle; no-op skips vehicle', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const holder = await h.admin.reserve();
  let pending;
  let barrierError;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.vehicles WHERE id=${r.vehicleId} FOR NO KEY UPDATE`;
    // A no-op must complete even with the vehicle locked by another transaction.
    const noop = await patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, mileageKm: r.mileageKm });
    assert.equal(noop.status, 200);
    pending = patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, advisorNotes: 'Vehicle lock' });
    await waitForBlockedOn(backend.pid, 1, 'UPDATE public.receptions AS r');
    // NOWAIT demonstrates the waiting writer already owns the reception lock.
    await assert.rejects(h.admin.begin(async (tx) => {
      await tx`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE NOWAIT`;
    }), (error) => error.code === '55P03');
  } catch (error) { barrierError = error; }
  finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
  }
  const response = pending ? await pending : null;
  if (barrierError) throw barrierError;
  assert.equal(response.status, 200);
  assert.equal((await audits(r.receptionId)).length, 1);
});

test('PATCH waiting behind a DB close observes non-open after the lock, without write or audit', async () => {
  const { a } = await h.twoTenants();
  const r = await created(a);
  const holder = await h.admin.reserve();
  let pending;
  let barrierError;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE`;
    pending = patch(a.owner, a.tenantId, r.receptionId,
      { expectedUpdatedAt: r.updatedAt, advisorNotes: 'Must not persist' });
    await waitForBlockedOn(backend.pid, 1, 'FOR NO KEY UPDATE OF r');
    await closeFixture(holder, a, r);
    await holder.unsafe('COMMIT');
  } catch (error) { barrierError = error; }
  finally {
    await holder.unsafe('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  const response = pending ? await pending : null;
  if (barrierError) throw barrierError;
  assert.equal(response.status, 409);
  assert.equal(code(response), 'RECEPTION_NOT_EDITABLE');
  const stored = await row(r.receptionId);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.advisor_notes, r.advisorNotes);
  assert.equal(stored.updated_token, r.updatedAt);
  assert.equal((await audits(r.receptionId)).length, 0);
});
