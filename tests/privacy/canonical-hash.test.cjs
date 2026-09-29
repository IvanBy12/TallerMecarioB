'use strict';

// S3-04.5 D-PRIV-02: canonical representation v1 and authorization_text_hash.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const f = require('./fixtures.cjs');

const { computeAuthorizationTextHash, authorizationTextPreimage, canonicalizeText,
  CONTROLLER_NOTICE_FIELDS } = f.loadModule('privacy/canonical-text.js');

/** SHA-256 of the TEST-ONLY fixture (NOTICE_V1 + SERVICE_V1 + SNAPSHOT), pinned. */
const PINNED_FIXTURE_HASH = 'a0f2f65b23625b2f45030cecc0ab3c246ae1e83cce233e2a3fabcdea59a826c6';
const base = () => ({
  purposeCode: 'service_provision', privacyNoticeVersion: f.NOTICE_V1.version,
  authorizationTextVersion: f.SERVICE_V1.version, noticeText: f.NOTICE_V1.text,
  authorizationText: f.SERVICE_V1.text, snapshot: { ...f.SNAPSHOT },
});
const hash = (overrides = {}) => computeAuthorizationTextHash({ ...base(), ...overrides });

/** Independent byte-level construction of the Diccionario 04 §1.1 preimage. */
function independentPreimage(input) {
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const lp = (s) => { const b = Buffer.from(s, 'utf8'); return [u64(b.length), b]; };
  const zero = Buffer.from([0]);
  const parts = [Buffer.from('tallermecario.privacy_consent.text.v1'), zero,
    Buffer.from(input.purposeCode), zero, Buffer.from(input.privacyNoticeVersion), zero,
    Buffer.from(input.authorizationTextVersion), zero, ...lp(input.noticeText), ...lp(input.authorizationText)];
  for (const field of ['legalName', 'address', 'phone', 'email', 'rightsChannel']) {
    const value = input.snapshot[field];
    parts.push(...(value === null ? [zero] : [Buffer.from([1]), ...lp(value)]));
  }
  return Buffer.concat(parts);
}

test('known hash: exact SHA-256 of the TEST-ONLY fixture, independent preimage, lowercase 64 hex', () => {
  const input = base();
  assert.deepEqual(authorizationTextPreimage(input), independentPreimage(input));
  assert.equal(createHash('sha256').update(independentPreimage(input)).digest('hex'), PINNED_FIXTURE_HASH);
  assert.equal(hash(), PINNED_FIXTURE_HASH);
  assert.match(hash(), /^[0-9a-f]{64}$/u);
  assert.equal(hash().length, 64);
  assert.deepEqual([...CONTROLLER_NOTICE_FIELDS], ['legalName', 'address', 'phone', 'email', 'rightsChannel']);
});

test('deterministic: same input always yields the same hash', () => {
  const results = new Set(Array.from({ length: 5 }, () => hash()));
  assert.equal(results.size, 1);
});

test('every component changes the hash: notice, authorization, purpose, versions, snapshot fields', () => {
  const reference = hash();
  const variants = {
    noticeByte: hash({ noticeText: `${f.NOTICE_V1.text.slice(0, -1)}!` }),
    authorizationByte: hash({ authorizationText: `${f.SERVICE_V1.text} ` }),
    purpose: hash({ purposeCode: 'marketing' }),
    noticeVersion: hash({ privacyNoticeVersion: 'test-notice-9' }),
    authorizationVersion: hash({ authorizationTextVersion: 'test-service-9' }),
  };
  for (const field of ['legalName', 'address', 'phone', 'rightsChannel'])
    variants[`snapshot.${field}`] = hash({ snapshot: { ...f.SNAPSHOT, [field]: `${f.SNAPSHOT[field]}x` } });
  variants['snapshot.email'] = hash({ snapshot: { ...f.SNAPSHOT, email: 'e@taller.test' } });
  for (const [name, value] of Object.entries(variants)) assert.notEqual(value, reference, name);
  assert.equal(new Set(Object.values(variants)).size, Object.keys(variants).length);
  // Length prefixes: moving bytes between notice and authorization is not ambiguous.
  assert.notEqual(hash({ noticeText: `${f.NOTICE_V1.text}A`, authorizationText: f.SERVICE_V1.text }),
    hash({ noticeText: f.NOTICE_V1.text, authorizationText: `A${f.SERVICE_V1.text}` }));
});

test('NULL and empty string are distinct evidence (0x00 vs 0x01 || u64be(0))', () => {
  const withNull = { ...f.SNAPSHOT, email: null };
  const withEmpty = { ...f.SNAPSHOT, email: '' };
  assert.notEqual(hash({ snapshot: withNull }), hash({ snapshot: withEmpty }));
  const nullBytes = authorizationTextPreimage({ ...base(), snapshot: withNull });
  const emptyBytes = authorizationTextPreimage({ ...base(), snapshot: withEmpty });
  assert.equal(emptyBytes.length - nullBytes.length, 8);
});

test('UTF-8 non-ASCII uses byte lengths; NFC, LF and BOM canonicalization', () => {
  const text = 'Autorización TEST-ONLY — ñandú';
  const preimage = authorizationTextPreimage({ ...base(), noticeText: text });
  const utf8 = Buffer.from(text, 'utf8');
  assert.ok(utf8.length > [...text].length);
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64BE(BigInt(utf8.length));
  assert.ok(preimage.includes(Buffer.concat([prefix, utf8])));
  const nfd = text.normalize('NFD');
  assert.notEqual(nfd, text);
  assert.equal(hash({ noticeText: nfd }), hash({ noticeText: text }));
  assert.equal(hash({ snapshot: { ...f.SNAPSHOT, address: f.SNAPSHOT.address.normalize('NFD') } }), hash());
  assert.equal(hash({ noticeText: f.NOTICE_V1.text.replace('\n', '\r\n') }), hash());
  assert.equal(hash({ noticeText: f.NOTICE_V1.text.replace('\n', '\r') }), hash());
  assert.equal(hash({ noticeText: `﻿${f.NOTICE_V1.text}` }), hash());
  assert.equal(canonicalizeText('a\r\nb\rc'), 'a\nb\nc');
  assert.throws(() => hash({ noticeText: '\uD800' }), /PRIVACY_CANONICAL_TEXT_INVALID/u);
  assert.throws(() => hash({ purposeCode: 'service\u0000provision' }), /PRIVACY_CANONICAL_TEXT_INVALID/u);
  assert.throws(() => hash({ privacyNoticeVersion: '' }), /PRIVACY_CANONICAL_TEXT_INVALID/u);
});
