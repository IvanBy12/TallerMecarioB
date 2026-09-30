'use strict';

// S3-04.5 privacy consent capture (D-PRIV-02/04/05) through the real route.
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const p = require('./privacy-helpers.cjs');
const { f } = p;
const { assert } = h;
const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerPrivacyConsentRoutes } = h.load('privacy/routes.js');
const { capturePrivacyConsentFromBundle, mapPrivacyConsentDbError } = h.load('privacy/consent-service.js');
const { parseCapturePrivacyConsent } = h.load('privacy/validation.js');
const { computeAuthorizationTextHash } = h.load('privacy/canonical-text.js');
const { PrivacyNoticeBundleKeyRing, issuePrivacyNoticeBundle } = h.load('privacy/notice-bundle.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });

const keyRing = new PrivacyNoticeBundleKeyRing([{ version: 'v1', key: f.BUNDLE_KEY_V1 }]);
/** TEST-ONLY validity; ADR-005 (Sprint 13) owns the production policy. */
const OFFLINE = { catalog: f.catalog(), keyRing, now: () => new Date(),
  validity: ({ issuedAt, expiresAt, now }) => issuedAt <= now && now < expiresAt };
const OFFLINE_ROUTE = '/api/v1/__s3045/offline-consents/:customerId';
const build = (registerPrivacy) => buildApi({ database: h.apiPool, identityProvider: provider,
  rateLimit: { max: 100_000, timeWindow: '1 minute' },
  registerRoutes(server) {
    registerCustomerRoutes(server);
    registerVehicleRoutes(server);
    registerPrivacy(server);
    registerReceptionRoutes(server);
    // Test-only wiring of the offline primitive (no production sync route yet).
    server.post(OFFLINE_ROUTE, { config: { permission: 'privacy_consents.capture' } }, async (request, reply) => {
      const { bundle, ...rest } = request.body;
      const input = parseCapturePrivacyConsent(request.params.customerId, rest);
      try {
        const privacyConsent = await capturePrivacyConsentFromBundle(getTenantRequestContext(request), bundle,
          input, OFFLINE, { requestId: request.id, ipAddress: request.ip });
        return reply.code(201).send({ privacyConsent });
      } catch (error) { throw mapPrivacyConsentDbError(error) ?? error; }
    });
  },
});
let app, productionApp, noChannelApp;
before(async () => {
  app = await build(p.registerTestPrivacyRoutes);
  productionApp = await build((server) => registerPrivacyConsentRoutes(server));
  noChannelApp = await build((server) => registerPrivacyConsentRoutes(server,
    { catalog: f.catalog(), controllerNotice: { rightsChannel: () => null } }));
});
after(async () => {
  await productionApp?.close();
  await noChannelApp?.close();
  await h.closeAll(app);
});

const code = (response) => response.json?.error?.code;
async function customer(actor, tenantId) {
  const result = await h.createCustomer(app, actor, tenantId, h.validCustomer());
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.customer.customerId;
}
const consentRows = (customerId) => h.admin`SELECT * FROM public.privacy_consents
  WHERE customer_id=${customerId} ORDER BY created_at, id`;
const EXPECTED_SNAPSHOT = { legalName: 'Legal', address: 'Calle 1 # 2-3, Bogotá, Bogotá D.C., CO',
  phone: '+5716000000', email: 'contacto@taller.test', rightsChannel: f.RIGHTS_CHANNEL };
const hashWith = (snapshot, overrides = {}) => computeAuthorizationTextHash({ purposeCode: 'service_provision',
  privacyNoticeVersion: f.NOTICE_V1.version, authorizationTextVersion: f.SERVICE_V1.version,
  noticeText: f.NOTICE_V1.text, authorizationText: f.SERVICE_V1.text, snapshot, ...overrides });

test('capture: server computes hash and snapshot; minimal DTO; audit without evidence text', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.configureNotice(a.tenantId);
  let result;
  const output = await h.captureOutput(async () => {
    result = await p.capture(app, a.advisor, a.tenantId, c, p.captureBody());
  });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.headers['cache-control'], 'no-store');
  const dto = result.json.privacyConsent;
  assert.deepEqual(Object.keys(dto).sort(), ['authorizationTextVersion', 'capturedAt', 'channel', 'createdAt',
    'customerId', 'privacyConsentId', 'privacyNoticeVersion', 'purposeCode', 'status'].sort());
  assert.equal(dto.status, 'granted');
  assert.equal(dto.capturedAt, dto.createdAt, 'no declared capturedAt: server time');
  const [row] = await consentRows(c);
  assert.equal(row.tenant_id, a.tenantId);
  assert.equal(row.purpose_code, 'service_provision');
  assert.equal(row.privacy_notice_version, f.NOTICE_V1.version);
  assert.equal(row.authorization_text_version, f.SERVICE_V1.version);
  assert.deepEqual(row.controller_notice_snapshot, EXPECTED_SNAPSHOT);
  assert.equal(row.authorization_text_hash, hashWith(EXPECTED_SNAPSHOT));
  assert.equal(row.created_by_membership_id, a.advisor.membershipId);
  assert.equal(row.revoked_at, null);
  assert.equal(row.user_agent, null);
  assert.equal(row.evidence_media_id, null);
  const audits = await h.admin`SELECT action, entity_type, actor_membership_id, metadata_json, before_json, after_json
    FROM public.audit_logs WHERE entity_id=${dto.privacyConsentId}`;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'privacy_consent.captured');
  assert.equal(audits[0].entity_type, 'privacy_consent');
  assert.equal(audits[0].actor_membership_id, a.advisor.membershipId);
  assert.deepEqual(audits[0].metadata_json, { customer_id: c, purpose_code: 'service_provision',
    privacy_notice_version: f.NOTICE_V1.version, authorization_text_version: f.SERVICE_V1.version,
    channel: 'in_person' });
  const rendered = `${JSON.stringify(result.json)} ${JSON.stringify(audits)} ${output}`;
  for (const leak of [row.authorization_text_hash, f.NOTICE_V1.text, f.SERVICE_V1.text, f.RIGHTS_CHANNEL,
    'Calle 1 # 2-3']) assert.equal(rendered.includes(leak), false, leak);
});

test('capturedAt is declared evidence only; strict RFC 3339 with offset', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.configureNotice(a.tenantId);
  for (const bad of ['2026-02-30T10:00:00Z', '2026-09-29T10:00:00', '2026-09-29', 'yesterday', 12, '']) {
    const result = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({ capturedAt: bad }));
    assert.equal(result.status, 400, String(bad));
  }
  // A device clock far in the past is stored as declared, not used for ordering.
  const declared = await p.capture(app, a.owner, a.tenantId, c,
    p.captureBody({ capturedAt: '2020-01-02T03:04:05.123456-05:00' }));
  assert.equal(declared.status, 201, JSON.stringify(declared.json));
  assert.equal(declared.json.privacyConsent.capturedAt, '2020-01-02T08:04:05.123456Z');
  assert.notEqual(declared.json.privacyConsent.createdAt, declared.json.privacyConsent.capturedAt);
});

test('D-PRIV-04: adult attestation must be the literal true; absent/false create nothing', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.configureNotice(a.tenantId);
  const { adultAttestationConfirmed: _omit, ...missing } = p.captureBody();
  for (const payload of [missing, p.captureBody({ adultAttestationConfirmed: false }),
    p.captureBody({ adultAttestationConfirmed: 'true' }), p.captureBody({ adultAttestationConfirmed: 1 }),
    p.captureBody({ adultAttestationConfirmed: null })]) {
    const result = await p.capture(app, a.owner, a.tenantId, c, payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
  }
  assert.equal((await consentRows(c)).length, 0);
  // No date of birth nor a redundant attestation boolean is persisted.
  const columns = await h.admin`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('privacy_consents','customers')
      AND (column_name ILIKE '%adult%' OR column_name ILIKE '%birth%' OR column_name ILIKE '%dob%')`;
  assert.equal(columns.length, 0);
});

test('client cannot supply hash, snapshot, texts, bundle, tenant, status or timestamps', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.configureNotice(a.tenantId);
  for (const [key, value] of [
    ['authorizationTextHash', 'a'.repeat(64)], ['authorization_text_hash', 'a'.repeat(64)],
    ['controllerNoticeSnapshot', { ...f.SNAPSHOT }], ['noticeText', f.NOTICE_V1.text],
    ['authorizationText', f.SERVICE_V1.text], ['privacyNoticeBundle', 'x.y'], ['tenantId', a.tenantId],
    ['customerId', c], ['status', 'granted'], ['revokedAt', null], ['createdAt', '2026-01-01T00:00:00Z'],
    ['updatedAt', '2026-01-01T00:00:00Z'], ['createdByMembershipId', a.owner.membershipId],
  ]) {
    const result = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({ [key]: value }));
    assert.equal(result.status, 400, key);
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
  }
  for (const payload of [p.captureBody({ purposeCode: 'unknown' }), p.captureBody({ channel: 'fax' }),
    p.captureBody({ privacyNoticeVersion: 'bad version' }), p.captureBody({ authorizationTextVersion: '' }),
    p.captureBody({ purposeCode: null })]) {
    assert.equal((await p.capture(app, a.owner, a.tenantId, c, payload)).status, 400, JSON.stringify(payload));
  }
  const wrongType = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: `/api/v1/customers/${c}/privacy-consents`, rawBody: JSON.stringify(p.captureBody()),
    headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const oversized = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({ channel: 'x'.repeat(17000) }));
  assert.equal(oversized.status, 413);
  assert.equal((await consentRows(c)).length, 0);
});

test('fail closed: unpublished versions and the production catalog create nothing', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.configureNotice(a.tenantId);
  for (const payload of [p.captureBody({ privacyNoticeVersion: 'test-notice-9' }),
    p.captureBody({ authorizationTextVersion: 'test-service-9' }),
    p.captureBody({ purposeCode: 'marketing' }),
    p.captureBody({ authorizationTextVersion: 'current' })]) {
    const result = await p.capture(app, a.owner, a.tenantId, c, payload);
    assert.equal(result.status, 409, JSON.stringify(payload));
    assert.equal(code(result), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  }
  // CANONICAL_PRIVACY_COPY_NOT_PUBLISHED: production publishes no version at all.
  const production = await p.capture(productionApp, a.owner, a.tenantId, c, p.captureBody());
  assert.equal(production.status, 409);
  assert.equal(code(production), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  assert.equal((await consentRows(c)).length, 0);
});

test('workshop without a complete privacy notice cannot capture consent nor create receptions', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  // createWorkshop fixture: no primary location, no phone/email.
  const noLocation = await p.capture(app, a.owner, a.tenantId, c, p.captureBody());
  assert.equal(noLocation.status, 409);
  assert.equal(code(noLocation), 'PRIVACY_NOTICE_NOT_CONFIGURED');
  await p.configureNotice(a.tenantId, { phone: null, email: null });
  const noContact = await p.capture(app, a.owner, a.tenantId, c, p.captureBody());
  assert.equal(code(noContact), 'PRIVACY_NOTICE_NOT_CONFIGURED');
  await p.configureNotice(a.tenantId);
  const noRightsChannel = await p.capture(noChannelApp, a.owner, a.tenantId, c, p.captureBody());
  assert.equal(code(noRightsChannel), 'PRIVACY_NOTICE_NOT_CONFIGURED');
  assert.equal((await consentRows(c)).length, 0);
  const vehicle = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: '/api/v1/vehicles', body: { customerId: c, plate: `N${randomUUID().slice(0, 8).toUpperCase()}`,
      vehicleType: 'car', brand: 'B', model: 'M' } });
  const reception = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: '/api/v1/receptions', body: { vehicleId: vehicle.json.vehicle.vehicleId, customerId: c,
      privacyConsentId: randomUUID(), mileageKm: 1 } });
  assert.equal(reception.status, 404);
  assert.equal(code(reception), 'PRIVACY_CONSENT_NOT_FOUND');
});

test('one granted consent per purpose; other purposes are separate rows', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  await p.serviceConsent(app, a.owner, a.tenantId, c);
  const again = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({
    authorizationTextVersion: f.SERVICE_V2.version }));
  assert.equal(again.status, 409);
  assert.equal(code(again), 'PRIVACY_CONSENT_ALREADY_GRANTED');
  const marketing = await p.capture(app, a.owner, a.tenantId, c, p.captureBody({
    purposeCode: 'marketing', authorizationTextVersion: f.MARKETING_V1.version, channel: 'web' }));
  assert.equal(marketing.status, 201);
  assert.equal(mapPrivacyConsentDbError({ code: '23505', constraint_name: 'other' }), null);
  assert.equal(mapPrivacyConsentDbError({ code: '23503', constraint_name: 'privacy_consents_customer_fk' }).code,
    'CUSTOMER_NOT_FOUND');
});

test('customer anti-oracle and RBAC: foreign/absent/malformed share 404; technician denied', async () => {
  const { a, b } = await h.twoTenants();
  const own = await customer(a.owner, a.tenantId);
  const foreign = (await h.createCustomer(app, b.owner, b.tenantId, h.validCustomer())).json.customer.customerId;
  await p.configureNotice(a.tenantId);
  const shapes = [];
  for (const target of [foreign, randomUUID(), 'not-a-uuid']) {
    const result = await p.capture(app, a.owner, a.tenantId, target, p.captureBody());
    assert.equal(result.status, 404);
    assert.equal(code(result), 'CUSTOMER_NOT_FOUND');
    shapes.push(h.errorShape(result));
  }
  assert.equal(new Set(shapes).size, 1);
  assert.equal((await consentRows(foreign)).length, 0);
  const denied = await p.capture(app, a.technician, a.tenantId, own, p.captureBody());
  assert.equal(denied.status, 403);
  assert.equal(code(denied), 'PERMISSION_DENIED');
  const unauth = await p.capture(app, null, a.tenantId, own, p.captureBody());
  assert.equal(unauth.status, 401);
  for (const actor of [a.owner, a.admin, a.advisor]) {
    const target = await customer(a.owner, a.tenantId);
    assert.equal((await p.capture(app, actor, a.tenantId, target, p.captureBody())).status, 201);
  }
});

test('snapshot is retained verbatim after the workshop changes; hash is reconstructible', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const id = await p.serviceConsent(app, a.owner, a.tenantId, c);
  await h.admin.begin(async (tx) => {
    await tx`UPDATE public.workshops SET legal_name='Nuevo Legal', phone='+5749999999', email=NULL
      WHERE id=${a.tenantId}`;
    await tx`UPDATE public.workshop_locations SET address_line='Carrera 99 # 1-1', city='Medellín'
      WHERE tenant_id=${a.tenantId} AND is_primary`;
  });
  const [row] = await h.admin`SELECT controller_notice_snapshot, authorization_text_hash
    FROM public.privacy_consents WHERE id=${id}`;
  assert.deepEqual(row.controller_notice_snapshot, EXPECTED_SNAPSHOT);
  // Versions + catalog texts + retained snapshot rebuild the exact hash.
  const catalogTexts = f.catalog().resolve('service_provision', f.NOTICE_V1.version, f.SERVICE_V1.version);
  assert.equal(computeAuthorizationTextHash({ purposeCode: 'service_provision',
    privacyNoticeVersion: f.NOTICE_V1.version, authorizationTextVersion: f.SERVICE_V1.version,
    ...catalogTexts, snapshot: row.controller_notice_snapshot }), row.authorization_text_hash);
  assert.notEqual(hashWith({ ...EXPECTED_SNAPSHOT, legalName: 'Nuevo Legal' }), row.authorization_text_hash);
  // A capture after the change uses the then-current notice.
  const other = await customer(a.owner, a.tenantId);
  const later = await p.capture(app, a.owner, a.tenantId, other, p.captureBody());
  const [laterRow] = await h.admin`SELECT controller_notice_snapshot FROM public.privacy_consents
    WHERE id=${later.json.privacyConsent.privacyConsentId}`;
  assert.deepEqual(laterRow.controller_notice_snapshot, { legalName: 'Nuevo Legal',
    address: 'Carrera 99 # 1-1, Medellín, Bogotá D.C., CO', phone: '+5749999999', email: null,
    rightsChannel: f.RIGHTS_CHANNEL });
});

test('offline primitive: authenticated bundle snapshot wins over the current workshop', async () => {
  const { a, b } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const issued = new Date(Date.now() - 60_000);
  const bundleFor = (tenantId, snapshot = f.SNAPSHOT) => issuePrivacyNoticeBundle({ keyRing, keyVersion: 'v1',
    catalog: OFFLINE.catalog, tenantId, privacyNoticeVersion: f.NOTICE_V1.version,
    authorizations: [{ purposeCode: 'service_provision', authorizationTextVersion: f.SERVICE_V1.version }],
    controllerNoticeSnapshot: snapshot, issuedAt: issued, expiresAt: new Date(Date.now() + 3_600_000) });
  // The current workshop differs from the snapshot shown offline.
  await p.configureNotice(a.tenantId, { phone: '+5749999999' });
  const sync = (bundle, extra = {}) => h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
    method: 'POST', url: OFFLINE_ROUTE.replace(':customerId', c),
    body: { bundle, ...p.captureBody({ capturedAt: '2026-09-29T08:00:00Z', channel: 'in_person' }), ...extra } });
  const [payload, mac] = bundleFor(a.tenantId).split('.');
  const tamperedBytes = Buffer.from(payload, 'base64url');
  tamperedBytes[20] ^= 0x01;
  for (const bad of [bundleFor(b.tenantId), `${tamperedBytes.toString('base64url')}.${mac}`, 'x.y', null]) {
    const rejected = await sync(bad);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.json));
    assert.equal(code(rejected), 'PRIVACY_NOTICE_BUNDLE_INVALID');
    assert.equal(JSON.stringify(rejected.json).includes(payload.slice(0, 20)), false);
  }
  const wrongVersion = await sync(bundleFor(a.tenantId), { authorizationTextVersion: f.SERVICE_V2.version });
  assert.equal(code(wrongVersion), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  assert.equal((await consentRows(c)).length, 0);
  const accepted = await sync(bundleFor(a.tenantId));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
  const [row] = await consentRows(c);
  assert.deepEqual(row.controller_notice_snapshot, { ...f.SNAPSHOT });
  assert.equal(row.authorization_text_hash, hashWith(f.SNAPSHOT));
  assert.notEqual(row.authorization_text_hash, hashWith({ ...EXPECTED_SNAPSHOT, phone: '+5749999999' }));
  assert.equal(accepted.json.privacyConsent.capturedAt, '2026-09-29T08:00:00.000000Z');
});
