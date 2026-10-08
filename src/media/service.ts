import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { headR2Object, presignR2Url, writeOnceUploadHeaders, type R2Config } from './r2.js';
import { inspectR2Content, MediaContentInvalid, MediaContentUnsupported } from './content.js';
import { MEDIA_TYPES } from '../db/schema.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { MediaError } from './errors.js';
import { authorizeOperationalCreate, bindingMatchesContext, insertUploadBinding, isOperationalMedia,
  readUploadBinding, revalidateUploadBinding, type OperationalContext, type UploadBinding } from './operational-binding.js';
export { MediaError } from './errors.js';

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

const RETENTION_CLASS: Record<MediaType, string> = {
  photo: 'operational', video: 'operational', video360: 'operational',
  signature: 'authorization_evidence', quote_pdf: 'document', document: 'document',
};

const RETENTION_POLICY_VERSION = 'v1';
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

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
  expectedSizeBytes: number;
  capturedAt?: string | null;
  operationalContext?: OperationalContext;
}

export interface UploadSessionResult {
  uploadSessionId: string;
  mediaAssetId: string;
  status: 'pending';
  uploadUrl: string;
  uploadMethod: 'PUT';
  uploadHeaders: Record<string, string>;
  objectKey: string;
  expiresAt: string;
}

/** UUID spellings are canonicalized exactly as PostgreSQL uuid equality.
 * Hash collisions only add serialization; RLS and tenant predicates authorize.
 */
export function uploadCreateLockKey(tenantId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`media-create:v1:${tenantId.toLowerCase()}:${idempotencyKey.toLowerCase()}`)
    .digest().readBigInt64BE(0).toString();
}

export function uploadUrlTtlSeconds(expiresAt: Date, now: Date): number {
  return Math.min(UPLOAD_URL_TTL_SECONDS, Math.floor((+expiresAt - +now) / 1000));
}

function signedUploadTarget(r2: R2Config, objectKey: string, mimeType: string, ttlSeconds: number, now: Date) {
  if (ttlSeconds < 1) throw new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired.');
  const uploadHeaders = writeOnceUploadHeaders(mimeType);
  const uploadUrl = presignR2Url(r2, {
    method: 'PUT', objectKey, expiresInSeconds: ttlSeconds, now,
    extraSignedHeaders: uploadHeaders,
  });
  return { uploadUrl, uploadMethod: 'PUT' as const, uploadHeaders };
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
  if (input.retentionClass !== RETENTION_CLASS[input.mediaType]) {
    throw new MediaError(422, 'RETENTION_CLASS_NOT_ALLOWED', 'Retention class is not allowed for this media type.');
  }
  const allowedMimes = MEDIA_TYPE_MIME_ALLOWLIST[input.mediaType];
  if (!allowedMimes.includes(input.mimeType)) {
    throw new MediaError(422, 'MIME_TYPE_NOT_ALLOWED', `mime_type '${input.mimeType}' not allowed for media_type '${input.mediaType}'.`);
  }
  const maxBytes = MEDIA_TYPE_MAX_BYTES[input.mediaType];
  if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes == null
    || input.expectedSizeBytes <= 0 || input.expectedSizeBytes > maxBytes) {
    throw new MediaError(422, 'MEDIA_SIZE_TOO_LARGE', `expected_size_bytes exceeds the limit for media_type '${input.mediaType}'.`);
  }

  const operational = isOperationalMedia(input.mediaType);
  if (operational !== (input.operationalContext !== undefined)) {
    throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'Operational context is required only for operational media.');
  }
  // Advisory key -> authoritative reception -> damage -> initial consent
  // -> session -> asset. Discovery reads never acquire media/child locks first.
  // Presigning is local crypto, with no R2 network I/O.
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(${uploadCreateLockKey(tenantId, input.idempotencyKey)}::bigint)`;
  const [discovered] = await sql<{ id: string; media_type: string; mime_type: string; retention_class: string;
    integrity_version: string; expected_size_bytes: string | null; captured_at_matches: boolean }[]>`
    SELECT us.id, us.integrity_version, us.expected_size_bytes, ma.media_type, ma.mime_type, ma.retention_class,
      ma.captured_at IS NOT DISTINCT FROM ${input.capturedAt ?? null}::text::timestamptz AS captured_at_matches
    FROM upload_sessions us JOIN media_assets ma ON ma.tenant_id=us.tenant_id AND ma.id=us.media_asset_id
    WHERE us.tenant_id=${tenantId} AND us.idempotency_key=${input.idempotencyKey}`;
  let binding: UploadBinding | undefined;
  if (discovered) {
    if (isOperationalMedia(discovered.media_type)) {
      binding = await readUploadBinding(sql, tenantId, discovered.id);
      if (!bindingMatchesContext(binding, input.operationalContext)) {
        throw new MediaError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Upload payload differs from the existing session.');
      }
    } else if (input.operationalContext) {
      throw new MediaError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Upload payload differs from the existing session.');
    }
    // Persisted identity and v1 semantics precede parent/terminal disclosure.
    // This tenant-scoped discovery takes no row locks; the advisory create
    // lock serializes the logical operation. Never resolve an incoming target.
    if (discovered.integrity_version === 'v1' && discovered.expected_size_bytes !== null
      && (Number(discovered.expected_size_bytes) !== input.expectedSizeBytes || discovered.mime_type !== input.mimeType
        || discovered.media_type !== input.mediaType || discovered.retention_class !== input.retentionClass
        || !discovered.captured_at_matches)) {
      throw new MediaError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Upload payload differs from the existing session.');
    }
    if (isOperationalMedia(discovered.media_type)) {
      await revalidateUploadBinding(sql, tenantId, discovered.id, discovered.media_type, true);
    }
  } else if (input.operationalContext) {
    binding = await authorizeOperationalCreate(sql, tenantId, input.operationalContext, input.mediaType);
  }
  const [existing] = await sql<CompletionSession[]>`
    SELECT id, media_asset_id, status, expires_at, expected_size_bytes, integrity_version
    FROM upload_sessions
    WHERE tenant_id = ${tenantId} AND idempotency_key = ${input.idempotencyKey} FOR UPDATE
  `;

  if (existing) {
    // Separate read after the session lock observes a concurrent completion's
    // committed asset; never lock the asset before the session.
    const [asset] = await sql<{ object_key: string; mime_type: string; media_type: string;
      retention_class: string; captured_at_matches: boolean }[]>`
      SELECT object_key, mime_type, media_type, retention_class,
        captured_at IS NOT DISTINCT FROM ${input.capturedAt ?? null}::text::timestamptz AS captured_at_matches
      FROM media_assets WHERE tenant_id = ${tenantId} AND id = ${existing.media_asset_id} FOR UPDATE
    `;
    if (!asset) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');
    // Compare v1 semantics BEFORE disclosing any terminal outcome. PostgreSQL
    // compares timestamp instants at persisted precision, preserving NULL.
    if (existing.integrity_version === 'v1' && existing.expected_size_bytes !== null
      && (Number(existing.expected_size_bytes) !== input.expectedSizeBytes || asset.mime_type !== input.mimeType
        || asset.media_type !== input.mediaType || asset.retention_class !== input.retentionClass
        || !asset.captured_at_matches)) {
      throw new MediaError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Upload payload differs from the existing session.');
    }
    if (existing.status === 'completed') {
      throw new MediaError(409, 'UPLOAD_SESSION_ALREADY_COMPLETED', 'This upload session was already completed.');
    }
    if (existing.status === 'failed') {
      throw new MediaError(409, 'UPLOAD_SESSION_FAILED', 'This upload session already failed; retry with a new idempotency key.');
    }
    const now = new Date();
    const expiresAt = new Date(existing.expires_at);
    const ttlSeconds = uploadUrlTtlSeconds(expiresAt, now);
    if (existing.integrity_version !== 'v1' || existing.expected_size_bytes === null
      || existing.status === 'expired' || ttlSeconds < 1) {
      if (existing.status === 'pending') {
        await sql`UPDATE upload_sessions SET status = 'expired'
          WHERE tenant_id = ${tenantId} AND id = ${existing.id} AND status = 'pending'`;
        await auditMedia(sql, tenantId, existing.media_asset_id, existing.id, 'media.upload_session_expired', 'UPLOAD_SESSION_EXPIRED');
      }
      throw new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'This upload session expired; retry with a new idempotency key.');
    }
    return {
      uploadSessionId: existing.id, mediaAssetId: existing.media_asset_id, status: 'pending',
      ...signedUploadTarget(r2, asset.object_key, asset.mime_type, ttlSeconds, now),
      objectKey: asset.object_key, expiresAt: expiresAt.toISOString(),
    };
  }

  // A fresh opaque media ID determines the object key. The database UNIQUE
  // constraint rejects collisions; conditional PUT protects the R2 object.
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
      'pending_upload', ${input.retentionClass}, ${RETENTION_POLICY_VERSION}, ${input.capturedAt ?? null}::text::timestamptz, ${membershipId}
    )
  `;
  await sql`
    INSERT INTO upload_sessions (
      id, tenant_id, media_asset_id, idempotency_key, status, expires_at, created_by_membership_id,
      expected_size_bytes, integrity_version
    ) VALUES (
      ${uploadSessionId}, ${tenantId}, ${mediaAssetId}, ${input.idempotencyKey}, 'pending', ${expiresAt}, ${membershipId},
      ${input.expectedSizeBytes}, 'v1'
    )
  `;

  if (binding) await insertUploadBinding(sql, tenantId, uploadSessionId, binding);
  await auditMedia(sql, tenantId, mediaAssetId, uploadSessionId, 'media.upload_session_created', null, binding);
  const signingNow = new Date();
  const ttlSeconds = uploadUrlTtlSeconds(expiresAt, signingNow);
  if (ttlSeconds < 1) {
    await sql`UPDATE upload_sessions SET status = 'expired' WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}`;
    await auditMedia(sql, tenantId, mediaAssetId, uploadSessionId, 'media.upload_session_expired', 'UPLOAD_SESSION_EXPIRED');
    throw new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired; create a new session with a new key.');
  }
  return { uploadSessionId, mediaAssetId, status: 'pending',
    ...signedUploadTarget(r2, objectKey, input.mimeType, ttlSeconds, signingNow),
    objectKey, expiresAt: expiresAt.toISOString() };
}

export interface CompleteUploadResult {
  mediaAssetId: string;
  status: 'active';
  sizeBytes: number;
  checksumSha256: string | null;
}

interface CompletionSession {
  id: string; media_asset_id: string; status: string; expires_at: Date;
  integrity_version: string; expected_size_bytes: string | null;
}
interface CompletionAsset {
  id: string; object_key: string; bucket: string; storage_provider: string;
  media_type: MediaType; mime_type: string; status: string;
  size_bytes: string | null; checksum_sha256: string | null;
}
export interface CompletionPlan { readonly session: CompletionSession; readonly asset?: CompletionAsset; readonly binding?: UploadBinding }
type IntegrityFailure = 'MEDIA_SIZE_INVALID' | 'MEDIA_METADATA_MISMATCH' | 'MEDIA_CONTENT_INVALID'
  | 'MEDIA_FORMAT_UNSUPPORTED' | 'MEDIA_INSPECTION_LIMIT_EXCEEDED';
export interface CompletionObservation {
  readonly plan: CompletionPlan;
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
  readonly failure: IntegrityFailure | null;
}
export type CompletionOutcome = { readonly kind: 'completed'; readonly result: CompleteUploadResult }
  | { readonly kind: 'durable-error'; readonly error: MediaError };

async function readCompletionPlan(sql: postgres.ReservedSql, tenantId: string,
  sessionId: string, lock: boolean): Promise<CompletionPlan> {
  // Phase A discovery takes no locks. Phase C revalidates/locks the parent
  // before locking session/asset, matching close and operational create.
  const [discovered] = await sql<{ media_type: string; retention_class: string }[]>`SELECT ma.media_type, ma.retention_class
    FROM upload_sessions us JOIN media_assets ma ON ma.tenant_id=us.tenant_id AND ma.id=us.media_asset_id
    WHERE us.tenant_id=${tenantId} AND us.id=${sessionId}`;
  let binding: UploadBinding | undefined;
  if (discovered && isOperationalMedia(discovered.media_type)) {
    if (discovered.retention_class !== 'operational') {
      throw new MediaError(409, 'MEDIA_ASSOCIATION_CONFLICT', 'Operational upload binding is not eligible.');
    }
    binding = await revalidateUploadBinding(sql, tenantId, sessionId, discovered.media_type, lock);
  }
  const [session] = await sql.unsafe<CompletionSession[]>(
    'SELECT id, media_asset_id, status, expires_at, integrity_version, expected_size_bytes FROM upload_sessions '
      + 'WHERE tenant_id = $1 AND id = $2' + (lock ? ' FOR UPDATE' : ''), [tenantId, sessionId]);
  if (!session) throw new MediaError(404, 'UPLOAD_SESSION_NOT_FOUND', 'Upload session not found.');
  if (session.status === 'failed') throw new MediaError(409, 'UPLOAD_SESSION_FAILED', 'Upload session already failed; it cannot be completed.');
  if (session.status !== 'completed' && (session.status === 'expired' || session.integrity_version !== 'v1'
    || session.expected_size_bytes === null || new Date(session.expires_at).getTime() <= Date.now())) return { session, binding };
  const [asset] = await sql.unsafe<CompletionAsset[]>(
    'SELECT id, object_key, bucket, storage_provider, media_type, mime_type, status, size_bytes, checksum_sha256 '
      + 'FROM media_assets WHERE tenant_id = $1 AND id = $2 '
      + 'AND deletion_requested_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL'
      + (lock ? ' FOR UPDATE' : ''), [tenantId, session.media_asset_id]);
  if (!asset) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');
  if (session.status === 'completed' ? asset.status !== 'active' : !['pending_upload', 'uploaded'].includes(asset.status)) {
    throw new MediaError(409, 'MEDIA_ASSET_NOT_ACTIVE', 'Media asset is not eligible for completion.');
  }
  return { session, asset, binding };
}

/** Phase A: tenant-scoped read only. Its transaction is closed before inspecting R2. */
export async function prepareUploadCompletion(sql: postgres.ReservedSql, tenantId: string,
  sessionId: string): Promise<CompletionPlan> {
  return readCompletionPlan(sql, tenantId, sessionId, false);
}

/** Phase B: no SQL client or database transaction is available to this function. */
export async function inspectUploadCompletion(r2: R2Config, plan: CompletionPlan): Promise<CompletionObservation | null> {
  if (!plan.asset || plan.session.status === 'completed') return null;
  const { asset, session } = plan;
  if (asset.bucket !== r2.bucket || asset.storage_provider !== 'cloudflare_r2') {
    throw new MediaError(503, 'MEDIA_STORAGE_UNAVAILABLE', 'Storage integrity validation is temporarily unavailable; retry later.');
  }
  const integrityDeadline = Date.now() + 10000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let failure: IntegrityFailure | null = null;
  try {
    const head = await headR2Object(r2, asset.object_key, controller.signal);
    if (!head.exists) throw new MediaError(409, 'UPLOAD_NOT_FOUND_IN_STORAGE', 'The object was not found in storage yet; retry the upload before completing.');
    const sizeBytes = head.sizeBytes as number;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MEDIA_TYPE_MAX_BYTES[asset.media_type]) {
      failure = 'MEDIA_SIZE_INVALID';
    } else if (sizeBytes !== Number(session.expected_size_bytes) || head.contentType !== asset.mime_type
      || !MEDIA_TYPE_MIME_ALLOWLIST[asset.media_type].includes(asset.mime_type)) {
      failure = 'MEDIA_METADATA_MISMATCH';
    } else {
      try { await inspectR2Content(r2, asset.object_key, asset.mime_type, sizeBytes, head.etag, controller.signal); }
      catch (error) {
        if (error instanceof MediaContentInvalid) failure = 'MEDIA_CONTENT_INVALID';
        else if (error instanceof MediaContentUnsupported) failure = error.integrityFailureCode;
        else throw error;
      }
    }
    if (Date.now() >= integrityDeadline || controller.signal.aborted) {
      controller.abort();
      throw new Error('INTEGRITY_DEADLINE');
    }
    return Object.freeze({ plan, sizeBytes, contentType: head.contentType, etag: head.etag, failure });
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(503, 'MEDIA_STORAGE_UNAVAILABLE', 'Storage integrity validation is temporarily unavailable; retry later.');
  } finally { clearTimeout(timeout); }
}

/** Phase C: revalidated tenant transaction; no external I/O. Durable mutations
 * return a domain outcome. Only the route explicitly opts that outcome into commit.
 */
export async function completeUploadSession(sql: postgres.ReservedSql, tenantId: string,
  uploadSessionId: string, plan: CompletionPlan, observation: CompletionObservation | null,
  clientChecksumSha256: string | null = null): Promise<CompletionOutcome> {
  if (clientChecksumSha256 !== null && !/^[a-fA-F0-9]{64}$/.test(clientChecksumSha256)) {
    throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'Checksum must be 64 hexadecimal characters.');
  }
  const checksum = clientChecksumSha256?.toLowerCase() ?? null;
  const current = await readCompletionPlan(sql, tenantId, uploadSessionId, true);
  const { session, asset } = current;
  if (current.binding?.reception_id !== plan.binding?.reception_id
    || current.binding?.damage_id !== plan.binding?.damage_id
    || current.binding?.privacy_consent_id !== plan.binding?.privacy_consent_id) {
    throw new MediaError(409, 'MEDIA_ASSOCIATION_CONFLICT', 'Operational upload binding changed during inspection.');
  }
  if (session.status === 'completed' && asset) {
    if ((asset.checksum_sha256?.toLowerCase() ?? null) !== checksum) {
      throw new MediaError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Completion payload differs from the completed session.');
    }
    return { kind: 'completed', result: {
      mediaAssetId: asset.id, status: 'active', sizeBytes: Number(asset.size_bytes), checksumSha256: asset.checksum_sha256,
    } };
  }
  if (!asset) {
    if (session.status === 'pending') {
      await sql`UPDATE upload_sessions SET status = 'expired' WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}`;
      await auditMedia(sql, tenantId, session.media_asset_id, uploadSessionId, 'media.upload_session_expired', 'UPLOAD_SESSION_EXPIRED');
    }
    return { kind: 'durable-error', error: new MediaError(409, 'UPLOAD_SESSION_EXPIRED', 'Upload session expired; create a new session with a new key.') };
  }
  const original = plan.asset;
  // The DB expectation trigger freezes tenant/asset/version/size. Compare every
  // other observation input too, including expiry, MIME, key, bucket and status.
  if (!original || !observation || observation.plan !== plan
    || session.id !== plan.session.id || session.media_asset_id !== plan.session.media_asset_id
    || session.integrity_version !== plan.session.integrity_version
    || String(session.expected_size_bytes) !== String(plan.session.expected_size_bytes)
    || +new Date(session.expires_at) !== +new Date(plan.session.expires_at)
    || (['id', 'object_key', 'bucket', 'storage_provider', 'media_type', 'mime_type', 'status'] as const)
      .some((key) => asset[key] !== original[key])) {
    throw new MediaError(409, 'MEDIA_ASSET_NOT_ACTIVE', 'Upload metadata changed during inspection; retry completion.');
  }
  const { sizeBytes, failure } = observation;
  const now = new Date();
  await sql`UPDATE media_assets SET status = 'uploaded', size_bytes = ${sizeBytes}, checksum_sha256 = ${checksum},
    uploaded_at = COALESCE(uploaded_at, ${now}), updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${asset.id}`;
  if (failure) {
    await sql`UPDATE media_assets SET status = 'quarantined', quarantined_at = COALESCE(quarantined_at, ${now}),
      integrity_failure_code = ${failure}, updated_at = ${now} WHERE tenant_id = ${tenantId} AND id = ${asset.id}`;
    await sql`UPDATE upload_sessions SET status = 'failed', completed_at = NULL
      WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}`;
    await auditMedia(sql, tenantId, asset.id, uploadSessionId, 'media.quarantined', failure);
    const code = failure === 'MEDIA_FORMAT_UNSUPPORTED' || failure === 'MEDIA_INSPECTION_LIMIT_EXCEEDED'
      ? 'MEDIA_CONTENT_INVALID' : failure;
    return { kind: 'durable-error', error: new MediaError(422, code, 'Uploaded object failed integrity validation and was quarantined.') };
  }
  await sql`UPDATE media_assets SET status = 'active', updated_at = ${now} WHERE tenant_id = ${tenantId} AND id = ${asset.id}`;
  await sql`UPDATE upload_sessions SET status = 'completed', completed_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${uploadSessionId}`;
  await auditMedia(sql, tenantId, asset.id, uploadSessionId, 'media.upload_completed');
  return { kind: 'completed', result: { mediaAssetId: asset.id, status: 'active', sizeBytes, checksumSha256: checksum } };
}

async function auditMedia(sql: postgres.ReservedSql, tenantId: string, mediaId: string,
  sessionId: string, action: string, reason: string | null = null, binding?: UploadBinding): Promise<void> {
  // Actor and correlation originate exclusively in the verified, transaction-local context.
  await sql`INSERT INTO public.audit_logs
    (id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
      entity_type, entity_id, reason_code, metadata_json, request_id)
    VALUES (${uuidV7()}, ${tenantId}, 'user',
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      NULLIF(current_setting('app.membership_id', true), '')::uuid,
      ${action}, 'success', 'media_asset', ${mediaId}, ${reason},
      ${sql.json({ upload_session_id: sessionId, ...(binding ? {
        context_type: binding.damage_id ? 'damage' : 'reception', reception_id: binding.reception_id,
        ...(binding.damage_id ? { damage_id: binding.damage_id } : {}), privacy_consent_id: binding.privacy_consent_id,
      } : {}) })}, current_setting('app.request_id', true))`;
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
