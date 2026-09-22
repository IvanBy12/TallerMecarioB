'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const root = process.env.TEST_WOMPI_MODULE_ROOT;
if (!root) throw new Error('TEST_WOMPI_MODULE_ROOT is required');
const { WompiAdapter } = require(join(root, 'integrations/wompi/adapter.js'));
const { WompiAdapterError } = require(join(root, 'integrations/wompi/errors.js'));
const { createWebhookChecksum } = require(join(root, 'integrations/wompi/crypto.js'));
const { verifyWompiWebhook } = require(join(root, 'integrations/wompi/webhook.js'));
const { uuidV7 } = require(join(root, 'platform/uuid-v7.js'));

function secretWithPrefix(prefix, names) {
  for (const name of names) {
    const value = process.env[name];
    if (value?.startsWith(prefix)) return value;
  }
  for (const value of Object.values(process.env)) {
    if (value?.startsWith(prefix)) return value;
  }
  throw new Error(`WOMPI_SANDBOX_CREDENTIAL_MISSING_${prefix.replaceAll('_', '').toUpperCase()}`);
}

const credentials = {
  publicKey: secretWithPrefix('pub_test_', ['WOMPI_PUBLIC_KEY', 'WOMPI_SANDBOX_PUBLIC_KEY']),
  privateKey: secretWithPrefix('prv_test_', ['WOMPI_PRIVATE_KEY', 'WOMPI_SANDBOX_PRIVATE_KEY']),
  integritySecret: secretWithPrefix('test_integrity_', ['WOMPI_INTEGRITY_SECRET', 'WOMPI_SANDBOX_INTEGRITY_SECRET']),
  eventSecret: secretWithPrefix('test_events_', ['WOMPI_EVENT_SECRET', 'WOMPI_SANDBOX_EVENT_SECRET']),
};

const adapter = new WompiAdapter({
  environment: 'test',
  baseUrl: 'https://sandbox.wompi.co/v1',
  publicKey: credentials.publicKey,
  privateKey: credentials.privateKey,
  integritySecret: credentials.integritySecret,
  maxAttempts: 4,
  timeoutMs: 15_000,
  baseRetryDelayMs: 250,
  maxRetryDelayMs: 3_000,
});

test('Wompi sandbox creates, queries and deduplicates a test transaction without card data', async () => {
  const tokens = await adapter.getAcceptanceTokens();
  assert.ok(tokens.acceptanceToken);

  const reference = `ilvox_pay_${uuidV7()}`;
  const created = await adapter.createTransaction({
    acceptanceToken: tokens.acceptanceToken,
    personalDataAuthToken: tokens.personalDataAuthToken,
    amountMinor: 150000,
    currency: 'COP',
    customerEmail: 'sandbox-billing@tallermecario.invalid',
    paymentMethod: { type: 'NEQUI', phone_number: '3991111111' },
    paymentMethodType: 'NEQUI',
    reference,
  });
  assert.equal(created.reference, reference);
  assert.equal(created.currency, 'COP');

  const reconciled = await adapter.getTransaction(created.providerTransactionId);
  assert.equal(reconciled.providerTransactionId, created.providerTransactionId);
  assert.equal(reconciled.reference, reference);
  assert.equal(reconciled.amountMinor, 150000);

  await assert.rejects(adapter.createTransaction({
    acceptanceToken: tokens.acceptanceToken,
    personalDataAuthToken: tokens.personalDataAuthToken,
    amountMinor: 150000,
    currency: 'COP',
    customerEmail: 'sandbox-billing@tallermecario.invalid',
    paymentMethod: { type: 'NEQUI', phone_number: '3991111111' },
    paymentMethodType: 'NEQUI',
    reference,
  }), (error) => {
    assert.ok(error instanceof WompiAdapterError);
    assert.equal(error.httpStatus, 422);
    assert.equal(error.retryable, false);
    return true;
  });
});

test('sandbox event secret verifies dynamic Wompi webhook signatures locally', () => {
  const event = {
    event: 'transaction.updated',
    data: { transaction: {
      id: 'sandbox-signed-event', reference: `ilvox_pay_${uuidV7()}`, status: 'APPROVED',
      amount_in_cents: 150000, currency: 'COP',
    } },
    environment: 'test',
    signature: {
      properties: ['transaction.status', 'transaction.amount_in_cents', 'transaction.id'],
      checksum: '0'.repeat(64),
    },
    timestamp: Math.floor(Date.now() / 1000),
    sent_at: new Date().toISOString(),
  };
  event.signature.checksum = createWebhookChecksum(event, credentials.eventSecret);
  const verified = verifyWompiWebhook({
    rawBody: Buffer.from(JSON.stringify(event)),
    headerChecksum: event.signature.checksum,
    eventSecret: credentials.eventSecret,
    expectedEnvironment: 'test',
  });
  assert.equal(verified.event.data.transaction.status, 'APPROVED');
});
