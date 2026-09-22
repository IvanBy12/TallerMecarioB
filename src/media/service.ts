import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { headR2Object, presignR2Url, type R2Config } from './r2.js';
import { MEDIA_TYPES } from '../db/schema.js';

/**
 * ADR-003 flow (create session -> presigned PUT -> client uploads -> complete
 * -> presigned GET), implemented against the `media_assets`/`upload_sessions`
 * contract in Dic. 03. `sql` is always the caller's open, tenant-scoped
 * connection (see `getTenantRequestContext` in ../api/app.js) -- tenant_id
 * here is a defense-in-depth WHERE clause on top of RLS, never the source of
 * tenant truth (AGENTS.md invariant 1).
 */

type MediaType = (typeof MEDIA_TYPES)[number];

const MEDIA_TYPE_MIME_ALLOWLIST: Record<MediaType, readonly string[]> = {
  photo: ['image/jpeg', 'image/png', 'image/webp'],
  video360: ['video/mp4', 'video/quicktime'],
  video: ['video/mp4', 'video/quicktime'],
  signature: ['image/png'],
  quote_pdf: ['application/pdf'],
  document: ['application/pdf', 'image/jpeg', 'image/png'],
};

const MEDIA_TYPE_MAX_BYTES: Record<MediaType, number> = {
  photo: 20 * 1024 * 1024,
  video360: 750 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  signature: 2 * 1024 * 1024,
  quote_pdf: 20 * 1024 * 1024,
  document: 20 * 1024 * 1024,
};

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};

const RETENTION_CLASSES = [
  'ephemeral_upload',
  'operational',
  'warranty_evidence',
  'authorization_evidence',
  'delivery_evidence',
  'document',
] as const;

const RETENTION_POLICY_VERSION = 'v1';
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

export class MediaError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value);
}

function buildObjectKey(tenantId: string, mediaAssetId: string, mimeType: string): string {
  const ext = MIME_EXTENSION[mimeType] ?? 'bin';
  return `tenants/${tenantId}/media/${mediaAssetId}.${ext}`;
}

export interface CreateUploadSessionInput {
  mediaType: string;
  mimeType: string;
  retentionClass: string;
  idempotencyKey: string;
  expectedSizeBytes?: number | null;
  capturedAt?: string | null;
}

export interface UploadSessionResult {
  uploadSessionId: string;
  mediaAssetId: string;
  status: 'pending';
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

export async function createUploadSession(
  sql: postgres.ReservedSql,
  r2: R2Config,
  tenantId: string,
  membershipId: string | null,
  input: CreateUploadSessionInput,
): Promise<UploadSessionResult> {
  if (!isMediaType(input.mediaType)) {
    throw new MediaError(422, 'MEDIA_TYPE_NOT_ALLOWED', `Unsupported media_type '${input.mediaType}'.`);
  }
  if (!RETENTION_CLASSES.includes(input.retentionClass as (typeof RETENTION_CLASSES)[number])) {
    throw new MediaError(422, 'RETENTION_CLASS_NOT_ALLOWED', `Unsupported retention_class '${input.retentionClass}'.`);
  }
  const allowedMimes = MEDIA_TYPE_MIME_ALLOWLIST[input.mediaType];
  if (!allowedMimes.includes(input.mimeType)) {
    throw new MediaError(422, 'MIME_TYPE_NOT_ALLOWED', `mime_type '${input.mimeType}' not allowed for media_type '${input.mediaType}'.`);
  }
  const maxBytes = MEDIA_TYPE_MAX_BYTES[input.mediaType];
  if (input.expectedSizeBytes != null && (input.expectedSizeBytes <= 0 || input.expectedSizeBytes > maxBytes)) {
    throw new MediaError(422, 'MEDIA_SIZE_TOO_LARGE', `expected_size_bytes exceeds the limit for media_type '${input.mediaType}'.`);
  }

  const [existing] = await sql<
    { id: string; media_asset_id: string; status: string; expires_at: Date; object_key: string; mime_type: string }[]
  >`
    SELECT us.id, us.media_asset_id, us.status, us.expires_at, ma.object_key, ma.mime_type
    FROM upload_sessions us
    JOIN media_assets ma ON ma.tenant_id = us.tenant_id AND ma.id = us.media_asset_id
    WHERE us.tenant_id = ${tenantId} AND us.idempotency_key = ${input.idempotencyKey}
  `;

  if (existing) {
    if (existing.status === 'completed') {
      throw new MediaError(409, 'UPLOAD_SESSION_ALREADY_COMPLETED', 'This upload session was already completed.');
    }
    if (existing.status === 'failed') {
      throw new MediaError(409, 'UPLOAD_SESSION_FAILED', 'This upload session already failed; retry with a new idempotency key.');
    }
    if (existing.status === 'expired' || new Date(existing.expires_at).getTime() <= Date.now()) {
      if (existing.status === 'pending') {
        await sql`
          UPDATE upload_sessions SET status = 'expired'
          WHERE tenant_id = ${tenantId} AND id = ${existing.id} AND status = 'pending'
        `;
      }
      throw new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'This upload session expired; retry with a new idempotency key.');
    }
    // Same in-flight request retried: return the same target, a fresh signed PUT URL.
    const uploadUrl = presignR2Url(r2, {
      method: 'PUT',
      objectKey: existing.object_key,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      extraSignedHeaders: { 'content-type': existing.mime_type },
    });
    return {
      uploadSessionId: existing.id,
      mediaAssetId: existing.media_asset_id,
      status: 'pending',
      uploadUrl,
      objectKey: existing.object_key,
      expiresAt: new Date(existing.expires_at).toISOString(),
    };
  }

  const mediaAssetId = randomUUID();
  const uploadSessionId = randomUUID();
  const objectKey = buildObjectKey(tenantId, mediaAssetId, input.mimeType);
  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);

  await sql`
    INSERT INTO media_assets (
      id, tenant_id, storage_provider, bucket, object_key, media_type, mime_type,
      status, retention_class, retention_policy_version, captured_at, created_by_membership_id
    ) VALUES (
      ${mediaAssetId}, ${tenantId}, 'cloudflare_r2', ${r2.bucket}, ${objectKey}, ${input.mediaType}, ${input.mimeType},
      'pending_upload', ${input.retentionClass}, ${RETENTION_POLICY_VERSION}, ${input.capturedAt ?? null}, ${membershipId}
    )
  `;
  await sql`
    INSERT INTO upload_sessions (
      id, tenant_id, media_asset_id, idempotency_key, status, expires_at, created_by_membership_id
    ) VALUES (
      ${uploadSessionId}, ${tenantId}, ${mediaAssetId}, ${input.idempotencyKey}, 'pending', ${expiresAt}, ${membershipId}
    )
  `;

  const uploadUrl = presignR2Url(r2, {
    method: 'PUT',
    objectKey,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    extraSignedHeaders: { 'content-type': input.mimeType },
  });

  return { uploadSessionId, mediaAssetId, status: 'pending', uploadUrl, objectKey, expiresAt: expiresAt.toISOString() };
}

export interface CompleteUploadResult {
  mediaAssetId: string;
  status: 'active';
  sizeBytes: number;
  checksumSha256: string | null;
}

export async function completeUploadSession(
  sql: postgres.ReservedSql,
  r2: R2Config,
  tenantId: string,
  uploadSessionId: string,
  clientChecksumSha256: string | null = null,
): Promise<CompleteUploadResult> {
  const [session] = await sql<{ id: string; media_asset_id: string; status: string; expires_at: Date }[]>`
    SELECT id, media_asset_id, status, expires_at FROM upload_sessions
    WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}
  `;
  if (!session) throw new MediaError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found.');

  if (session.status === 'completed') {
    const [asset] = await sql<{ id: string; status: string; size_bytes: string | null; checksum_sha256: string | null }[]>`
      SELECT id, status, size_bytes, checksum_sha256 FROM media_assets
      WHERE tenant_id = ${tenantId} AND id = ${session.media_asset_id}
    `;
    if (!asset || asset.status !== 'active') throw new MediaError(409, 'MEDIA_ASSET_NOT_ACTIVE', 'Media asset is not active.');
    return {
      mediaAssetId: asset.id,
      status: 'active',
      sizeBytes: Number(asset.size_bytes ?? 0),
      checksumSha256: asset.checksum_sha256,
    };
  }
  if (session.status === 'failed') {
    throw new MediaError(409, 'UPLOAD_SESSION_FAILED', 'Upload session already failed; it cannot be completed.');
  }
  if (session.status === 'expired' || new Date(session.expires_at).getTime() <= Date.now()) {
    if (session.status === 'pending') {
      await sql`
        UPDATE upload_sessions SET status = 'expired'
        WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId} AND status = 'pending'
      `;
    }
    throw new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired before it was completed.');
  }

  const [asset] = await sql<{ id: string; object_key: string; media_type: MediaType; mime_type: string }[]>`
    SELECT id, object_key, media_type, mime_type FROM media_assets
    WHERE tenant_id = ${tenantId} AND id = ${session.media_asset_id}
  `;
  if (!asset) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');

  const head = await headR2Object(r2, asset.object_key);
  if (!head.exists) {
    throw new MediaError(409, 'UPLOAD_NOT_FOUND_IN_STORAGE', 'The object was not found in storage yet; retry the upload before completing.');
  }

  const now = new Date();
  const sizeBytes = head.sizeBytes ?? 0;
  const maxBytes = MEDIA_TYPE_MAX_BYTES[asset.media_type];
  const isValid = sizeBytes > 0 && sizeBytes <= maxBytes;

  // pending_upload -> uploaded (object confirmed present) happens regardless of validity.
  await sql`
    UPDATE media_assets
    SET status = 'uploaded', size_bytes = ${sizeBytes}, checksum_sha256 = ${clientChecksumSha256},
        uploaded_at = ${now}, updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${asset.id}
  `;

  if (!isValid) {
    await sql`UPDATE media_assets SET status = 'quarantined', updated_at = ${now} WHERE tenant_id = ${tenantId} AND id = ${asset.id}`;
    await sql`UPDATE upload_sessions SET status = 'failed' WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}`;
    throw new MediaError(422, 'MEDIA_SIZE_INVALID', 'Uploaded object size is invalid for this media_type; asset was quarantined.');
  }

  await sql`UPDATE media_assets SET status = 'active', updated_at = ${now} WHERE tenant_id = ${tenantId} AND id = ${asset.id}`;
  await sql`
    UPDATE upload_sessions SET status = 'completed', completed_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}
  `;

  return { mediaAssetId: asset.id, status: 'active', sizeBytes, checksumSha256: clientChecksumSha256 };
}

export interface DownloadUrlResult {
  mediaAssetId: string;
  downloadUrl: string;
  expiresAt: string;
}

export async function getMediaDownloadUrl(
  sql: postgres.ReservedSql,
  r2: R2Config,
  tenantId: string,
  mediaAssetId: string,
): Promise<DownloadUrlResult> {
  const [asset] = await sql<{ id: string; object_key: string; status: string; deleted_at: Date | null }[]>`
    SELECT id, object_key, status, deleted_at FROM media_assets
    WHERE tenant_id = ${tenantId} AND id = ${mediaAssetId}
  `;
  if (!asset || asset.deleted_at) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');
  if (asset.status !== 'active') throw new MediaError(409, 'MEDIA_ASSET_NOT_ACTIVE', 'Media asset is not available for download.');

  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000);
  const downloadUrl = presignR2Url(r2, { method: 'GET', objectKey: asset.object_key, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
  return { mediaAssetId: asset.id, downloadUrl, expiresAt: expiresAt.toISOString() };
}
