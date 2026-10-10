import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { deleteR2Object, R2DeleteRejectedError, type R2Config } from './r2.js';

type Connection = postgres.ReservedSql;
async function transaction<T>(sql: Connection, tenantId: string, work: () => Promise<T>): Promise<T> {
  await sql`BEGIN`;
  try {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='8s'`;
    await sql`SELECT set_config('app.tenant_id',${tenantId},true)`;
    const result = await work();
    await sql`COMMIT`;
    return result;
  } catch (error) { await sql`ROLLBACK`.catch(() => undefined); throw error; }
}
/** A dedicated connection retains ONLY a session advisory fence during R2 I/O.
 * Its durable 120s lease bounds takeover after loss of that DB session. Never
 * start transport more than 10s after claim begins; DELETE deadline is 5s.
 * Protection after a potentially destructive attempt parks durable reconciliation.
 * A hold after physical DELETE cannot restore the object: see the B06 runbook.
 */
export async function purgeMediaAsset(database: postgres.Sql, config: R2Config,
  tenantId: string, assetId: string,
  transport: typeof deleteR2Object = deleteR2Object): Promise<'completed' | 'deferred' | 'retry'> {
  const sql = await database.reserve(), claim = randomUUID();
  let key: string | undefined;
  let claimed = false, storageConfirmed = false, transportStarted = false;
  try {
    const acquired = await transaction(sql, tenantId, async () => {
      const [fence] = await sql<{ key: string; acquired: boolean }[]>`SELECT app.media_purge_fence_key(${assetId}::uuid)::text AS key,
        pg_try_advisory_lock(app.media_purge_fence_key(${assetId}::uuid)) AS acquired`;
      if (fence.acquired) key = fence.key;
      return fence.acquired;
    });
    if (!acquired) return 'deferred';
    const started = performance.now();
    const plan = await transaction(sql, tenantId, async () => {
      const [row] = await sql<{ object_key: string; bucket: string; attempt: number }[]>`
        SELECT * FROM app.claim_media_purge(${assetId}::uuid,${claim}::uuid)`;
      return row;
    });
    if (!plan) return 'deferred';
    claimed = true;
    if (plan.bucket !== config.bucket || performance.now() - started > 10000) throw new Error('MEDIA_PURGE_PREPARATION_FAILED');
    // No SQL transaction is open here. The transport receives no authority.
    transportStarted = true;
    const result = await transport(config, plan.object_key, AbortSignal.timeout(5000));
    storageConfirmed = true;
    await transaction(sql, tenantId, async () => {
      await sql`SELECT app.record_media_purge_result(${assetId}::uuid,${claim}::uuid,${result})`;
    });
    await transaction(sql, tenantId, async () => {
      await sql`SELECT app.confirm_media_purge(${assetId}::uuid,${claim}::uuid)`;
    });
    return 'completed';
  } catch (error) {
    if (claimed) await transaction(sql, tenantId, async () => {
      await sql`SELECT app.record_media_purge_result(${assetId}::uuid,${claim}::uuid,
        ${storageConfirmed ? 'confirmation_unavailable' : !transportStarted ? 'storage_not_attempted'
          : error instanceof R2DeleteRejectedError ? 'storage_rejected' : 'storage_unavailable'})`;
    }).catch(() => undefined);
    return 'retry';
  } finally {
    await sql`ROLLBACK`.catch(() => undefined);
    if (key) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: { unlocked: boolean }[];
        try {
          result = await Promise.race([
            sql<{ unlocked: boolean }[]>`SELECT pg_advisory_unlock(${key}::bigint) AS unlocked`,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('MEDIA_PURGER_FENCE_RELEASE_FAILED')), 2000);
            }),
          ]);
        } finally { clearTimeout(timer); }
        if (!result[0]?.unlocked) throw new Error('MEDIA_PURGER_FENCE_RELEASE_FAILED');
      } catch {
        sql.release();
        await database.end({ timeout: 0 }).catch(() => undefined);
        throw new Error('MEDIA_PURGER_FENCE_RELEASE_FAILED');
      }
    }
    sql.release();
  }
}

/** Deterministic tenant/id cursor; discovery scans at most 100 rows per cycle.
 * Age never authorizes deletion. Queue calls run the complete locked evaluator.
 */
export async function discoverMediaPurges(database: postgres.Sql, tenantId: string,
  after: string | null, limit = 50): Promise<string | null> {
  const sql = await database.reserve();
  try {
    const rows = await transaction(sql, tenantId, () => sql<{ media_asset_id: string; candidate: boolean }[]>`
      SELECT * FROM app.media_purge_candidates(${after}::uuid,${limit})`);
    for (const row of rows) {
      if (!row.candidate) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await transaction(sql, tenantId, async () => {
            await sql`SELECT app.queue_retention_media_purge(${row.media_asset_id}::uuid)`;
          });
          break;
        } catch (error) {
          const db = error as { code?: string; message?: string };
          // Only this bounded transaction supplies statement_timeout. Cancellation
          // from another source is unexpected and must remain visible.
          const transient = db.code === '55P03' || db.code === '40001'
            || (db.code === '57014' && db.message === 'canceling statement due to statement timeout');
          if (transient) {
            if (db.code === '40001' && attempt < 2) continue;
            break; // fresh transaction for the next candidate; next sweep revisits this ID
          }
          if (['MEDIA_DELETE_NOT_ELIGIBLE','MEDIA_LEGAL_HOLD','MEDIA_ASSET_NOT_FOUND','MEDIA_PURGE_BUSY'].includes(db.message ?? '')) break;
          throw new Error('MEDIA_PURGE_DISCOVERY_FAILED', { cause: error });
        }
      }
    }
    return rows.length === limit ? rows.at(-1)!.media_asset_id : null;
  } finally { sql.release(); }
}
export async function dueMediaPurges(database: postgres.Sql, tenantId: string, limit = 50): Promise<string[]> {
  const sql = await database.reserve();
  try {
    return await transaction(sql, tenantId, async () => (await sql<{ media_asset_id: string }[]>`
      SELECT * FROM app.media_purge_due(${limit})`).map(r => r.media_asset_id));
  } finally { sql.release(); }
}
