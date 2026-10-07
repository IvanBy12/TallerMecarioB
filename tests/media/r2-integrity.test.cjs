'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { readR2Range, headR2Object, presignR2Url, R2UnavailableError } = require('../../dist/media/r2.js');
const { r2 } = require('./fixtures.cjs');
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
const read = (signal = AbortSignal.timeout(1000)) => readR2Range(r2, 'opaque', 10, '"version"', 2, 3, signal);
test('Range + opaque If-Match are in the SigV4 signature and request; bounded bytes returned', async () => {
  globalThis.fetch = async (url, init) => {
    assert.deepEqual(init.headers, { Range: 'bytes=2-4', 'If-Match': '"version"' });
    const signed = new URL(url);
    assert.equal(signed.searchParams.get('X-Amz-SignedHeaders'), 'host;if-match;range');
    const now = new Date(signed.searchParams.get('X-Amz-Date').replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    const changed = presignR2Url(r2, { method: 'GET', objectKey: 'opaque', expiresInSeconds: 60, now,
      extraSignedHeaders: { Range: 'bytes=2-5', 'If-Match': '"version"' } });
    assert.notEqual(new URL(changed).searchParams.get('X-Amz-Signature'), signed.searchParams.get('X-Amz-Signature'));
    return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"version"' } });
  };
  assert.equal((await read()).toString(), 'abc');
});
for (const [name, status, headers, bytes] of [
  ['ignored range', 200, {}, 'abc'], ['5xx', 503, {}, 'sensitive provider body'],
  ['wrong range', 206, { 'content-range': 'bytes 0-2/10' }, 'abc'],
  ['version changed', 206, { etag: '"new"' }, 'abc'], ['content encoding', 206, { 'content-encoding': 'gzip' }, 'abc'],
  ['oversized body', 206, {}, 'abcd'], ['truncated transport body', 206, {}, 'ab'],
]) test(`${name} is a safe recoverable error, not deterministic invalid media`, async () => {
  globalThis.fetch = async () => new Response(bytes, { status, headers: {
    'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"version"', ...headers } });
  await assert.rejects(read(), (e) => e instanceof R2UnavailableError && e.message === 'MEDIA_STORAGE_UNAVAILABLE');
});
test('oversized range is denied before any fetch', async () => {
  globalThis.fetch = () => { throw new Error('must not fetch'); };
  await assert.rejects(readR2Range(r2, 'opaque', 10000000, '"version"', 0, 1048577, AbortSignal.timeout(1000)), R2UnavailableError);
});
test('deadline aborts HEAD and body reads; provider errors never leak', async () => {
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('secret URL provider timeout')), { once: true });
  });
  const timer = setTimeout(() => {}, 100);
  try {
    await assert.rejects(headR2Object(r2, 'opaque', AbortSignal.timeout(5)), R2UnavailableError);
    await assert.rejects(read(AbortSignal.timeout(5)), R2UnavailableError);
  } finally { clearTimeout(timer); }
});
test('unusable HEAD size is recoverable; zero is an actual size observation', async () => {
  for (const value of [null, 'NaN', '-1', '1.5', '9007199254740993']) {
    globalThis.fetch = async () => new Response(null, { headers: value === null ? {} : { 'content-length': value } });
    await assert.rejects(headR2Object(r2, 'opaque'), R2UnavailableError);
  }
  globalThis.fetch = async () => new Response(null, { headers: { 'content-length': '0' } });
  assert.equal((await headR2Object(r2, 'opaque')).sizeBytes, 0);
});
test('deadline during body consumption aborts and cancels the bounded stream', async () => {
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('a'));
    init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('private transport body failure')); }, { once: true });
  } }), { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"version"' } });
  const timer = setTimeout(() => {}, 100);
  try { await assert.rejects(read(AbortSignal.timeout(5)), R2UnavailableError); assert.equal(aborted, true); }
  finally { clearTimeout(timer); }
});

for (const operation of ['HEAD', 'Range']) {
  const run = (signal = AbortSignal.timeout(1000)) => operation === 'HEAD' ? headR2Object(r2, 'opaque', signal) : read(signal);
  const success = () => operation === 'HEAD' ? new Response(null, { headers: { 'content-length': '3', 'content-type': 'image/png', etag: '"version"' } })
    : new Response('abc', { status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"version"' } });
  for (const failure of ['500', '429', 'transport', 'timeout']) test(`${operation} ${failure} then success uses exactly two pinned safe reads`, async () => {
    let calls = 0, firstUrl;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (calls === 1) firstUrl = url; else assert.equal(url, firstUrl);
      assert.ok(init.signal); assert.equal(init.redirect, 'error');
      if (operation === 'Range') {
        assert.deepEqual(init.headers, { Range: 'bytes=2-4', 'If-Match': '"version"' });
        assert.equal(new URL(url).searchParams.get('X-Amz-SignedHeaders'), 'host;if-match;range');
      }
      if (calls === 1) {
        if (failure === 'transport') throw new TypeError('private reset URL');
        if (failure === 'timeout') throw new DOMException('private timeout', 'TimeoutError');
        return new Response(operation === 'HEAD' ? null : 'private provider body', { status: Number(failure) });
      }
      return success();
    };
    const result = await run();
    if (operation === 'HEAD') assert.equal(result.sizeBytes, 3); else assert.equal(result.toString(), 'abc');
    assert.equal(calls, 2);
  });
  for (const failure of ['503', 'transport']) test(`${operation} repeated ${failure} exhausts after exactly two attempts`, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; if (failure === 'transport') throw new TypeError('secret'); return new Response(null, { status: 503 }); };
    await assert.rejects(run(), (e) => e instanceof R2UnavailableError && e.message === 'MEDIA_STORAGE_UNAVAILABLE');
    assert.equal(calls, 2);
  });
  for (const status of [400, 401, 403, 404, 412]) test(`${operation} deterministic ${status} is requested once`, async () => {
    let calls = 0; globalThis.fetch = async () => { calls++; return new Response(null, { status }); };
    if (operation === 'HEAD' && status === 404) assert.deepEqual(await run(), { exists: false });
    else await assert.rejects(run(), R2UnavailableError);
    assert.equal(calls, 1);
  });
  test(`${operation} pre-aborted deadline performs zero requests`, async () => {
    let calls = 0; globalThis.fetch = () => { calls++; throw new Error('unexpected'); };
    await assert.rejects(run(AbortSignal.abort()), R2UnavailableError); assert.equal(calls, 0);
  });
  test(`${operation} abort during backoff cannot start a second request`, async () => {
    const controller = new AbortController(); let calls = 0;
    globalThis.fetch = async () => { calls++; queueMicrotask(() => controller.abort()); return new Response(null, { status: 500 }); };
    await assert.rejects(run(controller.signal), R2UnavailableError); assert.equal(calls, 1);
  });
  test(`${operation} overall deadline during initial read prevents retry`, async () => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new TypeError('private reset')), { once: true }));
    };
    await assert.rejects(run(AbortSignal.timeout(10)), R2UnavailableError); assert.equal(calls, 1);
  });
}
test('Range mid-body transport reset retries from byte zero with the same version and range', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; assert.deepEqual(init.headers, { Range: 'bytes=2-4', 'If-Match': '"version"' });
    return new Response(calls === 1 ? new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('a'));
      queueMicrotask(() => controller.error(new TypeError('private midstream reset')));
    } }) : 'abc', { status: 206, headers: {
      'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"version"' } });
  };
  assert.equal((await read()).toString(), 'abc'); assert.equal(calls, 2);
});
test('per-attempt timeout permits one second attempt within the unchanged overall budget', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new TypeError('private timeout')), { once: true }));
    return new Response(null, { headers: { 'content-length': '3' } });
  };
  assert.equal((await headR2Object(r2, 'opaque', AbortSignal.timeout(6000))).sizeBytes, 3); assert.equal(calls, 2);
});
test('Range deterministic version mismatch never retries', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('abc', { status: 206, headers: {
    'content-range': 'bytes 2-4/10', 'content-length': '3', etag: '"different"' } }); };
  await assert.rejects(read(), R2UnavailableError); assert.equal(calls, 1);
});
