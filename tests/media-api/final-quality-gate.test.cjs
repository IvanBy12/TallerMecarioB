'use strict';
// Cross-subsystem B09 regression: real DB/runtime authorization and HTTP routes,
// simulated storage only. This is not browser or live-R2 E2E certification.
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Writable } = require('node:stream');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { parent } = require('./operational-helpers.cjs');
const f = require('../media/fixtures.cjs');
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { RECEPTION_ACCEPTANCE_VERSION } = h.load('receptions/acceptance-document.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const originalFetch = globalThis.fetch;
let app, a, b, calls = 0;
before(async () => {
  ({ a, b } = await h.twoTenants());
  app = await buildApi({ database: h.apiPool, identityProvider: { async verifyRequest(request) {
    const subject = request.headers.authorization?.slice(7);
    return subject ? { identityProvider: 'clerk', externalSubject: subject } : null;
  } }, rateLimit: { max: 100000, timeWindow: '1 minute' },
  logStream: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  registerRoutes(server) { registerMediaRoutes(server, f.r2); registerReceptionRoutes(server); } });
});
after(async () => { globalThis.fetch = originalFetch; await h.closeAll(app); });
const call = (method, url, payload, tenant = a) => app.inject({ method, url, payload,
  remoteAddress: `192.0.2.${++calls % 254 + 1}`,
  headers: { authorization: `Bearer ${tenant.owner.subject}`, 'x-tenant-id': tenant.tenantId } });
async function history(p) {
  const [row] = await h.admin`SELECT row_to_json(r)::text reception,
    (SELECT row_to_json(c)::text FROM privacy_consents c WHERE c.tenant_id=r.tenant_id AND c.id=r.privacy_consent_id) consent,
    (SELECT json_agg(row_to_json(d) ORDER BY d.id)::text FROM vehicle_damages d WHERE d.tenant_id=r.tenant_id AND d.reception_id=r.id) damages,
    (SELECT json_agg(row_to_json(s) ORDER BY s.id)::text FROM signatures s WHERE s.tenant_id=r.tenant_id AND s.reception_id=r.id) signatures,
    (SELECT json_agg(row_to_json(m) ORDER BY m.id)::text FROM media_assets m JOIN signatures s ON s.tenant_id=m.tenant_id AND s.signature_media_id=m.id WHERE s.tenant_id=r.tenant_id AND s.reception_id=r.id) signature_media,
    (SELECT count(*)::int FROM service_orders o WHERE o.tenant_id=r.tenant_id AND o.reception_id=r.id) orders
    FROM receptions r WHERE r.tenant_id=${a.tenantId} AND r.id=${p.reception}`;
  return { ...row };
}
async function uploadState(s) {
  const [row] = await h.admin`SELECT row_to_json(m)::text asset, row_to_json(u)::text session,
    (SELECT json_agg(row_to_json(b))::text FROM media_upload_bindings b WHERE b.tenant_id=u.tenant_id AND b.upload_session_id=u.id) binding,
    (SELECT count(*)::int FROM audit_logs WHERE tenant_id=m.tenant_id AND entity_id=m.id) audits
    FROM media_assets m JOIN upload_sessions u ON u.tenant_id=m.tenant_id AND u.media_asset_id=m.id
    WHERE m.tenant_id=${a.tenantId} AND m.id=${s.mediaAssetId}`;
  return { ...row };
}
for (const mediaType of ['photo', 'video360']) for (const failure of ['missing', 'provider', 'partial'])
  test(`B09 ${mediaType}/${failure}: outage preserves reception/history, retries same session and attaches once`, async () => {
    const p = await parent(a), bytes = mediaType === 'photo' ? f.png : readFileSync(join(__dirname, '../media/fixtures/clip.mp4'));
    const signed = mediaType === 'photo' && failure === 'provider';
    if (signed) {
      const signatureMediaId = randomUUID();
      await h.admin`INSERT INTO media_assets(id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
        VALUES(${signatureMediaId},${a.tenantId},'test',${signatureMediaId},'signature','image/png','active','authorization_evidence','v1')`;
      const captured = await call('POST', `/api/v1/receptions/${p.reception}/signature`, { signatureMediaId,
        signedByName: 'Historical signer', documentVersion: RECEPTION_ACCEPTANCE_VERSION });
      assert.equal(captured.statusCode, 201, captured.body);
      const persisted = await history(p);
      assert.equal(JSON.parse(persisted.signatures).length, 1);
      assert.equal(JSON.parse(persisted.signatures)[0].signature_media_id, signatureMediaId);
      assert.equal(JSON.parse(persisted.signature_media)[0].id, signatureMediaId);
      await assert.rejects(h.admin`UPDATE signatures SET signed_by_name='Changed' WHERE tenant_id=${a.tenantId} AND reception_id=${p.reception}`, { code: '23514' });
      await assert.rejects(h.admin`UPDATE media_assets SET object_key='Changed' WHERE tenant_id=${a.tenantId} AND id=${signatureMediaId}`, { code: '23514' });
      assert.deepEqual(await history(p), persisted);
    }
    const mime = mediaType === 'photo' ? 'image/png' : 'video/mp4';
    const payload = { mediaType, mimeType: mime, expectedSizeBytes: bytes.length, retentionClass: 'operational',
      idempotencyKey: randomUUID(), operationalContext: { type: 'reception', receptionId: p.reception } };
    const created = await call('POST', '/api/v1/media/upload-sessions', payload);
    assert.equal(created.statusCode, 201, created.body); const s = created.json();
    const before = await history(p), pending = await uploadState(s);
    const healthy = f.objectFetch(bytes, mime); let storageCalls = 0;
    globalThis.fetch = async (url, init) => {
      storageCalls++;
      if (failure === 'partial') {
        if (init.method === 'HEAD') return healthy(url, init);
        throw Error('synthetic interrupted range');
      }
      return new Response(null, { status: failure === 'missing' ? 404 : 503 });
    };
    const completion = `/api/v1/media/upload-sessions/${s.uploadSessionId}/complete`;
    const failed = await call('POST', completion, {});
    assert.equal(failed.statusCode, failure === 'missing' ? 409 : 503, failed.body);
    assert.equal(failed.json().error.code, failure === 'missing' ? 'UPLOAD_NOT_FOUND_IN_STORAGE' : 'MEDIA_STORAGE_UNAVAILABLE');
    assert.ok(storageCalls > 0); assert.deepEqual(await history(p), before); assert.deepEqual(await uploadState(s), pending);
    for (const secret of [s.uploadUrl, s.objectKey, f.r2.bucket]) assert.equal(failed.body.includes(secret), false);
    const foreign = await call('POST', completion, {}, b);
    assert.equal(foreign.statusCode, 404); assert.deepEqual(await uploadState(s), pending);
    const replay = await call('POST', '/api/v1/media/upload-sessions', payload);
    assert.equal(replay.statusCode, 201, replay.body);
    for (const key of ['uploadSessionId', 'mediaAssetId', 'objectKey', 'expiresAt']) assert.equal(replay.json()[key], s[key]);
    globalThis.fetch = healthy;
    assert.equal((await call('POST', completion, {})).statusCode, 200);
    const mediaUrl = `/api/v1/receptions/${p.reception}/media`;
    for (let i = 0; i < 2; i++) assert.equal((await call('POST', mediaUrl, { mediaAssetId: s.mediaAssetId })).statusCode, 201);
    const listed = await call('GET', mediaUrl);
    assert.equal(listed.statusCode, 200); assert.deepEqual(listed.json().media.map(m => m.mediaAssetId), [s.mediaAssetId]);
    const [audit] = await h.admin`SELECT count(*)::int n FROM audit_logs WHERE tenant_id=${a.tenantId} AND entity_id=${s.mediaAssetId} AND action='media.associated'`;
    assert.equal(audit.n, 1); assert.deepEqual(await history(p), before);
    const closed = await call('POST', `/api/v1/receptions/${p.reception}/close`);
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal((await call('GET', mediaUrl)).json().media[0].mediaAssetId, s.mediaAssetId);
    assert.equal((await history(p)).orders, 1);
    const afterClose = await history(p);
    if (signed) {
      assert.deepEqual(afterClose.signatures, before.signatures);
      assert.deepEqual(afterClose.signature_media, before.signature_media);
    } else assert.equal(afterClose.signatures, null, 'normal close requires no invented signature');
  });
