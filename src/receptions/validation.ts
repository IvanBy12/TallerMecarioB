import { z } from 'zod';
import { ApiError } from '../api/app.js';
import { BIDI_CONTROL_CHARACTERS, codePointLength, hasValidUnicode } from '../platform/unicode-text.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export const RECEPTION_BODY_LIMIT = 16 * 1024;
const NOTES_MAX = 2000;
const VERSION_TOKEN_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
export const EDITABLE_FIELDS = [
  ['appointmentId', 'appointment_id'], ['locationId', 'location_id'],
  ['mileageKm', 'mileage_km'], ['fuelLevelPct', 'fuel_level_pct'],
  ['customerNotes', 'customer_notes'], ['advisorNotes', 'advisor_notes'],
] as const;
const FIELDS = [
  ['vehicleId', 'vehicle_id'], ['customerId', 'customer_id'],
  ['appointmentId', 'appointment_id'], ['locationId', 'location_id'],
  ['mileageKm', 'mileage_km'], ['fuelLevelPct', 'fuel_level_pct'],
  ['customerNotes', 'customer_notes'], ['advisorNotes', 'advisor_notes'],
] as const;
const NOTES_PROHIBITED = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;
const notes = z.string().refine(hasValidUnicode)
  .transform((value) => value.normalize('NFC').replace(/\r\n?/gu, '\n').trim())
  .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value) && !NOTES_PROHIBITED.test(value))
  .refine((value) => codePointLength(value) <= NOTES_MAX)
  .nullable().transform((value) => value === '' ? null : value);
const createSchema = z.object({
  vehicleId: z.string(), customerId: z.string(),
  appointmentId: z.string().nullable().optional(), locationId: z.string().nullable().optional(),
  mileageKm: z.number().int().min(0).max(2147483647),
  fuelLevelPct: z.number().int().min(0).max(100).nullable().optional(),
  customerNotes: notes.optional(), advisorNotes: notes.optional(),
}).strict();
const patchSchema = z.object({
  expectedUpdatedAt: z.string().regex(VERSION_TOKEN_PATTERN),
  appointmentId: z.string().nullable().optional(), locationId: z.string().nullable().optional(),
  mileageKm: z.number().int().min(0).max(2147483647).optional(),
  fuelLevelPct: z.number().int().min(0).max(100).nullable().optional(),
  customerNotes: notes.optional(), advisorNotes: notes.optional(),
}).strict();

export type EditableColumn = (typeof EDITABLE_FIELDS)[number][1];
export type EditableValues = {
  appointment_id: string | null; location_id: string | null; mileage_km: number;
  fuel_level_pct: number | null; customer_notes: string | null; advisor_notes: string | null;
};
export interface PatchReceptionInput {
  expectedUpdatedAt: string;
  changes: Partial<EditableValues>;
}

export interface CreateReceptionInput {
  vehicleId: string;
  customerId: string;
  appointmentId: string | null;
  locationId: string | null;
  mileageKm: number;
  fuelLevelPct: number | null;
  customerNotes: string | null;
  advisorNotes: string | null;
  fields: string[];
}

export const createReceptionBodySchema = { type: 'object', additionalProperties: false,
  required: ['vehicleId', 'customerId', 'mileageKm'], properties: {
    vehicleId: { type: 'string' }, customerId: { type: 'string' },
    appointmentId: { type: ['string', 'null'] }, locationId: { type: ['string', 'null'] },
    mileageKm: { type: 'integer' }, fuelLevelPct: { type: ['integer', 'null'] },
    customerNotes: { type: ['string', 'null'] }, advisorNotes: { type: ['string', 'null'] },
  } } as const;
export const patchReceptionBodySchema = { type: 'object', additionalProperties: false,
  required: ['expectedUpdatedAt'], minProperties: 2, properties: {
    expectedUpdatedAt: { type: 'string' },
    appointmentId: { type: ['string', 'null'] }, locationId: { type: ['string', 'null'] },
    mileageKm: { type: 'integer' }, fuelLevelPct: { type: ['integer', 'null'] },
    customerNotes: { type: ['string', 'null'] }, advisorNotes: { type: ['string', 'null'] },
  } } as const;

function invalid(): ApiError {
  return new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
}

export function parseCreateReception(body: unknown): CreateReceptionInput {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const value = parsed.data;
  const vehicleId = parseCanonicalUuid(value.vehicleId);
  const customerId = parseCanonicalUuid(value.customerId);
  const appointmentId = value.appointmentId == null ? null : parseCanonicalUuid(value.appointmentId);
  const locationId = value.locationId == null ? null : parseCanonicalUuid(value.locationId);
  if (!vehicleId || !customerId || appointmentId === undefined || locationId === undefined) throw invalid();
  return {
    vehicleId, customerId, appointmentId, locationId, mileageKm: value.mileageKm,
    fuelLevelPct: value.fuelLevelPct ?? null, customerNotes: value.customerNotes ?? null,
    advisorNotes: value.advisorNotes ?? null,
    fields: FIELDS.filter(([field]) => Object.hasOwn(value, field)).map(([, column]) => column),
  };
}

export function parsePatchReception(body: unknown): PatchReceptionInput {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  const changes: Record<string, string | number | null> = {};
  for (const [field, column] of EDITABLE_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (field === 'appointmentId' || field === 'locationId') {
      const canonical = value === null ? null : parseCanonicalUuid(value);
      if (canonical === undefined) throw invalid();
      changes[column] = canonical;
    } else {
      changes[column] = value as string | number | null;
    }
  }
  if (Object.keys(changes).length === 0) throw invalid();
  return { expectedUpdatedAt: input.expectedUpdatedAt, changes: changes as Partial<EditableValues> };
}
