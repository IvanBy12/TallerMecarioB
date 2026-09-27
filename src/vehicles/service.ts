/** S2-05 Vehicles API. All SQL uses the request's reserved TenantContext transaction. */
import type postgres from 'postgres';
import { ApiError, markResourceAuthorizationSatisfied, type TenantRequestContext } from '../api/app.js';
import { requireTenantPermission } from '../authz/authorize.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { VEHICLE_FIELDS, encodeCursor, type CreateVehicleInput, type ListVehiclesQuery,
  type PatchVehicleInput, type VehicleColumn, type VehicleValues } from './validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
export interface RequestMeta { requestId: string; ipAddress: string; }
export interface VehicleDto {
  vehicleId: string; plate: string; vehicleType: string; brand: string; model: string;
  modelYear: number | null; color: string | null; vin: string | null; engineNumber: string | null;
  currentMileageKm: number | null; createdAt: string; updatedAt: string;
}
export type VehicleTechDto = Pick<VehicleDto, 'vehicleId' | 'plate' | 'vehicleType' | 'brand' | 'model' | 'modelYear' | 'color'>;
export interface OwnershipDto {
  ownershipId: string; vehicleId: string; customerId: string; relationshipType: 'owner';
  isPrimary: true; validFrom: string; validTo: null;
}
interface VehicleRow extends VehicleValues {
  id: string; current_mileage_km: number | null; created_at: string; updated_at: string;
}
const notFound = (entity: 'VEHICLE' | 'CUSTOMER') => new ApiError(404, `${entity}_NOT_FOUND`,
  `The ${entity.toLowerCase()} was not found.`);
const versionConflict = () => new ApiError(409, 'RESOURCE_VERSION_CONFLICT', 'The vehicle was modified by another request.');
function toDto(row: VehicleRow): VehicleDto {
  return { vehicleId: row.id, plate: row.plate, vehicleType: row.vehicle_type, brand: row.brand,
    model: row.model, modelYear: row.model_year, color: row.color, vin: row.vin,
    engineNumber: row.engine_number, currentMileageKm: row.current_mileage_km,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function toTechDto(row: VehicleRow): VehicleTechDto {
  return { vehicleId: row.id, plate: row.plate, vehicleType: row.vehicle_type, brand: row.brand,
    model: row.model, modelYear: row.model_year, color: row.color };
}
function columns(sql: postgres.Sql) {
  return sql`v.id, v.plate, v.vehicle_type, v.brand, v.model, v.model_year, v.color, v.vin,
    v.engine_number, v.current_mileage_km,
    pg_catalog.to_char(v.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at,
    pg_catalog.to_char(v.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at`;
}
async function audit(sql: postgres.ReservedSql, context: TenantRequestContext, meta: RequestMeta,
  action: 'vehicle.created' | 'vehicle.owner_changed' | 'vehicle.updated', vehicleId: string,
  metadata: postgres.JSONValue, after: postgres.JSONValue | null = null): Promise<void> {
  const { tenant } = context;
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    ${action}, 'success', 'vehicle', ${vehicleId}, NULL, NULL,
    ${after === null ? sql`NULL` : sql`${sql.json(after)}`}, ${sql.json(metadata)},
    ${meta.requestId}, ${meta.ipAddress}::inet)`;
}
/** Maps only known CRM constraints; unexpected PostgreSQL defects remain sanitized 500s. */
export function mapVehicleDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23505' && name === 'vehicles_tenant_plate_key')
    return new ApiError(409, 'VEHICLE_PLATE_ALREADY_EXISTS', 'The plate is already registered.');
  if (db.code === '23503' && name === 'vehicle_owners_customer_fk') return notFound('CUSTOMER');
  if (db.code === '23503' && name === 'vehicle_owners_vehicle_fk') return notFound('VEHICLE');
  if (db.code === '23514' && ['vehicles_plate_normalized_check', 'vehicles_plate_format_check'].includes(name ?? ''))
    return new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
  return null;
}
export async function createVehicle(context: TenantRequestContext, input: CreateVehicleInput,
  meta: RequestMeta): Promise<{ vehicle: VehicleDto; ownership: OwnershipDto }> {
  requireTenantPermission(context.tenant, 'vehicle_owners.manage');
  const { sql, tenant } = context;
  const [customer] = await sql`SELECT id FROM public.customers
    WHERE tenant_id = ${tenant.tenantId} AND id = ${input.customerId}`;
  if (!customer) throw notFound('CUSTOMER');
  const v = input.values;
  const [vehicle] = await sql<VehicleRow[]>`INSERT INTO public.vehicles AS v
    (id, tenant_id, plate, vehicle_type, brand, model, model_year, color, vin, engine_number)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${v.plate}, ${v.vehicle_type}, ${v.brand},
      ${v.model}, ${v.model_year}, ${v.color}, ${v.vin}, ${v.engine_number})
    RETURNING ${columns(sql)}`;
  if (!vehicle) throw new Error('VEHICLE_INSERT_FAILED');
  const [owner] = await sql<{ id: string; valid_from: string }[]>`
    INSERT INTO public.vehicle_owners (id, tenant_id, vehicle_id, customer_id,
      relationship_type, is_primary, valid_from)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${vehicle.id}, ${input.customerId},
      'owner', true, pg_catalog.clock_timestamp())
    RETURNING id, pg_catalog.to_char(valid_from AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS valid_from`;
  if (!owner) throw new Error('VEHICLE_OWNER_INSERT_FAILED');
  await audit(sql, context, meta, 'vehicle.created', vehicle.id,
    { ownership_id: owner.id, customer_id: input.customerId });
  await audit(sql, context, meta, 'vehicle.owner_changed', vehicle.id, { command: 'create' },
    { ownership_id: owner.id, customer_id: input.customerId });
  return { vehicle: toDto(vehicle), ownership: { ownershipId: owner.id, vehicleId: vehicle.id,
    customerId: input.customerId, relationshipType: 'owner', isPrimary: true,
    validFrom: owner.valid_from, validTo: null } };
}
export async function getVehicle(context: TenantRequestContext, vehicleId: string): Promise<VehicleDto | VehicleTechDto> {
  const { sql, tenant, resourceAuthorization } = context;
  const assigned = resourceAuthorization.grantedScopes.size > 0;
  if (assigned && !resourceAuthorization.grantedScopes.has('assigned')) throw notFound('VEHICLE');
  const [row] = await sql<VehicleRow[]>`SELECT ${columns(sql)} FROM public.vehicles AS v
    WHERE v.tenant_id = ${tenant.tenantId} AND v.id = ${vehicleId}
      ${assigned ? sql`AND EXISTS (
        SELECT 1 FROM public.service_orders AS so
        JOIN public.assignments AS a ON a.tenant_id = so.tenant_id AND a.order_id = so.id
        WHERE so.tenant_id = ${tenant.tenantId} AND so.vehicle_id = v.id
          AND a.membership_id = ${tenant.membershipId} AND a.released_at IS NULL
          AND a.assignment_type IN ('lead_technician', 'support_technician')
      )` : sql``}`;
  if (!row) throw notFound('VEHICLE');
  if (assigned) markResourceAuthorizationSatisfied(resourceAuthorization, 'assigned');
  return assigned ? toTechDto(row) : toDto(row);
}
export async function listVehicles(context: TenantRequestContext, query: ListVehiclesQuery): Promise<{
  vehicles: VehicleDto[]; nextCursor: string | null;
}> {
  const { sql, tenant } = context;
  const rows = await sql<VehicleRow[]>`SELECT ${columns(sql)} FROM public.vehicles AS v
    WHERE v.tenant_id = ${tenant.tenantId}
      ${query.afterId === undefined ? sql`` : sql`AND v.id < ${query.afterId}::uuid`}
      ${query.plate === undefined ? sql`` : sql`AND v.plate = ${query.plate}`}
    ORDER BY v.id DESC LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return { vehicles: page.map(toDto), nextCursor: rows.length > query.limit && last ? encodeCursor(last.id) : null };
}
export async function updateVehicle(context: TenantRequestContext, vehicleId: string,
  input: PatchVehicleInput, meta: RequestMeta): Promise<VehicleDto> {
  const { sql, tenant } = context;
  const [current] = await sql<(VehicleRow & { version_matches: boolean })[]>`
    SELECT ${columns(sql)},
      pg_catalog.to_char(v.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) = ${input.expectedUpdatedAt} AS version_matches
    FROM public.vehicles AS v WHERE v.tenant_id = ${tenant.tenantId} AND v.id = ${vehicleId}
    FOR NO KEY UPDATE OF v`;
  if (!current) throw notFound('VEHICLE');
  if (!current.version_matches) throw versionConflict();
  const merged: VehicleValues = { ...current, ...input.changes };
  const changed: VehicleColumn[] = VEHICLE_FIELDS.map(([, column]) => column)
    .filter((column) => Object.hasOwn(input.changes, column) && input.changes[column] !== current[column]);
  if (changed.length === 0) return toDto(current);
  const assignments = changed.map((column) => sql`${sql(column)} = ${merged[column]}`)
    .reduce((list, assignment) => sql`${list}, ${assignment}`);
  const [row] = await sql<VehicleRow[]>`UPDATE public.vehicles AS v SET ${assignments},
      updated_at = GREATEST(pg_catalog.now(), v.updated_at + interval '1 microsecond')
    WHERE v.tenant_id = ${tenant.tenantId} AND v.id = ${vehicleId}
      AND pg_catalog.to_char(v.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) = ${input.expectedUpdatedAt}
    RETURNING ${columns(sql)}`;
  if (!row) throw versionConflict();
  await audit(sql, context, meta, 'vehicle.updated', row.id, { changed_fields: changed });
  return toDto(row);
}
