'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const postgres = require('postgres');

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
  return Buffer.from(`fake-photo-bytes-${randomUUID()}`.repeat(64), 'utf8');
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

  for (const objectKey of createdObjectKeys) {
    await deleteR2Object(r2, objectKey).catch(() => undefined);
  }
  let allDeleted = true;
  for (const objectKey of createdObjectKeys) {
    const head = await headR2Object(r2, objectKey).catch(() => ({ exists: true }));
    if (head.exists) allDeleted = false;
  }

  await database.end({ timeout: 5 });
  await admin.end({ timeout: 5 });

  assert.equal(allDeleted, true, 'R2 cleanup left orphaned test objects behind');
});

test('full R2 flow: create session, upload real bytes, complete, and download them back', async () => {
  const idempotencyKey = randomUUID();
  const createResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/media/upload-sessions',
    headers: auth('token-a'),
    payload: { mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational', idempotencyKey },
  });
  assert.equal(createResponse.statusCode, 201);
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);

  const bytes = samplePngBytes();
  const putResponse = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
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

  const getResponse = await fetch(downloadUrl);
  assert.equal(getResponse.ok, true, `R2 GET failed: ${getResponse.status}`);
  const downloaded = Buffer.from(await getResponse.arrayBuffer());
  assert.equal(downloaded.equals(bytes), true, 'downloaded bytes must match the uploaded bytes exactly');
});

test('idempotency: retrying create-upload-session with the same key returns the same session, no duplicate rows', async () => {
  const idempotencyKey = randomUUID();
  const payload = { mediaType: 'document', mimeType: 'application/pdf', retentionClass: 'document', idempotencyKey };

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
    payload: { mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational', idempotencyKey },
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
    payload: { mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational', idempotencyKey },
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
    payload: { mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational', idempotencyKey },
  });
  const created = createResponse.json();
  createdObjectKeys.add(created.objectKey);

  const bytes = samplePngBytes();
  const putResponse = await fetch(created.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
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
