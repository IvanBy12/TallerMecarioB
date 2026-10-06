'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const postgres = require('postgres');
const { withR2Stage, getTransientFailures } = require('./r2-transport.cjs');

const apiModulePath = process.env.TEST_API_APP_MODULE;
const routesModulePath = process.env.TEST_MEDIA_ROUTES_MODULE;
const r2ModulePath = process.env.TEST_MEDIA_R2_MODULE;
if (!apiModulePath || !routesModulePath || !r2ModulePath) {
  throw new Error('TEST_API_APP_MODULE, TEST_MEDIA_ROUTES_MODULE and TEST_MEDIA_R2_MODULE are required');
}
const { buildApi } = require(apiModulePath);
const { registerMediaRoutes } = require(routesModulePath);
const { loadR2ConfigFromEnv, deleteR2Object, headR2Object } = require(r2ModulePath);

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
const runtimeLogin = process.env.TEST_RUNTIME_LOGIN;
const runtimePassword = process.env.TEST_RUNTIME_PASSWORD;
if (!adminUrl || !runtimeLogin || !runtimePassword) {
  throw new Error('Disposable database and runtime login are required');
}

const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Refusing to run media integration tests against a non-local host');
}

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const runtimeUrl = new URL(adminUrl);
runtimeUrl.username = runtimeLogin;
runtimeUrl.password = runtimePassword;
const database = postgres(runtimeUrl.toString(), {
  max: 4,
  onnotice: () => {},
  connection: { role: 'tallermecario_api' },
});

// Real R2 credentials from .env (scripts/test-media-r2.cjs is run with
// --env-file=.env and forwards process.env to this child process). Never
// printed/logged; used only to sign requests and to clean up afterwards.
const r2 = loadR2ConfigFromEnv();
const createdObjectKeys = new Set();

const fixture = {
  tenantA: randomUUID(),
  tenantB: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  membershipA: randomUUID(),
  membershipB: randomUUID(),
  subjectA: `subject-a-${randomUUID()}`,
  subjectB: `subject-b-${randomUUID()}`,
};

const identities = new Map([
  ['token-a', fixture.subjectA],
  ['token-b', fixture.subjectB],
]);

let app;

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function samplePngBytes() {
  return readFileSync(join(__dirname, 'fixtures/pixel.png'));
}

function fetchR2(stage, url, options = {}, readBytes = false) {
  return withR2Stage(stage, options.method ?? 'GET', async () => {
    const response = await fetch(url, options);
    if (process.env.R2_EXTERNAL_GATE === '1') {
      process.stdout.write(`R2_HTTP ${stage} ${options.method ?? 'GET'} status=${response.status}\n`);
    }
    if (!readBytes || !response.ok) return { response };
    // Read inside the retry boundary: the peer can close after fetch resolves.
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  });
}

function headR2(stage, objectKey) {
  return withR2Stage(stage, 'HEAD', () => headR2Object(r2, objectKey));
}

function deleteR2(stage, objectKey) {
  return withR2Stage(stage, 'DELETE', () => deleteR2Object(r2, objectKey));
}

test.before(async () => {
  await admin.begin(async (sql) => {
    await sql`SET LOCAL session_replication_role = replica`;
    await sql`INSERT INTO workshops ${sql([
      { id: fixture.tenantA, slug: `a-${fixture.tenantA}`, legal_name: 'Tenant A', display_name: 'Tenant A' },
      { id: fixture.tenantB, slug: `b-${fixture.tenantB}`, legal_name: 'Tenant B', display_name: 'Tenant B' },
    ])}`;
    await sql`INSERT INTO users ${sql([
      { id: fixture.userA, external_subject: fixture.subjectA, email: `${fixture.userA}@test.invalid` },
      { id: fixture.userB, external_subject: fixture.subjectB, email: `${fixture.userB}@test.invalid` },
    ])}`;
    await sql`INSERT INTO memberships ${sql([
      { id: fixture.membershipA, tenant_id: fixture.tenantA, user_id: fixture.userA },
      { id: fixture.membershipB, tenant_id: fixture.tenantB, user_id: fixture.userB },
    ])}`;
    // S1-02: media routes require media.upload / media.read from PostgreSQL RBAC.
    await sql`
      INSERT INTO membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      SELECT m.tenant_id, m.id, r.id, m.id
      FROM public.memberships AS m CROSS JOIN public.roles AS r
      WHERE m.id IN (${fixture.membershipA}, ${fixture.membershipB}) AND r.code = 'owner'
    `;
  });

  app = await buildApi({
    database,
    identityProvider: {
      async verifyRequest(request) {
        const authorization = request.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return null;
        const externalSubject = identities.get(authorization.slice(7));
        return externalSubject ? { identityProvider: 'clerk', externalSubject } : null;
      },
    },
    async registerRoutes(server) {
      registerMediaRoutes(server, r2);
    },
  });
});

test.after(async () => {
  if (app) await app.close();

  const cleanupFailures = [];
  for (const objectKey of createdObjectKeys) {
    try {
      await deleteR2('CLEANUP_DELETE', objectKey);
    } catch (error) {
      cleanupFailures.push(error.message);
    }
  }
  let allDeleted = true;
  for (const objectKey of createdObjectKeys) {
    try {
      const head = await headR2('CLEANUP_HEAD', objectKey);
      if (head.exists) {
        allDeleted = false;
        cleanupFailures.push('R2 CLEANUP_HEAD confirmed object still exists');
      }
    } catch (error) {
      allDeleted = false;
      cleanupFailures.push(error.message);
    }
  }

  await database.end({ timeout: 5 });
  await admin.end({ timeout: 5 });

  assert.equal(allDeleted, true,
    `R2 cleanup could not confirm deletion: ${cleanupFailures.join('; ')}`);
  process.stdout.write('R2_OBJECT_CLEANUP_PASS\n');
  if (process.env.R2_EXTERNAL_GATE === '1') {
    assert.equal(getTransientFailures(), 0, 'External gate requires zero transient transport failures, including recovered retries');
    process.stdout.write('R2_TRANSPORT_STABILITY_PASS\n');
  }
});

test('full R2 flow: create session, upload real bytes, complete, and download them back', async () => {
  const idempotencyKey = randomUUID();
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-sessions',
    headers: auth('token-a'),
    payload: { mediaType: 'document', mimeType: 'image/png', retentionClass: 'document', expectedSizeBytes: samplePngBytes().length, idempotencyKey },
  });
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);
  assert.equal(created.uploadMethod, 'PUT');
  assert.deepEqual(created.uploadHeaders, { 'Content-Type': 'image/png', 'If-None-Match': '*' });

  const bytes = samplePngBytes();
  const { response: putResponse } = await fetchR2('FULL_FLOW_INITIAL_PUT', created.uploadUrl, {
    method: created.uploadMethod,
    headers: created.uploadHeaders,
    body: bytes,
  });
  assert.equal(putResponse.ok, true, `R2 PUT failed: ${putResponse.status}`);

  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const completeResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-a'),
    payload: { checksumSha256 },
  });
  assert.equal(completeResponse.statusCode, 200);
  const completed = completeResponse.json();
  assert.equal(completed.status, 'active');
  assert.equal(completed.sizeBytes, bytes.length);
  assert.equal(completed.checksumSha256, checksumSha256);

  const [assetRow] = await admin`
    SELECT status, size_bytes, checksum_sha256 FROM media_assets WHERE id = ${created.mediaAssetId}
  `;
  assert.equal(assetRow.status, 'active');
  assert.equal(Number(assetRow.size_bytes), bytes.length);

  const downloadResponse = await app.inject({
    method: 'GET',
    url: `/api/v1/media/${created.mediaAssetId}/download-url`,
    headers: auth('token-a'),
  });
  assert.equal(downloadResponse.statusCode, 200);
  const { downloadUrl } = downloadResponse.json();

  const { response: getResponse, bytes: downloaded } = await fetchR2(
    'FULL_FLOW_DOWNLOAD_GET', downloadUrl, {}, true);
  assert.equal(getResponse.ok, true, `FULL_FLOW_DOWNLOAD_GET HTTP ${getResponse.status}`);
  assert.equal(downloaded.equals(bytes), true, 'downloaded bytes must match the uploaded bytes exactly');
});

test('idempotency: retrying create-upload-session with the same key returns the same session, no duplicate rows', async () => {
  const idempotencyKey = randomUUID();
  const payload = { mediaType: 'document', mimeType: 'application/pdf', retentionClass: 'document', expectedSizeBytes: 100, idempotencyKey };

  const first = await app.inject({ method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('token-a'), payload });
  assert.equal(first.statusCode, 201);
  const firstBody = first.json();
  createdObjectKeys.add(firstBody.objectKey);

  const second = await app.inject({ method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('token-a'), payload });
  assert.equal(second.statusCode, 201);
  const secondBody = second.json();
  assert.equal(secondBody.uploadSessionId, firstBody.uploadSessionId);
  assert.equal(secondBody.mediaAssetId, firstBody.mediaAssetId);
  assert.equal(secondBody.objectKey, firstBody.objectKey);
  assert.deepEqual(secondBody.uploadHeaders, firstBody.uploadHeaders);

  const rows = await admin`SELECT id FROM upload_sessions WHERE idempotency_key = ${idempotencyKey}`;
  assert.equal(rows.length, 1, 'a retried create must not insert a second upload_sessions row');
  const assetRows = await admin`SELECT id FROM media_assets WHERE id = ${firstBody.mediaAssetId}`;
  assert.equal(assetRows.length, 1);
});

test('an expired upload session is rejected at complete time and flips to expired', async () => {
  const idempotencyKey = randomUUID();
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-sessions',
    headers: auth('token-a'),
    payload: { mediaType: 'document', mimeType: 'image/png', retentionClass: 'document', expectedSizeBytes: samplePngBytes().length, idempotencyKey },
  });
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);

  await admin`UPDATE upload_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${created.uploadSessionId}`;

  const completeResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-a'),
    payload: {},
  });
  assert.equal(completeResponse.statusCode, 409);
  assert.equal(completeResponse.json().error.code, 'UPLOAD_SESSION_EXPIRED');

  const [row] = await admin`SELECT status FROM upload_sessions WHERE id = ${created.uploadSessionId}`;
  assert.equal(row.status, 'expired');
});

test('completing before the object reaches R2 fails without mutating asset state', async () => {
  const idempotencyKey = randomUUID();
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-sessions',
    headers: auth('token-a'),
    payload: { mediaType: 'document', mimeType: 'image/png', retentionClass: 'document', expectedSizeBytes: samplePngBytes().length, idempotencyKey },
  });
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey); // never uploaded; delete-on-cleanup is a safe no-op

  const completeResponse = await app.inject({
    method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-a'),
    payload: {},
  });
  assert.equal(completeResponse.statusCode, 409);
  assert.equal(completeResponse.json().error.code, 'UPLOAD_NOT_FOUND_IN_STORAGE');

  const [row] = await admin`SELECT status FROM media_assets WHERE id = ${created.mediaAssetId}`;
  assert.equal(row.status, 'pending_upload');
});

test('cross-tenant: tenant B cannot complete or read tenant A media through the API', async () => {
  const idempotencyKey = randomUUID();
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-sessions',
    headers: auth('token-a'),
    payload: { mediaType: 'document', mimeType: 'image/png', retentionClass: 'document', expectedSizeBytes: samplePngBytes().length, idempotencyKey },
  });
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);

  const bytes = samplePngBytes();
  const { response: putResponse } = await fetchR2('CROSS_TENANT_INITIAL_PUT', created.uploadUrl, {
    method: created.uploadMethod, headers: created.uploadHeaders, body: bytes,
  });
  assert.equal(putResponse.ok, true);

  const crossComplete = await app.inject({
    method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-b'),
    payload: {},
  });
  assert.equal(crossComplete.statusCode, 404);
  assert.equal(crossComplete.json().error.code, 'UPLOAD_SESSION_NOT_FOUND');

  const ownComplete = await app.inject({
    method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-a'),
    payload: {},
  });
  assert.equal(ownComplete.statusCode, 200);

  const crossDownload = await app.inject({
    method: 'GET',
    url: `/api/v1/media/${created.mediaAssetId}/download-url`,
    headers: auth('token-b'),
  });
  assert.equal(crossDownload.statusCode, 404);
  assert.equal(crossDownload.json().error.code, 'MEDIA_ASSET_NOT_FOUND');

  const ownDownload = await app.inject({
    method: 'GET',
    url: `/api/v1/media/${created.mediaAssetId}/download-url`,
    headers: auth('token-a'),
  });
  assert.equal(ownDownload.statusCode, 200);

  const [row] = await admin`SELECT tenant_id FROM media_assets WHERE id = ${created.mediaAssetId}`;
  assert.equal(row.tenant_id, fixture.tenantA);
});

test('signed reception evidence survives replay and unsigned-header attempts on the same PUT URL', async () => {
  const createResponse = await app.inject({
    method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('token-a'),
    payload: { mediaType: 'signature', mimeType: 'image/png', retentionClass: 'authorization_evidence', expectedSizeBytes: samplePngBytes().length,
      idempotencyKey: randomUUID() },
  });
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);
  assert.deepEqual(created.uploadHeaders, { 'Content-Type': 'image/png', 'If-None-Match': '*' });
  assert.equal(new URL(created.uploadUrl).searchParams.get('X-Amz-SignedHeaders'),
    'content-type;host;if-none-match');
  const original = samplePngBytes();
  const changed = Buffer.from(original); changed[45] ^= 1;
  const send = async (stage, url, headers, bytes) =>
    (await fetchR2(stage, url, { method: 'PUT', headers, body: bytes })).response;

  const withoutCondition = await send('SIGNATURE_MISSING_CONDITION_PUT',
    created.uploadUrl, { 'Content-Type': 'image/png' }, original);
  assert.equal(withoutCondition.status, 403, 'missing signed condition must not create the object');
  const wrongCondition = await send('SIGNATURE_WRONG_CONDITION_PUT', created.uploadUrl,
    { 'Content-Type': 'image/png', 'If-None-Match': '"other"' }, original);
  assert.equal(wrongCondition.status, 403, 'changed signed condition must not create the object');
  const tamperedId = randomUUID();
  const tamperedKey = created.uploadUrl.replace(created.mediaAssetId, tamperedId);
  const tamperedObjectKey = created.objectKey.replace(created.mediaAssetId, tamperedId);
  createdObjectKeys.add(tamperedObjectKey);
  assert.notEqual(tamperedKey, created.uploadUrl);
  const wrongKey = await send('SIGNATURE_TAMPERED_KEY_PUT', tamperedKey, created.uploadHeaders, original);
  assert.equal(wrongKey.status, 403, 'changing the signed object key must fail');
  assert.equal((await headR2('SIGNATURE_ORIGINAL_BEFORE_HEAD', created.objectKey)).exists, false);
  assert.equal((await headR2('SIGNATURE_TAMPERED_BEFORE_HEAD', tamperedObjectKey)).exists, false);

  const firstPut = await send('SIGNATURE_FIRST_VALID_PUT', created.uploadUrl, created.uploadHeaders, original);
  assert.equal(firstPut.ok, true, `first write-once R2 PUT failed: ${firstPut.status}`);
  const before = await headR2('SIGNATURE_FIRST_VALID_HEAD', created.objectKey);
  assert.equal(before.exists, true);
  assert.equal(before.sizeBytes, original.length);
  const checksumSha256 = createHash('sha256').update(original).digest('hex');
  const complete = await app.inject({ method: 'POST',
    url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
    headers: auth('token-a'), payload: { checksumSha256 } });
  assert.equal(complete.statusCode, 200);
  assert.equal(complete.json().checksumSha256, checksumSha256);

  const customer = randomUUID(), vehicle = randomUUID(), consent = randomUUID();
  const reception = randomUUID(), signature = randomUUID();
  await database.begin(async (sql) => {
    await sql`SELECT set_config('app.tenant_id', ${fixture.tenantA}, true)`;
    await sql`INSERT INTO customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${fixture.tenantA},'Signed','Evidence','3000000002')`;
    await sql`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
      VALUES (${vehicle},${fixture.tenantA},${`S${vehicle.slice(0, 6).toUpperCase()}`},'car','B','M')`;
    await sql`INSERT INTO vehicle_owners
      (id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES (${randomUUID()},${fixture.tenantA},${vehicle},${customer},'owner',true)`;
    await sql`INSERT INTO privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
        authorization_text_hash,channel,captured_at,controller_notice_snapshot)
      VALUES (${consent},${fixture.tenantA},${customer},'service_provision','test-notice-1',
        'test-service-1',${'f'.repeat(64)},'in_person',now(),
        ${sql.json({ legalName: 'TEST-ONLY', address: 'TEST-ONLY', phone: '+5700000000',
          email: null, rightsChannel: 'TEST-ONLY' })})`;
    await sql`INSERT INTO receptions
      (id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
      VALUES (${reception},${fixture.tenantA},${vehicle},${customer},${consent},${fixture.membershipA},0)`;
    await sql`INSERT INTO signatures (id,tenant_id,reception_id,signed_by_name,signature_media_id,
      signed_at,document_version,document_hash)
      VALUES (${signature},${fixture.tenantA},${reception},'Signed Evidence',${created.mediaAssetId},
      now(),'v1',${checksumSha256})`;
  });

  const sameReplay = await send('SIGNATURE_REPLAY_SAME_PUT', created.uploadUrl, created.uploadHeaders, original);
  assert.equal(sameReplay.status, 412, 'same-byte replay must fail with PreconditionFailed');
  const changedReplay = await send('SIGNATURE_REPLAY_CHANGED_PUT', created.uploadUrl, created.uploadHeaders, changed);
  assert.equal(changedReplay.status, 412, 'different-byte replay must fail with PreconditionFailed');
  const after = await headR2('SIGNATURE_REPLAY_AFTER_HEAD', created.objectKey);
  assert.equal(after.sizeBytes, before.sizeBytes);
  assert.equal(after.etag, before.etag);
  const download = await app.inject({ method: 'GET',
    url: `/api/v1/media/${created.mediaAssetId}/download-url`, headers: auth('token-a') });
  assert.equal(download.statusCode, 200);
  const { response: signatureGet, bytes: stored } = await fetchR2(
    'SIGNATURE_DOWNLOAD_GET', download.json().downloadUrl, {}, true);
  assert.equal(signatureGet.ok, true, `SIGNATURE_DOWNLOAD_GET HTTP ${signatureGet.status}`);
  assert.equal(stored.equals(original), true, 'signed R2 bytes must remain the original bytes');
  const [row] = await admin`SELECT signature_media_id FROM signatures WHERE id=${signature}`;
  assert.equal(row.signature_media_id, created.mediaAssetId);
  await database.begin(async (sql) => {
    await sql`SELECT set_config('app.tenant_id', ${fixture.tenantA}, true)`;
    await sql`UPDATE media_assets SET status='quarantined' WHERE id=${created.mediaAssetId}`;
  });
  const denied = await app.inject({ method: 'GET',
    url: `/api/v1/media/${created.mediaAssetId}/download-url`, headers: auth('token-a') });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, 'MEDIA_ASSET_NOT_ACTIVE');
  const [historical] = await admin`SELECT signature_media_id FROM signatures WHERE id=${signature}`;
  assert.equal(historical.signature_media_id, created.mediaAssetId);
  const [quarantined] = await admin`SELECT status,object_key FROM media_assets WHERE id=${created.mediaAssetId}`;
  assert.deepEqual([quarantined.status, quarantined.object_key], ['quarantined', created.objectKey]);
  const retained = await headR2('SIGNATURE_QUARANTINED_HEAD', created.objectKey);
  assert.deepEqual([retained.exists, retained.sizeBytes, retained.etag],
    [true, before.sizeBytes, before.etag]);
});
