/**
 * D-PRIV-02/05 controller identity snapshot (Ley 1581 art. 12 lit. d):
 * legalName, address, phone, email, rightsChannel. Built server-side from
 * workshops + the primary workshop_location at capture time and then retained
 * verbatim; historical evidence is never rebuilt from the current workshop.
 */
import { canonicalizeText, CONTROLLER_NOTICE_FIELDS, type ControllerNoticeFields } from './canonical-text.js';

export interface ControllerNoticeSnapshot extends ControllerNoticeFields {
  readonly legalName: string;
  readonly address: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly rightsChannel: string;
}

export interface ControllerNoticeWorkshop {
  tenantId: string;
  legalName: string;
  phone: string | null;
  email: string | null;
}
export interface ControllerNoticeLocation {
  addressLine: string;
  city: string;
  department: string;
  countryCode: string;
  phone: string | null;
}

/**
 * DOC_GAP (RIGHTS_CHANNEL_SOURCE_NOT_DEFINED): the canonical model has no
 * column for the "canal para ejercer derechos". The source is injected; the
 * production configuration returns null, so capture fails closed with
 * PRIVACY_NOTICE_NOT_CONFIGURED instead of inventing a channel.
 */
export interface ControllerNoticeConfiguration {
  rightsChannel(workshop: Readonly<ControllerNoticeWorkshop>): string | null;
}
export const PRODUCTION_CONTROLLER_NOTICE_CONFIGURATION: ControllerNoticeConfiguration = Object.freeze({
  rightsChannel: () => null,
});

const MAX_FIELD_LENGTH = 1000;

function required(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const canonical = canonicalizeText(value).trim();
  return canonical.length > 0 && canonical.length <= MAX_FIELD_LENGTH ? canonical : null;
}
function optional(value: unknown): string | null {
  return value == null ? null : required(value);
}

/** Returns null when the workshop lacks a complete notice (fail closed). */
export function buildControllerNoticeSnapshot(workshop: ControllerNoticeWorkshop,
  location: ControllerNoticeLocation | null, rightsChannel: string | null): ControllerNoticeSnapshot | null {
  if (!location) return null;
  const legalName = required(workshop.legalName);
  const parts = [location.addressLine, location.city, location.department, location.countryCode].map(required);
  const channel = optional(rightsChannel);
  const phone = optional(workshop.phone) ?? optional(location.phone);
  const email = optional(workshop.email);
  if (!legalName || parts.some((part) => part === null) || !channel || (!phone && !email)) return null;
  return Object.freeze({ legalName, address: parts.join(', '), phone, email, rightsChannel: channel });
}

/**
 * Strict shape check for a snapshot coming from storage or an authenticated
 * bundle: exactly the five keys, canonical strings, phone/email nullable with
 * at least one present (mirrors privacy_consents_controller_snapshot_check).
 */
export function parseControllerNoticeSnapshot(value: unknown): ControllerNoticeSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...CONTROLLER_NOTICE_FIELDS].sort().join(',')) return null;
  const exact = (field: unknown, nullable: boolean): boolean => {
    if (field === null) return nullable;
    try {
      return typeof field === 'string' && required(field) === field;
    } catch {
      return false;
    }
  };
  if (!exact(record.legalName, false) || !exact(record.address, false) || !exact(record.rightsChannel, false)
    || !exact(record.phone, true) || !exact(record.email, true)
    || (record.phone === null && record.email === null)) return null;
  return Object.freeze({
    legalName: record.legalName as string, address: record.address as string,
    phone: record.phone as string | null, email: record.email as string | null,
    rightsChannel: record.rightsChannel as string,
  });
}
