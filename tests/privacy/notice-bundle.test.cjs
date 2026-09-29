'use strict';

// S3-04.5 D-PRIV-05: privacy_notice_bundle envelope, HMAC boundary, semantics.
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { inspect } = require('node:util');
const test = require('node:test');
const f = require('./fixtures.cjs');

const bundles = f.loadModule('privacy/notice-bundle.js');
const { computeAuthorizationTextHash } = f.loadModule('privacy/canonical-text.js');
const { PrivacyNoticeBundleKeyRing, issuePrivacyNoticeBundle, encodePrivacyNoticeBundle,
  verifyPrivacyNoticeBundle, bundleConsentEvidence, decodeBase64Url, constantTimeEqual,
  PRIVACY_NOTICE_BUNDLE_FORMAT } = bundles;

const tenantId = randomUUID();
const now = new Date('2026-09-29T12:00:00.000Z');
const issuedAt = new Date('2026-09-29T11:00:00.000Z');
const expiresAt = new Date('2026-09-29T13:00:00.000Z');
/** TEST-ONLY validity window check; the production policy is ADR-005 (Sprint 13). */
const testValidity = ({ issuedAt: i, expiresAt: e, now: n }) => i <= n && n < e;
const ring = new PrivacyNoticeBundleKeyRing([{ version: 'v1', key: f.BUNDLE_KEY_V1 },
  { version: 'v2', key: f.BUNDLE_KEY_V2 }]);
const catalog = f.catalog();
const options = (overrides = {}) => ({ keyRing: ring, catalog, expectedTenantId: tenantId,
  validity: testValidity, now, ...overrides });
const issue = (overrides = {}) => issuePrivacyNoticeBundle({ keyRing: ring, keyVersion: 'v1', catalog, tenantId,
  privacyNoticeVersion: f.NOTICE_V1.version,
  authorizations: [{ purposeCode: 'service_provision', authorizationTextVersion: f.SERVICE_V1.version },
    { purposeCode: 'marketing', authorizationTextVersion: f.MARKETING_V1.version }],
  controllerNoticeSnapshot: f.SNAPSHOT, issuedAt, expiresAt, ...overrides });
const payloadOf = (bundle) => JSON.parse(Buffer.from(bundle.split('.')[0], 'base64url').toString('utf8'));
/** Sign arbitrary bytes the way an internal emission bug (or attacker with a key) would. */
const signBytes = (bytes, key = f.BUNDLE_KEY_V1) =>
  `${bytes.toString('base64url')}.${createHmac('sha256', key).update(bytes).digest('base64url')}`;
const rejects = (bundle, reason, overrides) => assert.throws(() => verifyPrivacyNoticeBundle(bundle, options(overrides)),
  (error) => error.name === 'PrivacyNoticeBundleError' && error.reason === reason
    && error.message === 'PRIVACY_NOTICE_BUNDLE_REJECTED');

test('encode -> verify round trip returns the authenticated payload', () => {
  const bundle = issue();
  const payload = verifyPrivacyNoticeBundle(bundle, options());
  assert.equal(payload.format, PRIVACY_NOTICE_BUNDLE_FORMAT);
  assert.equal(payload.tenantId, tenantId);
  assert.equal(payload.keyVersion, 'v1');
  assert.equal(payload.noticeText, f.NOTICE_V1.text);
  assert.deepEqual({ ...payload.controllerNoticeSnapshot }, { ...f.SNAPSHOT });
  assert.deepEqual(payload.authorizations.map((a) => a.purposeCode), ['service_provision', 'marketing']);
  assert.equal(bundle.split('.').length, 2);
  // The MAC covers the exact issued bytes (independent HMAC).
  const [payloadPart, macPart] = bundle.split('.');
  assert.equal(createHmac('sha256', f.BUNDLE_KEY_V1).update(Buffer.from(payloadPart, 'base64url'))
    .digest('base64url'), macPart);
});

test('tampering: payload byte, MAC byte, wrong key, unknown key version', () => {
  const bundle = issue();
  const [payloadPart, macPart] = bundle.split('.');
  const bytes = Buffer.from(payloadPart, 'base64url');
  const flipped = Buffer.from(bytes); flipped[10] ^= 0x01;
  rejects(`${flipped.toString('base64url')}.${macPart}`, 'MAC_MISMATCH');
  const mac = Buffer.from(macPart, 'base64url'); mac[0] ^= 0x80;
  rejects(`${payloadPart}.${mac.toString('base64url')}`, 'MAC_MISMATCH');
  rejects(signBytes(bytes, Buffer.from('TEST-ONLY-unrelated-wrong-key-0123456789abcdef')), 'MAC_MISMATCH');
  // Signed with a key version the verifier does not allow.
  const v3 = new PrivacyNoticeBundleKeyRing([{ version: 'v3',
    key: Buffer.from('TEST-ONLY-privacy-bundle-key-v3-0123456789abcdef') }]);
  rejects(issue({ keyRing: v3, keyVersion: 'v3' }), 'MAC_MISMATCH');
  // Valid MAC under v1 but the payload claims v2: key version is bound.
  const claimsV2 = Buffer.from(JSON.stringify({ ...payloadOf(bundle), keyVersion: 'v2' }));
  rejects(signBytes(claimsV2), 'KEY_VERSION_MISMATCH');
  // A bundle signed with an allowed older version still verifies.
  assert.equal(verifyPrivacyNoticeBundle(issue({ keyVersion: 'v2' }), options()).keyVersion, 'v2');
});

test('malformed envelopes and payloads are rejected, JSON is parsed only after the MAC', () => {
  const bundle = issue();
  const [payloadPart, macPart] = bundle.split('.');
  for (const bad of [undefined, null, 42, '', '.', payloadPart, `${bundle}.x`, `${payloadPart}=.${macPart}`,
    `${payloadPart}.${macPart}=`, `${payloadPart}+.${macPart}`, `${payloadPart}.${macPart.slice(1)}`,
    `.${macPart}`, `${payloadPart}.`, `${payloadPart} .${macPart}`, 'x'.repeat(300_000)]) rejects(bad, 'MALFORMED');
  // Non-JSON bytes with a VALID MAC: rejected as payload, not parsed before the MAC.
  rejects(signBytes(Buffer.from('{not json')), 'PAYLOAD_INVALID');
  rejects(signBytes(Buffer.from([0xff, 0xfe, 0x00])), 'PAYLOAD_INVALID');
  // Non-JSON bytes WITHOUT a valid MAC fail on the MAC, proving the order.
  rejects(`${Buffer.from('{not json').toString('base64url')}.${macPart}`, 'MAC_MISMATCH');
  const payload = payloadOf(bundle);
  for (const mutate of [
    (p) => ({ ...p, extra: 1 }), (p) => ({ ...p, format: 'other' }), (p) => ({ ...p, tenantId: 'x' }),
    (p) => ({ ...p, issuedAt: '2026-02-30T00:00:00.000Z' }), (p) => ({ ...p, authorizations: [] }),
    (p) => ({ ...p, authorizations: [p.authorizations[0], p.authorizations[0]] }),
    (p) => ({ ...p, controllerNoticeSnapshot: { ...p.controllerNoticeSnapshot, extra: 'x' } }),
    (p) => ({ ...p, authorizationTextHash: 'a'.repeat(64) }),
  ]) rejects(signBytes(Buffer.from(JSON.stringify(mutate(payload)))), 'PAYLOAD_INVALID');
});

test('tenant, validity policy and semantic catalog checks after a valid MAC', () => {
  rejects(issue({ tenantId: randomUUID() }), 'TENANT_MISMATCH');
  rejects(issue(), 'NOT_VALID_NOW', { now: new Date('2026-09-29T14:00:00.000Z') });
  rejects(issue(), 'NOT_VALID_NOW', { validity: () => false });
  rejects(issue({ issuedAt: expiresAt, expiresAt: issuedAt }), 'NOT_VALID_NOW');
  // No default validity policy exists (ADR-005 owns it): omitting it cannot pass.
  assert.throws(() => verifyPrivacyNoticeBundle(issue(), options({ validity: undefined })));
  const payload = payloadOf(issue());
  // version = v1 but text = v2, with a perfectly valid HMAC: semantic rejection.
  rejects(encodePrivacyNoticeBundle({ ...payload, noticeText: f.NOTICE_V2.text }, ring), 'CATALOG_MISMATCH');
  rejects(encodePrivacyNoticeBundle({ ...payload, authorizations: [
    { ...payload.authorizations[0], text: f.SERVICE_V2.text }] }, ring), 'CATALOG_MISMATCH');
  rejects(encodePrivacyNoticeBundle({ ...payload, privacyNoticeVersion: 'test-notice-9' }, ring), 'CATALOG_MISMATCH');
  rejects(encodePrivacyNoticeBundle({ ...payload, authorizations: [
    { ...payload.authorizations[0], authorizationTextVersion: 'test-service-9' }] }, ring), 'CATALOG_MISMATCH');
  // A version later unpublished (catalog without it) is rejected too.
  const { PrivacyDocumentCatalog } = f.loadModule('privacy/catalog.js');
  rejects(issue(), 'CATALOG_MISMATCH', { catalog: new PrivacyDocumentCatalog({ notices: [f.NOTICE_V2],
    authorizations: [f.SERVICE_V1, f.MARKETING_V1] }) });
  assert.throws(() => issue({ privacyNoticeVersion: 'test-notice-9' }), /PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE/u);
});

test('evidence keeps the authenticated historical snapshot, not the current workshop', () => {
  const payload = verifyPrivacyNoticeBundle(issue(), options());
  // The workshop later moved and changed contact data (current state differs).
  const current = { ...f.SNAPSHOT, address: 'Carrera 99 # 1-1, Medellín, Antioquia, CO', phone: '+5749999999' };
  const evidence = bundleConsentEvidence(payload, 'service_provision', f.NOTICE_V1.version, f.SERVICE_V1.version);
  assert.deepEqual({ ...evidence.snapshot }, { ...f.SNAPSHOT });
  assert.equal(evidence.authorizationTextHash, computeAuthorizationTextHash({ purposeCode: 'service_provision',
    privacyNoticeVersion: f.NOTICE_V1.version, authorizationTextVersion: f.SERVICE_V1.version,
    noticeText: f.NOTICE_V1.text, authorizationText: f.SERVICE_V1.text, snapshot: f.SNAPSHOT }));
  assert.notEqual(evidence.authorizationTextHash, computeAuthorizationTextHash({ purposeCode: 'service_provision',
    privacyNoticeVersion: f.NOTICE_V1.version, authorizationTextVersion: f.SERVICE_V1.version,
    noticeText: f.NOTICE_V1.text, authorizationText: f.SERVICE_V1.text, snapshot: current }));
  assert.equal(bundleConsentEvidence(payload, 'service_provision', f.NOTICE_V2.version, f.SERVICE_V1.version), null);
  assert.equal(bundleConsentEvidence(payload, 'image_use', f.NOTICE_V1.version, f.SERVICE_V1.version), null);
});

test('constant-time MAC comparison and no secret/bundle leakage', () => {
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('abc')), true);
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('abd')), false);
  assert.equal(constantTimeEqual(Buffer.from('abc'), Buffer.from('abcd')), false);
  assert.equal(decodeBase64Url('YQ=='), null);
  assert.equal(decodeBase64Url('YR'), null, 'non-canonical trailing bits');
  // Pattern check: the verifier compares MACs only through timingSafeEqual.
  const source = readFileSync(require.resolve(require('node:path').join(
    process.env.TEST_MODULE_ROOT || require('node:path').resolve('dist'), 'privacy/notice-bundle.js')), 'utf8');
  assert.match(source, /timingSafeEqual\)?\(left, right\)/u);
  assert.match(source, /constantTimeEqual\(options\.keyRing\.mac\(version, payloadBytes\), mac\)/u);
  assert.doesNotMatch(source, /\.equals\(mac\)|mac\.equals\(|=== mac\b/u);
  const bundle = issue();
  let caught;
  try { verifyPrivacyNoticeBundle(`${bundle.split('.')[0]}.${'A'.repeat(43)}`, options()); } catch (e) { caught = e; }
  const rendered = `${String(caught)} ${JSON.stringify(caught)} ${inspect(caught)}`;
  for (const secret of [bundle.split('.')[0].slice(0, 40), f.BUNDLE_KEY_V1.toString('utf8'),
    f.NOTICE_V1.text, f.SNAPSHOT.legalName]) assert.equal(rendered.includes(secret), false);
  const ringText = `${inspect(ring)} ${JSON.stringify(ring)} ${String(ring)}`;
  assert.equal(ringText.includes(f.BUNDLE_KEY_V1.toString('utf8')), false);
  assert.equal(ringText.includes(f.BUNDLE_KEY_V1.toString('base64')), false);
  assert.throws(() => new PrivacyNoticeBundleKeyRing([{ version: 'v1', key: Buffer.alloc(16) }]));
  assert.throws(() => new PrivacyNoticeBundleKeyRing([]));
});
