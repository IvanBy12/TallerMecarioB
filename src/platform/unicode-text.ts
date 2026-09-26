/**
 * Shared Unicode text primitives (moved verbatim from the S1-01 onboarding
 * validation so request-body validation and provider-profile sanitization use
 * one implementation).
 */

export const PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

/**
 * Built from numeric code points (never embedded as literal characters or
 * `\u` escapes in this source file) so the bidi-override range
 * U+202A-U+202E and the bidi-isolate range U+2066-U+2069 cannot be
 * silently mangled by any text-processing step between editor and disk --
 * these exact code points are the entire point of the check. Never
 * silently strip them: a hidden one can make displayed text read
 * differently than its byte order (e.g. spoof a file extension or a name).
 */
export const BIDI_CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
  'u',
);
// `\s` in Unicode mode already matches every Unicode White_Space code
// point (regular spaces, NBSP, the U+2000-200A run, line/paragraph
// separators, the CJK ideographic space, etc.) -- no need to enumerate them.
export const WHITESPACE_RUN = /\s+/gu;

/**
 * Minimal email shape check shared by every request/profile email validator
 * (S1 canonical email and the S2-04 CRM email, which differ only in
 * normalization: CRM never lowercases).
 */
export const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function hasValidUnicode(value: string): boolean {
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

export function codePointLength(value: string): number {
  return [...value].length;
}
