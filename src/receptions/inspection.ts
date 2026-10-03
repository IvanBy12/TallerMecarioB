import { ApiError, type TenantRequestContext } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { getReception } from './queries.js';
import type { RequestMeta } from './service.js';
import type { ChecklistInput, DamagesInput } from './inspection-validation.js';

const TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
async function lockOpenReception(context: TenantRequestContext, id: string, expectedUpdatedAt: string) {
  const { sql, tenant } = context;
  // The request TenantContext owns the transaction. Same lock as PATCH/CLOSE;
  // no child is touched before the parent, including the 0019 trigger's lock.
  const [row] = await sql`SELECT r.status,
      pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) =
        ${expectedUpdatedAt} AS version_matches
    FROM public.receptions AS r
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${id} FOR NO KEY UPDATE OF r`;
  if (!row) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
  if (row.status !== 'open') throw new ApiError(409, 'RECEPTION_NOT_EDITABLE', 'The reception cannot be edited.');
  if (!row.version_matches)
    throw new ApiError(409, 'RESOURCE_VERSION_CONFLICT', 'The reception was modified by another request.');
}
async function finish(context: TenantRequestContext, id: string, expectedUpdatedAt: string,
  action: string, count: number, meta: RequestMeta) {
  const { sql, tenant } = context;
  const [row] = await sql`UPDATE public.receptions AS r SET
      updated_at = GREATEST(pg_catalog.now(), r.updated_at + interval '1 microsecond')
    WHERE r.tenant_id = ${tenant.tenantId} AND r.id = ${id} AND r.status = 'open'
      AND pg_catalog.to_char(r.updated_at AT TIME ZONE 'UTC', ${TIMESTAMP_FORMAT}) = ${expectedUpdatedAt}
    RETURNING r.id`;
  if (!row) throw new Error('RECEPTION_LOCKED_UPDATE_FAILED');
  await sql`INSERT INTO public.audit_logs (
    id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome,
    entity_type, entity_id, reason_code, before_json, after_json, metadata_json, request_id, ip_address
  ) VALUES (${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
    ${action}, 'success', 'reception', ${id}, NULL, NULL, NULL,
    ${sql.json({ count })}, ${meta.requestId}, ${meta.ipAddress}::inet)`;
  return getReception(context, id);
}
export async function writeChecklist(context: TenantRequestContext, id: string,
  input: ChecklistInput, meta: RequestMeta) {
  const { sql, tenant } = context;
  await lockOpenReception(context, id, input.expectedUpdatedAt);
  for (const item of input.items) {
    await sql`INSERT INTO public.reception_check_items
      (id, tenant_id, reception_id, code, label, status, notes)
      VALUES (${uuidV7()}, ${tenant.tenantId}, ${id}, ${item.code}, ${item.label}, ${item.status}, ${item.notes})
      ON CONFLICT (tenant_id, reception_id, code) DO UPDATE
        SET label = EXCLUDED.label, status = EXCLUDED.status, notes = EXCLUDED.notes`;
  }
  return finish(context, id, input.expectedUpdatedAt, 'reception.checklist_updated', input.items.length, meta);
}
export async function writeDamages(context: TenantRequestContext, id: string,
  input: DamagesInput, meta: RequestMeta) {
  const { sql, tenant } = context;
  await lockOpenReception(context, id, input.expectedUpdatedAt);
  for (const item of input.damages) {
    if (item.operation === 'create') {
      await sql`INSERT INTO public.vehicle_damages
        (id, tenant_id, reception_id, zone_code, damage_type, severity, description)
        VALUES (${uuidV7()}, ${tenant.tenantId}, ${id}, ${item.zoneCode}, ${item.damageType},
          ${item.severity}, ${item.description})`;
    } else {
      const [row] = await sql`UPDATE public.vehicle_damages
        SET zone_code = ${item.zoneCode}, damage_type = ${item.damageType},
          severity = ${item.severity}, description = ${item.description}
        WHERE tenant_id = ${tenant.tenantId} AND reception_id = ${id} AND id = ${item.damageId}
        RETURNING id`;
      if (!row) throw new ApiError(404, 'DAMAGE_NOT_FOUND', 'The damage was not found.');
    }
  }
  return finish(context, id, input.expectedUpdatedAt, 'reception.damages_updated', input.damages.length, meta);
}
