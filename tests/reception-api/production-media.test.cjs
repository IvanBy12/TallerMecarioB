 'use strict';
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { Writable } = require('node:stream');
const { test, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const { buildProductionApi, loadProductionApiConfig } = h.load('api/server.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { assert } = h;
after(() => h.closeAll());
const synthetic = { R2_ENDPOINT: 'https://r2.invalid', R2_REGION: 'auto', R2_BUCKET: 'hermetic',
  R2_ACCESS_KEY_ID: randomUUID(), R2_SECRET_ACCESS_KEY: randomUUID() };
test('production entrypoint fails closed for missing or every partial R2 configuration before DB', () => {
  for (const missing of [null, ...Object.keys(synthetic)]) {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('R2_')) delete env[name];
    if (missing) Object.assign(env, synthetic, { [missing]: '' });
    const child = spawnSync(process.execPath, [join(process.env.TEST_MODULE_ROOT, 'api/server.js')],
      { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr.trim(), 'R2_CONFIGURATION_MISSING');
    assert.equal(child.stdout, '');
  }
});
test('real entrypoint validates every integration before calling runtimeDatabase or opening a pool', () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(R2_|WOMPI_|CLERK_|NEXT_PUBLIC_CLERK_|MEMBERSHIP_INVITATION_|RESEND_|DATABASE_URL$)/u.test(name)) delete env[name];
  }
  const clerk = h.clerkAuthenticationConfig();
  const clerkEnv = { CLERK_SECRET_KEY: clerk.secretKey, CLERK_PUBLISHABLE_KEY: clerk.publishableKey,
    CLERK_JWT_KEY: clerk.jwtKey, CLERK_AUTHORIZED_PARTIES: clerk.authorizedParties.join(','),
    CLERK_WEBHOOK_SIGNING_SECRET: h.newWebhookSecret() };
  const invitationEnv = { MEMBERSHIP_INVITATION_TOKEN_SECRET: Buffer.from(randomUUID()).toString('base64'),
    MEMBERSHIP_INVITATION_ACCEPT_URL: 'https://app.invalid/invite',
    MEMBERSHIP_INVITATION_EMAIL_FROM: 'invites@example.test' };
  const cases = [
    ...Object.keys(synthetic).map((name) => [{ ...synthetic, [name]: ' ' }, 'R2_CONFIGURATION_MISSING']),
    ...['not-a-url', 'http://r2.invalid'].map((endpoint) =>
      [{ ...synthetic, R2_ENDPOINT: endpoint }, 'R2_CONFIGURATION_MISSING']),
    [{ ...synthetic, WOMPI_ENABLED: 'invalid' }, 'WOMPI_ENABLED_INVALID'],
    [{ ...synthetic, WOMPI_ENABLED: 'true' }, 'WOMPI_PUBLIC_KEY_REQUIRED'],
    [{ ...synthetic, CLERK_SECRET_KEY: 'invalid' },
      'CLERK_CONFIGURATION_INVALID CLERK_SECRET_KEY: has an unexpected format'],
    ...['CLERK_JWT_KEY', 'CLERK_AUTHORIZED_PARTIES', 'CLERK_WEBHOOK_SIGNING_SECRET'].map((name) =>
      [{ ...synthetic, ...clerkEnv, [name]: '' }, 'CLERK_CONFIGURATION_INVALID ' + name + ': is required']),
    ...Object.keys(invitationEnv).map((name) => [{ ...synthetic, ...invitationEnv, [name]: '' },
      'MEMBERSHIP_INVITATION_CONFIGURATION_INVALID ' + name + ': is required']),
  ];
  const directory = mkdtempSync(join(tmpdir(), 'tallermecario-startup-'));
  const preload = join(directory, 'pool-trap.cjs');
  // Instrument the DB boundary in the actual server.js process. A call fails the assertion,
  // even if production code swallowed a DB error and later reported a config error.
  writeFileSync(preload, 'require(' + JSON.stringify(join(process.env.TEST_MODULE_ROOT,
    'platform/runtime-database.js')) + ').runtimeDatabase = async () => {'
    + 'process.stderr.write("DATABASE_POOL_OPENED\\n");'
    + 'throw new Error("DATABASE_CONFIGURATION_REQUIRED"); };');
  const run = (override) => spawnSync(process.execPath,
    ['--require', preload, join(process.env.TEST_MODULE_ROOT, 'api/server.js')],
    { env: { ...env, ...override }, encoding: 'utf8', timeout: 5000 });
  try {
    for (const [override, expected] of cases) {
      const child = run(override);
      assert.equal(child.status, 1);
      assert.equal(child.stderr.trim(), expected);
      assert.equal(child.stdout, '');
    }
    const valid = run({ ...synthetic, ...clerkEnv, ...invitationEnv });
    assert.equal(valid.status, 1);
    assert.equal(valid.stderr.trim(), 'DATABASE_POOL_OPENED\nDATABASE_CONFIGURATION_REQUIRED',
      'valid environment reaches the instrumented DB boundary exactly once');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production route composition registers all media paths, preserves RBAC, tenant boundary and log privacy', async () => {
  const config = loadProductionApiConfig({ ...process.env, ...synthetic });
  const chunks = [];
  const logStream = new Writable({ write(chunk, _enc, done) { chunks.push(chunk.toString()); done(); } });
  const app = await buildProductionApi({ database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    logStream, rateLimit: { max: 100000, timeWindow: '1 minute' } }, config);
  try {
    await app.ready();
    for (const [method, url] of [['POST', '/api/v1/media/upload-sessions'],
      ['POST', '/api/v1/media/upload-sessions/:id/complete'], ['GET', '/api/v1/media/:id/download-url']])
      assert.equal(app.hasRoute({ method, url }), true);
    const { a, b } = await h.twoTenants();
    const body = { mediaType: 'signature', mimeType: 'image/png',
      retentionClass: 'authorization_evidence', expectedSizeBytes: 68, idempotencyKey: randomUUID() };
    const call = (actor, tenantId, method, url, payload) => h.call(app,
      { subject: actor.subject, tenantId, method, url, body: payload });
    const made = await call(b.owner, b.tenantId, 'POST', '/api/v1/media/upload-sessions', body);
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.deepEqual(made.json.uploadHeaders, { 'Content-Type': 'image/png', 'If-None-Match': '*' });
    assert.equal(made.json.secretAccessKey, undefined);
    const complete = '/api/v1/media/upload-sessions/' + made.json.uploadSessionId + '/complete';
    const download = '/api/v1/media/' + made.json.mediaAssetId + '/download-url';
    for (const [method, url, payload] of [['POST', '/api/v1/media/upload-sessions', body],
      ['POST', complete, {}], ['GET', download, undefined]]) {
      const denied = await call(a.technician, a.tenantId, method, url, payload);
      assert.equal(denied.status, 403); assert.equal(denied.json.error.code, 'PERMISSION_DENIED');
    }
    for (const [method, url, payload] of [['POST', complete, {}], ['GET', download, undefined]]) {
      const foreign = await call(a.owner, a.tenantId, method, url, payload);
      const absent = await call(a.owner, a.tenantId, method, url.replace(made.json.uploadSessionId, randomUUID()).replace(made.json.mediaAssetId, randomUUID()), payload);
      assert.equal(foreign.status, 404); assert.equal(h.errorShape(foreign), h.errorShape(absent));
    }
    const logs = chunks.join('');
    for (const value of [synthetic.R2_ACCESS_KEY_ID, synthetic.R2_SECRET_ACCESS_KEY, made.json.uploadUrl,
      made.json.objectKey, 'X-Amz-Signature']) assert.equal(logs.includes(value), false);
    assert.equal(h.network.calls, 0);
  } finally { await app.close(); logStream.end(); }
});
