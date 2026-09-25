import type postgres from 'postgres';

/**
 * ADR-004 / ADR-009 §6-7: the worker never touches `outbox_events` directly
 * (it has no table grant on it -- see 0003_outbox_worker.sql); every step
 * goes through an allowlisted SECURITY DEFINER function owned by
 * `tallermecario_bootstrap_resolver`:
 *
 *   claim    -> app.bootstrap_claim_outbox_events   (0000)
 *   read     -> app.worker_get_outbox_event          (0003)
 *   complete -> app.worker_complete_outbox_event      (0003)
 *   recover  -> app.worker_requeue_stalled_outbox_events (0003)
 *
 * `database` must be a `postgres.Sql` connected as `tallermecario_worker`
 * (NOBYPASSRLS). Each job is processed in its own NEW transaction: TenantContext
 * (`app.tenant_id`) is set from the tenant_id the claim already resolved --
 * the event carries its own tenant_id from publish time, so there is no
 * separate inbound-tenant-resolution step here (contrast with the WhatsApp/
 * Wompi webhook resolvers in 0000, which map an external identifier to a
 * tenant before anything is known).
 */

export type OutboxOutcome = 'processed' | 'retry' | 'failed' | 'dead_letter';

export interface ClaimedJob {
  outboxEventId: string;
  tenantId: string | null;
}

export interface OutboxEvent {
  id: string;
  tenantId: string | null;
  aggregateType: string;
  aggregateId: string | null;
  eventType: string;
  eventVersion: number;
  payload: unknown;
  idempotencyKey: string | null;
  /** Attempt count as of THIS claim (already incremented by the claim itself). */
  attempts: number;
}

/** Handler should throw to signal failure; anything else is treated as success. */
export type OutboxHandler = (
  event: OutboxEvent,
  tx: postgres.ReservedSql,
) => Promise<void>;

/**
 * Handler for jobs that must call an external provider WITHOUT holding a
 * PostgreSQL transaction (or connection) open across the network call:
 *
 *   PHASE A  claim (claimBatch) + read the claimed payload: autocommit
 *            statements on the pool, nothing left open.
 *   PHASE B  `prepare`: runs with NO transaction and NO reserved connection.
 *            The only place a network call is allowed. It may issue its own
 *            autocommit reads through `pool` (e.g. a cheap stale pre-check).
 *   PHASE C  `apply`: a NEW short transaction on a freshly reserved
 *            connection. It must lock + re-read its state before mutating (the
 *            world may have moved while PHASE B waited on the network). The
 *            `processed` transition commits atomically with it.
 *
 * Failures in B or C never mark the job processed; C's writes are rolled back
 * and the retry/failed/dead_letter transition is recorded separately.
 */
export interface PhasedOutboxHandler<Prepared = unknown> {
  readonly kind: 'phased';
  prepare(event: OutboxEvent, pool: postgres.Sql): Promise<Prepared>;
  apply(event: OutboxEvent, prepared: Prepared, tx: postgres.ReservedSql): Promise<void>;
  /** Optional evidence of a failed attempt (autocommit, after rollback). Must not throw. */
  recordFailure?(event: OutboxEvent, error: unknown, retryable: boolean, pool: postgres.Sql): Promise<void>;
}

/** A classified transient failure (network timeout, 5xx, 429): eligible for retry. */
export class TransientDispatchError extends Error {
  readonly retryable = true as const;
}

/** A classified permanent failure (malformed payload, rejected by provider): never retried. */
export class PermanentDispatchError extends Error {
  readonly retryable = false as const;
}

export interface OutboxWorkerOptions {
  database: postgres.Sql;
  handlers: Record<string, OutboxHandler>;
  /** Network-calling handlers, processed with processPhasedJob (see PhasedOutboxHandler). */
  phasedHandlers?: Record<string, PhasedOutboxHandler<any>>;
  /** Attempts (inclusive) after which a retryable failure becomes dead_letter instead of retry. */
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_SECONDS = 30;
const DEFAULT_MAX_DELAY_SECONDS = 900;

/**
 * Exponential backoff, capped. `attempts` is the count already recorded by
 * the claim that is about to fail again. This is an application-level policy
 * -- the canonical dictionary fixes no retry count for outbox_events itself
 * (unlike the unrelated `max_attempts default 5` field documented for
 * message-retry tables in Dic. 02) -- so it is intentionally not enforced by
 * a DB CHECK.
 */
export function computeRetryDelaySeconds(
  attempts: number,
  baseDelaySeconds = DEFAULT_BASE_DELAY_SECONDS,
  maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
): number {
  const delay = baseDelaySeconds * 2 ** Math.max(attempts - 1, 0);
  return Math.min(delay, maxDelaySeconds);
}

export async function claimBatch(
  workerSql: postgres.Sql,
  batchSize: number,
): Promise<ClaimedJob[]> {
  const rows = await workerSql<{ outbox_event_id: string; tenant_id: string | null }[]>`
    SELECT outbox_event_id, tenant_id FROM app.bootstrap_claim_outbox_events(${batchSize})
  `;
  return rows.map((row) => ({ outboxEventId: row.outbox_event_id, tenantId: row.tenant_id }));
}

export async function requeueStalled(
  workerSql: postgres.Sql,
  stallSeconds: number,
  batchSize = 100,
): Promise<ClaimedJob[]> {
  const rows = await workerSql<{ outbox_event_id: string; tenant_id: string | null }[]>`
    SELECT outbox_event_id, tenant_id
    FROM app.worker_requeue_stalled_outbox_events(${stallSeconds}, ${batchSize})
  `;
  return rows.map((row) => ({ outboxEventId: row.outbox_event_id, tenantId: row.tenant_id }));
}

interface RawClaimedEventRow {
  id: string;
  tenant_id: string | null;
  aggregate_type: string;
  aggregate_id: string | null;
  event_type: string;
  event_version: number;
  payload_json: unknown;
  idempotency_key: string | null;
  attempts: number;
}

export async function getClaimedEvent(
  tx: postgres.Sql,
  outboxEventId: string,
): Promise<OutboxEvent | null> {
  const [row] = await tx<RawClaimedEventRow[]>`
    SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, event_version,
      payload_json, idempotency_key, attempts
    FROM app.worker_get_outbox_event(${outboxEventId})
  `;
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    payload: row.payload_json,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
  };
}

/** Returns false when the row was no longer 'processing' (already finished elsewhere): a safe no-op. */
export async function finishOutboxEvent(
  tx: postgres.Sql,
  outboxEventId: string,
  outcome: OutboxOutcome,
  error?: string,
  retryDelaySeconds?: number,
): Promise<boolean> {
  const [row] = await tx<{ done: boolean }[]>`
    SELECT app.worker_complete_outbox_event(
      ${outboxEventId}, ${outcome}, ${error ?? null}, ${retryDelaySeconds ?? 0}
    ) AS done
  `;
  return row.done;
}

export interface ProcessResult {
  outboxEventId: string;
  outcome: OutboxOutcome | 'already_finished';
  attempts: number | null;
}

/** A claimed ID and tenant must still match the durable outbox row. */
function assertClaimMatchesEvent(job: ClaimedJob, event: OutboxEvent): void {
  if (job.outboxEventId !== event.id || job.tenantId !== event.tenantId) {
    throw new Error('OUTBOX_CLAIM_TENANT_MISMATCH');
  }
}

/**
 * Processes one claimed job end to end in a brand-new, tenant-scoped
 * transaction: opens the connection, sets TenantContext from the job's own
 * tenant_id, runs the registered domain handler (any additional writes the
 * handler makes land in RLS under `tallermecario_worker`, same transaction),
 * and marks the outcome. Handler success and `processed` commit atomically;
 * on failure the transaction is rolled back (undoing any partial domain
 * writes) and the retry/failed/dead_letter transition is recorded as its own
 * statement so it is never lost even though the handler's work was undone.
 */
export async function processClaimedJob(
  options: OutboxWorkerOptions,
  job: ClaimedJob,
): Promise<ProcessResult> {
  // Phased handlers never share the single-transaction path below: PHASE A
  // needs the event type, read here with one autocommit statement.
  if (options.phasedHandlers && Object.keys(options.phasedHandlers).length > 0) {
    const event = await getClaimedEvent(options.database, job.outboxEventId);
    if (!event) return { outboxEventId: job.outboxEventId, outcome: 'already_finished', attempts: null };
    assertClaimMatchesEvent(job, event);
    const phased = options.phasedHandlers[event.eventType];
    if (phased) return processPhasedJob(options, job, event, phased);
  }

  const {
    database,
    handlers,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelaySeconds = DEFAULT_BASE_DELAY_SECONDS,
    maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
  } = options;

  const tx = await database.reserve();
  let inTransaction = false;
  try {
    await tx.unsafe('BEGIN');
    inTransaction = true;
    if (job.tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${job.tenantId}, true)`;
    }

    const event = await getClaimedEvent(tx, job.outboxEventId);
    if (!event) {
      // Claimed here, but no longer 'processing' by the time we looked: a
      // concurrent stall-requeue or a duplicate call already resolved it.
      await tx.unsafe('ROLLBACK');
      inTransaction = false;
      return { outboxEventId: job.outboxEventId, outcome: 'already_finished', attempts: null };
    }
    assertClaimMatchesEvent(job, event);

    try {
      const handler = handlers[event.eventType];
      if (!handler) {
        throw new PermanentDispatchError(`no handler registered for event_type ${event.eventType}`);
      }
      await handler(event, tx);
      const done = await finishOutboxEvent(tx, job.outboxEventId, 'processed');
      await tx.unsafe('COMMIT');
      inTransaction = false;
      return { outboxEventId: job.outboxEventId, outcome: done ? 'processed' : 'already_finished', attempts: event.attempts };
    } catch (error) {
      await tx.unsafe('ROLLBACK');
      inTransaction = false;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !(error instanceof PermanentDispatchError);

      if (retryable && event.attempts < maxAttempts) {
        const delay = computeRetryDelaySeconds(event.attempts, baseDelaySeconds, maxDelaySeconds);
        await finishOutboxEvent(tx, job.outboxEventId, 'retry', message, delay);
        return { outboxEventId: job.outboxEventId, outcome: 'retry', attempts: event.attempts };
      }
      const outcome: OutboxOutcome = retryable ? 'dead_letter' : 'failed';
      await finishOutboxEvent(tx, job.outboxEventId, outcome, message);
      return { outboxEventId: job.outboxEventId, outcome, attempts: event.attempts };
    }
  } catch (error) {
    // BEGIN / set_config / getClaimedEvent itself failed -- an infrastructure
    // error, not a job outcome (we may not even know the event's type/attempts).
    // Roll back so the connection is never released mid-transaction (a leaked
    // open/aborted transaction would poison the next reserve() from this pool),
    // then surface the error instead of silently spending a retry on it.
    if (inTransaction) {
      await tx.unsafe('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    tx.release();
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * PHASE B + PHASE C for a phased handler (PHASE A — claim + payload read — is
 * already done by the caller with autocommit statements). No transaction and
 * no reserved connection exist while `prepare` runs; `apply` gets a brand-new
 * transaction. See PhasedOutboxHandler.
 */
export async function processPhasedJob(
  options: OutboxWorkerOptions,
  job: ClaimedJob,
  event: OutboxEvent,
  handler: PhasedOutboxHandler<any>,
): Promise<ProcessResult> {
  assertClaimMatchesEvent(job, event);
  const {
    database,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelaySeconds = DEFAULT_BASE_DELAY_SECONDS,
    maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
  } = options;

  const fail = async (error: unknown): Promise<ProcessResult> => {
    const retryable = !(error instanceof PermanentDispatchError);
    if (handler.recordFailure) {
      await handler.recordFailure(event, error, retryable, database).catch(() => undefined);
    }
    const message = failureMessage(error);
    if (retryable && event.attempts < maxAttempts) {
      const delay = computeRetryDelaySeconds(event.attempts, baseDelaySeconds, maxDelaySeconds);
      await finishOutboxEvent(database, job.outboxEventId, 'retry', message, delay);
      return { outboxEventId: job.outboxEventId, outcome: 'retry', attempts: event.attempts };
    }
    const outcome: OutboxOutcome = retryable ? 'dead_letter' : 'failed';
    await finishOutboxEvent(database, job.outboxEventId, outcome, message);
    return { outboxEventId: job.outboxEventId, outcome, attempts: event.attempts };
  };

  // PHASE B — network allowed, no transaction open.
  let prepared: unknown;
  try {
    prepared = await handler.prepare(event, database);
  } catch (error) {
    return fail(error);
  }

  // PHASE C — new short transaction on a freshly reserved connection.
  const tx = await database.reserve();
  let inTransaction = false;
  let failure: { error: unknown } | null = null;
  let result: ProcessResult | null = null;
  try {
    await tx.unsafe('BEGIN');
    inTransaction = true;
    if (job.tenantId) {
      await tx`SELECT set_config('app.tenant_id', ${job.tenantId}, true)`;
    }
    await handler.apply(event, prepared, tx);
    const done = await finishOutboxEvent(tx, job.outboxEventId, 'processed');
    await tx.unsafe('COMMIT');
    inTransaction = false;
    result = { outboxEventId: job.outboxEventId, outcome: done ? 'processed' : 'already_finished', attempts: event.attempts };
  } catch (error) {
    if (inTransaction) {
      await tx.unsafe('ROLLBACK').catch(() => undefined);
      inTransaction = false;
    }
    failure = { error };
  } finally {
    tx.release();
  }
  if (failure) return fail(failure.error);
  return result!;
}
