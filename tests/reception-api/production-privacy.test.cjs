'use strict';

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const p = require('./privacy-helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerPrivacyConsentRoutes } = h.load('privacy/routes.js');
const { PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES } = h.load('privacy/consent-service.js');
const { computeAuthorizationTextHash } = h.load('privacy/canonical-text.js');
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerCustomerRoutes(server);
      registerVehicleRoutes(server);
      registerPrivacyConsentRoutes(server, PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES);
      registerReceptionRoutes(server);
    },
  });
});
after(async () => h.closeAll(app));
const body = (extra = {}) => ({ purposeCode: 'service_provision',
  privacyNoticeVersion: 'privacy_notice_es-CO_v1', authorizationTextVersion: 'service_provision_es-CO_v1',
  channel: 'in_person', adultAttestationConfirmed: true, ...extra });
const code = (r) => r.json?.error?.code;
async function scenario() {
  const { a } = await h.twoTenants();
  const c = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
  assert.equal(c.status, 201);
  return { a, c: c.json.customer.customerId };
}
const capture = (a, c, extra = {}) => p.capture(app, a.owner, a.tenantId, c, body(extra));
const rows = async (c) => Array.from(await h.admin`SELECT * FROM public.privacy_consents WHERE customer_id=${c}`);

test('production consent and reception retain exact server-owned v1 evidence after controller changes', async () => {
  const { a, c } = await scenario();
  await p.configureNotice(a.tenantId, { email: '  CONTACTO@TALLER.TEST  ' });
  const result = await capture(a, c);
  assert.equal(result.status, 201, JSON.stringify(result.json));
  const [evidence] = await rows(c);
  const [workshop] = await h.admin`SELECT legal_name FROM public.workshops WHERE id=${a.tenantId}`;
  assert.equal(evidence.tenant_id, a.tenantId);
  assert.equal(evidence.purpose_code, 'service_provision');
  assert.equal(evidence.privacy_notice_version, body().privacyNoticeVersion);
  assert.equal(evidence.authorization_text_version, body().authorizationTextVersion);
  assert.match(evidence.authorization_text_hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(evidence.controller_notice_snapshot, { legalName: workshop.legal_name,
    address: 'Calle 1 # 2-3, Bogotá, Bogotá D.C., CO', phone: '+5716000000', email: 'contacto@taller.test',
    rightsChannel: 'Correo electrónico: contacto@taller.test' });
  const hashInput = { purposeCode: 'service_provision', privacyNoticeVersion: body().privacyNoticeVersion,
    authorizationTextVersion: body().authorizationTextVersion,
    ...PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES.catalog.resolve('service_provision',
      body().privacyNoticeVersion, body().authorizationTextVersion), snapshot: evidence.controller_notice_snapshot };
  assert.equal(computeAuthorizationTextHash(hashInput), evidence.authorization_text_hash);
  for (const field of ['purposeCode', 'privacyNoticeVersion', 'authorizationTextVersion', 'noticeText', 'authorizationText'])
    assert.notEqual(computeAuthorizationTextHash({ ...hashInput, [field]: `${hashInput[field]}x` }), evidence.authorization_text_hash);
  for (const field of Object.keys(hashInput.snapshot))
    assert.notEqual(computeAuthorizationTextHash({ ...hashInput,
      snapshot: { ...hashInput.snapshot, [field]: `${hashInput.snapshot[field]}x` } }), evidence.authorization_text_hash);
  const vehicle = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: '/api/v1/vehicles', body: { customerId: c, plate: `P${randomUUID().slice(0, 8).toUpperCase()}`,
      vehicleType: 'car', brand: 'B', model: 'M' } });
  assert.equal(vehicle.status, 201, JSON.stringify(vehicle.json));
  await h.admin`UPDATE public.workshops SET legal_name='Nuevo Responsable', email=NULL, phone=NULL WHERE id=${a.tenantId}`;
  const reception = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
    url: '/api/v1/receptions', body: { vehicleId: vehicle.json.vehicle.vehicleId, customerId: c,
      privacyConsentId: evidence.id, mileageKm: 1 } });
  assert.equal(reception.status, 201, JSON.stringify(reception.json));
  const [persisted] = await h.admin`SELECT privacy_consent_id FROM public.receptions
    WHERE tenant_id=${a.tenantId} AND vehicle_id=${vehicle.json.vehicle.vehicleId}`;
  assert.equal(persisted.privacy_consent_id, evidence.id);
  assert.deepEqual(await rows(c), [evidence]);
  await assert.rejects(h.admin`UPDATE public.privacy_consents SET authorization_text_hash=${'a'.repeat(64)}
    WHERE id=${evidence.id}`, (e) => e.code === '23514');
  await assert.rejects(h.admin`UPDATE public.privacy_consents SET controller_notice_snapshot=${h.admin.json({
    ...evidence.controller_notice_snapshot, legalName: 'Changed' })} WHERE id=${evidence.id}`,
  (e) => e.code === '23514');
  assert.deepEqual(await rows(c), [evidence]);
});

test('production controller configuration fails closed for absent, blank or invalid required data', async () => {
  const { a, c } = await scenario();
  assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', 'no primary location');
  const locationId = await p.configureNotice(a.tenantId);
  for (const email of [null, '', '   ', 'invalid', 'a@b', 'a\u202e@b.test']) {
    await h.admin`UPDATE public.workshops SET email=${email} WHERE id=${a.tenantId}`;
    assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', String(email));
  }
  await p.configureNotice(a.tenantId, { phone: null });
  assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', 'email only');
  await h.admin`UPDATE public.workshops SET phone='   ' WHERE id=${a.tenantId}`;
  assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', 'blank phone');
  await p.configureNotice(a.tenantId);
  await h.admin`UPDATE public.workshops SET legal_name=' ' WHERE id=${a.tenantId}`;
  assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', 'blank legal name');
  await h.admin`UPDATE public.workshops SET legal_name='Taller Legal' WHERE id=${a.tenantId}`;
  await h.admin`UPDATE public.workshop_locations SET address_line=' ' WHERE id=${locationId}`;
  assert.equal(code(await capture(a, c)), 'PRIVACY_NOTICE_NOT_CONFIGURED', 'blank address');
  assert.deepEqual(await rows(c), []);
});

test('production accepts primary location phone when workshop phone is absent', async () => {
  const { a, c } = await scenario();
  const locationId = await p.configureNotice(a.tenantId, { phone: null });
  await h.admin`UPDATE public.workshop_locations SET phone='+5717000000' WHERE id=${locationId}`;
  assert.equal((await capture(a, c)).status, 201);
  assert.equal((await rows(c))[0].controller_notice_snapshot.phone, '+5717000000');
});

test('production rejects wrong versions, optional purposes, missing adult attestation and client evidence', async () => {
  const { a, c } = await scenario();
  await p.configureNotice(a.tenantId);
  for (const extra of [{ privacyNoticeVersion: 'unknown' }, { authorizationTextVersion: 'unknown' },
    { privacyNoticeVersion: 'latest' }, { authorizationTextVersion: 'current' },
    ...['marketing', 'image_use', 'appointment_reminders', 'service_notifications_whatsapp'].map((purposeCode) => ({ purposeCode }))])
    assert.equal(code(await capture(a, c, extra)), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  for (const adultAttestationConfirmed of [undefined, null, false, 'true', 1])
    assert.equal(code(await capture(a, c, { adultAttestationConfirmed })), 'REQUEST_VALIDATION_FAILED');
  for (const field of ['noticeText', 'authorizationText', 'authorizationTextHash', 'authorization_text_hash',
    'controllerNoticeSnapshot', 'controller_notice_snapshot', 'rightsChannel', 'tenant', 'tenantId', 'status'])
    assert.equal(code(await capture(a, c, { [field]: 'client-owned' })), 'REQUEST_VALIDATION_FAILED', field);
  assert.deepEqual(await rows(c), []);
  assert.equal((await capture(a, c)).status, 201);
  assert.deepEqual((await rows(c)).map((r) => r.purpose_code), ['service_provision']);
});
