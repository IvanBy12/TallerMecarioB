import type postgres from 'postgres';
import { MediaError } from './errors.js';
import { lockMediaRetention, recalculateLockedMediaRetention } from './retention.js';
import { revalidateUploadBinding } from './operational-binding.js';
import { uuidV7 } from '../platform/uuid-v7.js';

export type AssociationTarget = { type: 'reception'; receptionId: string }
  | { type: 'damage'; receptionId: string; damageId: string };
const definition = (target: AssociationTarget) => target.type === 'reception'
  ? { table: 'reception_media', column: 'reception_id', id: target.receptionId, purpose: 'intake_evidence' }
  : { table: 'damage_media', column: 'damage_id', id: target.damageId, purpose: 'damage_evidence' };
const mismatch = () => new MediaError(409, 'MEDIA_ASSOCIATION_CONTEXT_MISMATCH', 'The media binding does not match the association.');

async function validateTarget(sql: postgres.ReservedSql, tenantId: string, target: AssociationTarget,
  editable: boolean): Promise<void> {
  if (target.type === 'damage') {
    const [damage] = await sql`SELECT reception_id FROM public.vehicle_damages WHERE tenant_id=${tenantId}
      AND id=${target.damageId}`;
    if (!damage || damage.reception_id !== target.receptionId) throw new MediaError(404, 'DAMAGE_NOT_FOUND', 'The damage was not found.');
  }
  const [parent] = await sql`SELECT status FROM public.receptions WHERE tenant_id=${tenantId} AND id=${target.receptionId}`;
  if (!parent) throw new MediaError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
  if (editable && parent.status !== 'open') throw new MediaError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
}

// Public projection only. Keep PostgreSQL timestamp precision; storage and
// retention internals never enter the DTO. The same projection serves replay.
const projection = `m.id AS "mediaAssetId", m.media_type AS "mediaType", m.mime_type AS "mimeType",
  m.size_bytes::double precision AS "sizeBytes",
  to_char(m.captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "capturedAt",
  to_char(m.uploaded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "uploadedAt",
  l.purpose, l.sort_order AS "sortOrder"`;
interface AssociationDto {
  mediaAssetId: string; mediaType: string; mimeType: string; sizeBytes: number | null;
  capturedAt: string | null; uploadedAt: string | null; purpose: string; sortOrder: number;
}
async function read(sql: postgres.ReservedSql, tenantId: string, target: AssociationTarget,
  assetId?: string): Promise<AssociationDto[]> {
  const d = definition(target);
  return sql.unsafe<AssociationDto[]>(`SELECT ${projection} FROM public.${d.table} l
    JOIN public.media_assets m ON m.tenant_id=l.tenant_id AND m.id=l.media_asset_id
    WHERE l.tenant_id=$1 AND l.${d.column}=$2
    AND m.status<>'deleted' AND m.deletion_requested_at IS NULL AND m.deleted_at IS NULL AND m.purged_at IS NULL ${assetId ? 'AND l.media_asset_id=$3' : ''}
    ORDER BY l.sort_order ASC,l.media_asset_id ASC,l.purpose ASC`, assetId ? [tenantId,d.id,assetId] : [tenantId,d.id]);
}
export async function listAssociatedMedia(sql: postgres.ReservedSql, tenantId: string,
  target: AssociationTarget): Promise<AssociationDto[]> {
  await validateTarget(sql, tenantId, target, false);
  return read(sql, tenantId, target);
}

/** The caller owns the verified tenant transaction and whole-transaction retry.
 * No storage I/O here. Every validation is repeated under B05's graph locks. */
export async function attachMedia(sql: postgres.ReservedSql, tenantId: string,
  target: AssociationTarget, input: { mediaAssetId: string; sortOrder?: number }): Promise<AssociationDto> {
  const assetId = input.mediaAssetId.toLowerCase(), sort = input.sortOrder ?? 0;
  await validateTarget(sql, tenantId, target, true);
  const token = await lockMediaRetention(sql, tenantId, [assetId], {
    receptionIds: [target.receptionId], damageIds: target.type === 'damage' ? [target.damageId] : [],
  });
  await validateTarget(sql, tenantId, target, true);
  const [asset] = await sql`SELECT media_type,status,retention_class,deletion_requested_at,deleted_at,purged_at
    FROM public.media_assets WHERE tenant_id=${tenantId} AND id=${assetId}`;
  if (!asset) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'The media asset was not found.');
  if (asset.status !== 'active' || asset.retention_class !== 'operational'
    || !['photo','video','video360'].includes(asset.media_type) || asset.deletion_requested_at || asset.deleted_at || asset.purged_at)
    throw new MediaError(409, 'MEDIA_ASSET_NOT_ELIGIBLE', 'The media asset cannot be associated.');
  // Evaluate ALL sessions, not an arbitrary LIMIT 1. Missing or contradictory
  // historical evidence fails closed. Multiple equivalent proofs are safe.
  const sessions = await sql`SELECT us.id,us.status,us.completed_at,b.reception_id,b.damage_id
    FROM public.upload_sessions us LEFT JOIN public.media_upload_bindings b
      ON b.tenant_id=us.tenant_id AND b.upload_session_id=us.id
    WHERE us.tenant_id=${tenantId} AND us.media_asset_id=${assetId} ORDER BY us.id`;
  if (!sessions.length || sessions.some(s => s.status !== 'completed' || !s.completed_at
    || s.reception_id !== target.receptionId || s.damage_id !== (target.type === 'damage' ? target.damageId : null))) throw mismatch();
  for (const session of sessions) await revalidateUploadBinding(sql, tenantId, session.id, asset.media_type, false);
  const existing = await read(sql, tenantId, target, assetId);
  if (existing.length) {
    if (existing.length !== 1 || existing[0].sortOrder !== sort)
      throw new MediaError(409, 'MEDIA_ASSOCIATION_CONFLICT', 'The association already has a different sort order.');
    return existing[0];
  }
  const d = definition(target);
  await sql.unsafe(`INSERT INTO public.${d.table}(tenant_id,${d.column},media_asset_id,purpose,sort_order)
    VALUES($1,$2,$3,$4,$5)`, [tenantId,d.id,assetId,d.purpose,sort]);
  await recalculateLockedMediaRetention(token, assetId);
  await sql`INSERT INTO public.audit_logs(id,tenant_id,actor_type,actor_user_id,actor_membership_id,
    action,outcome,entity_type,entity_id,metadata_json,request_id)
    VALUES(${uuidV7()},${tenantId},'user',NULLIF(current_setting('app.user_id',true),'')::uuid,
      NULLIF(current_setting('app.membership_id',true),'')::uuid,'media.associated','success','media_asset',${assetId},
      ${sql.json({ target_type: target.type, target_id: d.id, purpose: d.purpose, sort_order: sort })},current_setting('app.request_id',true))`;
  return (await read(sql, tenantId, target, assetId))[0];
}
