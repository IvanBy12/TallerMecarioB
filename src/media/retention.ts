import type postgres from 'postgres';
import { MediaError, MediaLineageChangedError } from './errors.js';
import { uuidV7 } from '../platform/uuid-v7.js';

// v1 already denotes the canonical product defaults. No historical relabeling.
export const MEDIA_RETENTION_POLICY_VERSION = 'v1';
export type RetentionBlocker = 'ACTIVE_UPLOAD' | 'DOMAIN_LINK_NONTERMINAL'
  | 'CLOCK_NOT_STARTED' | 'UNRESOLVED_PROTECTION' | 'LEGAL_HOLD' | 'LIFECYCLE_UNAVAILABLE';
export interface RetentionSource {
  kind: string;
  id: string;
  knownRetentionUntil: string | null;
  blocker: RetentionBlocker | null;
}
export interface RetentionDecision {
  knownRetentionUntil: string | null;
  blocksAutomaticPurge: boolean;
  blockers: RetentionBlocker[];
  sources: RetentionSource[];
  policyVersion: string;
  eligibility: 'ELIGIBLE_AFTER_DATE' | 'NOT_ELIGIBLE_RETENTION_NOT_EXPIRED'
    | 'NOT_ELIGIBLE_ACTIVE_UPLOAD' | 'NOT_ELIGIBLE_DOMAIN_LINK_NONTERMINAL'
    | 'NOT_ELIGIBLE_CLOCK_NOT_STARTED' | 'NOT_ELIGIBLE_LEGAL_HOLD' | 'NOT_ELIGIBLE_UNRESOLVED_PROTECTION'
    | 'NOT_ELIGIBLE_LIFECYCLE_UNAVAILABLE';
}
interface Link {
  kind: string; id: string; reception_id: string | null; damage_id: string | null;
  order_id: string | null; item_id: string | null;
}
const missing = () => new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'The media asset was not found.');
const retry = () => new MediaLineageChangedError();
const iso = (value: string) => `to_char((${value}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Complete B01/B04 inventory. Every join includes tenant identity. Discovery
 * never takes a child lock. Binding is authorization evidence, not association. */
async function links(sql: postgres.ReservedSql, tenantId: string, ids: string[], maxRows?: number): Promise<Link[]> {
  const query = `
    SELECT 'reception_media' kind, rm.reception_id id, r.id reception_id, NULL::uuid damage_id,
      o.id order_id, NULL::uuid item_id FROM public.reception_media rm
      JOIN public.receptions r ON r.tenant_id=rm.tenant_id AND r.id=rm.reception_id
      LEFT JOIN public.service_orders o ON o.tenant_id=r.tenant_id AND o.reception_id=r.id
      WHERE rm.tenant_id=$1 AND rm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'damage_media', dm.damage_id, r.id, d.id, o.id, NULL::uuid FROM public.damage_media dm
      JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
      JOIN public.receptions r ON r.tenant_id=d.tenant_id AND r.id=d.reception_id
      LEFT JOIN public.service_orders o ON o.tenant_id=r.tenant_id AND o.reception_id=r.id
      WHERE dm.tenant_id=$1 AND dm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'finding_media', f.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.finding_media fm
      JOIN public.findings f ON f.tenant_id=fm.tenant_id AND f.id=fm.finding_id
      JOIN public.service_orders o ON o.tenant_id=f.tenant_id AND o.id=f.order_id
      WHERE fm.tenant_id=$1 AND fm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'work_activity_media', w.id, o.reception_id, NULL::uuid, o.id, w.service_order_item_id
      FROM public.work_activity_media wm
      JOIN public.work_activities w ON w.tenant_id=wm.tenant_id AND w.id=wm.work_activity_id
      JOIN public.service_orders o ON o.tenant_id=w.tenant_id AND o.id=w.order_id
      WHERE wm.tenant_id=$1 AND wm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'quality_check_media', q.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.quality_check_media qm
      JOIN public.quality_checks q ON q.tenant_id=qm.tenant_id AND q.id=qm.quality_check_id
      JOIN public.service_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id
      WHERE qm.tenant_id=$1 AND qm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'delivery_media', d.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.delivery_media dm
      JOIN public.deliveries d ON d.tenant_id=dm.tenant_id AND d.id=dm.delivery_id
      JOIN public.service_orders o ON o.tenant_id=d.tenant_id AND o.id=d.order_id
      WHERE dm.tenant_id=$1 AND dm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'quote_media', q.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.quote_media qm
      JOIN public.quote_versions q ON q.tenant_id=qm.tenant_id AND q.id=qm.quote_version_id
      JOIN public.service_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id
      WHERE qm.tenant_id=$1 AND qm.media_asset_id=ANY($2::uuid[])
    UNION
    SELECT 'signature', s.id, COALESCE(s.reception_id,o.reception_id), NULL::uuid, o.id, NULL::uuid
      FROM public.signatures s LEFT JOIN public.deliveries d ON d.tenant_id=s.tenant_id AND d.id=s.delivery_id
      LEFT JOIN public.service_orders o ON o.tenant_id=d.tenant_id AND o.id=d.order_id
      WHERE s.tenant_id=$1 AND s.signature_media_id=ANY($2::uuid[])
    UNION
    SELECT 'privacy_evidence', c.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid FROM public.privacy_consents c
      WHERE c.tenant_id=$1 AND c.evidence_media_id=ANY($2::uuid[])
    UNION
    SELECT 'upload_binding', b.upload_session_id, b.reception_id, b.damage_id, NULL::uuid, NULL::uuid
      FROM public.media_upload_bindings b JOIN public.upload_sessions us
        ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
      WHERE b.tenant_id=$1 AND us.media_asset_id=ANY($2::uuid[])
  `;
  // UNION ALL and LEFT joins count every raw reference, including broken lineage,
  // before any application array is materialized. Existing callers retain UNION.
  const inventory = maxRows === undefined ? query : query.replace(/\n    UNION\n/g, '\n    UNION ALL\n')
    .replace(/(?<!LEFT )JOIN public\./g, 'LEFT JOIN public.');
  const rows = await sql.unsafe<Link[]>(`SELECT * FROM (${inventory}) inventory ${maxRows === undefined ? '' : 'LIMIT $3'}`,
    maxRows === undefined ? [tenantId, ids] : [tenantId, ids, maxRows + 1]);
  enforceReadBudget(maxRows, rows.length);
  return rows;
}

function enforceReadBudget(maxRows: number | undefined, count: number): void {
  if (maxRows !== undefined && count > maxRows)
    throw new MediaError(503, 'MEDIA_QUERY_LIMIT_EXCEEDED', 'The media query exceeds its safe work budget.');
}

// An opaque in-process proof: callers cannot skip parent discovery by supplying
// a boolean. The proof belongs to this connection and transaction only.
declare const lockBrand: unique symbol;
export interface MediaRetentionLock { readonly [lockBrand]: true }
interface LockState {
  sql: postgres.ReservedSql; tenantId: string; ids: string[]; receptions: Set<string>;
  damages: Set<string>; orders: Set<string>; sessions: Set<string>; transaction: string; maxRows?: number;
}
const locks = new WeakMap<MediaRetentionLock, LockState>();
const distinct = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => v !== null))].sort();

/** Call BEFORE taking any session/asset lock. Future attach may pass its already
 * authorized parent IDs; no dates/policies/holds are accepted from callers.
 * Order-terminal commands acquire their complete graph here BEFORE updating the
 * order. All IDs in each tier are sorted, including batch recalculations. */
export async function lockMediaRetention(sql: postgres.ReservedSql, tenantId: string, assetIds: string[],
  additionalParents: { receptionIds?: string[]; damageIds?: string[]; orderIds?: string[] } = {},
  maxRows?: number): Promise<MediaRetentionLock> {
  if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 1)) throw new Error('MEDIA_READ_BUDGET_INVALID');
  const ids = distinct(assetIds.map((id) => id.toLowerCase()));
  const discovered = await links(sql, tenantId, ids, maxRows);
  const extraOrders = await sql<{ id: string; reception_id: string }[]>`SELECT id,reception_id
    FROM public.service_orders WHERE tenant_id=${tenantId} AND id=ANY(${additionalParents.orderIds ?? []}::uuid[])`;
  const extraDamages = await sql<{ id: string; reception_id: string }[]>`SELECT id,reception_id
    FROM public.vehicle_damages WHERE tenant_id=${tenantId} AND id=ANY(${additionalParents.damageIds ?? []}::uuid[])`;
  const receptions = distinct([...discovered.map((l) => l.reception_id), ...extraDamages.map((d) => d.reception_id),
    ...extraOrders.map((o) => o.reception_id), ...(additionalParents.receptionIds ?? []).map((id) => id.toLowerCase())]);
  const damages = distinct([...discovered.map((l) => l.damage_id), ...extraDamages.map((d) => d.id)]);
  const knownOrders = distinct([...discovered.map((l) => l.order_id), ...extraOrders.map((o) => o.id)]);
  const knownRows = discovered.length + receptions.length + damages.length + knownOrders.length;
  enforceReadBudget(maxRows, knownRows);
  const receptionOrders = await sql<{ id: string }[]>`SELECT id FROM public.service_orders
    WHERE tenant_id=${tenantId} AND reception_id=ANY(${receptions}::uuid[]) AND NOT (id=ANY(${knownOrders}::uuid[]))
    LIMIT ${maxRows === undefined ? 2147483647 : maxRows - knownRows + 1}`;
  enforceReadBudget(maxRows, knownRows + receptionOrders.length);
  const orders = distinct([...knownOrders, ...receptionOrders.map((o) => o.id)]);
  const parentRows = receptions.length + damages.length + orders.length;
  enforceReadBudget(maxRows, discovered.length + parentRows);
  const remaining = maxRows === undefined ? undefined : maxRows - discovered.length - parentRows;
  const discoveredSessions = remaining === undefined ? undefined : await sql<{ id: string }[]>`
    SELECT id FROM public.upload_sessions WHERE tenant_id=${tenantId} AND media_asset_id=ANY(${ids}::uuid[])
    ORDER BY id LIMIT ${remaining + 1}`;
  enforceReadBudget(remaining, discoveredSessions?.length ?? 0);
  await sql`SELECT id FROM public.receptions WHERE tenant_id=${tenantId} AND id=ANY(${receptions}::uuid[])
    ORDER BY id FOR NO KEY UPDATE`;
  await sql`SELECT id FROM public.vehicle_damages WHERE tenant_id=${tenantId} AND id=ANY(${damages}::uuid[])
    ORDER BY id FOR SHARE`;
  await sql`SELECT id FROM public.service_orders WHERE tenant_id=${tenantId} AND id=ANY(${orders}::uuid[])
    ORDER BY id FOR NO KEY UPDATE`;
  const sessions = await sql<{ id: string }[]>`SELECT id FROM public.upload_sessions
    WHERE tenant_id=${tenantId} AND media_asset_id=ANY(${ids}::uuid[])
      AND (${discoveredSessions === undefined} OR id=ANY(${discoveredSessions?.map(s => s.id) ?? []}::uuid[]))
    ORDER BY id FOR UPDATE`;
  const assets = await sql<{ id: string }[]>`SELECT id FROM public.media_assets
    WHERE tenant_id=${tenantId} AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  if (assets.length !== ids.length) throw missing();
  const [tx] = await sql<{ transaction: string }[]>`SELECT pg_catalog.pg_current_xact_id()::text AS transaction`;
  const token = Object.freeze({}) as MediaRetentionLock;
  locks.set(token, { sql, tenantId, ids, receptions: new Set(receptions), damages: new Set(damages),
    orders: new Set(orders), sessions: new Set(sessions.map((s) => s.id)), transaction: tx.transaction, maxRows });
  await state(token);
  return token;
}
async function state(token: MediaRetentionLock): Promise<LockState> {
  const locked = locks.get(token);
  if (!locked) throw new Error('MEDIA_RETENTION_LOCK_REQUIRED');
  const [tx] = await locked.sql<{ transaction: string }[]>`SELECT pg_catalog.pg_current_xact_id()::text AS transaction`;
  if (tx.transaction !== locked.transaction) throw new Error('MEDIA_RETENTION_TRANSACTION_MISMATCH');
  const current = await links(locked.sql, locked.tenantId, locked.ids, locked.maxRows);
  // An attach could commit between discovery and asset lock. Abort and retry
  // the ENTIRE transaction; never acquire an unknown parent after the asset.
  if (current.some((l) => (l.reception_id && !locked.receptions.has(l.reception_id))
    || (l.damage_id && !locked.damages.has(l.damage_id)) || (l.order_id && !locked.orders.has(l.order_id)))) throw retry();
  const orders = await locked.sql<{ id: string }[]>`SELECT id FROM public.service_orders
    WHERE tenant_id=${locked.tenantId} AND reception_id=ANY(${[...locked.receptions]}::uuid[])
      AND NOT (id=ANY(${[...locked.orders]}::uuid[])) LIMIT 1`;
  if (orders.length) throw retry();
  const knownRows = current.length + locked.receptions.size + locked.damages.size + locked.orders.size;
  enforceReadBudget(locked.maxRows, knownRows);
  const sessions = await locked.sql<{ id: string }[]>`SELECT id FROM public.upload_sessions
    WHERE tenant_id=${locked.tenantId} AND media_asset_id=ANY(${locked.ids}::uuid[])
    LIMIT ${locked.maxRows === undefined ? 2147483647 : locked.maxRows - knownRows + 1}`;
  enforceReadBudget(locked.maxRows, knownRows + sessions.length);
  if (sessions.some((s) => !locked.sessions.has(s.id))) throw retry();
  return locked;
}

/** A read checks the same proof without calculating or persisting retention. */
export async function revalidateMediaReadGraph(token: MediaRetentionLock): Promise<void> { await state(token); }

/** Safe only for the current locked transaction. This is an eligibility
 * decision for B06, not authorization for an external DELETE after COMMIT. */
export async function evaluateLockedMediaRetention(token: MediaRetentionLock, assetId: string): Promise<RetentionDecision> {
  const { sql, ids } = await state(token);
  if (!ids.includes(assetId.toLowerCase())) throw missing();
  const [row] = await sql<{ decision: RetentionDecision }[]>`SELECT app.media_retention_decision(${assetId}::uuid,false) AS decision`;
  return row.decision;
}
export async function evaluateMediaRetention(sql: postgres.ReservedSql, tenantId: string,
  assetId: string): Promise<RetentionDecision> {
  return evaluateLockedMediaRetention(await lockMediaRetention(sql, tenantId, [assetId]), assetId);
}

export type RetentionChange = {
  before: { retention_until: string | null };
  after: { retention_until: string; retention_policy_version: string };
}
/** Internal lifecycle integration MUST include returned change in its existing
 * atomic audit. Other business commands use recalculateLockedMediaRetention. */
export async function persistMediaLifecycleRetention(token: MediaRetentionLock,
  assetId: string): Promise<{ decision: RetentionDecision; change: RetentionChange | null }> {
  const { sql, tenantId } = await state(token);
  const decision = await evaluateLockedMediaRetention(token, assetId);
  let change: RetentionChange | null = null;
  if (decision.knownRetentionUntil) {
    const [before] = await sql.unsafe<{ until: string | null }[]>(`SELECT ${iso('retention_until')} until
      FROM public.media_assets WHERE tenant_id=$1 AND id=$2`, [tenantId, assetId]);
    const rows = await sql<{ retention_policy_version: string }[]>`UPDATE public.media_assets SET
      retention_until=GREATEST(retention_until, ${decision.knownRetentionUntil}::text::timestamptz)
      WHERE tenant_id=${tenantId} AND id=${assetId}
        AND (retention_until IS NULL OR retention_until<${decision.knownRetentionUntil}::text::timestamptz)
      RETURNING retention_policy_version`;
    if (rows.length) change = { before: { retention_until: before.until },
      after: { retention_until: decision.knownRetentionUntil, retention_policy_version: rows[0].retention_policy_version } };
  }
  return { decision, change };
}
/** Writes only an extension. GREATEST and the row lock preserve committed
 * microsecond floors, even for concurrent/stale callers. No dates are inputs.
 * Audit belongs to the caller's transaction; failure rolls back the extension. */
export async function recalculateLockedMediaRetention(token: MediaRetentionLock,
  assetId: string): Promise<RetentionDecision> {
  const { sql, tenantId } = await state(token);
  const { decision, change } = await persistMediaLifecycleRetention(token, assetId);
  if (change) {
    await sql`INSERT INTO public.audit_logs (id,tenant_id,actor_type,actor_user_id,actor_membership_id,
      action,outcome,entity_type,entity_id,before_json,after_json,request_id)
      VALUES (${uuidV7()},${tenantId},'user',NULLIF(current_setting('app.user_id',true),'')::uuid,
        NULLIF(current_setting('app.membership_id',true),'')::uuid,'media.retention_updated','success',
        'media_asset',${assetId},${sql.json(change.before)},${sql.json(change.after)},current_setting('app.request_id',true))`;
  }
  return decision;
}
export async function recalculateMediaRetention(sql: postgres.ReservedSql, tenantId: string,
  assetId: string): Promise<RetentionDecision> {
  return recalculateLockedMediaRetention(await lockMediaRetention(sql, tenantId, [assetId]), assetId);
}

/** Future terminal command: prepare this scope BEFORE locking/updating an
 * order row. B05 locks receptions -> damages -> orders -> sessions -> assets
 * (sorted within each tier); readers use that same hierarchy. An order-first
 * writer can deadlock with a reader holding its reception. If authorization
 * needs the owner-set/membership gate, take it before these domain tiers too.
 * Never use a 40P01 response as a substitute for following this protocol.
 * Prepare this scope before changing order status,
 * then recalculate its assets using the same token in that transaction. No
 * delivered/cancelled business command is introduced here. */
export async function lockOrderMediaRetention(sql: postgres.ReservedSql, tenantId: string,
  orderId: string): Promise<{ lock: MediaRetentionLock; assetIds: string[] }> {
  const [order] = await sql<{ reception_id: string }[]>`SELECT reception_id FROM public.service_orders
    WHERE tenant_id=${tenantId} AND id=${orderId}`;
  if (!order) throw new MediaError(404, 'SERVICE_ORDER_NOT_FOUND', 'The service order was not found.');
  const assetIds = await orderAssetIds(sql, tenantId, orderId);
  const lock = await lockMediaRetention(sql, tenantId, assetIds, { orderIds: [orderId] });
  const currentIds = await orderAssetIds(sql, tenantId, orderId);
  if (currentIds.some((id) => !assetIds.includes(id))) throw retry();
  return { lock, assetIds: assetIds.sort() };
}
async function orderAssetIds(sql: postgres.ReservedSql, tenantId: string, orderId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`SELECT media_asset_id AS id FROM (
    SELECT rm.media_asset_id FROM public.reception_media rm JOIN public.service_orders o
      ON o.tenant_id=rm.tenant_id AND o.reception_id=rm.reception_id WHERE o.tenant_id=${tenantId} AND o.id=${orderId}
    UNION SELECT dm.media_asset_id FROM public.damage_media dm JOIN public.vehicle_damages d
      ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id JOIN public.service_orders o
      ON o.tenant_id=d.tenant_id AND o.reception_id=d.reception_id WHERE o.tenant_id=${tenantId} AND o.id=${orderId}
    UNION SELECT fm.media_asset_id FROM public.finding_media fm JOIN public.findings f
      ON f.tenant_id=fm.tenant_id AND f.id=fm.finding_id WHERE f.tenant_id=${tenantId} AND f.order_id=${orderId}
    UNION SELECT wm.media_asset_id FROM public.work_activity_media wm JOIN public.work_activities w
      ON w.tenant_id=wm.tenant_id AND w.id=wm.work_activity_id WHERE w.tenant_id=${tenantId} AND w.order_id=${orderId}
    UNION SELECT qm.media_asset_id FROM public.quality_check_media qm JOIN public.quality_checks q
      ON q.tenant_id=qm.tenant_id AND q.id=qm.quality_check_id WHERE q.tenant_id=${tenantId} AND q.order_id=${orderId}
    UNION SELECT dm.media_asset_id FROM public.delivery_media dm JOIN public.deliveries d
      ON d.tenant_id=dm.tenant_id AND d.id=dm.delivery_id WHERE d.tenant_id=${tenantId} AND d.order_id=${orderId}
    UNION SELECT qm.media_asset_id FROM public.quote_media qm JOIN public.quote_versions q
      ON q.tenant_id=qm.tenant_id AND q.id=qm.quote_version_id WHERE q.tenant_id=${tenantId} AND q.order_id=${orderId}
    UNION SELECT s.signature_media_id FROM public.signatures s JOIN public.service_orders o
      ON o.tenant_id=s.tenant_id AND o.reception_id=s.reception_id WHERE o.tenant_id=${tenantId} AND o.id=${orderId}
    UNION SELECT s.signature_media_id FROM public.signatures s JOIN public.deliveries d
      ON d.tenant_id=s.tenant_id AND d.id=s.delivery_id WHERE d.tenant_id=${tenantId} AND d.order_id=${orderId}
    UNION SELECT us.media_asset_id FROM public.media_upload_bindings b JOIN public.upload_sessions us
      ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id JOIN public.service_orders o
      ON o.tenant_id=b.tenant_id AND o.reception_id=b.reception_id WHERE o.tenant_id=${tenantId} AND o.id=${orderId}
  ) sources ORDER BY media_asset_id`;
  return rows.map((row) => row.id);
}
export async function recalculateOrderMediaRetention(sql: postgres.ReservedSql, tenantId: string,
  orderId: string): Promise<RetentionDecision[]> {
  const scope = await lockOrderMediaRetention(sql, tenantId, orderId);
  const results: RetentionDecision[] = [];
  for (const assetId of scope.assetIds) results.push(await recalculateLockedMediaRetention(scope.lock, assetId));
  return results;
}
