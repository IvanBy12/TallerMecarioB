'use strict';
// Test-only phase measurements. No query text, parameters, identity or URL is emitted.
const { AsyncLocalStorage } = require('node:async_hooks');
function installDownloadProbe(pool, limits) {
  const scope = new AsyncLocalStorage(), traces = [];
  const originalDownload = limits.reserveMediaDownload, originalReserve = pool.reserve;
  let inUse = 0, poolPeak = 0;
  limits.reserveMediaDownload = (database, signal) => {
    const trace = { start: performance.now(), sqlMs: 0, statements: 0, sqlErrors: [] };
    traces.push(trace);
    return scope.run(trace, async () => {
      try { return await originalDownload(database, signal); }
      catch (error) { trace.end = performance.now(); trace.failure = trace.nativeStart === undefined ? 'admission' : 'acquisition'; trace.code = error.code; throw error; }
    });
  };
  pool.reserve = async (...args) => {
    const trace = scope.getStore();
    if (!trace) return originalReserve(...args);
    trace.nativeStart = performance.now();
    const raw = await originalReserve(...args);
    trace.acquired = performance.now(); inUse++; poolPeak = Math.max(poolPeak, inUse);
    let released = false;
    const execute = async (query, text) => {
      const start = performance.now();
      try { const result = await query;
        if (text.includes('lock_current_tenant_owner_set')) trace.ownerLockAcquired = performance.now();
        if (text === 'COMMIT') trace.commit = performance.now();
        return result;
      } catch (error) { trace.sqlErrors.push(error.code); throw error; }
      finally { const elapsed = performance.now() - start; trace.sqlMs += elapsed; trace.statements++;
        if (text.includes('lock_current_tenant_owner_set')) trace.ownerLockMs = elapsed; }
    };
    return new Proxy(raw, {
      apply(target, self, args) { return execute(Reflect.apply(target, self, args), args[0].join('?')); },
      get(target, property, receiver) {
        if (property === 'unsafe') return (...values) => execute(Reflect.apply(target.unsafe, target, values), values[0]);
        if (property === 'release') return () => { if (!released) { released = true; inUse--; trace.end = performance.now(); } raw.release(); };
        return Reflect.get(target, property, receiver);
      },
    });
  };
  const distribution = values => {
    values.sort((a,b)=>a-b);
    return { count: values.length, p50: +((values[Math.floor(values.length/2)] ?? 0).toFixed(2)), max: +((values.at(-1) ?? 0).toFixed(2)) };
  };
  return {
    finish() {
      limits.reserveMediaDownload = originalDownload; pool.reserve = originalReserve;
      const phases = {
        queueMs: distribution(traces.map(t=>(t.nativeStart ?? t.end ?? performance.now())-t.start)),
        acquireMs: distribution(traces.filter(t=>t.acquired).map(t=>t.acquired-t.nativeStart)),
        sqlMs: distribution(traces.map(t=>t.sqlMs)),
        ownerLockMs: distribution(traces.filter(t=>t.ownerLockMs!==undefined).map(t=>t.ownerLockMs)),
        serializedTurnMs: distribution(traces.filter(t=>t.commit&&t.ownerLockAcquired).map(t=>t.commit-t.ownerLockAcquired)),
        statements: distribution(traces.map(t=>t.statements)),
        failedAdmission: traces.filter(t=>t.failure==='admission').length,
        failedAcquisition: traces.filter(t=>t.failure==='acquisition').length,
        sqlErrors: traces.flatMap(t=>t.sqlErrors), poolPeak, inUse,
      };
      return phases;
    },
  };
}
module.exports = { installDownloadProbe };
