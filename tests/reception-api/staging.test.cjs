'use strict';

// Regression coverage for the shared HTTP drill helper. The Docker deployment
// remains a separate required gate, using the unchanged production entrypoint.
const { Writable } = require('node:stream');
const { test } = require('node:test');
const localFetch = globalThis.fetch;
const h = require('../crm-api/helpers.cjs');
const { buildApi } = h.load('api/app.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerPrivacyConsentRoutes } = h.load('privacy/routes.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { seedTwoTenants, runCrmE2e, assertLogPrivacy,
  completionEvents, assertExactCrmAudit } = require('../../scripts/staging-crm-e2e.cjs');
const { runReceptionE2e, readReceptionSnapshot } = require('../../scripts/staging-reception-e2e.cjs');

test('S3 staging helper uses real HTTP, production fail-closed privacy, OCC, RLS, RBAC and exactly-once close', async () => {
  const chunks = [];
  const stream = new Writable({ write(chunk, _encoding, done) {
    chunks.push(chunk.toString('utf8')); done();
  } });
  const app = await buildApi({ database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    logStream: stream, rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerCustomerRoutes(server); registerVehicleRoutes(server);
      registerPrivacyConsentRoutes(server); registerReceptionRoutes(server);
    } });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const tenants = await seedTwoTenants(h.admin);
    const identity = { privateKey: h.clerkKeys.privateKey, issuer: h.ISSUER,
      authorizedParty: h.AUTHORIZED_PARTY, secretKey: h.clerkAuthenticationConfig().secretKey,
      webhookSecret: h.newWebhookSecret() };
    const crm = await runCrmE2e(h.admin, address, identity, tenants, localFetch);
    await assertExactCrmAudit(h.admin, tenants, crm, completionEvents(chunks.join('')));
    const reception = await runReceptionE2e(h.admin, address, identity, tenants, crm.vehicleId, localFetch);
    h.assert.equal(assertLogPrivacy(chunks.join(''), [...crm.sentinels, ...reception.sentinels],
      crm.requestCount + reception.requestCount, [...crm.errors, ...reception.errors]),
    crm.requestCount + reception.requestCount);
    h.assert.equal(await readReceptionSnapshot(h.admin, tenants.a.tenantId,
      reception.receptionId, reception.vehicleId), reception.snapshot);
    for (const sentinel of reception.sentinels.filter((value) => value.startsWith('StagePrivate'))) {
      h.assert.throws(() => assertLogPrivacy(`${chunks.join('')}\n${sentinel}`,
        reception.sentinels, 0), /STAGING_LOG_PRIVATE_VALUE_FAILED/u);
    }
  } finally {
    await h.closeAll(app);
    stream.end();
  }
});
