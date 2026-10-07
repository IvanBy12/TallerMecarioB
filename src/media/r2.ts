import { createHash, createHmac } from 'node:crypto';
import { setTimeout as backoff } from 'node:timers/promises';

/**
 * ADR-003: media never streams through the API. This module only builds
 * short-lived AWS SigV4 presigned URLs against Cloudflare R2 (S3-compatible)
 * and performs bounded server-side integrity reads of objects already in R2.
 * Client uploads still go directly to R2. No AWS SDK
 * dependency: R2's presign surface is a handful of well-defined string
 * operations over Node's built-in crypto + global fetch (Node 26).
 */
export interface R2Config {
  /** e.g. https://<accountid>.r2.cloudflarestorage.com (no bucket, no trailing slash). */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function loadR2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config {
  const endpoint = env.R2_ENDPOINT;
  const region = env.R2_REGION;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint?.trim() || !region?.trim() || !bucket?.trim()
    || !accessKeyId?.trim() || !secretAccessKey?.trim()) {
    throw new Error('R2_CONFIGURATION_MISSING');
  }
  try {
    if (new URL(endpoint).protocol !== 'https:') throw new Error();
  } catch {
    throw new Error('R2_CONFIGURATION_MISSING');
  }
  return { endpoint: endpoint.replace(/\/$/, ''), region, bucket, accessKeyId, secretAccessKey };
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC 3986 percent-encoding as SigV4 requires it (stricter than encodeURIComponent). */
function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface PresignOptions {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  objectKey: string;
  expiresInSeconds: number;
  /** Header name (lowercase) -> exact value the caller must send. Forces that header to match. */
  extraSignedHeaders?: Record<string, string>;
  now?: Date;
}

/** Exact headers that a client must send with a write-once presigned PUT. */
export function writeOnceUploadHeaders(contentType: string): Record<string, string> {
  return { 'Content-Type': contentType, 'If-None-Match': '*' };
}

/** Builds a presigned R2 URL (query-string SigV4, path-style bucket addressing). */
export function presignR2Url(config: R2Config, options: PresignOptions): string {
  const now = options.now ?? new Date();
  const amz = amzDate(now);
  const dateStamp = amz.slice(0, 8);
  const service = 's3';
  const credentialScope = `${dateStamp}/${config.region}/${service}/aws4_request`;

  const host = new URL(config.endpoint).host;
  const canonicalUri = `/${uriEncode(config.bucket, false)}/${options.objectKey
    .split('/')
    .map((segment) => uriEncode(segment, false))
    .join('/')}`;

  const extraHeaders = options.extraSignedHeaders ?? {};
  const headerValues: Record<string, string> = { host };
  for (const [name, value] of Object.entries(extraHeaders)) {
    headerValues[name.toLowerCase()] = value;
  }
  // A presigned PUT remains a capability until expiry, but may create its key
  // only once. The condition belongs in SigV4's canonical headers: omitting or
  // changing it must invalidate the URL, not turn it into an overwrite token.
  if (options.method === 'PUT') {
    if (headerValues['if-none-match'] !== undefined && headerValues['if-none-match'] !== '*') {
      throw new Error('R2_PUT_REQUIRES_IF_NONE_MATCH_STAR');
    }
    headerValues['if-none-match'] = '*';
  }
  const signedHeaderNames = Object.keys(headerValues).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headerValues[name].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(options.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((key) => `${uriEncode(key, true)}=${uriEncode(queryParams[key], true)}`)
    .join('&');

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amz, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `${config.endpoint}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

export interface R2ObjectHead {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
  etag?: string;
}

/** Opaque transport failure: never expose provider response bodies or URLs. */
export class R2UnavailableError extends Error {
  constructor() { super('MEDIA_STORAGE_UNAVAILABLE'); }
}

// Internal retry classification never leaves this adapter.
class R2TransientError extends R2UnavailableError {}
const READ_ATTEMPT_TIMEOUT_MS = 4000;
const READ_RETRY_BACKOFF_MS = 25;

/** Two attempts for safe reads only. The caller's overall signal always wins,
 * including during body consumption and backoff; no new completion deadline.
 */
async function safeInspectionRead<T>(signal: AbortSignal, read: (attemptSignal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) throw new R2UnavailableError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_ATTEMPT_TIMEOUT_MS);
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const result = await read(attemptSignal);
      if (attemptSignal.aborted) throw new R2TransientError();
      return result;
    } catch (error) {
      if (signal.aborted || attempt === 1
        || (!(error instanceof R2TransientError) && !controller.signal.aborted)) throw new R2UnavailableError();
    } finally { clearTimeout(timer); }
    try { await backoff(READ_RETRY_BACKOFF_MS, undefined, { signal }); }
    catch { throw new R2UnavailableError(); }
  }
  throw new R2UnavailableError();
}

async function inspectionFetch(url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, init); }
  catch { throw new R2TransientError(); }
}
function transientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Confirms a completed upload without ever reading the object body. */
export async function headR2Object(config: R2Config, objectKey: string, signal = AbortSignal.timeout(5000)): Promise<R2ObjectHead> {
  const url = presignR2Url(config, { method: 'HEAD', objectKey, expiresInSeconds: 60 });
  return safeInspectionRead(signal, async (attemptSignal) => {
    const response = await inspectionFetch(url, { method: 'HEAD', signal: attemptSignal, redirect: 'error' });
    if (response.status === 404) return { exists: false };
    if (transientStatus(response.status)) throw new R2TransientError();
    if (response.status !== 200) throw new R2UnavailableError();
    const contentLength = response.headers.get('content-length');
    if (contentLength === null || !/^\d+$/.test(contentLength)
      || !Number.isSafeInteger(Number(contentLength))) throw new R2UnavailableError();
    return { exists: true, sizeBytes: Number(contentLength),
      contentType: response.headers.get('content-type') ?? undefined,
      etag: response.headers.get('etag') ?? undefined };
  });
}

/** Exact bounded range, pinned to the HEAD observation. ETag is only a version token. */
export async function readR2Range(config: R2Config, objectKey: string, size: number,
  etag: string, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0
    || length < 1 || length > 1024 * 1024 || offset + length > size || !etag) throw new R2UnavailableError();
  const headers = { Range: `bytes=${offset}-${offset + length - 1}`, 'If-Match': etag };
  const url = presignR2Url(config, { method: 'GET', objectKey, expiresInSeconds: 60,
    extraSignedHeaders: headers });
  return safeInspectionRead(signal, async (attemptSignal) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await inspectionFetch(url, { headers, signal: attemptSignal, redirect: 'error' });
      if (transientStatus(response.status)) {
        await response.body?.cancel();
        throw new R2TransientError();
      }
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${offset + length - 1}/${size}`
        || response.headers.get('etag') !== etag || response.headers.get('content-encoding')
        || response.headers.get('content-length') !== String(length) || !response.body) {
        await response.body?.cancel();
        throw new R2UnavailableError();
      }
      reader = response.body.getReader();
      const bytes = Buffer.alloc(length);
      let count = 0;
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { throw new R2TransientError(); }
        if (chunk.done) break;
        if (count + chunk.value.length > length) throw new R2UnavailableError();
        bytes.set(chunk.value, count);
        count += chunk.value.length;
      }
      if (count !== length) throw new R2UnavailableError();
      return bytes;
    } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  });
}

/** Test/cleanup helper -- production purge flow is documented separately (retention baseline). */
export async function deleteR2Object(config: R2Config, objectKey: string): Promise<void> {
  const url = presignR2Url(config, { method: 'DELETE', objectKey, expiresInSeconds: 60 });
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`R2_DELETE_FAILED_${response.status}`);
}
