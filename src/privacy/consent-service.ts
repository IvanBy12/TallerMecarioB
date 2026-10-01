/**
 * S3-04.5 privacy consent capture (D-PRIV-02/04/05). One command, two evidence
 * sources with the same persistence: online (catalog + current workshop at
 * capture time) and offline (authenticated privacy_notice_bundle, ADR-005).
 * All SQL runs in the request's TenantContext transaction under RLS.
 */
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { computeAuthorizationTextHash } from './canonical-text.js';
import { PRODUCTION_PRIVACY_DOCUMENT_CATALOG, type PrivacyDocumentCatalog } from './catalog.js';
import { buildControllerNoticeSnapshot, type ControllerNoticeConfiguration, type ControllerNoticeSnapshot,
  PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION } from './controller-notice.js';
import { bundleConsentEvidence, type PrivacyNoticeBundleKeyRing, type PrivacyNoticeBundleValidityPolicy,
  PrivacyNoticeBundleError, verifyPrivacyNoticeBundle } from './notice-bundle.js';
import type { CapturePrivacyConsentInput } from './validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
export interface RequestMeta { requestId: string; ipAddress: string; }
export interface PrivacyConsentDependencies {
  catalog: PrivacyDocumentCatalog;
  controllerNotice: ControllerNoticeConfiguration;
}
export const PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES: PrivacyConsentDependencies = Object.freeze({
  catalog: PRODUCTION_PRIVACY_DOCUMENT_CATALOG,
  controllerNotice: PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION,
});
/** Offline evidence needs an explicit key ring and ADR-005 validity policy: no defaults. */
export interface OfflineBundleDependencies {
  catalog: PrivacyDocumentCatalog;
  keyRing: PrivacyNoticeBundleKeyRing;
  validity: PrivacyNoticeBundleValidityPolicy;
  now: () => Date;
}

/** Hash and snapshot are evidence, not API surface: the DTO omits both. */
export interface PrivacyConsentDto {
  privacyConsentId: string; customerId: string; purposeCode: string;
  privacyNoticeVersion: string; authorizationTextVersion: string; channel: string;
  status: 'granted'; capturedAt: string; createdAt: string;
}
interface ConsentRow {
  id: string; customer_id: string; purpose_code: string; privacy_notice_version: string;
  authorization_text_version: string; channel: string; captured_at: string; created_at: string;
}
interface ConsentEvidence { snapshot: ControllerNoticeSnapshot; authorizationTextHash: string; }

const versionUnavailable = () => new ApiError(409, 'PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE',
  'The requested privacy document version is not available.');
const noticeNotConfigured = () => new ApiError(409, 'PRIVACY_NOTICE_NOT_CONFIGURED',
  'The workshop privacy notice is not configured.');
const customerNotFound = () => new ApiError(404, 'CUSTOMER_NOT_FOUND', 'The customer was not found.');
const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');

export function mapPrivacyConsentDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23505' && name === 'privacy_consents_one_granted_uq')
    return new ApiError(409, 'PRIVACY_CONSENT_ALREADY_GRANTED',
      'A granted consent already exists for this purpose.');
  if (db.code === '23503' && name === 'privacy_consents_customer_fk') return customerNotFound();
  return null;
}

/** Online capture: texts from the server catalog, snapshot from the workshop now. */
export async function capturePrivacyConsent(context: TenantRequestContext, input: CapturePrivacyConsentInput,
  dependencies: PrivacyConsentDependencies, meta: RequestMeta): Promise<PrivacyConsentDto> {
  // D-PRIV-04 is enforced here too, not only by the HTTP schema.
  if (input.adultAttestationConfirmed !== true) throw invalid();
  // Exact published versions only: never a fallback to a "current" text.
  const documents = dependencies.catalog.resolve(input.purposeCode, input.privacyNoticeVersion,
    input.authorizationTextVersion);
  if (!documents) throw versionUnavailable();
  const snapshot = await currentControllerNotice(context, dependencies.controllerNotice);
  if (!snapshot) throw noticeNotConfigured();
  const authorizationTextHash = computeAuthorizationTextHash({
    purposeCode: input.purposeCode, privacyNoticeVersion: input.privacyNoticeVersion,
    authorizationTextVersion: input.authorizationTextVersion, ...documents, snapshot,
  });
  return persistPrivacyConsent(context, input, { snapshot, authorizationTextHash }, meta);
}

/**
 * Offline sync primitive (not HTTP-exposed until ADR-005 defines the sync
 * contract and bundle validity). Uses the snapshot of the authenticated
 * bundle, never the current workshop, and recomputes the hash server-side.
 */
export async function capturePrivacyConsentFromBundle(context: TenantRequestContext, bundle: unknown,
  input: CapturePrivacyConsentInput, dependencies: OfflineBundleDependencies,
  meta: RequestMeta): Promise<PrivacyConsentDto> {
  if (input.adultAttestationConfirmed !== true || input.capturedAt === null) throw invalid();
  let evidence: ConsentEvidence | null;
  try {
    const payload = verifyPrivacyNoticeBundle(bundle, { keyRing: dependencies.keyRing,
      catalog: dependencies.catalog, expectedTenantId: context.tenant.tenantId,
      validity: dependencies.validity, now: dependencies.now() });
    evidence = bundleConsentEvidence(payload, input.purposeCode, input.privacyNoticeVersion,
      input.authorizationTextVersion);
  } catch (error) {
    if (error instanceof PrivacyNoticeBundleError)
      throw new ApiError(400, 'PRIVACY_NOTICE_BUNDLE_INVALID', 'The privacy notice bundle is invalid.');
    throw error;
  }
  if (!evidence) throw versionUnavailable();
  return persistPrivacyConsent(context, input, evidence, meta);
}

async function currentControllerNotice(context: TenantRequestContext,
  configuration: ControllerNoticeConfiguration): Promise<ControllerNoticeSnapshot | null> {
  const { sql, tenant } = context;
  const [row] = await sql<{
    legal_name: string; phone: string | null; email: string | null; address_line: string | null;
    city: string | null; department: string | null; country_code: string | null; location_phone: string | null;
  }[]>`SELECT w.legal_name, w.phone, w.email, l.address_line, l.city, l.department,
      l.country_code, l.phone AS location_phone
    FROM public.workshops AS w
    LEFT JOIN public.workshop_locations AS l
      ON l.tenant_id = w.id AND l.is_primary = true
    WHERE w.id = ${tenant.tenantId}`;
  if (!row) return null;
  const workshop = { tenantId: tenant.tenantId, legalName: row.legal_name, phone: row.phone, email: row.email };
  const location = row.address_line === null ? null : {
    addressLine: row.address_line, city: row.city ?? '', department: row.department ?? '',
    countryCode: row.country_code ?? '', phone: row.location_phone,
  };
  return buildControllerNoticeSnapshot(workshop, location, configuration.rightsChannel(workshop),
    configuration.requirePhoneAndEmail);
}

async function persistPrivacyConsent(context: TenantRequestContext, input: CapturePrivacyConsentInput,
  evidence: ConsentEvidence, meta: RequestMeta): Promise<PrivacyConsentDto> {
  const { sql, tenant } = context;
  const [customer] = await sql`SELECT id FROM public.customers
    WHERE tenant_id = ${tenant.tenantId} AND id = ${input.customerId}`;
  if (!customer) throw customerNotFound();
  // status, revoked_at, created_at and updated_at stay server/DB-owned.
  const [row] = await sql<ConsentRow[]>`INSERT INTO public.privacy_consents AS c
    (id, tenant_id, customer_id, purpose_code, privacy_notice_version, authorization_text_version,
      authorization_text_hash, controller_notice_snapshot, channel, captured_at, ip_address,
      created_by_membership_id)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${input.customerId}, ${input.purposeCode},
      ${input.privacyNoticeVersion}, ${input.authorizationTextVersion}, ${evidence.authorizationTextHash},
      ${sql.json({ ...evidence.snapshot })},
      ${input.channel},
      -- ::text first: never round-trip the declared instant through a JS Date (ms truncation).
      COALESCE(${input.capturedAt}::text::timestamptz, pg_catalog.now()), ${meta.ipAddress}::inet,
      ${tenant.membershipId})
    RETURNING c.id, c.customer_id, c.purpose_code, c.privacy_notice_version, c.authorization_text_version,
      c.channel,
      pg_catalog.to_char(c.captured_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS captured_at,
      pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at`;
  if (!row) throw new Error('PRIVACY_CONSENT_INSERT_FAILED');
  // Minimal metadata: no notice/authorization text, snapshot, hash or bundle.
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    'privacy_consent.captured', 'success', 'privacy_consent', ${row.id}, NULL, NULL, NULL,
    ${sql.json({ customer_id: row.customer_id, purpose_code: row.purpose_code,
      privacy_notice_version: row.privacy_notice_version,
      authorization_text_version: row.authorization_text_version, channel: row.channel })},
    ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return { privacyConsentId: row.id, customerId: row.customer_id, purposeCode: row.purpose_code,
    privacyNoticeVersion: row.privacy_notice_version, authorizationTextVersion: row.authorization_text_version,
    channel: row.channel, status: 'granted', capturedAt: row.captured_at, createdAt: row.created_at };
}
