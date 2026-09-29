import { z } from 'zod';
import { ApiError } from '../api/app.js';
import { isPrivacyPurposeCode, PRIVACY_DOCUMENT_VERSION_PATTERN, type PrivacyPurposeCode } from './catalog.js';

export const PRIVACY_CONSENT_BODY_LIMIT = 16 * 1024;
/** privacy_consents_channel_check. */
export const PRIVACY_CONSENT_CHANNELS = ['web', 'in_person', 'whatsapp', 'email', 'phone', 'import', 'other'] as const;
export type PrivacyConsentChannel = (typeof PRIVACY_CONSENT_CHANNELS)[number];
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The client names versions and a purpose, and declares capturedAt. The server
 * owns texts, snapshot, hash, tenant, status and timestamps: any such key is
 * an unknown property and fails validation (additionalProperties: false).
 * D-PRIV-04: adultAttestationConfirmed must be the literal true; it is not
 * persisted (the attestation is part of the versioned authorization text).
 */
const captureSchema = z.object({
  purposeCode: z.string(),
  privacyNoticeVersion: z.string().regex(PRIVACY_DOCUMENT_VERSION_PATTERN),
  authorizationTextVersion: z.string().regex(PRIVACY_DOCUMENT_VERSION_PATTERN),
  channel: z.enum(PRIVACY_CONSENT_CHANNELS),
  capturedAt: z.string().nullable().optional(),
  adultAttestationConfirmed: z.literal(true),
}).strict();

export const capturePrivacyConsentBodySchema = { type: 'object', additionalProperties: false,
  required: ['purposeCode', 'privacyNoticeVersion', 'authorizationTextVersion', 'channel',
    'adultAttestationConfirmed'],
  properties: {
    purposeCode: { type: 'string' }, privacyNoticeVersion: { type: 'string' },
    authorizationTextVersion: { type: 'string' }, channel: { type: 'string' },
    capturedAt: { type: ['string', 'null'] }, adultAttestationConfirmed: { type: 'boolean' },
  } } as const;

export interface CapturePrivacyConsentInput {
  customerId: string;
  purposeCode: PrivacyPurposeCode;
  privacyNoticeVersion: string;
  authorizationTextVersion: string;
  channel: PrivacyConsentChannel;
  /** Declared by the channel/device: evidence only, never ordering authority. */
  capturedAt: string | null;
  adultAttestationConfirmed: true;
}

function invalid(): ApiError {
  return new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
}

/** RFC 3339 instant with an explicit offset and a real calendar date. */
export function isDeclaredInstant(value: string): boolean {
  const match = INSTANT.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as number[];
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  return date.getUTCFullYear() === year && date.getUTCMonth() === (month as number) - 1
    && date.getUTCDate() === day && (hour as number) < 24 && (minute as number) < 60
    && (second as number) < 60 && !Number.isNaN(Date.parse(value));
}

export function parseCapturePrivacyConsent(customerId: string, body: unknown): CapturePrivacyConsentInput {
  const parsed = captureSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const value = parsed.data;
  const purposeCode = value.purposeCode;
  if (!isPrivacyPurposeCode(purposeCode)) throw invalid();
  const capturedAt = value.capturedAt ?? null;
  if (capturedAt !== null && !isDeclaredInstant(capturedAt)) throw invalid();
  return { customerId, purposeCode, privacyNoticeVersion: value.privacyNoticeVersion,
    authorizationTextVersion: value.authorizationTextVersion, channel: value.channel, capturedAt,
    adultAttestationConfirmed: value.adultAttestationConfirmed };
}
