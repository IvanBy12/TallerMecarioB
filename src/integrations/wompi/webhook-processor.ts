import type postgres from 'postgres';
import { uuidV7 } from '../../platform/uuid-v7.js';
import { providerTransactionStatusChangedSchema } from './contracts.js';
import { PostgresWompiBillingRepository } from './billing-repository.js';

export type WebhookAttemptStatus = 'succeeded' | 'retryable_error' | 'permanent_error';

export interface WompiWebhookAttemptRepository {
  appendAttempt(input: {
    id: string;
    webhookEventId: string;
    attemptNumber: number;
    status: WebhookAttemptStatus;
    startedAt: Date;
    finishedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    workerId?: string;
    requestId?: string;
  }): Promise<void>;
}

export class PostgresWompiWebhookAttemptRepository implements WompiWebhookAttemptRepository {
  constructor(private readonly database: postgres.Sql) {}

  async appendAttempt(input: Parameters<WompiWebhookAttemptRepository['appendAttempt']>[0]): Promise<void> {
    await this.database`
      SELECT app.append_wompi_webhook_attempt(
        ${input.id}::uuid,
        ${input.webhookEventId}::uuid,
        ${input.attemptNumber},
        ${input.status},
        ${input.startedAt}::timestamptz,
        ${input.finishedAt}::timestamptz,
        ${input.errorCode ?? null},
        ${input.errorMessage ?? null},
        ${input.workerId ?? null},
        ${input.requestId ?? null}
      )
    `;
  }
}

/** Runs inside an already-open worker transaction with transaction-local TenantContext. */
export async function processWompiWebhookOutbox(input: {
  payload: unknown;
  tenantSql: postgres.ReservedSql;
  attempts: WompiWebhookAttemptRepository;
  attemptNumber: number;
  workerId?: string;
  requestId?: string;
  createId?: () => string;
}): Promise<'applied' | 'duplicate'> {
  const startedAt = new Date();
  const createId = input.createId ?? uuidV7;
  let event;
  try {
    event = providerTransactionStatusChangedSchema.parse(input.payload);
  } catch {
    const finishedAt = new Date();
    await input.attempts.appendAttempt({
      id: createId(), webhookEventId: extractWebhookEventId(input.payload), attemptNumber: input.attemptNumber,
      status: 'permanent_error', startedAt, finishedAt, errorCode: 'WOMPI_NORMALIZED_EVENT_INVALID',
      errorMessage: 'Normalized event validation failed.', workerId: input.workerId, requestId: input.requestId,
    });
    throw new Error('WOMPI_NORMALIZED_EVENT_INVALID');
  }

  try {
    const repository = new PostgresWompiBillingRepository(input.tenantSql);
    const outcome = await repository.applyWebhookStatus({
      billingEventId: createId(),
      webhookEventId: event.webhook_event_id,
      providerTransactionId: event.provider_transaction_id,
      reference: event.reference,
      status: event.status,
      amountMinor: event.amount_minor,
      currency: event.currency,
      occurredAt: event.occurred_at,
    });
    await input.attempts.appendAttempt({
      id: createId(), webhookEventId: event.webhook_event_id, attemptNumber: input.attemptNumber,
      status: 'succeeded', startedAt, finishedAt: new Date(), workerId: input.workerId, requestId: input.requestId,
    });
    return outcome;
  } catch (error) {
    const permanent = error instanceof Error && error.message === 'WOMPI_TRANSACTION_CORRELATION_MISMATCH';
    await input.attempts.appendAttempt({
      id: createId(), webhookEventId: event.webhook_event_id, attemptNumber: input.attemptNumber,
      status: permanent ? 'permanent_error' : 'retryable_error', startedAt, finishedAt: new Date(),
      errorCode: permanent ? 'WOMPI_TRANSACTION_CORRELATION_MISMATCH' : 'WOMPI_WEBHOOK_PROCESSING_FAILED',
      errorMessage: permanent ? 'Transaction correlation failed.' : 'Webhook processing failed.',
      workerId: input.workerId, requestId: input.requestId,
    });
    throw error;
  }
}

function extractWebhookEventId(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'webhook_event_id' in payload
    && typeof payload.webhook_event_id === 'string') return payload.webhook_event_id;
  throw new Error('WOMPI_WEBHOOK_EVENT_ID_MISSING');
}
