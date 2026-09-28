'use strict';

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
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
      registerReceptionRoutes(server);
    },
  });
});
after(async () => h.closeAll(app));

const code = (response) => response.json?.error?.code;
const call = (actor, tenantId, body) => h.call(app, {
  subject: actor?.subject, tenantId, method: 'POST', url: '/api/v1/receptions', body,
});
const body = (vehicleId, customerId, extra = {}) => ({ vehicleId, customerId, mileageKm: 12345, ...extra });
async function customer(actor, tenantId) {
  const result = await h.createCustomer(app, actor, tenantId, h.validCustomer());
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.customer.customerId;
}
async function vehicle(actor, tenantId, customerId) {
  const result = await h.call(app, { subject: actor.subject, tenantId, method: 'POST',
    url: '/api/v1/vehicles', body: { customerId,
      plate: `R${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      vehicleType: 'car', brand: 'Marca', model: 'Modelo' } });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.vehicle.vehicleId;
}
async function count(vehicleId) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.receptions
    WHERE vehicle_id=${vehicleId} AND status='open'`;
  return row.n;
}
async function seedLocation(tenantId) {
  const id = randomUUID();
  await h.admin`INSERT INTO public.workshop_locations
    (id, tenant_id, name, address_line, city, department, is_primary)
    VALUES (${id}, ${tenantId}, 'Sucursal', 'Calle 1', 'Bogotá', 'Bogotá', true)`;
  return id;
}
async function seedAppointment(tenantId, customerId, vehicleId) {
  const id = randomUUID();
  await h.admin`INSERT INTO public.appointments
    (id, tenant_id, customer_id, vehicle_id, scheduled_start, scheduled_end, reason)
    VALUES (${id}, ${tenantId}, ${customerId}, ${vehicleId}, now() + interval '1 day',
      now() + interval '2 days', 'Visita')`;
  return id;
}

test('POST minimum: stable DTO, server values, audit and no extra routes', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  const result = await call(a.advisor, a.tenantId, body(v, c));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.headers['cache-control'], 'no-store');
  const r = result.json.reception;
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
  const [stored] = await h.admin`SELECT tenant_id, received_by_membership_id, status, closed_at
    FROM public.receptions WHERE id=${r.receptionId}`;
  assert.equal(stored.tenant_id, a.tenantId);
  assert.equal(stored.received_by_membership_id, a.advisor.membershipId);
  assert.equal(stored.status, 'open');
  assert.equal(stored.closed_at, null);
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
  assert.deepEqual(audit.metadata_json, { fields: ['vehicle_id', 'customer_id', 'mileage_km'] });
  for (const method of ['GET', 'PATCH', 'DELETE'])
    assert.equal(app.hasRoute({ method, url: '/api/v1/receptions' }), false);
});

test('optionals and non-owner same-tenant customer; no appointment lineage rule', async () => {
  const { a } = await h.twoTenants();
  const owner = await customer(a.owner, a.tenantId);
  const visitor = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, owner);
  const locationId = await seedLocation(a.tenantId);
  const appointmentId = await seedAppointment(a.tenantId, owner, v);
  const result = await call(a.owner, a.tenantId, body(v, visitor, {
    appointmentId, locationId, fuelLevelPct: 50, customerNotes: '  Nota\r\ncliente  ',
    advisorNotes: '  Nota interna  ',
  }));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.json.reception.customerId, visitor);
  assert.equal(result.json.reception.appointmentId, appointmentId);
  assert.equal(result.json.reception.locationId, locationId);
  assert.equal(result.json.reception.fuelLevelPct, 50);
  assert.equal(result.json.reception.customerNotes, 'Nota\ncliente');
  assert.equal(result.json.reception.advisorNotes, 'Nota interna');
  const [audit] = await h.admin`SELECT metadata_json FROM public.audit_logs WHERE entity_id=${result.json.reception.receptionId}`;
  assert.equal(JSON.stringify(audit).includes('Nota'), false);
});

test('request logging and audit metadata exclude note contents', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  const secret = `sensitive-${randomUUID()}`;
  let result;
  const output = await h.captureOutput(async () => {
    result = await call(a.owner, a.tenantId, body(v, c,
      { customerNotes: secret, advisorNotes: secret }));
  });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(output.includes(secret), false);
  const [audit] = await h.admin`SELECT metadata_json, before_json, after_json
    FROM public.audit_logs WHERE entity_id=${result.json.reception.receptionId}`;
  assert.equal(JSON.stringify(audit).includes(secret), false);
});

test('validation and server controlled fields reject without insertion', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  const invalid = [
    body(v, c, { mileageKm: -1 }), body(v, c, { fuelLevelPct: -1 }),
    body(v, c, { fuelLevelPct: 101 }), body('bad', c), body(v, 'bad'),
    body(v, c, { appointmentId: 'bad' }), body(v, c, { locationId: 'bad' }),
    body(v, c, { unknown: true }), body(v, c, { customerNotes: 'a'.repeat(2001) }),
    body(v, c, { advisorNotes: 'a'.repeat(2001) }),
    ...['tenantId', 'status', 'receivedByMembershipId', 'receivedAt', 'closedAt', 'createdAt', 'updatedAt']
      .map((key) => body(v, c, { [key]: 'forged' })),
  ];
  for (const payload of invalid) {
    const result = await call(a.owner, a.tenantId, payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
    assert.deepEqual(Object.keys(result.json.error).sort(), ['code', 'message', 'request_id']);
  }
  assert.equal(await count(v), 0);
});

test('RBAC and unauthenticated: route permission blocks technician before handler', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  registerReceptionRoutes({ post(path, options) {
    assert.equal(path, '/api/v1/receptions');
    assert.deepEqual(options.config, { permission: 'receptions.create' });
  } });
  for (const actor of [a.owner, a.admin, a.advisor]) {
    const ownVehicle = actor === a.owner ? v : await vehicle(a.owner, a.tenantId, c);
    assert.equal((await call(actor, a.tenantId, body(ownVehicle, c))).status, 201);
  }
  const separate = await vehicle(a.owner, a.tenantId, c);
  for (const payload of [body(separate, c), { bogus: true }]) {
    const denied = await call(a.technician, a.tenantId, payload);
    assert.equal(denied.status, 403);
    assert.equal(code(denied), 'PERMISSION_DENIED');
  }
  const unauth = await call(null, a.tenantId, body(separate, c));
  assert.equal(unauth.status, 401);
  assert.equal(code(unauth), 'AUTHENTICATION_REQUIRED');
  assert.equal(await count(separate), 0);
});

test('tenant references: foreign and absent IDs share 404, no owner requirement', async () => {
  const { a, b } = await h.twoTenants();
  const ca = await customer(a.owner, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const va = await vehicle(a.owner, a.tenantId, ca);
  const vb = await vehicle(b.owner, b.tenantId, cb);
  const lb = await seedLocation(b.tenantId);
  const ab = await seedAppointment(b.tenantId, cb, vb);
  for (const [payload, expected] of [
    [body(va, cb), 'CUSTOMER_NOT_FOUND'],
    [body(vb, ca), 'VEHICLE_NOT_FOUND'],
    [body(vb, cb), 'VEHICLE_NOT_FOUND'],
    [body(va, ca, { locationId: lb }), 'LOCATION_NOT_FOUND'],
    [body(va, ca, { appointmentId: ab }), 'APPOINTMENT_NOT_FOUND'],
  ]) {
    const result = await call(a.owner, a.tenantId, payload);
    assert.equal(result.status, 404, JSON.stringify(result.json));
    assert.equal(code(result), expected);
    const field = expected.split('_')[0];
    const missing = await call(a.owner, a.tenantId, { ...payload,
      [field === 'VEHICLE' ? 'vehicleId' : field === 'CUSTOMER' ? 'customerId' :
        field === 'LOCATION' ? 'locationId' : 'appointmentId']: randomUUID() });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.message, result.json.error.message);
  }
  assert.equal(await count(va), 0);
});

test('database mileage guard, duplicate open, and two simultaneous creates', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  await h.admin`UPDATE public.vehicles SET current_mileage_km=100 WHERE id=${v}`;
  const low = await call(a.owner, a.tenantId, body(v, c, { mileageKm: 99 }));
  assert.equal(low.status, 400);
  assert.equal(code(low), 'REQUEST_VALIDATION_FAILED');
  assert.equal(await count(v), 0);
  const first = await call(a.owner, a.tenantId, body(v, c));
  assert.equal(first.status, 201);
  const duplicate = await call(a.owner, a.tenantId, body(v, c));
  assert.equal(duplicate.status, 409);
  assert.equal(code(duplicate), 'RECEPTION_ALREADY_OPEN');
  assert.equal(await count(v), 1);
  const concurrentVehicle = await vehicle(a.owner, a.tenantId, c);
  const results = await Promise.all([
    call(a.owner, a.tenantId, body(concurrentVehicle, c)),
    call(a.admin, a.tenantId, body(concurrentVehicle, c)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(results.find((result) => result.status === 409).json.error.code, 'RECEPTION_ALREADY_OPEN');
  assert.equal(await count(concurrentVehicle), 1);
});

test('only known PostgreSQL constraints map; audit failure rolls insert back', async () => {
  for (const [state, expected] of [
    [{ code: '23505', constraint_name: 'receptions_one_open_vehicle_uq' }, 'RECEPTION_ALREADY_OPEN'],
    [{ code: '23503', constraint_name: 'receptions_vehicle_fk' }, 'VEHICLE_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_customer_fk' }, 'CUSTOMER_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_appointment_fk' }, 'APPOINTMENT_NOT_FOUND'],
    [{ code: '23503', constraint_name: 'receptions_location_fk' }, 'LOCATION_NOT_FOUND'],
    [{ code: '23514', constraint_name: 'receptions_vehicle_mileage_guard' }, 'REQUEST_VALIDATION_FAILED'],
    [{ code: '23514', constraint_name: 'receptions_fuel_check' }, 'REQUEST_VALIDATION_FAILED'],
    [{ code: '23514', constraint_name: 'receptions_mileage_check' }, 'REQUEST_VALIDATION_FAILED'],
  ]) assert.equal(mapReceptionDbError(state)?.code, expected);
  assert.equal(mapReceptionDbError({ code: '23505', constraint_name: 'other' }), null);
  assert.equal(mapReceptionDbError({ code: '23514', constraint_name: 'other' }), null);
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const v = await vehicle(a.owner, a.tenantId, c);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'reception.created'");
  try {
    const result = await call(a.owner, a.tenantId, body(v, c));
    assert.equal(result.status, 500);
    assert.equal(code(result), 'INTERNAL_ERROR');
  } finally { await remove(); }
  assert.equal(await count(v), 0);
});
