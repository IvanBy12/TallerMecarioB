import { createInflate, inflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { R2UnavailableError, readR2Range, type R2Config } from './r2.js';

export class MediaContentInvalid extends Error {
  constructor() { super('MEDIA_CONTENT_INVALID'); }
}
export class MediaContentUnsupported extends Error {
  constructor(readonly integrityFailureCode: 'MEDIA_FORMAT_UNSUPPORTED' | 'MEDIA_INSPECTION_LIMIT_EXCEEDED' = 'MEDIA_FORMAT_UNSUPPORTED') {
    super(integrityFailureCode);
  }
}
function unsupported(): never { throw new MediaContentUnsupported(); }
function limit(): never { throw new MediaContentUnsupported('MEDIA_INSPECTION_LIMIT_EXCEEDED'); }
function invalid(): never { throw new MediaContentInvalid(); }
function unavailable(): never { throw new R2UnavailableError(); }
const IMAGE_BUDGET = 21 * 1024 * 1024;
const VIDEO_BUDGET = 2 * 1024 * 1024;

/** Structural inspection, not antivirus, codec decoding, or a full-object digest. */
export async function inspectR2Content(config: R2Config, key: string, mime: string,
  size: number, etag: string | undefined, signal: AbortSignal): Promise<void> {
  if (!etag) unavailable();
  const video = mime.startsWith('video/');
  let remaining = video ? VIDEO_BUDGET : IMAGE_BUDGET;
  let calls = 0;
  const read = async (offset: number, length: number): Promise<Buffer> => {
    if (signal.aborted) unavailable();
    if (++calls > 128 || length > remaining) limit();
    if (length < 1 || offset < 0 || offset + length > size) invalid();
    remaining -= length;
    const bytes = Buffer.alloc(length);
    for (let p = 0; p < length; p += 1024 * 1024) {
      bytes.set(await readR2Range(config, key, size, etag as string, offset + p,
        Math.min(1024 * 1024, length - p), signal), p);
    }
    return bytes;
  };
  if (video) await inspectVideo(read, size, mime);
  else {
    const data = await read(0, size);
    switch (mime) {
      case 'image/png': await inspectPng(data, signal); break;
      case 'image/jpeg': inspectJpeg(data); break;
      case 'image/webp': inspectWebp(data); break;
      case 'application/pdf': inspectPdf(data); break;
      default: invalid();
    }
  }
  if (signal.aborted) unavailable();
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inspectPng(data: Buffer, signal: AbortSignal): Promise<void> {
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid();
  let p = 8, chunks = 0, header: Buffer | undefined, palette = false, ended = false, idatEnded = false;
  const compressed: Buffer[] = [];
  while (p < data.length) {
    if (++chunks > 4096) limit();
    if (p + 12 > data.length) invalid();
    const length = data.readUInt32BE(p), type = data.toString('ascii', p + 4, p + 8);
    if (p + 12 + length > data.length || !/^[A-Za-z]{4}$/.test(type)) invalid();
    if (crc32(data.subarray(p + 4, p + 8 + length)) !== data.readUInt32BE(p + 8 + length)) invalid();
    const body = data.subarray(p + 8, p + 8 + length);
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      header = body;
    } else if (type === 'PLTE') {
      if (palette || compressed.length || length < 3 || length > 768 || length % 3) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (idatEnded) invalid();
      compressed.push(body);
    } else {
      if (compressed.length) idatEnded = true;
      if (type === 'IEND') {
        if (length || !compressed.length || p + 12 !== data.length) invalid();
        ended = true;
      } else if (type === 'acTL') unsupported(); // Animated PNG needs a dedicated bounded decoder.
      else if (type[0] === type[0].toUpperCase()) invalid();
    }
    p += 12 + length;
  }
  if (!header || !ended) invalid();
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), depth = header[8], color = header[9];
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth)
    || header[10] || header[11] || header[12] > 1 || (color === 3 && !palette)) invalid();
  const passes = header[12] === 0 ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const rows: { count: number; stride: number }[] = [];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (!w || !h) continue;
    const stride = 1 + Math.ceil(w * channels[color] * depth / 8);
    expected += h * stride;
    rows.push({ count: h, stride });
  }
  if (expected > 64 * 1024 * 1024) limit(); // Resource ceiling, never a product dimension policy.
  // Inspect decompressed scanline boundaries incrementally; never retain the expanded image.
  const source = Readable.from(compressed);
  const decoder = createInflate({ chunkSize: 65536 });
  const abort = () => decoder.destroy(new R2UnavailableError());
  if (signal.aborted) unavailable();
  signal.addEventListener('abort', abort, { once: true });
  source.pipe(decoder);
  let total = 0, pass = 0, row = 0, nextFilter = 0;
  try {
    for await (const output of decoder) {
      const bytes = output as Buffer;
      if (total + bytes.length > expected) invalid();
      while (nextFilter < total + bytes.length && pass < rows.length) {
        if (bytes[nextFilter - total] > 4) invalid();
        nextFilter += rows[pass].stride;
        if (++row === rows[pass].count) { pass++; row = 0; }
      }
      total += bytes.length;
    }
  } catch (error) {
    if (error instanceof MediaContentInvalid) throw error;
    if ((error as NodeJS.ErrnoException).code?.startsWith('Z_')) invalid();
    unavailable();
  } finally { signal.removeEventListener('abort', abort); source.destroy(); decoder.destroy(); }
  if (total !== expected) invalid();

}

function inspectJpeg(data: Buffer): void {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) invalid();
  let p = 2, frame = false, scan = false, quantization = false, huffman = false;
  while (p < data.length) {
    if (data[p++] !== 0xff) invalid();
    while (data[p] === 0xff) p++;
    const marker = data[p++];
    if (marker === 0xd9) {
      if (!frame || !scan || !quantization || !huffman || p !== data.length) invalid();
      return;
    }
    if (p + 2 > data.length || marker === 0 || marker === 0xd8) invalid();
    const length = data.readUInt16BE(p);
    if (length < 2 || p + length > data.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || length < 11 || !data.readUInt16BE(p + 3) || !data.readUInt16BE(p + 5)
        || length !== 8 + 3 * data[p + 7]) invalid();
      frame = true;
    } else if (marker === 0xdb) {
      let table = p + 2;
      while (table < p + length) {
        const descriptor = data[table++];
        if ((descriptor >>> 4) > 1 || (descriptor & 15) > 3) invalid();
        table += 64 * ((descriptor >>> 4) + 1);
        if (table > p + length) invalid();
        quantization = true;
      }
      if (length === 2) invalid();
    } else if (marker === 0xc4) {
      let table = p + 2;
      while (table < p + length) {
        const descriptor = data[table++];
        if ((descriptor >>> 4) > 1 || (descriptor & 15) > 3 || table + 16 > p + length) invalid();
        let symbols = 0;
        for (let i = 0; i < 16; i++) symbols += data[table++];
        if (!symbols || symbols > 256 || table + symbols > p + length) invalid();
        table += symbols; huffman = true;
      }
      if (length === 2) invalid();
    }
    else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) unsupported();
    p += length;
    if (marker === 0xda) {
      const components = data[p - length + 2];
      if (!frame || !quantization || !huffman || !components || length !== 6 + 2 * components) invalid();
      scan = true;
      const start = p;
      while (p < data.length) {
        if (data[p] !== 0xff) { p++; continue; }
        const next = data[p + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { p += 2; continue; }
        if (next === 0xff) { p++; continue; }
        break;
      }
      if (p === start) invalid();
    }
  }
  invalid();
}

function inspectWebp(data: Buffer): void {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) invalid();
  let p = 12, image = false;
  while (p < data.length) {
    if (p + 8 > data.length) invalid();
    const type = data.toString('ascii', p, p + 4), length = data.readUInt32LE(p + 4), start = p + 8;
    if (start + length + (length & 1) > data.length) invalid();
    if (type === 'ANIM' || type === 'ANMF') unsupported();
    if (type === 'VP8 ' || type === 'VP8L') {
      if (image) invalid();
      image = true;
      if (type === 'VP8 ') {
        if (length < 10 || (data[start] & 1) || !data.subarray(start + 3, start + 6).equals(Buffer.from('9d012a', 'hex'))
          || !(data.readUInt16LE(start + 6) & 0x3fff) || !(data.readUInt16LE(start + 8) & 0x3fff)
          || (data.readUIntLE(start, 3) >>> 5) + 3 > length) invalid();
      } else if (length < 6 || data[start] !== 0x2f || (data[start + 4] & 0xe0)) invalid();
    } else if (type === 'VP8X') {
      if (p !== 12 || length !== 10 || (data[start] & 0xc1)
        || data[start + 1] || data[start + 2] || data[start + 3]) invalid();
      if (data[start] & 2) unsupported();
    }
    p = start + length + (length & 1);
  }
  if (!image) invalid();
}

function inspectPdf(data: Buffer): void {
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(data.toString('latin1', 0, 16))) invalid();
  const tail = data.toString('latin1', Math.max(0, data.length - 4096));
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!match) invalid();
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) invalid();
  const xref = data.toString('latin1', offset, Math.min(data.length, offset + 1024 * 1024));
  if (!/^xref\s/.test(xref)) {
    if (/^\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b/.test(xref)) { inspectPdfXrefStream(data, offset); return; }
    invalid();
  }
  const entries = new Map<number, { offset: number; generation: number }>();
  let p = 4;
  while (true) {
    const whitespace = /^\s*/.exec(xref.slice(p)) as RegExpExecArray;
    p += whitespace[0].length;
    if (xref.startsWith('trailer', p)) break;
    const section = /^(\d+)\s+(\d+)\s*[\r\n]+/.exec(xref.slice(p));
    if (!section) { if (xref.length === 1024 * 1024) limit(); invalid(); }
    const first = Number(section[1]), count = Number(section[2]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || !count) invalid();
    if (count > 100000 || entries.size + count > 100000) limit();
    p += section[0].length;
    for (let i = 0; i < count; i++) {
      const entry = /^(\d{10}) (\d{5}) ([nf])(?:[ \r\n]+)/.exec(xref.slice(p));
      if (!entry) invalid();
      p += entry[0].length;
      if (entry[3] === 'f') continue;
      const objectOffset = Number(entry[1]), generation = Number(entry[2]), id = first + i;
      if (objectOffset >= offset || generation > 65535 || entries.has(id)) invalid();
      const object = data.toString('latin1', objectOffset, Math.min(data.length, objectOffset + 64));
      const objectHeader = /^(\d+)\s+(\d+)\s+obj\b/.exec(object);
      if (!objectHeader || Number(objectHeader[1]) !== id || Number(objectHeader[2]) !== generation) invalid();
      entries.set(id, { offset: objectOffset, generation });
    }
  }
  const trailer = xref.slice(p);
  if (/\/Prev\b|\/XRefStm\b/.test(trailer)) unsupported(); // Incremental/hybrid files require fuller bounded parsing.
  validatePdfRoot(data, trailer, entries);
}

function validatePdfRoot(data: Buffer, trailer: string, entries: Map<number, { offset: number; generation: number }>): void {
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(trailer);
  const size = /\/Size\s+([1-9]\d*)/.exec(trailer);
  let largestId = 0;
  for (const id of entries.keys()) largestId = Math.max(largestId, id);
  if (!root || !size || Number(size[1]) <= largestId) invalid();
  const rootEntry = entries.get(Number(root[1]));
  if (!rootEntry || rootEntry.generation !== Number(root[2])) invalid();
  const catalog = data.toString('latin1', rootEntry.offset, Math.min(data.length, rootEntry.offset + 65536));
  const end = catalog.indexOf('endobj');
  if (end < 0) { if (catalog.length === 65536) limit(); invalid(); }
  const pages = /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(catalog.slice(0, end));
  if (!/\/Type\s*\/Catalog\b/.test(catalog.slice(0, end)) || !pages) invalid();
  const pagesEntry = entries.get(Number(pages[1]));
  if (!pagesEntry || pagesEntry.generation !== Number(pages[2])) invalid();
  const pageTree = data.toString('latin1', pagesEntry.offset, Math.min(data.length, pagesEntry.offset + 65536));
  const pageEnd = pageTree.indexOf('endobj');
  if (pageEnd < 0) { if (pageTree.length === 65536) limit(); invalid(); }
  if (!/\/Type\s*\/Pages\b/.test(pageTree.slice(0, pageEnd))) invalid();
}

function inspectPdfXrefStream(data: Buffer, offset: number): void {
  const prefix = data.toString('latin1', offset, Math.min(data.length, offset + 65536));
  const header = /^(\d+)\s+(\d+)\s+obj\s*(<<[\s\S]*?>>)\s*stream(?:\r\n|\n|\r)/.exec(prefix);
  if (!header) { if (prefix.length === 65536) limit(); invalid(); }
  const dict = header[3];
  if (/\/Prev\b|\/XRefStm\b|\/DecodeParms\b/.test(dict)) unsupported();
  const widths = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dict);
  const length = /\/Length\s+(\d+)\s*(?!\d)(?!\s+\d+\s+R)/.exec(dict);
  const size = /\/Size\s+([1-9]\d*)\b/.exec(dict);
  if (!widths || !size) invalid();
  if (!length) unsupported(); // Indirect lengths need a bounded object resolver.
  const w = widths.slice(1).map(Number), n = Number(size[1]), byteLength = Number(length[1]);
  if (w.some((v) => v > 6) || n > 100000) limit();
  const stride = w.reduce((a, b) => a + b, 0);
  if (!stride || !Number.isSafeInteger(byteLength) || byteLength < 1) invalid();
  const indexMatch = /\/Index\s*\[([^\]]*)\]/.exec(dict);
  const index = indexMatch ? indexMatch[1].trim().split(/\s+/).map(Number) : [0, n];
  if (index.length % 2 || index.some((v) => !Number.isSafeInteger(v) || v < 0)) invalid();
  let total = 0;
  for (let i = 0; i < index.length; i += 2) {
    if (!index[i + 1] || index[i] + index[i + 1] > n) invalid();
    total += index[i + 1];
  }
  if (total > 100000) limit();
  const start = offset + header[0].length, end = start + byteLength;
  if (end > data.length || !/^\s*endstream\s+endobj\b/.test(data.toString('latin1', end, end + 64))) invalid();
  let bytes = data.subarray(start, end);
  const filter = /\/Filter\b/.test(dict);
  if (filter && !/\/Filter\s*(?:\/FlateDecode\b|\[\s*\/FlateDecode\s*\])/.test(dict)) unsupported();
  if (filter) {
    try { bytes = inflateSync(bytes, { maxOutputLength: 2 * 1024 * 1024 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') limit();
      if ((error as NodeJS.ErrnoException).code?.startsWith('Z_')) invalid();
      unavailable();
    }
  }
  if (bytes.length !== total * stride) invalid();
  const entries = new Map<number, { offset: number; generation: number }>();
  let p = 0;
  for (let k = 0; k < index.length; k += 2) for (let j = 0; j < index[k + 1]; j++) {
    const values = w.map((width, column) => {
      let value = width === 0 && column === 0 ? 1 : 0;
      for (let c = 0; c < width; c++) value = value * 256 + bytes[p++];
      return value;
    });
    const id = index[k] + j;
    if (values[0] === 2) unsupported(); // Object streams require an additional object resolver.
    if (values[0] !== 0 && values[0] !== 1) invalid();
    if (values[0] === 0) continue;
    const object = /^(\d+)\s+(\d+)\s+obj\b/.exec(data.toString('latin1', values[1], values[1] + 64));
    if (!object || values[1] > offset || values[2] > 65535 || Number(object[1]) !== id
      || Number(object[2]) !== values[2] || entries.has(id)) invalid();
    entries.set(id, { offset: values[1], generation: values[2] });
  }
  validatePdfRoot(data, dict, entries);
}

type ReadAt = (offset: number, length: number) => Promise<Buffer>;
interface Atom { type: string; start: number; end: number; body: number }
function atoms(data: Buffer, start = 0, end = data.length): Atom[] {
  const result: Atom[] = [];
  for (let p = start; p < end;) {
    if (result.length > 10000) limit();
    if (p + 8 > end) invalid();
    let length = data.readUInt32BE(p), header = 8;
    if (length === 1) {
      if (p + 16 > end) invalid();
      const wide = data.readBigUInt64BE(p + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      length = Number(wide); header = 16;
    } else if (length === 0) length = end - p;
    if (length < header || p + length > end) invalid();
    result.push({ type: data.toString('latin1', p + 4, p + 8), start: p, end: p + length, body: p + header });
    p += length;
  }
  return result;
}
function child(data: Buffer, parent: Atom, type: string): Atom {
  const found = atoms(data, parent.body, parent.end).find((a) => a.type === type);
  if (!found) invalid();
  return found;
}
async function inspectVideo(read: ReadAt, size: number, mime: string): Promise<void> {
  let p = 0, count = 0, brand: string | undefined, moov: Buffer | undefined;
  const media: { start: number; end: number }[] = [];
  const fragments: { offset: number; bytes: Buffer }[] = [];
  while (p < size) {
    if (++count > 128) limit();
    const header = await read(p, Math.min(16, size - p));
    if (header.length < 8) invalid();
    let length = header.readUInt32BE(0), headerSize = 8;
    const type = header.toString('latin1', 4, 8);
    if (length === 1) {
      if (header.length < 16) invalid();
      const wide = header.readBigUInt64BE(8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      length = Number(wide); headerSize = 16;
    } else if (length === 0) length = size - p;
    if (length < headerSize || p + length > size) invalid();
    if (type === 'ftyp') {
      if (brand || length < headerSize + 8 || (length - headerSize) % 4) invalid();
      brand = (await read(p + headerSize, 8)).toString('latin1', 0, 4);
    } else if (type === 'moov') {
      if (moov) invalid();
      moov = await read(p, length);
    } else if (type === 'mdat') {
      if (length <= headerSize) invalid();
      media.push({ start: p + headerSize, end: p + length });
    } else if (type === 'moof') fragments.push({ offset: p, bytes: await read(p, length) });
    p += length;
  }
  if (!moov || !media.length) invalid();
  if (!brand) unsupported(); // Older QuickTime without ftyp is ambiguous under exact MIME validation.
  if (mime === 'video/quicktime' ? brand !== 'qt  ' : brand === 'qt  ') invalid();
  if (mime === 'video/mp4' && !['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash'].includes(brand)) unsupported();
  const root = atoms(moov)[0];
  const mvhd = child(moov, root, 'mvhd');
  const version = moov[mvhd.body];
  if (version > 1 || mvhd.end - mvhd.body < (version === 1 ? 112 : 100)) invalid();
  const tracks = atoms(moov, root.body, root.end).filter((a) => a.type === 'trak');
  let video = false;
  const videoTrackIds = new Set<number>();
  for (const track of tracks) {
    const mdia = child(moov, track, 'mdia'), hdlr = child(moov, mdia, 'hdlr');
    if (hdlr.end - hdlr.body < 24) invalid();
    if (moov.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    video = true;
    const stbl = child(moov, child(moov, mdia, 'minf'), 'stbl');
    const stsd = child(moov, stbl, 'stsd'), stsz = child(moov, stbl, 'stsz');
    if (fragments.length) {
      const tkhd = child(moov, track, 'tkhd'), mdhd = child(moov, mdia, 'mdhd');
      if (tkhd.end - tkhd.body < (moov[tkhd.body] === 1 ? 96 : 84)
        || mdhd.end - mdhd.body < (moov[mdhd.body] === 1 ? 36 : 24)
        || stsd.end - stsd.body < 16 || stsz.end - stsz.body < 12) invalid();
      const id = moov.readUInt32BE(tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12));
      if (!id || videoTrackIds.has(id)) invalid();
      videoTrackIds.add(id);
      const entries = atoms(moov, stsd.body + 8, stsd.end);
      if (!entries.length || entries.length !== moov.readUInt32BE(stsd.body + 4)
        || entries.some((entry) => entry.end - entry.body < 78)) invalid();
      // Mixed fragmented/non-fragmented sample tables need a separate resolver.
      if (moov.readUInt32BE(stsz.body + 8)) unsupported();
      if (stsz.end - stsz.body !== 12) invalid();
      continue;
    }

    if (stsd.end - stsd.body < 16 || !moov.readUInt32BE(stsd.body + 4)
      || stsz.end - stsz.body < 12 || !moov.readUInt32BE(stsz.body + 8)) invalid();
    const sampleCount = moov.readUInt32BE(stsz.body + 8), sampleSize = moov.readUInt32BE(stsz.body + 4);
    if (stsz.end - stsz.body !== 12 + (sampleSize === 0 ? 4 * sampleCount : 0)) invalid();
    const tkhd = child(moov, track, 'tkhd'), mdhd = child(moov, mdia, 'mdhd');
    if (tkhd.end - tkhd.body < (moov[tkhd.body] === 1 ? 96 : 84)
      || mdhd.end - mdhd.body < (moov[mdhd.body] === 1 ? 36 : 24)) invalid();
    const stts = child(moov, stbl, 'stts'), stsc = child(moov, stbl, 'stsc');
    if (stts.end - stts.body < 8 || stsc.end - stsc.body < 8) invalid();
    const timingCount = moov.readUInt32BE(stts.body + 4), mappingCount = moov.readUInt32BE(stsc.body + 4);
    if (!timingCount || !mappingCount || stts.end - stts.body !== 8 + timingCount * 8
      || stsc.end - stsc.body !== 8 + mappingCount * 12) invalid();
    let timedSamples = 0;
    for (let i = 0; i < timingCount; i++) timedSamples += moov.readUInt32BE(stts.body + 8 + i * 8);
    if (timedSamples !== sampleCount) invalid();
    const entries = atoms(moov, stsd.body + 8, stsd.end);
    if (entries.length !== moov.readUInt32BE(stsd.body + 4)) invalid();
    if (entries.some((entry) => entry.end - entry.body < 78)) invalid();
    const stco = atoms(moov, stbl.body, stbl.end).find((a) => ['stco', 'co64'].includes(a.type));
    if (!stco || stco.end - stco.body < 8) invalid();
    const n = moov.readUInt32BE(stco.body + 4), width = stco.type === 'co64' ? 8 : 4;
    if (!n || stco.end - stco.body !== 8 + n * width) invalid();
    for (let i = 0; i < n; i++) {
      const offset = width === 8 ? Number(moov.readBigUInt64BE(stco.body + 8 + i * width))
        : moov.readUInt32BE(stco.body + 8 + i * width);
      if (!media.some((m) => offset >= m.start && offset < m.end)) invalid();
    }
  }
  if (!video) invalid();
  if (fragments.length) inspectFragments(moov, root, fragments, media, videoTrackIds);
  // Duration policy is DURATION_POLICY_UNRESOLVED; no numeric gate is applied.
}

/** Bounded ISO-BMFF fragments with explicit or moof-relative data offsets.
 * Validate sample sizes and byte spans; encoded samples are never downloaded.
 */
function inspectFragments(moov: Buffer, root: Atom, fragments: { offset: number; bytes: Buffer }[],
  media: { start: number; end: number }[], videoTracks: Set<number>): void {
  const mvex = child(moov, root, 'mvex');
  const defaults = new Map<number, number>();
  for (const atom of atoms(moov, mvex.body, mvex.end).filter((a) => a.type === 'trex')) {
    if (atom.end - atom.body !== 24 || moov[atom.body] !== 0) invalid();
    const id = moov.readUInt32BE(atom.body + 4);
    if (!id || defaults.has(id)) invalid();
    defaults.set(id, moov.readUInt32BE(atom.body + 16));
  }
  let samples = 0, priorSequence = -1;
  const seen = new Set<number>();
  for (const fragment of fragments) {
    const d = fragment.bytes, parent = atoms(d)[0], mfhd = child(d, parent, 'mfhd');
    if (mfhd.end - mfhd.body !== 8 || d[mfhd.body] !== 0) invalid();
    const sequence = d.readUInt32BE(mfhd.body + 4);
    if (sequence <= priorSequence) invalid();
    priorSequence = sequence;
    const tracks = atoms(d, parent.body, parent.end).filter((a) => a.type === 'traf');
    if (!tracks.length) invalid();
    for (const track of tracks) {
      const tfhd = child(d, track, 'tfhd');
      if (tfhd.end - tfhd.body < 8 || d[tfhd.body] !== 0) invalid();
      const flags = d.readUIntBE(tfhd.body + 1, 3), id = d.readUInt32BE(tfhd.body + 4);
      if (!defaults.has(id)) invalid();
      if (flags & ~0x03003b) unsupported();
      let p = tfhd.body + 8, base: number, sampleSize = defaults.get(id) as number;
      const field = (width: number): number => {
        if (p + width > tfhd.end) invalid();
        const value = width === 8 ? Number(d.readBigUInt64BE(p)) : d.readUInt32BE(p);
        p += width; if (!Number.isSafeInteger(value)) invalid(); return value;
      };
      if (flags & 1) base = field(8);
      else if (flags & 0x020000) base = fragment.offset;
      else unsupported(); // Implicit previous-fragment bases require another resolver.
      if (flags & 2) field(4);
      if (flags & 8) field(4);
      if (flags & 16) sampleSize = field(4);
      if (flags & 32) field(4);
      if (p !== tfhd.end) invalid();
      const tfdt = atoms(d, track.body, track.end).find((a) => a.type === 'tfdt');
      if (tfdt && (d[tfdt.body] > 1 || tfdt.end - tfdt.body !== (d[tfdt.body] === 1 ? 12 : 8))) invalid();
      let next: number | undefined;
      const runs = atoms(d, track.body, track.end).filter((a) => a.type === 'trun');
      if (!runs.length) invalid();
      for (const run of runs) {
        if (run.end - run.body < 8 || d[run.body] > 1) invalid();
        const runFlags = d.readUIntBE(run.body + 1, 3), count = d.readUInt32BE(run.body + 4);
        if (runFlags & ~0x000f05) unsupported();
        if (!count) invalid();
        if ((samples += count) > 100000) limit();
        let q = run.body + 8;
        const value = (signed = false): number => {
          if (q + 4 > run.end) invalid();
          const v = signed ? d.readInt32BE(q) : d.readUInt32BE(q); q += 4; return v;
        };
        let start: number;
        if (runFlags & 1) start = base + value(true);
        else if (next !== undefined) start = next;
        else unsupported();
        if (runFlags & 4) value();
        let length = 0;
        for (let i = 0; i < count; i++) {
          if (runFlags & 0x100) value();
          const size = runFlags & 0x200 ? value() : sampleSize;
          if (!size) invalid();
          length += size;
          if (runFlags & 0x400) value();
          if (runFlags & 0x800) value(d[run.body] === 1);
        }
        if (q !== run.end || !media.some((m) => start >= m.start && start + length <= m.end)) invalid();
        next = start + length;
        if (videoTracks.has(id)) seen.add(id);
      }
    }
  }
  if (![...videoTracks].every((id) => seen.has(id))) invalid();
}
