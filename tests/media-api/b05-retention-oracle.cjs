// Frozen original B05 at 56c6e05; types erased, evaluator unchanged.

const { MediaError, MediaLineageChangedError } = require('../crm-api/helpers.cjs').load('media/errors.js');
const { uuidV7 } = require('../crm-api/helpers.cjs').load('platform/uuid-v7.js');

// v1 already denotes the canonical product defaults. No historical relabeling.
const MEDIA_RETENTION_POLICY_VERSION = 'v1';

const missing = () => new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'The media asset was not found.');
const retry = () => new MediaLineageChangedError();
const iso = (value) => `to_char((${value}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const calendar = (field, interval) => `((${field} AT TIME ZONE 'UTC') + interval '${interval}') AT TIME ZONE 'UTC'`;

/** Complete B01/B04 inventory. Every join includes tenant identity. Discovery
 * never takes a child lock. Binding is authorization evidence, not association. */
async function links(sql, tenantId, ids) {
  return sql.unsafe(`
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
  `, [tenantId, ids]);
}

// An opaque in-process proof: callers cannot skip parent discovery by supplying
// a boolean. The proof belongs to this connection and transaction only.

const locks = new WeakMap();
const distinct = (values) => [...new Set(values.filter((v) => v !== null))].sort();

/** Call BEFORE taking any session/asset lock. Future attach may pass its already
 * authorized parent IDs; no dates/policies/holds are accepted from callers.
 * Order-terminal commands acquire their complete graph here BEFORE updating the
 * order. All IDs in each tier are sorted, including batch recalculations. */
async function lockMediaRetention(sql, tenantId, assetIds,
  additionalParents = {}) {
  const ids = distinct(assetIds.map((id) => id.toLowerCase()));
  const discovered = await links(sql, tenantId, ids);
  const extraOrders = await sql`SELECT id,reception_id
    FROM public.service_orders WHERE tenant_id=${tenantId} AND id=ANY(${additionalParents.orderIds ?? []}::uuid[])`;
  const extraDamages = await sql`SELECT id,reception_id
    FROM public.vehicle_damages WHERE tenant_id=${tenantId} AND id=ANY(${additionalParents.damageIds ?? []}::uuid[])`;
  const receptions = distinct([...discovered.map((l) => l.reception_id), ...extraDamages.map((d) => d.reception_id),
    ...extraOrders.map((o) => o.reception_id), ...(additionalParents.receptionIds ?? []).map((id) => id.toLowerCase())]);
  const damages = distinct([...discovered.map((l) => l.damage_id), ...extraDamages.map((d) => d.id)]);
  const receptionOrders = await sql`SELECT id FROM public.service_orders
    WHERE tenant_id=${tenantId} AND reception_id=ANY(${receptions}::uuid[])`;
  const orders = distinct([...discovered.map((l) => l.order_id), ...extraOrders.map((o) => o.id), ...receptionOrders.map((o) => o.id)]);
  await sql`SELECT id FROM public.receptions WHERE tenant_id=${tenantId} AND id=ANY(${receptions}::uuid[])
    ORDER BY id FOR NO KEY UPDATE`;
  await sql`SELECT id FROM public.vehicle_damages WHERE tenant_id=${tenantId} AND id=ANY(${damages}::uuid[])
    ORDER BY id FOR SHARE`;
  await sql`SELECT id FROM public.service_orders WHERE tenant_id=${tenantId} AND id=ANY(${orders}::uuid[])
    ORDER BY id FOR NO KEY UPDATE`;
  const sessions = await sql`SELECT id FROM public.upload_sessions
    WHERE tenant_id=${tenantId} AND media_asset_id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  const assets = await sql`SELECT id FROM public.media_assets
    WHERE tenant_id=${tenantId} AND id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  if (assets.length !== ids.length) throw missing();
  const [tx] = await sql`SELECT pg_catalog.pg_current_xact_id()::text AS transaction`;
  const token = Object.freeze({});
  locks.set(token, { sql, tenantId, ids, receptions: new Set(receptions), damages: new Set(damages),
    orders: new Set(orders), sessions: new Set(sessions.map((s) => s.id)), transaction: tx.transaction });
  await state(token);
  return token;
}
async function state(token) {
  const locked = locks.get(token);
  if (!locked) throw new Error('MEDIA_RETENTION_LOCK_REQUIRED');
  const [tx] = await locked.sql`SELECT pg_catalog.pg_current_xact_id()::text AS transaction`;
  if (tx.transaction !== locked.transaction) throw new Error('MEDIA_RETENTION_TRANSACTION_MISMATCH');
  const current = await links(locked.sql, locked.tenantId, locked.ids);
  // An attach could commit between discovery and asset lock. Abort and retry
  // the ENTIRE transaction; never acquire an unknown parent after the asset.
  if (current.some((l) => (l.reception_id && !locked.receptions.has(l.reception_id))
    || (l.damage_id && !locked.damages.has(l.damage_id)) || (l.order_id && !locked.orders.has(l.order_id)))) throw retry();
  const orders = await locked.sql`SELECT id FROM public.service_orders
    WHERE tenant_id=${locked.tenantId} AND reception_id=ANY(${[...locked.receptions]}::uuid[])`;
  if (orders.some((o) => !locked.orders.has(o.id))) throw retry();
  const sessions = await locked.sql`SELECT id FROM public.upload_sessions
    WHERE tenant_id=${locked.tenantId} AND media_asset_id=ANY(${locked.ids}::uuid[])`;
  if (sessions.some((s) => !locked.sessions.has(s.id))) throw retry();
  return locked;
}

/** Safe only for the current locked transaction. This is an eligibility
 * decision for B06, not authorization for an external DELETE after COMMIT. */
async function evaluateLockedMediaRetention(token, assetId) {
  const { sql, tenantId, ids } = await state(token);
  if (!ids.includes(assetId.toLowerCase())) throw missing();
  const [asset] = await sql.unsafe(`SELECT id, media_type,status,
    ${iso('retention_until')} retention_until, retention_policy_version,
    legal_hold_until > clock_timestamp() AS legal_hold_active,
    (status='deleted' OR deletion_requested_at IS NOT NULL OR deleted_at IS NOT NULL OR purged_at IS NOT NULL) unavailable,
    ${iso(calendar('uploaded_at', '30 days'))} unlinked_until,
    ${iso(calendar('quarantined_at', '7 days'))} quarantine_until,
    ${iso('clock_timestamp()')} now FROM public.media_assets WHERE tenant_id=$1 AND id=$2`, [tenantId, assetId]);
  if (!asset) throw missing();
  const sources = [];
  const add = (kind, id, date, blocker = null) => {
    sources.push({ kind, id, knownRetentionUntil: date, blocker });
  };
  const domain = await links(sql, tenantId, [assetId]);
  for (const link of domain) {
    if (link.kind === 'upload_binding') {
      const [binding] = await sql`SELECT (r.status='open'
        AND r.privacy_consent_id=b.privacy_consent_id AND c.customer_id=r.customer_id
        AND c.purpose_code='service_provision' AND c.created_at<=b.authorized_at
        AND b.created_at=b.authorized_at AND b.authorized_at<=clock_timestamp()
        AND ((us.status='pending' AND us.expires_at>clock_timestamp() AND us.integrity_version='v1')
          OR (us.status='completed' AND ${asset.status}='active' AND NOT (
            (b.damage_id IS NULL AND EXISTS (SELECT 1 FROM public.reception_media rm
              WHERE rm.tenant_id=b.tenant_id AND rm.reception_id=b.reception_id
                AND rm.media_asset_id=us.media_asset_id AND rm.purpose='intake_evidence'))
            OR (b.damage_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.damage_media dm
              JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
              WHERE dm.tenant_id=b.tenant_id AND dm.damage_id=b.damage_id AND d.reception_id=b.reception_id
                AND dm.media_asset_id=us.media_asset_id AND dm.purpose='damage_evidence')))))) AS protected
        FROM public.media_upload_bindings b JOIN public.upload_sessions us ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
        JOIN public.receptions r ON r.tenant_id=b.tenant_id AND r.id=b.reception_id
        JOIN public.privacy_consents c ON c.tenant_id=b.tenant_id AND c.id=b.privacy_consent_id
        WHERE b.tenant_id=${tenantId} AND b.upload_session_id=${link.id}`;
      if (binding?.protected) add(link.kind, link.id, null, 'UNRESOLVED_PROTECTION');
      continue;
    }
    if (link.kind === 'privacy_evidence' || link.kind === 'quote_media') {
      add(link.kind, link.id, null, 'UNRESOLVED_PROTECTION'); continue;
    }
    if (link.kind === 'signature') {
      const [row] = await sql.unsafe(`SELECT ${iso(calendar('signed_at', '36 months'))} until
        FROM public.signatures WHERE tenant_id=$1 AND id=$2`, [tenantId, link.id]);
      add(link.kind, link.id, row?.until ?? null, row?.until ? null : 'UNRESOLVED_PROTECTION'); continue;
    }
    if (link.kind === 'delivery_media') {
      const [row] = await sql.unsafe(`SELECT status,
        ${iso(calendar('delivered_at', '36 months'))} until
        FROM public.deliveries WHERE tenant_id=$1 AND id=$2`, [tenantId, link.id]);
      const completed = row?.status === 'completed';
      add(link.kind, link.id, completed ? row.until : null,
        completed ? (row.until ? null : 'UNRESOLVED_PROTECTION')
          : row?.status === 'pending' ? 'CLOCK_NOT_STARTED' : 'UNRESOLVED_PROTECTION'); continue;
    }
    if (!['photo', 'video', 'video360'].includes(asset.media_type)) {
      add(link.kind, link.id, null, 'UNRESOLVED_PROTECTION'); continue;
    }
    if (!link.order_id) {
      add(link.kind, link.id, null, 'CLOCK_NOT_STARTED'); continue;
    }
    const [order] = await sql.unsafe(`SELECT status,
      ${iso(calendar('closed_at', '12 months'))} until FROM public.service_orders WHERE tenant_id=$1 AND id=$2`,
    [tenantId, link.order_id]);
    const terminal = order && ['delivered', 'cancelled'].includes(order.status);
    add(link.kind, link.id, terminal ? order.until : null,
      terminal ? (order.until ? null : 'UNRESOLVED_PROTECTION') : 'DOMAIN_LINK_NONTERMINAL');
    // Only the work activity's composite item/order FK proves exact item evidence.
    // Sharing vehicle/customer/reception or simply having warranty items is insufficient.
    if (link.item_id) {
      const [item] = await sql.unsafe(`SELECT
        ${iso(calendar('warranty_expires_at', '90 days'))} until, warranty_origin<>'none' AS warranty
        FROM public.service_order_items WHERE tenant_id=$1 AND id=$2 AND order_id=$3`,
      [tenantId, link.item_id, link.order_id]);
      if (item?.warranty) add('warranty_item', link.item_id, item.until,
        item.until ? null : 'UNRESOLVED_PROTECTION');
    }
  }
  const sessions = await sql.unsafe(`SELECT id,
    ${iso("created_at + interval '24 hours'")} until,
    (status='pending' AND expires_at>clock_timestamp()) live FROM public.upload_sessions
    WHERE tenant_id=$1 AND media_asset_id=$2 AND status<>'completed'`, [tenantId, assetId]);
  if (['pending_upload', 'uploaded'].includes(asset.status)) {
    if (!sessions.length) add('incomplete_clock_unresolved', assetId, null, 'UNRESOLVED_PROTECTION');
    for (const session of sessions) add('incomplete_upload', session.id, session.until, session.live ? 'ACTIVE_UPLOAD' : null);
  } else {
    for (const session of sessions) if (session.live) add('live_upload', session.id, null, 'ACTIVE_UPLOAD');
    if (asset.status === 'quarantined') add('quarantine', assetId, asset.quarantine_until,
      asset.quarantine_until ? null : 'UNRESOLVED_PROTECTION');
    if (asset.status === 'active' && sources.length === 0) add('active_unlinked', assetId, asset.unlinked_until,
      asset.unlinked_until ? null : 'UNRESOLVED_PROTECTION');
  }
  if (asset.retention_until) add('committed_floor', assetId, asset.retention_until);
  if (asset.legal_hold_active) add('legal_hold', assetId, null, 'LEGAL_HOLD');
  if (asset.unavailable) add('lifecycle', assetId, null, 'LIFECYCLE_UNAVAILABLE');
  const known = sources.map((s) => s.knownRetentionUntil).filter((v) => v !== null).sort().at(-1) ?? null;
  const blockers = [...new Set(sources.map((s) => s.blocker).filter((v) => v !== null))];
  if (!known && blockers.length === 0) blockers.push('UNRESOLVED_PROTECTION');
  const priority = ['LIFECYCLE_UNAVAILABLE', 'LEGAL_HOLD', 'ACTIVE_UPLOAD',
    'DOMAIN_LINK_NONTERMINAL', 'CLOCK_NOT_STARTED', 'UNRESOLVED_PROTECTION'];
  const first = priority.find((b) => blockers.includes(b));
  const eligibility = first ? `NOT_ELIGIBLE_${first}`
    : known && known <= asset.now ? 'ELIGIBLE_AFTER_DATE' : 'NOT_ELIGIBLE_RETENTION_NOT_EXPIRED';
  return { knownRetentionUntil: known, blocksAutomaticPurge: blockers.length > 0 || !known || known > asset.now,
    blockers, sources, policyVersion: MEDIA_RETENTION_POLICY_VERSION, eligibility };
}
async function evaluateMediaRetention(sql, tenantId,
  assetId) {
  return evaluateLockedMediaRetention(await lockMediaRetention(sql, tenantId, [assetId]), assetId);
}

/** Internal lifecycle integration MUST include returned change in its existing
 * atomic audit. Other business commands use recalculateLockedMediaRetention. */
async function persistMediaLifecycleRetention(token,
  assetId) {
  const { sql, tenantId } = await state(token);
  const decision = await evaluateLockedMediaRetention(token, assetId);
  let change = null;
  if (decision.knownRetentionUntil) {
    const [before] = await sql.unsafe(`SELECT ${iso('retention_until')} until
      FROM public.media_assets WHERE tenant_id=$1 AND id=$2`, [tenantId, assetId]);
    const rows = await sql`UPDATE public.media_assets SET
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
async function recalculateLockedMediaRetention(token,
  assetId) {
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
async function recalculateMediaRetention(sql, tenantId,
  assetId) {
  return recalculateLockedMediaRetention(await lockMediaRetention(sql, tenantId, [assetId]), assetId);
}

/** Future terminal command: prepare this scope before changing order status,
 * then recalculate its assets using the same token in that transaction. No
 * delivered/cancelled business command is introduced here. */
async function lockOrderMediaRetention(sql, tenantId,
  orderId) {
  const [order] = await sql`SELECT reception_id FROM public.service_orders
    WHERE tenant_id=${tenantId} AND id=${orderId}`;
  if (!order) throw new MediaError(404, 'SERVICE_ORDER_NOT_FOUND', 'The service order was not found.');
  const assetIds = await orderAssetIds(sql, tenantId, orderId);
  const lock = await lockMediaRetention(sql, tenantId, assetIds, { orderIds: [orderId] });
  const currentIds = await orderAssetIds(sql, tenantId, orderId);
  if (currentIds.some((id) => !assetIds.includes(id))) throw retry();
  return { lock, assetIds: assetIds.sort() };
}
async function orderAssetIds(sql, tenantId, orderId) {
  const rows = await sql`SELECT media_asset_id AS id FROM (
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
async function recalculateOrderMediaRetention(sql, tenantId,
  orderId) {
  const scope = await lockOrderMediaRetention(sql, tenantId, orderId);
  const results = [];
  for (const assetId of scope.assetIds) results.push(await recalculateLockedMediaRetention(scope.lock, assetId));
  return results;
}

module.exports={evaluateMediaRetention,recalculateMediaRetention};
