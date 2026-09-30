'use strict';

// Test-only fixtures in a disposable staging database. All reception mutations
// use deployed HTTP routes; production privacy dependencies remain unchanged.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { sessionToken } = require('./staging-crm-e2e.cjs');
const privacy = require('../tests/privacy/fixtures.cjs');

const staffFields = ['receptionId', 'vehicleId', 'customerId', 'appointmentId', 'locationId',
  'receivedByMembershipId', 'mileageKm', 'fuelLevelPct', 'customerNotes', 'advisorNotes',
  'status', 'receivedAt', 'closedAt', 'createdAt', 'updatedAt', 'checklist', 'damages'].sort();
const listFields = ['receptionId', 'vehicleId', 'customerId', 'mileageKm', 'fuelLevelPct',
  'status', 'receivedAt', 'closedAt', 'updatedAt'].sort();

async function readReceptionSnapshot(admin, tenantId, receptionId, vehicleId) {
  const receptions = await admin`SELECT to_jsonb(r) AS row FROM public.receptions r
    WHERE tenant_id=${tenantId} AND id=${receptionId} ORDER BY id`;
  const signatures = await admin`SELECT to_jsonb(s) AS row FROM public.signatures s
    WHERE tenant_id=${tenantId} AND reception_id=${receptionId} ORDER BY id`;
  const orders = await admin`SELECT to_jsonb(o) AS row FROM public.service_orders o
    WHERE tenant_id=${tenantId} AND reception_id=${receptionId} ORDER BY id`;
  const history = await admin`SELECT to_jsonb(h) AS row FROM public.order_status_history h
    WHERE h.tenant_id=${tenantId} AND h.order_id IN
      (SELECT id FROM public.service_orders WHERE tenant_id=${tenantId}
        AND reception_id=${receptionId}) ORDER BY h.id`;
  const audits = await admin`SELECT to_jsonb(a) AS row FROM public.audit_logs a
    WHERE tenant_id=${tenantId} AND entity_id=${receptionId} ORDER BY id`;
  const vehicles = await admin`SELECT to_jsonb(v) AS row FROM public.vehicles v
    WHERE tenant_id=${tenantId} AND id=${vehicleId} ORDER BY id`;
  return JSON.stringify({ receptions, signatures, orders, history, audits, vehicles });
}

async function runReceptionE2e(admin, baseUrl, identity, tenants, vehicleId, fetcher = fetch) {
  const { a, b } = tenants;
  const tokens = new Map([a.advisor, a.technician, b.advisor]
    .map((actor) => [actor, sessionToken(actor, identity)]));
  const customerNotes = 'StagePrivateS3CustomerNotes';
  const advisorNotes = 'StagePrivateS3AdvisorNotes';
  const patchedNotes = 'StagePrivateS3UpdatedAdvisorNotes';
  const signer = 'StagePrivateS3Signer';
  const document = 'StagePrivateS3Document';
  const sentinels = [customerNotes, advisorNotes, patchedNotes, signer, document,
    privacy.NOTICE_V1.text, privacy.SERVICE_V1.text, privacy.FIXTURE_HASH,
    JSON.stringify(privacy.SNAPSHOT), privacy.RIGHTS_CHANNEL, ...tokens.values()];
  const errors = [];
  const requests = [];
  async function request(actor, tenantId, method, route, body, status, errorCode) {
    const response = await fetcher(`${baseUrl}${route}`, {
      method, signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${tokens.get(actor)}`, 'x-tenant-id': tenantId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    assert.equal(response.status, status, `${method} reception route status`);
    if (status < 400) assert.equal(response.headers.get('cache-control'), 'no-store');
    const item = { actor, tenantId, method, status, requestId: json.error?.request_id };
    requests.push(item);
    if (errorCode) {
      assert.equal(json.error?.code, errorCode);
      errors.push({ requestId: item.requestId, method, status, code: errorCode });
    }
    return json;
  }

  const [owner] = await admin`SELECT customer_id FROM public.vehicle_owners
    WHERE tenant_id=${a.tenantId} AND vehicle_id=${vehicleId} AND is_primary AND valid_to IS NULL`;
  assert.ok(owner, 'CRM fixture has a current primary owner');
  const customerId = owner.customer_id;
  const consentRoute = `/api/v1/customers/${customerId}/privacy-consents`;
  const consentBody = { purposeCode: 'service_provision', privacyNoticeVersion: privacy.NOTICE_V1.version,
    authorizationTextVersion: privacy.SERVICE_V1.version, channel: 'in_person',
    adultAttestationConfirmed: true };
  await request(a.advisor, a.tenantId, 'POST', consentRoute, consentBody,
    409, 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  const [beforeConsent] = await admin`SELECT count(*)::int AS n FROM public.privacy_consents
    WHERE tenant_id=${a.tenantId} AND customer_id=${customerId}`;
  assert.equal(beforeConsent.n, 0, 'production capture remains fail-closed without evidence');

  const consentId = randomUUID();
  const mediaId = randomUUID();
  // Explicit DB fixture evidence, never a published catalog or a signature.
  // All guards and RLS policies stay enabled throughout the deployed flow.
  await admin.begin(async (tx) => {
    await tx`INSERT INTO public.privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
        authorization_text_hash,channel,captured_at,controller_notice_snapshot)
      VALUES (${consentId},${a.tenantId},${customerId},'service_provision',${privacy.NOTICE_V1.version},
        ${privacy.SERVICE_V1.version},${privacy.FIXTURE_HASH},'in_person',now(),${tx.json(privacy.SNAPSHOT)})`;
    await tx`INSERT INTO public.media_assets
      (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES (${mediaId},${a.tenantId},'test-only-staging',${`test-only/${mediaId}`},'signature','image/png',
        'active','authorization_evidence','test-only-v1')`;
  });
  const createBody = { vehicleId, customerId, privacyConsentId: consentId,
    mileageKm: 1234, fuelLevelPct: 40, customerNotes, advisorNotes };
  await request(b.advisor, b.tenantId, 'POST', '/api/v1/receptions', createBody,
    404, 'VEHICLE_NOT_FOUND');
  const created = (await request(a.advisor, a.tenantId, 'POST', '/api/v1/receptions',
    { ...createBody, privacyConsentId: randomUUID() }, 404, 'PRIVACY_CONSENT_NOT_FOUND'));
  assert.ok(created.error);
  const reception = (await request(a.advisor, a.tenantId, 'POST', '/api/v1/receptions',
    createBody, 201)).reception;
  assert.equal(reception.status, 'open');
  assert.equal(reception.vehicleId, vehicleId);
  assert.equal(reception.customerId, customerId);
  assert.equal(reception.receivedByMembershipId, a.advisor.membershipId);
  assert.equal(reception.mileageKm, 1234);
  assert.equal(reception.fuelLevelPct, 40);
  const route = `/api/v1/receptions/${reception.receptionId}`;
  const patchBody = { expectedUpdatedAt: reception.updatedAt, mileageKm: 2345,
    fuelLevelPct: 60, advisorNotes: patchedNotes };
  await request(b.advisor, b.tenantId, 'PATCH', route, patchBody, 404, 'RECEPTION_NOT_FOUND');
  const patched = (await request(a.advisor, a.tenantId, 'PATCH', route, patchBody, 200)).reception;
  assert.ok(patched.updatedAt > reception.updatedAt, 'OCC token advances at microsecond precision');
  assert.equal(patched.mileageKm, 2345);
  assert.equal(patched.advisorNotes, patchedNotes);
  await request(a.advisor, a.tenantId, 'PATCH', route, patchBody, 409, 'RESOURCE_VERSION_CONFLICT');
  const signed = (await request(a.advisor, a.tenantId, 'POST', `${route}/signature`, {
    signatureMediaId: mediaId, signedByName: signer, signedByDocument: document,
    documentVersion: 'reception_acceptance_es-CO_v1',
  }, 201)).signature;
  assert.equal(signed.receptionId, reception.receptionId);
  assert.equal(signed.signatureMediaId, mediaId);
  const closed = await request(a.advisor, a.tenantId, 'POST', `${route}/close`, undefined, 200);
  assert.equal(closed.reception.status, 'closed');
  assert.equal(closed.serviceOrder.receptionId, reception.receptionId);
  assert.equal(closed.serviceOrder.vehicleId, vehicleId);
  assert.equal(closed.serviceOrder.customerId, customerId);
  assert.equal(closed.serviceOrder.status, 'reception');
  assert.equal(closed.serviceOrder.version, 1);
  const detail = (await request(a.advisor, a.tenantId, 'GET', route, undefined, 200)).reception;
  assert.deepEqual(Object.keys(detail).sort(), staffFields);
  assert.equal(detail.status, 'closed');
  assert.equal(detail.customerNotes, customerNotes);
  assert.equal(detail.advisorNotes, patchedNotes);
  assert.equal(detail.mileageKm, 2345);
  assert.equal(detail.fuelLevelPct, 60);
  const queryRoute = `/api/v1/receptions?status=closed&vehicleId=${vehicleId}`;
  sentinels.push(queryRoute, encodeURIComponent(customerNotes), encodeURIComponent(document));
  const listed = await request(a.advisor, a.tenantId, 'GET', queryRoute, undefined, 200);
  assert.equal(listed.receptions.length, 1);
  assert.equal(listed.receptions[0].receptionId, reception.receptionId);
  assert.deepEqual(Object.keys(listed.receptions[0]).sort(), listFields);
  await request(b.advisor, b.tenantId, 'GET', route, undefined, 404, 'RECEPTION_NOT_FOUND');
  const foreignList = await request(b.advisor, b.tenantId, 'GET', '/api/v1/receptions', undefined, 200);
  assert.equal(foreignList.receptions.some((row) => row.receptionId === reception.receptionId), false);
  await request(a.technician, a.tenantId, 'GET', '/api/v1/receptions', undefined, 403, 'PERMISSION_DENIED');

  const snapshot = await readReceptionSnapshot(admin, a.tenantId, reception.receptionId, vehicleId);
  const state = JSON.parse(snapshot);
  assert.equal(state.receptions.length, 1);
  assert.equal(state.receptions[0].row.privacy_consent_id, consentId);
  assert.equal(state.receptions[0].row.received_by_membership_id, a.advisor.membershipId);
  assert.equal(state.receptions[0].row.status, 'closed');
  assert.equal(state.signatures.length, 1);
  assert.equal(state.signatures[0].row.id, signed.signatureId);
  assert.equal(state.signatures[0].row.signature_media_id, mediaId);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0].row.id, closed.serviceOrder.id);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].row.from_status, null);
  assert.equal(state.history[0].row.to_status, 'reception');
  assert.equal(state.history[0].row.changed_by_membership_id, a.advisor.membershipId);
  assert.equal(state.vehicles[0].row.current_mileage_km, 2345);
  assert.equal(state.audits.length, 4);
  assert.deepEqual(state.audits.map(({ row }) => row.action).sort(),
    ['reception.closed', 'reception.created', 'reception.signed', 'reception.updated']);
  for (const { row } of state.audits) {
    assert.equal(row.outcome, 'success');
    assert.equal(row.actor_user_id, a.advisor.userId);
    assert.equal(row.actor_membership_id, a.advisor.membershipId);
    assert.equal(row.tenant_id, a.tenantId);
  }
  const retry = await request(a.advisor, a.tenantId, 'POST', `${route}/close`, undefined, 200);
  assert.deepEqual(retry, closed, 'retry returns the same order and timestamps');
  assert.equal(await readReceptionSnapshot(admin, a.tenantId, reception.receptionId, vehicleId), snapshot,
    'retry changes no reception, signature, order, history, vehicle or audit column');
  // Fixture presence never enables production privacy capture.
  await request(a.advisor, a.tenantId, 'POST', consentRoute, consentBody,
    409, 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  return { requestCount: requests.length, sentinels, errors, requests, snapshot,
    receptionId: reception.receptionId, vehicleId, route, detail, recoveryToken: tokens.get(a.advisor) };
}

module.exports = { runReceptionE2e, readReceptionSnapshot };
