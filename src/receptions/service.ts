import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import type { CreateReceptionInput } from './validation.js';

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
  customer_notes: string | null; advisor_notes: string | null; status: 'open';
  received_at: string; closed_at: null; created_at: string; updated_at: string;
}
const notFound = (entity: 'VEHICLE' | 'CUSTOMER' | 'APPOINTMENT' | 'LOCATION') =>
  new ApiError(404, `${entity}_NOT_FOUND`, `The ${entity.toLowerCase()} was not found.`);
const invalid = () => new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');

function columns(sql: postgres.Sql) {
  return sql`r.id, r.vehicle_id, r.customer_id, r.appointment_id, r.location_id,
    r.received_by_membership_id, r.mileage_km, r.fuel_level_pct, r.customer_notes,
    r.advisor_notes, r.status, r.closed_at,
    pg_catalog.to_char(r.received_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS received_at,
    pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at,
    pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at`;
}
function toDto(row: ReceptionRow): ReceptionDto {
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
  }
  if (db.code === '23514' && [
    'receptions_mileage_check', 'receptions_fuel_check', 'receptions_vehicle_mileage_guard',
  ].includes(name ?? '')) return invalid();
  return null;
}

export async function createReception(context: TenantRequestContext, input: CreateReceptionInput,
  meta: RequestMeta): Promise<ReceptionDto> {
  const { sql, tenant } = context;
  // Scoped reads give the same 404 for absent and foreign references. The FKs
  // remain the authority if a reference is deleted between these reads and INSERT.
  for (const [table, id, entity] of [
    ['vehicles', input.vehicleId, 'VEHICLE'], ['customers', input.customerId, 'CUSTOMER'],
    ['appointments', input.appointmentId, 'APPOINTMENT'], ['workshop_locations', input.locationId, 'LOCATION'],
  ] as const) {
    if (id === null) continue;
    const [row] = await sql`SELECT id FROM public.${sql(table)}
      WHERE tenant_id = ${tenant.tenantId} AND id = ${id}`;
    if (!row) throw notFound(entity);
  }
  const [row] = await sql<ReceptionRow[]>`INSERT INTO public.receptions AS r
    (id, tenant_id, vehicle_id, customer_id, appointment_id, location_id,
      received_by_membership_id, mileage_km, fuel_level_pct, customer_notes, advisor_notes)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${input.vehicleId}, ${input.customerId},
      ${input.appointmentId}, ${input.locationId}, ${tenant.membershipId}, ${input.mileageKm},
      ${input.fuelLevelPct}, ${input.customerNotes}, ${input.advisorNotes})
    RETURNING ${columns(sql)}`;
  if (!row) throw new Error('RECEPTION_INSERT_FAILED');
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    'reception.created', 'success', 'reception', ${row.id}, NULL, NULL, NULL,
    ${sql.json({ fields: input.fields })}, ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return toDto(row);
}
