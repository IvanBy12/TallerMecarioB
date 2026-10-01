'use strict';

/**
 * S3-04.5 reception API privacy helpers. Consents are captured through the real
 * POST /customers/:id/privacy-consents route with TEST-ONLY catalog fixtures
 * and a TEST-ONLY rights channel source, separate from production dependencies.
 */
const { randomUUID } = require('node:crypto');
const h = require('../crm-api/helpers.cjs');
const f = require('../privacy/fixtures.cjs');
const { assert } = h;
const { registerPrivacyConsentRoutes } = h.load('privacy/routes.js');

const TEST_DEPENDENCIES = Object.freeze({
  catalog: f.catalog(),
  controllerNotice: { rightsChannel: () => f.RIGHTS_CHANNEL },
});
const registerTestPrivacyRoutes = (server) => registerPrivacyConsentRoutes(server, TEST_DEPENDENCIES);

/** Gives the workshop a complete controller notice (primary location + contact). */
async function configureNotice(tenantId, { phone = '+5716000000', email = 'contacto@taller.test' } = {}) {
  let locationId;
  await h.admin.begin(async (tx) => {
    const [existing] = await tx`SELECT id FROM public.workshop_locations
      WHERE tenant_id = ${tenantId} AND is_primary = true`;
    locationId = existing?.id ?? randomUUID();
    if (!existing) await tx`INSERT INTO public.workshop_locations
      (id, tenant_id, name, address_line, city, department, is_primary)
      VALUES (${locationId}, ${tenantId}, 'Sede', 'Calle 1 # 2-3', 'Bogotá', 'Bogotá D.C.', true)`;
    await tx`UPDATE public.workshops SET phone = ${phone}, email = ${email} WHERE id = ${tenantId}`;
  });
  return locationId;
}

const captureBody = (overrides = {}) => ({
  purposeCode: 'service_provision', privacyNoticeVersion: f.NOTICE_V1.version,
  authorizationTextVersion: f.SERVICE_V1.version, channel: 'in_person', adultAttestationConfirmed: true,
  ...overrides,
});
const capture = (app, actor, tenantId, customerId, body, extra = {}) => h.call(app, {
  subject: actor?.subject, tenantId, method: 'POST', url: `/api/v1/customers/${customerId}/privacy-consents`,
  body, ...extra,
});

/** A granted service_provision consent for the customer, via the real API. */
async function serviceConsent(app, actor, tenantId, customerId, overrides = {}) {
  await configureNotice(tenantId);
  const result = await capture(app, actor, tenantId, customerId, captureBody(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  return result.json.privacyConsent.privacyConsentId;
}

/** Revocation as the runtime API role would perform it (no revoke route exists yet). */
const REVOKE_SQL = `UPDATE public.privacy_consents
  SET status = 'revoked', revoked_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE tenant_id = $1 AND id = $2`;

module.exports = { f, TEST_DEPENDENCIES, registerTestPrivacyRoutes, configureNotice, captureBody, capture,
  serviceConsent, REVOKE_SQL };
