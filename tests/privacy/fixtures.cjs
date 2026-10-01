'use strict';

/**
 * TEST-ONLY privacy fixtures. These strings are NOT legal copy, NOT a published
 * version and never reach the production catalog
 * Versions use the "test-" prefix independently of published production versions.
 */
const { join, resolve } = require('node:path');

const moduleRoot = process.env.TEST_MODULE_ROOT || resolve('dist');
const loadModule = (relative) => require(join(moduleRoot, relative));

const NOTICE_V1 = Object.freeze({
  version: 'test-notice-1',
  text: 'TEST-ONLY aviso de privacidad (fixture sin efecto jurídico).\nResponsable: ver identificación.',
});
const NOTICE_V2 = Object.freeze({
  version: 'test-notice-2',
  text: 'TEST-ONLY aviso de privacidad v2 (fixture sin efecto jurídico).',
});
const SERVICE_V1 = Object.freeze({
  purposeCode: 'service_provision',
  version: 'test-service-1',
  text: 'TEST-ONLY autorización service_provision (fixture).\nTEST-ONLY: declaro ser mayor de edad.',
});
const SERVICE_V2 = Object.freeze({
  purposeCode: 'service_provision',
  version: 'test-service-2',
  text: 'TEST-ONLY autorización service_provision v2 (fixture).\nTEST-ONLY: declaro ser mayor de edad.',
});
const MARKETING_V1 = Object.freeze({
  purposeCode: 'marketing',
  version: 'test-marketing-1',
  text: 'TEST-ONLY autorización marketing (fixture, nunca premarcada).\nTEST-ONLY: declaro ser mayor de edad.',
});
const DOCUMENTS = Object.freeze({
  notices: [NOTICE_V1, NOTICE_V2],
  authorizations: [SERVICE_V1, SERVICE_V2, MARKETING_V1],
});
const SNAPSHOT = Object.freeze({
  legalName: 'TEST-ONLY Taller Fixture S.A.S.',
  address: 'Calle 1 # 2-3, Bogotá, Bogotá D.C., CO',
  phone: '+5716000000',
  email: null,
  rightsChannel: 'TEST-ONLY derechos@taller.test',
});
/** TEST-ONLY HMAC keys (32+ bytes); never a deployed secret. */
const BUNDLE_KEY_V1 = Buffer.from('TEST-ONLY-privacy-bundle-key-v1-0123456789abcdef', 'utf8');
const BUNDLE_KEY_V2 = Buffer.from('TEST-ONLY-privacy-bundle-key-v2-0123456789abcdef', 'utf8');
/** Rights channel source for tests only (production has none: DOC_GAP). */
const RIGHTS_CHANNEL = 'TEST-ONLY canal de derechos: derechos@taller.test';
/** Well-formed TEST-ONLY evidence for privileged DB fixtures (not a real presented text). */
const FIXTURE_HASH = 'f'.repeat(64);

function catalog() {
  const { PrivacyDocumentCatalog } = loadModule('privacy/catalog.js');
  return new PrivacyDocumentCatalog(DOCUMENTS);
}

module.exports = {
  loadModule, NOTICE_V1, NOTICE_V2, SERVICE_V1, SERVICE_V2, MARKETING_V1, DOCUMENTS, SNAPSHOT,
  BUNDLE_KEY_V1, BUNDLE_KEY_V2, RIGHTS_CHANNEL, FIXTURE_HASH, catalog,
};
