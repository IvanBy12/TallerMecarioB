import type { TenantRequestContext } from '../api/tenant-request.js';
import { mediaDownloadSql } from './download-limits.js';
import { lockReader } from './assigned-authorization.js';
import { lockMediaRetention } from './retention.js';

/** B01 compatibility fix, independently reproduced by the deletion-wins test.
 * Preserve tenant-wide family/history access: these are authorization/lifecycle
 * locks only, not B07's restricted graph eligibility or the gallery's D05 filter.
 * The caller signs synchronously under these locks, before request commit. */
export async function authorizeTenantDownload(context: TenantRequestContext, assetId: string): Promise<void> {
  const sql = await mediaDownloadSql(context.sql);
  await lockReader({ ...context, sql }, true);
  await lockMediaRetention(sql, context.tenant.tenantId, [assetId]);
}
