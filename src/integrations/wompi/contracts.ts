import { z } from 'zod';

export const WOMPI_PROVIDER_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED'] as const;
export type WompiProviderStatus = (typeof WOMPI_PROVIDER_STATUSES)[number];
export type LocalPaymentStatus = Lowercase<WompiProviderStatus>;

export const wompiTransactionSchema = z.object({
  id: z.string().min(1).max(255),
  reference: z.string().min(1).max(255),
  status: z.enum(WOMPI_PROVIDER_STATUSES),
  amount_in_cents: z.number().int().positive().safe(),
  currency: z.literal('COP'),
  finalized_at: z.string().datetime({ offset: true }).nullish(),
}).passthrough();

export const wompiTransactionResponseSchema = z.object({ data: wompiTransactionSchema }).passthrough();

export const wompiPaymentSourceResponseSchema = z.object({
  data: z.object({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    status: z.string().min(1).optional(),
  }).passthrough(),
}).passthrough();

export const wompiMerchantResponseSchema = z.object({
  data: z.object({
    presigned_acceptance: z.object({ token: z.string().min(1) }).passthrough(),
    presigned_personal_data_auth: z.object({ token: z.string().min(1) }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

export const wompiWebhookSchema = z.object({
  event: z.literal('transaction.updated'),
  data: z.object({ transaction: wompiTransactionSchema }).passthrough(),
  environment: z.enum(['test', 'prod']),
  signature: z.object({
    properties: z.array(z.string().min(1).max(200)).min(1).max(32),
    checksum: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }).strict(),
  timestamp: z.number().int().nonnegative().safe(),
  sent_at: z.string().datetime({ offset: true }),
}).passthrough();

export const subscriptionChargeRequestedSchema = z.object({
  event_type: z.literal('billing.subscription_charge_requested'),
  event_version: z.literal(1),
  tenant_id: z.string().uuid(),
  subscription_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  amount_minor: z.number().int().positive().safe(),
  currency: z.literal('COP'),
  provider: z.literal('wompi'),
  provider_payment_source_ref: z.string().min(1).max(255),
  customer_email: z.string().email().max(320),
  reference: z.string().regex(/^ilvox_pay_[0-9a-f-]{36}$/i).max(160),
  requested_at: z.string().datetime({ offset: true }),
}).strict();

export const providerTransactionStatusChangedSchema = z.object({
  type: z.literal('billing.provider_transaction_status_changed'),
  version: z.literal(1),
  provider: z.literal('wompi'),
  provider_transaction_id: z.string().min(1).max(255),
  reference: z.string().min(1).max(160),
  status: z.enum(WOMPI_PROVIDER_STATUSES),
  amount_minor: z.number().int().positive().safe(),
  currency: z.literal('COP'),
  occurred_at: z.string().datetime({ offset: true }),
  webhook_event_id: z.string().uuid(),
}).strict();

export type WompiTransaction = z.infer<typeof wompiTransactionSchema>;
export type WompiWebhook = z.infer<typeof wompiWebhookSchema>;
export type SubscriptionChargeRequested = z.infer<typeof subscriptionChargeRequestedSchema>;
export type ProviderTransactionStatusChanged = z.infer<typeof providerTransactionStatusChangedSchema>;

export interface NormalizedWompiTransaction {
  provider: 'wompi';
  providerTransactionId: string;
  reference: string;
  providerStatus: WompiProviderStatus;
  localStatus: LocalPaymentStatus;
  amountMinor: number;
  currency: 'COP';
  finalizedAt: string | null;
}

export function normalizeWompiTransaction(transaction: WompiTransaction): NormalizedWompiTransaction {
  return {
    provider: 'wompi',
    providerTransactionId: transaction.id,
    reference: transaction.reference,
    providerStatus: transaction.status,
    localStatus: transaction.status.toLowerCase() as LocalPaymentStatus,
    amountMinor: transaction.amount_in_cents,
    currency: transaction.currency,
    finalizedAt: transaction.finalized_at ?? null,
  };
}

const forbiddenPaymentKeys = new Set(['pan', 'card_number', 'cardnumber', 'cvv', 'cvc', 'security_code']);

export function assertNoRawPaymentInstrument(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenPaymentKeys.has(key.toLowerCase())) throw new Error('RAW_PAYMENT_INSTRUMENT_FORBIDDEN');
      pending.push(child);
    }
  }
}
