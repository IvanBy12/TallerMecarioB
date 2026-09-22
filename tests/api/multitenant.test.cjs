'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const postgres = require('postgres');

const apiModulePath = process.env.TEST_API_APP_MODULE;
if (!apiModulePath) throw new Error('TEST_API_APP_MODULE is required');
const { buildApi, getTenantRequestContext } = require(apiModulePath);

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
const runtimeLogin = process.env.TEST_RUNTIME_LOGIN;
const runtimePassword = process.env.TEST_RUNTIME_PASSWORD;
if (!adminUrl || !runtimeLogin || !runtimePassword) {
  throw new Error('Disposable database and runtime login are required');
}

const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Refusing to run API integration tests against a non-local host');
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const runtimeUrl = new URL(adminUrl);
runtimeUrl.username = runtimeLogin;
runtimeUrl.password = runtimePassword;
const database = postgres(runtimeUrl.toString(), {
  max: 4,
  onnotice: () => {},
  connection: { role: 'tallermecario_api' },
});

const fixture = {
  tenantA: randomUUID(),
  tenantB: randomUUID(),
  userA: randomUUID(),
  userWithoutMembership: randomUUID(),
  membershipA: randomUUID(),
  customerA: randomUUID(),
  customerB: randomUUID(),
  subjectA: `subject-a-${randomUUID()}`,
  subjectWithoutMembership: `subject-none-${randomUUID()}`,
};

const identities = new Map([
  ['token-a', fixture.subjectA],
  ['token-no-membership', fixture.subjectWithoutMembership],
]);

let app;
let lastTenantContext;

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

test.before(async () => {
  const [runtimeRole] = await database`
    SELECT current_user AS role,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser,
      (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass_rls
  `;
  assert.equal(runtimeRole.role, 'tallermecario_api');
  assert.equal(runtimeRole.superuser, false);
  assert.equal(runtimeRole.bypass_rls, false);

  await admin.begin(async (sql) => {
    await sql`SET LOCAL session_replication_role = replica`;
    await sql`INSERT INTO workshops ${sql([
      { id: fixture.tenantA, slug: `a-${fixture.tenantA}`, legal_name: 'Tenant A', display_name: 'Tenant A' },
      { id: fixture.tenantB, slug: `b-${fixture.tenantB}`, legal_name: 'Tenant B', display_name: 'Tenant B' },
    ])}`;
    await sql`INSERT INTO users ${sql([
      { id: fixture.userA, external_subject: fixture.subjectA, email: `${fixture.userA}@test.invalid` },
      { id: fixture.userWithoutMembership, external_subject: fixture.subjectWithoutMembership, email: `${fixture.userWithoutMembership}@test.invalid` },
    ])}`;
    await sql`INSERT INTO memberships ${sql({
      id: fixture.membershipA,
      tenant_id: fixture.tenantA,
      user_id: fixture.userA,
    })}`;
    await sql`INSERT INTO customers ${sql([
      { id: fixture.customerA, tenant_id: fixture.tenantA, first_name: 'Allowed', last_name: 'A', phone: '3000000001', notes: 'tenant-a' },
      { id: fixture.customerB, tenant_id: fixture.tenantB, first_name: 'Hidden', last_name: 'B', phone: '3000000002', notes: 'tenant-b' },
    ])}`;
  });

  app = await buildApi({
    database,
    identityProvider: {
      async verifyRequest(request) {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return null;
        const externalSubject = identities.get(authorization.slice(7));
        return externalSubject
          ? { identityProvider: 'clerk', externalSubject }
          : null;
      },
    },
    async registerRoutes(server) {
      server.get('/api/v1/customers/:id', async (request, reply) => {
        const context = getTenantRequestContext(request);
        lastTenantContext = context.tenant;
        const { id } = request.params;
        const rows = await context.sql`
          SELECT id, first_name, last_name, phone
          FROM public.customers
          WHERE id = ${id}
        `;
        if (rows.length === 0) return reply.code(404).send({ error: { code: 'CUSTOMER_NOT_FOUND', request_id: request.id } });
        return rows[0];
      });

      // Test-only probe: validates that an API write cannot reach another tenant.
      server.patch('/__test/customers/:id', {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['notes'],
            properties: { notes: { type: 'string', maxLength: 200 } },
          },
        },
      }, async (request, reply) => {
        const context = getTenantRequestContext(request);
        lastTenantContext = context.tenant;
        const { id } = request.params;
        const { notes } = request.body;
        const rows = await context.sql`
          UPDATE public.customers
          SET notes = ${notes}, updated_at = now()
          WHERE id = ${id}
          RETURNING id
        `;
        if (rows.length === 0) return reply.code(404).send({ error: { code: 'CUSTOMER_NOT_FOUND', request_id: request.id } });
        return { id: rows[0].id };
      });
    },
  });
});

test.after(async () => {
  if (app) await app.close();
  await database.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

test('TenantContext is derived from a verified identity and active PostgreSQL membership', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/customers/${fixture.customerA}`,
    headers: auth('token-a'),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().id, fixture.customerA);
  assert.equal(lastTenantContext.tenantId, fixture.tenantA);
  assert.equal(lastTenantContext.userId, fixture.userA);
  assert.equal(lastTenantContext.membershipId, fixture.membershipA);
  assert.ok(lastTenantContext.requestId);
});

test('Tenant A cannot read a Tenant B customer through Fastify', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/customers/${fixture.customerB}`,
    headers: auth('token-a'),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'CUSTOMER_NOT_FOUND');
});

test('Tenant A can update A but cannot modify B through Fastify', async () => {
  const allowed = await app.inject({
    method: 'PATCH',
    url: `/__test/customers/${fixture.customerA}`,
    headers: auth('token-a'),
    payload: { notes: 'updated-a' },
  });
  assert.equal(allowed.statusCode, 200);

  const denied = await app.inject({
    method: 'PATCH',
    url: `/__test/customers/${fixture.customerB}`,
    headers: auth('token-a'),
    payload: { notes: 'tampered-b' },
  });
  assert.equal(denied.statusCode, 404);

  const rows = await admin`
    SELECT id, notes FROM public.customers
    WHERE id IN (${fixture.customerA}, ${fixture.customerB})
    ORDER BY id
  `;
  const notes = new Map(rows.map((row) => [row.id, row.notes]));
  assert.equal(notes.get(fixture.customerA), 'updated-a');
  assert.equal(notes.get(fixture.customerB), 'tenant-b');
});

test('invalid identity and identity without an active membership are rejected', async () => {
  const unauthenticated = await app.inject({
    method: 'GET',
    url: `/api/v1/customers/${fixture.customerA}`,
    headers: auth('invalid-token'),
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, 'AUTHENTICATION_REQUIRED');
  assert.ok(unauthenticated.json().error.request_id);

  const noMembership = await app.inject({
    method: 'GET',
    url: `/api/v1/customers/${fixture.customerA}`,
    headers: auth('token-no-membership'),
  });
  assert.equal(noMembership.statusCode, 403);
  assert.equal(noMembership.json().error.code, 'ACTIVE_MEMBERSHIP_REQUIRED');
  assert.ok(noMembership.json().error.request_id);
});
