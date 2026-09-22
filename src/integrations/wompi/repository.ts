import type postgres from 'postgres';
import type { VerifiedWompiWebhook } from './webhook.js';

export interface PersistWompiWebhookInput extends VerifiedWompiWebhook {
  webhookEventId: string;
  outboxEventId: string;
}

export interface PersistWompiWebhookResult {
  webhookEventId: string;
  inserted: boolean;
  tenantId: string | null;
}

export interface WompiWebhookRepository {
  persistVerifiedWebhook(input: PersistWompiWebhookInput): Promise<PersistWompiWebhookResult>;
}

interface IngestRow {
  webhook_event_id: string;
  inserted: boolean;
  tenant_id: string | null;
}

export class PostgresWompiWebhookRepository implements WompiWebhookRepository {
  constructor(private readonly database: postgres.Sql) {}

  async persistVerifiedWebhook(input: PersistWompiWebhookInput): Promise<PersistWompiWebhookResult> {
    const transaction = input.event.data.transaction;
    const environment = input.event.environment === 'test' ? 'test' : 'production';
    const rows = await this.database<IngestRow[]>`
      SELECT webhook_event_id, inserted, tenant_id
      FROM app.ingest_verified_wompi_webhook(
        ${input.webhookEventId}::uuid,
        ${input.outboxEventId}::uuid,
        ${input.providerEventId},
        ${input.payloadHash},
        ${this.database.json(input.event as never)},
        ${this.database.json({ x_event_checksum: input.headerChecksum })},
        ${environment},
        ${transaction.reference},
        ${transaction.id},
        ${transaction.status},
        ${input.event.sent_at}::timestamptz
      )
    `;
    const row = rows[0];
    if (!row) throw new Error('WOMPI_WEBHOOK_PERSISTENCE_FAILED');
    return { webhookEventId: row.webhook_event_id, inserted: row.inserted, tenantId: row.tenant_id };
  }
}
