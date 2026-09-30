'use strict';

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const p = require('./privacy-helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { mapReceptionDbError } = h.load('receptions/service.js');
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
      p.registerTestPrivacyRoutes(server);
      registerReceptionRoutes(server);
    },
  });
});
after(async () => h.closeAll(app));

const code = (response) => response.json?.error?.code;
const call = (actor, tenantId, body) => h.call(app, {
  subject: actor?.subject, tenantId, method: 'POST', url: '/api/v1/receptions', body,
});
const body = (vehicleId, customerId, privacyConsentId, extra = {}) =>
  ({ vehicleId, customerId, privacyConsentId, mileageKm: 12345, ...extra });
async function customer(actor, tenantId) {
  const result = await h.createCustomer(app, actor, tenantId, h.validCustomer());
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.customer.customerId;
}
async function ownedVehicle(actor, tenantId, customerId) {
  const result = await h.call(app, { subject: actor.subject, tenantId, method: 'POST',
    url: '/api/v1/vehicles', body: { customerId,
      plate: `R${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      vehicleType: 'car', brand: 'Marca', model: 'Modelo' } });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return { vehicleId: result.json.vehicle.vehicleId, ownershipId: result.json.ownership.ownershipId };
}
const vehicle = async (actor, tenantId, customerId) => (await ownedVehicle(actor, tenantId, customerId)).vehicleId;
/** Owner customer + owned vehicle + granted service_provision consent (real API). */
async function scenario(tenant, actor = tenant.owner) {
  const c = await customer(actor, tenant.tenantId);
  const owned = await ownedVehicle(actor, tenant.tenantId, c);
  const pc = await p.serviceConsent(app, actor, tenant.tenantId, c);
  return { c, v: owned.vehicleId, ownershipId: owned.ownershipId, pc };
}
async function count(vehicleId) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.receptions
    WHERE vehicle_id=${vehicleId} AND status='open'`;
  return row.n;
}
async function createdAudits(tenantId) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.audit_logs
    WHERE tenant_id=${tenantId} AND action='reception.created'`;
  return row.n;
}
const VEHICLE_LOCK = '%FROM public.vehicles%FOR NO KEY UPDATE%';
const CONSENT_LOCK = '%FROM public.privacy_consents AS c%FOR SHARE OF c%';
/** Waits until `expected` backends matching one of the patterns wait (transitively) on holderPid. */
async function waitForBlockedOn(holderPid, expected, patterns, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database()
        AND ${holderPid} = ANY(pg_catalog.pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_catalog.pg_stat_activity a
      JOIN waiting w ON w.pid = ANY(pg_catalog.pg_blocking_pids(a.pid))
      WHERE a.datname = pg_catalog.current_database()
    ) SELECT count(DISTINCT a.pid)::int AS n FROM waiting w
      JOIN pg_catalog.pg_stat_activity a ON a.pid = w.pid
      WHERE a.wait_event_type = 'Lock' AND a.query LIKE ANY(${patterns})`;
    if (row.n >= expected) return;
    if (Date.now() > deadline) throw new Error(`RECEPTION_LOCK_WAITERS_NOT_REACHED ${row.n}/${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/** Admin transaction holding the vehicle row lock (the transferOwner gate). */
async function holdVehicle(tenantId, vehicleId) {
  const holder = await h.admin.reserve();
  await holder.unsafe('BEGIN');
  const [backend] = await holder`SELECT pg_catalog.pg_backend_pid() AS pid`;
  await holder`SELECT id FROM public.vehicles WHERE tenant_id=${tenantId} AND id=${vehicleId} FOR UPDATE`;
  return { pid: backend.pid, release: async () => {
    await holder.unsafe('ROLLBACK').catch(() => undefined);
    holder.release();
  } };
}
/** Runtime API transaction that revokes and keeps the row lock until commit(). */
async function beginRevoke(tenantId, consentId) {
  const conn = await h.apiPool.reserve();
  await conn.unsafe('BEGIN');
  await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  const [backend] = await conn`SELECT pg_catalog.pg_backend_pid() AS pid`;
  return { conn, pid: backend.pid,
    revoke: () => conn.unsafe(p.REVOKE_SQL, [tenantId, consentId]),
    finish: async (commit) => {
      try { await conn.unsafe(commit ? 'COMMIT' : 'ROLLBACK'); } finally { conn.release(); }
    } };
}
async function seedLocation(tenantId) {
  // The primary location is part of the configured controller notice.
  return p.configureNotice(tenantId);
}
async function seedAppointment(tenantId, customerId, vehicleId) {
  const id = randomUUID();
  await h.admin`INSERT INTO public.appointments
    (id, tenant_id, customer_id, vehicle_id, scheduled_start, scheduled_end, reason)
    VALUES (${id}, ${tenantId}, ${customerId}, ${vehicleId}, now() + interval '1 day',
      now() + interval '2 days', 'Visita')`;
  return id;
}
const transfer = (actor, tenantId, vehicleId, customerId, expectedCurrentOwnershipId) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST', url: `/api/v1/vehicles/${vehicleId}/owners`,
  body: { customerId, expectedCurrentOwnershipId },
});

test('POST minimum: stable DTO, server values, consent link, audit and no extra routes', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const result = await call(a.advisor, a.tenantId, body(v, c, pc));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.headers['cache-control'], 'no-store');
  const r = result.json.reception;
  // S3-04.5 keeps the S3-03 DTO: the consent link is internal evidence.
  assert.deepEqual(Object.keys(r).sort(), [
    'receptionId', 'vehicleId', 'customerId', 'appointmentId', 'locationId',
    'receivedByMembershipId', 'mileageKm', 'fuelLevelPct', 'customerNotes',
    'advisorNotes', 'status', 'receivedAt', 'closedAt', 'createdAt', 'updatedAt',
  ].sort());
  assert.equal(r.vehicleId, v);
  assert.equal(r.customerId, c);
  assert.equal(r.receivedByMembershipId, a.advisor.membershipId);
  assert.equal(r.status, 'open');
  for (const field of ['appointmentId', 'locationId', 'fuelLevelPct', 'customerNotes', 'advisorNotes', 'closedAt'])
    assert.equal(r[field], null);
  for (const field of ['receivedAt', 'createdAt', 'updatedAt']) assert.match(r[field], h.TOKEN_FORMAT);
  const [stored] = await h.admin`SELECT tenant_id, received_by_membership_id, status, closed_at, privacy_consent_id
    FROM public.receptions WHERE id=${r.receptionId}`;
  assert.equal(stored.tenant_id, a.tenantId);
  assert.equal(stored.received_by_membership_id, a.advisor.membershipId);
  assert.equal(stored.status, 'open');
  assert.equal(stored.closed_at, null);
  assert.equal(stored.privacy_consent_id, pc);
  const [audit] = await h.admin`SELECT tenant_id, actor_type, actor_user_id, actor_membership_id,
    action, outcome, entity_type, entity_id, before_json, after_json, metadata_json, user_agent
    FROM public.audit_logs WHERE entity_id=${r.receptionId}`;
  assert.equal(audit.tenant_id, a.tenantId);
  assert.equal(audit.actor_user_id, a.advisor.user.id);
  assert.equal(audit.actor_membership_id, a.advisor.membershipId);
  assert.equal(audit.action, 'reception.created');
  assert.equal(audit.outcome, 'success');
  assert.equal(audit.entity_type, 'reception');
  assert.equal(audit.entity_id, r.receptionId);
  assert.equal(audit.before_json, null);
  assert.equal(audit.after_json, null);
  assert.equal(audit.user_agent, null);
  assert.deepEqual(audit.metadata_json, {
    fields: ['vehicle_id', 'customer_id', 'privacy_consent_id', 'mileage_km'], privacy_consent_id: pc,
  });
  for (const method of ['GET', 'PATCH', 'DELETE'])
    assert.equal(app.hasRoute({ method, url: '/api/v1/receptions' }), false);
});

test('optionals with the current owner; refusing other purposes does not block the reception', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const locationId = await seedLocation(a.tenantId);
  const appointmentId = await seedAppointment(a.tenantId, c, v);
  const result = await call(a.owner, a.tenantId, body(v, c, pc, {
    appointmentId, locationId, fuelLevelPct: 50, customerNotes: '  Nota\r\ncliente  ',
    advisorNotes: '  Nota interna  ',
  }));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.json.reception.appointmentId, appointmentId);
  assert.equal(result.json.reception.locationId, locationId);
  assert.equal(result.json.reception.fuelLevelPct, 50);
  assert.equal(result.json.reception.customerNotes, 'Nota\ncliente');
  assert.equal(result.json.reception.advisorNotes, 'Nota interna');
  const [audit] = await h.admin`SELECT metadata_json FROM public.audit_logs WHERE entity_id=${result.json.reception.receptionId}`;
  assert.equal(JSON.stringify(audit).includes('Nota'), false);
  // Only service_provision exists for this customer: no marketing/image/WhatsApp needed.
  const [purposes] = await h.admin`SELECT array_agg(purpose_code)::text[] AS p FROM public.privacy_consents
    WHERE customer_id=${c}`;
  assert.deepEqual(purposes.p, ['service_provision']);
});

test('D-PRIV-03: a same-tenant customer that is not the current owner is now 409 (was 201 in S3-03)', async () => {
  // Deliberate canonical change: S3-03 accepted any tenant customer. Now the
  // customer must be the current primary owner (vehicle_owners.is_primary AND
  // valid_to IS NULL), even with that customer's own valid consent.
  const { a } = await h.twoTenants();
  const { v } = await scenario(a);
  const visitor = await customer(a.owner, a.tenantId);
  const visitorConsent = await p.serviceConsent(app, a.owner, a.tenantId, visitor);
  const result = await call(a.owner, a.tenantId, body(v, visitor, visitorConsent));
  assert.equal(result.status, 409, JSON.stringify(result.json));
  assert.equal(code(result), 'VEHICLE_OWNERSHIP_CONFLICT');
  assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message', 'request_id']);
  const [owner] = await h.admin`SELECT customer_id FROM public.vehicle_owners WHERE vehicle_id=${v}`;
  assert.equal(JSON.stringify(result.json).includes(owner.customer_id), false, 'owner id not leaked');
  assert.equal(await count(v), 0);
  assert.equal(await createdAudits(a.tenantId), 0);
});

test('request logging and audit metadata exclude note contents and privacy evidence', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const secret = `sensitive-${randomUUID()}`;
  let result;
  const output = await h.captureOutput(async () => {
    result = await call(a.owner, a.tenantId, body(v, c, pc,
      { customerNotes: secret, advisorNotes: secret }));
  });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(output.includes(secret), false);
  const [consent] = await h.admin`SELECT authorization_text_hash FROM public.privacy_consents WHERE id=${pc}`;
  const [audit] = await h.admin`SELECT metadata_json, before_json, after_json
    FROM public.audit_logs WHERE entity_id=${result.json.reception.receptionId}`;
  const rendered = JSON.stringify(audit);
  for (const leak of [secret, consent.authorization_text_hash, p.f.SERVICE_V1.text, p.f.NOTICE_V1.text,
    p.f.RIGHTS_CHANNEL]) assert.equal(rendered.includes(leak), false);
});

test('validation: privacyConsentId required and canonical; server controlled fields rejected', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const { privacyConsentId: _omitted, ...missingConsent } = body(v, c, pc);
  const invalid = [
    missingConsent, body(v, c, null), body(v, c, 'bad'), body(v, c, 42), body(v, c, '00000000-0000-0000-0000-000000000000'),
    body(v, c, `{${pc}}`),
    body(v, c, pc, { mileageKm: -1 }), body(v, c, pc, { fuelLevelPct: -1 }),
    body(v, c, pc, { mileageKm: 1.5 }), body(v, c, pc, { mileageKm: '100' }),
    body(v, c, pc, { mileageKm: null }), body(v, c, pc, { fuelLevelPct: 101 }),
    body('bad', c, pc), body(v, 'bad', pc),
    body(v, c, pc, { appointmentId: 'bad' }), body(v, c, pc, { locationId: 'bad' }),
    body(v, c, pc, { unknown: true }), body(v, c, pc, { customerNotes: 'a'.repeat(2001) }),
    body(v, c, pc, { advisorNotes: 'a'.repeat(2001) }),
    ...['tenantId', 'status', 'receivedByMembershipId', 'receivedAt', 'closedAt', 'createdAt', 'updatedAt',
      'privacyConsent', 'authorizationTextHash', 'controllerNoticeSnapshot']
      .map((key) => body(v, c, pc, { [key]: 'forged' })),
  ];
  for (const payload of invalid) {
    const result = await call(a.owner, a.tenantId, payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
    assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message', 'request_id']);
  }
  const oversized = await call(a.owner, a.tenantId, body(v, c, pc, { customerNotes: 'x'.repeat(17000) }));
  assert.equal(oversized.status, 413);
  assert.equal(code(oversized), 'PAYLOAD_TOO_LARGE');
  const wrongType = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: '/api/v1/receptions', rawBody: JSON.stringify(body(v, c, pc)), headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  assert.equal(await count(v), 0);
});

test('RBAC and unauthenticated: route permission blocks technician before handler', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  registerReceptionRoutes({ post(path, options) {
    const permissions = {
      '/api/v1/receptions': 'receptions.create',
      '/api/v1/receptions/:receptionId/close': 'receptions.close',
      '/api/v1/receptions/:receptionId/signature': 'signatures.capture',
    };
    assert.equal(options.config.permission, permissions[path]);
  }, patch(path, options) {
    assert.equal(path, '/api/v1/receptions/:receptionId');
    assert.deepEqual(options.config, { permission: 'receptions.update_open' });
  } });
  for (const actor of [a.owner, a.admin, a.advisor]) {
    const ownVehicle = actor === a.owner ? v : await vehicle(a.owner, a.tenantId, c);
    assert.equal((await call(actor, a.tenantId, body(ownVehicle, c, pc))).status, 201);
  }
  const separate = await vehicle(a.owner, a.tenantId, c);
  for (const payload of [body(separate, c, pc), { bogus: true }]) {
    const denied = await call(a.technician, a.tenantId, payload);
    assert.equal(denied.status, 403);
    assert.equal(code(denied), 'PERMISSION_DENIED');
  }
  const unauth = await call(null, a.tenantId, body(separate, c, pc));
  assert.equal(unauth.status, 401);
  assert.equal(code(unauth), 'AUTHENTICATION_REQUIRED');
  assert.equal(await count(separate), 0);
});

test('tenant isolation: foreign and absent references, including consents, share one 404', async () => {
  const { a, b } = await h.twoTenants();
  const A = await scenario(a);
  const B = await scenario(b, b.owner);
  const lb = await seedLocation(b.tenantId);
  const ab = await seedAppointment(b.tenantId, B.c, B.v);
  for (const [payload, expected, field] of [
    [body(A.v, B.c, A.pc), 'CUSTOMER_NOT_FOUND', 'customerId'],
    [body(B.v, A.c, A.pc), 'VEHICLE_NOT_FOUND', 'vehicleId'],
    [body(B.v, B.c, B.pc), 'VEHICLE_NOT_FOUND', 'vehicleId'],
    [body(A.v, A.c, A.pc, { locationId: lb }), 'LOCATION_NOT_FOUND', 'locationId'],
    [body(A.v, A.c, A.pc, { appointmentId: ab }), 'APPOINTMENT_NOT_FOUND', 'appointmentId'],
    [body(A.v, A.c, B.pc), 'PRIVACY_CONSENT_NOT_FOUND', 'privacyConsentId'],
  ]) {
    const result = await call(a.owner, a.tenantId, payload);
    assert.equal(result.status, 404, JSON.stringify(result.json));
    assert.equal(code(result), expected);
    const missing = await call(a.owner, a.tenantId, { ...payload, [field]: randomUUID() });
    assert.equal(h.errorShape(missing), h.errorShape(result));
  }
  // Tenant B cannot use tenant A's consent for its own owner/vehicle either.
  const crossed = await call(b.owner, b.tenantId, body(B.v, B.c, A.pc));
  assert.equal(crossed.status, 404);
  assert.equal(code(crossed), 'PRIVACY_CONSENT_NOT_FOUND');
  assert.equal(h.errorShape(crossed), h.errorShape(await call(b.owner, b.tenantId, body(B.v, B.c, randomUUID()))));
  assert.equal(await count(A.v), 0);
  assert.equal(await count(B.v), 0);
  // Tenant A with its own evidence still works.
  assert.equal((await call(a.owner, a.tenantId, body(A.v, A.c, A.pc))).status, 201);
});

test('RECEPTION-CONSENT-01: wrong customer, wrong purpose and revoked consents are not eligible', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const visitor = await customer(a.owner, a.tenantId);
  const visitorConsent = await p.serviceConsent(app, a.owner, a.tenantId, visitor);
  const marketing = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({
    purposeCode: 'marketing', authorizationTextVersion: p.f.MARKETING_V1.version }));
  assert.equal(marketing.status, 201, JSON.stringify(marketing.json));
  for (const consentId of [visitorConsent, marketing.json.privacyConsent.privacyConsentId]) {
    const result = await call(a.owner, a.tenantId, body(v, c, consentId));
    assert.equal(result.status, 409, JSON.stringify(result.json));
    assert.equal(code(result), 'PRIVACY_CONSENT_NOT_ELIGIBLE');
    assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message', 'request_id']);
  }
  await h.asRuntime(h.apiPool, { tenantId: a.tenantId }, (tx) => tx.unsafe(p.REVOKE_SQL, [a.tenantId, pc]));
  const revoked = await call(a.owner, a.tenantId, body(v, c, pc));
  assert.equal(revoked.status, 409);
  assert.equal(code(revoked), 'PRIVACY_CONSENT_NOT_ELIGIBLE');
  assert.equal(await count(v), 0);
  assert.equal(await createdAudits(a.tenantId), 0);
  // A new authorization is a new row and covers new receptions again.
  const renewed = await p.serviceConsent(app, a.owner, a.tenantId, c);
  assert.notEqual(renewed, pc);
  assert.equal((await call(a.owner, a.tenantId, body(v, c, renewed))).status, 201);
});

test('mileage conflict, duplicate open, and two overlapping creates serialize on the vehicle lock', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  await h.admin`UPDATE public.vehicles SET current_mileage_km=100 WHERE id=${v}`;
  const low = await call(a.owner, a.tenantId, body(v, c, pc, { mileageKm: 99 }));
  assert.equal(low.status, 409);
  assert.equal(code(low), 'RECEPTION_MILEAGE_CONFLICT');
  assert.deepEqual(Object.keys(low.json.error).sort(), ['code', 'message', 'request_id']);
  assert.equal(await count(v), 0);
  const first = await call(a.owner, a.tenantId, body(v, c, pc));
  assert.equal(first.status, 201);
  const duplicate = await call(a.owner, a.tenantId, body(v, c, pc));
  assert.equal(duplicate.status, 409);
  assert.equal(code(duplicate), 'RECEPTION_ALREADY_OPEN');
  assert.equal(await count(v), 1);
  const concurrentVehicle = await vehicle(a.owner, a.tenantId, c);
  const auditsBefore = await createdAudits(a.tenantId);
  const holder = await holdVehicle(a.tenantId, concurrentVehicle);
  let pending;
  let barrierError;
  try {
    pending = [call(a.owner, a.tenantId, body(concurrentVehicle, c, pc)),
      call(a.admin, a.tenantId, body(concurrentVehicle, c, pc))];
    // Both requests wait on createReception's own vehicle FOR NO KEY UPDATE,
    // i.e. before any owner/consent precheck or INSERT.
    await waitForBlockedOn(holder.pid, 2, [VEHICLE_LOCK]);
  } catch (error) {
    barrierError = error;
  } finally {
    await holder.release();
  }
  const results = pending ? await Promise.all(pending) : [];
  if (barrierError) throw barrierError;
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(results.find((result) => result.status === 409).json.error.code, 'RECEPTION_ALREADY_OPEN');
  assert.equal(await count(concurrentVehicle), 1);
  assert.equal(await createdAudits(a.tenantId), auditsBefore + 1);
});

test('race: transferOwner takes the vehicle lock first, the stale customer is rejected', async () => {
  const { a } = await h.twoTenants();
  const { c, v, ownershipId, pc } = await scenario(a);
  const buyer = await customer(a.owner, a.tenantId);
  const holder = await holdVehicle(a.tenantId, v);
  let pendingTransfer, pendingCreate, barrierError;
  try {
    pendingTransfer = transfer(a.owner, a.tenantId, v, buyer, ownershipId);
    await waitForBlockedOn(holder.pid, 1, [VEHICLE_LOCK]);
    pendingCreate = call(a.advisor, a.tenantId, body(v, c, pc));
    await waitForBlockedOn(holder.pid, 2, [VEHICLE_LOCK]);
  } catch (error) { barrierError = error; } finally { await holder.release(); }
  const [moved, created] = await Promise.all([pendingTransfer, pendingCreate]);
  if (barrierError) throw barrierError;
  assert.equal(moved.status, 201, JSON.stringify(moved.json));
  assert.equal(created.status, 409, JSON.stringify(created.json));
  assert.equal(code(created), 'VEHICLE_OWNERSHIP_CONFLICT');
  assert.equal(await count(v), 0);
  assert.equal(await createdAudits(a.tenantId), 0);
});

test('race: createReception takes the vehicle lock first, the reception stays historically valid', async () => {
  const { a } = await h.twoTenants();
  const { c, v, ownershipId, pc } = await scenario(a);
  const buyer = await customer(a.owner, a.tenantId);
  const holder = await holdVehicle(a.tenantId, v);
  let pendingTransfer, pendingCreate, barrierError;
  try {
    pendingCreate = call(a.advisor, a.tenantId, body(v, c, pc));
    await waitForBlockedOn(holder.pid, 1, [VEHICLE_LOCK]);
    pendingTransfer = transfer(a.owner, a.tenantId, v, buyer, ownershipId);
    await waitForBlockedOn(holder.pid, 2, [VEHICLE_LOCK]);
  } catch (error) { barrierError = error; } finally { await holder.release(); }
  const [created, moved] = await Promise.all([pendingCreate, pendingTransfer]);
  if (barrierError) throw barrierError;
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(moved.status, 201, JSON.stringify(moved.json));
  const [row] = await h.admin`SELECT customer_id, privacy_consent_id FROM public.receptions
    WHERE id=${created.json.reception.receptionId}`;
  assert.deepEqual({ ...row }, { customer_id: c, privacy_consent_id: pc });
  const [owner] = await h.admin`SELECT customer_id FROM public.vehicle_owners
    WHERE vehicle_id=${v} AND is_primary AND valid_to IS NULL`;
  assert.equal(owner.customer_id, buyer);
  // History is not re-evaluated: the open reception of the former owner stays editable.
  const edited = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'PATCH',
    url: `/api/v1/receptions/${created.json.reception.receptionId}`,
    body: { expectedUpdatedAt: created.json.reception.updatedAt, advisorNotes: 'post transfer' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.reception.customerId, c);
});

test('race: revocation commits first; createReception waits on FOR SHARE and sees revoked', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const revoker = await beginRevoke(a.tenantId, pc);
  let pending, barrierError;
  try {
    await revoker.revoke();
    pending = call(a.owner, a.tenantId, body(v, c, pc));
    // Blocked on the app's consent FOR SHARE (the vehicle lock was already taken).
    await waitForBlockedOn(revoker.pid, 1, [CONSENT_LOCK]);
  } catch (error) { barrierError = error; }
  await revoker.finish(!barrierError);
  const result = await pending;
  if (barrierError) throw barrierError;
  assert.equal(result.status, 409, JSON.stringify(result.json));
  assert.equal(code(result), 'PRIVACY_CONSENT_NOT_ELIGIBLE');
  const [consent] = await h.admin`SELECT status FROM public.privacy_consents WHERE id=${pc}`;
  assert.equal(consent.status, 'revoked');
  assert.equal(await count(v), 0);
  assert.equal(await createdAudits(a.tenantId), 0);
});

test('race: createReception holds FOR SHARE first; the revoke waits and applies after commit', async () => {
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const key = BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const trigger = `s3045_barrier_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  // Test-only barrier: pause createReception at its audit INSERT, after it
  // already holds the vehicle lock and the consent FOR SHARE lock.
  await h.admin.unsafe(`
    CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.action = 'reception.created' THEN PERFORM pg_catalog.pg_advisory_xact_lock(${key});
    END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${trigger} BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.${trigger}();`);
  const barrier = await h.admin.reserve();
  let revoker, pendingCreate, pendingRevoke, barrierError;
  try {
    const [bp] = await barrier`SELECT pg_catalog.pg_backend_pid() AS pid, pg_catalog.pg_advisory_lock(${key})`;
    pendingCreate = call(a.owner, a.tenantId, body(v, c, pc));
    await waitForBlockedOn(bp.pid, 1, ['%INSERT INTO public.audit_logs%']);
    revoker = await beginRevoke(a.tenantId, pc);
    pendingRevoke = revoker.revoke().then(() => null, (error) => error);
    // The revoke UPDATE waits on createReception's FOR SHARE, not on the barrier.
    await waitForBlockedOn(bp.pid, 2, ['%INSERT INTO public.audit_logs%', '%UPDATE public.privacy_consents%']);
    const [direct] = await h.admin`SELECT pg_catalog.pg_blocking_pids(${revoker.pid}) AS blockers`;
    assert.equal(direct.blockers.includes(bp.pid), false);
    assert.equal(direct.blockers.length, 1);
  } catch (error) { barrierError = error; } finally {
    await barrier`SELECT pg_catalog.pg_advisory_unlock(${key})`.catch(() => undefined);
    barrier.release();
  }
  const created = await pendingCreate;
  const revokeError = pendingRevoke ? await pendingRevoke : null;
  if (revoker) await revoker.finish(!barrierError && !revokeError);
  await h.admin.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON public.audit_logs; DROP FUNCTION IF EXISTS public.${trigger}();`);
  if (barrierError) throw barrierError;
  assert.equal(revokeError, null);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const [row] = await h.admin`SELECT r.privacy_consent_id, c.status, c.revoked_at >= r.created_at AS after_reception
    FROM public.receptions r JOIN public.privacy_consents c ON c.id = r.privacy_consent_id
    WHERE r.id=${created.json.reception.receptionId}`;
  assert.deepEqual({ ...row }, { privacy_consent_id: pc, status: 'revoked', after_reception: true });
  assert.equal(await createdAudits(a.tenantId), 1);
  // The historical reception stays; new receptions with that consent are blocked.
  const other = await vehicle(a.owner, a.tenantId, c);
  const blocked = await call(a.owner, a.tenantId, body(other, c, pc));
  assert.equal(code(blocked), 'PRIVACY_CONSENT_NOT_ELIGIBLE');
});

test('only known PostgreSQL constraints map; audit failure rolls insert back', async () => {
  for (const [state, expected] of [
    [{ code: '23505', constraint_name: 'receptions_one_open_vehicle_uq' }, 'RECEPTION_ALREADY_OPEN'],
    [{ code: '23503', constraint_name: 'receptions_vehicle_fk' }, 'VEHICLE_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_customer_fk' }, 'CUSTOMER_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_appointment_fk' }, 'APPOINTMENT_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_location_fk' }, 'LOCATION_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_privacy_consent_fk' }, 'PRIVACY_CONSENT_NOT_FOUND'],
    [{ code: '23514', constraint_name: 'receptions_current_owner_guard' }, 'VEHICLE_OWNERSHIP_CONFLICT'],
    [{ code: '23514', constraint_name: 'receptions_privacy_consent_guard' }, 'PRIVACY_CONSENT_NOT_ELIGIBLE'],
    [{ code: '23514', constraint_name: 'receptions_vehicle_mileage_guard' }, 'RECEPTION_MILEAGE_CONFLICT'],
    [{ code: '23514', constraint_name: 'receptions_fuel_check' }, 'REQUEST_VALIDATION_FAILED'],
    [{ code: '23514', constraint_name: 'receptions_mileage_check' }, 'REQUEST_VALIDATION_FAILED'],
  ]) assert.equal(mapReceptionDbError(state)?.code, expected);
  assert.equal(mapReceptionDbError({ code: '23505', constraint_name: 'other' }), null);
  assert.equal(mapReceptionDbError({ code: '23514', constraint_name: 'other' }), null);
  assert.equal(mapReceptionDbError({ code: '23503', constraint_name: 'other' }), null);
  assert.equal(mapReceptionDbError({ code: '23514', constraint_name: 'receptions_lifecycle_guard' }), null);
  assert.equal(mapReceptionDbError({ code: '23503', constraint_name: 'receptions_current_owner_guard' }), null);
  assert.equal(mapReceptionDbError({ code: '23514', constraint_name: 'receptions_privacy_consent_fk' }), null);
  const { a } = await h.twoTenants();
  const { c, v, pc } = await scenario(a);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'reception.created'");
  let result;
  let output;
  try {
    output = await h.captureOutput(async () => { result = await call(a.owner, a.tenantId, body(v, c, pc)); });
  } finally { await remove(); }
  assert.equal(result.status, 500);
  assert.equal(code(result), 'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message', 'request_id']);
  for (const leak of ['TEST_INJECTED_FAILURE', 'audit_logs', 'SQLSTATE', pc]) {
    assert.equal(JSON.stringify(result.json).includes(leak), false, leak);
  }
  assert.equal(output.includes(pc), false);
  assert.equal(await count(v), 0);
});
