'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const postgres = require('postgres');

const apiModulePath = process.env.TEST_API_APP_MODULE;
const healthModulePath = process.env.TEST_API_HEALTH_MODULE;
if (!apiModulePath || !healthModulePath) {
  throw new Error('TEST_API_APP_MODULE and TEST_API_HEALTH_MODULE are required');
}
const { buildApi, getTenantRequestContext } = require(apiModulePath);
const { checkDatabaseReady } = require(healthModulePath);

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
const runtimeLogin = process.env.TEST_RUNTIME_LOGIN;
const runtimePassword = process.env.TEST_RUNTIME_PASSWORD;
if (!adminUrl || !runtimeLogin || !runtimePassword) {
  throw new Error('Disposable database and runtime login are required');
}

const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Refusing to run API security tests against a non-local host');
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
  tenant: randomUUID(),
  user: randomUUID(),
  membership: randomUUID(),
  subject: `subject-${randomUUID()}`,
};

const identityProvider = {
  async verifyRequest(request) {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer token-${fixture.subject}`) return null;
    return { identityProvider: 'clerk', externalSubject: fixture.subject };
  },
};

let app;
let rateLimitedApp;

test.before(async () => {
  await admin.begin(async (sql) => {
    await sql`SET LOCAL session_replication_role = replica`;
    await sql`INSERT INTO workshops ${sql({ id: fixture.tenant, slug: `s-${fixture.tenant}`, legal_name: 'T', display_name: 'T' })}`;
    await sql`INSERT INTO users ${sql({ id: fixture.user, external_subject: fixture.subject, email: `${fixture.user}@test.invalid` })}`;
    await sql`INSERT INTO memberships ${sql({ id: fixture.membership, tenant_id: fixture.tenant, user_id: fixture.user })}`;
  });

  app = await buildApi({
    database,
    identityProvider,
    corsAllowedOrigins: ['https://allowed.example'],
    async registerRoutes(server) {
      server.get('/api/v1/__test/ping', async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId };
      });
      server.get('/api/v1/__test/boom', async () => {
        throw new Error('leaking a raw SQL string or stack trace would be a Security Baseline §15 violation');
      });
    },
  });

  // Separate instance with a deliberately tiny global rate limit so the
  // 429 path is reachable in a handful of requests instead of 300+.
  rateLimitedApp = await buildApi({
    database,
    identityProvider,
    rateLimit: { max: 2, timeWindow: '1 minute' },
    async registerRoutes(server) {
      server.get('/api/v1/__test/ping', async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId };
      });
    },
  });
});

test.after(async () => {
  if (app) await app.close();
  if (rateLimitedApp) await rateLimitedApp.close();
  await database.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

test('checkDatabaseReady: true when the check resolves', async () => {
  const fakeSql = () => Promise.resolve([{ ok: 1 }]);
  assert.equal(await checkDatabaseReady(fakeSql, 1000), true);
});

test('checkDatabaseReady: false when the check rejects', async () => {
  const fakeSql = () => Promise.reject(new Error('connection refused'));
  assert.equal(await checkDatabaseReady(fakeSql, 1000), false);
});

test('checkDatabaseReady: false when the check exceeds the timeout', async () => {
  const fakeSql = () => new Promise(() => {}); // never resolves
  assert.equal(await checkDatabaseReady(fakeSql, 50), false);
});

test('GET /health/live is unauthenticated and always 200', async () => {
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'live');
});

test('GET /health/ready reports the real database as ready', async () => {
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.checks.database, true);
});

test('protected routes still require authentication after the health/CORS/rate-limit refactor', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/v1/__test/ping' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');

  const authed = await app.inject({
    method: 'GET',
    url: '/api/v1/__test/ping',
    headers: { authorization: `Bearer token-${fixture.subject}` },
  });
  assert.equal(authed.statusCode, 200);
  assert.equal(authed.json().tenantId, fixture.tenant);
});

test('unexpected errors return a sanitized 500 with request_id, never a stack trace or SQL', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/__test/boom',
    headers: { authorization: `Bearer token-${fixture.subject}` },
  });
  assert.equal(response.statusCode, 500);
  const body = response.json();
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'The request could not be completed.');
  assert.ok(body.error.request_id);
  assert.equal(JSON.stringify(body).includes('leaking'), false, 'the raw error message must never reach the response body');
  assert.equal('stack' in body.error, false);
});

test('security headers: CSP, nosniff, referrer-policy present and no X-Powered-By', async () => {
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(response.headers['content-security-policy'], 'expected a CSP header');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.ok(response.headers['referrer-policy'], 'expected a Referrer-Policy header');
  assert.equal(response.headers['x-powered-by'], undefined);
});

test('CORS: explicit origin allowlist reflects allowed origins and denies others', async () => {
  const allowed = await app.inject({
    method: 'GET',
    url: '/health/live',
    headers: { origin: 'https://allowed.example' },
  });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://allowed.example');

  const denied = await app.inject({
    method: 'GET',
    url: '/health/live',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('rate limiting: exceeding the configured max returns 429 with a stable error code', async () => {
  const first = await rateLimitedApp.inject({ method: 'GET', url: '/api/v1/__test/ping' });
  const second = await rateLimitedApp.inject({ method: 'GET', url: '/api/v1/__test/ping' });
  const third = await rateLimitedApp.inject({ method: 'GET', url: '/api/v1/__test/ping' });

  assert.equal(first.statusCode, 401); // unauthenticated, but counted against the limit
  assert.equal(second.statusCode, 401);
  assert.equal(third.statusCode, 429);
  assert.equal(third.json().error.code, 'RATE_LIMIT_EXCEEDED');
  assert.ok(third.json().error.request_id);
});

test('rate limiting exempts /health/* so orchestrator polling is never throttled', async () => {
  for (let i = 0; i < 5; i += 1) {
    const response = await rateLimitedApp.inject({ method: 'GET', url: '/health/live' });
    assert.equal(response.statusCode, 200);
  }
});
