import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import type { RequestMeta } from './service.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

interface LockedReception {
  id: string; vehicle_id: string; customer_id: string; mileage_km: number;
  status: string; closed_at: string | null; updated_at: string;
}
interface OrderRow {
  id: string; reception_id: string; vehicle_id: string; customer_id: string;
  order_number: string; status: string; opened_at: string; version: number;
}

function internalIntegrityError(): ApiError {
  return new ApiError(500, 'RECEPTION_ORDER_INTEGRITY_ERROR', 'The request could not be completed.');
}

function response(reception: LockedReception, order: OrderRow) {
  if (reception.status !== 'closed' || reception.closed_at === null
    || order.reception_id !== reception.id || order.vehicle_id !== reception.vehicle_id
    || order.customer_id !== reception.customer_id) throw internalIntegrityError();
  return {
    reception: { id: reception.id, status: 'closed' as const,
      closedAt: reception.closed_at, updatedAt: reception.updated_at },
    serviceOrder: { id: order.id, receptionId: order.reception_id,
      vehicleId: order.vehicle_id, customerId: order.customer_id,
      orderNumber: order.order_number, status: order.status, openedAt: order.opened_at,
      version: order.version },
  };
}

/** Runs entirely inside the request's bound TenantContext transaction. */
export async function closeReception(context: TenantRequestContext, receptionId: string,
  meta: RequestMeta) {
  const { sql, tenant } = context;
  const [reception] = await sql<LockedReception[]>`SELECT r.id, r.vehicle_id, r.customer_id,
      r.mileage_km, r.status,
      pg_catalog.to_char(r.closed_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS closed_at,
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at
    FROM public.receptions AS r
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${receptionId}
    FOR NO KEY UPDATE OF r`;
  if (!reception) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');

  // A retry observes the committed order after waiting for the reception lock.
  // It must not lock the vehicle, allocate a number, update, or audit.
  if (reception.status === 'closed') {
    const [order] = await sql<OrderRow[]>`SELECT o.id, o.reception_id, o.vehicle_id,
        o.customer_id, o.order_number::text AS order_number, o.status, o.version,
        pg_catalog.to_char(o.opened_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS opened_at
      FROM public.service_orders AS o
      WHERE o.tenant_id = ${tenant.tenantId} AND o.reception_id = ${reception.id}`;
    if (!order) throw internalIntegrityError();
    return response(reception, order);
  }
  if (reception.status !== 'open')
    throw new ApiError(409, 'RECEPTION_NOT_CLOSABLE', 'The reception cannot be closed.');

  // A captured signature is historical evidence. Media quarantine, consent
  // revocation, and owner transfer do not invalidate it at close time.
  const [signature] = await sql`SELECT id FROM public.signatures
    WHERE tenant_id = ${tenant.tenantId} AND reception_id = ${reception.id}`;
  if (!signature) throw new ApiError(409, 'RECEPTION_SIGNATURE_REQUIRED',
    'A reception signature is required.');

  // Global lock order for existing receptions: reception -> vehicle -> number.
  const [vehicle] = await sql<{ current_mileage_km: number | null }[]>`
    SELECT current_mileage_km FROM public.vehicles
    WHERE tenant_id = ${tenant.tenantId} AND id = ${reception.vehicle_id}
    FOR NO KEY UPDATE`;
  if (!vehicle) throw internalIntegrityError();
  if (vehicle.current_mileage_km !== null
    && reception.mileage_km < vehicle.current_mileage_km)
    throw new ApiError(409, 'RECEPTION_MILEAGE_CONFLICT',
      'The reception mileage conflicts with the current vehicle mileage.');

  // One transaction-level lock per tenant. Hash collisions only serialize
  // unrelated tenants; the tenant-scoped UNIQUE remains the final authority.
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'service_order_number:' || ${tenant.tenantId}::text, 0))`;

  if (vehicle.current_mileage_km !== reception.mileage_km) {
    await sql`UPDATE public.vehicles AS v SET current_mileage_km = ${reception.mileage_km},
        updated_at = GREATEST(pg_catalog.now(), v.updated_at + interval '1 microsecond')
      WHERE v.tenant_id = ${tenant.tenantId} AND v.id = ${reception.vehicle_id}`;
  }
  const [closed] = await sql<LockedReception[]>`UPDATE public.receptions AS r
    SET status = 'closed', closed_at = pg_catalog.now(),
      updated_at = GREATEST(pg_catalog.now(), r.updated_at + interval '1 microsecond')
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${reception.id} AND r.status = 'open'
    RETURNING r.id, r.vehicle_id, r.customer_id, r.mileage_km, r.status,
      pg_catalog.to_char(r.closed_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS closed_at,
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at`;
  if (!closed) throw internalIntegrityError();

  const [order] = await sql<OrderRow[]>`INSERT INTO public.service_orders AS o
    (id, tenant_id, reception_id, vehicle_id, customer_id, order_number,
      status, priority, opened_at, promised_at, closed_at, created_by_membership_id, version)
    SELECT ${uuidV7()}, ${tenant.tenantId}, ${closed.id}, ${closed.vehicle_id},
      ${closed.customer_id}, COALESCE(MAX(existing.order_number), 0) + 1,
      'reception', 'normal', pg_catalog.now(), NULL, NULL, ${tenant.membershipId}, 1
    FROM public.service_orders AS existing WHERE existing.tenant_id = ${tenant.tenantId}
    RETURNING o.id, o.reception_id, o.vehicle_id, o.customer_id,
      o.order_number::text AS order_number, o.status, o.version,
      pg_catalog.to_char(o.opened_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS opened_at`;
  if (!order) throw internalIntegrityError();

  await sql`INSERT INTO public.order_status_history
    (id, tenant_id, order_id, from_status, to_status, reason,
      changed_by_membership_id, changed_at, request_id)
    VALUES (${uuidV7()}, ${tenant.tenantId}, ${order.id}, NULL, 'reception', NULL,
      ${tenant.membershipId}, pg_catalog.now(), ${meta.requestId})`;
  await sql`INSERT INTO public.audit_logs
    (id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
      entity_type, entity_id, reason_code, before_json, after_json, metadata_json,
      request_id, ip_address)
    VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId},
      ${tenant.membershipId}, 'reception.closed', 'success', 'reception', ${closed.id},
      NULL, NULL, NULL,
      ${sql.json({ service_order_id: order.id, order_number: order.order_number })},
      ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return response(closed, order);
}

export function mapCloseDbError(error: unknown): ApiError | null {
  const db = error as { code?: string; constraint_name?: string; constraint?: string };
  const name = db.constraint_name ?? db.constraint;
  if (db.code === '23514' && name === 'receptions_signature_required')
    return new ApiError(409, 'RECEPTION_SIGNATURE_REQUIRED', 'A reception signature is required.');
  if (db.code === '23514' && name === 'receptions_vehicle_mileage_guard')
    return new ApiError(409, 'RECEPTION_MILEAGE_CONFLICT',
      'The reception mileage conflicts with the current vehicle mileage.');
  return null;
}
