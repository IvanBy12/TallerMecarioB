'use strict';

const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const test = require('node:test');
const { loadR2ConfigFromEnv, presignR2Url, writeOnceUploadHeaders } = require('../../dist/media/r2.js');

const config = {
  endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', bucket: 'media-test',
  accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'test-secret-key',
};
const now = new Date('2026-01-02T03:04:05.000Z');
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest();

function independentSignature(url, condition) {
  const parsed = new URL(url);
  const dateStamp = parsed.searchParams.get('X-Amz-Date').slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalQuery = parsed.search.slice(1).split('&')
    .filter((part) => !part.startsWith('X-Amz-Signature=')).join('&');
  const canonicalRequest = [
    'PUT', parsed.pathname, canonicalQuery,
    `content-type:image/png\nhost:${parsed.host}\nif-none-match:${condition}\n`,
    'content-type;host;if-none-match', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const requestHash = createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = ['AWS4-HMAC-SHA256', parsed.searchParams.get('X-Amz-Date'), scope,
    requestHash].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp),
    config.region), 's3'), 'aws4_request');
  return createHmac('sha256', key).update(stringToSign).digest('hex');
}

test('PUT signs the exact write-once condition in its canonical SigV4 request', () => {
  const headers = writeOnceUploadHeaders('image/png');
  assert.deepEqual(headers, { 'Content-Type': 'image/png', 'If-None-Match': '*' });
  const url = presignR2Url(config, { method: 'PUT', objectKey: 'tenants/random/media/opaque.png',
    expiresInSeconds: 900, extraSignedHeaders: headers, now });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host;if-none-match');
  assert.equal(parsed.searchParams.get('X-Amz-Signature'), independentSignature(url, '*'));
  assert.notEqual(parsed.searchParams.get('X-Amz-Signature'), independentSignature(url, ''));
  assert.notEqual(parsed.searchParams.get('X-Amz-Signature'), independentSignature(url, '"other"'));
  assert.equal(url, presignR2Url(config, { method: 'PUT',
    objectKey: 'tenants/random/media/opaque.png', expiresInSeconds: 900,
    extraSignedHeaders: headers, now }));
});

test('every generic PUT is conditional; other methods are unaffected', () => {
  const put = new URL(presignR2Url(config, { method: 'PUT', objectKey: 'x',
    expiresInSeconds: 60, now }));
  assert.equal(put.searchParams.get('X-Amz-SignedHeaders'), 'host;if-none-match');
  assert.throws(() => presignR2Url(config, { method: 'PUT', objectKey: 'x',
    expiresInSeconds: 60, extraSignedHeaders: { 'If-None-Match': '"other"' }, now }),
  /R2_PUT_REQUIRES_IF_NONE_MATCH_STAR/u);
  const get = new URL(presignR2Url(config, { method: 'GET', objectKey: 'x',
    expiresInSeconds: 60, now }));
  assert.equal(get.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

const environment = { R2_ENDPOINT: config.endpoint, R2_REGION: config.region, R2_BUCKET: config.bucket,
  R2_ACCESS_KEY_ID: config.accessKeyId, R2_SECRET_ACCESS_KEY: config.secretAccessKey };

test('R2 config rejects absent, empty and whitespace-only values without fallback or value disclosure', () => {
  for (const name of Object.keys(environment)) {
    for (const value of [undefined, '', ' ', '\t\n']) {
      assert.throws(() => loadR2ConfigFromEnv({ ...environment, [name]: value }),
        { message: 'R2_CONFIGURATION_MISSING' });
    }
  }
});

test('R2 config rejects malformed and non-HTTPS endpoints with the same secret-safe error', () => {
  for (const endpoint of ['not-a-url', 'http://r2.invalid', 'ftp://r2.invalid']) {
    assert.throws(() => loadR2ConfigFromEnv({ ...environment, R2_ENDPOINT: endpoint }),
      { message: 'R2_CONFIGURATION_MISSING' });
  }
  assert.deepEqual(loadR2ConfigFromEnv(environment), config);
  assert.equal(loadR2ConfigFromEnv({ ...environment, R2_ENDPOINT: config.endpoint + '/' }).endpoint,
    config.endpoint);
});

test('R2 validation preserves nonblank credential values exactly', () => {
  const padded = { ...environment, R2_ACCESS_KEY_ID: ' key-with-spaces ',
    R2_SECRET_ACCESS_KEY: ' secret-with-spaces ', R2_BUCKET: ' bucket ', R2_REGION: ' auto ' };
  const loaded = loadR2ConfigFromEnv(padded);
  assert.equal(loaded.accessKeyId, padded.R2_ACCESS_KEY_ID);
  assert.equal(loaded.secretAccessKey, padded.R2_SECRET_ACCESS_KEY);
  assert.equal(loaded.bucket, padded.R2_BUCKET);
  assert.equal(loaded.region, padded.R2_REGION);
});
