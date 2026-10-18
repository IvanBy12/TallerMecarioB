import type postgres from 'postgres';
import { mediaQueryRetry } from './order-query-limits.js';

// Operational bounds, verified by the healthy-burst and contention matrix.
// These are not product limits or additional authorization inputs.
// 1s absorbs measured Linux scheduling/tenant-lock turns; 64 waiters and the
// pool.max - 1 active cap still bound load. It is not a production latency SLO.
export const MEDIA_DOWNLOAD_MAX_WAITERS = 64;
export const MEDIA_DOWNLOAD_ADMISSION_WAIT_MS = 1000;
interface Waiter {
  deadline: number;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  settled: boolean;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}
interface Admission { active: number; capacity: number; waiters: Waiter[] }
const admissions = new WeakMap<postgres.Sql, Admission>();
const boundedConnections = new WeakMap<postgres.ReservedSql, postgres.ReservedSql>();

/** Internal counters only; no tenant, identity, cursor or configuration data. */
export function mediaDownloadAdmissionSnapshot(database: postgres.Sql): { active: number; waiting: number } {
  const state = admissions.get(database);
  return { active: state?.active ?? 0, waiting: state?.waiters.length ?? 0 };
}
function finish(waiter: Waiter): void {
  waiter.settled = true;
  clearTimeout(waiter.timer);
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
}
function lease(state: Admission): () => void {
  state.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active--;
    drain(state);
  };
}
function drain(state: Admission): void {
  while (state.active < state.capacity && state.waiters.length) {
    const waiter = state.waiters.shift()!;
    finish(waiter);
    if (waiter.signal?.aborted || performance.now() >= waiter.deadline) waiter.reject(mediaQueryRetry());
    else waiter.resolve(lease(state));
  }
}
function acquireAdmission(database: postgres.Sql, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(mediaQueryRetry());
  let state = admissions.get(database);
  if (!state) {
    state = { active: 0, capacity: Math.max(1, database.options.max - 1), waiters: [] };
    admissions.set(database, state);
  }
  if (!state.waiters.length && state.active < state.capacity) return Promise.resolve(lease(state));
  if (state.waiters.length >= MEDIA_DOWNLOAD_MAX_WAITERS) return Promise.reject(mediaQueryRetry());
  const admission = state;
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { deadline: performance.now() + MEDIA_DOWNLOAD_ADMISSION_WAIT_MS,
      signal, settled: false, resolve, reject, onAbort: () => {} };
    const cancel = () => {
      if (waiter.settled) return;
      const index = admission.waiters.indexOf(waiter);
      if (index >= 0) admission.waiters.splice(index, 1);
      finish(waiter);
      reject(mediaQueryRetry());
    };
    waiter.onAbort = cancel;
    admission.waiters.push(waiter);
    waiter.timer = setTimeout(cancel, MEDIA_DOWNLOAD_ADMISSION_WAIT_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    // Never allow a new arrival to bypass an existing waiter. Expiration is
    // checked at handoff as well, even if the event loop delayed its timer.
    drain(admission);
  });
}

/** FIFO waiters consume no DB connection. A lease covers reservation, SQL and
 * rollback/release. On acquisition timeout or disconnect, a pending native
 * reservation retains its lease until it arrives and is released without BEGIN.
 * This prevents abandoned reservations from growing the driver queue forever. */
export async function reserveMediaDownload(database: postgres.Sql, signal?: AbortSignal): Promise<{
  sql: postgres.ReservedSql; releaseAdmission: () => void;
}> {
  const releaseAdmission = await acquireAdmission(database, signal);
  if (signal?.aborted) { releaseAdmission(); throw mediaQueryRetry(); }
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abandon); };
    const abandon = () => { if (abandoned) return; abandoned = true; cleanup(); reject(mediaQueryRetry()); };
    const timer = setTimeout(abandon, 2000);
    signal?.addEventListener('abort', abandon, { once: true });
    if (signal?.aborted) { abandon(); releaseAdmission(); return; }
    let reservation: Promise<postgres.ReservedSql>;
    try { reservation = database.reserve(); }
    catch (error) { cleanup(); releaseAdmission(); reject(error); return; }
    reservation.then(sql => {
      cleanup();
      if (abandoned || signal?.aborted) {
        sql.release(); releaseAdmission();
        if (!abandoned) reject(mediaQueryRetry());
      } else resolve({ sql, releaseAdmission });
    }, error => {
      cleanup(); releaseAdmission();
      if (!abandoned) reject(error);
    });
  });
}

/** Each statement has an 8s server-side budget and each lock wait 2s. These
 * are transaction-local and deliberately do not impose the gallery's 15s
 * operation deadline on historical downloads. Cleanup always uses raw SQL. */
export async function mediaDownloadSql(raw: postgres.ReservedSql, signal?: AbortSignal): Promise<postgres.ReservedSql> {
  const existing = boundedConnections.get(raw);
  if (existing) return existing;
  const execute = async (query: PromiseLike<unknown>) => {
    try {
      if (signal?.aborted) throw mediaQueryRetry();
      const result = await query;
      if (signal?.aborted) throw mediaQueryRetry();
      return result;
    }
    catch (error) {
      if (['55P03', '57014', '40P01'].includes((error as { code?: string }).code ?? '')) throw mediaQueryRetry();
      throw error;
    }
  };
  const bounded = new Proxy(raw, {
    apply(target, self, args) { return execute(Reflect.apply(target, self, args)); },
    get(target, property, receiver) {
      if (property === 'unsafe') return (...args: unknown[]) => execute(Reflect.apply(target.unsafe, target, args));
      return Reflect.get(target, property, receiver);
    },
  });
  await bounded`SET LOCAL statement_timeout='8s'`;
  await bounded`SET LOCAL lock_timeout='2s'`;
  boundedConnections.set(bounded, bounded);
  return bounded;
}
