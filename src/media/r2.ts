import { createHash, createHmac } from 'node:crypto';

/**
 * ADR-003: media never streams through the API. This module only builds
 * short-lived AWS SigV4 presigned URLs against Cloudflare R2 (S3-compatible)
 * and makes the small out-of-band HEAD/DELETE calls needed to verify/clean up
 * an object -- it never reads or writes the object body itself. No AWS SDK
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
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
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

/** Confirms a completed upload without ever reading the object body. */
export async function headR2Object(config: R2Config, objectKey: string): Promise<R2ObjectHead> {
  const url = presignR2Url(config, { method: 'HEAD', objectKey, expiresInSeconds: 60 });
  const response = await fetch(url, { method: 'HEAD' });
  if (response.status === 404) return { exists: false };
  if (!response.ok) throw new Error(`R2_HEAD_FAILED_${response.status}`);
  const contentLength = response.headers.get('content-length');
  return {
    exists: true,
    sizeBytes: contentLength != null ? Number(contentLength) : undefined,
    contentType: response.headers.get('content-type') ?? undefined,
    etag: response.headers.get('etag') ?? undefined,
  };
}

/** Test/cleanup helper -- production purge flow is documented separately (retention baseline). */
export async function deleteR2Object(config: R2Config, objectKey: string): Promise<void> {
  const url = presignR2Url(config, { method: 'DELETE', objectKey, expiresInSeconds: 60 });
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`R2_DELETE_FAILED_${response.status}`);
}
