/**
 * D-PRIV-02 server-owned, versioned privacy document catalog (in code; the MVP
 * has no privacy_notice_versions table). A published version is immutable:
 * changing its text requires a new version, and a version stays published
 * while historical evidence or an acceptable bundle may reference it.
 */
import { canonicalizeText } from './canonical-text.js';

/** Diccionario 04 §1.1 initial purpose catalog. Only service_provision gates receptions. */
export const PRIVACY_PURPOSE_CODES = [
  'service_provision',
  'service_notifications_whatsapp',
  'appointment_reminders',
  'marketing',
  'image_use',
] as const;
export type PrivacyPurposeCode = (typeof PRIVACY_PURPOSE_CODES)[number];
export const RECEPTION_PURPOSE_CODE: PrivacyPurposeCode = 'service_provision';

/** Fits varchar(40); ASCII so it can never collide with the 0x00 preimage separator. */
export const PRIVACY_DOCUMENT_VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?$/u;

export interface PrivacyNoticeEntry { readonly version: string; readonly text: string; }
export interface AuthorizationTextEntry {
  readonly purposeCode: PrivacyPurposeCode;
  readonly version: string;
  /** Includes the D-PRIV-04 adult attestation wording for this purpose. */
  readonly text: string;
}
export interface PublishedPrivacyDocuments {
  readonly notices: readonly PrivacyNoticeEntry[];
  readonly authorizations: readonly AuthorizationTextEntry[];
}
export interface ResolvedPrivacyDocuments { noticeText: string; authorizationText: string; }

export class PrivacyCatalogDefinitionError extends Error {
  constructor(reason: string) {
    super(`PRIVACY_CATALOG_DEFINITION_INVALID ${reason}`);
    this.name = 'PrivacyCatalogDefinitionError';
  }
}

export function isPrivacyPurposeCode(value: unknown): value is PrivacyPurposeCode {
  return typeof value === 'string' && (PRIVACY_PURPOSE_CODES as readonly string[]).includes(value);
}

export class PrivacyDocumentCatalog {
  readonly #notices: ReadonlyMap<string, string>;
  readonly #authorizations: ReadonlyMap<string, string>;

  constructor(documents: PublishedPrivacyDocuments) {
    const notices = new Map<string, string>();
    for (const entry of documents.notices) {
      assertPublishable(entry.version, entry.text);
      if (notices.has(entry.version)) throw new PrivacyCatalogDefinitionError('duplicate notice version');
      notices.set(entry.version, entry.text);
    }
    const authorizations = new Map<string, string>();
    for (const entry of documents.authorizations) {
      if (!isPrivacyPurposeCode(entry.purposeCode)) throw new PrivacyCatalogDefinitionError('unknown purpose');
      assertPublishable(entry.version, entry.text);
      const key = authorizationKey(entry.purposeCode, entry.version);
      if (authorizations.has(key)) throw new PrivacyCatalogDefinitionError('duplicate authorization version');
      authorizations.set(key, entry.text);
    }
    this.#notices = notices;
    this.#authorizations = authorizations;
    Object.freeze(this);
  }

  /** Exact published text, or null: never a fallback to a "current" version. */
  noticeText(version: string): string | null {
    return this.#notices.get(version) ?? null;
  }

  authorizationText(purposeCode: PrivacyPurposeCode, version: string): string | null {
    return this.#authorizations.get(authorizationKey(purposeCode, version)) ?? null;
  }

  resolve(purposeCode: PrivacyPurposeCode, noticeVersion: string,
    authorizationVersion: string): ResolvedPrivacyDocuments | null {
    const noticeText = this.noticeText(noticeVersion);
    const authorizationText = this.authorizationText(purposeCode, authorizationVersion);
    return noticeText === null || authorizationText === null ? null : { noticeText, authorizationText };
  }

  /** Published entries, for known-hash pinning tests. */
  published(): { notices: PrivacyNoticeEntry[]; authorizations: AuthorizationTextEntry[] } {
    return {
      notices: [...this.#notices].map(([version, text]) => ({ version, text })),
      authorizations: [...this.#authorizations].map(([key, text]) => {
        const [purposeCode, version] = key.split('\u0000') as [PrivacyPurposeCode, string];
        return { purposeCode, version, text };
      }),
    };
  }
}

function authorizationKey(purposeCode: string, version: string): string {
  return `${purposeCode}\u0000${version}`;
}

function assertPublishable(version: string, text: string): void {
  if (typeof version !== 'string' || !PRIVACY_DOCUMENT_VERSION_PATTERN.test(version))
    throw new PrivacyCatalogDefinitionError('invalid version');
  // The catalog stores the exact canonical bytes that were presented.
  if (typeof text !== 'string' || text.trim().length === 0 || canonicalizeText(text) !== text)
    throw new PrivacyCatalogDefinitionError('text is not canonical');
}

/**
 * CANONICAL_PRIVACY_COPY_NOT_PUBLISHED: the literal v1 legal copy of the
 * privacy notice and of each purpose authorization is not published in the
 * canonical documentation yet. Production therefore publishes NO version and
 * every capture fails closed with PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE.
 * Publishing requires adding the exact approved copy here plus a known-hash
 * pin in tests/privacy; never placeholder or invented legal text.
 */
export const PRODUCTION_PRIVACY_DOCUMENT_CATALOG = new PrivacyDocumentCatalog({
  notices: [],
  authorizations: [],
});
