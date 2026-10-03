'use strict';

/**
 * S3 reception HTTP contract (docs/api/reception-contract.md), as wired in
 * src/api/server.ts: production privacy dependencies, no TEST-ONLY catalog.
 * Pins the route inventory, the notice/consent/acceptance reads that feed
 * privacyConsentId and documentVersion, and the published retry behavior.
 */
const { createHash, randomUUID } = require('node:crypto');
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
const { RECEPTION_ACCEPTANCE_TEXT, receptionAcceptanceDocument } = h.load('receptions/acceptance-document.js');
const { PRODUCTION_PRIVACY_DOCUMENT_CATALOG, PRODUCTION_PRIVACY_DOCUMENT_PRESENTATION } = h.load('privacy/catalog.js');
const { PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES } = h.load('privacy/consent-service.js');
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerCustomerRoutes(server);
      registerVehicleRoutes(server);
      registerPrivacyConsentRoutes(server);
      registerReceptionRoutes(server);
    },
  });
});
after(async () => h.closeAll(app));

const NOTICE_VERSION = 'privacy_notice_es-CO_v1';
const SERVICE_VERSION = 'service_provision_es-CO_v1';
const ACCEPTANCE_VERSION = 'reception_acceptance_es-CO_v1';
const ACCEPTANCE_SHA256 = '192829413c90bd0a1a58c9301274fa10c608da30e6c4b4c7f38174deea11125e';
const RECEPTION_KEYS = ['advisorNotes', 'appointmentId', 'closedAt', 'createdAt', 'customerId',
  'customerNotes', 'fuelLevelPct', 'locationId', 'mileageKm', 'receivedAt', 'receivedByMembershipId',
  'receptionId', 'status', 'updatedAt', 'vehicleId'];
const CONSENT_KEYS = ['authorizationTextVersion', 'capturedAt', 'channel', 'createdAt', 'customerId',
  'privacyConsentId', 'privacyNoticeVersion', 'purposeCode', 'status'];

const code = (r) => r.json?.error?.code;
const get = (actor, tenantId, url) => h.call(app, { subject: actor.subject, tenantId, url });
const send = (actor, tenantId, method, url, body, headers) => h.call(app, {
  subject: actor.subject, tenantId, method, url, body, headers,
});
const notice = (actor, tenantId, query = '?purposeCode=service_provision') =>
  get(actor, tenantId, `/api/v1/privacy-notice${query}`);
const granted = (actor, tenantId, customerId, query = '?status=granted') =>
  get(actor, tenantId, `/api/v1/customers/${customerId}/privacy-consents${query}`);
/** The capture body a client builds from GET /privacy-notice: versions echoed, nothing else. */
const captureFrom = (presented) => ({ purposeCode: presented.purposeCode,
  privacyNoticeVersion: presented.privacyNoticeVersion,
  authorizationTextVersion: presented.authorizationTextVersion,
  channel: 'in_person', adultAttestationConfirmed: true });
const capture = (actor, tenantId, customerId, body) =>
  send(actor, tenantId, 'POST', `/api/v1/customers/${customerId}/privacy-consents`, body);

async function customer(actor, tenantId) {
  const result = await h.createCustomer(app, actor, tenantId, h.validCustomer());
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.customer.customerId;
}
async function vehicle(actor, tenantId, customerId) {
  const result = await send(actor, tenantId, 'POST', '/api/v1/vehicles', { customerId,
    plate: `K${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    vehicleType: 'car', brand: 'Marca', model: 'Modelo' });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.vehicle.vehicleId;
}
async function signatureMedia(tenantId) {
  const media = randomUUID();
  await h.admin`INSERT INTO public.media_assets
    (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
    VALUES (${media},${tenantId},'test',${media},'signature','image/png',
      'active','authorization_evidence','v1')`;
  return media;
}
/** Revocation as the runtime API role performs it (no revoke route exists). */
const revoke = (tenantId, consentId) => h.asRuntime(h.apiPool, { tenantId },
  (tx) => tx.unsafe(p.REVOKE_SQL, [tenantId, consentId]));

test('route inventory: published reception/privacy routes exist; cancel, reopen and revoke do not', async () => {
  for (const [method, url] of [
    ['GET', '/api/v1/privacy-notice'],
    ['GET', '/api/v1/customers/:customerId/privacy-consents'],
    ['POST', '/api/v1/customers/:customerId/privacy-consents'],
    ['GET', '/api/v1/reception-acceptance-document'],
    ['POST', '/api/v1/receptions'],
    ['GET', '/api/v1/receptions'],
    ['GET', '/api/v1/receptions/:receptionId'],
    ['PATCH', '/api/v1/receptions/:receptionId'],
    ['POST', '/api/v1/receptions/:receptionId/signature'],
    ['POST', '/api/v1/receptions/:receptionId/close'],
  ]) assert.equal(app.hasRoute({ method, url }), true, `${method} ${url}`);
  for (const [method, url] of [
    ['POST', '/api/v1/receptions/:receptionId/cancel'],
    ['POST', '/api/v1/receptions/:receptionId/reopen'],
    ['DELETE', '/api/v1/receptions/:receptionId'],
    ['PUT', '/api/v1/receptions/:receptionId'],
    ['GET', '/api/v1/receptions/:receptionId/signature'],
    ['POST', '/api/v1/customers/:customerId/privacy-consents/:privacyConsentId/revoke'],
    ['GET', '/api/v1/privacy-notice-bundle'],
  ]) assert.equal(app.hasRoute({ method, url }), false, `${method} ${url}`);
  const { a } = await h.twoTenants();
  const cancel = await send(a.owner, a.tenantId, 'POST', `/api/v1/receptions/${randomUUID()}/cancel`);
  // Unmatched routes keep Fastify's default 404 body (no stable error envelope).
  assert.equal(cancel.status, 404);
});

test('GET /privacy-notice presents exact production v1 texts and the controller capture will snapshot', async () => {
  const { a } = await h.twoTenants();
  const unconfigured = await notice(a.owner, a.tenantId);
  assert.equal(unconfigured.status, 409);
  assert.equal(code(unconfigured), 'PRIVACY_NOTICE_NOT_CONFIGURED');
  await p.configureNotice(a.tenantId);
  const result = await notice(a.advisor, a.tenantId);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(result.json), ['privacyNotice']);
  const presented = result.json.privacyNotice;
  assert.deepEqual(Object.keys(presented).sort(), ['authorizationText', 'authorizationTextVersion',
    'controller', 'privacyNoticeText', 'privacyNoticeVersion', 'purposeCode']);
  const documents = PRODUCTION_PRIVACY_DOCUMENT_CATALOG.resolve('service_provision', NOTICE_VERSION, SERVICE_VERSION);
  assert.deepEqual({ ...presented, controller: undefined }, { purposeCode: 'service_provision',
    privacyNoticeVersion: NOTICE_VERSION, privacyNoticeText: documents.noticeText,
    authorizationTextVersion: SERVICE_VERSION, authorizationText: documents.authorizationText,
    controller: undefined });
  const [workshop] = await h.admin`SELECT legal_name FROM public.workshops WHERE id=${a.tenantId}`;
  assert.deepEqual(presented.controller, { legalName: workshop.legal_name,
    address: 'Calle 1 # 2-3, Bogotá, Bogotá D.C., CO', phone: '+5716000000',
    email: 'contacto@taller.test', rightsChannel: 'Correo electrónico: contacto@taller.test' });
  assert.doesNotMatch(JSON.stringify(result.json), /hash|snapshot|bundle/iu);
  assert.equal(presented.privacyNoticeVersion, PRODUCTION_PRIVACY_DOCUMENT_PRESENTATION.privacyNoticeVersion);
  assert.equal(presented.authorizationTextVersion,
    PRODUCTION_PRIVACY_DOCUMENT_PRESENTATION.authorizationTextVersions.service_provision);

  // The client echoes the presented versions; the stored snapshot equals what was shown.
  const c = await customer(a.owner, a.tenantId);
  const captured = await capture(a.advisor, a.tenantId, c, captureFrom(presented));
  assert.equal(captured.status, 201, JSON.stringify(captured.json));
  const [row] = await h.admin`SELECT controller_notice_snapshot FROM public.privacy_consents
    WHERE id=${captured.json.privacyConsent.privacyConsentId}`;
  assert.deepEqual(row.controller_notice_snapshot, presented.controller);

  const denied = await notice(a.technician, a.tenantId);
  assert.equal(denied.status, 403);
  assert.equal(code(denied), 'PERMISSION_DENIED');
  for (const query of ['', '?purposeCode=nope', '?purposeCode=service_provision&purposeCode=marketing',
    '?purposeCode=service_provision&locale=es', '?purposeCode=SERVICE_PROVISION']) {
    const bad = await notice(a.owner, a.tenantId, query);
    assert.equal(bad.status, 400, query);
    assert.equal(code(bad), 'REQUEST_VALIDATION_FAILED', query);
  }
  // Optional purposes have no published authorization: never a fallback text.
  for (const purpose of ['marketing', 'image_use', 'appointment_reminders', 'service_notifications_whatsapp']) {
    const unavailable = await notice(a.owner, a.tenantId, `?purposeCode=${purpose}`);
    assert.equal(unavailable.status, 409, purpose);
    assert.equal(code(unavailable), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE', purpose);
  }
});

test('GET granted consents is the source of an existing privacyConsentId (returning customer, revoke)', async () => {
  const { a, b } = await h.twoTenants();
  await p.configureNotice(a.tenantId);
  const c = await customer(a.owner, a.tenantId);
  const v1 = await vehicle(a.owner, a.tenantId, c);
  const v2 = await vehicle(a.owner, a.tenantId, c);
  const empty = await granted(a.advisor, a.tenantId, c);
  assert.equal(empty.status, 200, JSON.stringify(empty.json));
  assert.equal(empty.headers['cache-control'], 'no-store');
  assert.deepEqual(empty.json, { privacyConsents: [] });

  const presented = (await notice(a.owner, a.tenantId)).json.privacyNotice;
  const first = await capture(a.owner, a.tenantId, c, captureFrom(presented));
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const consent = first.json.privacyConsent;
  assert.deepEqual(Object.keys(consent).sort(), CONSENT_KEYS);
  // Lost response / second visit: capture is not repeatable; the list recovers the same id.
  const retry = await capture(a.owner, a.tenantId, c, captureFrom(presented));
  assert.equal(retry.status, 409);
  assert.equal(code(retry), 'PRIVACY_CONSENT_ALREADY_GRANTED');
  const listed = await granted(a.advisor, a.tenantId, c);
  assert.deepEqual(listed.json, { privacyConsents: [consent] });
  assert.deepEqual((await granted(a.owner, a.tenantId, c, '?status=granted&purposeCode=service_provision')).json,
    { privacyConsents: [consent] });
  assert.deepEqual((await granted(a.owner, a.tenantId, c, '?purposeCode=marketing&status=granted')).json,
    { privacyConsents: [] });
  const reception = await send(a.owner, a.tenantId, 'POST', '/api/v1/receptions',
    { vehicleId: v1, customerId: c, privacyConsentId: listed.json.privacyConsents[0].privacyConsentId, mileageKm: 10 });
  assert.equal(reception.status, 201, JSON.stringify(reception.json));

  // Revoked: the old id is no longer listed and cannot cover a new reception; a new capture can.
  await revoke(a.tenantId, consent.privacyConsentId);
  assert.deepEqual((await granted(a.owner, a.tenantId, c)).json, { privacyConsents: [] });
  const stale = await send(a.owner, a.tenantId, 'POST', '/api/v1/receptions',
    { vehicleId: v2, customerId: c, privacyConsentId: consent.privacyConsentId, mileageKm: 10 });
  assert.equal(stale.status, 409);
  assert.equal(code(stale), 'PRIVACY_CONSENT_NOT_ELIGIBLE');
  const renewed = await capture(a.owner, a.tenantId, c, captureFrom(presented));
  assert.equal(renewed.status, 201, JSON.stringify(renewed.json));
  assert.notEqual(renewed.json.privacyConsent.privacyConsentId, consent.privacyConsentId);
  assert.deepEqual((await granted(a.owner, a.tenantId, c)).json, { privacyConsents: [renewed.json.privacyConsent] });
  const covered = await send(a.owner, a.tenantId, 'POST', '/api/v1/receptions',
    { vehicleId: v2, customerId: c, privacyConsentId: renewed.json.privacyConsent.privacyConsentId, mileageKm: 10 });
  assert.equal(covered.status, 201, JSON.stringify(covered.json));
  // The earlier reception keeps its historical consent.
  const [historical] = await h.admin`SELECT privacy_consent_id FROM public.receptions
    WHERE id=${reception.json.reception.receptionId}`;
  assert.equal(historical.privacy_consent_id, consent.privacyConsentId);

  // Anti-oracle: absent, foreign and malformed customers share one 404.
  const foreignCustomer = await customer(b.owner, b.tenantId);
  const shapes = [];
  for (const id of [randomUUID(), foreignCustomer, 'not-a-uuid']) {
    const missing = await granted(a.owner, a.tenantId, id);
    assert.equal(code(missing), 'CUSTOMER_NOT_FOUND', id);
    shapes.push(h.errorShape(missing));
  }
  assert.equal(new Set(shapes).size, 1);
  assert.equal(code(await granted(b.owner, b.tenantId, c)), 'CUSTOMER_NOT_FOUND');
  const denied = await granted(a.technician, a.tenantId, c);
  assert.equal(denied.status, 403);
  assert.equal(code(denied), 'PERMISSION_DENIED');
  for (const query of ['', '?status=revoked', '?status=granted&status=granted', '?status=granted&limit=5',
    '?status=granted&purposeCode=nope', '?status=granted&purposeCode=service_provision&purposeCode=service_provision']) {
    const bad = await granted(a.owner, a.tenantId, c, query);
    assert.equal(bad.status, 400, query);
    assert.equal(code(bad), 'REQUEST_VALIDATION_FAILED', query);
  }
});

test('GET /reception-acceptance-document returns the pinned v1 text the signature echoes', async () => {
  const { a } = await h.twoTenants();
  const result = await get(a.advisor, a.tenantId, '/api/v1/reception-acceptance-document');
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.json, { acceptanceDocument: { documentVersion: ACCEPTANCE_VERSION,
    text: RECEPTION_ACCEPTANCE_TEXT } });
  assert.equal(createHash('sha256').update(result.json.acceptanceDocument.text, 'utf8').digest('hex'),
    ACCEPTANCE_SHA256);
  const canonical = receptionAcceptanceDocument(result.json.acceptanceDocument.documentVersion);
  assert.equal(result.json.acceptanceDocument.text, canonical.text);
  assert.equal(canonical.hash, ACCEPTANCE_SHA256);
  const denied = await get(a.technician, a.tenantId, '/api/v1/reception-acceptance-document');
  assert.equal(denied.status, 403);
  assert.equal(code(denied), 'PERMISSION_DENIED');
  const bad = await get(a.owner, a.tenantId, '/api/v1/reception-acceptance-document?version=v0');
  assert.equal(bad.status, 400);
  assert.equal(code(bad), 'REQUEST_VALIDATION_FAILED');
});

test('vertical slice with published retry outcomes: create, patch, sign, close', async () => {
  const { a } = await h.twoTenants();
  await p.configureNotice(a.tenantId);
  const c = await customer(a.advisor, a.tenantId);
  const v = await vehicle(a.advisor, a.tenantId, c);
  const presented = (await notice(a.advisor, a.tenantId)).json.privacyNotice;
  const consentId = (await capture(a.advisor, a.tenantId, c, captureFrom(presented))).json.privacyConsent.privacyConsentId;
  const createBody = { vehicleId: v, customerId: c, privacyConsentId: consentId, mileageKm: 5000 };

  // Idempotency-Key is not part of the contract: it changes nothing. The retry
  // is rejected by one-open-reception-per-vehicle and recovered via the list.
  const headers = { 'idempotency-key': randomUUID() };
  const created = await send(a.advisor, a.tenantId, 'POST', '/api/v1/receptions', createBody, headers);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.headers['cache-control'], 'no-store');
  const reception = created.json.reception;
  assert.deepEqual(Object.keys(reception).sort(), RECEPTION_KEYS);
  assert.equal(reception.status, 'open');
  assert.equal(reception.receivedByMembershipId, a.advisor.membershipId);
  const duplicate = await send(a.advisor, a.tenantId, 'POST', '/api/v1/receptions', createBody, headers);
  assert.equal(duplicate.status, 409);
  assert.equal(code(duplicate), 'RECEPTION_ALREADY_OPEN');
  const open = await get(a.advisor, a.tenantId, `/api/v1/receptions?vehicleId=${v}&status=open`);
  assert.deepEqual(open.json.receptions.map((r) => r.receptionId), [reception.receptionId]);
  assert.equal(open.json.nextCursor, null);

  // PATCH is OCC-guarded: replaying a committed PATCH reports a stale token.
  const patchBody = { expectedUpdatedAt: reception.updatedAt, fuelLevelPct: 40 };
  const url = `/api/v1/receptions/${reception.receptionId}`;
  const patched = await send(a.advisor, a.tenantId, 'PATCH', url, patchBody);
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.deepEqual(Object.keys(patched.json.reception).sort(), RECEPTION_KEYS);
  const replay = await send(a.advisor, a.tenantId, 'PATCH', url, patchBody);
  assert.equal(replay.status, 409);
  assert.equal(code(replay), 'RESOURCE_VERSION_CONFLICT');
  const detail = await get(a.advisor, a.tenantId, url);
  assert.equal(detail.json.reception.fuelLevelPct, 40);
  assert.equal(detail.json.reception.updatedAt, patched.json.reception.updatedAt);
  assert.equal(detail.json.reception.signature, null);
  assert.equal(detail.json.reception.serviceOrder, null);

  // Close needs a signature; a replayed signature is a stable 409.
  const early = await send(a.advisor, a.tenantId, 'POST', `${url}/close`);
  assert.equal(code(early), 'RECEPTION_SIGNATURE_REQUIRED');
  const documentVersion = (await get(a.advisor, a.tenantId, '/api/v1/reception-acceptance-document'))
    .json.acceptanceDocument.documentVersion;
  const signBody = { signatureMediaId: await signatureMedia(a.tenantId), signedByName: 'Cliente',
    documentVersion };
  const signed = await send(a.advisor, a.tenantId, 'POST', `${url}/signature`, signBody);
  assert.equal(signed.status, 201, JSON.stringify(signed.json));
  const [storedSignature] = await h.admin`SELECT document_version, document_hash,
      pg_catalog.to_char(signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS signed_at
    FROM public.signatures
    WHERE tenant_id=${a.tenantId} AND id=${signed.json.signature.signatureId}`;
  assert.equal(storedSignature.document_version, documentVersion);
  assert.equal(storedSignature.document_hash, receptionAcceptanceDocument(documentVersion).hash);
  const signedDetail = (await get(a.advisor, a.tenantId, url)).json.reception;
  assert.deepEqual(signedDetail.signature, { signatureId: signed.json.signature.signatureId,
    documentVersion, signedAt: storedSignature.signed_at });
  assert.equal(Date.parse(signedDetail.signature.signedAt), Date.parse(signed.json.signature.signedAt));
  assert.equal(signedDetail.serviceOrder, null);
  const resigned = await send(a.advisor, a.tenantId, 'POST', `${url}/signature`, signBody);
  assert.equal(resigned.status, 409);
  assert.equal(code(resigned), 'RECEPTION_ALREADY_SIGNED');

  // Close is idempotent: a retry returns the identical persisted result.
  const closed = await send(a.advisor, a.tenantId, 'POST', `${url}/close`);
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.deepEqual(Object.keys(closed.json).sort(), ['reception', 'serviceOrder']);
  assert.deepEqual(Object.keys(closed.json.reception).sort(), ['closedAt', 'id', 'status', 'updatedAt']);
  assert.deepEqual(Object.keys(closed.json.serviceOrder).sort(), ['customerId', 'id', 'openedAt',
    'orderNumber', 'receptionId', 'status', 'vehicleId', 'version']);
  const again = await send(a.advisor, a.tenantId, 'POST', `${url}/close`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, closed.json);
  const frozen = await send(a.advisor, a.tenantId, 'PATCH', url,
    { expectedUpdatedAt: closed.json.reception.updatedAt, fuelLevelPct: 10 });
  assert.equal(code(frozen), 'RECEPTION_NOT_EDITABLE');
  const reread = await get(a.advisor, a.tenantId, url);
  assert.equal(reread.json.reception.status, 'closed');
  assert.equal(reread.json.reception.closedAt, closed.json.reception.closedAt);
  assert.deepEqual(reread.json.reception.signature, signedDetail.signature);
  assert.deepEqual(reread.json.reception.serviceOrder, { id: closed.json.serviceOrder.id,
    orderNumber: closed.json.serviceOrder.orderNumber, status: closed.json.serviceOrder.status });
  assert.equal(typeof reread.json.reception.serviceOrder.orderNumber, 'string');
  // The vehicle can be received again once its reception is closed.
  const next = await send(a.advisor, a.tenantId, 'POST', '/api/v1/receptions', { ...createBody, mileageKm: 5100 });
  assert.equal(next.status, 201, JSON.stringify(next.json));
});


test('GET authorization and tenant selection precede malformed resource/query/body validation', async () => {
  const { a, b } = await h.twoTenants();
  for (const url of ['/api/v1/privacy-notice?extra=1',
    '/api/v1/customers/not-a-uuid/privacy-consents?status=nope',
    '/api/v1/reception-acceptance-document?version=x&version=x']) {
    const unauthenticated = await h.call(app, { tenantId: a.tenantId, url, rawBody: '{' });
    assert.equal(unauthenticated.status, 401, url);
    assert.equal(code(unauthenticated), 'AUTHENTICATION_REQUIRED');
    const foreign = await h.call(app, { subject: a.owner.subject, tenantId: b.tenantId, url });
    assert.equal(foreign.status, 403, url);
    assert.equal(code(foreign), 'TENANT_ACCESS_DENIED');
    const invalidTenant = await h.call(app, { subject: a.owner.subject, tenantId: 'bad', url });
    assert.equal(invalidTenant.status, 400, url);
    assert.equal(code(invalidTenant), 'TENANT_SELECTION_INVALID');
    const denied = await h.call(app, { subject: a.technician.subject, tenantId: a.tenantId,
      url, rawBody: '{' });
    assert.equal(denied.status, 403, url);
    assert.equal(code(denied), 'PERMISSION_DENIED');
  }
});

test('acceptance GET rejects bodies and every query key, including duplicate keys', async () => {
  const { a } = await h.twoTenants();
  for (const query of ['?version=v1', '?version=v1&version=v1', '?documentVersion=', '?purposeCode=service_provision']) {
    const result = await get(a.owner, a.tenantId, '/api/v1/reception-acceptance-document' + query);
    assert.equal(result.status, 400, query);
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  for (const rawBody of ['{}', 'null', '{', ' ']) {
    const result = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
      url: '/api/v1/reception-acceptance-document', rawBody });
    assert.equal(result.status, 400, rawBody);
    assert.equal(code(result), 'REQUEST_VALIDATION_FAILED');
  }
});

test('notice and capture fail closed together with current production controller requirements', async () => {
  const { a } = await h.twoTenants();
  const c = await customer(a.owner, a.tenantId);
  const valid = { purposeCode: 'service_provision', privacyNoticeVersion: NOTICE_VERSION,
    authorizationTextVersion: SERVICE_VERSION, channel: 'in_person', adultAttestationConfirmed: true };
  for (const config of [{ phone: null }, { email: null }, { email: 'invalid' }, { email: '   ' }]) {
    await p.configureNotice(a.tenantId, config);
    assert.equal(code(await notice(a.owner, a.tenantId)), 'PRIVACY_NOTICE_NOT_CONFIGURED');
    assert.equal(code(await capture(a.owner, a.tenantId, c, valid)), 'PRIVACY_NOTICE_NOT_CONFIGURED');
  }
  await p.configureNotice(a.tenantId, { phone: null, email: 'CONTACTO@TALLER.TEST' });
  await h.admin`UPDATE public.workshop_locations SET phone='+5716111111'
    WHERE tenant_id=${a.tenantId} AND is_primary=true`;
  const presented = (await notice(a.owner, a.tenantId)).json.privacyNotice;
  assert.equal(presented.controller.phone, '+5716111111');
  assert.equal(presented.controller.email, 'contacto@taller.test');
  assert.equal(presented.controller.rightsChannel, 'Correo electrónico: contacto@taller.test');
  const result = await capture(a.owner, a.tenantId, c, captureFrom(presented));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  const [evidence] = await h.admin`SELECT controller_notice_snapshot FROM public.privacy_consents
    WHERE tenant_id=${a.tenantId} AND id=${result.json.privacyConsent.privacyConsentId}`;
  assert.deepEqual(evidence.controller_notice_snapshot, presented.controller);
});

test('notice never infers a presentation from catalog entries or falls back from unpublished pointers', async () => {
  const { a } = await h.twoTenants();
  await p.configureNotice(a.tenantId);
  for (const presentation of [undefined,
    { privacyNoticeVersion: 'unpublished', authorizationTextVersions: { service_provision: SERVICE_VERSION } },
    { privacyNoticeVersion: NOTICE_VERSION, authorizationTextVersions: { service_provision: 'unpublished' } }]) {
    const isolated = await buildApi({ database: h.apiPool,
      identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
      rateLimit: { max: 100_000, timeWindow: '1 minute' },
      registerRoutes(server) { registerPrivacyConsentRoutes(server,
        { ...PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES, presentation }); },
    });
    try {
      const result = await h.call(isolated, { subject: a.owner.subject, tenantId: a.tenantId,
        url: '/api/v1/privacy-notice?purposeCode=service_provision' });
      assert.equal(result.status, 409);
      assert.equal(code(result), 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
    } finally { await isolated.close(); }
  }
});

test('notice controller and consent evidence stay tenant-local; foreign granted evidence cannot satisfy a lookup', async () => {
  const { a, b } = await h.twoTenants();
  await p.configureNotice(a.tenantId, { email: 'a@taller.test' });
  await p.configureNotice(b.tenantId, { email: 'b@taller.test' });
  const ca = await customer(a.owner, a.tenantId);
  const cb = await customer(b.owner, b.tenantId);
  const pa = (await notice(a.owner, a.tenantId)).json.privacyNotice;
  const pb = (await notice(b.owner, b.tenantId)).json.privacyNotice;
  assert.equal(pa.controller.email, 'a@taller.test');
  assert.equal(pb.controller.email, 'b@taller.test');
  const consent = await capture(b.owner, b.tenantId, cb, captureFrom(pb));
  assert.equal(consent.status, 201);
  assert.deepEqual((await granted(a.owner, a.tenantId, ca)).json, { privacyConsents: [] });
  assert.equal(code(await granted(a.owner, a.tenantId, cb)), 'CUSTOMER_NOT_FOUND');
  assert.deepEqual((await granted(b.owner, b.tenantId, cb)).json, { privacyConsents: [consent.json.privacyConsent] });
});

test('successful and rejected GETs leave domain rows and audit evidence unchanged', async () => {
  const { a } = await h.twoTenants();
  await p.configureNotice(a.tenantId);
  const c = await customer(a.owner, a.tenantId);
  const presented = (await notice(a.owner, a.tenantId)).json.privacyNotice;
  assert.equal((await capture(a.owner, a.tenantId, c, captureFrom(presented))).status, 201);
  async function snapshot() {
    const state = {};
    for (const table of ['customers', 'privacy_consents', 'receptions', 'signatures', 'media_assets',
      'service_orders', 'audit_logs', 'vehicles', 'vehicle_owners', 'workshop_locations']) {
      state[table] = await h.admin.unsafe('SELECT * FROM public.' + table + ' WHERE tenant_id=$1 ORDER BY id', [a.tenantId]);
    }
    return state;
  }
  const beforeReads = await snapshot();
  for (const url of ['/api/v1/privacy-notice?purposeCode=service_provision',
    '/api/v1/customers/' + c + '/privacy-consents?status=granted',
    '/api/v1/reception-acceptance-document']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await get(a.advisor, a.tenantId, url);
      assert.equal(result.status, 200, url);
      assert.equal(result.headers['cache-control'], 'no-store');
    }
    const rejected = await get(a.advisor, a.tenantId, url + (url.includes('?') ? '&' : '?') + 'unknown=1');
    assert.equal(rejected.status, 400);
  }
  assert.deepEqual(await snapshot(), beforeReads);
});


// FORCE RLS masks missing tenant predicates, so pin the application backstop too.
test('privacy reads retain explicit tenant predicates in addition to runtime FORCE RLS', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const source = readFileSync(join(process.env.TEST_MODULE_ROOT, 'privacy/consent-service.js'), 'utf8');
  assert.match(source, /WHERE c\.tenant_id = \$\{tenant\.tenantId\} AND c\.customer_id = \$\{customerId\}/u);
  assert.match(source, /WHERE tenant_id = \$\{tenant\.tenantId\} AND id = \$\{customerId\}/u);
  assert.match(source, /ON l\.tenant_id = w\.id AND l\.is_primary = true\s+WHERE w\.id = \$\{tenant\.tenantId\}/u);
});
