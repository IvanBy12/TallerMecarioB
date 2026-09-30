'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { diagnoseNetwork, endpointTarget, probe, safeCode } = require('./r2-network.cjs');

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
  assert.deepEqual(calls, ['TCP', 'TLS', 'HTTP']);
  assert.deepEqual(emitted.at(-1), { sample: 1, phase: 'DNS', family: 6, ok: false, code: 'ENODATA' });
  assert.doesNotMatch(JSON.stringify(emitted), /sensitive|192\.0\.2\.1|secret|authorization/);
  assert.equal(safeCode({ code: 'SECRET_ACCESS_KEY' }), 'UNKNOWN');
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
