'use strict';

const RETRY_DELAYS_MS = [100, 300];
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'DELETE']);
const TRANSIENT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
let transientFailures = 0;

function errorCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(current.code)) {
      return current.code;
    }
    if (typeof current.message === 'string' && /^R2_(?:HEAD|DELETE)_FAILED_\d{3}$/.test(current.message)) {
      return current.message;
    }
    current = current.cause;
  }
  return 'UNKNOWN';
}

async function withR2Stage(stage, method, operation, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(stage)) throw new Error('INVALID_R2_STAGE');
  const retryableMethod = RETRYABLE_METHODS.has(method);
  const attempts = retryableMethod ? RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = errorCode(error);
      if (TRANSIENT_CODES.has(code)) {
        transientFailures += 1;
        if (process.env.R2_EXTERNAL_GATE === '1') {
          process.stdout.write(`R2_TRANSPORT ${stage} ${method} ${code} attempt=${attempt + 1}/${attempts}\n`);
        }
      }
      if (attempt === attempts - 1 || !TRANSIENT_CODES.has(code)) {
        // Never attach the original error: fetch errors may contain signed URLs.
        throw new Error(`R2 ${stage} failed: ${code} (attempt ${attempt + 1}/${attempts})`);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error('UNREACHABLE_R2_RETRY_STATE');
}

module.exports = { withR2Stage, getTransientFailures: () => transientFailures };
