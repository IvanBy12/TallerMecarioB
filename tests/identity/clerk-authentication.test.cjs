'use strict';

/**
 * S1-03 — real ClerkIdentityProvider (SDK authenticateRequest + jwtKey) in
 * front of the real S1-02 lifecycle, against the migrated disposable DB.
 * Every session token is RS256-signed in-test with a per-run key; the Backend
 * API is a counting fake; any real network attempt trips the global trap.
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert, admin, load, network } = h;
const { buildApi, getTenantRequestContext } = load('api/app.js');
const { ClerkIdentityProvider } = load('identity/clerk/clerk-identity-provider.js');
const {
  ClerkConfigurationError,
  loadClerkAuthenticationConfig,
  parseAuthorizedParties,
  issuerFromPublishableKey,
} = load('identity/clerk/config.js');
const { registerOnboardingRoutes } = load('onboarding/routes.js');

const apiPool = h.runtimePool('api', 6);
const users = new h.FakeClerkUsers();
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: users });
const handlerCalls = { read: 0, ownerOnly: 0 };

let app;
const fixture = {};

function onboardingPayload() {
  return {
    workshop: { legalName: 'Taller Auth S.A.S.', displayName: `Taller Auth ${randomUUID().slice(0, 6)}` },
    primaryLocation: { name: 'Sede', addressLine: 'Calle 1 # 2-3', city: 'Bogotá', department: 'Cundinamarca' },
  };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

before(async () => {
  app = await buildApi({
    database: apiPool,
    identityProvider: provider,
    rateLimit: { max: 10_000, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database: apiPool, rateLimit: { max: 10_000, timeWindow: '1 minute' } });
    },
    registerRoutes(server) {
      server.get('/api/v1/__s103/read', { config: { permission: 'workshop.read' } }, async (request) => {
        handlerCalls.read += 1;
        return { tenantId: getTenantRequestContext(request).tenant.tenantId };
      });
      // owner-only in the RBAC matrix (roles.assign_owner).
      server.post('/api/v1/__s103/owner-only', { config: { permission: 'roles.assign_owner' } }, async () => {
        handlerCalls.ownerOnly += 1;
        return { ok: true };
      });
    },
  });

  fixture.owner = await h.createUser();
  fixture.technician = await h.createUser();
  const workshop = await h.createWorkshop([
    { user: fixture.owner, roles: ['owner'] },
    { user: fixture.technician, roles: ['technician'] },
  ]);
  fixture.tenantId = workshop.tenantId;
});

after(async () => {
  if (app) await app.close();
  await apiPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

async function get(path, headers = {}) {
  return app.inject({ method: 'GET', url: path, headers });
}

describe('networkless session verification (authenticateRequest + jwtKey)', () => {
  test('valid session JWT: GET /me and a tenant route succeed with 0 network and 0 Backend API calls', async () => {
    const networkBefore = network.calls;
    const backendBefore = users.calls.length;
    const token = h.sessionToken(fixture.owner.subject);

    const me = await get('/api/v1/me', bearer(token));
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, fixture.owner.id);

    const tenant = await get('/api/v1/__s103/read', bearer(token));
    assert.equal(tenant.statusCode, 200);
    assert.equal(tenant.json().tenantId, fixture.tenantId);

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await get('/api/v1/__s103/read', bearer(token))).statusCode, 200);
    }
    assert.equal(network.calls - networkBefore, 0, 'no network call on the hot path');
    assert.equal(users.calls.length - backendBefore, 0, 'no Backend API getUser on /me or tenant routes');
  });

  const rejected = [
    ['missing Authorization', () => ({})],
    ['malformed scheme', () => ({ authorization: `Token ${h.sessionToken(fixture.owner.subject)}` })],
    ['expired JWT', () => bearer(h.sessionToken(fixture.owner.subject, {
      exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900, nbf: Math.floor(Date.now() / 1000) - 900,
    }))],
    ['not yet valid (nbf in the future)', () => bearer(h.sessionToken(fixture.owner.subject, { nbf: Math.floor(Date.now() / 1000) + 600 }))],
    ['invalid signature (tampered payload)', () => {
      const [head, , signature] = h.sessionToken(fixture.owner.subject).split('.');
      const forged = Buffer.from(JSON.stringify(h.sessionClaims(fixture.technician.subject))).toString('base64url');
      return bearer(`${head}.${forged}.${signature}`);
    }],
    ['signed by another key with our issuer', () => bearer(h.sessionToken(fixture.owner.subject, {}, { privateKey: h.foreignKeys.privateKey }))],
    ['wrong issuer: another Clerk instance (its own key + its own iss)', () => bearer(h.sessionToken(
      fixture.owner.subject, { iss: h.FOREIGN_ISSUER }, { privateKey: h.foreignKeys.privateKey },
    ))],
    ['wrong issuer even when signed with the configured key', () => bearer(h.sessionToken(fixture.owner.subject, { iss: h.FOREIGN_ISSUER }))],
    ['missing issuer', () => bearer(h.sessionToken(fixture.owner.subject, { iss: undefined }))],
    ['wrong authorized party (azp)', () => bearer(h.sessionToken(fixture.owner.subject, { azp: 'https://evil.example.test' }))],
    ['authorized-party prefix trick', () => bearer(h.sessionToken(fixture.owner.subject, { azp: `${h.AUTHORIZED_PARTY}.evil.test` }))],
    ['missing azp', () => bearer(h.sessionToken(fixture.owner.subject, { azp: undefined }))],
    ['wrong token type: M2M JWT (mch_ subject)', () => bearer(h.sessionToken(`mch_${randomUUID().replaceAll('-', '')}`))],
    ['wrong token type: OAuth access token (typ at+jwt)', () => bearer(h.sessionToken(fixture.owner.subject, {}, { header: { typ: 'at+jwt' } }))],
    ['wrong token type: non-session JWT category', () => bearer(h.sessionToken(fixture.owner.subject, {}, { header: { cat: 'cl_B7d4PD333AAA' } }))],
    ['wrong token type: opaque API key', () => bearer(`ak_${randomUUID().replaceAll('-', '')}`)],
    ['wrong token type: opaque M2M token', () => bearer(`mt_${randomUUID().replaceAll('-', '')}`)],
    ['alg none', () => {
      const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(h.sessionClaims(fixture.owner.subject))).toString('base64url');
      return bearer(`${head}.${body}.`);
    }],
    ['session cookie only (cookie path never reaches the SDK)', () => ({ cookie: `__session=${h.sessionToken(fixture.owner.subject)}` })],
  ];

  for (const [label, headers] of rejected) {
    test(`401 before any handler: ${label}`, async () => {
      const networkBefore = network.calls;
      const handlerBefore = handlerCalls.read;
      for (const path of ['/api/v1/me', '/api/v1/__s103/read']) {
        const response = await get(path, headers());
        assert.equal(response.statusCode, 401, `${label} on ${path}`);
        assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
        assert.ok(response.json().error.request_id);
      }
      assert.equal(handlerCalls.read, handlerBefore);
      assert.equal(network.calls, networkBefore, 'rejection is networkless too');
    });
  }

  test('forged Clerk metadata / organization claims never grant PostgreSQL permissions', async () => {
    const token = h.sessionToken(fixture.technician.subject, {
      metadata: { role: 'owner' },
      public_metadata: { role: 'owner', permissions: ['*'], tenantId: randomUUID() },
      org_id: 'org_forged',
      org_role: 'org:admin',
      org_permissions: ['org:sys_memberships:manage'],
      o: { id: 'org_forged', rol: 'admin', per: 'manage' },
      roles: ['owner', 'admin'],
    });
    const before = handlerCalls.ownerOnly;
    const response = await app.inject({ method: 'POST', url: '/api/v1/__s103/owner-only', headers: bearer(token) });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'PERMISSION_DENIED');
    assert.equal(handlerCalls.ownerOnly, before);

    const owner = await app.inject({ method: 'POST', url: '/api/v1/__s103/owner-only', headers: bearer(h.sessionToken(fixture.owner.subject)) });
    assert.equal(owner.statusCode, 200, 'the PostgreSQL owner role is what authorizes');
  });

  test('Google/Microsoft sign-ins are the same Clerk subject model: identity_provider=clerk, external_subject=sub', async () => {
    for (const provider of ['oauth_google', 'oauth_microsoft']) {
      const subject = h.newSubject(provider);
      users.put(h.clerkUser(subject, {
        email: `${provider}-${randomUUID().slice(0, 6)}@Social.Example.test`,
        externalAccounts: [{ provider, emailAddress: 'social@example.test', providerUserId: 'provider-side-id' }],
      }));
      const response = await app.inject({
        method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
      });
      assert.equal(response.statusCode, 201, provider);
      const [row] = await admin`SELECT identity_provider, external_subject, email FROM public.users WHERE external_subject = ${subject}`;
      assert.equal(row.identity_provider, 'clerk');
      assert.equal(row.external_subject, subject);
      assert.match(row.email, /@social\.example\.test$/u, 'canonical lowercase email only');
      const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE identity_provider IN ('google', 'microsoft', 'oauth_google', 'oauth_microsoft')`;
      assert.equal(n, 0);
    }
  });
});

describe('profile lookup is opt-in (onboarding only)', () => {
  test('onboarding makes exactly one getUser; tenant routes and /me make none', async () => {
    const subject = h.newSubject('onb');
    users.put(h.clerkUser(subject, { email: 'Primary.Person@Example.test' }));
    const before = users.calls.length;
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(users.calls.slice(before), [subject]);

    const token = h.sessionToken(subject);
    const mid = users.calls.length;
    assert.equal((await get('/api/v1/me', bearer(token))).statusCode, 200);
    assert.equal((await get('/api/v1/__s103/read', bearer(token))).statusCode, 200);
    assert.equal(users.calls.length, mid);
  });

  test('onboarding profile lookup runs before any API transaction is opened (pg_stat_activity at call time)', async () => {
    const subject = h.newSubject('onbtx');
    const record = users.put(h.clerkUser(subject));
    let inTransaction;
    users.script(subject, async () => {
      const rows = await admin`
        SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
        WHERE usename = ${process.env.TEST_API_LOGIN} AND datname = pg_catalog.current_database()
          AND (xact_start IS NOT NULL OR state = 'idle in transaction')
      `;
      inTransaction = rows[0].n;
      return record;
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(inTransaction, 0, 'no API backend was inside a transaction during the Backend API call');
  });

  test('primary email is chosen by primaryEmailAddressId, never emailAddresses[0]', async () => {
    const subject = h.newSubject('primary');
    const record = users.put(h.clerkUser(subject, { email: 'the-primary@example.test', decoyFirst: 'decoy-first@example.test' }));
    assert.equal(record.emailAddresses[0].emailAddress, 'decoy-first@example.test');
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 201);
    const [row] = await admin`SELECT email FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(row.email, 'the-primary@example.test');
  });

  test('an unverified PRIMARY email blocks onboarding even when another address is verified', async () => {
    const subject = h.newSubject('unverified');
    users.put(h.clerkUser(subject, { email: 'primary-unverified@example.test', verified: false, decoyFirst: 'verified-other@example.test' }));
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'IDENTITY_EMAIL_UNVERIFIED');
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(n, 0);
  });

  test('a problematic provider full name becomes NULL and never blocks onboarding (S1-01 sanitizer reused)', async () => {
    const subject = h.newSubject('badname');
    users.put(h.clerkUser(subject, { firstName: `Eve${String.fromCodePoint(0x202e)}gnp.exe`, lastName: null }));
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 201);
    const [row] = await admin`SELECT full_name FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(row.full_name, null);
  });

  for (const [label, behavior] of [
    ['429', () => Promise.reject(h.httpError(429))],
    ['503', () => Promise.reject(h.httpError(503))],
    ['network error (no status)', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout (never settles)', () => new Promise(() => {})],
  ]) {
    test(`temporary Backend API failure during onboarding -> 503 IDENTITY_PROVIDER_UNAVAILABLE (${label})`, async () => {
      const subject = h.newSubject('outage');
      users.put(h.clerkUser(subject));
      users.script(subject, behavior);
      const started = Date.now();
      const response = await app.inject({
        method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'IDENTITY_PROVIDER_UNAVAILABLE');
      assert.equal(response.headers['retry-after'], '5');
      assert.ok(Date.now() - started < 5000, 'the Backend API wait is bounded by the finite timeout');
      const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
      assert.equal(n, 0);
    });
  }

  test('Backend API 404 for an authenticated subject during onboarding -> 401, nothing created', async () => {
    const subject = h.newSubject('gone');
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: bearer(h.sessionToken(subject)), payload: onboardingPayload(),
    });
    assert.equal(response.statusCode, 401);
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${subject}`;
    assert.equal(n, 0);
  });
});

describe('configuration is explicit and fails closed', () => {
  test('authorized parties: explicit origins only; wildcard, paths and empty lists are rejected', () => {
    assert.deepEqual(parseAuthorizedParties('http://localhost:5173, https://app.example.test'), ['http://localhost:5173', 'https://app.example.test']);
    for (const bad of [undefined, '', ' , ', '*', 'https://*.example.test', 'https://app.example.test/path', 'app.example.test', 'ftp://x.example.test', 'https://app.example.test/']) {
      assert.throws(() => parseAuthorizedParties(bad), ClerkConfigurationError, String(bad));
    }
  });

  test('issuer derives from the publishable key and can be pinned explicitly; partial config refuses to load', () => {
    assert.equal(issuerFromPublishableKey(h.PUBLISHABLE_KEY), h.ISSUER);
    const env = {
      CLERK_SECRET_KEY: 'sk_test_hermetic',
      CLERK_PUBLISHABLE_KEY: h.PUBLISHABLE_KEY,
      CLERK_JWT_KEY: h.clerkKeys.publicPem.replace(/\n/g, '\\n'),
      CLERK_AUTHORIZED_PARTIES: h.AUTHORIZED_PARTY,
    };
    const config = loadClerkAuthenticationConfig(env);
    assert.equal(config.issuer, h.ISSUER);
    assert.ok(config.jwtKey.includes('\n-----END PUBLIC KEY-----'));
    assert.equal(loadClerkAuthenticationConfig({ ...env, CLERK_ISSUER_URL: 'https://clerk.custom.example.test' }).issuer, 'https://clerk.custom.example.test');
    for (const missing of ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_JWT_KEY', 'CLERK_AUTHORIZED_PARTIES']) {
      const partial = { ...env };
      delete partial[missing];
      assert.throws(() => loadClerkAuthenticationConfig(partial), (error) => error instanceof ClerkConfigurationError
        && !error.message.includes('sk_test_hermetic') && !error.message.includes('BEGIN PUBLIC KEY'));
    }
    assert.throws(() => loadClerkAuthenticationConfig({ ...env, CLERK_ISSUER_URL: 'http://insecure.example.test' }), ClerkConfigurationError);
  });
});
