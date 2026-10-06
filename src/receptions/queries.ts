import { ApiError, markResourceAuthorizationSatisfied, type TenantRequestContext } from '../api/app.js';
import { encodeReceptionCursor, type ListReceptionsQuery } from './queries-validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const notFound = () => new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');

interface ReceptionRow {
  id: string; vehicle_id: string; customer_id: string;
  appointment_id: string | null; location_id: string | null;
  received_by_membership_id: string; mileage_km: number; fuel_level_pct: number | null;
  customer_notes: string | null; advisor_notes: string | null;
  status: 'open' | 'closed' | 'cancelled'; received_at: string; closed_at: string | null;
  created_at: string; updated_at: string;
}
interface SignatureSummary { signatureId: string; documentVersion: string; signedAt: string; }
interface ServiceOrderSummary { id: string; orderNumber: string; status: string; }
interface ReceptionDetailRow extends ReceptionRow {
  signatures: SignatureSummary[]; service_orders: ServiceOrderSummary[];
}
interface CheckRow { id: string; code: string; label: string; status: string; notes: string | null; created_at: string; }
interface DamageRow { id: string; zone_code: string; damage_type: string; severity: string;
  description: string | null; created_at: string; }

const summary = (r: ReceptionRow) => ({ receptionId: r.id, vehicleId: r.vehicle_id,
  customerId: r.customer_id, mileageKm: r.mileage_km, fuelLevelPct: r.fuel_level_pct,
  status: r.status, receivedAt: r.received_at, closedAt: r.closed_at, updatedAt: r.updated_at });
const checkDto = (r: CheckRow) => ({ checkItemId: r.id, code: r.code, label: r.label,
  status: r.status, notes: r.notes, createdAt: r.created_at });
const damageDto = (r: DamageRow) => ({ damageId: r.id, zoneCode: r.zone_code,
  damageType: r.damage_type, severity: r.severity, description: r.description,
  createdAt: r.created_at });

export async function listReceptions(context: TenantRequestContext, query: ListReceptionsQuery) {
  const { sql, tenant } = context;
  const rows = await sql<ReceptionRow[]>`SELECT r.id, r.vehicle_id, r.customer_id,
      r.mileage_km, r.fuel_level_pct, r.status,
      pg_catalog.to_char(r.received_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS received_at,
      pg_catalog.to_char(r.closed_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS closed_at,
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at
    FROM public.receptions AS r
    WHERE r.tenant_id = ${tenant.tenantId}
      ${query.afterId === undefined ? sql`` : sql`AND r.id < ${query.afterId}::uuid`}
      ${query.status === undefined ? sql`` : sql`AND r.status = ${query.status}`}
      ${query.vehicleId === undefined ? sql`` : sql`AND r.vehicle_id = ${query.vehicleId}`}
      ${query.customerId === undefined ? sql`` : sql`AND r.customer_id = ${query.customerId}`}
    ORDER BY r.id DESC LIMIT ${query.limit + 1}`;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return { receptions: page.map(summary),
    nextCursor: rows.length > query.limit && last ? encodeReceptionCursor(last.id) : null };
}

export async function getReception(context: TenantRequestContext, receptionId: string) {
  const { sql, tenant, resourceAuthorization } = context;
  // The effective grant controls both the DB predicate and the response shape.
  const restricted = resourceAuthorization.grantedScopes.size > 0;
  if (restricted && !resourceAuthorization.grantedScopes.has('assigned')) throw notFound();
  const [row] = await sql<ReceptionDetailRow[]>`SELECT r.id, r.vehicle_id, r.customer_id,
      r.appointment_id, r.location_id, r.received_by_membership_id,
      r.mileage_km, r.fuel_level_pct, r.customer_notes, r.advisor_notes, r.status,
      pg_catalog.to_char(r.received_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS received_at,
      pg_catalog.to_char(r.closed_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS closed_at,
      pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at,
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS updated_at,
      COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'signatureId', s.id, 'documentVersion', s.document_version,
        'signedAt', pg_catalog.to_char(s.signed_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT})))
        FROM public.signatures AS s
        WHERE s.tenant_id = ${tenant.tenantId} AND s.reception_id = r.id), '[]'::jsonb) AS signatures,
      COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', o.id, 'orderNumber', o.order_number::text, 'status', o.status))
        FROM public.service_orders AS o
        WHERE o.tenant_id = ${tenant.tenantId} AND o.reception_id = r.id), '[]'::jsonb) AS service_orders
    FROM public.receptions AS r
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${receptionId}
      ${restricted ? sql`AND EXISTS (
        SELECT 1 FROM public.service_orders AS so
        JOIN public.assignments AS a ON a.tenant_id = so.tenant_id AND a.order_id = so.id
        WHERE so.tenant_id = ${tenant.tenantId} AND so.reception_id = r.id
          AND a.tenant_id = ${tenant.tenantId} AND a.membership_id = ${tenant.membershipId}
          AND a.released_at IS NULL
          AND a.assignment_type IN ('lead_technician', 'support_technician')
      )` : sql``}`;
  if (!row) throw notFound();
  // Reception and its evidence use one statement snapshot, including concurrent close.
  // Aggregate every matching row: uniqueness violations must not select an arbitrary row.
  if (row.signatures.length > 1 || row.service_orders.length > 1
    || (row.status === 'open' && row.service_orders.length !== 0)
    || (row.status === 'closed' && row.service_orders.length !== 1)
    || (row.status !== 'open' && row.status !== 'closed'))
    throw new Error('RECEPTION_READ_STATE_INCONSISTENT');
  const signature = row.signatures[0] ?? null;
  const serviceOrder = row.service_orders[0] ?? null;
  if (restricted) markResourceAuthorizationSatisfied(resourceAuthorization, 'assigned');
  const checks = await sql<CheckRow[]>`SELECT c.id, c.code, c.label, c.status, c.notes,
      pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at
    FROM public.reception_check_items AS c
    WHERE c.tenant_id = ${tenant.tenantId} AND c.reception_id = ${receptionId}
    ORDER BY c.code ASC, c.id ASC`;
  const damages = await sql<DamageRow[]>`SELECT d.id, d.zone_code, d.damage_type, d.severity, d.description,
      pg_catalog.to_char(d.created_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) AS created_at
    FROM public.vehicle_damages AS d
    WHERE d.tenant_id = ${tenant.tenantId} AND d.reception_id = ${receptionId}
    ORDER BY d.created_at ASC, d.id ASC`;
  const children = { signature, serviceOrder, checklist: checks.map(checkDto), damages: damages.map(damageDto) };
  if (restricted) return { receptionId: row.id, vehicleId: row.vehicle_id,
    mileageKm: row.mileage_km, fuelLevelPct: row.fuel_level_pct, status: row.status,
    receivedAt: row.received_at, closedAt: row.closed_at, ...children };
  return { receptionId: row.id, vehicleId: row.vehicle_id, customerId: row.customer_id,
    appointmentId: row.appointment_id, locationId: row.location_id,
    receivedByMembershipId: row.received_by_membership_id, mileageKm: row.mileage_km,
    fuelLevelPct: row.fuel_level_pct, customerNotes: row.customer_notes,
    advisorNotes: row.advisor_notes, status: row.status, receivedAt: row.received_at,
    closedAt: row.closed_at, createdAt: row.created_at, updatedAt: row.updated_at, ...children };
}
