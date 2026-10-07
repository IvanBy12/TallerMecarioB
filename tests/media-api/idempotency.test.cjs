'use strict';
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { Writable } = require('node:stream');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { uploadCreateLockKey } = h.load('media/service.js');
const f = require('../media/fixtures.cjs');
let app, a, b, port;
const originalFetch = globalThis.fetch;
before(async () => {
  ({ a, b } = await h.twoTenants());
  app = await buildApi({ database: h.apiPool, logStream: new Writable({ write(_chunk, _encoding, done) { done(); } }), identityProvider: {
    async verifyRequest(request) {
      const subject = request.headers.authorization?.slice(7);
      return subject ? { identityProvider: 'clerk', externalSubject: subject } : null;
    } }, rateLimit: { max: 100000, timeWindow: '1 minute' }, registerRoutes(server) {
      // Raise the test fixture's request budget BEFORE rate-limit registration;
      // production routes retain their 30/min limit. Real HTTP uses one loopback IP.
      const post = server.post;
      server.post = function (url, options, handler) {
        options.config.rateLimit = { max: 100000, timeWindow: '1 minute' };
        return post.call(this, url, options, handler);
      };
      try { registerMediaRoutes(server, f.r2); } finally { server.post = post; }
    } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = app.server.address().port;
});
after(async () => { globalThis.fetch = originalFetch; await h.closeAll(app); });
// Real, distinct HTTP connections; the fetch mock applies only to R2 inspection.
function call(path, payload, tenant = a, actor = tenant.owner) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      ...(actor ? { authorization: `Bearer ${actor.subject}` } : {}), 'x-tenant-id': tenant.tenantId,
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}
const payload = (extra = {}) => ({ mediaType: 'signature', mimeType: 'image/png', retentionClass: 'authorization_evidence',
  idempotencyKey: randomUUID(), expectedSizeBytes: f.png.length, ...extra });
const create = (body, tenant = a, actor) => call('/api/v1/media/upload-sessions', body, tenant, actor);
const complete = (s, body = {}, tenant = a, actor) => call(`/api/v1/media/upload-sessions/${s.uploadSessionId}/complete`, body, tenant, actor);
async function session(body = payload(), tenant = a) {
  const result = await create(body, tenant); assert.equal(result.status, 201, JSON.stringify(result)); return result.body;
}
const mismatch = (result) => { assert.equal(result.status, 409, JSON.stringify(result)); assert.equal(result.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH'); };
async function snapshot(s) {
  const [row] = await h.admin`SELECT row_to_json(us) AS session, row_to_json(ma) AS asset
    FROM upload_sessions us JOIN media_assets ma ON ma.tenant_id=us.tenant_id AND ma.id=us.media_asset_id
    WHERE us.id=${s.uploadSessionId}`;
  return { ...row };
}
async function counts(body, tenant = a) {
  const [row] = await h.admin`SELECT
    (SELECT count(*)::int FROM media_assets WHERE tenant_id=${tenant.tenantId}) AS assets,
    (SELECT count(*)::int FROM upload_sessions WHERE tenant_id=${tenant.tenantId} AND idempotency_key=${body.idempotencyKey}) AS sessions,
    (SELECT count(*)::int FROM audit_logs al JOIN upload_sessions us ON us.tenant_id=al.tenant_id AND us.media_asset_id=al.entity_id
      WHERE us.tenant_id=${tenant.tenantId} AND us.idempotency_key=${body.idempotencyKey} AND al.action='media.upload_session_created') AS created`;
  return row;
}
async function auditCount(s, action) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=${a.tenantId} AND entity_id=${s.mediaAssetId} AND action=${action}`;
  return row.n;
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'barrier reached before deadline'); await yieldTurn(); }
}
async function createRace(body, bodies, tenant = a) {
  const sql = await h.admin.reserve(); let pending, barrierError;
  try {
    await sql`BEGIN`;
    await sql`SELECT pg_advisory_xact_lock(${uploadCreateLockKey(tenant.tenantId, body.idempotencyKey)}::bigint)`;
    pending = Promise.all(bodies.map((candidate) => create(candidate, tenant)));
    // Every distinct request must wait on the same key BEFORE the absent-row read.
    await until(async () => {
      const [row] = await h.admin`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
      return row.n === bodies.length;
    });
  } catch (error) { barrierError = error; }
  finally { await sql`ROLLBACK`; sql.release(); }
  const results = await pending;
  if (barrierError) throw barrierError;
  return results;
}
async function completeRace(s, bodies, bytes = f.png, whileBlocked = async () => {}) {
  const transport = f.objectFetch(bytes, 'image/png');
  let seen = 0, releaseResolve, barrierError;
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  globalThis.fetch = async (url, init) => {
    if (init.method === 'HEAD') { seen++; await release; }
    return transport(url, init);
  };
  const pending = Promise.all(bodies.map((body) => complete(s, body)));
  try { await until(async () => seen === bodies.length); await whileBlocked(); }
  catch (error) { barrierError = error; }
  finally { releaseResolve(); }
  const results = await pending;
  if (barrierError) throw barrierError;
  return results;
}
function signedExpiry(s) {
  const params = new URL(s.uploadUrl).searchParams;
  const start = Date.parse(params.get('X-Amz-Date').replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
  const ttl = Number(params.get('X-Amz-Expires'));
  assert.ok(ttl >= 1 && ttl <= 900); assert.ok(start + ttl * 1000 <= Date.parse(s.expiresAt));
  return ttl;
}
test('equivalent sequential create preserves IDs, key, expiry, rows and one audit; UUID spelling canonicalizes', async () => {
  const body = payload(), before = await counts(body), s = await session(body);
  const result = await create({ ...body, idempotencyKey: body.idempotencyKey.toUpperCase() });
  assert.equal(result.status, 201);
  for (const key of ['uploadSessionId', 'mediaAssetId', 'objectKey', 'expiresAt']) assert.equal(result.body[key], s[key]);
  signedExpiry(s); signedExpiry(result.body);
  const after = await counts(body); assert.equal(after.assets - before.assets, 1); assert.equal(after.sessions, 1); assert.equal(after.created, 1);
});
for (const [first, second] of [
  ['2026-10-07T10:00:00-05:00', '2026-10-07T15:00:00Z'],
  ['2026-10-07T15:00:00.120000Z', '2026-10-07T15:00:00.12Z'],
  ['2026-10-07T15:00:00.123456Z', '2026-10-07T10:00:00.123456-05:00'],
]) test(`capturedAt compares persisted instants: ${first}`, async () => {
  const body = payload({ capturedAt: first }), s = await session(body);
  const result = await create({ ...body, capturedAt: second });
  assert.equal(result.status, 201); assert.equal(result.body.uploadSessionId, s.uploadSessionId);
});
for (const [name, original, change] of [
  ['size', {}, { expectedSizeBytes: f.png.length + 1 }],
  ['MIME', { mediaType: 'document', retentionClass: 'document' }, { mimeType: 'image/jpeg' }],
  ['type/class', {}, { mediaType: 'document', retentionClass: 'document' }],
  ['absent to present', {}, { capturedAt: '2026-10-07T15:00:00Z' }],
  ['present to absent', { capturedAt: '2026-10-07T15:00:00Z' }, { capturedAt: undefined }],
  ['different instant', { capturedAt: '2026-10-07T15:00:00Z' }, { capturedAt: '2026-10-07T15:00:01Z' }],
  ['submillisecond instant', { capturedAt: '2026-10-07T15:00:00.123456Z' }, { capturedAt: '2026-10-07T15:00:00.123457Z' }],
]) test(`create semantic mismatch ${name}`, async () => {
  const body = payload(original), s = await session(body), before = await snapshot(s);
  mismatch(await create({ ...body, ...change })); assert.deepEqual(await snapshot(s), before);
});
for (const [state, code] of [['completed', 'UPLOAD_SESSION_ALREADY_COMPLETED'], ['failed', 'UPLOAD_SESSION_FAILED'], ['expired', 'UPLOAD_SESSION_EXPIRED']]) {
  test(`create ${state}: mismatch precedes status, equivalent returns stable outcome without mutations`, async () => {
    const body = payload(), s = await session(body);
    if (state === 'expired') await h.admin`UPDATE upload_sessions SET status='expired' WHERE id=${s.uploadSessionId}`;
    else {
      globalThis.fetch = f.objectFetch(state === 'failed' ? Buffer.alloc(f.png.length) : f.png, 'image/png');
      assert.equal((await complete(s)).status, state === 'failed' ? 422 : 200);
    }
    const before = await snapshot(s);
    mismatch(await create({ ...body, expectedSizeBytes: f.png.length + 1 }));
    const equivalent = await create(body); assert.equal(equivalent.status, 409); assert.equal(equivalent.body.error.code, code);
    assert.deepEqual(await snapshot(s), before); assert.equal(await auditCount(s, 'media.upload_session_created'), 1);
  });
}
test('eight equivalent absent-key HTTP creates wait at PostgreSQL barrier and produce one asset/session/audit', async () => {
  const body = payload(), before = await counts(body);
  const results = await createRace(body, Array.from({ length: 8 }, (_, i) => ({ ...body, idempotencyKey: i % 2 ? body.idempotencyKey.toUpperCase() : body.idempotencyKey })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results));
  for (const r of results) for (const key of ['uploadSessionId', 'mediaAssetId', 'objectKey', 'expiresAt']) assert.equal(r.body[key], results[0].body[key]);
  const after = await counts(body); assert.equal(after.assets - before.assets, 1); assert.equal(after.sessions, 1); assert.equal(after.created, 1);
});
test('incompatible absent-key HTTP creates have one winner and one mismatch without orphan/audit', async () => {
  const body = payload(), alternative = { ...body, mediaType: 'document', retentionClass: 'document' }, before = await counts(body);
  const results = await createRace(body, [body, alternative]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]); mismatch(results.find((r) => r.status === 409));
  const winner = results.find((r) => r.status === 201), row = await snapshot(winner.body);
  assert.equal(row.asset.retention_class, row.asset.media_type === 'signature' ? 'authorization_evidence' : 'document');
  const after = await counts(body); assert.equal(after.assets - before.assets, 1); assert.equal(after.sessions, 1); assert.equal(after.created, 1);
});
test('same UUID in two tenants stays independent even while tenant A coordination lock is held', async () => {
  const body = payload(), sql = await h.admin.reserve(); let first;
  try {
    await sql`BEGIN`; await sql`SELECT pg_advisory_xact_lock(${uploadCreateLockKey(a.tenantId, body.idempotencyKey)}::bigint)`;
    first = create(body); const second = await session(body, b);
    assert.equal((await snapshot(second)).session.tenant_id, b.tenantId);
  } finally { await sql`ROLLBACK`; sql.release(); }
  const result = await first; assert.equal(result.status, 201);
  assert.equal((await counts(body)).created, 1); assert.equal((await counts(body, b)).created, 1);
});
for (const [stored, replay, equivalent] of [
  ['a'.repeat(64), 'A'.repeat(64), true], [undefined, undefined, true],
  ['a'.repeat(64), undefined, false], [undefined, 'a'.repeat(64), false], ['a'.repeat(64), 'b'.repeat(64), false],
]) test(`completed active checksum replay stored=${stored?.slice(0, 1)} replay=${replay?.slice(0, 1)} makes zero HEAD/Range calls`, async () => {
  const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
  const first = await complete(s, { checksumSha256: stored }); assert.equal(first.status, 200);
  const before = await snapshot(s); let heads = 0, ranges = 0;
  assert.equal(before.asset.status, 'active'); assert.equal(before.asset.checksum_sha256, stored ?? null);
  globalThis.fetch = async (_url, init) => { if (init.method === 'HEAD') heads++; else ranges++; throw new Error('replay must not inspect'); };
  const result = await complete(s, { checksumSha256: replay });
  if (equivalent) { assert.equal(result.status, 200); assert.deepEqual(result.body, first.body); } else mismatch(result);
  assert.equal(heads, 0); assert.equal(ranges, 0); assert.deepEqual(await snapshot(s), before); assert.equal(await auditCount(s, 'media.upload_completed'), 1);
});
test('three equivalent completions meet HEAD barrier, return persisted winner and audit once', async () => {
  const s = await session();
  const results = await completeRace(s, [{ checksumSha256: 'a'.repeat(64) }, { checksumSha256: 'A'.repeat(64) }, { checksumSha256: 'a'.repeat(64) }]);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results));
  for (const result of results) assert.deepEqual(result.body, results[0].body);
  const row = await snapshot(s); assert.equal(row.session.status, 'completed'); assert.equal(row.asset.uploaded_at, row.session.completed_at);
  assert.equal(await auditCount(s, 'media.upload_completed'), 1);
  let extra = 0; globalThis.fetch = () => { extra++; throw new Error('fresh replay'); };
  assert.deepEqual((await complete(s, { checksumSha256: 'A'.repeat(64) })).body, results[0].body); assert.equal(extra, 0);
});
test('incompatible concurrent completion cannot rewrite winning declaration', async () => {
  const s = await session(), results = await completeRace(s, [{}, { checksumSha256: 'a'.repeat(64) }]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]); mismatch(results.find((r) => r.status === 409));
  const winner = results.find((r) => r.status === 200), before = await snapshot(s);
  assert.equal(before.asset.checksum_sha256, winner.body.checksumSha256); assert.equal(await auditCount(s, 'media.upload_completed'), 1);
  mismatch(await complete(s, { checksumSha256: winner.body.checksumSha256 === null ? 'a'.repeat(64) : undefined }));
  assert.deepEqual(await snapshot(s), before);
});
for (const [field, code] of [['status', 'MEDIA_ASSET_NOT_ACTIVE'], ['deletion_requested_at', 'MEDIA_ASSET_NOT_FOUND'], ['deleted_at', 'MEDIA_ASSET_NOT_FOUND'], ['purged_at', 'MEDIA_ASSET_NOT_FOUND']]) {
  for (const replay of ['a'.repeat(64), 'b'.repeat(64)]) {
    test(`completed ${field} availability precedes ${replay[0] === 'a' ? 'equivalent' : 'mismatching'} checksum without disclosure`, async () => {
      const s = await session(); globalThis.fetch = f.objectFetch(f.png, 'image/png');
      assert.equal((await complete(s, { checksumSha256: 'a'.repeat(64) })).status, 200);
      if (field === 'status') await h.admin`UPDATE media_assets SET status='quarantined' WHERE id=${s.mediaAssetId}`;
      if (field === 'deletion_requested_at') await h.admin`UPDATE media_assets SET deletion_requested_at=now() WHERE id=${s.mediaAssetId}`;
      if (field === 'deleted_at') await h.admin`UPDATE media_assets SET deleted_at=now() WHERE id=${s.mediaAssetId}`;
      if (field === 'purged_at') await h.admin`UPDATE media_assets SET deleted_at=now(),purged_at=now() WHERE id=${s.mediaAssetId}`;
      const before = await snapshot(s), auditsBefore = await auditCount(s, 'media.upload_completed');
      assert.equal(before.session.status, 'completed'); assert.equal(before.asset.checksum_sha256, 'a'.repeat(64));
      assert.equal(auditsBefore, 1);
      let heads = 0, ranges = 0;
      globalThis.fetch = async (_url, init) => { if (init.method === 'HEAD') heads++; else ranges++; throw new Error('unavailable replay must not inspect'); };
      const result = await complete(s, { checksumSha256: replay });
      assert.equal(result.status, field === 'status' ? 409 : 404);
      assert.equal(result.body.error.code, code); assert.notEqual(result.body.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
      assert.equal(result.body.checksumSha256, undefined);
      assert.equal(heads, 0); assert.equal(ranges, 0);
      // Full rows include checksum, all timestamps and status: no mutation or reactivation.
      assert.deepEqual(await snapshot(s), before);
      assert.equal(await auditCount(s, 'media.upload_completed'), auditsBefore);
    });
  }
}
test('concurrent quarantine has one terminal failure and one audit; loser never activates', async () => {
  const s = await session(), results = await completeRace(s, [{}, {}], Buffer.alloc(f.png.length));
  assert.deepEqual(results.map((r) => r.status).sort(), [409, 422]);
  assert.equal(results.find((r) => r.status === 409).body.error.code, 'UPLOAD_SESSION_FAILED');
  const row = await snapshot(s); assert.equal(row.session.status, 'failed'); assert.equal(row.asset.status, 'quarantined');
  assert.equal(row.session.completed_at, null); assert.equal(await auditCount(s, 'media.quarantined'), 1); assert.equal(await auditCount(s, 'media.upload_completed'), 0);
});
test('expiry after concurrent pending inspections has one durable expiration audit and no activation', async () => {
  const s = await session();
  const results = await completeRace(s, [{}, {}], f.png, () => h.admin`UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE id=${s.uploadSessionId}`);
  for (const result of results) assert.equal(result.body.error.code, 'UPLOAD_SESSION_EXPIRED');
  const row = await snapshot(s); assert.equal(row.session.status, 'expired'); assert.equal(row.asset.status, 'pending_upload');
  assert.equal(await auditCount(s, 'media.upload_session_expired'), 1); assert.equal(await auditCount(s, 'media.upload_completed'), 0);
});
test('concurrent create discovering subsecond expiry emits no URL and exactly one expiration audit', async () => {
  const body = payload(), s = await session(body);
  await h.admin`UPDATE upload_sessions SET expires_at=now()+interval '800 milliseconds' WHERE id=${s.uploadSessionId}`;
  const results = await createRace(body, [body, body, body]);
  for (const result of results) { assert.equal(result.body.error.code, 'UPLOAD_SESSION_EXPIRED'); assert.equal(result.body.uploadUrl, undefined); }
  assert.equal((await snapshot(s)).session.status, 'expired'); assert.equal(await auditCount(s, 'media.upload_session_expired'), 1);
});
test('renewal TTL follows remaining logical lifetime and never changes expires_at', async () => {
  const body = payload(), s = await session(body);
  await h.admin`UPDATE upload_sessions SET expires_at=now()+interval '5 seconds' WHERE id=${s.uploadSessionId}`;
  const before = await snapshot(s), result = await create(body); assert.equal(result.status, 201);
  assert.ok(signedExpiry(result.body) <= 5); assert.equal(Date.parse(result.body.expiresAt), Date.parse(before.session.expires_at));
  assert.deepEqual(await snapshot(s), before);
});
test('authentication/RBAC/tenant context still precede replay and do not reveal operation details', async () => {
  const body = payload(), s = await session(body), before = await snapshot(s);
  for (const actor of [null, a.technician]) {
    const result = await create(body, a, actor); assert.ok([401, 403].includes(result.status)); assert.equal(result.body.uploadSessionId, undefined);
    const finished = await complete(s, {}, a, actor); assert.ok([401, 403].includes(finished.status));
  }
  const foreign = await complete(s, {}, b), absent = await complete({ uploadSessionId: randomUUID() }, {}, b);
  assert.equal(foreign.status, 404); assert.equal(foreign.body.error.code, absent.body.error.code);
  const wrongTenant = await create(body, b, a.owner); assert.equal(wrongTenant.status, 403);
  assert.deepEqual(await snapshot(s), before);
});
test('invalid incoming payload keeps validation precedence over replay semantics', async () => {
  const body = payload(), s = await session(body); globalThis.fetch = f.objectFetch(f.png, 'image/png'); await complete(s);
  assert.equal((await complete(s, { checksumSha256: 'bad' })).body.error.code, 'REQUEST_VALIDATION_FAILED');
  assert.equal((await create({ ...body, mediaType: 'invalid' })).body.error.code, 'MEDIA_TYPE_NOT_ALLOWED');
  assert.equal((await create({ ...body, capturedAt: 'invalid' })).body.error.code, 'REQUEST_VALIDATION_FAILED');
});
test('legacy pending replay stays fail-safe without fabricating expectation or semantic proof', async () => {
  const body = payload(), media = randomUUID(), id = randomUUID();
  await h.admin`INSERT INTO media_assets(id,tenant_id,bucket,object_key,media_type,mime_type,retention_class,retention_policy_version)
    VALUES(${media},${a.tenantId},${f.r2.bucket},${media},'signature','image/png','authorization_evidence','v1')`;
  await h.admin`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,expires_at,integrity_version)
    VALUES(${id},${a.tenantId},${media},${body.idempotencyKey},now()+interval '1 hour','legacy')`;
  const result = await create(body); assert.equal(result.body.error.code, 'UPLOAD_SESSION_EXPIRED');
  const row = await snapshot({ uploadSessionId: id }); assert.equal(row.session.expected_size_bytes, null); assert.equal(row.session.integrity_version, 'legacy');
});
for (const operation of ['HEAD', 'Range']) {
  for (const failure of ['500', 'transport']) test(`${operation} transient ${failure} recovers on exactly one retry outside DB transactions`, async () => {
    const s = await session(), transport = f.objectFetch(f.png, 'image/png'); let selectedCalls = 0;
    globalThis.fetch = async (url, init) => {
      const [row] = await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
        AND usename <> current_user AND state='idle in transaction'`;
      assert.equal(row.n, 0);
      if ((init.method === 'HEAD' ? 'HEAD' : 'Range') === operation && ++selectedCalls === 1) {
        if (failure === 'transport') throw new TypeError('private reset');
        return new Response(null, { status: 500 });
      }
      return transport(url, init);
    };
    assert.equal((await complete(s)).status, 200); assert.equal(selectedCalls, 2);
    assert.equal((await snapshot(s)).session.status, 'completed'); assert.equal(await auditCount(s, 'media.upload_completed'), 1);
  });
  test(`${operation} exhaustion is bounded and leaves all persisted fields pending/recoverable`, async () => {
    const s = await session(), before = await snapshot(s), transport = f.objectFetch(f.png, 'image/png'); let selectedCalls = 0;
    globalThis.fetch = async (url, init) => {
      if ((init.method === 'HEAD' ? 'HEAD' : 'Range') === operation) { selectedCalls++; return new Response(null, { status: 503 }); }
      return transport(url, init);
    };
    const result = await complete(s); assert.equal(result.status, 503); assert.equal(result.body.error.code, 'MEDIA_STORAGE_UNAVAILABLE');
    assert.equal(selectedCalls, 2); assert.deepEqual(await snapshot(s), before);
    assert.equal(await auditCount(s, 'media.quarantined'), 0); assert.equal(await auditCount(s, 'media.upload_completed'), 0);
    globalThis.fetch = transport; assert.equal((await complete(s)).status, 200);
  });
}
test('deterministic invalid content is inspected once and quarantined without transport retry', async () => {
  const s = await session(), transport = f.objectFetch(Buffer.alloc(f.png.length), 'image/png'); let heads = 0, ranges = 0;
  globalThis.fetch = (url, init) => { if (init.method === 'HEAD') heads++; else ranges++; return transport(url, init); };
  assert.equal((await complete(s)).status, 422); assert.equal(heads, 1); assert.equal(ranges, 1); assert.equal(await auditCount(s, 'media.quarantined'), 1);
});
test('mismatch against effectively expired pending create does not disclose/materialize expiry before equivalence', async () => {
  const body = payload(), s = await session(body);
  await h.admin`UPDATE upload_sessions SET expires_at=now()-interval '1 second' WHERE id=${s.uploadSessionId}`;
  const before = await snapshot(s); mismatch(await create({ ...body, expectedSizeBytes: f.png.length + 1 }));
  assert.deepEqual(await snapshot(s), before); assert.equal(await auditCount(s, 'media.upload_session_expired'), 0);
  assert.equal((await create(body)).body.error.code, 'UPLOAD_SESSION_EXPIRED'); assert.equal(await auditCount(s, 'media.upload_session_expired'), 1);
});
test('one remaining whole second can issue a bounded PUT; subsecond and past expiry issue no capability', async () => {
  for (const remaining of ['1800 milliseconds', '800 milliseconds', '-1 second']) {
    const body = payload(), s = await session(body);
    await h.admin`UPDATE upload_sessions SET expires_at=now()+${remaining}::interval WHERE id=${s.uploadSessionId}`;
    const result = await create(body);
    if (remaining === '1800 milliseconds') { assert.equal(result.status, 201); assert.equal(signedExpiry(result.body), 1); }
    else { assert.equal(result.status, 409); assert.equal(result.body.error.code, 'UPLOAD_SESSION_EXPIRED'); assert.equal(result.body.uploadUrl, undefined); }
  }
});
test('create/audit failure rolls back assets, sessions and advisory locks so a later request can win', async () => {
  const body = payload(), before = await counts(body), remove = await h.injectFailure('audit_logs', "NEW.action = 'media.upload_session_created'");
  try {
    const results = await createRace(body, [body, body]); assert.ok(results.every((r) => r.status === 500));
    const after = await counts(body); assert.equal(after.assets, before.assets); assert.equal(after.sessions, 0); assert.equal(after.created, 0);
  } finally { await remove(); }
  await session(body); assert.equal((await counts(body)).created, 1);
});
