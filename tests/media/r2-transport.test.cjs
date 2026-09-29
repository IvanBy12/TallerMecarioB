'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { withR2Stage } = require('./r2-transport.cjs');

function transient(code) {
  return Object.assign(new Error('synthetic transport failure'), { code });
}

for (const method of ['GET', 'HEAD', 'DELETE']) {
  test(`${method} retries a transient transport failure and succeeds`, async () => {
    let calls = 0;
    const delays = [];
    const result = await withR2Stage(`UNIT_${method}`, method, () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed', { cause: transient('UND_ERR_SOCKET') });
      return 'success';
    }, async (ms) => { delays.push(ms); });
    assert.equal(result, 'success');
    assert.equal(calls, 2);
    assert.deepEqual(delays, [100]);
  });
}

for (const status of [403, 412]) {
  test(`HTTP ${status} response is returned without retry`, async () => {
    let calls = 0;
    const response = await withR2Stage('UNIT_HTTP', 'GET', () => {
      calls += 1;
      return { status };
    }, async () => { throw new Error('unexpected delay'); });
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  });
}

test('PUT socket failure is not replayed and diagnostics omit sensitive details', async () => {
  let calls = 0;
  await assert.rejects(withR2Stage('UNIT_PUT', 'PUT', () => {
    calls += 1;
    throw new TypeError('signed-url-secret', { cause: transient('UND_ERR_SOCKET') });
  }, async () => { throw new Error('unexpected delay'); }), (error) => {
    assert.match(error.message, /R2 UNIT_PUT failed: UND_ERR_SOCKET \(attempt 1\/1\)/);
    assert.doesNotMatch(error.message, /signed-url-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('retry limit is three attempts with deterministic backoff', async () => {
  let calls = 0;
  const delays = [];
  await assert.rejects(withR2Stage('UNIT_LIMIT', 'GET', () => {
    calls += 1;
    throw transient('UND_ERR_CONNECT_TIMEOUT');
  }, async (ms) => { delays.push(ms); }),
  /R2 UNIT_LIMIT failed: UND_ERR_CONNECT_TIMEOUT \(attempt 3\/3\)/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 300]);
});

test('non-transient transport codes are not retried', async () => {
  let calls = 0;
  await assert.rejects(withR2Stage('UNIT_OTHER', 'DELETE', () => {
    calls += 1;
    throw transient('CERT_HAS_EXPIRED');
  }, async () => { throw new Error('unexpected delay'); }),
  /R2 UNIT_OTHER failed: CERT_HAS_EXPIRED \(attempt 1\/3\)/);
  assert.equal(calls, 1);
});
