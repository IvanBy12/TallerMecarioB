/**
 * Arquitectura Técnica v1 §16: `/health/live` verifies the process is up;
 * `/health/ready` verifies essential internal dependencies. WhatsApp/Wompi
 * being down must not flip the whole API unready -- they are async, via
 * outbox/worker, so the only essential synchronous dependency here is
 * PostgreSQL. R2 is not checked: signing a URL is pure local crypto (see
 * ../media/r2.ts), it never calls out to R2 itself.
 */

// `unknown` return (not `Promise<...>`): postgres.js's tagged-template call
// returns a thenable `Helper` whose `then` TypeScript sees as private, so it
// fails structural assignability against `PromiseLike`/`Promise` return
// types even though it is perfectly awaitable at runtime. Wrapping the call
// result in `Promise.resolve` below sidesteps that without weakening the
// actual check.
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('READINESS_CHECK_TIMEOUT')), ms);
  });
}

/** Never throws: a failed/slow check means "not ready", not a route error. */
export async function checkDatabaseReady(database: SqlTag, timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([Promise.resolve(database`SELECT 1`), timeout(timeoutMs)]);
    return true;
  } catch {
    return false;
  }
}
