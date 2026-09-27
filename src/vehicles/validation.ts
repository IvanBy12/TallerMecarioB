import { z } from 'zod';
import { ApiError } from '../api/app.js';
import { BIDI_CONTROL_CHARACTERS, codePointLength, hasValidUnicode, PROHIBITED_CONTROL_CHARACTERS } from '../platform/unicode-text.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export const VEHICLE_FIELDS = Object.freeze([
  ['plate', 'plate'], ['vehicleType', 'vehicle_type'], ['brand', 'brand'], ['model', 'model'],
  ['modelYear', 'model_year'], ['color', 'color'], ['vin', 'vin'], ['engineNumber', 'engine_number'],
] as const);
export type VehicleColumn = (typeof VEHICLE_FIELDS)[number][1];
export interface VehicleValues {
  plate: string; vehicle_type: 'car' | 'motorcycle' | 'other'; brand: string; model: string;
  model_year: number | null; color: string | null; vin: string | null; engine_number: string | null;
}
export const invalid = (subject: 'body' | 'query' = 'body'): ApiError =>
  new ApiError(400, 'REQUEST_VALIDATION_FAILED', `The request ${subject} is invalid.`);
const text = (max: number) => z.string().refine(hasValidUnicode)
  .transform((value) => value.normalize('NFC').trim())
  .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value) && !PROHIBITED_CONTROL_CHARACTERS.test(value))
  .refine((value) => codePointLength(value) <= max);
const requiredText = (max: number) => text(max).refine((value) => value.length > 0);
const nullableText = (max: number) => text(max).nullable().transform((value) => value === '' ? null : value);
const plate = z.string().transform((value) => value.trim().replace(/[ .-]/gu, '')
  .replace(/[a-z]/gu, (letter) => letter.toUpperCase())).refine((value) => /^[A-Z0-9]{1,16}$/u.test(value));
const vehicleType = z.enum(['car', 'motorcycle', 'other']);
const modelYear = z.number().int().min(1886).max(2200).nullable();
const createSchema = z.object({ customerId: z.string(), plate, vehicleType,
  brand: requiredText(80), model: requiredText(100), modelYear: modelYear.optional(),
  color: nullableText(60).optional(), vin: nullableText(32).optional(),
  engineNumber: nullableText(80).optional(),
}).strict();
const patchSchema = z.object({
  expectedUpdatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
  plate: plate.optional(), vehicleType: vehicleType.optional(), brand: requiredText(80).optional(),
  model: requiredText(100).optional(), modelYear: modelYear.optional(),
  color: nullableText(60).optional(), vin: nullableText(32).optional(),
  engineNumber: nullableText(80).optional(),
}).strict();
export interface CreateVehicleInput { customerId: string; values: VehicleValues; }
export function parseCreateVehicle(body: unknown): CreateVehicleInput {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  const customerId = parseCanonicalUuid(input.customerId);
  if (!customerId) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'The customer was not found.');
  return { customerId, values: {
    plate: input.plate, vehicle_type: input.vehicleType, brand: input.brand, model: input.model,
    model_year: input.modelYear ?? null, color: input.color ?? null, vin: input.vin ?? null,
    engine_number: input.engineNumber ?? null,
  } };
}
export interface PatchVehicleInput { expectedUpdatedAt: string; changes: Partial<VehicleValues>; }
export function parsePatchVehicle(body: unknown): PatchVehicleInput {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  const changes: Record<string, unknown> = {};
  for (const [field, column] of VEHICLE_FIELDS) {
    if (Object.hasOwn(input, field)) changes[column] = input[field];
  }
  if (Object.keys(changes).length === 0) throw invalid();
  return { expectedUpdatedAt: input.expectedUpdatedAt, changes: changes as Partial<VehicleValues> };
}
const nullableString = { type: ['string', 'null'] } as const;
export const createVehicleBodySchema = { type: 'object', additionalProperties: false,
  required: ['customerId', 'plate', 'vehicleType', 'brand', 'model'], properties: {
    customerId: { type: 'string' }, plate: { type: 'string' }, vehicleType: { type: 'string' },
    brand: { type: 'string' }, model: { type: 'string' }, modelYear: { type: ['integer', 'null'] },
    color: nullableString, vin: nullableString, engineNumber: nullableString,
  } } as const;
export const patchVehicleBodySchema = { type: 'object', additionalProperties: false,
  required: ['expectedUpdatedAt'], minProperties: 2, properties: {
    expectedUpdatedAt: { type: 'string' }, plate: { type: 'string' }, vehicleType: { type: 'string' },
    brand: { type: 'string' }, model: { type: 'string' }, modelYear: { type: ['integer', 'null'] },
    color: nullableString, vin: nullableString, engineNumber: nullableString,
  } } as const;
const LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
export interface ListVehiclesQuery { limit: number; afterId?: string; plate?: string; }
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id }), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): string | undefined {
  if (!CURSOR_PATTERN.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('v') || !keys.includes('id')) return undefined;
  const { v, id } = payload as { v: unknown; id: unknown };
  if (v !== 1 || typeof id !== 'string') return undefined;
  const canonical = parseCanonicalUuid(id);
  return canonical === id ? canonical : undefined;
}
export function parseListVehiclesQuery(query: unknown): ListVehiclesQuery {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (!['plate', 'limit', 'cursor'].includes(key) || typeof value !== 'string') throw invalid('query');
    values[key] = value;
  }
  let limit = 20;
  if (values.limit !== undefined) {
    if (!LIMIT_PATTERN.test(values.limit)) throw invalid('query');
    limit = Number(values.limit);
    if (limit > 100) throw invalid('query');
  }
  const afterId = values.cursor === undefined ? undefined : decodeCursor(values.cursor);
  if (values.cursor !== undefined && afterId === undefined) throw invalid('query');
  const normalizedPlate = values.plate === undefined ? undefined : plate.safeParse(values.plate);
  if (normalizedPlate && !normalizedPlate.success) throw invalid('query');
  return { limit, ...(afterId === undefined ? {} : { afterId }),
    ...(normalizedPlate === undefined ? {} : { plate: normalizedPlate.data }) };
}
