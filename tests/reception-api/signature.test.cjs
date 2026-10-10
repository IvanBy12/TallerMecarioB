'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { RECEPTION_ACCEPTANCE_VERSION, RECEPTION_ACCEPTANCE_TEXT,
  canonicalAcceptanceBytes, acceptanceHash } = h.load('receptions/acceptance-document.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const PIN = '192829413c90bd0a1a58c9301274fa10c608da30e6c4b4c7f38174deea11125e';
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool, identityProvider: provider,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes: (server) => {
      registerReceptionRoutes(server);
      registerMediaRoutes(server, { endpoint: 'https://r2.invalid', region: 'auto',
        bucket: 'test', accessKeyId: 'test', secretAccessKey: 'test' });
    } });
});
after(async () => h.closeAll(app));

test('CANONICAL_ACCEPTANCE_HASH_PIN', () => {
  assert.equal(RECEPTION_ACCEPTANCE_VERSION, 'reception_acceptance_es-CO_v1');
  const bytes = canonicalAcceptanceBytes(RECEPTION_ACCEPTANCE_TEXT);
  assert.equal(bytes.toString('utf8'), RECEPTION_ACCEPTANCE_TEXT);
  assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb, false);
  assert.equal(bytes.at(-1), '.'.charCodeAt(0));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), PIN);
  assert.equal(acceptanceHash(RECEPTION_ACCEPTANCE_TEXT), PIN);
  assert.notEqual(acceptanceHash(`${RECEPTION_ACCEPTANCE_TEXT}\n`), PIN);
  assert.notEqual(acceptanceHash(RECEPTION_ACCEPTANCE_TEXT.replace('vehículo', 'automóvil')), PIN);
  assert.equal(acceptanceHash(RECEPTION_ACCEPTANCE_TEXT.replaceAll('\n', '\r\n')), PIN);
  assert.equal(acceptanceHash(RECEPTION_ACCEPTANCE_TEXT.replace('VEHÍCULO', 'VEHI\u0301CULO')), PIN);
});

async function fixture(tenant) {
  const customer = randomUUID(), vehicle = randomUUID(), consent = randomUUID(), reception = randomUUID();
  await h.admin.begin(async (tx) => {
    await tx`INSERT INTO public.customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant.tenantId},'Firma','Cliente','3000000000')`;
    await tx`INSERT INTO public.vehicles (id,tenant_id,plate,vehicle_type,brand,model)
      VALUES (${vehicle},${tenant.tenantId},${`F${vehicle.replaceAll('-', '').slice(0, 12).toUpperCase()}`},'car','Marca','Modelo')`;
    await tx`INSERT INTO public.vehicle_owners
      (id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES (${randomUUID()},${tenant.tenantId},${vehicle},${customer},'owner',true)`;
    await tx`INSERT INTO public.privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
        authorization_text_hash,channel,captured_at,controller_notice_snapshot)
      VALUES (${consent},${tenant.tenantId},${customer},'service_provision','test-notice-1',
        'test-service-1',${'f'.repeat(64)},'in_person',now(),
        ${tx.json({ legalName: 'TEST-ONLY', address: 'TEST-ONLY', phone: '+5700000000',
          email: null, rightsChannel: 'TEST-ONLY' })})`;
    await tx`INSERT INTO public.receptions
      (id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
      VALUES (${reception},${tenant.tenantId},${vehicle},${customer},${consent},${tenant.owner.membershipId},0)`;
  });
  return { customer, vehicle, consent, reception };
}
async function media(tenantId, type = 'signature', status = 'active', retention = 'authorization_evidence') {
  const id = randomUUID();
  await h.admin.begin(async (tx) => {
    // Only fabricate the invalid historical status used by the negative test.
    if (status === 'deleted') await tx`SET LOCAL session_replication_role=replica`;
    await tx`INSERT INTO public.media_assets
      (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES (${id},${tenantId},'test',${id},${type},'image/png',${status},${retention},'v1')`;
  });
  return id;
}
const body = (signatureMediaId, extra = {}) => ({ signatureMediaId, signedByName: '  María Gómez  ',
  signedByDocument: null, documentVersion: RECEPTION_ACCEPTANCE_VERSION, ...extra });
const capture = (actor, tenantId, receptionId, data) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST',
  url: `/api/v1/receptions/${receptionId}/signature`, body: data,
});
const code = (response) => response.json?.error?.code;
const signatures = (id) => h.admin`SELECT * FROM public.signatures WHERE reception_id=${id}`;
const audits = (id) => h.admin`SELECT * FROM public.audit_logs
  WHERE entity_id=${id} AND action='reception.signed'`;
async function blockedBy(holderPid, expected, fragment) {
  const until = Date.now() + 6000;
  for (;;) {
    const [row] = await h.admin`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND ${holderPid}=ANY(pg_catalog.pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_catalog.pg_stat_activity a JOIN waiting w
        ON w.pid=ANY(pg_catalog.pg_blocking_pids(a.pid))
      WHERE a.datname=pg_catalog.current_database()
    ) SELECT count(DISTINCT a.pid)::int AS n FROM waiting w
      JOIN pg_catalog.pg_stat_activity a ON a.pid=w.pid
      WHERE a.wait_event_type='Lock' AND a.query LIKE ${`%${fragment}%`}`;
    if (row.n >= expected) return;
    if (Date.now() > until) assert.fail(`expected ${expected} blocked ${fragment}, got ${row.n}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('valid capture stores server hash and signer separately from actor, exactly once', async () => {
  const { a } = await h.twoTenants();
  const { reception, consent } = await fixture(a);
  const m = await media(a.tenantId);
  const result = await capture(a.advisor, a.tenantId, reception, body(m));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.deepEqual(Object.keys(result.json.signature).sort(),
    ['signatureId', 'receptionId', 'signatureMediaId', 'documentVersion', 'signedAt'].sort());
  assert.equal(result.headers['cache-control'], 'no-store');
  const [stored] = await signatures(reception);
  assert.equal(stored.signed_by_name, 'María Gómez');
  assert.equal(stored.signed_by_document, null);
  assert.equal(stored.document_hash, PIN);
  assert.equal(stored.document_version, RECEPTION_ACCEPTANCE_VERSION);
  assert.equal(stored.signature_media_id, m);
  const [retention] = await h.admin`SELECT retention_until =
    ((s.signed_at AT TIME ZONE 'UTC') + interval '36 months') AT TIME ZONE 'UTC' AS exact_clock
    FROM media_assets ma JOIN signatures s ON s.tenant_id=ma.tenant_id AND s.signature_media_id=ma.id
    WHERE ma.id=${m}`;
  assert.equal(retention.exact_clock,true);
  assert.equal((await h.admin`SELECT id FROM audit_logs WHERE entity_id=${m} AND action='media.retention_updated'`).length,1);
  const [audit] = await audits(reception);
  assert.equal(audit.actor_membership_id, a.advisor.membershipId);
  assert.deepEqual(audit.metadata_json, { signature_id: stored.id,
    media_id: m, document_version: RECEPTION_ACCEPTANCE_VERSION });
  const [r] = await h.admin`SELECT status,privacy_consent_id FROM public.receptions WHERE id=${reception}`;
  assert.deepEqual([r.status, r.privacy_consent_id], ['open', consent]);
  const duplicate = await capture(a.owner, a.tenantId, reception, body(m));
  assert.deepEqual([duplicate.status, code(duplicate)], [409, 'RECEPTION_ALREADY_SIGNED']);
  assert.equal((await signatures(reception)).length, 1);
  assert.equal((await audits(reception)).length, 1);
  const another = await fixture(a);
  const reused = await capture(a.owner, a.tenantId, another.reception, body(m));
  assert.deepEqual([reused.status, code(reused)], [409, 'SIGNATURE_MEDIA_ALREADY_USED']);
  assert.equal((await signatures(another.reception)).length, 0);
  assert.equal((await audits(another.reception)).length, 0);
});

test('RBAC, tenant, version and strict body failures leave no evidence', async () => {
  const { a, b } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  for (const [actor, tenant, data, expectedStatus, expectedCode] of [
    [a.technician, a.tenantId, body(m), 403, 'PERMISSION_DENIED'],
    [b.owner, b.tenantId, body(m), 404, 'RECEPTION_NOT_FOUND'],
    [a.owner, a.tenantId, body(m, { documentVersion: 'future_v2' }), 409,
      'ACCEPTANCE_DOCUMENT_VERSION_MISMATCH'],
    [a.owner, a.tenantId, body(m, { documentVersion: 'reception_acceptance_es-CO_v0' }), 409,
      'ACCEPTANCE_DOCUMENT_VERSION_MISMATCH'],
    [a.owner, a.tenantId, body(m, { documentVersion: undefined }), 400, 'REQUEST_VALIDATION_FAILED'],
    [a.owner, a.tenantId, body(m, { documentHash: PIN }), 400, 'REQUEST_VALIDATION_FAILED'],
    [a.owner, a.tenantId, body(m, { acceptanceText: 'x' }), 400, 'REQUEST_VALIDATION_FAILED'],
    [a.owner, a.tenantId, body(m, { signedByName: '   ' }), 400, 'REQUEST_VALIDATION_FAILED'],
    [a.owner, a.tenantId, body(m, { signedByName: 'x'.repeat(201) }), 400, 'REQUEST_VALIDATION_FAILED'],
  ]) {
    const result = await capture(actor, tenant, reception, data);
    assert.deepEqual([result.status, code(result)], [expectedStatus, expectedCode], JSON.stringify(result.json));
  }
  assert.equal((await signatures(reception)).length, 0);
  assert.equal((await audits(reception)).length, 0);
});

test('signer identity rejects original controls before trimming and preserves safe Unicode', async () => {
  const { a } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  for (const value of ['\tAlice', 'Alice\n', '\rAlice', '\0Alice',
    'Alice\u0085', '\u202eAlice', 'Alice\u2067', '\ud800Alice', 'Alice\udc00']) {
    for (const field of ['signedByName', 'signedByDocument']) {
      const result = await capture(a.owner, a.tenantId, reception, body(m, { [field]: value }));
      assert.deepEqual([result.status, code(result)], [400, 'REQUEST_VALIDATION_FAILED'],
        `${field}: ${JSON.stringify(value)}`);
    }
  }
  assert.equal((await signatures(reception)).length, 0);
  assert.equal((await audits(reception)).length, 0);
  const result = await capture(a.owner, a.tenantId, reception,
    body(m, { signedByName: '  María Gómez  ', signedByDocument: '  00-١٢  ' }));
  assert.equal(result.status, 201, JSON.stringify(result.json));
  const [stored] = await signatures(reception);
  assert.deepEqual([stored.signed_by_name, stored.signed_by_document], ['María Gómez', '00-١٢']);
});

test('media eligibility and foreign media fail without signature or success audit', async () => {
  const { a, b } = await h.twoTenants();
  const { reception } = await fixture(a);
  const candidates = [
    [randomUUID(), 404, 'SIGNATURE_MEDIA_NOT_FOUND'],
    [await media(b.tenantId), 404, 'SIGNATURE_MEDIA_NOT_FOUND'],
    [await media(a.tenantId, 'signature', 'active', 'operational'), 409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE'],
    [await media(a.tenantId, 'photo'), 409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE'],
    [await media(a.tenantId, 'signature', 'pending_upload'), 409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE'],
    [await media(a.tenantId, 'signature', 'quarantined'), 409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE'],
    [await media(a.tenantId, 'signature', 'deleted'), 409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE'],
  ];
  for (const [id, status, expectedCode] of candidates) {
    const result = await capture(a.owner, a.tenantId, reception, body(id));
    assert.deepEqual([result.status, code(result)], [status, expectedCode], JSON.stringify(result.json));
  }
  assert.equal((await signatures(reception)).length, 0);
  assert.equal((await audits(reception)).length, 0);
});

test('two overlapping POSTs serialize on reception and commit one signature and audit', async () => {
  const { a } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  const holder = await h.admin.reserve();
  let pending;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.receptions WHERE id=${reception} FOR NO KEY UPDATE`;
    pending = [capture(a.owner, a.tenantId, reception, body(m)),
      capture(a.advisor, a.tenantId, reception, body(m))];
    await blockedBy(backend.pid, 2, 'FROM public.receptions');
  } finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
  }
  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(code(responses.find((r) => r.status === 409)), 'RECEPTION_ALREADY_SIGNED');
  assert.equal((await signatures(reception)).length, 1);
  assert.equal((await audits(reception)).length, 1);
});

test('quarantine wins media lock; capture fails, and signed media can later quarantine', async () => {
  const { a } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  const holder = await h.admin.reserve();
  let pending;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`UPDATE public.media_assets SET status='quarantined' WHERE id=${m}`;
    pending = capture(a.owner, a.tenantId, reception, body(m));
    await blockedBy(backend.pid, 1, 'FROM public.media_assets');
    await holder.unsafe('COMMIT');
  } finally {
    await holder.unsafe('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  const failed = await pending;
  assert.deepEqual([failed.status, code(failed)], [409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE']);
  assert.equal((await signatures(reception)).length, 0);
  assert.equal((await audits(reception)).length, 0);

  const second = await fixture(a);
  const signedMedia = await media(a.tenantId);
  assert.equal((await capture(a.owner, a.tenantId, second.reception, body(signedMedia))).status, 201);
  const [before] = await signatures(second.reception);
  await h.admin`UPDATE public.media_assets SET status='quarantined' WHERE id=${signedMedia}`;
  const [after] = await signatures(second.reception);
  assert.deepEqual(after, before);
  const [state] = await h.admin`SELECT status FROM public.media_assets WHERE id=${signedMedia}`;
  assert.equal(state.status, 'quarantined');
  const denied = await h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
    method: 'GET', url: `/api/v1/media/${signedMedia}/download-url` });
  assert.deepEqual([denied.status, code(denied)], [409, 'MEDIA_ASSET_NOT_ACTIVE']);
});

test('capture holds reception lock while waiting for media lock', async () => {
  const { a } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  const mediaHolder = await h.admin.reserve();
  const updater = await h.admin.reserve();
  let pendingCapture, pendingUpdate;
  try {
    await mediaHolder.unsafe('BEGIN');
    await updater.unsafe('BEGIN');
    const [holderBackend] = await mediaHolder`SELECT pg_backend_pid() AS pid`;
    const [updaterBackend] = await updater`SELECT pg_backend_pid() AS pid`;
    await mediaHolder`UPDATE public.media_assets SET updated_at=now() WHERE id=${m}`;
    pendingCapture = capture(a.owner, a.tenantId, reception, body(m));
    await blockedBy(holderBackend.pid, 1, 'FROM public.media_assets');
    const [signer] = await h.admin`SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND wait_event_type='Lock'
        AND ${holderBackend.pid}=ANY(pg_catalog.pg_blocking_pids(pid))
        AND query LIKE '%FROM public.media_assets%' LIMIT 1`;
    assert.ok(signer);
    pendingUpdate = Promise.resolve(updater`UPDATE public.receptions SET advisor_notes='later' WHERE id=${reception}`);
    await blockedBy(signer.pid, 1, 'UPDATE public.receptions');
    const [updaterState] = await h.admin`SELECT pg_blocking_pids(${updaterBackend.pid}) AS blockers`;
    assert.ok(updaterState.blockers.includes(signer.pid));
    await mediaHolder.unsafe('COMMIT');
    assert.equal((await pendingCapture).status, 201);
    await pendingUpdate;
    await updater.unsafe('COMMIT');
  } finally {
    await mediaHolder.unsafe('ROLLBACK').catch(() => undefined);
    await updater.unsafe('ROLLBACK').catch(() => undefined);
    mediaHolder.release(); updater.release();
  }
  assert.equal((await signatures(reception)).length, 1);
});

test('close-like DB fixture wins reception lock; endpoint sees closed and writes no new audit', async () => {
  const { a } = await h.twoTenants();
  const { reception, vehicle, customer } = await fixture(a);
  const m = await media(a.tenantId);
  const closer = await h.admin.reserve();
  let pending;
  try {
    await closer.unsafe('BEGIN');
    const [backend] = await closer`SELECT pg_backend_pid() AS pid`;
    await closer`SELECT id FROM public.receptions WHERE id=${reception} FOR NO KEY UPDATE`;
    await closer`INSERT INTO public.signatures
      (id,tenant_id,reception_id,signature_media_id,signed_by_name,document_version,document_hash,signed_at)
      VALUES (${randomUUID()},${a.tenantId},${reception},${m},'TEST-ONLY',
        ${RECEPTION_ACCEPTANCE_VERSION},${PIN},now())`;
    await closer`UPDATE public.receptions SET status='closed',closed_at=now() WHERE id=${reception}`;
    const order = randomUUID();
    await closer`INSERT INTO public.service_orders
      (id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
      VALUES (${order},${a.tenantId},${reception},${vehicle},${customer},987654,
        ${a.owner.membershipId})`;
    await closer`INSERT INTO public.order_status_history
      (id,tenant_id,order_id,to_status,request_id)
      VALUES (${randomUUID()},${a.tenantId},${order},'reception',${randomUUID()})`;
    pending = capture(a.owner, a.tenantId, reception, body(m));
    await blockedBy(backend.pid, 1, 'FROM public.receptions');
    await closer.unsafe('COMMIT');
  } finally {
    await closer.unsafe('ROLLBACK').catch(() => undefined);
    closer.release();
  }
  const result = await pending;
  assert.deepEqual([result.status, code(result)], [409, 'RECEPTION_NOT_EDITABLE']);
  const wrongVersion = await capture(a.owner, a.tenantId, reception,
    body(m, { documentVersion: 'unknown_v2' }));
  assert.deepEqual([wrongVersion.status, code(wrongVersion)], [409, 'RECEPTION_NOT_EDITABLE']);
  assert.equal((await signatures(reception)).length, 1);
  assert.equal((await audits(reception)).length, 0);
});

test('audit failure rolls back signature and retry succeeds', async () => {
  const { a } = await h.twoTenants();
  const { reception } = await fixture(a);
  const m = await media(a.tenantId);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'reception.signed'");
  try {
    const result = await capture(a.owner, a.tenantId, reception, body(m));
    assert.deepEqual([result.status, code(result)], [500, 'INTERNAL_ERROR']);
  } finally { await remove(); }
  assert.equal((await signatures(reception)).length, 0);
  assert.equal((await audits(reception)).length, 0);
  assert.equal((await h.admin`SELECT retention_until FROM media_assets WHERE id=${m}`)[0].retention_until,null);
  assert.equal((await h.admin`SELECT id FROM audit_logs WHERE entity_id=${m} AND action='media.retention_updated'`).length,0);
  assert.equal((await capture(a.owner, a.tenantId, reception, body(m))).status, 201);
});

// PostgreSQL independently masks an omitted service check; keep the application
// guard explicit as well as testing the API outcome and direct DB invariant.
test('capture explicitly checks reception retention before inserting evidence', () => {
  const source = readFileSync(join(process.env.TEST_MODULE_ROOT, 'receptions/signature.js'), 'utf8');
  assert.match(source, /SELECT media_type, status, retention_class, deleted_at, purged_at/u);
  assert.match(source, /media\.retention_class !== 'authorization_evidence'/u);
});
