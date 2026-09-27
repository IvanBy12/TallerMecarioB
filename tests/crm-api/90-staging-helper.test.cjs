'use strict';

// Exercises the T8 helper with the real Fastify/Clerk verifier and the
// disposable CRM PostgreSQL fixture. The Docker drill remains the staging gate.
const { Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { test } = require('node:test');
const localFetch = globalThis.fetch;
const h = require('./helpers.cjs');
const { buildApi } = h.load('api/app.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { migrationState, seedTwoTenants, runCrmE2e,
  assertLogPrivacy } = require('../../scripts/staging-crm-e2e.cjs');

test('S2-08 staging helper: deployed-style HTTP CRM flow, isolation, audit and privacy', async () => {
  const chunks = [];
  const stream = new Writable({ write(chunk, _encoding, done) {
    chunks.push(chunk.toString('utf8')); done();
  } });
  const app = await buildApi({
    database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    logStream: stream,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) { registerCustomerRoutes(server); registerVehicleRoutes(server); },
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const schemaBefore = await migrationState(h.admin);
    const migration = spawnSync(process.execPath, ['scripts/migrate.cjs'], {
      cwd: join(__dirname, '../..'), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL_ADMIN },
    });
    h.assert.equal(migration.status, 0, 'second migration succeeds');
    h.assert.equal(await migrationState(h.admin), schemaBefore,
      'second migration leaves ledger and schema unchanged');
    const tenants = await seedTwoTenants(h.admin);
    const identity = { privateKey: h.clerkKeys.privateKey, issuer: h.ISSUER,
      authorizedParty: h.AUTHORIZED_PARTY, secretKey: h.clerkAuthenticationConfig().secretKey,
      webhookSecret: h.newWebhookSecret() };
    const e2e = await runCrmE2e(h.admin, address, identity, tenants, localFetch);
    h.assert.equal(assertLogPrivacy(chunks.join(''), e2e.sentinels, e2e.requestCount, e2e.errors),
      e2e.requestCount);
    h.assert.equal(await migrationState(h.admin), schemaBefore);
  } finally {
    await h.closeAll(app);
    stream.end();
  }
});
