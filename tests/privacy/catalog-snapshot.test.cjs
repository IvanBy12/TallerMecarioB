'use strict';

// S3-04.5 D-PRIV-02/05: versioned catalog (fail closed) and controller snapshot.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const f = require('./fixtures.cjs');

const { PrivacyDocumentCatalog, PRODUCTION_PRIVACY_DOCUMENT_CATALOG, PRIVACY_PURPOSE_CODES } =
  f.loadModule('privacy/catalog.js');
const { buildControllerNoticeSnapshot, parseControllerNoticeSnapshot,
  PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION } = f.loadModule('privacy/controller-notice.js');

/**
 * Known-hash pins for every PRODUCTION published version (sha256 of the exact
 * text). CANONICAL_PRIVACY_COPY_NOT_PUBLISHED: no version is published yet, so
 * this map is empty. Publishing a version requires adding its pin here.
 */
const PRODUCTION_TEXT_PINS = {};

test('production catalog publishes nothing and fails closed; every published text is pinned', () => {
  const published = PRODUCTION_PRIVACY_DOCUMENT_CATALOG.published();
  const actual = {};
  for (const n of published.notices) actual[`notice:${n.version}`] = createHash('sha256').update(n.text).digest('hex');
  for (const a of published.authorizations)
    actual[`${a.purposeCode}:${a.version}`] = createHash('sha256').update(a.text).digest('hex');
  assert.deepEqual(actual, PRODUCTION_TEXT_PINS);
  for (const purpose of PRIVACY_PURPOSE_CODES)
    for (const document of [...f.DOCUMENTS.notices, ...f.DOCUMENTS.authorizations])
      assert.equal(PRODUCTION_PRIVACY_DOCUMENT_CATALOG.resolve(purpose, document.version, document.version), null);
  assert.equal(PRODUCTION_PRIVACY_DOCUMENT_CATALOG.noticeText('v1'), null);
  assert.equal(PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION.rightsChannel({ tenantId: 'x', legalName: 'L',
    phone: '1', email: 'e@x.test' }), null);
});

test('catalog resolves exact versions only, never a fallback', () => {
  const catalog = f.catalog();
  assert.deepEqual(catalog.resolve('service_provision', f.NOTICE_V1.version, f.SERVICE_V1.version),
    { noticeText: f.NOTICE_V1.text, authorizationText: f.SERVICE_V1.text });
  assert.equal(catalog.resolve('service_provision', f.NOTICE_V1.version, f.SERVICE_V2.version).authorizationText,
    f.SERVICE_V2.text);
  assert.equal(catalog.resolve('marketing', f.NOTICE_V1.version, f.SERVICE_V1.version), null);
  assert.equal(catalog.resolve('service_provision', 'test-notice-9', f.SERVICE_V1.version), null);
  assert.equal(catalog.resolve('service_provision', f.NOTICE_V1.version, 'latest'), null);
  assert.equal(catalog.resolve('service_provision', f.NOTICE_V1.version, 'current'), null);
  assert.ok(Object.isFrozen(catalog));
});

test('catalog definition rejects reuse, non-canonical text and invalid versions', () => {
  const define = (documents) => () => new PrivacyDocumentCatalog({ notices: [], authorizations: [], ...documents });
  for (const bad of [
    { notices: [f.NOTICE_V1, { version: f.NOTICE_V1.version, text: 'TEST-ONLY otro texto' }] },
    { authorizations: [f.SERVICE_V1, { ...f.SERVICE_V1, text: 'TEST-ONLY otro' }] },
    { notices: [{ version: 'test-crlf', text: 'TEST-ONLY a\r\nb' }] },
    { notices: [{ version: 'test-nfd', text: 'TEST-ONLY autorización' }] },
    { notices: [{ version: 'test-bom', text: '﻿TEST-ONLY' }] },
    { notices: [{ version: 'test-empty', text: '   ' }] },
    { notices: [{ version: 'bad version', text: 'TEST-ONLY' }] },
    { notices: [{ version: 'x'.repeat(41), text: 'TEST-ONLY' }] },
    { authorizations: [{ purposeCode: 'unknown', version: 'test-1', text: 'TEST-ONLY' }] },
  ]) assert.throws(define(bad), /PRIVACY_CATALOG_DEFINITION_INVALID/u);
});

test('snapshot is built server-side from workshop + primary location and fails closed', () => {
  const workshop = { tenantId: 't', legalName: '  Taller Legal  ', phone: null, email: 'contacto@taller.test' };
  const location = { addressLine: 'Calle 1 # 2-3', city: 'Bogotá', department: 'Cundinamarca',
    countryCode: 'CO', phone: '+5716000000' };
  const snapshot = buildControllerNoticeSnapshot(workshop, location, f.RIGHTS_CHANNEL);
  assert.deepEqual({ ...snapshot }, { legalName: 'Taller Legal', address: 'Calle 1 # 2-3, Bogotá, Cundinamarca, CO',
    phone: '+5716000000', email: 'contacto@taller.test', rightsChannel: f.RIGHTS_CHANNEL });
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(buildControllerNoticeSnapshot({ ...workshop, phone: '+5710000000' }, location, f.RIGHTS_CHANNEL).phone,
    '+5710000000');
  assert.equal(buildControllerNoticeSnapshot(workshop, location, null), null, 'no rights channel');
  assert.equal(buildControllerNoticeSnapshot(workshop, location, '  '), null, 'blank rights channel');
  assert.equal(buildControllerNoticeSnapshot(workshop, null, f.RIGHTS_CHANNEL), null, 'no primary location');
  assert.equal(buildControllerNoticeSnapshot({ ...workshop, email: null }, { ...location, phone: null },
    f.RIGHTS_CHANNEL), null, 'no phone nor email');
  assert.equal(buildControllerNoticeSnapshot({ ...workshop, legalName: ' ' }, location, f.RIGHTS_CHANNEL), null);
});

test('stored/bundle snapshot shape is strict', () => {
  assert.deepEqual({ ...parseControllerNoticeSnapshot({ ...f.SNAPSHOT }) }, { ...f.SNAPSHOT });
  for (const bad of [null, [], 'x', { ...f.SNAPSHOT, extra: 'x' }, { ...f.SNAPSHOT, legalName: undefined },
    { ...f.SNAPSHOT, phone: 1 }, { ...f.SNAPSHOT, phone: null, email: null }, { ...f.SNAPSHOT, address: ' a' },
    { ...f.SNAPSHOT, legalName: 'Bogotá' }, { ...f.SNAPSHOT, rightsChannel: null }])
    assert.equal(parseControllerNoticeSnapshot(bad), null, JSON.stringify(bad));
});
