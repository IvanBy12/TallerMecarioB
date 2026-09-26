import { z } from 'zod';
import {
  BIDI_CONTROL_CHARACTERS,
  codePointLength,
  EMAIL_ADDRESS_PATTERN,
  hasValidUnicode,
  PROHIBITED_CONTROL_CHARACTERS,
  WHITESPACE_RUN,
} from '../platform/unicode-text.js';

/**
 * Provider-profile normalization shared by every path that persists provider
 * identity data into `users` (S1-01 onboarding JIT and S1-03 webhook
 * reconciliation). One algorithm, one place.
 */

/**
 * Provider-sourced (Clerk) `fullName` never blocks onboarding or sync: this
 * data did not come from the request body, so an invalid name degrades to
 * null instead of a 403/500. Policy: non-string or malformed Unicode (lone
 * surrogate) -> null; NFC; any C0/DEL/C1 control or bidi override/isolate
 * character anywhere -> null (never partially stripped, so a potentially
 * ambiguous name is never silently rewritten); trim + collapse whitespace;
 * empty -> null; truncate to 200 code points. Truncation is Unicode-safe by
 * code point only -- it never splits a surrogate pair, but it does not
 * preserve grapheme clusters (a combining or ZWJ sequence may be cut).
 */
export function normalizeProviderFullName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!hasValidUnicode(raw)) return null;
  const normalized = raw.normalize('NFC');
  if (PROHIBITED_CONTROL_CHARACTERS.test(normalized) || BIDI_CONTROL_CHARACTERS.test(normalized)) return null;
  const value = normalized.trim().replace(WHITESPACE_RUN, ' ');
  if (value.length === 0) return null;
  const codePoints = [...value];
  return codePoints.length > 200 ? codePoints.slice(0, 200).join('') : value;
}

/**
 * Canonical email contract (same rules as the S1-01 request-body text
 * contract): well-formed Unicode -> NFC -> trim -> collapse whitespace ->
 * reject bidi/control characters -> non-empty, <= 320 code points ->
 * lowercase -> minimal shape check.
 */
export const canonicalEmailSchema = z.string()
  .refine(hasValidUnicode, 'must be well-formed Unicode')
  .transform((value) => value.normalize('NFC'))
  .transform((value) => value.trim())
  .transform((value) => value.replace(WHITESPACE_RUN, ' '))
  .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value), 'must not contain bidirectional control characters')
  .refine((value) => !PROHIBITED_CONTROL_CHARACTERS.test(value), 'contains prohibited control characters')
  .refine((value) => value.length > 0, 'must not be empty')
  .refine((value) => codePointLength(value) <= 320, 'must contain at most 320 characters')
  .transform((value) => value.toLowerCase())
  .refine((value) => EMAIL_ADDRESS_PATTERN.test(value), 'must be an email address');

/** Verified provider profile accepted for local identity reconciliation. */
export const verifiedProfileSchema = z.object({
  email: canonicalEmailSchema,
  emailVerified: z.literal(true),
  fullName: z.string().nullable().transform(normalizeProviderFullName),
}).strict();

export type VerifiedProfileInput = z.infer<typeof verifiedProfileSchema>;

/** Canonical verified email or null when the provider value is unusable (never throws). */
export function normalizeVerifiedEmail(raw: unknown): string | null {
  const parsed = canonicalEmailSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
