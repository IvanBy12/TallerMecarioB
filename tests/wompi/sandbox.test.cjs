'use strict';

const assert = require('node:assert/strict');
const { join } = require('node:path');
const test = require('node:test');

const root = process.env.TEST_WOMPI_MODULE_ROOT;
if (!root) throw new Error('TEST_WOMPI_MODULE_ROOT is required');
const { WompiAdapter } = require(join(root, 'integrations/wompi/adapter.js'));
const { WompiAdapterError } = require(join(root, 'integrations/wompi/errors.js'));
const { uuidV7 } = require(join(root, 'platform/uuid-v7.js'));

const credentials = {
  publicKey: process.env.WOMPI_PUBLIC_KEY,
  privateKey: process.env.WOMPI_PRIVATE_KEY,
  integritySecret: process.env.WOMPI_INTEGRITY_SECRET,
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
  assert.ok(tokens.personalDataAuthToken);

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
