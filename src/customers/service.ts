/**
 * S2-04 Customers (Arquitectura Técnica v1 §13.4, Diccionario 01 §10,
 * Operación §5.2, ADR-009 §3/§10, docs/S2-04-DOC-CHANGES.md).
 *
 * Every statement runs through the tenant request's reserved connection
 * (`context.sql`), inside its single transaction with the app.* GUCs bound:
 * RLS (FORCE, NOBYPASSRLS runtime) and the explicit `tenant_id` predicate
 * both scope every read and write to the TenantContext tenant. The tenant is
 * never read from the request. The API holds INSERT on customers and UPDATE
 * only on the 0018 column allowlist; nothing here deletes.
 *
 * Timestamps are rendered by PostgreSQL as text with microseconds
 * (TIMESTAMP_FORMAT) and never pass through a JS Date: `updatedAt` is the
 * opaque OCC token and must round-trip exactly (D-21).
 *
 * PATCH, in one transaction:
 *   lock the row FOR NO KEY UPDATE (0 rows -> 404 CUSTOMER_NOT_FOUND)
 *   -> compare expectedUpdatedAt as text (mismatch -> 409 RESOURCE_VERSION_CONFLICT)
 *   -> merge + document pair on the resulting state (400)
 *   -> changed_fields = [] -> 200 current DTO, no UPDATE, no audit (DOC_GAP-01)
 *   -> UPDATE only the changed columns + a strictly newer updated_at
 *   -> audit customer.updated
 */

import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import {
  CUSTOMER_FIELDS,
  type CreateCustomerInput,
  type CustomerColumn,
  type CustomerValues,
  documentPairIsValid,
  encodeCursor,
  type ListCustomersQuery,
  type PatchCustomerInput,
  requestValidationFailed,
} from './validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

export const CUSTOMER_ERRORS = Object.freeze({
  CUSTOMER_NOT_FOUND: { status: 404, message: 'The customer was not found.' },
  RESOURCE_VERSION_CONFLICT: { status: 409, message: 'The customer was modified by another request.' },
} as const);

export function customerError(code: keyof typeof CUSTOMER_ERRORS): ApiError {
  const { status, message } = CUSTOMER_ERRORS[code];
  return new ApiError(status, code, message);
}

/** Server-derived request context only (never a client-supplied free-form header). */
export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string;
}

export interface CustomerDto {
  readonly customerId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly documentType: string | null;
  readonly documentNumber: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerPage {
  readonly customers: CustomerDto[];
  readonly nextCursor: string | null;
}

interface CustomerRow extends CustomerValues {
  id: string;
  created_at: string;
  updated_at: string;
}

function toDto(row: CustomerRow): CustomerDto {
  return {
    customerId: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    email: row.email,
    documentType: row.document_type,
    documentNumber: row.document_number,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The DTO's columns; timestamps as exact UTC text with microseconds. */
function customerColumns(sql: postgres.Sql) {
  return sql`
    c.id, c.first_name, c.last_name, c.phone, c.email, c.document_type, c.document_number, c.notes,
    pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at,
    pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at
  `;
}

type AuditAction = 'customer.created' | 'customer.updated';

/**
 * Operación §5.2 CRM catalog: actor user from the TenantContext, success,
 * reason_code/before/after NULL, metadata holds persisted column NAMES only
 * (DOC_GAP-05), never values. Same transaction as the change.
 */
async function insertAudit(
  sql: postgres.ReservedSql,
  context: TenantRequestContext,
  meta: RequestMeta,
  action: AuditAction,
  customerId: string,
  metadata: postgres.JSONValue,
): Promise<void> {
  const { tenant } = context;
  await sql`
    INSERT INTO public.audit_logs (
      id, tenant_id, actor_type, actor_user_id, actor_membership_id,
      action, outcome, entity_type, entity_id, reason_code,
      before_json, after_json, metadata_json, request_id, ip_address
    ) VALUES (
      ${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
      ${action}, 'success', 'customer', ${customerId}, NULL,
      NULL, NULL, ${sql.json(metadata)}, ${meta.requestId}, ${meta.ipAddress}::inet
    )
  `;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export async function createCustomer(
  context: TenantRequestContext,
  input: CreateCustomerInput,
  meta: RequestMeta,
): Promise<CustomerDto> {
  const { sql, tenant } = context;
  const { values } = input;
  const [row] = await sql<CustomerRow[]>`
    INSERT INTO public.customers AS c (
      id, tenant_id, first_name, last_name, phone, email, document_type, document_number, notes
    ) VALUES (
      ${uuidV7()}, ${tenant.tenantId}, ${values.first_name}, ${values.last_name}, ${values.phone},
      ${values.email}, ${values.document_type}, ${values.document_number}, ${values.notes}
    )
    RETURNING ${customerColumns(sql)}
  `;
  if (!row) throw new Error('CUSTOMER_INSERT_FAILED');
  await insertAudit(sql, context, meta, 'customer.created', row.id, { fields: [...input.fields] });
  return toDto(row);
}

export async function updateCustomer(
  context: TenantRequestContext,
  customerId: string,
  input: PatchCustomerInput,
  meta: RequestMeta,
): Promise<CustomerDto> {
  const { sql, tenant } = context;
  const [current] = await sql<(CustomerRow & { version_matches: boolean })[]>`
    SELECT ${customerColumns(sql)},
      pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) = ${input.expectedUpdatedAt} AS version_matches
    FROM public.customers AS c
    WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${customerId}
    FOR NO KEY UPDATE OF c
  `;
  if (!current) throw customerError('CUSTOMER_NOT_FOUND');
  // OCC first: a stale token is a conflict even if the patch would be a no-op.
  if (!current.version_matches) throw customerError('RESOURCE_VERSION_CONFLICT');

  const merged: CustomerValues = { ...current, ...input.changes };
  if (!documentPairIsValid(merged)) throw requestValidationFailed();

  const changed: CustomerColumn[] = CUSTOMER_FIELDS
    .map(([, column]) => column)
    .filter((column) => Object.hasOwn(input.changes, column) && input.changes[column] !== current[column]);
  if (changed.length === 0) {
    const { version_matches: _ignored, ...unchanged } = current;
    return toDto(unchanged);
  }

  // Explicit `"column" = value` fragments: only columns in the 0018 UPDATE allowlist,
  // and no reliance on postgres.js keyword-sniffing for object helpers (`AS c` would
  // turn `sql(object)` into a select list).
  const assignments = changed
    .map((column) => sql`${sql(column)} = ${merged[column]}`)
    .reduce((list, assignment) => sql`${list}, ${assignment}`);
  const [row] = await sql<CustomerRow[]>`
    UPDATE public.customers AS c
    SET ${assignments},
      updated_at = GREATEST(pg_catalog.now(), c.updated_at + interval '1 microsecond')
    WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${customerId}
    RETURNING ${customerColumns(sql)}
  `;
  // The row is locked FOR NO KEY UPDATE: a miss here is a broken invariant, not a race.
  if (!row) throw new Error('CUSTOMER_UPDATE_FAILED');
  await insertAudit(sql, context, meta, 'customer.updated', row.id, { changed_fields: changed });
  return toDto(row);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getCustomer(context: TenantRequestContext, customerId: string): Promise<CustomerDto> {
  const { sql, tenant } = context;
  const [row] = await sql<CustomerRow[]>`
    SELECT ${customerColumns(sql)}
    FROM public.customers AS c
    WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${customerId}
  `;
  if (!row) throw customerError('CUSTOMER_NOT_FOUND');
  return toDto(row);
}

/**
 * Keyset by id DESC (UUIDv7 ~ creation order, id is the unique tiebreak).
 * `name` is a case-insensitive, accent-sensitive prefix of first_name OR
 * last_name: both sides lowercased under the ICU root collation (Unicode case
 * mapping; the database default could be "C", which only folds ASCII), then
 * `starts_with` — no LIKE, so `%` and `_` are literal. Only existing indexes
 * (ERD §17); the name prefix is intentionally unindexed in Sprint 2.
 */
export async function listCustomers(context: TenantRequestContext, query: ListCustomersQuery): Promise<CustomerPage> {
  const { sql, tenant } = context;
  const rows = await sql<CustomerRow[]>`
    SELECT ${customerColumns(sql)}
    FROM public.customers AS c
    WHERE c.tenant_id = ${tenant.tenantId}
      ${query.afterId === undefined ? sql`` : sql`AND c.id < ${query.afterId}::uuid`}
      ${query.phone === undefined ? sql`` : sql`AND c.phone = ${query.phone}`}
      ${query.documentNumber === undefined ? sql`` : sql`AND c.document_number = ${query.documentNumber}`}
      ${query.name === undefined ? sql`` : sql`AND (
        pg_catalog.starts_with(pg_catalog.lower(c.first_name COLLATE "und-x-icu"), pg_catalog.lower(${query.name}::text COLLATE "und-x-icu"))
        OR pg_catalog.starts_with(pg_catalog.lower(c.last_name COLLATE "und-x-icu"), pg_catalog.lower(${query.name}::text COLLATE "und-x-icu"))
      )`}
    ORDER BY c.id DESC
    LIMIT ${query.limit + 1}
  `;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    customers: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
  };
}
