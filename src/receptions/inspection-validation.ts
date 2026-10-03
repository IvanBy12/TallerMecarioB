import { z } from 'zod';
import { ApiError } from '../api/app.js';
import { BIDI_CONTROL_CHARACTERS, codePointLength, hasValidUnicode } from '../platform/unicode-text.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { VERSION_TOKEN_PATTERN } from './validation.js';

export const INSPECTION_BODY_LIMIT = 64 * 1024;
const prohibited = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;
function text(max: number, nonempty = true) {
  return z.string().refine(hasValidUnicode)
    .transform((value) => value.normalize('NFC').replace(/\r\n?/gu, '\n').trim())
    .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value) && !prohibited.test(value))
    .refine((value) => codePointLength(value) <= max && (!nonempty || value.length > 0));
}
const note = text(2000, false).nullable().transform((value) => value === '' ? null : value);
const checkItem = z.object({ code: text(64), label: text(160),
  status: z.enum(['ok', 'issue', 'not_checked', 'not_applicable']), notes: note }).strict();
const damageFields = { zoneCode: text(64), damageType: text(64),
  severity: z.enum(['minor', 'moderate', 'severe']), description: note };
const damage = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), ...damageFields }).strict(),
  z.object({ operation: z.literal('update'), damageId: z.string()
    .transform((value, ctx) => {
      const id = parseCanonicalUuid(value);
      if (!id) { ctx.addIssue({ code: 'custom', message: 'Invalid ID' }); return z.NEVER; }
      return id;
    }), ...damageFields }).strict(),
]);
const version = z.string().regex(VERSION_TOKEN_PATTERN);
const checks = z.object({ expectedUpdatedAt: version, items: z.array(checkItem).min(1).max(100) }).strict();
const damages = z.object({ expectedUpdatedAt: version, damages: z.array(damage).min(1).max(100) }).strict();
export type ChecklistInput = z.infer<typeof checks>;
export type DamagesInput = z.infer<typeof damages>;
const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
export function parseChecklist(body: unknown): ChecklistInput {
  const parsed = checks.safeParse(body);
  if (!parsed.success || new Set(parsed.data.items.map((item) => item.code)).size !== parsed.data.items.length)
    throw invalid();
  return parsed.data;
}
export function parseDamages(body: unknown): DamagesInput {
  const parsed = damages.safeParse(body);
  if (!parsed.success) throw invalid();
  const ids = parsed.data.damages.flatMap((item) => item.operation === 'update' ? [item.damageId] : []);
  if (new Set(ids).size !== ids.length) throw invalid();
  return parsed.data;
}
