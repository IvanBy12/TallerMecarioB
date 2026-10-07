'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { uploadUrlTtlSeconds, uploadCreateLockKey } = require('../../dist/media/service.js');
const { presignR2Url, writeOnceUploadHeaders } = require('../../dist/media/r2.js');
const { r2 } = require('./fixtures.cjs');
const now = new Date('2026-10-07T15:00:00.123Z');
for (const [remaining, expected] of [[1000000, 900], [900001, 900], [900000, 900], [899999, 899],
  [5000, 5], [1999, 1], [1000, 1], [999, 0], [0, 0], [-1000, -1]]) {
  test(`remaining ${remaining}ms bounds signed PUT TTL to ${expected}s`, () => {
    const expiry = new Date(+now + remaining), ttl = uploadUrlTtlSeconds(expiry, now);
    assert.equal(ttl, expected);
    if (ttl < 1) return;
    const url = presignR2Url(r2, { method: 'PUT', objectKey: 'opaque', expiresInSeconds: ttl, now,
      extraSignedHeaders: writeOnceUploadHeaders('image/png') });
    const params = new URL(url).searchParams;
    assert.equal(Number(params.get('X-Amz-Expires')), ttl);
    const signedStart = Date.parse(params.get('X-Amz-Date').replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    assert.ok(signedStart + ttl * 1000 <= +expiry);
  });
}
test('coordination key canonicalizes UUID spellings, separates tenants and fits PostgreSQL signed bigint', () => {
  const a = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const key = uploadCreateLockKey(a, b);
  assert.equal(uploadCreateLockKey(a.toUpperCase(), b.toUpperCase()), key);
  assert.notEqual(uploadCreateLockKey(b, b), key);
  assert.ok(BigInt(key) >= -(2n ** 63n) && BigInt(key) < 2n ** 63n);
});
