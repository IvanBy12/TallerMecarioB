import type postgres from 'postgres';
import { MediaError } from './errors.js';

export const ORDER_MEDIA_GRAPH_BUDGET = 1000;
const requestDeadlines = new WeakMap<object, number>();
const boundedConnections = new WeakMap<postgres.ReservedSql, { raw: postgres.ReservedSql; deadline: number }>();
export const mediaQueryRetry = () => new MediaError(503, 'MEDIA_QUERY_RETRY', 'The media query could not be completed. Please try again.');
export function startOrderMediaRequest(request: object): void { requestDeadlines.set(request, performance.now() + 15000); }
export function orderMediaDeadline(request: object): number | undefined { return requestDeadlines.get(request); }
export function assertOrderMediaDeadline(deadline: number): number {
  const value = Math.floor(deadline - performance.now());
  if (value < 1) throw mediaQueryRetry();
  return value;
}

/** Bound identity and pool waits too. A late reservation is released without
 * BEGIN, tenant GUCs or queries; a late identity never resumes the pipeline. */
export async function awaitOrderMediaStep<T>(work: PromiseLike<T>, deadline: number,
  disposeLate?: (value: T) => void): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = Promise.resolve(work).then(value => {
    if (expired || performance.now() >= deadline) { disposeLate?.(value); throw mediaQueryRetry(); }
    return value;
  });
  try {
    return await Promise.race([result, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(mediaQueryRetry()); }, Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

/** Same reserved connection. The server cancels each statement at min(8s,
 * remaining request budget), avoiding late protocol cancellation packets that
 * could race a rollback or another request on a reused connection. */
export function orderMediaSql(sql: postgres.ReservedSql, deadline: number): postgres.ReservedSql {
  const existing = boundedConnections.get(sql);
  if (existing && existing.deadline <= deadline) return sql;
  if (existing) sql = existing.raw;
  const execute = async (query: PromiseLike<unknown>) => {
    try {
      const timeout = Math.min(8000, assertOrderMediaDeadline(deadline));
      await sql`SELECT pg_catalog.set_config('statement_timeout', ${String(timeout)}, true)`;
      assertOrderMediaDeadline(deadline);
      const result = await query;
      assertOrderMediaDeadline(deadline);
      return result;
    } catch (error) {
      if (['55P03', '57014', '40P01'].includes((error as { code?: string }).code ?? '')) throw mediaQueryRetry();
      throw error;
    }
  };
  const bounded = new Proxy(sql, {
    apply(target, self, args) { assertOrderMediaDeadline(deadline); return execute(Reflect.apply(target, self, args)); },
    get(target, property, receiver) {
      if (property === 'unsafe') return (...args: unknown[]) => {
        assertOrderMediaDeadline(deadline); return execute(Reflect.apply(target.unsafe, target, args));
      };
      return Reflect.get(target, property, receiver);
    },
  });
  boundedConnections.set(bounded, { raw: sql, deadline });
  return bounded;
}

export async function withOrderMediaLimits<T>(sql: postgres.ReservedSql,
  work: (bounded: postgres.ReservedSql) => Promise<T>, deadline = performance.now() + 15000): Promise<T> {
  const bounded = orderMediaSql(sql, deadline);
  await bounded`SET LOCAL lock_timeout='2s'`;
  const result = await work(bounded);
  assertOrderMediaDeadline(deadline);
  return result;
}
