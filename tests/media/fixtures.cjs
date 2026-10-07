'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const png = readFileSync(join(__dirname, 'fixtures/pixel.png'));
const jpeg = readFileSync(join(__dirname, 'fixtures/pixel.jpg'));
const webp = readFileSync(join(__dirname, 'fixtures/pixel.webp'));
function pdf() {
  let text = '%PDF-1.4\n';
  const offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>'];
  for (const [i, body] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n`; }
  const start = Buffer.byteLength(text);
  text += 'xref\n0 4\n0000000000 65535 f \n' + offsets.slice(1).map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
const r2 = { endpoint: 'https://r2.invalid', region: 'auto', bucket: 'private-test', accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
function objectFetch(data, mime, options = {}) {
  return async (_url, init = {}) => {
    if (options.error) throw new Error('provider secret bucket object key signed URL body');
    const size = options.size ?? data.length;
    if (init.method === 'HEAD') {
      const headers = { 'content-length': String(size), etag: '"opaque-etag-not-sha256"' };
      if (mime) headers['content-type'] = mime;
      return new Response(null, { status: options.status ?? 200, headers });
    }
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const bytes = data.subarray(Number(from), Number(to) + 1);
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${from}-${to}/${size}`,
      'content-length': String(bytes.length), etag: '"opaque-etag-not-sha256"' } });
  };
}
module.exports = { png, jpeg, webp, pdf: pdf(), r2, objectFetch };
// Standards-shaped fixtures for bounded structural inspection (no renderer required).
function pngChunk(type, body) {
  const payload = Buffer.concat([Buffer.from(type), body]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(body.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, payload, checksum]);
}
const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
const frame = Buffer.alloc(26); frame.writeUInt32BE(1, 4); frame.writeUInt32BE(1, 8); frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
module.exports.apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', animation), pngChunk('fcTL', frame), png.subarray(33)]);
module.exports.pngChunk = pngChunk;
function xrefPdf(compressed = false) {
  let text = '%PDF-1.7\n'; const offsets = [0];
  for (const [i, body] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'].entries()) {
    offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const start = Buffer.byteLength(text); offsets.push(start);
  let bytes = Buffer.alloc(4 * 7);
  for (let i = 0; i < 4; i++) { bytes[i * 7] = i === 0 ? 0 : 1; bytes.writeUInt32BE(offsets[i], i * 7 + 1); bytes.writeUInt16BE(i === 0 ? 65535 : 0, i * 7 + 5); }
  if (compressed) bytes = require('node:zlib').deflateSync(bytes);
  return Buffer.concat([Buffer.from(text + `3 0 obj\n<< /Type /XRef /Size 4 /Root 1 0 R /W [1 4 2] /Length ${bytes.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`), bytes,
    Buffer.from(`\nendstream\nendobj\nstartxref\n${start}\n%%EOF\n`)]);
}
module.exports.xrefPdf = xrefPdf;
