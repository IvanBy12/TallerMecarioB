import { lockMediaRetention, recalculateLockedMediaRetention, type MediaRetentionLock } from '../media/retention.js';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { BIDI_CONTROL_CHARACTERS, codePointLength, hasValidUnicode,
  PROHIBITED_CONTROL_CHARACTERS } from '../platform/unicode-text.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { receptionAcceptanceDocument } from './acceptance-document.js';
import type { RequestMeta } from './service.js';

export const SIGNATURE_BODY_LIMIT = 2048;
export const signatureBodySchema = { type: 'object', additionalProperties: false,
  required: ['signatureMediaId', 'signedByName', 'documentVersion'], properties: {
    signatureMediaId: { type: 'string' }, signedByName: { type: 'string' },
    signedByDocument: { type: ['string', 'null'] }, documentVersion: { type: 'string' },
  } } as const;

export interface SignatureInput {
  signatureMediaId: string; signedByName: string;
  signedByDocument: string | null; documentVersion: string;
}

const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
function normalized(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !hasValidUnicode(value)
    || BIDI_CONTROL_CHARACTERS.test(value)
    || PROHIBITED_CONTROL_CHARACTERS.test(value)) throw invalid();
  const result = value.normalize('NFC').trim();
  if (codePointLength(result) > max) throw invalid();
  return result || null;
}
export function parseSignatureInput(body: unknown): SignatureInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['signatureMediaId', 'signedByName',
    'signedByDocument', 'documentVersion'].includes(key))) throw invalid();
  const signatureMediaId = parseCanonicalUuid(raw.signatureMediaId);
  const signedByName = normalized(raw.signedByName, 200);
  const signedByDocument = raw.signedByDocument == null ? null : normalized(raw.signedByDocument, 60);
  if (!signatureMediaId || !signedByName || typeof raw.documentVersion !== 'string'
    || raw.documentVersion.length === 0 || raw.documentVersion.length > 40) throw invalid();
  return { signatureMediaId, signedByName, signedByDocument,
    documentVersion: raw.documentVersion };
}

const mediaNotFound = () => new ApiError(404, 'SIGNATURE_MEDIA_NOT_FOUND', 'The signature media was not found.');
const mediaNotEligible = () => new ApiError(409, 'SIGNATURE_MEDIA_NOT_ELIGIBLE',
  'The signature media is not eligible.');
const alreadySigned = () => new ApiError(409, 'RECEPTION_ALREADY_SIGNED',
  'The reception already has a signature.');
const mediaUsed = () => new ApiError(409, 'SIGNATURE_MEDIA_ALREADY_USED',
  'The signature media is already used.');

export function mapSignatureDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23505' && name === 'signatures_one_reception_uq') return alreadySigned();
  if (db.code === '23505' && name === 'signatures_one_media_uq') return mediaUsed();
  if (db.code === '23514' && name === 'signatures_media_guard') return mediaNotEligible();
  if (db.code === '23503' && name === 'signatures_media_fk') return mediaNotFound();
  if (db.code === '23514' && name === 'reception_signature_parent_guard')
    return new ApiError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  return null;
}

export async function captureReceptionSignature(context: TenantRequestContext, receptionId: string,
  input: SignatureInput, meta: RequestMeta) {
  const { sql, tenant } = context;
  const [reception] = await sql<{ status: string }[]>`SELECT status FROM public.receptions
    WHERE tenant_id=${tenant.tenantId} AND id=${receptionId}`;
  if (!reception) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
  if (reception.status !== 'open')
    throw new ApiError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  const document = receptionAcceptanceDocument(input.documentVersion);
  if (!document) throw new ApiError(409, 'ACCEPTANCE_DOCUMENT_VERSION_MISMATCH',
    'The acceptance document version does not match.');
  let retentionLock: MediaRetentionLock;
  try {
    retentionLock = await lockMediaRetention(sql, tenant.tenantId, [input.signatureMediaId],
      { receptionIds: [receptionId] });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'MEDIA_ASSET_NOT_FOUND') throw mediaNotFound();
    if (code === 'MEDIA_ASSOCIATION_CONFLICT') {
      const [used] = await sql`SELECT id FROM public.signatures
        WHERE tenant_id=${tenant.tenantId} AND signature_media_id=${input.signatureMediaId}`;
      if (used) throw mediaUsed();
    }
    throw error;
  }
  const [lockedReception] = await sql<{ status: string }[]>`SELECT status FROM public.receptions
    WHERE tenant_id=${tenant.tenantId} AND id=${receptionId} FOR NO KEY UPDATE`;
  if (lockedReception.status !== 'open')
    throw new ApiError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  // Reception precedes media in both application and 0019 trigger lock graphs.
  const [media] = await sql<{ media_type: string; status: string; retention_class: string;
    deleted_at: Date | null; purged_at: Date | null }[]>`SELECT media_type, status, retention_class, deleted_at, purged_at
    FROM public.media_assets WHERE tenant_id=${tenant.tenantId} AND id=${input.signatureMediaId}
    FOR SHARE`;
  if (!media) throw mediaNotFound();
  if (media.media_type !== 'signature' || media.status !== 'active'
    || media.retention_class !== 'authorization_evidence'
    || media.deleted_at || media.purged_at) throw mediaNotEligible();
  const [row] = await sql<{ id: string; signed_at: string }[]>`INSERT INTO public.signatures
    (id, tenant_id, reception_id, signature_media_id, signed_by_name,
      signed_by_document, document_version, document_hash, signed_at, ip_address)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${receptionId}, ${input.signatureMediaId},
      ${input.signedByName}, ${input.signedByDocument}, ${document.version}, ${document.hash},
      pg_catalog.now(), ${meta.ipAddress}::inet)
    RETURNING id, signed_at`;
  if (!row) throw new Error('SIGNATURE_INSERT_FAILED');
  await recalculateLockedMediaRetention(retentionLock, input.signatureMediaId);
  await sql`INSERT INTO public.audit_logs
    (id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
      entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
      request_id, ip_address)
    VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId},
      ${tenant.membershipId}, 'reception.signed', 'success', 'reception', ${receptionId},
      NULL, NULL, NULL, ${sql.json({ signature_id: row.id,
        media_id: input.signatureMediaId, document_version: document.version })},
      ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return { signatureId: row.id, receptionId, signatureMediaId: input.signatureMediaId,
    documentVersion: document.version, signedAt: row.signed_at };
}
