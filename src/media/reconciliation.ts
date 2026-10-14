import { createHmac, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { ReconciliationStorageError, type ReconciliationStorage, type StorageFailure } from './reconciliation-r2.js';

export interface MediaObservation {
  id: string; bucket: string; object_key: string; storage_provider: string; status: string;
  deletion_requested_at: Date | null; deleted_at: Date | null; purged_at: Date | null;
  held: boolean; pending: boolean; job_state: string | null; version: string;
}
export interface ReconciliationMetadata {
  page(tenant: string, after: string | null, limit: number, signal: AbortSignal): Promise<MediaObservation[]>;
  asset(tenant: string, id: string, signal: AbortSignal): Promise<MediaObservation | undefined>;
  exists(bucket: string, keys: string[], signal: AbortSignal): Promise<boolean[]>;
}
export type Classification = 'active_exists' | 'active_missing' | 'pending_upload' | 'incomplete_upload'
  | 'uploaded_unverified' | 'quarantined' | 'deletion_in_progress' | 'reconciliation_required'
  | 'purged_absent' | 'purged_object_present' | 'metadata_object' | 'orphan_candidate'
  | 'orphan_observation' | 'inventory_changed' | 'lifecycle_changed' | 'uncertain';
export interface RedactedObservation {
  ref: string; classification: Classification; storage: 'exists' | 'missing' | 'unknown'; held?: boolean; failure?: StorageFailure | 'database_failure' | 'metadata_configuration';
}
export interface TenantCoverage {
  ref: string; databaseRows: number; status: 'not_started' | 'partial' | 'complete' | 'failed';
}
export interface ReconciliationReport {
  version: 1; runId: string; startedAt: string; finishedAt: string;
  status: 'complete' | 'partial' | 'cancelled'; reason: 'finished' | 'budget' | 'cancelled' | 'database_failure' | 'storage_failure' | 'configuration';
  scope: 'configured_tenants'; tenantsRequested: number; tenantsWithRows: number; tenantCoverage: TenantCoverage[];
  databaseComplete: boolean; inventoryComplete: boolean; databaseRows: number; inventoryObjects: number;
  counts: Partial<Record<Classification, number>>; failures: Partial<Record<StorageFailure | 'database_failure' | 'metadata_configuration', number>>;
  samples: RedactedObservation[]; samplesTruncated: boolean;
  alerts: ('active_missing' | 'held_missing' | 'purged_object_present' | 'orphan_candidates' | 'scan_incomplete' | 'storage_access' | 'manual_reconciliation' | 'uncertain_observations' | 'scope_empty' | 'scope_coverage_gap')[];
  liveEvidence: { bucketPrivacy: 'pending'; credentialPermissions: 'pending' };
}
export interface ReconciliationOptions {
  tenantIds: string[]; bucket: string; reportKey: string; signal?: AbortSignal;
  pageSize?: number; maxDatabasePages?: number; maxInventoryPages?: number; concurrency?: number; maxDurationMs?: number;
}
function bound(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('MEDIA_RECONCILIATION_CONFIGURATION_INVALID');
  return result;
}
function lifecycle(row: MediaObservation, storage: 'exists' | 'missing'): Classification {
  if (row.job_state === 'reconciliation_required') return 'reconciliation_required';
  if (row.purged_at) return storage === 'exists' ? 'purged_object_present' : 'purged_absent';
  if (row.deleted_at || row.deletion_requested_at || row.status === 'deleted') return 'deletion_in_progress';
  if (row.pending) return 'pending_upload';
  if (row.status === 'pending_upload') return 'incomplete_upload';
  if (row.status === 'quarantined') return 'quarantined';
  if (row.status === 'uploaded') return 'uploaded_unverified';
  if (row.status === 'active') return storage === 'exists' ? 'active_exists' : 'active_missing';
  return 'uncertain';
}
/** Each report is a bounded point-in-time observation, never repair authority.
 * No SQL transaction or lifecycle lock is held across provider I/O. Re-read
 * asset + sessions + job after HEAD; any observed change is explicitly uncertain.
 * LIST absence is never used as proof of missing. Orphan promotion requires a
 * complete inventory and successful global metadata probes, regardless of tenant.
 */
export async function reconcileMedia(metadata: ReconciliationMetadata, storage: ReconciliationStorage,
  options: ReconciliationOptions): Promise<ReconciliationReport> {
  if (!options.bucket || options.bucket.length > 120 || options.reportKey.length < 32
    || options.tenantIds.length < 1 || options.tenantIds.length > 100
    || options.tenantIds.some(id => parseCanonicalUuid(id) !== id) || new Set(options.tenantIds).size !== options.tenantIds.length) {
    throw new Error('MEDIA_RECONCILIATION_CONFIGURATION_INVALID');
  }
  const pageSize = bound(options.pageSize, 50, 100), maxDb = bound(options.maxDatabasePages, 10, 100);
  const maxList = bound(options.maxInventoryPages, 10, 100), concurrency = bound(options.concurrency, 4, 16);
  const duration = bound(options.maxDurationMs, 30000, 120000);
  const deadline = AbortSignal.timeout(duration), signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const report: ReconciliationReport = { version: 1, runId: randomUUID(), startedAt: new Date().toISOString(), finishedAt: '',
    scope: 'configured_tenants', tenantsRequested: options.tenantIds.length, tenantsWithRows: 0, tenantCoverage: [],
    status: 'partial', reason: 'budget', databaseComplete: false, inventoryComplete: false, databaseRows: 0, inventoryObjects: 0,
    counts: {}, failures: {}, samples: [], samplesTruncated: false, alerts: [],
    liveEvidence: { bucketPrivacy: 'pending', credentialPermissions: 'pending' } };
  const ref = (kind: string, value: string) => createHmac('sha256', options.reportKey).update(`${kind}:${value}`).digest('hex');
  report.tenantCoverage = options.tenantIds.map(tenant => ({ ref: ref('tenant', tenant), databaseRows: 0, status: 'not_started' }));
  let heldMissing = false, dbFailed = false, storageFailed = false;
  const sampleLimit = 50;
  const sampleClass = (s: RedactedObservation) => s.failure ? `${s.classification}:${s.failure}`
    : s.classification === 'active_missing' && s.held ? 'held_missing' : s.classification;
  const samplePriority = (s: RedactedObservation) => ['held_missing', 'purged_object_present', 'reconciliation_required', 'active_missing'].indexOf(sampleClass(s));
  const sampleOrder = (s: RedactedObservation) => `${sampleClass(s)}:${s.ref}:${s.storage}:${s.held ?? false}:${s.failure ?? ''}`;
  const compareSamples = (a: RedactedObservation, b: RedactedObservation) => {
    const pa = samplePriority(a), pb = samplePriority(b);
    return (pa < 0 ? 4 : pa) - (pb < 0 ? 4 : pb) || sampleOrder(a).localeCompare(sampleOrder(b));
  };
  const record = (observation: RedactedObservation) => {
    report.counts[observation.classification] = (report.counts[observation.classification] ?? 0) + 1;
    if (observation.failure) report.failures[observation.failure] = (report.failures[observation.failure] ?? 0) + 1;
    if (observation.classification === 'active_missing' && observation.held) heldMissing = true;
    // Retain anomalies first; ordinary success counters are enough for logs.
    if (['active_exists', 'metadata_object', 'purged_absent'].includes(observation.classification)) return;
    // Reserve the smallest HMAC reference for EVERY observed class (held absence
    // is separate). Fill remaining slots by severity and stable reference order.
    // Streaming bottom-k selection is independent of completion/encounter order.
    const choices = [...report.samples, observation].sort(compareSamples);
    const champions = new Map<string, RedactedObservation>();
    for (const sample of choices) if (!champions.has(sampleClass(sample))) champions.set(sampleClass(sample), sample);
    if (champions.size > sampleLimit) throw new Error('MEDIA_RECONCILIATION_SAMPLES_UNACTIONABLE');
    const retained = [...champions.values()];
    const identities = new Set(retained.map(sampleOrder));
    for (const sample of choices) {
      if (identities.has(sampleOrder(sample))) continue;
      if (retained.length === sampleLimit) { report.samplesTruncated = true; continue; }
      retained.push(sample); identities.add(sampleOrder(sample));
    }
    report.samples = retained;
  };
  const dbFailure = () => { dbFailed = true; record({ ref: ref('scan', 'database'), classification: 'uncertain', storage: 'unknown', failure: 'database_failure' }); };
  const storageFailure = (value: string, error: unknown) => {
    storageFailed = true;
    const failure = error instanceof ReconciliationStorageError ? error.code : 'network_failure';
    record({ ref: ref('storage', value), classification: 'uncertain', storage: 'unknown', failure });
  };
  async function batch<T>(items: T[], work: (item: T) => Promise<void>) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!signal.aborted && index < items.length) { const item = items[index++]; await work(item); }
    }));
  }
  let pages = 0, finishedTenants = 0;
  for (const [tenantIndex, tenant] of options.tenantIds.entries()) {
    const coverage = report.tenantCoverage[tenantIndex];
    let after: string | null = null;
    while (!signal.aborted && pages < maxDb) {
      let rows: MediaObservation[];
      coverage.status = 'partial';
      try { rows = await metadata.page(tenant, after, pageSize, signal); } catch { coverage.status = 'failed'; dbFailure(); break; }
      pages++;
      if (rows.length > pageSize || rows.some((r, i) => !parseCanonicalUuid(r.id) || (i ? r.id <= rows[i - 1].id : after !== null && r.id <= after))) { coverage.status = 'failed'; dbFailure(); break; }
      if (rows.length && !coverage.databaseRows) report.tenantsWithRows++;
      coverage.databaseRows += rows.length;
      report.databaseRows += rows.length;
      await batch(rows, async row => {
        const reference = ref('asset', `${tenant}:${row.id}`);
        if (row.bucket !== options.bucket || row.storage_provider !== 'cloudflare_r2') {
          record({ ref: reference, classification: 'uncertain', storage: 'unknown', failure: 'metadata_configuration' }); return;
        }
        let observation: 'exists' | 'missing';
        try { observation = await storage.head(row.object_key, signal); } catch (error) { storageFailure(row.id, error); return; }
        let current: MediaObservation | undefined;
        try { current = await metadata.asset(tenant, row.id, signal); } catch { dbFailure(); return; }
        if (!current || row.version !== current.version) {
          record({ ref: reference, classification: 'lifecycle_changed', storage: 'unknown' }); return;
        }
        record({ ref: reference, classification: lifecycle(current, observation), storage: observation, held: current.held });
      });
      if (rows.length < pageSize && !signal.aborted && !dbFailed) { coverage.status = 'complete'; finishedTenants++; break; }
      after = rows.at(-1)?.id ?? after;
    }
    if (dbFailed || signal.aborted || pages >= maxDb) break;
  }
  report.databaseComplete = finishedTenants === options.tenantIds.length && !dbFailed && !signal.aborted;
  let token: string | undefined;
  const seenTokens = new Set<string>(), seenKeys = new Set<string>(), provisional: string[] = [];
  for (let page = 0; page < maxList && !signal.aborted; page++) {
    let inventory;
    try { inventory = await storage.list('', pageSize, token, signal); } catch (error) { storageFailure('inventory', error); break; }
    if (inventory.keys.length > pageSize || inventory.keys.some(key => !key || seenKeys.has(key))
      || new Set(inventory.keys).size !== inventory.keys.length
      || (inventory.truncated && (!inventory.nextToken || seenTokens.has(inventory.nextToken) || !inventory.keys.length))) {
      storageFailure('inventory', new ReconciliationStorageError('protocol_failure')); break;
    }
    inventory.keys.forEach(key => seenKeys.add(key));
    report.inventoryObjects += inventory.keys.length;
    let matches: boolean[];
    try { matches = inventory.keys.length ? await metadata.exists(options.bucket, inventory.keys, signal) : []; }
    catch { dbFailure(); break; }
    if (matches.length !== inventory.keys.length || matches.some(m => typeof m !== 'boolean')) { dbFailure(); break; }
    inventory.keys.forEach((key, i) => {
      if (matches[i]) record({ ref: ref('object', key), classification: 'metadata_object', storage: 'exists' });
      else provisional.push(key);
    });
    if (!inventory.truncated) { report.inventoryComplete = true; break; }
    token = inventory.nextToken;
    seenTokens.add(token!);
  }
  const candidates: RedactedObservation[] = [];
  // Recheck provider presence AND global metadata after the listing. A committed
  // create/completion wins over stale inventory; historical/tombstone rows match.
  if (report.inventoryComplete && report.databaseComplete && !dbFailed && !signal.aborted) {
    await batch(provisional, async key => {
      let observation: 'exists' | 'missing';
      try { observation = await storage.head(key, signal); } catch (error) { storageFailure('candidate', error); return; }
      let matches: boolean[];
      try { matches = await metadata.exists(options.bucket, [key], signal); } catch { dbFailure(); return; }
      if (matches.length !== 1 || typeof matches[0] !== 'boolean') { dbFailure(); return; }
      candidates.push({ ref: ref('object', key), classification: matches[0] ? 'metadata_object'
        : observation === 'missing' ? 'inventory_changed' : 'orphan_candidate', storage: observation });
    });
  }
  const canPromote = report.databaseComplete && report.inventoryComplete && !dbFailed && !storageFailed && !report.failures.metadata_configuration && !signal.aborted;
  for (const candidate of candidates) record(candidate.classification === 'orphan_candidate' && !canPromote
    ? { ...candidate, classification: 'orphan_observation' } : candidate);
  const processed = new Set(candidates.map(c => c.ref));
  for (const key of provisional) if (!processed.has(ref('object', key))) record({ ref: ref('object', key), classification: 'orphan_observation', storage: 'unknown' });
  report.status = options.signal?.aborted ? 'cancelled' : canPromote ? 'complete' : 'partial';
  report.reason = options.signal?.aborted ? 'cancelled' : deadline.aborted ? 'budget'
    : dbFailed ? 'database_failure' : storageFailed ? 'storage_failure' : report.failures.metadata_configuration ? 'configuration' : canPromote ? 'finished' : 'budget';
  if (report.counts.uncertain || report.counts.lifecycle_changed || report.counts.orphan_observation) report.alerts.push('uncertain_observations');
  if (report.counts.active_missing) report.alerts.push('active_missing');
  if (heldMissing) report.alerts.push('held_missing');
  if (report.counts.purged_object_present) report.alerts.push('purged_object_present');
  if (report.counts.orphan_candidate) report.alerts.push('orphan_candidates');
  if (report.counts.reconciliation_required) report.alerts.push('manual_reconciliation');
  if (report.status !== 'complete') report.alerts.push('scan_incomplete');
  // Empty coverage describes completed metadata sweeps, never failed/unvisited ones.
  if (report.databaseComplete && report.databaseRows === 0) report.alerts.push('scope_empty');
  else if (report.tenantCoverage.some(t => t.status === 'complete' && t.databaseRows === 0)) report.alerts.push('scope_coverage_gap');
  if (report.failures.access_denied || report.failures.not_found || report.failures.metadata_configuration || report.failures.configuration) report.alerts.push('storage_access');
  report.finishedAt = new Date().toISOString();
  report.samples.sort(compareSamples);
  report.tenantCoverage.sort((a, b) => a.ref.localeCompare(b.ref));
  return report;
}

/** Transactions have fixed read-only mode, bounded SQL and transaction-local
 * tenant context. Queries finish within the SQL timeout; reserve cancellation
 * releases any late-arriving connection. No external I/O runs inside them.
 */
export function createReconciliationMetadata(database: postgres.Sql): ReconciliationMetadata {
  async function read<T>(tenant: string | null, signal: AbortSignal, work: (sql: postgres.ReservedSql) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error('MEDIA_RECONCILIATION_CANCELLED');
    let sql: postgres.ReservedSql | undefined;
    let abort: (() => void) | undefined;
    const reservation = database.reserve();
    try {
      sql = await Promise.race([reservation, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('MEDIA_RECONCILIATION_CANCELLED'));
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } catch (error) { void reservation.then(late => late.release()).catch(() => undefined); throw error; }
    finally { if (abort) signal.removeEventListener('abort', abort); }
    try {
      await sql`BEGIN READ ONLY`;
      await sql`SET LOCAL statement_timeout='2s'`;
      await sql`SET LOCAL lock_timeout='500ms'`;
      await sql`SELECT set_config('app.tenant_id',${tenant ?? ''},true)`;
      if (signal.aborted) throw new Error('MEDIA_RECONCILIATION_CANCELLED');
      const result = await work(sql);
      if (signal.aborted) throw new Error('MEDIA_RECONCILIATION_CANCELLED');
      await sql`COMMIT`;
      return result;
    } finally { await sql`ROLLBACK`.catch(() => undefined); sql.release(); }
  }
  // Only allowlisted operational columns; fingerprint all lifecycle sources
  // including B05 floors/holds and B06 parked/storage outcomes. No PII read.
  const selection = `SELECT m.id,m.bucket,m.object_key,m.storage_provider,m.status,m.deletion_requested_at,m.deleted_at,m.purged_at,
    coalesce(m.legal_hold_until>clock_timestamp(),false) AS held,
    EXISTS(SELECT 1 FROM public.upload_sessions s WHERE s.tenant_id=m.tenant_id AND s.media_asset_id=m.id
      AND s.status='pending' AND s.expires_at>clock_timestamp()) AS pending,
    (SELECT j.state FROM public.media_purge_jobs j WHERE j.tenant_id=m.tenant_id AND j.media_asset_id=m.id) AS job_state,
    md5(jsonb_build_array(m.id,m.bucket,m.object_key,m.storage_provider,m.status,m.retention_until,m.legal_hold_until,
      m.deletion_requested_at,m.deleted_at,m.purged_at,
      (SELECT jsonb_agg(jsonb_build_array(s.status,s.expires_at,s.created_at) ORDER BY s.created_at,s.expires_at,s.status)
        FROM public.upload_sessions s WHERE s.tenant_id=m.tenant_id AND s.media_asset_id=m.id),
      (SELECT jsonb_build_array(j.state,j.storage_outcome) FROM public.media_purge_jobs j WHERE j.tenant_id=m.tenant_id AND j.media_asset_id=m.id))::text) AS version
    FROM public.media_assets m WHERE m.tenant_id=$1::uuid`;
  return {
    page: (tenant, after, limit, signal) => read(tenant, signal, async sql => {
      if (!parseCanonicalUuid(tenant) || (after && !parseCanonicalUuid(after)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('MEDIA_RECONCILIATION_INPUT_INVALID');
      return await sql.unsafe<MediaObservation[]>(`${selection} AND ($2::uuid IS NULL OR m.id>$2::uuid) ORDER BY m.id LIMIT $3`, [tenant, after, limit]);
    }),
    asset: (tenant, id, signal) => read(tenant, signal, async sql => (await sql.unsafe<MediaObservation[]>(`${selection} AND m.id=$2::uuid`, [tenant, id]))[0]),
    exists: (bucket, keys, signal) => read(null, signal, async sql => (await sql<{ metadata_exists: boolean }[]>`
      SELECT metadata_exists FROM app.media_storage_metadata_exists(${bucket},${keys}::text[])`).map(r => r.metadata_exists)),
  };
}
