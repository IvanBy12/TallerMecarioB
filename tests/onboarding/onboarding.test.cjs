'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const postgres = require('postgres');

const {
  buildApi,
  getIdentityOnlyRequestContext,
  getIdentityProfileRequestContext,
  getTenantRequestContext,
} = require(process.env.TEST_API_APP_MODULE);
const { registerOnboardingRoutes } = require(process.env.TEST_ONBOARDING_ROUTES_MODULE);

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
const runtimeUrl = process.env.TEST_DATABASE_URL_RUNTIME;
if (!adminUrl || !runtimeUrl) throw new Error('Disposable database URLs are required');
const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Refusing to run onboarding tests against a non-local host');
}

const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });
const database = postgres(runtimeUrl, {
  max: 8,
  onnotice: () => {},
  connection: { role: 'tallermecario_api' },
});

const subjectsByToken = new Map();
const profilesBySubject = new Map();
const extraIdentityData = new Set();

function addIdentity(name, overrides = {}) {
  const token = `token-${name}-${randomUUID()}`;
  const subject = `subject-${name}-${randomUUID()}`;
  subjectsByToken.set(token, subject);
  profilesBySubject.set(subject, {
    email: `${name}-${randomUUID()}@example.test`,
    emailVerified: true,
    fullName: `User ${name}`,
    ...overrides,
  });
  return { token, subject };
}

const identityProvider = {
  async verifyRequest(request) {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const subject = subjectsByToken.get(header.slice(7));
    if (!subject) return null;
    const identity = { identityProvider: 'clerk', externalSubject: subject };
    if (extraIdentityData.has(subject)) {
      identity.roles = ['platform_admin'];
      identity.publicMetadata = { tenantId: randomUUID(), role: 'owner' };
    }
    return identity;
  },
  async getIdentityProfile(identity) {
    const profile = profilesBySubject.get(identity.externalSubject);
    if (!profile) throw new Error('profile missing');
    if (extraIdentityData.has(identity.externalSubject)) {
      return { ...profile, privateMetadata: { roles: ['owner'] }, organizationRole: 'admin' };
    }
    return profile;
  },
};

function validPayload(label = 'Central') {
  return {
    workshop: {
      legalName: `Taller ${label} S.A.S.`,
      displayName: `Taller ${label}`,
      taxId: `NIT-${randomUUID().slice(0, 8)}`,
      phone: '+57 300 123 4567',
      email: `${label.toLowerCase().replace(/[^a-z]/g, '')}@example.test`,
    },
    primaryLocation: {
      name: 'Sede principal',
      addressLine: 'Carrera 7 # 12-34',
      city: 'Bogotá',
      department: 'Cundinamarca',
      phone: '+57 601 555 0101',
    },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

async function postOnboarding(identity, payload = validPayload(), injectOptions = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/onboarding/workshops',
    headers: auth(identity.token),
    payload,
    ...injectOptions,
  });
}

async function createFailureTrigger(table, suffix) {
  const functionName = `test_fail_${suffix}`;
  const triggerName = `test_fail_${suffix}_trg`;
  await admin.unsafe(`
    CREATE FUNCTION public.${functionName}() RETURNS trigger
    LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''TEST_INJECTED_FAILURE''; END';
    CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.${table}
    FOR EACH ROW EXECUTE FUNCTION public.${functionName}();
  `);
  return async () => {
    await admin.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON public.${table}`);
    await admin.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
  };
}

let app;

test.before(async () => {
  app = await buildApi({
    database,
    identityProvider,
    rateLimit: { max: 1000, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, {
        database,
        rateLimit: { max: 1000, timeWindow: '1 minute' },
      });
    },
    registerRoutes(server) {
      server.get('/api/v1/__test/tenant', async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId };
      });
    },
  });
});

test.after(async () => {
  if (app) await app.close();
  await database.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

test('V01/V02/V03: runtime and SECURITY DEFINER attributes preserve ADR-009 boundaries', async () => {
  const [runtime] = await database`
    SELECT current_user AS role,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser,
      (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user) AS bypass
  `;
  assert.deepEqual(runtime, { role: 'tallermecario_api', superuser: false, bypass: false });

  const [security] = await admin`
    SELECT r.rolcanlogin, r.rolbypassrls,
      p.prosecdef,
      pg_catalog.pg_get_userbyid(p.proowner) AS function_owner,
      p.proconfig,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
      has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.rolname = 'tallermecario_bootstrap_resolver'
    WHERE n.nspname = 'app' AND p.proname = 'bootstrap_provision_user'
  `;
  assert.equal(security.rolcanlogin, false);
  assert.equal(security.rolbypassrls, true);
  assert.equal(security.prosecdef, true);
  assert.equal(security.function_owner, 'tallermecario_bootstrap_resolver');
  assert.deepEqual(security.proconfig, ['search_path=pg_catalog']);
  assert.equal(security.public_execute, false);
  assert.equal(security.api_execute, true);
});

test('V04/V05: audit_logs retains ENABLE + FORCE RLS and tenant-only runtime INSERT policy', async () => {
  const [table] = await admin`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = 'public.audit_logs'::regclass
  `;
  assert.equal(table.relrowsecurity, true);
  assert.equal(table.relforcerowsecurity, true);
  const policies = await admin`
    SELECT policyname, roles, cmd, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs'
    ORDER BY policyname
  `;
  const insert = policies.find((policy) => policy.cmd === 'INSERT');
  assert.deepEqual(insert.roles.sort(), ['tallermecario_api', 'tallermecario_worker']);
  assert.match(insert.with_check, /tenant_id = app\.current_tenant_id/);
});

test('P4: bootstrap resolver column privileges match the S1-01 allowlist exactly', async () => {
  const privileges = await admin`
    SELECT table_name, column_name, privilege_type
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee = 'tallermecario_bootstrap_resolver'
      AND table_name IN ('users', 'audit_logs')
    ORDER BY table_name, column_name, privilege_type
  `;
  const userColumns = await admin`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `;
  const expected = [
    ...userColumns.map(({ column_name }) => `users.${column_name}.SELECT`),
    ...['id', 'identity_provider', 'external_subject', 'email', 'full_name', 'status']
      .map((column) => `users.${column}.INSERT`),
    ...[
      'id', 'tenant_id', 'actor_type', 'actor_user_id', 'action', 'outcome',
      'entity_type', 'entity_id', 'metadata_json', 'request_id',
    ].map((column) => `audit_logs.${column}.INSERT`),
  ].sort();
  const actual = privileges
    .map((row) => `${row.table_name}.${row.column_name}.${row.privilege_type}`)
    .sort();
  assert.deepEqual(actual, expected);
  assert.equal(actual.includes('users.email.UPDATE'), false);
  assert.equal(actual.includes('users.full_name.UPDATE'), false);
  assert.equal(actual.includes('users.updated_at.UPDATE'), false);
});

test('P1: profile lookup is opt-in and tenant routes do not request it', async () => {
  const token = `profile-opt-in-${randomUUID()}`;
  const subject = `profile-opt-in-${randomUUID()}`;
  const calls = { verify: 0, profile: 0 };
  const countingProvider = {
    async verifyRequest(request) {
      calls.verify += 1;
      return request.headers.authorization === `Bearer ${token}`
        ? { identityProvider: 'clerk', externalSubject: subject }
        : null;
    },
    async getIdentityProfile() {
      calls.profile += 1;
      return { email: `${randomUUID()}@example.test`, emailVerified: true, fullName: 'Opt In' };
    },
  };
  const countingApp = await buildApi({
    database,
    identityProvider: countingProvider,
    rateLimit: { max: 100, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database, rateLimit: { max: 100, timeWindow: '1 minute' } });
      server.get('/api/v1/__test/identity-only', async (request) => ({
        subject: getIdentityOnlyRequestContext(request).identity.externalSubject,
      }));
      server.get('/api/v1/__test/profile-not-loaded', async (request) => ({
        profile: getIdentityProfileRequestContext(request).profile.email,
      }));
    },
    registerRoutes(server) {
      server.get('/api/v1/__test/profile-tenant', async (request) => ({
        tenantId: getTenantRequestContext(request).tenant.tenantId,
      }));
    },
  });
  try {
    const onboarding = await countingApp.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops',
      headers: auth(token), payload: validPayload('Profile Opt In'),
    });
    assert.equal(onboarding.statusCode, 201);
    assert.deepEqual(calls, { verify: 1, profile: 1 });

    calls.verify = 0;
    calls.profile = 0;
    const identityOnly = await countingApp.inject({
      method: 'GET', url: '/api/v1/__test/identity-only', headers: auth(token),
    });
    assert.equal(identityOnly.statusCode, 200);
    assert.deepEqual(calls, { verify: 1, profile: 0 });

    calls.verify = 0;
    calls.profile = 0;
    const profileNotLoaded = await countingApp.inject({
      method: 'GET', url: '/api/v1/__test/profile-not-loaded', headers: auth(token),
    });
    assert.equal(profileNotLoaded.statusCode, 500);
    assert.equal(profileNotLoaded.json().error.code, 'IDENTITY_PROFILE_CONTEXT_UNAVAILABLE');
    assert.deepEqual(calls, { verify: 1, profile: 0 });

    calls.verify = 0;
    calls.profile = 0;
    const tenant = await countingApp.inject({
      method: 'GET', url: '/api/v1/__test/profile-tenant', headers: auth(token),
    });
    assert.equal(tenant.statusCode, 200);
    assert.deepEqual(calls, { verify: 1, profile: 0 });
  } finally {
    await countingApp.close();
  }
});

test('P2: profile provider outage is a sanitized 503 and does not affect identity-only routes', async () => {
  const token = `profile-unavailable-${randomUUID()}`;
  let profileCalls = 0;
  let failure = 'unavailable';
  const unavailableProvider = {
    async verifyRequest(request) {
      return request.headers.authorization === `Bearer ${token}`
        ? { identityProvider: 'clerk', externalSubject: `subject-${token}` }
        : null;
    },
    async getIdentityProfile() {
      profileCalls += 1;
      if (failure === 'not-found') {
        throw Object.assign(new Error('provider user does not exist'), {
          code: 'IDENTITY_PROFILE_NOT_FOUND',
        });
      }
      throw new Error('SDK timeout containing provider internals');
    },
  };
  const unavailableApp = await buildApi({
    database,
    identityProvider: unavailableProvider,
    rateLimit: { max: 100, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database, rateLimit: { max: 100, timeWindow: '1 minute' } });
      server.get('/api/v1/__test/identity-only-unavailable', async (request) => ({
        subject: getIdentityOnlyRequestContext(request).identity.externalSubject,
      }));
    },
  });
  try {
    const identityOnly = await unavailableApp.inject({
      method: 'GET', url: '/api/v1/__test/identity-only-unavailable', headers: auth(token),
    });
    assert.equal(identityOnly.statusCode, 200);
    assert.equal(profileCalls, 0);

    const onboarding = await unavailableApp.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops',
      headers: auth(token), payload: validPayload('Provider Down'),
    });
    assert.equal(onboarding.statusCode, 503);
    assert.equal(onboarding.json().error.code, 'IDENTITY_PROVIDER_UNAVAILABLE');
    assert.equal(onboarding.headers['retry-after'], '5');
    assert.equal(onboarding.body.includes('SDK timeout'), false);
    assert.equal(profileCalls, 1);

    failure = 'not-found';
    const missingIdentity = await unavailableApp.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops',
      headers: auth(token), payload: validPayload('Provider Missing'),
    });
    assert.equal(missingIdentity.statusCode, 401);
    assert.equal(missingIdentity.json().error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(missingIdentity.body.includes('provider user does not exist'), false);
    assert.equal(profileCalls, 2);
  } finally {
    await unavailableApp.close();
  }
});

test('T01/T02: authentication is required and an unverified provider email is rejected', async () => {
  const unauthenticated = await app.inject({
    method: 'POST', url: '/api/v1/onboarding/workshops', payload: validPayload(),
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, 'AUTHENTICATION_REQUIRED');

  const unverified = addIdentity('unverified', { emailVerified: false });
  const denied = await postOnboarding(unverified);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'IDENTITY_EMAIL_UNVERIFIED');
});

test('T03: strict allowlists reject tenantId, userId, roles, status and internal IDs', async () => {
  const identity = addIdentity('mass-assignment');
  const payloads = [
    { ...validPayload(), tenantId: randomUUID() },
    { ...validPayload(), userId: randomUUID() },
    { ...validPayload(), roles: ['owner'] },
    { ...validPayload(), workshop: { ...validPayload().workshop, status: 'active' } },
    { ...validPayload(), primaryLocation: { ...validPayload().primaryLocation, id: randomUUID(), isPrimary: false } },
  ];
  for (const [index, payload] of payloads.entries()) {
    const response = await postOnboarding(identity, payload);
    assert.equal(response.statusCode, 400, JSON.stringify({ index, body: response.body }));
    assert.equal(response.json().error.code, 'REQUEST_VALIDATION_FAILED');
  }
});

test('P5: regional defaults are server-owned and client values are rejected atomically', async () => {
  const identity = addIdentity('regional-defaults');
  const payloads = [
    { ...validPayload(), workshop: { ...validPayload().workshop, timezone: 'UTC' } },
    { ...validPayload(), workshop: { ...validPayload().workshop, currency: 'USD' } },
    { ...validPayload(), primaryLocation: { ...validPayload().primaryLocation, countryCode: 'US' } },
  ];
  for (const payload of payloads) {
    const response = await postOnboarding(identity, payload);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'REQUEST_VALIDATION_FAILED');
  }
  const [state] = await admin`
    SELECT
      (SELECT count(*)::int FROM public.users WHERE external_subject = ${identity.subject}) AS users,
      (SELECT count(*)::int FROM public.workshops WHERE legal_name = 'Taller Central S.A.S.') AS workshops
  `;
  assert.deepEqual(state, { users: 0, workshops: 0 });
});

test('T04: wrong types, null, NUL, controls and lone surrogates are rejected without coercion', async () => {
  const identity = addIdentity('invalid-text');
  const payloads = [
    { ...validPayload(), workshop: { ...validPayload().workshop, legalName: 123 } },
    { ...validPayload(), workshop: { ...validPayload().workshop, displayName: null } },
    { ...validPayload(), workshop: { ...validPayload().workshop, legalName: 'bad\u0000name' } },
    { ...validPayload(), primaryLocation: { ...validPayload().primaryLocation, city: 'bad\u0007city' } },
  ];
  for (const [index, payload] of payloads.entries()) {
    const response = await postOnboarding(identity, payload);
    assert.equal(response.statusCode, 400, JSON.stringify({ index, body: response.body }));
    assert.equal(response.json().error.code, 'REQUEST_VALIDATION_FAILED');
  }

  const baseJson = JSON.stringify(validPayload());
  const loneSurrogateJson = baseJson.replace(
    '"displayName":"Taller Central"',
    '"displayName":"\\ud800"',
  );
  assert.equal(loneSurrogateJson.includes('\\ud800'), true);
  assert.equal(JSON.parse(loneSurrogateJson).workshop.displayName.charCodeAt(0), 0xd800);
  const loneSurrogate = await app.inject({
    method: 'POST',
    url: '/api/v1/onboarding/workshops',
    headers: { ...auth(identity.token), 'content-type': 'application/json' },
    payload: loneSurrogateJson,
  });
  assert.equal(loneSurrogate.statusCode, 400);
  assert.equal(loneSurrogate.json().error.code, 'REQUEST_VALIDATION_FAILED');
});

test('T05/T06/T07: malformed JSON, media type and body limit use stable safe errors', async () => {
  const identity = addIdentity('transport-errors');
  const malformed = await app.inject({
    method: 'POST', url: '/api/v1/onboarding/workshops', headers: {
      ...auth(identity.token), 'content-type': 'application/json',
    }, payload: '{"workshop":',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'REQUEST_BODY_MALFORMED');

  const media = await app.inject({
    method: 'POST', url: '/api/v1/onboarding/workshops', headers: {
      ...auth(identity.token), 'content-type': 'text/plain',
    }, payload: JSON.stringify(validPayload()),
  });
  assert.equal(media.statusCode, 415);
  assert.equal(media.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const tooLarge = validPayload();
  tooLarge.workshop.legalName = 'a'.repeat(20 * 1024);
  const large = await postOnboarding(identity, tooLarge);
  assert.equal(large.statusCode, 413);
  assert.equal(large.json().error.code, 'PAYLOAD_TOO_LARGE');

  const rateLimitedApp = await buildApi({
    database,
    identityProvider,
    rateLimit: { max: 2, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database, rateLimit: { max: 100, timeWindow: '1 minute' } });
    },
  });
  try {
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await rateLimitedApp.inject({
        method: 'POST', url: '/api/v1/onboarding/workshops', payload: validPayload('Rate Limit'),
      }));
    }
    assert.equal(responses[2].statusCode, 429);
    assert.equal(responses[2].json().error.code, 'RATE_LIMIT_EXCEEDED');
  } finally {
    await rateLimitedApp.close();
  }
});

test('T08: a disabled local user is denied without creating tenant state', async () => {
  const identity = addIdentity('disabled');
  const userId = randomUUID();
  const profile = profilesBySubject.get(identity.subject);
  await admin`INSERT INTO public.users ${admin({
    id: userId,
    identity_provider: 'clerk',
    external_subject: identity.subject,
    email: profile.email,
    status: 'disabled',
  })}`;
  const response = await postOnboarding(identity, validPayload('Disabled'));
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'USER_DISABLED');
  const [count] = await admin`SELECT count(*)::int AS n FROM public.workshops WHERE legal_name = 'Taller Disabled S.A.S.'`;
  assert.equal(count.n, 0);
});

test('T09: location insertion failure rolls back user, workshop and all tenant-owned rows', async () => {
  const identity = addIdentity('rollback-location');
  const removeTrigger = await createFailureTrigger('workshop_locations', 'onboarding_location');
  try {
    const response = await postOnboarding(identity, validPayload('Rollback Location'));
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
  } finally {
    await removeTrigger();
  }
  const [state] = await admin`
    SELECT
      (SELECT count(*)::int FROM public.users WHERE external_subject = ${identity.subject}) AS users,
      (SELECT count(*)::int FROM public.workshops WHERE legal_name = 'Taller Rollback Location S.A.S.') AS workshops,
      (SELECT count(*)::int FROM public.audit_logs WHERE action = 'identity.user_provisioned_jit'
        AND actor_user_id IN (SELECT id FROM public.users WHERE external_subject = ${identity.subject})) AS audits
  `;
  assert.deepEqual(state, { users: 0, workshops: 0, audits: 0 });
});

test('T10: membership insertion failure rolls back workshop and primary location', async () => {
  const identity = addIdentity('rollback-membership');
  const removeTrigger = await createFailureTrigger('memberships', 'onboarding_membership');
  try {
    const response = await postOnboarding(identity, validPayload('Rollback Membership'));
    assert.equal(response.statusCode, 500);
  } finally {
    await removeTrigger();
  }
  const [state] = await admin`
    SELECT
      (SELECT count(*)::int FROM public.users WHERE external_subject = ${identity.subject}) AS users,
      (SELECT count(*)::int FROM public.workshops WHERE legal_name = 'Taller Rollback Membership S.A.S.') AS workshops,
      (SELECT count(*)::int FROM public.workshop_locations l
        JOIN public.workshops w ON w.id = l.tenant_id
        WHERE w.legal_name = 'Taller Rollback Membership S.A.S.') AS locations
  `;
  assert.deepEqual(state, { users: 0, workshops: 0, locations: 0 });
});

test('T11/V06: concurrent JIT provisioning returns one local user and one global audit event', async () => {
  const subject = `subject-jit-${randomUUID()}`;
  const email = `jit-${randomUUID()}@example.test`;
  const calls = await Promise.all([
    database`SELECT * FROM app.bootstrap_provision_user('clerk', ${subject}, ${randomUUID()}::uuid, ${email}, 'JIT User', ${randomUUID()})`,
    database`SELECT * FROM app.bootstrap_provision_user('clerk', ${subject}, ${randomUUID()}::uuid, ${email}, 'JIT User', ${randomUUID()})`,
  ]);
  assert.equal(calls[0][0].user_id, calls[1][0].user_id);
  assert.equal(calls.flat().filter((row) => row.provisioned).length, 1);
  const [state] = await admin`
    SELECT
      (SELECT count(*)::int FROM public.users WHERE identity_provider = 'clerk' AND external_subject = ${subject}) AS users,
      (SELECT count(*)::int FROM public.audit_logs WHERE action = 'identity.user_provisioned_jit'
        AND entity_id = ${calls[0][0].user_id}) AS audits
  `;
  assert.deepEqual(state, { users: 1, audits: 1 });
});

test('T12/P3: JIT preserves an existing local profile and receives owner membership atomically', async () => {
  const identity = addIdentity('existing');
  const userId = randomUUID();
  await admin`INSERT INTO public.users ${admin({
    id: userId,
    identity_provider: 'clerk',
    external_subject: identity.subject,
    email: 'old@example.test',
    full_name: 'Old Name',
  })}`;
  const response = await postOnboarding(identity, validPayload('Existing'));
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.membership.role, 'owner');
  const [state] = await admin`
    SELECT u.email, u.full_name, m.user_id, mr.assigned_by_membership_id, r.code,
      (SELECT count(*)::int FROM public.audit_logs a
        WHERE a.action = 'identity.user_provisioned_jit' AND a.actor_user_id = u.id) AS jit_audits
    FROM public.users u
    JOIN public.memberships m ON m.user_id = u.id
    JOIN public.membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
    JOIN public.roles r ON r.id = mr.role_id
    WHERE u.external_subject = ${identity.subject}
  `;
  assert.equal(state.email, 'old@example.test');
  assert.equal(state.full_name, 'Old Name');
  assert.equal(state.user_id, userId);
  assert.equal(state.assigned_by_membership_id, body.membership.id);
  assert.equal(state.code, 'owner');
  assert.equal(state.jit_audits, 0);
});

test('T13/V07: new identity and valid Unicode create exactly one complete tenant', async () => {
  const identity = addIdentity('unicode', { fullName: 'María 🚗' });
  const payload = validPayload('Águila 🚙');
  payload.primaryLocation.city = 'Bogotá D.C.';
  const response = await postOnboarding(identity, payload);
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.match(body.workshop.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}$/);
  assert.ok(body.workshop.slug.length <= 80);
  const [state] = await admin`
    SELECT
      (SELECT count(*)::int FROM public.workshops WHERE id = ${body.workshop.id}) AS workshops,
      (SELECT count(*)::int FROM public.workshop_locations WHERE tenant_id = ${body.workshop.id} AND is_primary) AS primary_locations,
      (SELECT count(*)::int FROM public.memberships WHERE tenant_id = ${body.workshop.id} AND status = 'active') AS memberships,
      (SELECT count(*)::int FROM public.membership_roles WHERE tenant_id = ${body.workshop.id}) AS roles,
      (SELECT timezone FROM public.workshops WHERE id = ${body.workshop.id}) AS timezone,
      (SELECT currency FROM public.workshops WHERE id = ${body.workshop.id}) AS currency,
      (SELECT country_code FROM public.workshop_locations
        WHERE tenant_id = ${body.workshop.id} AND is_primary) AS country_code
  `;
  assert.deepEqual(state, {
    workshops: 1,
    primary_locations: 1,
    memberships: 1,
    roles: 1,
    timezone: 'America/Bogota',
    currency: 'COP',
    country_code: 'CO',
  });
});

test('T14: a workshops_slug_key collision retries the complete transaction once', async () => {
  const collisionSlug = `collision-${randomUUID().slice(0, 12)}`;
  const existingTenant = randomUUID();
  await admin.begin(async (sql) => {
    await sql`SET LOCAL session_replication_role = replica`;
    await sql`INSERT INTO public.workshops ${sql({
      id: existingTenant,
      slug: collisionSlug,
      legal_name: 'Existing Collision Fixture',
      display_name: 'Existing Collision Fixture',
    })}`;
  });
  let calls = 0;
  const identity = addIdentity('slug-retry');
  const slugApp = await buildApi({
    database,
    identityProvider,
    rateLimit: { max: 100, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, {
        database,
        rateLimit: { max: 100, timeWindow: '1 minute' },
        slugFactory() {
          calls += 1;
          return calls === 1 ? collisionSlug : `${collisionSlug}-retry`;
        },
      });
    },
  });
  try {
    const response = await slugApp.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: auth(identity.token), payload: validPayload('Slug Retry'),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().workshop.slug, `${collisionSlug}-retry`);
    assert.equal(calls, 2);
    const [state] = await admin`
      SELECT
        (SELECT count(*)::int FROM public.users WHERE external_subject = ${identity.subject}) AS users,
        (SELECT count(*)::int FROM public.audit_logs WHERE action = 'identity.user_provisioned_jit'
          AND actor_user_id IN (SELECT id FROM public.users WHERE external_subject = ${identity.subject})) AS jit_audits
    `;
    assert.deepEqual(state, { users: 1, jit_audits: 1 });
  } finally {
    await slugApp.close();
  }
});

test('T15/V08: Clerk roles and metadata are ignored; PostgreSQL owner seed is authoritative', async () => {
  const identity = addIdentity('metadata');
  extraIdentityData.add(identity.subject);
  const response = await postOnboarding(identity, validPayload('Metadata'));
  assert.equal(response.statusCode, 201);
  const body = response.json();
  const roles = await admin`
    SELECT r.code
    FROM public.membership_roles mr JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.tenant_id = ${body.workshop.id}
  `;
  assert.deepEqual(roles.map((row) => row.code), ['owner']);
});

test('T16/T17: simultaneous onboarding for one identity creates at most one workshop', async () => {
  const identity = addIdentity('concurrent-onboarding');
  const [first, second] = await Promise.all([
    postOnboarding(identity, validPayload('Concurrent A')),
    postOnboarding(identity, validPayload('Concurrent B')),
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
  const conflict = first.statusCode === 409 ? first : second;
  assert.ok(['ONBOARDING_ALREADY_COMPLETED', 'ONBOARDING_IN_PROGRESS'].includes(conflict.json().error.code));
  const [state] = await admin`
    SELECT count(*)::int AS workshops
    FROM public.memberships m JOIN public.users u ON u.id = m.user_id
    WHERE u.external_subject = ${identity.subject} AND m.status = 'active'
  `;
  assert.equal(state.workshops, 1);
});

test('T18: a second completed onboarding returns ONBOARDING_ALREADY_COMPLETED', async () => {
  const identity = addIdentity('repeat');
  const first = await postOnboarding(identity, validPayload('Repeat'));
  assert.equal(first.statusCode, 201);
  const second = await postOnboarding(identity, validPayload('Repeat Again'));
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, 'ONBOARDING_ALREADY_COMPLETED');
});

test('T19/V09/V10/P6: tenant audit events share request context and contain no PII or headers', async () => {
  const identity = addIdentity('audit');
  const payload = validPayload('Audit Secret Name');
  const userAgent = `audit-agent/${'x'.repeat(600)}`;
  const response = await postOnboarding(identity, payload, {
    headers: { ...auth(identity.token), 'user-agent': userAgent, cookie: 'secret-cookie' },
    remoteAddress: '198.51.100.42',
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  const rows = await admin`
    SELECT action, actor_user_id, actor_membership_id, request_id,
      before_json, after_json, metadata_json, ip_address, user_agent
    FROM public.audit_logs
    WHERE tenant_id = ${body.workshop.id}
    ORDER BY action
  `;
  assert.deepEqual(rows.map((row) => row.action), ['membership.activated', 'role.assigned', 'workshop.created']);
  assert.ok(rows.every((row) => row.actor_membership_id === body.membership.id));
  assert.ok(rows.every((row) => row.request_id === body.request_id));
  assert.ok(rows.every((row) => row.ip_address === '198.51.100.42'));
  assert.ok(rows.every((row) => row.user_agent === userAgent.slice(0, 512)));
  const serialized = JSON.stringify(rows);
  for (const forbidden of [
    identity.subject,
    profilesBySubject.get(identity.subject).email,
    profilesBySubject.get(identity.subject).fullName,
    payload.workshop.legalName,
    payload.workshop.displayName,
    payload.workshop.taxId,
    payload.workshop.phone,
    payload.primaryLocation.addressLine,
    identity.token,
    'secret-cookie',
    'authorization',
  ]) assert.equal(serialized.includes(forbidden), false);
});

test('T20/V11: direct PostgreSQL RLS blocks cross-tenant reads and writes and missing context', async () => {
  const first = addIdentity('rls-a');
  const second = addIdentity('rls-b');
  const a = (await postOnboarding(first, validPayload('RLS A'))).json();
  const b = (await postOnboarding(second, validPayload('RLS B'))).json();

  const conn = await database.reserve();
  try {
    await conn.unsafe('BEGIN');
    await conn`SELECT set_config('app.tenant_id', ${a.workshop.id}, true)`;
    const hidden = await conn`SELECT id FROM public.workshops WHERE id = ${b.workshop.id}`;
    assert.equal(hidden.length, 0);
    const updated = await conn`UPDATE public.workshops SET display_name = 'tampered' WHERE id = ${b.workshop.id} RETURNING id`;
    assert.equal(updated.length, 0);
    await assert.rejects(
      conn`INSERT INTO public.workshop_locations ${conn({
        id: randomUUID(), tenant_id: b.workshop.id, name: 'X', address_line: 'X', city: 'X', department: 'X', is_primary: false,
      })}`,
      (error) => error.code === '42501',
    );
    await conn.unsafe('ROLLBACK');
  } finally {
    conn.release();
  }

  await assert.rejects(
    database`INSERT INTO public.workshops ${database({
      id: randomUUID(), slug: `no-context-${randomUUID()}`, legal_name: 'No Context', display_name: 'No Context',
    })}`,
    (error) => error.code === '42501',
  );
});

test('T21/V12: transaction-local app.* context does not leak after COMMIT or ROLLBACK', async () => {
  const singleDatabase = postgres(runtimeUrl, {
    max: 1, onnotice: () => {}, connection: { role: 'tallermecario_api' },
  });
  const commitIdentity = addIdentity('guc-commit');
  const rollbackIdentity = addIdentity('guc-rollback');
  const singleApp = await buildApi({
    database: singleDatabase,
    identityProvider,
    rateLimit: { max: 100, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database: singleDatabase, rateLimit: { max: 100, timeWindow: '1 minute' } });
    },
  });
  try {
    const committed = await singleApp.inject({
      method: 'POST', url: '/api/v1/onboarding/workshops', headers: auth(commitIdentity.token), payload: validPayload('GUC Commit'),
    });
    assert.equal(committed.statusCode, 201);
    let [setting] = await singleDatabase`SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant`;
    assert.equal(setting.tenant, null);

    const removeTrigger = await createFailureTrigger('memberships', 'guc_rollback');
    try {
      const rolledBack = await singleApp.inject({
        method: 'POST', url: '/api/v1/onboarding/workshops', headers: auth(rollbackIdentity.token), payload: validPayload('GUC Rollback'),
      });
      assert.equal(rolledBack.statusCode, 500);
    } finally {
      await removeTrigger();
    }
    [setting] = await singleDatabase`SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant`;
    assert.equal(setting.tenant, null);
  } finally {
    await singleApp.close();
    await singleDatabase.end({ timeout: 5 });
  }
});

test('T22: tenant routes still require an active membership', async () => {
  const identity = addIdentity('tenant-regression');
  const response = await app.inject({
    method: 'GET', url: '/api/v1/__test/tenant', headers: auth(identity.token),
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'ACTIVE_MEMBERSHIP_REQUIRED');
});

test('T23/V13: request IDs are globally shaped, unique across app instances and sanitized on 500', async () => {
  const secondApp = await buildApi({
    database,
    identityProvider,
    registerRoutes(server) {
      server.get('/api/v1/__test/request-id', async () => ({ ok: true }));
    },
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/api/v1/__test/tenant' });
    const second = await secondApp.inject({ method: 'GET', url: '/api/v1/__test/request-id' });
    const firstId = first.json().error.request_id;
    const secondId = second.json().error.request_id;
    assert.match(firstId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(secondId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(firstId, secondId);
    assert.equal(JSON.stringify(first.json()).includes('SQL'), false);
    assert.equal('stack' in first.json().error, false);
  } finally {
    await secondApp.close();
  }
});
