/**
 * S1-03 identity lifecycle synchronization (outbox job
 * `identity.provider_user_lifecycle_received`, tenant-less).
 *
 * Fetch-on-process: the webhook is only a trigger. The worker asks the
 * provider for the subject's CURRENT state and never trusts profile data from
 * the webhook payload (which is not even stored).
 *
 *   PHASE A (worker)  claim + read payload, autocommit.
 *   PHASE B prepare   autocommit ordering pre-check (skip stale/duplicate/
 *                     tombstoned without any network call); user.deleted needs
 *                     no fetch; otherwise ONE provider fetch with a finite
 *                     timeout. No transaction and no reserved connection.
 *   PHASE C apply     new short transaction: app.identity_sync_apply takes the
 *                     per-identity advisory lock, locks + re-reads the sync
 *                     state and discards the snapshot if a newer event won the
 *                     race while PHASE B waited on the network.
 */

import { z } from 'zod';
import { uuidV7 } from '../../platform/uuid-v7.js';
import {
  PermanentDispatchError,
  TransientDispatchError,
  type OutboxEvent,
  type PhasedOutboxHandler,
} from '../../worker/outbox-worker.js';
import {
  IdentityProviderRequestError,
  IdentityProviderUnavailableError,
  type IdentitySnapshotSource,
} from '../identity-provider.js';
import { normalizeProviderFullName, normalizeVerifiedEmail } from '../profile.js';

export const IDENTITY_LIFECYCLE_EVENT_TYPE = 'identity.provider_user_lifecycle_received';

const PROVIDER_EVENT_TYPES = [
  'user.created', 'user.updated', 'user.deleted',
  'user.banned', 'user.unbanned', 'user.locked', 'user.unlocked',
] as const;

const lifecyclePayloadSchema = z.object({
  type: z.literal(IDENTITY_LIFECYCLE_EVENT_TYPE),
  version: z.literal(1),
  provider: z.literal('clerk'),
  external_subject: z.string().min(1).max(255),
  provider_event_type: z.enum(PROVIDER_EVENT_TYPES),
  provider_event_id: z.string().min(1).max(128),
  occurred_at: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), 'must be a timestamp'),
  webhook_event_id: z.uuid(),
}).strict();

export type LifecyclePayload = z.infer<typeof lifecyclePayloadSchema>;

export type LifecycleClassification = 'fresh' | 'duplicate' | 'stale' | 'tombstoned';

export type PreparedLifecycle =
  | { readonly kind: 'skip'; readonly payload: LifecyclePayload; readonly classification: Exclude<LifecycleClassification, 'fresh'> }
  | {
    readonly kind: 'observation';
    readonly payload: LifecyclePayload;
    readonly observation: 'snapshot';
    readonly email: string | null;
    readonly fullName: string | null;
    readonly banned: boolean;
  }
  | { readonly kind: 'observation'; readonly payload: LifecyclePayload; readonly observation: 'not_found' | 'deleted' };

export interface LifecycleApplyResult {
  readonly outboxEventId: string;
  readonly result: string;
  readonly userId: string | null;
  readonly lifecycleState: string | null;
  readonly revocationsEnqueued: number;
}

export interface IdentityLifecycleHandlerOptions {
  readonly source: IdentitySnapshotSource;
  readonly workerId?: string;
  /** Observability/test hook; called after PHASE C returned (before COMMIT). */
  readonly onApplied?: (result: LifecycleApplyResult) => void;
}

function parsePayload(event: OutboxEvent): LifecyclePayload {
  if (event.tenantId !== null) throw new PermanentDispatchError('IDENTITY_SYNC_TENANT_SCOPE_INVALID');
  const parsed = lifecyclePayloadSchema.safeParse(event.payload);
  if (!parsed.success) throw new PermanentDispatchError('IDENTITY_SYNC_PAYLOAD_INVALID');
  return parsed.data;
}

/** Stable, PII-free code for outbox.last_error / webhook_processing_attempts. */
export function lifecycleErrorCode(error: unknown): string {
  if (error instanceof IdentityProviderUnavailableError) return 'IDENTITY_PROVIDER_UNAVAILABLE';
  if (error instanceof IdentityProviderRequestError) return 'IDENTITY_PROVIDER_REQUEST_REJECTED';
  if (error instanceof Error && /^[A-Z0-9_]{1,120}$/u.test(error.message)) return error.message;
  return 'IDENTITY_SYNC_FAILED';
}

/**
 * Database errors can carry localized text or values; only a stable code and
 * the SQLSTATE ever reach outbox_events.last_error / processing attempts.
 */
function sanitizedDatabaseError(code: string, error: unknown): Error {
  const sqlState = (error as { code?: unknown } | null)?.code;
  return new Error(typeof sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(sqlState) ? `${code}_${sqlState}` : code);
}

export function createIdentityLifecycleHandler(
  options: IdentityLifecycleHandlerOptions,
): PhasedOutboxHandler<PreparedLifecycle> {
  const workerId = (options.workerId ?? `worker-${process.pid}`).slice(0, 160);
  const startedAt = new WeakMap<OutboxEvent, Date>();

  return {
    kind: 'phased',

    async prepare(event, pool) {
      startedAt.set(event, new Date());
      const payload = parsePayload(event);

      const [row] = await pool<{ classification: LifecycleClassification }[]>`
        SELECT app.identity_sync_classify(
          ${payload.provider}, ${payload.external_subject}, ${payload.provider_event_id},
          ${payload.provider_event_type}, ${payload.occurred_at}::timestamptz
        ) AS classification
      `;
      const classification = row?.classification;
      if (classification === 'duplicate' || classification === 'stale' || classification === 'tombstoned') {
        return { kind: 'skip', payload, classification };
      }
      if (classification !== 'fresh') throw new Error('IDENTITY_SYNC_CLASSIFICATION_INVALID');

      if (payload.provider_event_type === 'user.deleted') {
        return { kind: 'observation', payload, observation: 'deleted' };
      }

      let snapshot;
      try {
        snapshot = await options.source.fetchIdentitySnapshot(payload.external_subject);
      } catch (error) {
        if (error instanceof IdentityProviderRequestError) {
          throw new PermanentDispatchError('IDENTITY_PROVIDER_REQUEST_REJECTED');
        }
        // Timeout, network, 429, 5xx, provider auth/config: retry via outbox.
        throw new TransientDispatchError('IDENTITY_PROVIDER_UNAVAILABLE');
      }
      if (snapshot.kind === 'not_found') {
        return { kind: 'observation', payload, observation: 'not_found' };
      }
      return {
        kind: 'observation',
        payload,
        observation: 'snapshot',
        email: normalizeVerifiedEmail(snapshot.verifiedPrimaryEmail),
        fullName: normalizeProviderFullName(snapshot.fullName),
        banned: snapshot.banned,
      };
    },

    async apply(event, prepared, tx) {
      const payload = prepared.payload;
      let result: LifecycleApplyResult;
      if (prepared.kind === 'skip') {
        result = {
          outboxEventId: event.id,
          result: prepared.classification,
          userId: null,
          lifecycleState: null,
          revocationsEnqueued: 0,
        };
      } else {
        const email = prepared.observation === 'snapshot' ? prepared.email : null;
        const fullName = prepared.observation === 'snapshot' ? prepared.fullName : null;
        const banned = prepared.observation === 'snapshot' ? prepared.banned : null;
        let row: { result: string; user_id: string | null; lifecycle_state: string | null; revocations_enqueued: number } | undefined;
        try {
          [row] = await tx<{ result: string; user_id: string | null; lifecycle_state: string | null; revocations_enqueued: number }[]>`
            SELECT result, user_id, lifecycle_state, revocations_enqueued
            FROM app.identity_sync_apply(
              ${payload.provider}, ${payload.external_subject}, ${payload.provider_event_id},
              ${payload.provider_event_type}, ${payload.occurred_at}::timestamptz,
              ${payload.webhook_event_id}::uuid, ${prepared.observation},
              ${email}, ${fullName}, ${banned}::boolean,
              ${uuidV7()}::uuid, ${uuidV7()}::uuid, ${event.id}
            )
          `;
        } catch (error) {
          throw sanitizedDatabaseError('IDENTITY_SYNC_APPLY_FAILED', error);
        }
        if (!row) throw new Error('IDENTITY_SYNC_APPLY_RESULT_MISSING');
        result = {
          outboxEventId: event.id,
          result: row.result,
          userId: row.user_id,
          lifecycleState: row.lifecycle_state,
          revocationsEnqueued: row.revocations_enqueued,
        };
      }

      try {
        await tx`
          SELECT app.identity_sync_record_attempt(
            ${payload.webhook_event_id}::uuid, ${event.attempts}::integer, 'succeeded',
            ${(startedAt.get(event) ?? new Date()).toISOString()}::timestamptz, NULL, ${workerId}, ${event.id}
          )
        `;
      } catch (error) {
        throw sanitizedDatabaseError('IDENTITY_SYNC_ATTEMPT_RECORD_FAILED', error);
      }
      options.onApplied?.(result);
    },

    async recordFailure(event, error, retryable, pool) {
      const parsed = lifecyclePayloadSchema.safeParse(event.payload);
      if (!parsed.success) return;
      await pool`
        SELECT app.identity_sync_record_attempt(
          ${parsed.data.webhook_event_id}::uuid, ${event.attempts}::integer,
          ${retryable ? 'retryable_error' : 'permanent_error'},
          ${(startedAt.get(event) ?? new Date()).toISOString()}::timestamptz,
          ${lifecycleErrorCode(error)}, ${workerId}, ${event.id}
        )
      `;
    },
  };
}

