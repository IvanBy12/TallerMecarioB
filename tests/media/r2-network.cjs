'use strict';

// Test-only, unsigned HEAD / probes. Never accept a signed URL or object key.
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { performance } = require('node:perf_hooks');

const SAFE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ETIMEDOUT',
  'EACCES', 'EPERM', 'ENOENT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'DIAGNOSTIC_TIMEOUT']);

function safeCode(error) {
  return SAFE_CODES.has(error?.code) ? error.code : 'UNKNOWN';
}

function endpointTarget(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/') throw new Error('R2_DIAGNOSTIC_ENDPOINT_INVALID');
  return { hostname: url.hostname, port: Number(url.port || 443) };
}

function probe(target, address, family, phase, timeoutMs) {
  return new Promise((resolve) => {
    let socket;
    let request;
    const start = performance.now();
    const timer = setTimeout(() => finish({ ok: false, code: 'DIAGNOSTIC_TIMEOUT' }), timeoutMs);
    let finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request?.destroy();
      socket?.destroy();
      resolve({ phase, family, ...result, ms: Math.round(performance.now() - start) });
    }
    const options = { host: address, port: target.port, family };
    const onError = (error) => finish({ ok: false, code: safeCode(error) });
    if (phase === 'TCP') {
      socket = net.connect(options, () => finish({ ok: true }));
      socket.on('error', onError);
    } else if (phase === 'TLS') {
      socket = tls.connect({ ...options, servername: target.hostname,
        rejectUnauthorized: true }, () => finish({ ok: true }));
      socket.on('error', onError);
    } else {
      request = https.request({ hostname: target.hostname, port: target.port,
        servername: target.hostname, method: 'HEAD', path: '/', agent: false,
        autoSelectFamily: false,
        lookup: (_host, _options, callback) => callback(null, address, family) },
      (response) => {
        response.resume();
        finish({ ok: true, status: response.statusCode });
      });
      request.on('error', onError);
      request.end();
    }
  });
}

async function diagnoseNetwork(endpoint, { emit = (row) => process.stdout.write(`R2_NETWORK ${JSON.stringify(row)}\n`),
  lookup = dns.lookup, connect = probe, samples = 3, timeoutMs = 5000 } = {}) {
  const target = endpointTarget(endpoint);
  const rows = [];
  const record = (row) => { rows.push(row); emit(row); };
  for (let sample = 1; sample <= samples; sample += 1) {
    for (const family of [4, 6]) {
      let addresses;
      try {
        addresses = await lookup(target.hostname, { family, all: true });
        record({ sample, phase: 'DNS', family, ok: true, count: addresses.length });
      } catch (error) {
        record({ sample, phase: 'DNS', family, ok: false, code: safeCode(error) });
        continue;
      }
      // Bound cost; record address ordinals, never account hostname or IPs.
      for (const [index, entry] of addresses.slice(0, 2).entries()) {
        for (const phase of ['TCP', 'TLS', 'HTTP']) {
          record({ sample, address: index + 1,
            ...await connect(target, entry.address, family, phase, timeoutMs) });
        }
      }
    }
  }
  return rows;
}

module.exports = { diagnoseNetwork, endpointTarget, probe, safeCode };
