import type postgres from 'postgres';

/**
 * ADR-004: the outbox row is written in the SAME PostgreSQL transaction as
 * the domain change that produced it. `sql` must already be the open,
 * tenant-scoped connection running that business operation (see
 * `getTenantRequestContext` in `../api/app.js`) -- this function issues no
 * BEGIN/COMMIT of its own and never picks a tenant on its own behalf
 * (AGENTS.md invariant 1: tenant_id comes exclusively from TenantContext).
 */
export interface OutboxEventInput {
  /** Application-generated UUIDv7 (AGENTS.md invariant 8). */
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId?: string | null;
  eventType: string;
  eventVersion?: number;
  payload: unknown;
  /**
   * Required for events that dispatch an external effect sensitive to
   * duplicates (Dic. 04 §7). A second publish with the same key -- e.g. the
   * caller's business operation was retried under the same Idempotency-Key
   * -- is a no-op: it returns the original event, never a second row.
   */
  idempotencyKey?: string | null;
}

export interface PublishResult {
  id: string;
  deduplicated: boolean;
}

export async function publishOutboxEvent(
  sql: postgres.ReservedSql | postgres.TransactionSql,
  event: OutboxEventInput,
): Promise<PublishResult> {
  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO outbox_events (
      id, tenant_id, aggregate_type, aggregate_id, event_type, event_version,
      payload_json, idempotency_key
    ) VALUES (
      ${event.id}, ${event.tenantId}, ${event.aggregateType}, ${event.aggregateId ?? null},
      ${event.eventType}, ${event.eventVersion ?? 1}, ${sql.json(event.payload as postgres.JSONValue)},
      ${event.idempotencyKey ?? null}
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (inserted) return { id: inserted.id, deduplicated: false };

  // Lost the insert to an existing row sharing idempotencyKey: look it up
  // instead of raising, so a retried business operation stays a no-op.
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM outbox_events WHERE idempotency_key = ${event.idempotencyKey ?? null}
  `;
  if (!existing) throw new Error('OUTBOX_PUBLISH_CONFLICT_WITHOUT_EXISTING_ROW');
  return { id: existing.id, deduplicated: true };
}
