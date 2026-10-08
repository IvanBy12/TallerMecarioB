'use strict';
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Writable } = require('node:stream');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const f = require('../media/fixtures.cjs');
let app, a, b, calls = 0;
const logs = [];
const originalFetch = globalThis.fetch;
before(async () => {
  ({ a, b } = await h.twoTenants());
  app = await buildApi({ database: h.apiPool, identityProvider: {
    async verifyRequest(request) {
      const subject = request.headers.authorization?.slice(7);
      return subject ? { identityProvider: 'clerk', externalSubject: subject } : null;
    } }, rateLimit: { max: 100000, timeWindow: '1 minute' },
    logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
    registerRoutes(server) { registerMediaRoutes(server, f.r2); } });
});
after(async () => { globalThis.fetch = originalFetch; await h.closeAll(app); });
const call = (method, url, payload, tenant = a) => app.inject({ method, url, remoteAddress: `192.0.2.${++calls % 254 + 1}`,
  headers: { authorization: `Bearer ${tenant.owner.subject}`, 'x-tenant-id': tenant.tenantId }, payload });
const create = (extra = {}, tenant = a) => call('POST', '/api/v1/media/upload-sessions', {
  mediaType: 'signature', mimeType: 'image/png', retentionClass: 'authorization_evidence',
  idempotencyKey: randomUUID(), expectedSizeBytes: f.png.length, ...extra }, tenant);
async function session(extra = {}) {
  const response = await create(extra);
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
const complete = (s, body = {}, tenant = a) => call('POST', `/api/v1/media/upload-sessions/${s.uploadSessionId}/complete`, body, tenant);
async function rows(s) {
  const [row] = await h.admin`SELECT ma.status AS asset_status, ma.size_bytes, ma.checksum_sha256,
    ma.uploaded_at, ma.quarantined_at, ma.integrity_failure_code, us.status AS session_status,
    us.completed_at, us.expected_size_bytes, us.integrity_version
    FROM media_assets ma JOIN upload_sessions us ON us.tenant_id=ma.tenant_id AND us.media_asset_id=ma.id
    WHERE us.id=${s.uploadSessionId}`;
  return { ...row };
}
const audits = (s) => h.admin`SELECT * FROM audit_logs WHERE entity_id=${s.mediaAssetId} ORDER BY created_at`;
for (const [name, size, code, status] of [
  ['missing', undefined, 'REQUEST_VALIDATION_FAILED', 400], ['zero', 0, 'REQUEST_VALIDATION_FAILED', 400],
  ['negative', -1, 'REQUEST_VALIDATION_FAILED', 400], ['fractional', 1.5, 'REQUEST_VALIDATION_FAILED', 400],
  ['over max', 2097153, 'MEDIA_SIZE_TOO_LARGE', 422],
]) test(`CREATE expected size ${name}`, async () => {
  const response = await create({ expectedSizeBytes: size });
  assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code);
});
test('CREATE persists v1 exact expectation; incompatible expectation cannot silently replay', async () => {
  const idempotencyKey = randomUUID();
  const s = await session({ idempotencyKey });
  assert.equal(Number((await rows(s)).expected_size_bytes), f.png.length);
  assert.equal((await rows(s)).integrity_version, 'v1');
  const replay = await create({ idempotencyKey });
  assert.equal(replay.json().uploadSessionId, s.uploadSessionId);
  assert.equal((await audits(s)).length, 1);
  const different = await create({ idempotencyKey, expectedSizeBytes: f.png.length + 1 });
  assert.equal(different.statusCode, 409); assert.equal(different.json().error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
});
test('operational create requires context; technician remains fail-closed', async () => {
  for (const actor of [a.owner, a.admin, a.advisor, a.technician]) for (const mediaType of ['photo', 'video', 'video360']) {
    const response = await create({ mediaType, mimeType: mediaType === 'photo' ? 'image/png' : 'video/mp4',
      retentionClass: 'operational' }, { ...a, owner: actor });
    assert.equal(response.statusCode, actor === a.technician ? 403 : 400);
    assert.equal(response.json().error.code, actor === a.technician ? 'PERMISSION_DENIED' : 'REQUEST_VALIDATION_FAILED');
    assert.equal(response.json().uploadUrl, undefined);
  }
  const incompatible = await create({ retentionClass: 'operational' });
  assert.equal(incompatible.json().error.code, 'RETENTION_CLASS_NOT_ALLOWED');
});
test('happy signature: exact metadata, real PNG, atomic timestamps, declared lowercase checksum, stable replay', async () => {
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
  const result = await complete(s, { checksumSha256: 'A'.repeat(64) });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json(), { mediaAssetId: s.mediaAssetId, status: 'active', sizeBytes: f.png.length, checksumSha256: 'a'.repeat(64) });
  const row = await rows(s);
  assert.equal(row.asset_status, 'active'); assert.equal(row.session_status, 'completed');
  assert.ok(row.uploaded_at); assert.ok(row.completed_at); assert.equal(row.quarantined_at, null);
  assert.equal(+row.uploaded_at, +row.completed_at); assert.equal(row.integrity_failure_code, null);
  assert.equal(row.checksum_sha256, 'a'.repeat(64));
  assert.equal((await audits(s)).length, 2);
  globalThis.fetch = () => { throw new Error('completed replay must not access R2'); };
  const replay = await complete(s, { checksumSha256: 'A'.repeat(64) });
  assert.equal(replay.statusCode, 200); assert.deepEqual(await rows(s), row); assert.equal((await audits(s)).length, 2);
});
test('invalid declared checksum rejects before storage; absence never becomes an ETag digest', async () => {
  const s = await session(); globalThis.fetch = () => { throw new Error('no call expected'); };
  for (const checksumSha256 of ['g'.repeat(64), 'a'.repeat(63), ' '.repeat(64)]) {
    const response = await complete(s, { checksumSha256 });
    assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'REQUEST_VALIDATION_FAILED');
  }
  globalThis.fetch = f.objectFetch(f.png, 'image/png');
  const response = await complete(s); assert.equal(response.json().checksumSha256, null);
  assert.equal((await rows(s)).checksum_sha256, null);
});
for (const [name, data, mime, options, expected] of [
  ['zero', f.png, 'image/png', { size: 0 }, 'MEDIA_SIZE_INVALID'],
  ['over max', f.png, 'image/png', { size: 2097153 }, 'MEDIA_SIZE_INVALID'],
  ['exact size mismatch', f.png, 'image/png', { size: f.png.length + 1 }, 'MEDIA_METADATA_MISMATCH'],
  ['missing Content-Type', f.png, null, {}, 'MEDIA_METADATA_MISMATCH'],
  ['different Content-Type', f.png, 'image/jpeg', {}, 'MEDIA_METADATA_MISMATCH'],
  ['MIME parameter', f.png, 'image/png; charset=binary', {}, 'MEDIA_METADATA_MISMATCH'],
  ['MIME case', f.png, 'Image/PNG', {}, 'MEDIA_METADATA_MISMATCH'],
  ['arbitrary PNG', Buffer.alloc(f.png.length, 42), 'image/png', {}, 'MEDIA_CONTENT_INVALID'],
  ['truncated PNG', f.png.subarray(0, -1), 'image/png', {}, 'MEDIA_CONTENT_INVALID'],
  ['corrupt PNG', Buffer.from(f.png.map((v, i) => i === 45 ? v ^ 1 : v)), 'image/png', {}, 'MEDIA_CONTENT_INVALID'],
]) test(`COMPLETE ${name} commits quarantined + failed + safe audit on 422`, async () => {
  const s = await session({ expectedSizeBytes: data.length }); globalThis.fetch = f.objectFetch(data, mime, options);
  const response = await complete(s); assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().error.code, expected);
  const row = await rows(s); assert.equal(row.asset_status, 'quarantined'); assert.equal(row.session_status, 'failed');
  assert.ok(row.quarantined_at); assert.ok(row.uploaded_at); assert.equal(row.completed_at, null);
  assert.equal(row.integrity_failure_code, expected);
  const audit = (await audits(s)).at(-1); assert.equal(audit.action, 'media.quarantined'); assert.equal(audit.reason_code, expected);
  assert.equal(audit.actor_membership_id, a.owner.membershipId);
  assert.equal(audit.request_id, response.json().error.request_id);
  for (const secret of [s.objectKey, f.r2.bucket, s.uploadUrl]) assert.equal(response.body.includes(secret), false);
  assert.equal((await complete(s)).json().error.code, 'UPLOAD_SESSION_FAILED');
});
for (const [name, options, code, status] of [['network', { error: true }, 'MEDIA_STORAGE_UNAVAILABLE', 503],
  ['provider 5xx', { status: 503 }, 'MEDIA_STORAGE_UNAVAILABLE', 503], ['absent object', { status: 404 }, 'UPLOAD_NOT_FOUND_IN_STORAGE', 409]]) {
  test(`recoverable ${name}: no false integrity result`, async () => {
    const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png', options);
    const response = await complete(s); assert.equal(response.statusCode, status, response.body); assert.equal(response.json().error.code, code);
    const row = await rows(s); assert.equal(row.asset_status, 'pending_upload'); assert.equal(row.session_status, 'pending');
    assert.equal(row.uploaded_at, null); assert.equal(row.integrity_failure_code, null); assert.equal(row.completed_at, null);
    assert.equal((await audits(s)).length, 1);
    assert.equal(response.body.includes('provider secret'), false);
    globalThis.fetch = f.objectFetch(f.png, 'image/png'); assert.equal((await complete(s)).statusCode, 200);
  });
}
test('legacy pending session expires without HEAD or manufactured expectation', async () => {
  const id = randomUUID(), media = randomUUID();
  await h.admin`INSERT INTO media_assets (id,tenant_id,bucket,object_key,media_type,mime_type,retention_class,retention_policy_version)
    VALUES (${media},${a.tenantId},'test',${media},'signature','image/png','authorization_evidence','v1')`;
  await h.admin`INSERT INTO upload_sessions (id,tenant_id,media_asset_id,idempotency_key,expires_at,integrity_version)
    VALUES (${id},${a.tenantId},${media},${randomUUID()},now()+interval '1 hour','legacy')`;
  globalThis.fetch = () => { throw new Error('legacy must not read R2'); };
  const s = { uploadSessionId: id, mediaAssetId: media };
  assert.equal((await complete(s)).json().error.code, 'UPLOAD_SESSION_EXPIRED');
  const row = await rows(s); assert.equal(row.session_status, 'expired'); assert.equal(row.asset_status, 'pending_upload');
  assert.equal(row.expected_size_bytes, null); assert.equal(row.completed_at, null);
});
test('expired session denied; cross-tenant complete is non-enumerable and cannot change states', async () => {
  const s = await session();
  globalThis.fetch = () => { throw new Error('no storage calls expected'); };
  const foreign = await complete(s, {}, b), absent = await complete({ uploadSessionId: randomUUID() }, {}, b);
  assert.equal(foreign.statusCode, 404); assert.equal(foreign.json().error.code, absent.json().error.code);
  assert.equal((await rows(s)).session_status, 'pending');
  await h.admin`UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE id=${s.uploadSessionId}`;
  assert.equal((await complete(s)).json().error.code, 'UPLOAD_SESSION_EXPIRED');
  assert.equal((await rows(s)).session_status, 'expired');
  assert.equal((await rows(s)).asset_status, 'pending_upload');
});
test('large/raw client bodies and content bytes are not accepted by completion; logs contain no R2 values', async () => {
  const s = await session();
  const response = await complete(s, { bytes: 'a'.repeat(1024 * 1024 + 1) });
  assert.equal(response.statusCode, 413);
  const unknown = await complete(s, { bytes: 'payload' }); assert.equal(unknown.statusCode, 400);
  const text = logs.join('');
  for (const value of [s.objectKey, s.uploadUrl, f.r2.bucket, 'X-Amz-Signature', 'provider secret']) assert.equal(text.includes(value), false);
});
test('Range transport failure after valid HEAD remains pending and does not claim uploaded', async () => {
  const s = await session(); const fetchHead = f.objectFetch(f.png, 'image/png');
  globalThis.fetch = (url, init) => init.method === 'HEAD' ? fetchHead(url, init) : Promise.reject(new Error('secret provider body'));
  const response = await complete(s); assert.equal(response.statusCode, 503);
  const row = await rows(s); assert.equal(row.asset_status, 'pending_upload'); assert.equal(row.session_status, 'pending');
  assert.equal(row.uploaded_at, null); assert.equal(row.quarantined_at, null);
});
test('failed completion audit rolls back both state transitions and retry succeeds', async () => {
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'media.upload_completed'");
  try {
    assert.equal((await complete(s)).statusCode, 500);
    const row = await rows(s); assert.equal(row.asset_status, 'pending_upload'); assert.equal(row.session_status, 'pending');
    assert.equal(row.uploaded_at, null); assert.equal(row.completed_at, null);
    assert.equal((await audits(s)).length, 1);
  } finally { await remove(); }
  assert.equal((await complete(s)).statusCode, 200);
});
test('failed quarantine audit rolls back quarantine and failed session consistently', async () => {
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/jpeg');
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'media.quarantined'");
  try {
    assert.equal((await complete(s)).statusCode, 500);
    const row = await rows(s); assert.equal(row.asset_status, 'pending_upload'); assert.equal(row.session_status, 'pending');
    assert.equal(row.quarantined_at, null); assert.equal(row.integrity_failure_code, null);
  } finally { await remove(); }
  assert.equal((await complete(s)).statusCode, 422);
  assert.equal((await rows(s)).session_status, 'failed');
});
// New public operation with a real authorized parent; never upgrade old fixtures into evidence.
async function operationalFixture(bytes, mediaType, mimeType) {
  const parent = await require('./operational-helpers.cjs').parent(a);
  return session({ mediaType, mimeType, retentionClass: 'operational', expectedSizeBytes: bytes.length,
    operationalContext: { type: 'reception', receptionId: parent.reception } });
}
for (const [name, bytes, mime, type] of [['JPEG', f.jpeg, 'image/jpeg', 'document'],
  ['PNG document', f.png, 'image/png', 'document'], ['PDF', f.pdf, 'application/pdf', 'quote_pdf'],
  ['WebP', f.webp, 'image/webp', 'photo']]) test(`exact ${name} complete succeeds`, async () => {
    const s = type === 'photo' ? await operationalFixture(bytes, type, mime) : await session({ mediaType: type,
      mimeType: mime, retentionClass: 'document', expectedSizeBytes: bytes.length });
    globalThis.fetch = f.objectFetch(bytes, mime); const response = await complete(s);
    assert.equal(response.statusCode, 200, response.body); assert.equal((await rows(s)).asset_status, 'active');
  });
test('allowed-but-unexpected MIME and PNG declared JPEG both quarantine', async () => {
  for (const [headMime, bytes] of [['image/png', f.png], ['image/jpeg', f.png]]) {
    const s = await operationalFixture(bytes, 'photo', 'image/jpeg');
    globalThis.fetch = f.objectFetch(bytes, headMime);
    const response = await complete(s); assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, headMime === 'image/png' ? 'MEDIA_METADATA_MISMATCH' : 'MEDIA_CONTENT_INVALID');
    assert.equal((await rows(s)).session_status, 'failed');
    const before = await rows(s);
    assert.equal((await complete(s, {}, b)).statusCode, 404); assert.deepEqual(await rows(s), before);
  }
});
test('PostgreSQL enforces positive v1 expectation, per-type maximum, tenant FK and immutability', async () => {
  const s = await session();
  await assert.rejects(h.admin`UPDATE upload_sessions SET expected_size_bytes=71 WHERE id=${s.uploadSessionId}`,
    (e) => e.code === '23514' && e.constraint_name === 'upload_sessions_expectation_immutable');
  for (const expected of [null, 0, -1, 2097153]) {
    await assert.rejects(h.admin`INSERT INTO upload_sessions (id,tenant_id,media_asset_id,idempotency_key,expires_at,expected_size_bytes)
      VALUES (${randomUUID()},${a.tenantId},${s.mediaAssetId},${randomUUID()},now()+interval '1 hour',${expected})`,
    (e) => e.code === '23514');
  }
  await assert.rejects(h.asRuntime(h.apiPool, { tenantId: a.tenantId, userId: a.owner.user.id,
    membershipId: a.owner.membershipId }, (sql) => sql`INSERT INTO upload_sessions
    (id,tenant_id,media_asset_id,idempotency_key,expires_at,integrity_version)
    VALUES (${randomUUID()},${a.tenantId},${s.mediaAssetId},${randomUUID()},now()+interval '1 hour','legacy')`),
    (e) => e.code === '23514');
});
for (const [type, extension, mime] of [['video', 'mp4', 'video/mp4'], ['video360', 'mov', 'video/quicktime']]) {
  test(`${type} bound container completion passes integrity with duration policy still unresolved`, async () => {
    const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, `../media/fixtures/clip.${extension}`));
    const s = await operationalFixture(bytes, type, mime); globalThis.fetch = f.objectFetch(bytes, mime);
    assert.equal((await complete(s)).statusCode, 200);
    assert.equal((await rows(s)).session_status, 'completed');
  });
}
test('expiry during storage validation is rechecked before any activation', async () => {
  const s = await session();
  await h.admin`UPDATE upload_sessions SET expires_at=now()+interval '500 milliseconds' WHERE id=${s.uploadSessionId}`;
  const transport = f.objectFetch(f.png, 'image/png'); let heads = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'HEAD') { heads++; await new Promise((resolve) => setTimeout(resolve, 600)); }
    return transport(url, init);
  };
  const response = await complete(s); assert.equal(heads, 1); assert.equal(response.json().error.code, 'UPLOAD_SESSION_EXPIRED');
  const row = await rows(s); assert.equal(row.session_status, 'expired'); assert.equal(row.asset_status, 'pending_upload');
  assert.equal(row.completed_at, null); assert.equal(row.uploaded_at, null);
});
test('two overlapping completions commit one transition and one completion audit', async () => {
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
  const result = await Promise.all([complete(s), complete(s)]);
  assert.ok(result.every((r) => r.statusCode === 200));
  assert.equal((await audits(s)).filter((r) => r.action === 'media.upload_completed').length, 1);
  assert.equal((await rows(s)).session_status, 'completed');
});
test('different internal bucket cannot certify a different object at the same key', async () => {
  const s = await session();
  await h.admin`UPDATE media_assets SET bucket='different-internal-bucket' WHERE id=${s.mediaAssetId}`;
  globalThis.fetch = () => { throw new Error('misconfigured bucket must not access R2'); };
  assert.equal((await complete(s)).statusCode, 503);
  assert.equal((await rows(s)).session_status, 'pending'); assert.equal((await rows(s)).asset_status, 'pending_upload');
});

test('unsupported object has one terminal quarantine; exact retries never repeat inspection', async () => {
  const s = await session({ expectedSizeBytes: f.apng.length }); let inspected = 0;
  const fetchObject = f.objectFetch(f.apng, 'image/png');
  globalThis.fetch = (...args) => { inspected++; return fetchObject(...args); };
  const first = await complete(s); assert.equal(first.statusCode, 422, first.body);
  assert.equal(first.json().error.code, 'MEDIA_CONTENT_INVALID');
  const state = await rows(s); assert.equal(state.integrity_failure_code, 'MEDIA_FORMAT_UNSUPPORTED');
  assert.equal(state.asset_status, 'quarantined'); assert.equal(state.session_status, 'failed');
  const count = inspected;
  for (let i = 0; i < 3; i++) {
    const retry = await complete(s); assert.equal(retry.statusCode, 409); assert.equal(retry.json().error.code, 'UPLOAD_SESSION_FAILED');
  }
  assert.equal(inspected, count); assert.deepEqual(await rows(s), state); assert.equal((await audits(s)).length, 2);
});
for (const transport of ['timeout', 'truncated']) test(`range ${transport} is retryable and does not quarantine`, async () => {
  const s = await session(), fetchObject = f.objectFetch(f.png, 'image/png');
  globalThis.fetch = async (url, init) => {
    if (init.method === 'HEAD') return fetchObject(url, init);
    if (transport === 'timeout') throw new DOMException('timed out', 'TimeoutError');
    return new Response(f.png.subarray(0, -1), { status: 206, headers: {
      'content-range': `bytes 0-${f.png.length - 1}/${f.png.length}`, 'content-length': String(f.png.length), etag: '"opaque-etag-not-sha256"' } });
  };
  const before = await rows(s), response = await complete(s);
  assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'MEDIA_STORAGE_UNAVAILABLE');
  assert.deepEqual(await rows(s), before); assert.equal((await audits(s)).length, 1);
  globalThis.fetch = f.objectFetch(f.png, 'image/png'); assert.equal((await complete(s)).statusCode, 200);
});

test('delayed HEAD and range hold neither transaction nor media locks; unrelated tenant operation completes', async () => {
  const s = await session(), fetchObject = f.objectFetch(f.png, 'image/png');
  let enteredResolve, releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let checked = 0;
  globalThis.fetch = async (url, init) => {
    // The API pool is idle, with Phase A released, during BOTH HEAD and GET.
    const active = await h.admin`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND usename <> current_user AND state='idle in transaction'`;
    assert.equal(active.length, 0, 'no retained API transaction during R2'); checked++;
    if (init.method === 'HEAD') { enteredResolve(); await release; }
    return fetchObject(url, init);
  };
  const pending = complete(s);
  try {
    await entered;
    await h.admin.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout='250ms'`;
      await tx`SELECT id FROM upload_sessions WHERE id=${s.uploadSessionId} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM media_assets WHERE id=${s.mediaAssetId} FOR UPDATE NOWAIT`;
    });
    const unrelated = await create({}, b);
    assert.equal(unrelated.statusCode, 201, unrelated.body);
    const before = await rows(s); assert.equal(before.session_status, 'pending');
  } finally { releaseResolve(); }
  assert.equal((await pending).statusCode, 200); assert.ok(checked >= 2);
});
for (const mutation of ['mime', 'expiry', 'delete', 'membership']) test(`Phase C rejects ${mutation} changed during R2 inspection`, async () => {
  const fresh = mutation === 'membership' ? (await h.twoTenants()).a : a;
  const actor = mutation === 'membership' ? { ...fresh, owner: fresh.advisor } : a;
  const made = await create({}, actor); assert.equal(made.statusCode, 201);
  const s = made.json(), fetchObject = f.objectFetch(f.png, 'image/png'); let changed = false;
  globalThis.fetch = async (url, init) => {
    if (!changed) {
      changed = true;
      if (mutation === 'mime') await h.admin`UPDATE media_assets SET mime_type='image/jpeg' WHERE id=${s.mediaAssetId}`;
      if (mutation === 'expiry') await h.admin`UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE id=${s.uploadSessionId}`;
      if (mutation === 'delete') await h.admin`UPDATE media_assets SET deletion_requested_at=now() WHERE id=${s.mediaAssetId}`;
      if (mutation === 'membership') await h.admin`UPDATE memberships SET status='suspended', suspended_at=now() WHERE id=${actor.owner.membershipId}`;
    }
    return fetchObject(url, init);
  };
  {
    const response = await complete(s, {}, actor); assert.ok([403, 404, 409].includes(response.statusCode), response.body);
    const state = await rows(s); assert.equal(state.asset_status, 'pending_upload'); assert.equal(state.completed_at, null);
    assert.equal(state.session_status, mutation === 'expiry' ? 'expired' : 'pending');
    assert.equal((await audits(s)).length, mutation === 'expiry' ? 2 : 1);
  }
});
for (const compressed of [false, true]) test(`xref PDF stream completes compressed=${compressed}`, async () => {
  const bytes = f.xrefPdf(compressed), s = await session({ mediaType: 'quote_pdf', mimeType: 'application/pdf', retentionClass: 'document', expectedSizeBytes: bytes.length });
  globalThis.fetch = f.objectFetch(bytes, 'application/pdf'); assert.equal((await complete(s)).statusCode, 200);
});

for (const [extension, mime, type] of [['mp4', 'video/mp4', 'video'], ['mov', 'video/quicktime', 'video360']]) test(`fragmented ${extension} completes bounded structural inspection`, async () => {
  const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, `../media/fixtures/fragmented.${extension}`));
  const s = await operationalFixture(bytes, type, mime); globalThis.fetch = f.objectFetch(bytes, mime);
  assert.equal((await complete(s)).statusCode, 200);
});

test('previous main writer is rejected atomically after 0025; compatible writer recovers without weakening legacy guard', async () => {
  const media = randomUUID(), id = randomUUID(), tenant = { tenantId: a.tenantId, userId: a.owner.user.id, membershipId: a.owner.membershipId };
  await assert.rejects(h.asRuntime(h.apiPool, tenant, async (sql) => {
    // Same column lists as previous main createUploadSession (no v1 expectation).
    await sql`INSERT INTO media_assets (id,tenant_id,storage_provider,bucket,object_key,media_type,mime_type,
      status,retention_class,retention_policy_version,created_by_membership_id)
      VALUES (${media},${a.tenantId},'cloudflare_r2',${f.r2.bucket},${media},'signature','image/png',
        'pending_upload','authorization_evidence','v1',${a.owner.membershipId})`;
    await sql`INSERT INTO upload_sessions (id,tenant_id,media_asset_id,idempotency_key,status,expires_at,created_by_membership_id)
      VALUES (${id},${a.tenantId},${media},${randomUUID()},'pending',now()+interval '1 hour',${a.owner.membershipId})`;
  }), (e) => e.code === '23514' && e.constraint_name === 'upload_sessions_integrity_expectation_check');
  const [count] = await h.admin`SELECT count(*)::int AS n FROM media_assets WHERE id=${media}`; assert.equal(count.n, 0);
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
  assert.equal((await complete(s)).statusCode, 200);
  const { assertMediaIntegritySchema } = h.load('media/deployment.js');
  await assertMediaIntegritySchema(h.apiPool);
});
