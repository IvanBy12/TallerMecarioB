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
    const payments = await this.sql<{ subscription_id: string; status: string }[]>`
      SELECT subscription_id, status
      FROM public.payments
      WHERE reference = ${input.reference}
        AND provider = 'wompi'
        AND amount = ${input.amountMinor}
        AND currency = ${input.currency}
        AND (provider_transaction_id IS NULL OR provider_transaction_id = ${input.providerTransactionId})
      FOR UPDATE
    `;
    if (payments.length !== 1) throw new Error('WOMPI_TRANSACTION_CORRELATION_MISMATCH');

    const businessEventId = sha256Hex(`wompi|${input.providerTransactionId}|${input.status}`);
    const inserted = await this.sql<{ id: string }[]>`
      INSERT INTO public.billing_events (
        id, tenant_id, subscription_id, provider, provider_event_id,
        event_type, payload_json, occurred_at
      )
      SELECT ${input.billingEventId}::uuid, p.tenant_id, p.subscription_id, 'wompi', ${businessEventId},
        'billing.provider_transaction_status_changed',
        ${this.sql.json({
          provider: 'wompi',
          provider_transaction_id: input.providerTransactionId,
          reference: input.reference,
          status: input.status,
          amount_minor: input.amountMinor,
          currency: input.currency,
          webhook_event_id: input.webhookEventId,
        })},
        ${input.occurredAt}::timestamptz
      FROM public.payments AS p
      WHERE p.reference = ${input.reference}
        AND p.provider = 'wompi'
        AND p.amount = ${input.amountMinor}
        AND p.currency = ${input.currency}
        AND (p.provider_transaction_id IS NULL OR p.provider_transaction_id = ${input.providerTransactionId})
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 0) return 'duplicate';

    const localStatus = input.status.toLowerCase();
    const currentStatus = payments[0].status;
    const finalStatuses = new Set(['approved', 'declined', 'error', 'voided']);
    if (!(localStatus === 'pending' && finalStatuses.has(currentStatus))) {
      await this.sql`
        UPDATE public.payments
        SET provider_transaction_id = ${input.providerTransactionId},
            status = ${localStatus},
            paid_at = CASE WHEN ${localStatus} = 'approved'
              THEN COALESCE(paid_at, ${input.occurredAt}::timestamptz) ELSE paid_at END,
            updated_at = now()
        WHERE reference = ${input.reference} AND provider = 'wompi'
      `;
    }

    const subscriptionId = payments[0].subscription_id;
    if (input.status === 'APPROVED') {
      await this.sql`
        UPDATE public.subscriptions
        SET status = 'active', updated_at = now()
        WHERE id = ${subscriptionId}::uuid AND status IN ('trialing','past_due','suspended')
      `;
    } else if (input.status === 'DECLINED') {
      await this.sql`
        UPDATE public.subscriptions
        SET status = 'past_due', updated_at = now()
        WHERE id = ${subscriptionId}::uuid AND status = 'active'
      `;
    }
    return 'applied';
  }
}
