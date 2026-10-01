'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const tls = require('node:tls');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { diagnoseNetwork, endpointTarget, probe, safeCode, evaluateNetworkDiagnostic } = require('./r2-network.cjs');

test('network diagnostics distinguish DNS/family/TCP/TLS/HTTP without emitting targets or errors', async () => {
  const emitted = [];
  const calls = [];
  await diagnoseNetwork('https://sensitive-account.invalid', {
    samples: 1, emit: (row) => emitted.push(row),
    lookup: async (_hostname, { family }) => {
      if (family === 6) throw Object.assign(new Error('secret URL and authorization'), { code: 'ENODATA' });
      return [{ address: '192.0.2.1', family: 4 }];
    },
    connect: async (_target, _address, family, phase) => {
      calls.push(phase);
      return { phase, family, ok: phase !== 'TLS', ...(phase === 'HTTP' ? { status: 403 } : {}) };
    },
  });
  assert.deepEqual(calls, ['TCP', 'TLS']);
  assert.deepEqual(emitted.at(-1), { sample: 1, phase: 'DNS', family: 6, ok: false, code: 'ENODATA' });
  assert.doesNotMatch(JSON.stringify(emitted), /sensitive|192\.0\.2\.1|secret|authorization/);
  assert.equal(safeCode({ code: 'SECRET_ACCESS_KEY' }), 'UNKNOWN');
});

async function scenario(fail, samples = 1) {
  const calls = [];
  const rows = await diagnoseNetwork('https://sensitive-account.invalid', {
    samples, emit: () => {},
    lookup: async (_host, { family }) => [{ address: family === 4 ? '192.0.2.1' : '2001:db8::1' }],
    connect: async (_target, _address, family, phase) => {
      calls.push({ family, phase });
      const sample = calls.filter((call) => call.family === 4 && call.phase === 'TCP').length;
      return { ok: !fail(family, phase, sample), code: 'ENETUNREACH', status: 403 };
    },
  });
  return { rows, calls, result: evaluateNetworkDiagnostic(rows) };
}

test('A/D: IPv4 usable and IPv6 TCP ENETUNREACH passes, skipping IPv6 TLS/HTTP', async () => {
  const { calls, result } = await scenario((family) => family === 6);
  assert.deepEqual(calls.filter((call) => call.family === 6), [{ family: 6, phase: 'TCP' }]);
  assert.deepEqual(result, { ok: true, samples: 1, usableSamples: 1, ipv4Usable: true, ipv6Usable: false });
});

test('B: IPv6 alone can provide a complete usable route', async () => {
  const { result } = await scenario((family) => family === 4);
  assert.equal(result.ok, true);
  assert.equal(result.ipv4Usable, false);
  assert.equal(result.ipv6Usable, true);
});

test('C/E: TLS failures skip HTTP and neither family usable fails', async () => {
  const { calls, result } = await scenario((_family, phase) => phase === 'TLS');
  assert.equal(calls.some((call) => call.phase === 'HTTP'), false);
  assert.equal(result.ok, false);
  assert.equal(result.usableSamples, 0);
});

test('F: all three samples require and have a complete route', async () => {
  const { result } = await scenario((family) => family === 6, 3);
  assert.deepEqual(result, { ok: true, samples: 3, usableSamples: 3, ipv4Usable: true, ipv6Usable: false });
});

test('G: a single unusable sample fails the diagnostic', async () => {
  const { result } = await scenario((family, _phase, sample) => family === 6 || sample === 2, 3);
  assert.equal(result.ok, false);
  assert.equal(result.samples, 3);
  assert.equal(result.usableSamples, 2);
});

test('complete phases must share the same family and address; DNS-only and empty fail', () => {
  const rows = ['TCP', 'TLS', 'HTTP'].map((phase, index) => ({ sample: 1, family: 4, address: index + 1, phase, ok: true }));
  assert.equal(evaluateNetworkDiagnostic(rows).ok, false);
  assert.equal(evaluateNetworkDiagnostic([{ sample: 1, phase: 'DNS', ok: true }]).ok, false);
  assert.equal(evaluateNetworkDiagnostic([]).ok, false);
});

test('TCP failure proceeds to next address, which can succeed', async () => {
  const calls = [];
  const rows = await diagnoseNetwork('https://host.invalid', {
    samples: 1, emit: () => {},
    lookup: async () => [{ address: '192.0.2.1' }, { address: '192.0.2.2' }],
    connect: async (_target, address, _family, phase) => {
      calls.push([address, phase]);
      return { ok: address.endsWith('.2'), code: 'EHOSTUNREACH' };
    },
  });
  assert.equal(calls.filter(([address]) => address.endsWith('.1')).length, 2);
  assert.equal(evaluateNetworkDiagnostic(rows).ok, true);
});

test('H: rows and evaluation whitelist data and sanitize thrown errors', async () => {
  const sensitive = 'sensitive-account.invalid 192.0.2.1 2001:db8::1 authorization access-key secret-key https://host/key?X-Amz-Signature=secret';
  const rows = await diagnoseNetwork('https://sensitive-account.invalid', {
    samples: 1, emit: () => {}, lookup: async () => [{ address: '192.0.2.1' }],
    connect: async (_target, _address, family) => {
      if (family === 6) throw Object.assign(new Error(sensitive), { code: sensitive });
      return { ok: false, code: 'ECONNRESET', hostname: sensitive, error: new Error(sensitive), url: sensitive };
    },
  });
  const output = JSON.stringify({ rows, evaluation: evaluateNetworkDiagnostic(rows) });
  assert.doesNotMatch(output, /sensitive|192\.0\.2|2001:db8|authorization|access-key|secret-key|Signature|stack|hostname/);
  assert.equal(rows.find((row) => row.family === 6 && row.phase === 'TCP').code, 'UNKNOWN');
});

test('socket/request listeners handle errors emitted during destroy, including underlying HTTP TLS socket', async (t) => {
  for (const phase of ['TCP', 'TLS', 'HTTP']) {
    for (const code of ['ENETUNREACH', 'ECONNRESET', 'EHOSTUNREACH', 'DIAGNOSTIC_TIMEOUT']) {
      const socket = new EventEmitter();
      socket.destroy = () => socket.emit('error', Object.assign(new Error('sensitive target'), { code }));
      const start = () => {
        if (code !== 'DIAGNOSTIC_TIMEOUT') queueMicrotask(() => socket.emit('error', { code }));
        return socket;
      };
      if (phase === 'TCP') t.mock.method(net, 'connect', start);
      if (phase === 'TLS') t.mock.method(tls, 'connect', start);
      if (phase === 'HTTP') t.mock.method(https, 'request', () => {
        const request = new EventEmitter();
        request.destroy = () => request.emit('error', { code });
        request.end = () => { request.emit('socket', socket); start(); };
        return request;
      });
      const result = await probe({ hostname: 'host.invalid', port: 443 }, '192.0.2.1', 4, phase, 10);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      socket.emit('error', { code });
      t.mock.restoreAll();
    }
  }
});

test('CLI awaits evaluation, prints sanitized summary, and returns nonzero for unusable routes', () => {
  for (const usable of [true, false]) {
    const child = spawnSync(process.execPath, ['-e', `
      const diagnostic = require('./tests/media/r2-network.cjs');
      diagnostic.diagnoseNetwork = async () => [1, 2, 3].flatMap(sample =>
        ['TCP', 'TLS', 'HTTP'].map(phase => ({ sample, family: 4, address: 1, phase, ok: ${usable} })));
      require('./scripts/diagnose-r2-network.cjs');
    `], { cwd: require('node:path').resolve(__dirname, '../..'), encoding: 'utf8' });
    assert.equal(child.status, usable ? 0 : 1);
    assert.equal(child.stdout, usable ? 'R2_NETWORK_DIAGNOSTIC_PASS samples=3 usable_samples=3 ipv4_usable=true ipv6_usable=false\n' : '');
    assert.equal(child.stderr, usable ? '' : 'R2_NETWORK_DIAGNOSTIC_FAILED\n');
  }
});

test('diagnostics reject credentials, signed URLs and object paths', () => {
  for (const endpoint of ['https://host.invalid/key', 'https://host.invalid/?X-Amz-Signature=secret',
    'https://user:secret@host.invalid', 'http://host.invalid']) {
    assert.throws(() => endpointTarget(endpoint), /R2_DIAGNOSTIC_ENDPOINT_INVALID/);
  }
});

test('TCP probe succeeds locally and TLS probe times out with bounded resource cleanup', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = { hostname: 'localhost', port: server.address().port };
    assert.equal((await probe(target, '127.0.0.1', 4, 'TCP', 1000)).ok, true);
    const result = await probe(target, '127.0.0.1', 4, 'TLS', 100);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DIAGNOSTIC_TIMEOUT');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
