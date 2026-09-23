import { z } from 'zod';
import { canonicalEmailSchema } from '../identity/profile.js';
import {
  BIDI_CONTROL_CHARACTERS,
  codePointLength,
  hasValidUnicode,
  PROHIBITED_CONTROL_CHARACTERS,
  WHITESPACE_RUN,
} from '../platform/unicode-text.js';

export { verifiedProfileSchema, type VerifiedProfileInput } from '../identity/profile.js';

/**
 * Request-body text contract: well-formed Unicode -> NFC -> trim -> collapse
 * internal whitespace runs to one space -> reject (never silently strip)
 * bidi-override/isolate controls and other C0/C1 control characters.
 * Strict: any violation is a 400, never a silent transform of dangerous
 * input. Contrast with `normalizeProviderFullName`, which is permissive
 * because it sanitizes provider-sourced data that must never block
 * onboarding.
 */
function normalizedText(maxLength: number) {
  return z.string()
    .refine(hasValidUnicode, 'must be well-formed Unicode')
    .transform((value) => value.normalize('NFC'))
    .transform((value) => value.trim())
    .transform((value) => value.replace(WHITESPACE_RUN, ' '))
    .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value), 'must not contain bidirectional control characters')
    .refine((value) => !PROHIBITED_CONTROL_CHARACTERS.test(value), 'contains prohibited control characters')
    .refine((value) => value.length > 0, 'must not be empty')
    .refine((value) => codePointLength(value) <= maxLength, `must contain at most ${maxLength} characters`);
}

const optionalText = (maxLength: number) => normalizedText(maxLength).optional();

const email = canonicalEmailSchema;

// DOC_CONFLICT note (see AGENTS.md §1): the canonical S1-01 validation
// contract (referenced by the architecture audit as "the spec") was not
// found in the Notion canonical docs (Diccionario de Datos only types
// `tax_id varchar(40) nullable`, no format) and is not reproducible from
// this repository. This pattern -- alphanumeric plus internal hyphens, no
// spaces or other punctuation -- is a conservative placeholder chosen to
// (a) reject arbitrary free text as required and (b) stay compatible with
// the existing `NIT-xxxxxxxx` fixtures used throughout the test suite.
// Confirm against the actual S1-01 spec and replace if it differs.
const TAX_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/u;
const taxId = normalizedText(40)
  .refine((value) => TAX_ID_PATTERN.test(value), 'must be a valid tax identifier');

const PHONE_ALLOWED_INPUT = /^[+0-9()\-\s]+$/u;
const PHONE_RESULT_PATTERN = /^\+?[0-9]{7,15}$/u;

/**
 * Raw input: 7-32 characters, only `+ 0-9 ( ) -` and spaces (a letter is a
 * 400, never coerced). Normalization strips spaces, `(`, `)` and `-`
 * (an optional leading `+` survives); the result must match
 * `^\+?[0-9]{7,15}$`.
 */
const phone = z.string()
  .refine(hasValidUnicode, 'must be well-formed Unicode')
  .refine((value) => value.length >= 7 && value.length <= 32, 'must be 7 to 32 characters')
  .refine((value) => PHONE_ALLOWED_INPUT.test(value), 'must contain only digits, spaces, +, ( ) and -')
  .transform((value) => value.replace(/[\s()-]/gu, ''))
  .refine((value) => PHONE_RESULT_PATTERN.test(value), 'must be a valid phone number');

export const onboardingRequestSchema = z.object({
  workshop: z.object({
    legalName: normalizedText(200),
    displayName: normalizedText(160),
    taxId: taxId.optional(),
    phone: phone.optional(),
    email: email.optional(),
  }).strict(),
  primaryLocation: z.object({
    name: normalizedText(160),
    addressLine: normalizedText(300),
    city: normalizedText(120),
    department: normalizedText(120),
    phone: phone.optional(),
  }).strict(),
}).strict();

export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;
