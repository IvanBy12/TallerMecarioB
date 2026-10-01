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

const APPROVED_COPY = require('./production-copy.cjs');
const PRODUCTION_TEXT_PINS = {
  "notice:privacy_notice_es-CO_v1": "fd459b0980dd784c2db78c43c45ee752ac65b0ef4a8bb13f30695df87f474385",
  "service_provision:service_provision_es-CO_v1": "61b3686e8d36f918feb011e501fee8776e736c6c30ab13d71a302d5a78d361f6"
};

test('production publishes exactly the approved v1 bytes and independent SHA-256 pins', () => {
  const published = PRODUCTION_PRIVACY_DOCUMENT_CATALOG.published();
  assert.deepEqual(published, APPROVED_COPY);
  const actual = {};
  for (const n of published.notices) actual[`notice:${n.version}`] = createHash('sha256').update(n.text, 'utf8').digest('hex');
  for (const a of published.authorizations) actual[`${a.purposeCode}:${a.version}`] = createHash('sha256').update(a.text, 'utf8').digest('hex');
  assert.deepEqual(actual, PRODUCTION_TEXT_PINS);
  for (const purpose of PRIVACY_PURPOSE_CODES) {
    if (purpose !== 'service_provision') assert.equal(PRODUCTION_PRIVACY_DOCUMENT_CATALOG.resolve(purpose,
      'privacy_notice_es-CO_v1', 'service_provision_es-CO_v1'), null);
  }
  assert.equal(PRODUCTION_PRIVACY_DOCUMENT_CATALOG.noticeText('latest'), null);
  assert.equal(PRODUCTION_PRIVACY_DOCUMENT_CATALOG.noticeText('v1'), null);
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

test('production uses canonical workshop email and requires phone plus email without changing stored snapshot parsing', () => {
  const config = PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION;
  const workshop = { tenantId: 't', legalName: 'Taller', phone: null, email: '  CONTACTO@TALLER.TEST  ' };
  const location = { addressLine: 'Calle 1', city: 'Bogotá', department: 'Bogotá D.C.',
    countryCode: 'CO', phone: '+5716000000' };
  const build = (w, l) => buildControllerNoticeSnapshot(w, l, config.rightsChannel(w), config.requirePhoneAndEmail);
  assert.equal(config.rightsChannel(workshop), 'Correo electrónico: contacto@taller.test');
  assert.equal(build(workshop, location).email, 'contacto@taller.test');
  assert.equal(build(workshop, { ...location, phone: null }), null);
  for (const email of [null, '', '  ', 'invalid', 'a@b', 'a\u202e@b.test'])
    assert.equal(build({ ...workshop, email }, location), null);
  assert.equal(build(workshop, null), null);
  assert.equal(build({ ...workshop, legalName: ' ' }, location), null);
  for (const field of ['addressLine', 'city', 'department', 'countryCode'])
    assert.equal(build(workshop, { ...location, [field]: ' ' }), null);
  const historical = { ...f.SNAPSHOT, phone: null, email: 'historical@taller.test' };
  assert.deepEqual(parseControllerNoticeSnapshot(historical), historical);
});

test('stored/bundle snapshot shape is strict', () => {
  assert.deepEqual({ ...parseControllerNoticeSnapshot({ ...f.SNAPSHOT }) }, { ...f.SNAPSHOT });
  for (const bad of [null, [], 'x', { ...f.SNAPSHOT, extra: 'x' }, { ...f.SNAPSHOT, legalName: undefined },
    { ...f.SNAPSHOT, phone: 1 }, { ...f.SNAPSHOT, phone: null, email: null }, { ...f.SNAPSHOT, address: ' a' },
    { ...f.SNAPSHOT, legalName: 'Bogotá' }, { ...f.SNAPSHOT, rightsChannel: null }])
    assert.equal(parseControllerNoticeSnapshot(bad), null, JSON.stringify(bad));
});
