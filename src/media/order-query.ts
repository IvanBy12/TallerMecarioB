import type { TenantRequestContext } from '../api/tenant-request.js';
import { markResourceAuthorizationSatisfied } from '../authz/resource-authorization.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { lockReader, eligibleGraph, assignedReception } from './assigned-authorization.js';
import { mediaDtoProjection, type MediaDto } from './associations.js';
import { MediaError, MediaLineageChangedError } from './errors.js';
import type { OrderMediaCursor, OrderMediaCursorContext, OrderMediaPosition } from './order-query-cursor.js';
import { ORDER_MEDIA_GRAPH_BUDGET, withOrderMediaLimits } from './order-query-limits.js';
import { lockMediaRetention, revalidateMediaReadGraph } from './retention.js';

export type OrderMediaSource = { type: 'reception'; receptionId: string }
  | { type: 'damage'; receptionId: string; damageId: string };
export type OrderMediaDto = MediaDto & { source: OrderMediaSource };
interface Candidate extends MediaDto { sourceRank: 0 | 1; sourceId: string; receptionId: string }
const missing = () => new MediaError(404, 'SERVICE_ORDER_NOT_FOUND', 'The service order was not found.');
const invalid = () => new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');
const rootIntegrity = () => new MediaError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
const tuple = (row: Candidate): OrderMediaPosition => [row.sourceRank, row.sourceId, row.sortOrder, row.mediaAssetId,
  row.purpose as OrderMediaPosition[4]];

async function candidates(context: TenantRequestContext, receptionId: string, limit: number, after?: OrderMediaPosition): Promise<Candidate[]> {
  return context.sql.unsafe<Candidate[]>(`SELECT ${mediaDtoProjection}, l.source_rank AS "sourceRank",
    l.source_id AS "sourceId", $2::uuid AS "receptionId"
    FROM (
      SELECT 0 AS source_rank, rm.reception_id AS source_id, rm.media_asset_id, rm.purpose, rm.sort_order, rm.tenant_id
      FROM public.reception_media rm WHERE rm.tenant_id=$1 AND rm.reception_id=$2
      UNION ALL
      SELECT 1, dm.damage_id, dm.media_asset_id, dm.purpose, dm.sort_order, dm.tenant_id
      FROM public.damage_media dm JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
      WHERE dm.tenant_id=$1 AND d.reception_id=$2
    ) l JOIN public.media_assets m ON m.tenant_id=l.tenant_id AND m.id=l.media_asset_id
    ${after ? 'WHERE (l.source_rank,l.source_id,l.sort_order,l.media_asset_id,l.purpose COLLATE "C") > ($4::int,$5::uuid,$6::int,$7::uuid,$8::text COLLATE "C")' : ''}
    ORDER BY l.source_rank,l.source_id,l.sort_order,l.media_asset_id,l.purpose COLLATE "C" LIMIT $3`,
  after ? [context.tenant.tenantId, receptionId, limit + 1, ...after] : [context.tenant.tenantId, receptionId, limit + 1]);
}
async function root(context: TenantRequestContext, orderId: string): Promise<string> {
  const [order] = await context.sql`SELECT o.reception_id, r.status
    FROM public.service_orders o LEFT JOIN public.receptions r ON r.tenant_id=o.tenant_id AND r.id=o.reception_id
    WHERE o.tenant_id=${context.tenant.tenantId} AND o.id=${orderId}`;
  if (!order) throw missing();
  if (order.status !== 'closed') throw rootIntegrity();
  return order.reception_id;
}
function parseQuery(value: unknown): { limit: number; cursor?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => !['limit','cursor'].includes(key))) throw invalid();
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit))) throw invalid();
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (limit > 100 || (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor.length || query.cursor.length > 2048))) throw invalid();
  return { limit, cursor: query.cursor as string | undefined };
}

/** No storage calls or mutations. One bounded window, full per-asset security
 * graph and one sorted batch of B05 locks; never one lock traversal per damage. */
export async function listOrderMedia(original: TenantRequestContext, orderIdInput: string, query: unknown,
  body: unknown, cursorCodec: OrderMediaCursor, deadline?: number): Promise<{ media: OrderMediaDto[]; nextCursor: string | null }> {
  return withOrderMediaLimits(original.sql, async sql => {
    const context = { ...original, sql };
    const tenantWide = context.resourceAuthorization.grantedScopes.size === 0;
    try { await lockReader(context, tenantWide); }
    catch (error) { if (error instanceof MediaError && error.statusCode === 404) throw missing(); throw error; }
    const orderId = parseCanonicalUuid(orderIdInput);
    if (!orderId) throw missing();
    const receptionId = await root(context, orderId);
    if (!tenantWide) {
      // Discovery only: no assignment row lock before B05's parent tiers.
      const [assignment] = await sql`SELECT 1 FROM public.assignments
        WHERE tenant_id=${context.tenant.tenantId} AND order_id=${orderId} AND membership_id=${context.tenant.membershipId}
          AND released_at IS NULL AND assignment_type IN ('lead_technician','support_technician') LIMIT 1`;
      if (!assignment) throw missing();
    }
    if (body !== undefined) throw invalid();
    const { limit, cursor } = parseQuery(query);
    const cursorContext: OrderMediaCursorContext = { tenantId: context.tenant.tenantId, orderId,
      userId: context.tenant.userId, membershipId: context.tenant.membershipId, limit };
    const after = cursor === undefined ? undefined : cursorCodec.decode(cursor, cursorContext);
    const discovered = await candidates(context, receptionId, limit, after);
    const window = discovered.slice(0, limit);
    const ids = [...new Set(window.map(row => row.mediaAssetId))].sort();
    const proof = await lockMediaRetention(sql, context.tenant.tenantId, ids,
      { receptionIds: [receptionId], orderIds: [orderId] }, ORDER_MEDIA_GRAPH_BUDGET);
    if (await root(context, orderId) !== receptionId) throw rootIntegrity();
    if (!tenantWide && !await assignedReception(context, receptionId)) throw missing();
    const current = await candidates(context, receptionId, limit, after);
    // A shifted candidate window is never interpreted using the wrong lock set.
    if (JSON.stringify(current.slice(0, limit).map(tuple)) !== JSON.stringify(window.map(tuple))) throw new MediaLineageChangedError();
    const media: OrderMediaDto[] = [];
    const seen = new Set<string>();
    for (const row of current.slice(0, limit)) {
      if (seen.has(row.mediaAssetId) || !await eligibleGraph(context, row.mediaAssetId, tenantWide)) continue;
      seen.add(row.mediaAssetId);
      const { sourceRank, sourceId, receptionId: origin, ...dto } = row;
      // A contradictory multi-target graph is denied by B07's binding consensus;
      // the tenant-wide legacy exception additionally requires exactly one link.
      media.push({ ...dto, source: sourceRank === 0 ? { type: 'reception', receptionId: origin }
        : { type: 'damage', receptionId: origin, damageId: sourceId } });
    }
    await revalidateMediaReadGraph(proof);
    if (!tenantWide) markResourceAuthorizationSatisfied(context.resourceAuthorization, 'assigned');
    const last = window.at(-1);
    return { media, nextCursor: current.length > limit && last ? cursorCodec.encode(cursorContext, tuple(last)) : null };
  }, deadline);
}
