import type postgres from 'postgres';
import { MediaError } from './errors.js';

export type OperationalContext = { type: 'reception'; receptionId: string }
  | { type: 'damage'; damageId: string };
export interface UploadBinding {
  reception_id: string;
  damage_id: string | null;
  privacy_consent_id: string;
}
interface Reception { id: string; customer_id: string; privacy_consent_id: string; status: string }
export const isOperationalMedia = (type: string): boolean => ['photo', 'video', 'video360'].includes(type);
const conflict = () => new MediaError(409, 'MEDIA_ASSOCIATION_CONFLICT', 'Operational upload binding is not eligible.');

async function reception(sql: postgres.ReservedSql, tenantId: string, id: string, lock: boolean): Promise<Reception> {
  const [row] = await sql.unsafe<Reception[]>(
    'SELECT id, customer_id, privacy_consent_id, status FROM public.receptions WHERE tenant_id=$1 AND id=$2'
      + (lock ? ' FOR NO KEY UPDATE' : ''), [tenantId, id]);
  if (!row) throw new MediaError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
  if (row.status !== 'open') throw new MediaError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  return row;
}
async function damage(sql: postgres.ReservedSql, tenantId: string, id: string, parentId: string, lock: boolean): Promise<void> {
  const [row] = await sql.unsafe(
    'SELECT id FROM public.vehicle_damages WHERE tenant_id=$1 AND id=$2 AND reception_id=$3'
      + (lock ? ' FOR SHARE' : ''), [tenantId, id, parentId]);
  if (!row) throw new MediaError(404, 'DAMAGE_NOT_FOUND', 'The damage was not found.');
}

/** Parent first, then damage, then consent FOR SHARE; serialize close/revoke. */
export async function authorizeOperationalCreate(sql: postgres.ReservedSql, tenantId: string,
  context: OperationalContext, mediaType: string): Promise<UploadBinding> {
  let parentId: string;
  if (context.type === 'damage') {
    // Discovery only, no child lock before its parent. Recheck lineage under locks.
    const [row] = await sql<{ reception_id: string }[]>`SELECT reception_id FROM public.vehicle_damages
      WHERE tenant_id=${tenantId} AND id=${context.damageId}`;
    if (!row) throw new MediaError(404, 'DAMAGE_NOT_FOUND', 'The damage was not found.');
    parentId = row.reception_id;
  } else parentId = context.receptionId;
  const parent = await reception(sql, tenantId, parentId, true);
  const damageId = context.type === 'damage' ? context.damageId : null;
  if (damageId) {
    await damage(sql, tenantId, damageId, parent.id, true);
    if (mediaType === 'video360') throw conflict();
  }
  const [consent] = await sql<{ eligible: boolean }[]>`SELECT
    (customer_id=${parent.customer_id} AND purpose_code='service_provision' AND status='granted'
      AND revoked_at IS NULL AND created_at <= pg_catalog.clock_timestamp()) AS eligible
    FROM public.privacy_consents WHERE tenant_id=${tenantId} AND id=${parent.privacy_consent_id} FOR SHARE`;
  if (!consent?.eligible) throw new MediaError(409, 'PRIVACY_CONSENT_NOT_ELIGIBLE', 'The privacy consent cannot cover this operation.');
  return { reception_id: parent.id, damage_id: damageId?.toLowerCase() ?? null,
    privacy_consent_id: parent.privacy_consent_id };
}
export async function readUploadBinding(sql: postgres.ReservedSql, tenantId: string, sessionId: string): Promise<UploadBinding> {
  const [row] = await sql<UploadBinding[]>`SELECT reception_id, damage_id, privacy_consent_id
    FROM public.media_upload_bindings WHERE tenant_id=${tenantId} AND upload_session_id=${sessionId}`;
  if (!row) throw conflict();
  return row;
}
export function bindingMatchesContext(binding: UploadBinding, context: OperationalContext | undefined): boolean {
  return context?.type === 'reception'
    ? binding.damage_id === null && binding.reception_id === context.receptionId.toLowerCase()
    : context?.type === 'damage' && binding.damage_id === context.damageId.toLowerCase();
}
/** Historical initial evidence, never current granted/revoked state. */
export async function revalidateUploadBinding(sql: postgres.ReservedSql, tenantId: string,
  sessionId: string, mediaType: string, lock: boolean): Promise<UploadBinding> {
  const binding = await readUploadBinding(sql, tenantId, sessionId);
  const parent = await reception(sql, tenantId, binding.reception_id, lock);
  if (binding.damage_id) {
    await damage(sql, tenantId, binding.damage_id, parent.id, lock);
    if (mediaType === 'video360') throw conflict();
  }
  if (parent.privacy_consent_id !== binding.privacy_consent_id) throw conflict();
  const [evidence] = await sql<{ eligible: boolean }[]>`SELECT
    (c.customer_id=${parent.customer_id} AND c.purpose_code='service_provision'
      AND c.created_at <= b.authorized_at AND b.authorized_at=b.created_at
      AND b.authorized_at <= pg_catalog.clock_timestamp()) AS eligible
    FROM public.media_upload_bindings b JOIN public.privacy_consents c
      ON c.tenant_id=b.tenant_id AND c.id=b.privacy_consent_id
    WHERE b.tenant_id=${tenantId} AND b.upload_session_id=${sessionId}`;
  if (!evidence?.eligible) throw conflict();
  return binding;
}
export async function insertUploadBinding(sql: postgres.ReservedSql, tenantId: string,
  sessionId: string, binding: UploadBinding): Promise<void> {
  await sql`INSERT INTO public.media_upload_bindings
    (tenant_id, upload_session_id, reception_id, damage_id, privacy_consent_id)
    VALUES (${tenantId}, ${sessionId}, ${binding.reception_id}, ${binding.damage_id}, ${binding.privacy_consent_id})`;
}
