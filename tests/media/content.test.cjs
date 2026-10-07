'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const f = require('./fixtures.cjs');
const { inspectR2Content, MediaContentInvalid, MediaContentUnsupported } = require('../../dist/media/content.js');
const { R2UnavailableError } = require('../../dist/media/r2.js');
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });
const check = (data, mime) => {
  globalThis.fetch = f.objectFetch(data, mime);
  return inspectR2Content(f.r2, 'opaque', mime, data.length, '"opaque-etag-not-sha256"', AbortSignal.timeout(1000));
};
for (const [name, bytes, mime] of [['PNG', f.png, 'image/png'], ['JPEG', f.jpeg, 'image/jpeg'],
  ['WebP', f.webp, 'image/webp'], ['PDF', f.pdf, 'application/pdf']]) {
  test(`${name} real fixture passes bounded format validation`, () => check(bytes, mime));
  test(`${name} truncated known format fails`, () => assert.rejects(check(bytes.subarray(0, -5), mime), MediaContentInvalid));
}
test('PNG declared as JPEG and arbitrary bytes declared PNG fail', async () => {
  await assert.rejects(check(f.png, 'image/jpeg'), MediaContentInvalid);
  await assert.rejects(check(Buffer.from('arbitrary'), 'image/png'), MediaContentInvalid);
});
test('PNG CRC protects against corrupt bytes', async () => {
  const changed = Buffer.from(f.png); changed[45] ^= 1;
  await assert.rejects(check(changed, 'image/png'), MediaContentInvalid);
});
test('no version observation or unknown parser cannot certify integrity', async () => {
  await assert.rejects(inspectR2Content(f.r2, 'opaque', 'image/png', f.png.length, undefined,
    AbortSignal.timeout(1000)), R2UnavailableError);
});
test('video reads skip a huge mdat and fail safely when metadata exceeds 2 MiB', async () => {
  const size = 750 * 1024 * 1024;
  let read = 0;
  globalThis.fetch = async (_url, init) => {
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(from), end = Number(to), data = Buffer.alloc(end - start + 1);
    read += data.length;
    if (start === 0) { data.writeUInt32BE(size - 3 * 1024 * 1024, 0); data.write('mdat', 4); }
    else { data.writeUInt32BE(3 * 1024 * 1024, 0); data.write('moov', 4); }
    return new Response(data, { status: 206, headers: { 'content-range': `bytes ${from}-${to}/${size}`,
      'content-length': String(data.length), etag: '"version"' } });
  };
  await assert.rejects(inspectR2Content(f.r2, 'opaque', 'video/mp4', size, '"version"',
    AbortSignal.timeout(1000)), MediaContentUnsupported);
  assert.equal(read, 32, 'only two small headers; no giant video body');
});
for (const [extension, mime] of [['mp4', 'video/mp4'], ['mov', 'video/quicktime']]) {
  test(`real ${extension} container validates; corrupt/truncated container and MIME swap fail`, async () => {
    const bytes = readFileSync(join(__dirname, `fixtures/clip.${extension}`));
    await check(bytes, mime);
    await assert.rejects(check(bytes.subarray(0, -5), mime), MediaContentInvalid);
    const corrupted = Buffer.from(bytes); corrupted.writeUInt32BE(bytes.length + 1, 0);
    await assert.rejects(check(corrupted, mime), MediaContentInvalid);
    await assert.rejects(check(bytes, extension === 'mp4' ? 'video/quicktime' : 'video/mp4'), MediaContentInvalid);
  });
}
test('PNG expansion is streamed and an inconsistent scanline payload is rejected', async () => {
  const { deflateSync } = require('node:zlib');
  const compressed = deflateSync(Buffer.alloc(1024 * 1024));
  const payload = Buffer.concat([Buffer.from('IDAT'), compressed]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(compressed.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const data = Buffer.concat([f.png.subarray(0, 33), length, payload, checksum, f.png.subarray(-12)]);
  await assert.rejects(check(data, 'image/png'), MediaContentInvalid);
});
test('malformed PDF xref/root references and corrupt video sample-table counts cannot activate', async () => {
  const brokenPdf = Buffer.from(f.pdf.toString().replace('/Root 1 0 R', '/Root 9 0 R'));
  await assert.rejects(check(brokenPdf, 'application/pdf'), MediaContentInvalid);
  const clip = Buffer.from(readFileSync(join(__dirname, 'fixtures/clip.mp4')));
  const sample = clip.indexOf(Buffer.from('stsz'));
  assert.ok(sample > 0); clip.writeUInt32BE(10000, sample + 12);
  await assert.rejects(check(clip, 'video/mp4'), MediaContentInvalid);
});

for (const compressed of [false, true]) test(`PDF xref stream compressed=${compressed} supports bounded root validation`, async () => {
  await check(f.xrefPdf(compressed), 'application/pdf');
  const bad = Buffer.from(f.xrefPdf(compressed).toString('latin1').replace('/Root 1 0 R', '/Root 9 0 R'), 'latin1');
  await assert.rejects(check(bad, 'application/pdf'), MediaContentInvalid);
});
test('deterministic animation and parser ceilings have an explicit terminal category', async () => {
  await assert.rejects(check(f.apng, 'image/png'), (e) => e instanceof MediaContentUnsupported && e.integrityFailureCode === 'MEDIA_FORMAT_UNSUPPORTED');
  const huge = Buffer.from(f.png.subarray(8, 33)); huge.writeUInt32BE(100000, 8); huge.writeUInt32BE(100000, 12);
  const data = Buffer.concat([f.png.subarray(0, 8), f.pngChunk('IHDR', huge.subarray(8, 21)), f.png.subarray(33)]);
  await assert.rejects(check(data, 'image/png'), (e) => e instanceof MediaContentUnsupported && e.integrityFailureCode === 'MEDIA_INSPECTION_LIMIT_EXCEEDED');
});

for (const [extension, mime] of [['mp4', 'video/mp4'], ['mov', 'video/quicktime']]) test(`real Apple fragmented ${extension}: sample spans validate; corrupt offset fails`, async () => {
  const bytes = readFileSync(join(__dirname, `fixtures/fragmented.${extension}`));
  assert.ok(bytes.indexOf('moof') > 0); await check(bytes, mime);
  const damaged = Buffer.from(bytes), run = damaged.indexOf('trun');
  assert.ok(run > 0); assert.ok(damaged.readUIntBE(run + 5, 3) & 1);
  damaged.writeInt32BE(-2147483648, run + 12);
  await assert.rejects(check(damaged, mime), MediaContentInvalid);
});

test('unsupported animation, PDF history and ambiguous container variants are deterministic', async () => {
  const chunk = (type, bytes) => {
    const h = Buffer.alloc(8); h.write(type); h.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([h, bytes, bytes.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const ext = Buffer.alloc(10); ext[0] = 2; ext.writeUIntLE(1, 4, 3); ext.writeUIntLE(1, 7, 3);
  const frame = Buffer.alloc(16); frame.writeUIntLE(1, 6, 3); frame.writeUIntLE(1, 9, 3); frame.writeUIntLE(100, 12, 3);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', ext), chunk('ANIM', Buffer.alloc(6)), chunk('ANMF', Buffer.concat([frame, f.webp.subarray(12)]))]);
  const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  await assert.rejects(check(Buffer.concat([header, body]), 'image/webp'), MediaContentUnsupported);
  const prior = Number(/startxref\s+(\d+)/.exec(f.pdf.toString())[1]);
  const appendOffset = f.pdf.length;
  const incremental = Buffer.concat([f.pdf, Buffer.from(`xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev ${prior} >>\nstartxref\n${appendOffset}\n%%EOF\n`)]);
  await assert.rejects(check(incremental, 'application/pdf'), MediaContentUnsupported);
  const clip = Buffer.from(readFileSync(join(__dirname, 'fixtures/clip.mp4')));
  clip.write('zzzz', clip.indexOf('ftyp') + 4);
  await assert.rejects(check(clip, 'video/mp4'), MediaContentUnsupported);
  const legacy = Buffer.from(readFileSync(join(__dirname, 'fixtures/clip.mov')));
  legacy.write('free', legacy.indexOf('ftyp'));
  await assert.rejects(check(legacy, 'video/quicktime'), MediaContentUnsupported);
});
