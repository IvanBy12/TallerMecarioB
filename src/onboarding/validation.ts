import { z } from 'zod';

const PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

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

function normalizedText(maxLength: number) {
  return z.string()
    .transform((value) => value.trim().normalize('NFC'))
    .refine((value) => value.length > 0, 'must not be empty')
    .refine(hasValidUnicode, 'must contain valid Unicode')
    .refine((value) => !PROHIBITED_CONTROL_CHARACTERS.test(value), 'contains prohibited control characters')
    .refine((value) => codePointLength(value) <= maxLength, `must contain at most ${maxLength} characters`);
}

const optionalText = (maxLength: number) => normalizedText(maxLength).optional();

const email = normalizedText(320)
  .transform((value) => value.toLowerCase())
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), 'must be an email address');

export const onboardingRequestSchema = z.object({
  workshop: z.object({
    legalName: normalizedText(200),
    displayName: normalizedText(160),
    taxId: optionalText(40),
    phone: optionalText(32),
    email: email.optional(),
  }).strict(),
  primaryLocation: z.object({
    name: normalizedText(160),
    addressLine: normalizedText(500),
    city: normalizedText(120),
    department: normalizedText(120),
    phone: optionalText(32),
  }).strict(),
}).strict();

export const verifiedProfileSchema = z.object({
  email,
  emailVerified: z.literal(true),
  fullName: normalizedText(200).nullable(),
}).strict();

export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;
export type VerifiedProfileInput = z.infer<typeof verifiedProfileSchema>;
