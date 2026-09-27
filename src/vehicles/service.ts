/** S2-05 Vehicles API. All SQL uses the request's reserved TenantContext transaction. */
import type postgres from 'postgres';
import { ApiError, markResourceAuthorizationSatisfied, type TenantRequestContext } from '../api/app.js';
import { requireTenantPermission } from '../authz/authorize.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { VEHICLE_FIELDS, encodeCursor, type CreateVehicleInput, type ListVehiclesQuery,
  type PatchVehicleInput, type TransferOwnerInput, type VehicleColumn, type VehicleValues } from './validation.js';

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
export interface OwnerHistoryItemDto {
  ownershipId: string; customerId: string; customer: { firstName: string; lastName: string };
  relationshipType: string; isPrimary: boolean; validFrom: string; validTo: string | null;
}
interface OwnerRow {
  id: string; vehicle_id: string; customer_id: string; relationship_type: 'owner';
  is_primary: true; valid_from: string; valid_to: string | null;
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
  metadata: postgres.JSONValue, after: postgres.JSONValue | null = null,
  before: postgres.JSONValue | null = null): Promise<void> {
  const { tenant } = context;
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
    request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    ${action}, 'success', 'vehicle', ${vehicleId}, NULL,
    ${before === null ? sql`NULL` : sql`${sql.json(before)}`},
    ${after === null ? sql`NULL` : sql`${sql.json(after)}`}, ${sql.json(metadata)},
    ${meta.requestId}, ${meta.ipAddress}::inet)`;
}
/** Maps only known CRM constraints; unexpected PostgreSQL defects remain sanitized 500s. */
export function mapVehicleDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23505' && name === 'vehicles_tenant_plate_key')
    return new ApiError(409, 'VEHICLE_PLATE_ALREADY_EXISTS', 'The plate is already registered.');
  if (db.code === '23505' && name === 'vehicle_owners_one_primary_uq')
    return new ApiError(409, 'VEHICLE_OWNERSHIP_CONFLICT', 'The vehicle ownership changed.');
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

const ownershipConflict = () => new ApiError(409, 'VEHICLE_OWNERSHIP_CONFLICT', 'The vehicle ownership changed.');
const ownerColumns = (sql: postgres.Sql) => sql`o.id, o.vehicle_id, o.customer_id,
  o.relationship_type, o.is_primary,
  pg_catalog.to_char(o.valid_from AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS valid_from,
  CASE WHEN o.valid_to IS NULL THEN NULL ELSE
    pg_catalog.to_char(o.valid_to AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) END AS valid_to`;
const ownershipDto = (row: OwnerRow): OwnershipDto => ({
  ownershipId: row.id, vehicleId: row.vehicle_id, customerId: row.customer_id,
  relationshipType: row.relationship_type, isPrimary: row.is_primary,
  validFrom: row.valid_from, validTo: null,
});

export async function listOwnerHistory(context: TenantRequestContext, vehicleId: string): Promise<OwnerHistoryItemDto[]> {
  requireTenantPermission(context.tenant, 'vehicles.read');
  const { sql, tenant } = context;
  const [vehicle] = await sql`SELECT id FROM public.vehicles
    WHERE tenant_id = ${tenant.tenantId} AND id = ${vehicleId}`;
  if (!vehicle) throw notFound('VEHICLE');
  const rows = await sql<(OwnerRow & { first_name: string; last_name: string })[]>`
    SELECT ${ownerColumns(sql)}, c.first_name, c.last_name
    FROM public.vehicle_owners AS o
    JOIN public.customers AS c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
    WHERE o.tenant_id = ${tenant.tenantId} AND o.vehicle_id = ${vehicleId}
    ORDER BY o.valid_from DESC, o.id DESC LIMIT 200`;
  return rows.map((row) => ({ ownershipId: row.id, customerId: row.customer_id,
    customer: { firstName: row.first_name, lastName: row.last_name },
    relationshipType: row.relationship_type, isPrimary: row.is_primary,
    validFrom: row.valid_from, validTo: row.valid_to }));
}

export async function transferOwner(context: TenantRequestContext, vehicleId: string,
  input: TransferOwnerInput, meta: RequestMeta): Promise<{ ownership: OwnershipDto; changed: boolean }> {
  const { sql, tenant } = context;
  const [vehicle] = await sql`SELECT id FROM public.vehicles
    WHERE tenant_id = ${tenant.tenantId} AND id = ${vehicleId} FOR NO KEY UPDATE`;
  if (!vehicle) throw notFound('VEHICLE');
  const customerId = parseCanonicalUuid(input.customerId);
  if (!customerId) throw notFound('CUSTOMER');
  const [customer] = await sql`SELECT id FROM public.customers
    WHERE tenant_id = ${tenant.tenantId} AND id = ${customerId}`;
  if (!customer) throw notFound('CUSTOMER');
  const [current] = await sql<OwnerRow[]>`SELECT ${ownerColumns(sql)} FROM public.vehicle_owners AS o
    WHERE o.tenant_id = ${tenant.tenantId} AND o.vehicle_id = ${vehicleId}
      AND o.is_primary = true AND o.valid_to IS NULL`;
  if (current?.customer_id === customerId) return { ownership: ownershipDto(current), changed: false };
  if ((current?.id ?? null) !== input.expectedCurrentOwnershipId) throw ownershipConflict();
  const [time] = await sql<{ t: string }[]>`SELECT pg_catalog.to_char(
    pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS t`;
  if (!time) throw new Error('VEHICLE_OWNER_TIMESTAMP_FAILED');
  if (current) {
    const closed = await sql`UPDATE public.vehicle_owners SET valid_to = ${time.t}::text::timestamptz
      WHERE tenant_id = ${tenant.tenantId} AND id = ${current.id} AND valid_to IS NULL RETURNING id`;
    if (closed.length !== 1) throw ownershipConflict();
  }
  const [owner] = await sql<OwnerRow[]>`INSERT INTO public.vehicle_owners AS o
    (id, tenant_id, vehicle_id, customer_id, relationship_type, is_primary, valid_from)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${vehicleId}, ${customerId}, 'owner', true, ${time.t}::text::timestamptz)
    RETURNING ${ownerColumns(sql)}`;
  if (!owner) throw new Error('VEHICLE_OWNER_INSERT_FAILED');
  await audit(sql, context, meta, 'vehicle.owner_changed', vehicleId, { command: 'transfer' },
    { ownership_id: owner.id, customer_id: customerId },
    current ? { ownership_id: current.id, customer_id: current.customer_id } : null);
  return { ownership: ownershipDto(owner), changed: true };
}
