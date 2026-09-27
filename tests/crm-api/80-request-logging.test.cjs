'use strict';

const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { Writable } = require('node:stream');
const { test, before, after } = require('node:test');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');

const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const chunks = [];
const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString('utf8')); done(); } });
const secret = {
  name: 'PrivateCustomerName', phone: '3009876543', email: 'private.customer@example.test',
  document: 'PRIVATE123456', plate: 'PRIVATEPLATE123', vin: 'VINPRIVATESENTINEL',
  engine: 'ENGINEPRIVATESENTINEL', query: 'SensitiveSearchValue', cookie: 'session=PrivateCookieValue',
};
let app;

before(async () => {
  app = await buildApi({
    database: h.apiPool, identityProvider: provider, logStream: stream,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerCustomerRoutes(server);
      registerVehicleRoutes(server);
      server.get('/api/v1/__s208/failure', { config: { permission: 'customers.read' } }, async () => {
        throw new Error(`internal diagnostic ${secret.name} ${secret.email} ${secret.cookie}`);
      });
    },
  });
});
after(async () => {
  await h.closeAll(app);
  stream.end();
});

function assertPrivateLogs(raw, forbidden) {
  for (const value of forbidden) assert.equal(raw.includes(value), false, `private value reached logger: ${value}`);
  assert.doesNotMatch(raw, /Bearer\s|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
  assert.doesNotMatch(raw, /\/api\/v1\/[^"\s]*\?/u, 'raw URL with query reached logger');
}

async function loggedRequest(invoke, { method, route, status, errorCode, actor, tenantId, forbidden = [] }) {
  chunks.length = 0;
  const response = await invoke();
  assert.equal(response.status, status, JSON.stringify(response.json));
  const raw = chunks.join('');
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
  const completions = lines.filter((line) => line.status_code !== undefined);
  assert.equal(completions.length, 1, 'exactly one completion event per request');
  const completion = completions[0];
  assert.match(completion.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  assert.equal(completion.method, method);
  assert.equal(completion.route, route);
  assert.equal(completion.status_code, status);
  assert.equal(typeof completion.duration_ms, 'number');
  assert.ok(completion.duration_ms >= 0);
  if (errorCode) {
    assert.equal(completion.error_code, errorCode);
    if (response.json?.error?.request_id) assert.equal(completion.request_id, response.json.error.request_id);
  } else assert.equal('error_code' in completion, false);
  if (actor) {
    assert.equal(completion.tenant_id, tenantId);
    assert.equal(completion.user_id, actor.user.id);
    assert.equal(completion.membership_id, actor.membershipId);
  } else {
    for (const key of ['tenant_id', 'user_id', 'membership_id']) assert.equal(key in completion, false);
  }
  const allowed = new Set([
    'level', 'request_id', 'method', 'route', 'status_code', 'error_code',
    'duration_ms', 'tenant_id', 'user_id', 'membership_id',
  ]);
  for (const key of Object.keys(completion)) assert.ok(allowed.has(key), `unexpected completion field: ${key}`);
  assertPrivateLogs(raw, [...Object.values(secret), ...forbidden]);
  return { response, lines };
}

test('S2-08 request logging: CRM reads, search, mutations and 400/404/409/500 keep the closed privacy contract', async () => {
  const { a } = await h.twoTenants();
  const token = h.sessionToken(a.owner.subject);
  const headers = { authorization: `Bearer ${token}`, cookie: secret.cookie };
  const customerBody = {
    firstName: secret.name, lastName: 'PrivateLastName', phone: secret.phone,
    email: secret.email, documentType: 'CC', documentNumber: secret.document,
  };
  const created = await loggedRequest(() => h.call(app, {
    method: 'POST', url: '/api/v1/customers', tenantId: a.tenantId, body: customerBody, headers,
  }), { method: 'POST', route: '/api/v1/customers', status: 201, actor: a.owner, tenantId: a.tenantId,
    forbidden: [token, 'PrivateLastName', JSON.stringify(customerBody)] });
  const customer = created.response.json.customer;

  await loggedRequest(() => h.getCustomer(app, a.owner, a.tenantId, customer.customerId), {
    method: 'GET', route: '/api/v1/customers/:customerId', status: 200, actor: a.owner, tenantId: a.tenantId,
  });
  await loggedRequest(() => h.listCustomers(app, a.owner, a.tenantId,
    `name=${encodeURIComponent(secret.query)}`), {
    method: 'GET', route: '/api/v1/customers', status: 200, actor: a.owner, tenantId: a.tenantId,
  });
  await loggedRequest(() => h.call(app, {
    method: 'POST', url: '/api/v1/vehicles', tenantId: a.tenantId, headers,
    body: { customerId: customer.customerId, plate: secret.plate, vehicleType: 'car',
      brand: 'Marca', model: 'Modelo', vin: secret.vin, engineNumber: secret.engine },
  }), { method: 'POST', route: '/api/v1/vehicles', status: 201, actor: a.owner, tenantId: a.tenantId,
    forbidden: [token] });

  await loggedRequest(() => h.createCustomer(app, a.owner, a.tenantId, {
    firstName: secret.name, lastName: 'PrivateLastName', phone: 'invalid',
  }), { method: 'POST', route: '/api/v1/customers', status: 400,
    errorCode: 'REQUEST_VALIDATION_FAILED', actor: a.owner, tenantId: a.tenantId });
  await loggedRequest(() => h.getCustomer(app, a.owner, a.tenantId, randomUUID()), {
    method: 'GET', route: '/api/v1/customers/:customerId', status: 404,
    errorCode: 'CUSTOMER_NOT_FOUND', actor: a.owner, tenantId: a.tenantId });
  await loggedRequest(() => h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: '2020-01-01T00:00:00.000000Z', firstName: secret.name,
  }), { method: 'PATCH', route: '/api/v1/customers/:customerId', status: 409,
    errorCode: 'RESOURCE_VERSION_CONFLICT', actor: a.owner, tenantId: a.tenantId });

  await loggedRequest(() => h.call(app, {
    url: `/unmatched?name=${encodeURIComponent(secret.query)}`, headers: { cookie: secret.cookie },
  }), { method: 'GET', route: 'unmatched', status: 404, errorCode: 'NOT_FOUND' });

  const failed = await loggedRequest(() => h.call(app, {
    subject: a.owner.subject, url: '/api/v1/__s208/failure', tenantId: a.tenantId,
  }), { method: 'GET', route: '/api/v1/__s208/failure', status: 500,
    errorCode: 'INTERNAL_ERROR', actor: a.owner, tenantId: a.tenantId });
  assert.deepEqual(Object.keys(failed.response.json.error).sort(), ['code', 'message', 'request_id']);
  assert.equal(failed.response.json.error.message, 'The request could not be completed.');
  const diagnostics = failed.lines.filter((line) => line.diagnostic === 'request_internal_error');
  assert.equal(diagnostics.length, 1, 'one safe server diagnostic for the 500');
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['diagnostic', 'level', 'request_id']);
  assert.equal(diagnostics[0].request_id, failed.response.json.error.request_id);
});

test('S2-08 privacy assertion rejects a raw query serialization probe', () => {
  assert.throws(() => assertPrivateLogs(JSON.stringify({ url: `/api/v1/customers?name=${secret.query}` }),
    Object.values(secret)), /private value reached logger|raw URL with query/u);
});

test('S2-08 central redaction masks accidental structured sensitive fields', () => {
  chunks.length = 0;
  app.log.info({
    req: { url: `/api/v1/customers?name=${secret.query}` },
    headers: { authorization: `Bearer ${secret.vin}`, cookie: secret.cookie },
    body: { firstName: secret.name, phone: secret.phone },
    customer: { email: secret.email, documentNumber: secret.document },
    vehicle: { plate: secret.plate, vin: secret.vin, engineNumber: secret.engine },
  }, 'redaction probe');
  const raw = chunks.join('');
  assert.match(raw, /\[REDACTED\]/u);
  assertPrivateLogs(raw, Object.values(secret));
});
