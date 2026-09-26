/**
 * S2-04 Customers API input contract (Arquitectura Técnica v1 §13.4, including
 * «Clientes — cierre S2-04»; Diccionario 01 §10; docs/S2-04-DOC-CHANGES.md).
 *
 * Shape (strict keys, JSON types) is enforced by the Fastify JSON Schemas
 * below; normalization and value rules by the Zod schemas. Every violation is
 * the same 400 REQUEST_VALIDATION_FAILED with a fixed message: input values
 * are never reflected.
 *
 * Text rule (firstName, lastName, documentType, documentNumber, `name` query):
 * well-formed Unicode -> NFC -> trim -> reject C0/C1 control and bidi control
 * characters -> code-point length. Internal whitespace is NOT collapsed (the
 * S1 onboarding helper does collapse; it is intentionally not reused).
 *
 * `notes` (DOC_GAP-03/04): same, but CRLF/CR -> LF first and LF is allowed
 * inside; TAB and every other control character is still rejected; <= 2000
 * code points after normalization.
 *
 * Nullable fields (email, documentType, documentNumber, notes; DOC_GAP-02):
 * `null` is accepted in POST and PATCH, and a value that normalizes to "" is
 * canonicalized to null (empty strings are never stored). firstName, lastName
 * and phone never accept null or an empty result.
 */

import { z } from 'zod';
import { ApiError } from '../api/app.js';
import {
  BIDI_CONTROL_CHARACTERS,
  codePointLength,
  EMAIL_ADDRESS_PATTERN,
  hasValidUnicode,
  PROHIBITED_CONTROL_CHARACTERS,
} from '../platform/unicode-text.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export const CUSTOMER_BODY_LIMIT = 16 * 1024;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 100;

const NAME_MAX = 120;
const DOCUMENT_TYPE_MAX = 24;
const DOCUMENT_NUMBER_MAX = 40;
const EMAIL_MAX = 320;
const NOTES_MAX = 2000;

/** Exactly the `updatedAt` form the API emits: UTC, microseconds. */
const VERSION_TOKEN_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
/** Removed from phone input: ASCII space, '-', '.', '(' and ')' only. */
const PHONE_SEPARATORS = /[ .()-]/gu;
const PHONE_PATTERN = /^\+?[0-9]{7,15}$/u;
/** Every C0/C1 control character except LF (U+000A): notes only. */
const NOTES_PROHIBITED_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u;

export function requestValidationFailed(subject: 'body' | 'query' = 'body'): ApiError {
  return new ApiError(400, 'REQUEST_VALIDATION_FAILED', `The request ${subject} is invalid.`);
}

/* -------------------------------------------------------------------------- */
/* Field schemas                                                              */
/* -------------------------------------------------------------------------- */

function crmText(max: number) {
  return z.string()
    .refine(hasValidUnicode)
    .transform((value) => value.normalize('NFC').trim())
    .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value) && !PROHIBITED_CONTROL_CHARACTERS.test(value))
    .refine((value) => codePointLength(value) <= max);
}

const requiredText = (max: number) => crmText(max).refine((value) => value.length > 0);

const emptyToNull = (value: string | null): string | null => (value === '' ? null : value);

const nullableText = (max: number) => crmText(max).nullable().transform(emptyToNull);

const phone = z.string()
  .transform((value) => value.replace(PHONE_SEPARATORS, ''))
  .refine((value) => PHONE_PATTERN.test(value));

/** trim + the existing S1 email checks, minus its lowercasing/collapsing (Arq §13.4). */
const email = z.string()
  .refine(hasValidUnicode)
  .transform((value) => value.trim())
  .refine((value) => value === '' || (
    !BIDI_CONTROL_CHARACTERS.test(value)
    && !PROHIBITED_CONTROL_CHARACTERS.test(value)
    && codePointLength(value) <= EMAIL_MAX
    && EMAIL_ADDRESS_PATTERN.test(value)))
  .nullable()
  .transform(emptyToNull);

const notes = z.string()
  .refine(hasValidUnicode)
  .transform((value) => value.normalize('NFC').replace(/\r\n?/gu, '\n').trim())
  .refine((value) => !BIDI_CONTROL_CHARACTERS.test(value) && !NOTES_PROHIBITED_CONTROL_CHARACTERS.test(value))
  .refine((value) => codePointLength(value) <= NOTES_MAX)
  .nullable()
  .transform(emptyToNull);

/* -------------------------------------------------------------------------- */
/* Bodies                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * API field -> persisted column, in the canonical order used for the audit
 * `fields` / `changed_fields` arrays (DOC_GAP-05). Never reorder by input.
 */
export const CUSTOMER_FIELDS = Object.freeze([
  ['firstName', 'first_name'],
  ['lastName', 'last_name'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['documentType', 'document_type'],
  ['documentNumber', 'document_number'],
  ['notes', 'notes'],
] as const);

export type CustomerField = (typeof CUSTOMER_FIELDS)[number][0];
export type CustomerColumn = (typeof CUSTOMER_FIELDS)[number][1];

export interface CustomerValues {
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  document_type: string | null;
  document_number: string | null;
  notes: string | null;
}

const createSchema = z.object({
  firstName: requiredText(NAME_MAX),
  lastName: requiredText(NAME_MAX),
  phone,
  email: email.optional(),
  documentType: nullableText(DOCUMENT_TYPE_MAX).optional(),
  documentNumber: nullableText(DOCUMENT_NUMBER_MAX).optional(),
  notes: notes.optional(),
}).strict();

const patchSchema = z.object({
  expectedUpdatedAt: z.string().regex(VERSION_TOKEN_PATTERN),
  firstName: requiredText(NAME_MAX).optional(),
  lastName: requiredText(NAME_MAX).optional(),
  phone: phone.optional(),
  email: email.optional(),
  documentType: nullableText(DOCUMENT_TYPE_MAX).optional(),
  documentNumber: nullableText(DOCUMENT_NUMBER_MAX).optional(),
  notes: notes.optional(),
}).strict();

/** Both null or both set, on the resulting row state (DOC_GAP-02). */
export function documentPairIsValid(values: Pick<CustomerValues, 'document_type' | 'document_number'>): boolean {
  return (values.document_type === null) === (values.document_number === null);
}

export interface CreateCustomerInput {
  readonly values: CustomerValues;
  /** Persisted column names the request informed, canonical order. */
  readonly fields: readonly CustomerColumn[];
}

export function parseCreateCustomer(body: unknown): CreateCustomerInput {
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw requestValidationFailed();
  const input = parsed.data;
  const values: CustomerValues = {
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone,
    email: input.email ?? null,
    document_type: input.documentType ?? null,
    document_number: input.documentNumber ?? null,
    notes: input.notes ?? null,
  };
  if (!documentPairIsValid(values)) throw requestValidationFailed();
  const fields = CUSTOMER_FIELDS
    .filter(([field]) => Object.hasOwn(input, field))
    .map(([, column]) => column);
  return { values, fields };
}

export interface PatchCustomerInput {
  /** Opaque OCC token, compared as text; never parsed into a JS Date. */
  readonly expectedUpdatedAt: string;
  /** Normalized values of the fields present in the request only. */
  readonly changes: Partial<CustomerValues>;
}

export function parsePatchCustomer(body: unknown): PatchCustomerInput {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw requestValidationFailed();
  const input = parsed.data;
  const changes: Partial<Record<CustomerColumn, string | null>> = {};
  for (const [field, column] of CUSTOMER_FIELDS) {
    if (Object.hasOwn(input, field)) changes[column] = input[field] as string | null;
  }
  if (Object.keys(changes).length === 0) throw requestValidationFailed();
  return { expectedUpdatedAt: input.expectedUpdatedAt, changes: changes as Partial<CustomerValues> };
}

/** JSON Schema shape guards (Fastify/Ajv, coerceTypes off): strict keys and JSON types only. */
const nullableString = { type: ['string', 'null'] } as const;

export const createCustomerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['firstName', 'lastName', 'phone'],
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    phone: { type: 'string' },
    email: nullableString,
    documentType: nullableString,
    documentNumber: nullableString,
    notes: nullableString,
  },
} as const;

export const patchCustomerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedUpdatedAt'],
  minProperties: 2,
  properties: {
    expectedUpdatedAt: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    phone: { type: 'string' },
    email: nullableString,
    documentType: nullableString,
    documentNumber: nullableString,
    notes: nullableString,
  },
} as const;

/* -------------------------------------------------------------------------- */
/* List query                                                                 */
/* -------------------------------------------------------------------------- */

const LIST_QUERY_KEYS = new Set(['phone', 'documentNumber', 'name', 'limit', 'cursor']);
const LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CURSOR_VERSION = 1;

export interface ListCustomersQuery {
  readonly limit: number;
  readonly afterId?: string;
  readonly phone?: string;
  readonly documentNumber?: string;
  readonly name?: string;
}

/** Opaque, versioned base64url keyset cursor (Arq §13): the last returned id. */
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): string | undefined {
  if (!CURSOR_PATTERN.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64url');
  // Reject non-canonical encodings (Node's decoder is lenient).
  if (bytes.toString('base64url') !== raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('v') || !keys.includes('id')) return undefined;
  const { v, id } = payload as { v: unknown; id: unknown };
  if (v !== CURSOR_VERSION || typeof id !== 'string') return undefined;
  const canonical = parseCanonicalUuid(id);
  return canonical === id ? canonical : undefined;
}

function queryValue(schema: z.ZodType<string>, raw: string): string {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw requestValidationFailed('query');
  return parsed.data;
}

/**
 * Only phone, documentNumber, name, limit, cursor; each at most once. Unknown
 * keys (tenantId, q, email, firstName, lastName, ...) and repeated keys are 400.
 */
export function parseListCustomersQuery(query: unknown): ListCustomersQuery {
  const source = (query ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!LIST_QUERY_KEYS.has(key) || typeof value !== 'string') throw requestValidationFailed('query');
    values[key] = value;
  }

  let limit = LIST_DEFAULT_LIMIT;
  if (values.limit !== undefined) {
    if (!LIMIT_PATTERN.test(values.limit)) throw requestValidationFailed('query');
    limit = Number(values.limit);
    if (limit > LIST_MAX_LIMIT) throw requestValidationFailed('query');
  }

  let afterId: string | undefined;
  if (values.cursor !== undefined) {
    afterId = decodeCursor(values.cursor);
    if (afterId === undefined) throw requestValidationFailed('query');
  }

  return {
    limit,
    ...(afterId === undefined ? {} : { afterId }),
    ...(values.phone === undefined ? {} : { phone: queryValue(phone, values.phone) }),
    ...(values.documentNumber === undefined
      ? {} : { documentNumber: queryValue(requiredText(DOCUMENT_NUMBER_MAX), values.documentNumber) }),
    ...(values.name === undefined ? {} : { name: queryValue(requiredText(NAME_MAX), values.name) }),
  };
}
