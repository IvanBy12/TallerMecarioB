import { WompiAdapter } from './adapter.js';
import {
  subscriptionChargeRequestedSchema,
  type NormalizedWompiTransaction,
  type SubscriptionChargeRequested,
} from './contracts.js';

export interface WompiBillingRepository {
  findProviderTransactionId(paymentId: string): Promise<string | null>;
  recordProviderTransaction(input: {
    tenantId: string;
    subscriptionId: string;
    paymentId: string;
    transaction: NormalizedWompiTransaction;
  }): Promise<void>;
}

export interface WompiChargeResult {
  outcome: 'created' | 'already_created';
  transaction: NormalizedWompiTransaction;
}

/** Handler for the canonical `billing.subscription_charge_requested` outbox event. */
export async function handleSubscriptionChargeRequested(input: {
  payload: unknown;
  adapter: WompiAdapter;
  repository: WompiBillingRepository;
}): Promise<WompiChargeResult> {
  const event = subscriptionChargeRequestedSchema.parse(input.payload);
  const existingTransactionId = await input.repository.findProviderTransactionId(event.payment_id);
  if (existingTransactionId) {
    const transaction = await reconcileTransaction(input.adapter, existingTransactionId, event);
    await persist(input.repository, event, transaction);
    return { outcome: 'already_created', transaction };
  }

  const tokens = await input.adapter.getAcceptanceTokens();
  const transaction = await input.adapter.createTransaction({
    acceptanceToken: tokens.acceptanceToken,
    personalDataAuthToken: tokens.personalDataAuthToken,
    amountMinor: event.amount_minor,
    currency: event.currency,
    customerEmail: event.customer_email,
    paymentMethod: { installments: 1 },
    reference: event.reference,
    paymentSourceId: event.provider_payment_source_ref,
    recurrent: true,
  });
  assertCorrelation(transaction, event);
  await persist(input.repository, event, transaction);
  return { outcome: 'created', transaction };
}

export async function reconcileTransaction(
  adapter: WompiAdapter,
  providerTransactionId: string,
  event: SubscriptionChargeRequested,
): Promise<NormalizedWompiTransaction> {
  const transaction = await adapter.getTransaction(providerTransactionId);
  assertCorrelation(transaction, event);
  return transaction;
}

function assertCorrelation(transaction: NormalizedWompiTransaction, event: SubscriptionChargeRequested): void {
  if (transaction.reference !== event.reference
    || transaction.amountMinor !== event.amount_minor
    || transaction.currency !== event.currency) {
    throw new Error('WOMPI_TRANSACTION_CORRELATION_MISMATCH');
  }
}

function persist(
  repository: WompiBillingRepository,
  event: SubscriptionChargeRequested,
  transaction: NormalizedWompiTransaction,
): Promise<void> {
  return repository.recordProviderTransaction({
    tenantId: event.tenant_id,
    subscriptionId: event.subscription_id,
    paymentId: event.payment_id,
    transaction,
  });
}
