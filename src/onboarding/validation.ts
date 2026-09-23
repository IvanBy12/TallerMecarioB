import { z } from 'zod';

const PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Built from numeric code points (never embedded as literal characters or
 * `\u` escapes in this source file) so the bidi-override range
 * U+202A-U+202E and the bidi-isolate range U+2066-U+2069 cannot be
 * silently mangled by any text-processing step between editor and disk --
 * these exact code points are the entire point of the check. Never
 * silently strip them: a hidden one can make displayed text read
 * differently than its byte order (e.g. spoof a file extension or a name).
 */
const BIDI_CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
  'u',
);
// `\s` in Unicode mode already matches every Unicode White_Space code
// point (regular spaces, NBSP, the U+2000-200A run, line/paragraph
// separators, the CJK ideographic space, etc.) -- no need to enumerate them.
const WHITESPACE_RUN = /\s+/gu;

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number {
  return [...value].length;
}

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

const email = normalizedText(320)
  .transform((value) => value.toLowerCase())
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), 'must be an email address');

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

/**
 * Provider-sourced (Clerk) `fullName` is sanitized, never a 403: this data
 * did not come from the request body, so blocking onboarding over an
 * awkward-but-real name is the wrong failure mode. NFC -> trim -> collapse
 * whitespace -> empty becomes null -> Unicode-safe truncation to 200 code
 * points (never split a surrogate pair or a combining sequence mid-cluster
 * by slicing UTF-16 code units). A malformed string (lone surrogate, NUL)
 * degrades to null rather than persisting invalid data or throwing.
 */
function normalizeProviderFullName(raw: string | null): string | null {
  if (raw === null) return null;
  if (!hasValidUnicode(raw)) return null;
  let value = raw.normalize('NFC').trim().replace(WHITESPACE_RUN, ' ');
  value = value.replace(PROHIBITED_CONTROL_CHARACTERS, '').trim();
  if (value.length === 0) return null;
  const codePoints = [...value];
  if (codePoints.length > 200) value = codePoints.slice(0, 200).join('');
  return value;
}

export const verifiedProfileSchema = z.object({
  email,
  emailVerified: z.literal(true),
  fullName: z.string().nullable().transform(normalizeProviderFullName),
}).strict();

export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;
export type VerifiedProfileInput = z.infer<typeof verifiedProfileSchema>;
