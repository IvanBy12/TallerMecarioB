import { z } from 'zod';
import { ApiError } from '../api/app.js';
import { BIDI_CONTROL_CHARACTERS, codePointLength, hasValidUnicode } from '../platform/unicode-text.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export const RECEPTION_BODY_LIMIT = 16 * 1024;
const NOTES_MAX = 2000;
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
