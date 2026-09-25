import type postgres from 'postgres';
import type { NormalizedWompiTransaction, WompiProviderStatus } from './contracts.js';
import { sha256Hex } from './crypto.js';
import type { WompiBillingRepository } from './outbox-handler.js';

export interface ApplyWompiStatusInput {
  billingEventId: string;
  webhookEventId: string;
  providerTransactionId: string;
  reference: string;
  status: WompiProviderStatus;
  amountMinor: number;
  currency: 'COP';
  occurredAt: string;
}

export class PostgresWompiBillingRepository implements WompiBillingRepository {
  constructor(private readonly sql: postgres.ReservedSql) {}

  async findProviderTransactionId(paymentId: string): Promise<string | null> {
    const rows = await this.sql<{ provider_transaction_id: string | null }[]>`
      SELECT provider_transaction_id
      FROM public.payments
      WHERE id = ${paymentId}::uuid AND provider = 'wompi'
    `;
    return rows[0]?.provider_transaction_id ?? null;
  }

  async recordProviderTransaction(input: {
    tenantId: string;
    subscriptionId: string;
    paymentId: string;
    transaction: NormalizedWompiTransaction;
  }): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE public.payments
      SET provider_transaction_id = ${input.transaction.providerTransactionId},
          status = ${input.transaction.localStatus},
          paid_at = CASE WHEN ${input.transaction.localStatus} = 'approved'
            THEN COALESCE(paid_at, ${input.transaction.finalizedAt}::timestamptz, now()) ELSE paid_at END,
          updated_at = now()
      WHERE id = ${input.paymentId}::uuid
        AND tenant_id = ${input.tenantId}::uuid
        AND subscription_id = ${input.subscriptionId}::uuid
        AND provider = 'wompi'
        AND reference = ${input.transaction.reference}
        AND amount = ${input.transaction.amountMinor}
        AND currency = ${input.transaction.currency}
        AND (provider_transaction_id IS NULL OR provider_transaction_id = ${input.transaction.providerTransactionId})
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error('WOMPI_TRANSACTION_CORRELATION_MISMATCH');
  }

  /** Must run inside the worker's tenant-scoped transaction. */
  async applyWebhookStatus(input: ApplyWompiStatusInput): Promise<'applied' | 'duplicate'> {
    const businessEventId = sha256Hex(`wompi|${input.providerTransactionId}|${input.status}`);
    const [row] = await this.sql<{ outcome: 'applied' | 'duplicate' }[]>`
      SELECT app.apply_wompi_payment_status(
        ${input.billingEventId}::uuid,
        ${input.webhookEventId}::uuid,
        ${businessEventId},
        ${input.providerTransactionId},
        ${input.reference},
        ${input.status},
        ${input.amountMinor}::bigint,
        ${input.currency},
        ${input.occurredAt}::timestamptz
      ) AS outcome
    `;
    if (!row) throw new Error('WOMPI_WEBHOOK_PROCESSING_FAILED');
    return row.outcome;
  }
}
