'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const root = process.env.TEST_WOMPI_MODULE_ROOT;
if (!root) throw new Error('TEST_WOMPI_MODULE_ROOT is required');
const { WompiAdapter } = require(join(root, 'integrations/wompi/adapter.js'));
const { WompiAdapterError } = require(join(root, 'integrations/wompi/errors.js'));
const { normalizeWompiTransaction } = require(join(root, 'integrations/wompi/contracts.js'));
const { createTransactionIntegritySignature, createWebhookChecksum } = require(join(root, 'integrations/wompi/crypto.js'));
const { verifyWompiWebhook } = require(join(root, 'integrations/wompi/webhook.js'));
const { handleSubscriptionChargeRequested } = require(join(root, 'integrations/wompi/outbox-handler.js'));
const { loadWompiConfig } = require(join(root, 'integrations/wompi/config.js'));
const { subscriptionStatusAfterWompiPayment } = require(join(root, 'integrations/wompi/subscription-state.js'));
const { registerWompiWebhookRoute } = require(join(root, 'integrations/wompi/routes.js'));
const { buildApi } = require(join(root, 'api/app.js'));

const testConfig = {
  environment: 'test',
  baseUrl: 'https://wompi.test/v1',
  privateKey: 'prv_test_private-not-real',
  publicKey: 'pub_test_public-not-real',
  integritySecret: 'test_integrity_not-real',
  maxAttempts: 4,
  timeoutMs: 100,
  baseRetryDelayMs: 10,
  maxRetryDelayMs: 1_000,
  allowCustomBaseUrl: true,
};

function response(status, body, headers = {}) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function transaction(overrides = {}) {
  return {
    id: 'tx-sandbox-1',
    reference: 'ilvox_pay_018f0f40-9d89-7a4c-8b6e-82c54f690111',
    status: 'PENDING',
    amount_in_cents: 4990000,
    currency: 'COP',
    ...overrides,
  };
}

function signedWebhook(overrides = {}) {
  const eventSecret = 'test_events_secret-not-real';
  const event = {
    event: 'transaction.updated',
    data: { transaction: transaction({ status: 'APPROVED' }) },
    environment: 'test',
    signature: {
      properties: ['transaction.amount_in_cents', 'transaction.id', 'transaction.status'],
      checksum: '0'.repeat(64),
    },
    timestamp: 1789786800,
    sent_at: '2026-09-19T03:00:00.000Z',
    ...overrides,
  };
  event.signature.checksum = createWebhookChecksum(event, eventSecret);
  return { event, eventSecret, rawBody: Buffer.from(JSON.stringify(event)) };
}

test('transaction integrity signature uses reference + amount + currency + integrity secret', () => {
  const signature = createTransactionIntegritySignature({
    reference: 'ORDER-1', amountMinor: 50000, currency: 'COP', integritySecret: 'test_integrity_secret',
  });
  assert.equal(signature, '81f8f348134103a9b1d7e8f0f48c70be9e8156fadf144eeeabe93084f4e6058f');
});

test('WOMPI_ENABLED defaults false and enabled mode fails fast unless all secrets exist', () => {
  assert.deepEqual(loadWompiConfig({}), { enabled: false });
  assert.deepEqual(loadWompiConfig({ WOMPI_ENABLED: 'false' }), { enabled: false });

  const enabled = {
    WOMPI_ENABLED: 'true', WOMPI_ENVIRONMENT: 'test',
    WOMPI_PUBLIC_KEY: 'pub_test_unit-only', WOMPI_PRIVATE_KEY: 'prv_test_unit-only',
    WOMPI_INTEGRITY_SECRET: 'test_integrity_unit-only', WOMPI_EVENTS_SECRET: 'test_events_unit-only',
  };
  for (const name of ['WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET']) {
    const missing = { ...enabled };
    delete missing[name];
    assert.throws(() => loadWompiConfig(missing), new RegExp(`${name}_REQUIRED`));
  }
  const loaded = loadWompiConfig(enabled);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.baseUrl, 'https://sandbox.wompi.co/v1');
});

test('adapter creates canonical transaction payload without exposing the private key in results', async () => {
  let request;
  const adapter = new WompiAdapter(testConfig, {
    fetch: async (url, options) => {
      request = { url, options, payload: JSON.parse(options.body) };
      return response(201, { data: transaction() });
    },
  });
  const result = await adapter.createTransaction({
    acceptanceToken: 'acceptance-token',
    personalDataAuthToken: 'personal-auth-token',
    amountMinor: 4990000,
    currency: 'COP',
    customerEmail: 'billing@example.invalid',
    paymentMethod: { installments: 1 },
    reference: transaction().reference,
    paymentSourceId: '3891',
    recurrent: true,
  });
  assert.equal(request.url, 'https://wompi.test/v1/transactions');
  assert.equal(request.options.headers.authorization, `Bearer ${testConfig.privateKey}`);
  assert.deepEqual(Object.keys(request.payload).sort(), [
    'accept_personal_auth', 'acceptance_token', 'amount_in_cents', 'currency', 'customer_email',
    'payment_method', 'payment_source_id', 'recurrent', 'reference', 'signature',
  ]);
  assert.equal(request.payload.payment_source_id, 3891);
  assert.equal(result.localStatus, 'pending');
  assert.equal(JSON.stringify(result).includes(testConfig.privateKey), false);
});

test('adapter never accepts PAN or CVV fields', async () => {
  const adapter = new WompiAdapter(testConfig, { fetch: async () => { throw new Error('must not call'); } });
  await assert.rejects(adapter.createTransaction({
    acceptanceToken: 'token', amountMinor: 1000, currency: 'COP', customerEmail: 'a@example.invalid',
    paymentMethod: { card_number: '4242424242424242', cvv: '123' },
    reference: transaction().reference,
  }), /RAW_PAYMENT_INSTRUMENT_FORBIDDEN/);
});

test('adapter creates a payment source from an opaque token only', async () => {
  let payload;
  const adapter = new WompiAdapter(testConfig, {
    fetch: async (_url, options) => {
      payload = JSON.parse(options.body);
      return response(201, { data: { id: 3891, status: 'AVAILABLE' } });
    },
  });
  const source = await adapter.createPaymentSource({
    type: 'CARD', token: 'tok_test_opaque', customerEmail: 'billing@example.invalid',
    acceptanceToken: 'acceptance-token', personalDataAuthToken: 'personal-auth-token',
  });
  assert.deepEqual(source, { id: '3891', status: 'AVAILABLE' });
  assert.deepEqual(Object.keys(payload).sort(), [
    'accept_personal_auth', 'acceptance_token', 'customer_email', 'token', 'type',
  ]);
});

test('all canonical Wompi statuses normalize to Dictionary payment statuses', () => {
  const expected = {
    PENDING: 'pending', APPROVED: 'approved', DECLINED: 'declined', ERROR: 'error', VOIDED: 'voided',
  };
  for (const [providerStatus, localStatus] of Object.entries(expected)) {
    assert.equal(normalizeWompiTransaction(transaction({ status: providerStatus })).localStatus, localStatus);
  }
});

test('adapter retries 5xx and honors Retry-After for 429, then succeeds', async () => {
  const waits = [];
  let calls = 0;
  const adapter = new WompiAdapter(testConfig, {
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      calls += 1;
      if (calls === 1) return response(503, { error: 'unavailable' });
      if (calls === 2) return response(429, { error: 'limited' }, { 'retry-after': '2' });
      return response(200, { data: transaction({ status: 'APPROVED' }) });
    },
  });
  const result = await adapter.getTransaction('tx-sandbox-1');
  assert.equal(result.localStatus, 'approved');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 1000]);
});

test('adapter treats a duplicate reference 422 as a permanent error and does not retry', async () => {
  let calls = 0;
  const adapter = new WompiAdapter(testConfig, {
    fetch: async () => { calls += 1; return response(422, { error: 'duplicate reference' }); },
  });
  await assert.rejects(adapter.createTransaction({
    acceptanceToken: 'acceptance-token', amountMinor: 4990000, currency: 'COP',
    customerEmail: 'billing@example.invalid', paymentMethod: { installments: 1 },
    reference: transaction().reference, paymentSourceId: '3891', recurrent: true,
  }), (error) => {
    assert.ok(error instanceof WompiAdapterError);
    assert.equal(error.code, 'WOMPI_VALIDATION_REJECTED');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('adapter retries bounded timeouts and reports WOMPI_TIMEOUT without leaking credentials', async () => {
  let calls = 0;
  const adapter = new WompiAdapter({ ...testConfig, maxAttempts: 2, timeoutMs: 5 }, {
    random: () => 0,
    sleep: async () => undefined,
    fetch: async (_url, options) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  await assert.rejects(adapter.getTransaction('tx-timeout'), (error) => {
    assert.ok(error instanceof WompiAdapterError);
    assert.equal(error.code, 'WOMPI_TIMEOUT');
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes(testConfig.privateKey), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('adapter retries network failures with bounded exponential backoff', async () => {
  let calls = 0;
  const waits = [];
  const adapter = new WompiAdapter({ ...testConfig, maxAttempts: 3 }, {
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('network unavailable');
      return response(200, { data: transaction() });
    },
  });
  await adapter.getTransaction('tx-after-network-retry');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('webhook verifier uses dynamic properties in received order and constant-time checksum comparison', () => {
  const fixture = signedWebhook();
  const verified = verifyWompiWebhook({
    rawBody: fixture.rawBody,
    headerChecksum: fixture.event.signature.checksum.toUpperCase(),
    eventSecret: fixture.eventSecret,
    expectedEnvironment: 'test',
  });
  assert.equal(verified.event.data.transaction.status, 'APPROVED');
  assert.match(verified.providerEventId, /^[a-f0-9]{64}$/);

  assert.throws(() => verifyWompiWebhook({
    rawBody: fixture.rawBody,
    headerChecksum: 'f'.repeat(64),
    eventSecret: fixture.eventSecret,
    expectedEnvironment: 'test',
  }), /WOMPI_WEBHOOK_SIGNATURE_INVALID/);
});

test('webhook environment mismatch is rejected before persistence', () => {
  const fixture = signedWebhook({ environment: 'prod' });
  fixture.event.signature.checksum = createWebhookChecksum(fixture.event, fixture.eventSecret);
  const rawBody = Buffer.from(JSON.stringify(fixture.event));
  assert.throws(() => verifyWompiWebhook({
    rawBody, headerChecksum: fixture.event.signature.checksum,
    eventSecret: fixture.eventSecret, expectedEnvironment: 'test',
  }), /WOMPI_WEBHOOK_ENVIRONMENT_INVALID/);
});

test('verified payment statuses use only canonical subscription transitions', () => {
  assert.equal(subscriptionStatusAfterWompiPayment('trialing', 'PENDING'), 'trialing');
  assert.equal(subscriptionStatusAfterWompiPayment('trialing', 'APPROVED'), 'active');
  assert.equal(subscriptionStatusAfterWompiPayment('active', 'DECLINED'), 'past_due');
  assert.equal(subscriptionStatusAfterWompiPayment('active', 'ERROR'), 'active');
  assert.equal(subscriptionStatusAfterWompiPayment('active', 'VOIDED'), 'active');
  assert.equal(subscriptionStatusAfterWompiPayment('cancelled', 'APPROVED'), 'cancelled');
});

test('outbox charge handler reconciles an existing provider transaction instead of charging twice', async () => {
  let createCalls = 0;
  let getCalls = 0;
  const adapter = {
    async getTransaction(id) {
      getCalls += 1;
      assert.equal(id, 'tx-existing');
      return {
        provider: 'wompi', providerTransactionId: id, reference: transaction().reference,
        providerStatus: 'APPROVED', localStatus: 'approved', amountMinor: 4990000,
        currency: 'COP', finalizedAt: '2026-09-19T03:00:00.000Z',
      };
    },
    async createTransaction() { createCalls += 1; throw new Error('must not charge'); },
  };
  let recorded = 0;
  const repository = {
    async findProviderTransactionId() { return 'tx-existing'; },
    async recordProviderTransaction() { recorded += 1; },
  };
  const result = await handleSubscriptionChargeRequested({
    adapter,
    repository,
    payload: {
      event_type: 'billing.subscription_charge_requested', event_version: 1,
      tenant_id: '018f0f40-9d89-7a4c-8b6e-82c54f690001',
      subscription_id: '018f0f40-9d89-7a4c-8b6e-82c54f690002',
      payment_id: '018f0f40-9d89-7a4c-8b6e-82c54f690003', amount_minor: 4990000,
      currency: 'COP', provider: 'wompi', provider_payment_source_ref: '3891',
      customer_email: 'billing@example.invalid', reference: transaction().reference,
      requested_at: '2026-09-19T03:00:00.000Z',
    },
  });
  assert.equal(result.outcome, 'already_created');
  assert.equal(createCalls, 0);
  assert.equal(getCalls, 1);
  assert.equal(recorded, 1);
});

test('Fastify webhook route is public, persists once, ACKs duplicates and rejects invalid signatures', async () => {
  const fixture = signedWebhook();
  let identityCalls = 0;
  let persistCalls = 0;
  const repository = {
    async persistVerifiedWebhook() {
      persistCalls += 1;
      return { webhookEventId: '018f0f40-9d89-7a4c-8b6e-82c54f690010', inserted: persistCalls === 1, tenantId: null };
    },
  };
  const app = await buildApi({
    database: async () => { throw new Error('database auth must not run'); },
    identityProvider: { async verifyRequest() { identityCalls += 1; return null; } },
    registerPublicRoutes(server) {
      registerWompiWebhookRoute(server, {
        eventSecret: fixture.eventSecret,
        environment: 'test',
        repository,
        createId: (() => {
          let value = 0;
          return () => `018f0f40-9d89-7a4c-8b6e-${String(++value).padStart(12, '0')}`;
        })(),
      });
    },
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const accepted = await app.inject({
        method: 'POST', url: '/api/v1/webhooks/wompi',
        headers: { 'content-type': 'application/json', 'x-event-checksum': fixture.event.signature.checksum },
        payload: fixture.rawBody,
      });
      assert.equal(accepted.statusCode, 204);
    }
    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/webhooks/wompi',
      headers: { 'content-type': 'application/json', 'x-event-checksum': '0'.repeat(64) },
      payload: fixture.rawBody,
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error.code, 'WOMPI_WEBHOOK_SIGNATURE_INVALID');
    assert.equal(identityCalls, 0);
    assert.equal(persistCalls, 2);
  } finally {
    await app.close();
  }
});
