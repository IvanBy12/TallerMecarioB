import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { EDITABLE_FIELDS, type CreateReceptionInput, type EditableColumn,
  type EditableValues, type PatchReceptionInput } from './validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
export interface RequestMeta { requestId: string; ipAddress: string; }
export interface ReceptionDto {
  receptionId: string; vehicleId: string; customerId: string;
  appointmentId: string | null; locationId: string | null;
  receivedByMembershipId: string; mileageKm: number; fuelLevelPct: number | null;
  customerNotes: string | null; advisorNotes: string | null; status: 'open';
  receivedAt: string; closedAt: null; createdAt: string; updatedAt: string;
}
interface ReceptionRow {
  id: string; vehicle_id: string; customer_id: string;
  appointment_id: string | null; location_id: string | null;
  received_by_membership_id: string; mileage_km: number; fuel_level_pct: number | null;
  customer_notes: string | null; advisor_notes: string | null; status: 'open' | 'closed' | 'cancelled';
  received_at: string; closed_at: string | null; created_at: string; updated_at: string;
}
const notFound = (entity: 'VEHICLE' | 'CUSTOMER' | 'APPOINTMENT' | 'LOCATION') =>
  new ApiError(404, `${entity}_NOT_FOUND`, `The ${entity.toLowerCase()} was not found.`);
const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
// Reuses the published S2-06 code: the customer is not the current owner.
const ownershipConflict = () => new ApiError(409, 'VEHICLE_OWNERSHIP_CONFLICT', 'The vehicle ownership changed.');
// Absent and foreign consents are indistinguishable (RLS hides foreign rows).
const consentNotFound = () => new ApiError(404, 'PRIVACY_CONSENT_NOT_FOUND', 'The privacy consent was not found.');
// Wrong customer/purpose, revoked or newer than the reception: one stable code.
const consentNotEligible = () => new ApiError(409, 'PRIVACY_CONSENT_NOT_ELIGIBLE',
  'The privacy consent cannot cover this reception.');

function columns(sql: postgres.Sql) {
  return sql`r.id, r.vehicle_id, r.customer_id, r.appointment_id, r.location_id,
    r.received_by_membership_id, r.mileage_km, r.fuel_level_pct, r.customer_notes,
    r.advisor_notes, r.status, r.closed_at,
    pg_catalog.to_char(r.received_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS received_at,
    pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at,
    pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at`;
}
function toDto(row: ReceptionRow): ReceptionDto {
  if (row.status !== 'open' || row.closed_at !== null) throw new Error('RECEPTION_DTO_NOT_OPEN');
  return { receptionId: row.id, vehicleId: row.vehicle_id, customerId: row.customer_id,
    appointmentId: row.appointment_id, locationId: row.location_id,
    receivedByMembershipId: row.received_by_membership_id, mileageKm: row.mileage_km,
    fuelLevelPct: row.fuel_level_pct, customerNotes: row.customer_notes,
    advisorNotes: row.advisor_notes, status: row.status, receivedAt: row.received_at,
    closedAt: row.closed_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function mapReceptionDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23505' && name === 'receptions_one_open_vehicle_uq')
    return new ApiError(409, 'RECEPTION_ALREADY_OPEN', 'An open reception already exists for this vehicle.');
  if (db.code === '23503') {
    if (name === 'receptions_vehicle_fk') return notFound('VEHICLE');
    if (name === 'receptions_customer_fk') return notFound('CUSTOMER');
    if (name === 'receptions_appointment_fk') return notFound('APPOINTMENT');
    if (name === 'receptions_location_fk') return notFound('LOCATION');
    if (name === 'receptions_privacy_consent_fk') return consentNotFound();
  }
  if (db.code === '23514' && name === 'receptions_current_owner_guard') return ownershipConflict();
  if (db.code === '23514' && name === 'receptions_privacy_consent_guard') return consentNotEligible();
  if (db.code === '23514' && name === 'receptions_vehicle_mileage_guard')
    return new ApiError(409, 'RECEPTION_MILEAGE_CONFLICT',
      'The reception mileage conflicts with the current vehicle mileage.');
  if (db.code === '23514' && [
    'receptions_mileage_check', 'receptions_fuel_check',
  ].includes(name ?? '')) return invalid();
  return null;
}

export async function createReception(context: TenantRequestContext, input: CreateReceptionInput,
  meta: RequestMeta): Promise<ReceptionDto> {
  const { sql, tenant } = context;
  // S3-04.5 lock graph: vehicle FOR NO KEY UPDATE (the transferOwner gate)
  // -> current primary owner -> consent FOR SHARE -> INSERT -> audit. Two
  // creates for one vehicle serialize here; receptions_one_open_vehicle_uq
  // still decides RECEPTION_ALREADY_OPEN. These checks give clean errors; the
  // 0020 INSERT triggers repeat them (reentrant locks) as the authority.
  const [vehicle] = await sql`SELECT id FROM public.vehicles
    WHERE tenant_id = ${tenant.tenantId} AND id = ${input.vehicleId} FOR NO KEY UPDATE`;
  if (!vehicle) throw notFound('VEHICLE');
  // Scoped reads give the same 404 for absent and foreign references. The FKs
  // remain the authority if a reference is deleted between these reads and INSERT.
  for (const [table, id, entity] of [
    ['customers', input.customerId, 'CUSTOMER'],
    ['appointments', input.appointmentId, 'APPOINTMENT'], ['workshop_locations', input.locationId, 'LOCATION'],
  ] as const) {
    if (id === null) continue;
    const [row] = await sql`SELECT id FROM public.${sql(table)}
      WHERE tenant_id = ${tenant.tenantId} AND id = ${id}`;
    if (!row) throw notFound(entity);
  }
  // D-PRIV-03: only the current primary owner can deliver the vehicle. The
  // response never reveals who the owner is.
  const [owner] = await sql<{ customer_id: string }[]>`SELECT customer_id FROM public.vehicle_owners
    WHERE tenant_id = ${tenant.tenantId} AND vehicle_id = ${input.vehicleId}
      AND is_primary = true AND valid_to IS NULL`;
  if (owner?.customer_id !== input.customerId) throw ownershipConflict();
  // RECEPTION-CONSENT-01: FOR SHARE conflicts with a concurrent revoke UPDATE.
  // now() equals the reception's created_at default in this transaction.
  const [consent] = await sql<{ eligible: boolean }[]>`SELECT (c.customer_id = ${input.customerId}
      AND c.purpose_code = 'service_provision' AND c.status = 'granted' AND c.revoked_at IS NULL
      AND c.created_at <= pg_catalog.now()) AS eligible
    FROM public.privacy_consents AS c
    WHERE c.tenant_id = ${tenant.tenantId} AND c.id = ${input.privacyConsentId} FOR SHARE OF c`;
  if (!consent) throw consentNotFound();
  if (!consent.eligible) throw consentNotEligible();
  const [row] = await sql<ReceptionRow[]>`INSERT INTO public.receptions AS r
    (id, tenant_id, vehicle_id, customer_id, privacy_consent_id, appointment_id, location_id,
      received_by_membership_id, mileage_km, fuel_level_pct, customer_notes, advisor_notes)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${input.vehicleId}, ${input.customerId},
      ${input.privacyConsentId}, ${input.appointmentId}, ${input.locationId}, ${tenant.membershipId},
      ${input.mileageKm}, ${input.fuelLevelPct}, ${input.customerNotes}, ${input.advisorNotes})
    RETURNING ${columns(sql)}`;
  if (!row) throw new Error('RECEPTION_INSERT_FAILED');
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    'reception.created', 'success', 'reception', ${row.id}, NULL, NULL, NULL,
    ${sql.json({ fields: input.fields, privacy_consent_id: input.privacyConsentId })},
    ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return toDto(row);
}

export async function updateReception(context: TenantRequestContext, receptionId: string,
  input: PatchReceptionInput, meta: RequestMeta): Promise<ReceptionDto> {
  const { sql, tenant } = context;
  // Match CRM's exact PostgreSQL text token: never parse it as a JS Date.
  // Check open + OCC under the row lock, before deciding a normalized no-op.
  const [current] = await sql<(ReceptionRow & { version_matches: boolean })[]>`
    SELECT ${columns(sql)},
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) =
        ${input.expectedUpdatedAt} AS version_matches
    FROM public.receptions AS r
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${receptionId}
    FOR NO KEY UPDATE OF r`;
  if (!current) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
  if (current.status !== 'open')
    throw new ApiError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  if (!current.version_matches)
    throw new ApiError(409, 'RESOURCE_VERSION_CONFLICT', 'The reception was modified by another request.');

  const changed: EditableColumn[] = EDITABLE_FIELDS.map(([, column]) => column)
    .filter((column) => Object.hasOwn(input.changes, column)
      && input.changes[column] !== current[column]);
  if (changed.length === 0) return toDto(current);

  // The reception row is locked first. The 0019 lifecycle trigger subsequently
  // locks its vehicle (even when mileage is unchanged), preserving close's order.
  for (const [column, table, entity] of [
    ['appointment_id', 'appointments', 'APPOINTMENT'],
    ['location_id', 'workshop_locations', 'LOCATION'],
  ] as const) {
    if (!changed.includes(column)) continue;
    const id = input.changes[column];
    if (id == null) continue;
    const [reference] = await sql`SELECT id FROM public.${sql(table)}
      WHERE tenant_id = ${tenant.tenantId} AND id = ${id}`;
    if (!reference) throw notFound(entity);
  }

  const merged: EditableValues = { ...current, ...input.changes };
  const assignments = changed.map((column) => sql`${sql(column)} = ${merged[column]}`)
    .reduce((list, assignment) => sql`${list}, ${assignment}`);
  const [row] = await sql<ReceptionRow[]>`UPDATE public.receptions AS r SET ${assignments},
      updated_at = GREATEST(pg_catalog.now(), r.updated_at + interval '1 microsecond')
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${receptionId}
      AND r.status = 'open'
      AND pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) =
        ${input.expectedUpdatedAt}
    RETURNING ${columns(sql)}`;
  if (!row) throw new Error('RECEPTION_LOCKED_UPDATE_FAILED');
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    'reception.updated', 'success', 'reception', ${row.id}, NULL, NULL, NULL,
    ${sql.json({ changed_fields: changed })}, ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return toDto(row);
}
