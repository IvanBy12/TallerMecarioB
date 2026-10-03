 'use strict';
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { Writable } = require('node:stream');
const { test, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const { buildProductionApi } = h.load('api/server.js');
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
test('production route composition registers all media paths, preserves RBAC, tenant boundary and log privacy', async () => {
  Object.assign(process.env, synthetic);
  const chunks = [];
  const logStream = new Writable({ write(chunk, _enc, done) { chunks.push(chunk.toString()); done(); } });
  const app = await buildProductionApi({ database: h.apiPool,
    identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
    logStream, rateLimit: { max: 100000, timeWindow: '1 minute' } });
  try {
    await app.ready();
    for (const [method, url] of [['POST', '/api/v1/media/upload-sessions'],
      ['POST', '/api/v1/media/upload-sessions/:id/complete'], ['GET', '/api/v1/media/:id/download-url']])
      assert.equal(app.hasRoute({ method, url }), true);
    const { a, b } = await h.twoTenants();
    const body = { mediaType: 'signature', mimeType: 'image/png',
      retentionClass: 'authorization_evidence', idempotencyKey: randomUUID() };
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
