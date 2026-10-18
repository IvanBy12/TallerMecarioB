import type { TenantRequestContext } from '../api/tenant-request.js';
import { markResourceAuthorizationSatisfied } from '../authz/resource-authorization.js';
import { lockCurrentTenantOwnerSet } from '../memberships/membership-access.js';
import { listAssociatedMedia, type AssociationTarget } from './associations.js';
import { MediaError } from './errors.js';
import { lockMediaRetention } from './retention.js';

const missing = () => new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'Media asset not found.');

/** Serialize with the existing role/status command protocol, before domain locks.
 * Re-read the actual grant after waiting: request-start RBAC is not fresh proof.
 * No added privileges or authorization inferred from a role name. */
export async function lockReader(context: TenantRequestContext, tenantWide = false): Promise<void> {
  const { sql, tenant, resourceAuthorization } = context;
  if (resourceAuthorization.permission !== 'media.read' || (!tenantWide && !resourceAuthorization.grantedScopes.has('assigned'))) throw missing();
  await lockCurrentTenantOwnerSet(sql);
  const [membership] = await sql`SELECT id FROM public.memberships
    WHERE tenant_id=${tenant.tenantId} AND id=${tenant.membershipId}
      AND user_id=${tenant.userId} AND status='active' FOR SHARE`;
  if (!membership) throw missing();
  const [grant] = await sql`SELECT 1 FROM public.membership_roles mr
    JOIN public.role_permissions rp ON rp.role_id=mr.role_id
    JOIN public.permissions p ON p.id=rp.permission_id
    WHERE mr.tenant_id=${tenant.tenantId} AND mr.membership_id=${tenant.membershipId}
      AND p.code='media.read' AND rp.resource_scope IN ('tenant','assigned')
      AND (${!tenantWide} OR rp.resource_scope='tenant')`;
  if (!grant) throw missing();
}

/** Called after the sorted B05 parent/order/session/asset tiers. SHARE blocks
 * UPDATE released_at/type/member/order until capability issuance commits.
 * Revocation that wins the lock is re-evaluated by PostgreSQL, never stale JS. */
export async function assignedReception(context: TenantRequestContext, receptionId: string): Promise<boolean> {
  const { sql, tenant } = context;
  const orders = await sql<{ id: string }[]>`SELECT o.id FROM public.service_orders o
    JOIN public.receptions r ON r.tenant_id=o.tenant_id AND r.id=o.reception_id
    WHERE o.tenant_id=${tenant.tenantId} AND r.id=${receptionId} AND r.status='closed'`;
  if (orders.length !== 1) return false;
  const rows = await sql`SELECT id FROM public.assignments
    WHERE tenant_id=${tenant.tenantId} AND order_id=${orders[0].id}
      AND membership_id=${tenant.membershipId} AND released_at IS NULL
      AND assignment_type IN ('lead_technician','support_technician')
    ORDER BY id FOR SHARE`;
  return rows.length > 0;
}

interface Link { reception_id: string | null; damage_id: string | null; valid: boolean }

/** All nine reference families, including sensitive references whose media
 * type/class might look operational. Only B04's canonical families have an
 * approved read contract here; future families fail closed. LEFT joins retain
 * broken lineage as a denial rather than silently discarding an association.
 * Caller holds the full B05 graph locks; B06 reference guards share asset locks. */
export async function eligibleGraph(context: TenantRequestContext, assetId: string, tenantWideLegacy = false): Promise<boolean> {
  const { sql, tenant } = context;
  const [asset] = await sql`SELECT id FROM public.media_assets
    WHERE tenant_id=${tenant.tenantId} AND id=${assetId} AND status='active'
      AND media_type IN ('photo','video','video360') AND retention_class='operational'
      AND quarantined_at IS NULL AND integrity_failure_code IS NULL
      AND deletion_requested_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL`;
  if (!asset) return false;
  const [disallowed] = await sql`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM public.finding_media WHERE tenant_id=${tenant.tenantId} AND media_asset_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.work_activity_media WHERE tenant_id=${tenant.tenantId} AND media_asset_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.quality_check_media WHERE tenant_id=${tenant.tenantId} AND media_asset_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.delivery_media WHERE tenant_id=${tenant.tenantId} AND media_asset_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.quote_media WHERE tenant_id=${tenant.tenantId} AND media_asset_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.signatures WHERE tenant_id=${tenant.tenantId} AND signature_media_id=${assetId})
    OR EXISTS(SELECT 1 FROM public.privacy_consents WHERE tenant_id=${tenant.tenantId} AND evidence_media_id=${assetId})`;
  if (disallowed) return false;
  const links = await sql<Link[]>`SELECT r.id reception_id, NULL::uuid damage_id,
      (r.id IS NOT NULL AND rm.purpose='intake_evidence') valid
    FROM public.reception_media rm LEFT JOIN public.receptions r ON r.tenant_id=rm.tenant_id AND r.id=rm.reception_id
    WHERE rm.tenant_id=${tenant.tenantId} AND rm.media_asset_id=${assetId}
    UNION ALL
    SELECT r.id, d.id, (r.id IS NOT NULL AND d.id IS NOT NULL AND dm.purpose='damage_evidence')
    FROM public.damage_media dm LEFT JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
    LEFT JOIN public.receptions r ON r.tenant_id=d.tenant_id AND r.id=d.reception_id
    WHERE dm.tenant_id=${tenant.tenantId} AND dm.media_asset_id=${assetId}`;
  if (!links.length || links.some(l => !l.valid || !l.reception_id)) return false;
  // Immutable upload evidence never authorizes an unattached asset. Every
  // session must prove the exact final target and historical consent lineage.
  const sessions = await sql<{ reception_id: string | null; damage_id: string | null; valid: boolean; binding_id: string | null; session_status: string; completed_at: Date | null }[]>`
    SELECT b.reception_id, b.damage_id, b.upload_session_id AS binding_id, us.status AS session_status, us.completed_at,
      (us.status='completed' AND us.completed_at IS NOT NULL AND b.upload_session_id IS NOT NULL
        AND c.id IS NOT NULL AND r.id IS NOT NULL AND c.customer_id=r.customer_id
        AND c.purpose_code='service_provision' AND c.created_at<=b.authorized_at
        AND b.authorized_at=b.created_at AND b.authorized_at<=pg_catalog.clock_timestamp()
        AND (b.damage_id IS NULL OR d.id IS NOT NULL)) valid
    FROM public.upload_sessions us LEFT JOIN public.media_upload_bindings b
      ON b.tenant_id=us.tenant_id AND b.upload_session_id=us.id
    LEFT JOIN public.receptions r ON r.tenant_id=b.tenant_id AND r.id=b.reception_id AND r.privacy_consent_id=b.privacy_consent_id
    LEFT JOIN public.vehicle_damages d ON d.tenant_id=b.tenant_id AND d.id=b.damage_id AND d.reception_id=b.reception_id
    LEFT JOIN public.privacy_consents c ON c.tenant_id=b.tenant_id AND c.id=b.privacy_consent_id
    WHERE us.tenant_id=${tenant.tenantId} AND us.media_asset_id=${assetId}`;
  // D05: only the order gallery's tenant-wide path accepts genuinely unbound
  // historical evidence. Mixed or incomplete proof never uses this exception.
  if (tenantWideLegacy && links.length === 1 && sessions.every(s => s.binding_id === null
    && s.session_status === 'completed' && s.completed_at !== null)) return true;
  if (!sessions.length || sessions.some(s => s.reception_id !== sessions[0].reception_id || s.damage_id !== sessions[0].damage_id)
    || sessions.some(s => s.valid !== true
    || !links.some(l => l.reception_id === s.reception_id && l.damage_id === s.damage_id))
    || links.some(l => !sessions.some(s => s.reception_id === l.reception_id && s.damage_id === l.damage_id))) return false;
  if (tenantWideLegacy) return true;
  for (const receptionId of [...new Set(links.map(l => l.reception_id!))].sort()) {
    if (!await assignedReception(context, receptionId)) return false;
  }
  return true;
}

export async function authorizeAssignedDownload(context: TenantRequestContext, assetId: string): Promise<void> {
  await lockReader(context);
  await lockMediaRetention(context.sql, context.tenant.tenantId, [assetId]);
  if (!await eligibleGraph(context, assetId)) throw missing();
  markResourceAuthorizationSatisfied(context.resourceAuthorization, 'assigned');
}

export async function listAssignedMedia(context: TenantRequestContext, target: AssociationTarget) {
  await lockReader(context);
  const { sql, tenant } = context;
  // Discovery is not returned. Batch locks preserve B04/B05's sorted tiers,
  // even when an unsafe multi-link leads to another reception/order.
  const discovered = await listAssociatedMedia(sql, tenant.tenantId, target);
  const ids = [...new Set(discovered.map(m => m.mediaAssetId))].sort();
  await lockMediaRetention(sql, tenant.tenantId, ids, { receptionIds: [target.receptionId],
    damageIds: target.type === 'damage' ? [target.damageId] : [] });
  const current = await listAssociatedMedia(sql, tenant.tenantId, target);
  if (!await assignedReception(context, target.receptionId)) {
    throw new MediaError(404, target.type === 'damage' ? 'DAMAGE_NOT_FOUND' : 'RECEPTION_NOT_FOUND',
      target.type === 'damage' ? 'The damage was not found.' : 'The reception was not found.');
  }
  const eligible = new Set<string>();
  for (const id of ids) if (await eligibleGraph(context, id)) eligible.add(id);
  const media = current.filter(m => eligible.has(m.mediaAssetId));
  markResourceAuthorizationSatisfied(context.resourceAuthorization, 'assigned');
  return media;
}
