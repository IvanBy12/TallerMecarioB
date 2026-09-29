/**
 * D-PRIV-05 privacy_notice_bundle primitives (offline evidence, ADR-005).
 *
 *   payload_bytes = exact UTF-8 bytes produced by the backend
 *   bundle        = base64url(payload_bytes) || "." || base64url(HMAC-SHA256(key[key_version], payload_bytes))
 *
 * Verification authenticates the exact received bytes in constant time BEFORE
 * any JSON parsing (never parse -> re-serialize -> verify), then checks tenant,
 * format and key version, delegates validity to an explicit caller policy and
 * finally compares every text against the server-owned catalog. The expiry /
 * grace policy belongs to ADR-005 (Sprint 13): no default policy exists here.
 * Errors carry only a reason code; bundle, payload, MAC and keys never leak.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { computeAuthorizationTextHash } from './canonical-text.js';
import { isPrivacyPurposeCode, PRIVACY_DOCUMENT_VERSION_PATTERN, type PrivacyDocumentCatalog,
  type PrivacyPurposeCode } from './catalog.js';
import { type ControllerNoticeSnapshot, parseControllerNoticeSnapshot } from './controller-notice.js';

export const PRIVACY_NOTICE_BUNDLE_FORMAT = 'tallermecario.privacy_notice_bundle.v1';
const MAX_BUNDLE_LENGTH = 256 * 1024;
const MAC_BYTES = 32;
const MIN_KEY_BYTES = 32;
const KEY_VERSION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PAYLOAD_KEYS = ['authorizations', 'controllerNoticeSnapshot', 'expiresAt', 'format', 'issuedAt',
  'keyVersion', 'noticeText', 'privacyNoticeVersion', 'tenantId'];

export type PrivacyNoticeBundleRejection =
  | 'MALFORMED' | 'MAC_MISMATCH' | 'PAYLOAD_INVALID' | 'KEY_VERSION_MISMATCH'
  | 'TENANT_MISMATCH' | 'NOT_VALID_NOW' | 'CATALOG_MISMATCH';

export class PrivacyNoticeBundleError extends Error {
  readonly reason: PrivacyNoticeBundleRejection;
  constructor(reason: PrivacyNoticeBundleRejection) {
    super('PRIVACY_NOTICE_BUNDLE_REJECTED');
    this.name = 'PrivacyNoticeBundleError';
    this.reason = reason;
  }
}

export interface BundleAuthorization {
  readonly purposeCode: PrivacyPurposeCode;
  readonly authorizationTextVersion: string;
  readonly text: string;
}
export interface PrivacyNoticeBundlePayload {
  readonly format: typeof PRIVACY_NOTICE_BUNDLE_FORMAT;
  readonly keyVersion: string;
  readonly tenantId: string;
  readonly privacyNoticeVersion: string;
  readonly noticeText: string;
  readonly authorizations: readonly BundleAuthorization[];
  readonly controllerNoticeSnapshot: ControllerNoticeSnapshot;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Versioned HMAC keys, dedicated to bundles (never reuse Wompi/Clerk/invitation secrets). */
export class PrivacyNoticeBundleKeyRing {
  readonly #keys: ReadonlyMap<string, Buffer>;
  constructor(entries: readonly { version: string; key: Uint8Array }[]) {
    const keys = new Map<string, Buffer>();
    for (const { version, key } of entries) {
      if (!KEY_VERSION_PATTERN.test(version) || keys.has(version)) throw new Error('PRIVACY_BUNDLE_KEY_RING_INVALID');
      if (!(key instanceof Uint8Array) || key.byteLength < MIN_KEY_BYTES) throw new Error('PRIVACY_BUNDLE_KEY_RING_INVALID');
      keys.set(version, Buffer.from(key));
    }
    if (keys.size === 0) throw new Error('PRIVACY_BUNDLE_KEY_RING_INVALID');
    this.#keys = keys;
    Object.freeze(this);
  }
  versions(): string[] { return [...this.#keys.keys()]; }
  mac(version: string, payload: Buffer): Buffer {
    const key = this.#keys.get(version);
    if (!key) throw new Error('PRIVACY_BUNDLE_KEY_VERSION_UNKNOWN');
    return createHmac('sha256', key).update(payload).digest();
  }
  toJSON(): { versions: string[] } { return { versions: this.versions() }; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'PrivacyNoticeBundleKeyRing [redacted]'; }
}

/**
 * Validity is an explicit input: ADR-005 (Sprint 13) owns the expiration and
 * grace policy. Callers must pass one; there is deliberately no default.
 */
export type PrivacyNoticeBundleValidityPolicy =
  (window: { issuedAt: Date; expiresAt: Date; now: Date }) => boolean;

export interface VerifyPrivacyNoticeBundleOptions {
  keyRing: PrivacyNoticeBundleKeyRing;
  catalog: PrivacyDocumentCatalog;
  expectedTenantId: string;
  validity: PrivacyNoticeBundleValidityPolicy;
  now: Date;
}

/** Strict, canonical base64url (no padding, re-encodes to the same string). */
export function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

/** Constant-time for equal-length inputs; length is public (always 32 for SHA-256). */
export function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encodePrivacyNoticeBundle(payload: PrivacyNoticeBundlePayload,
  keyRing: PrivacyNoticeBundleKeyRing): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${bytes.toString('base64url')}.${keyRing.mac(payload.keyVersion, bytes).toString('base64url')}`;
}

/** Issues a bundle whose texts are resolved from the server catalog, never from the caller. */
export function issuePrivacyNoticeBundle(options: {
  keyRing: PrivacyNoticeBundleKeyRing; keyVersion: string; catalog: PrivacyDocumentCatalog;
  tenantId: string; privacyNoticeVersion: string;
  authorizations: readonly { purposeCode: PrivacyPurposeCode; authorizationTextVersion: string }[];
  controllerNoticeSnapshot: ControllerNoticeSnapshot; issuedAt: Date; expiresAt: Date;
}): string {
  const noticeText = options.catalog.noticeText(options.privacyNoticeVersion);
  if (noticeText === null) throw new Error('PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
  const authorizations = options.authorizations.map(({ purposeCode, authorizationTextVersion }) => {
    const text = options.catalog.authorizationText(purposeCode, authorizationTextVersion);
    if (text === null) throw new Error('PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE');
    return { purposeCode, authorizationTextVersion, text };
  });
  if (!parseControllerNoticeSnapshot(options.controllerNoticeSnapshot)) throw new Error('PRIVACY_NOTICE_NOT_CONFIGURED');
  return encodePrivacyNoticeBundle({
    format: PRIVACY_NOTICE_BUNDLE_FORMAT, keyVersion: options.keyVersion, tenantId: options.tenantId,
    privacyNoticeVersion: options.privacyNoticeVersion, noticeText, authorizations,
    controllerNoticeSnapshot: options.controllerNoticeSnapshot,
    issuedAt: options.issuedAt.toISOString(), expiresAt: options.expiresAt.toISOString(),
  }, options.keyRing);
}

export function verifyPrivacyNoticeBundle(bundle: unknown,
  options: VerifyPrivacyNoticeBundleOptions): PrivacyNoticeBundlePayload {
  // 1. Envelope: payload "." mac, both strict base64url.
  if (typeof bundle !== 'string' || bundle.length === 0 || bundle.length > MAX_BUNDLE_LENGTH)
    throw new PrivacyNoticeBundleError('MALFORMED');
  const parts = bundle.split('.');
  if (parts.length !== 2) throw new PrivacyNoticeBundleError('MALFORMED');
  const payloadBytes = decodeBase64Url(parts[0] as string);
  const mac = decodeBase64Url(parts[1] as string);
  if (!payloadBytes || payloadBytes.length === 0 || !mac || mac.length !== MAC_BYTES)
    throw new PrivacyNoticeBundleError('MALFORMED');

  // 2. MAC over the exact received bytes, against every allowed key version
  //    (no early exit), before interpreting anything inside the payload.
  let matchedVersion: string | null = null;
  for (const version of options.keyRing.versions()) {
    if (constantTimeEqual(options.keyRing.mac(version, payloadBytes), mac) && matchedVersion === null)
      matchedVersion = version;
  }
  if (matchedVersion === null) throw new PrivacyNoticeBundleError('MAC_MISMATCH');

  // 3. Only now decode and parse the authenticated bytes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payloadBytes));
  } catch {
    throw new PrivacyNoticeBundleError('PAYLOAD_INVALID');
  }
  const payload = parsePayload(parsed);
  if (!payload) throw new PrivacyNoticeBundleError('PAYLOAD_INVALID');
  if (payload.keyVersion !== matchedVersion) throw new PrivacyNoticeBundleError('KEY_VERSION_MISMATCH');
  if (payload.tenantId !== options.expectedTenantId) throw new PrivacyNoticeBundleError('TENANT_MISMATCH');
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  if (!(issuedAt < expiresAt) || options.validity({ issuedAt, expiresAt, now: options.now }) !== true)
    throw new PrivacyNoticeBundleError('NOT_VALID_NOW');

  // 4. Semantic check: a valid MAC is not enough. Every text must equal the
  //    published catalog text for its version (guards internal emission bugs).
  if (options.catalog.noticeText(payload.privacyNoticeVersion) !== payload.noticeText)
    throw new PrivacyNoticeBundleError('CATALOG_MISMATCH');
  for (const item of payload.authorizations) {
    if (options.catalog.authorizationText(item.purposeCode, item.authorizationTextVersion) !== item.text)
      throw new PrivacyNoticeBundleError('CATALOG_MISMATCH');
  }
  return payload;
}

/**
 * Consent evidence for one purpose from a verified bundle. The snapshot is the
 * authenticated one shown offline, never the workshop's current state.
 */
export function bundleConsentEvidence(payload: PrivacyNoticeBundlePayload, purposeCode: PrivacyPurposeCode,
  privacyNoticeVersion: string, authorizationTextVersion: string): {
    snapshot: ControllerNoticeSnapshot; authorizationTextHash: string;
  } | null {
  if (payload.privacyNoticeVersion !== privacyNoticeVersion) return null;
  const item = payload.authorizations.find((entry) => entry.purposeCode === purposeCode
    && entry.authorizationTextVersion === authorizationTextVersion);
  if (!item) return null;
  const snapshot = payload.controllerNoticeSnapshot;
  return {
    snapshot,
    authorizationTextHash: computeAuthorizationTextHash({
      purposeCode, privacyNoticeVersion, authorizationTextVersion,
      noticeText: payload.noticeText, authorizationText: item.text, snapshot,
    }),
  };
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function isVersion(value: unknown): value is string {
  return typeof value === 'string' && PRIVACY_DOCUMENT_VERSION_PATTERN.test(value);
}

function parsePayload(value: unknown): PrivacyNoticeBundlePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== PAYLOAD_KEYS.join(',')) return null;
  if (record.format !== PRIVACY_NOTICE_BUNDLE_FORMAT || typeof record.keyVersion !== 'string'
    || typeof record.tenantId !== 'string' || !UUID.test(record.tenantId)
    || !isVersion(record.privacyNoticeVersion) || typeof record.noticeText !== 'string'
    || !isInstant(record.issuedAt) || !isInstant(record.expiresAt)
    || !Array.isArray(record.authorizations) || record.authorizations.length === 0) return null;
  const snapshot = parseControllerNoticeSnapshot(record.controllerNoticeSnapshot);
  if (!snapshot) return null;
  const purposes = new Set<string>();
  const authorizations: BundleAuthorization[] = [];
  for (const item of record.authorizations as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'authorizationTextVersion,purposeCode,text'
      || !isPrivacyPurposeCode(entry.purposeCode) || purposes.has(entry.purposeCode)
      || !isVersion(entry.authorizationTextVersion) || typeof entry.text !== 'string') return null;
    purposes.add(entry.purposeCode);
    authorizations.push(Object.freeze({ purposeCode: entry.purposeCode,
      authorizationTextVersion: entry.authorizationTextVersion, text: entry.text }));
  }
  return Object.freeze({
    format: PRIVACY_NOTICE_BUNDLE_FORMAT, keyVersion: record.keyVersion, tenantId: record.tenantId,
    privacyNoticeVersion: record.privacyNoticeVersion, noticeText: record.noticeText,
    authorizations: Object.freeze(authorizations), controllerNoticeSnapshot: snapshot,
    issuedAt: record.issuedAt, expiresAt: record.expiresAt,
  });
}
