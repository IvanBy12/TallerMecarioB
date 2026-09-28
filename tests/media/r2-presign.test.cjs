'use strict';

const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const test = require('node:test');
const { presignR2Url, writeOnceUploadHeaders } = require('../../dist/media/r2.js');

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
