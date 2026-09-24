/**
 * S1-04 invitation email delivery (ADR-004 outbox + ADR-009 §9 phased worker).
 *
 *   API transaction      invitation row + outbox job (nonce + immutable
 *                        delivery snapshot; no token, no recipient PII)
 *   worker PHASE A       claim + payload read (autocommit)
 *   worker PHASE B       (1) one short READ transaction under the job's
 *                            tenant: recipient + token_hash (immutable); for
 *                            a pending invitation re-derive the token, check
 *                            it against token_hash and render the message;
 *                        (2) ONE autocommit call acquiring the delivery LEASE
 *                            (0009 app.worker_acquire_invitation_email_lease):
 *                            advisory lock -> still pending and valid for the
 *                            whole lease -> no other active lease -> lease
 *                            committed. While it is valid, accept/revoke/expire
 *                            cannot commit (409 INVITATION_IN_PROGRESS);
 *                        (3) ONE Resend call with no transaction, no reserved
 *                            connection and no lock, only if this attempt's
 *                            monotonic deadline (measured from BEFORE the
 *                            acquire call, so it ends no later than the
 *                            database lease) still covers the whole request
 *                            timeout. `Idempotency-Key: membership-invitation/<id>`
 *   worker PHASE C       new short transaction: record the provider acceptance
 *                        + release the lease (0009 complete function), audit,
 *                        outbox `processed` -- one commit.
 *
 * Invariant: once a terminal transition has committed, no provider request
 * for that invitation can START: every lease acquired before it has expired
 * (and with it every attempt's local send deadline) or was released after
 * its request finished; every later acquire sees the terminal state.
 *
 * Retries never create an invitation or a token: the same nonce reproduces the
 * same token, every other message input comes from the immutable delivery
 * snapshot in the job payload (see InvitationDeliverySnapshot), so the same
 * idempotency key always carries the same request and Resend deduplicates.
 * accepted/revoked/expired invitations are never emailed.
 */

import { performance } from 'node:perf_hooks';
import type postgres from 'postgres';
import { z } from 'zod';
import { ROLE_NAMES_ES, type RoleCode } from '../authz/rbac-matrix.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import {
  PermanentDispatchError,
  TransientDispatchError,
  type OutboxEvent,
  type PhasedOutboxHandler,
} from '../worker/outbox-worker.js';
import type { InvitationEmailConfig } from './config.js';
import {
  deriveInvitationToken,
  invitationAcceptUrl,
  invitationTokenMatchesHash,
  INVITATION_TOKEN_PATTERN,
} from './token.js';

export const INVITATION_EMAIL_EVENT_TYPE = 'membership.invitation_email_requested';

/* -------------------------------------------------------------------------- */
/* Resend client                                                              */
/* -------------------------------------------------------------------------- */

export interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailSendOptions {
  /** Upper bound for this request (the lease's remaining send window). */
  readonly timeoutMs?: number;
}

export interface EmailSender {
  /**
   * Throws TransientDispatchError (retryable) or PermanentDispatchError. An
   * error for which isProviderRejection() is true means the provider answered
   * and definitively did NOT accept the message.
   */
  send(message: EmailMessage, idempotencyKey: string, options?: EmailSendOptions): Promise<{ readonly providerMessageId: string }>;
}

const providerRejections = new WeakSet<object>();

/** Marks an error as "the provider answered and did not accept the message". */
export function markProviderRejection<T extends Error>(error: T): T {
  providerRejections.add(error);
  return error;
}

/**
 * True only when the provider definitively refused the request. Timeouts,
 * network errors, 5xx, 408 and 409 concurrent-idempotency are AMBIGUOUS (the
 * message may have been accepted) and keep the delivery lease until expiry.
 */
export function isProviderRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && providerRejections.has(error);
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Minimal Resend REST client (POST /emails). Error messages carry only a
 * stable code + HTTP status: never the API key, the recipient or the body.
 */
export class ResendEmailSender implements EmailSender {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: Pick<InvitationEmailConfig, 'resendApiKey' | 'resendBaseUrl' | 'resendTimeoutMs'>,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(message: EmailMessage, idempotencyKey: string, options: EmailSendOptions = {}): Promise<{ providerMessageId: string }> {
    const timeoutMs = Math.max(1, Math.floor(Math.min(this.config.resendTimeoutMs, options.timeoutMs ?? Infinity)));
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/emails', this.config.resendBaseUrl).toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.resendApiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new TransientDispatchError('RESEND_NETWORK_ERROR');
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.ok) {
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        throw new TransientDispatchError('RESEND_RESPONSE_INVALID');
      }
      return { providerMessageId: id };
    }

    const status = response.status;
    const name = (body as { name?: unknown } | null)?.name;
    // Same key still in flight on Resend's side: retry later (ambiguous).
    if (status === 409 && name === 'concurrent_idempotent_requests') {
      throw new TransientDispatchError('RESEND_HTTP_409_CONCURRENT');
    }
    if (status === 408 || status >= 500) {
      throw new TransientDispatchError(`RESEND_HTTP_${status}`);
    }
    // Any other 4xx: the provider answered and refused this request.
    if (status === 429 || status === 401 || status === 403) {
      throw markProviderRejection(new TransientDispatchError(`RESEND_HTTP_${status}`));
    }
    throw markProviderRejection(new PermanentDispatchError(`RESEND_HTTP_${status}`));
  }
}

/* -------------------------------------------------------------------------- */
/* Message                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Header-safe single line (subject). */
function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 160);
}

/**
 * Delivery snapshot (S104-02). Every input of the Resend request that is not
 * immutable in PostgreSQL is frozen here by the API when the invitation and
 * its job are created, and stored in the job payload (outbox payload_json is
 * never updatable by runtime roles: 0003). A retry therefore rebuilds the
 * byte-identical request for the same Resend idempotency key, whatever
 * happened meanwhile to workshops.display_name, the role labels, the
 * configured sender / accept URL or the template code.
 *
 * Not in the snapshot, by design:
 *   - the recipient: membership_invitations.email is immutable for the whole
 *     lifecycle (0008 trigger mi_immutable_columns) and is PII, so it stays
 *     out of the job payload and is re-read;
 *   - the token: re-derived from (secret, invitation id, nonce, key version),
 *     never stored in any form (./token.ts);
 *   - transport settings (Resend base URL, API key, timeout): they select the
 *     endpoint/credentials, they are not part of the idempotent payload.
 *
 * Template changes MUST add a new template_version renderer and keep the old
 * one until no job of that version can still be retried.
 */
export const INVITATION_EMAIL_EVENT_VERSION = 2;
export const INVITATION_EMAIL_TEMPLATE_VERSION = 1;

export interface InvitationDeliverySnapshot {
  readonly template_version: typeof INVITATION_EMAIL_TEMPLATE_VERSION;
  readonly from: string;
  readonly accept_url: string;
  readonly workshop_name: string;
  readonly role_label: string;
  readonly expires_at: string;
}

const deliverySnapshotSchema = z.object({
  template_version: z.literal(INVITATION_EMAIL_TEMPLATE_VERSION),
  from: z.string().min(3).max(320).refine((value) => !/[\r\n]/u.test(value) && value.includes('@')),
  accept_url: z.url().max(2048),
  workshop_name: z.string().min(1).max(500),
  role_label: z.string().min(1).max(80),
  expires_at: z.iso.datetime(),
}).strict();

export interface InvitationDeliverySnapshotInput {
  readonly from: string;
  readonly acceptUrl: string;
  readonly workshopName: string;
  readonly role: RoleCode;
  readonly expiresAt: Date;
}

/** API side: freezes the message inputs at job creation. */
export function buildInvitationDeliverySnapshot(input: InvitationDeliverySnapshotInput): InvitationDeliverySnapshot {
  return deliverySnapshotSchema.parse({
    template_version: INVITATION_EMAIL_TEMPLATE_VERSION,
    from: input.from,
    accept_url: input.acceptUrl,
    workshop_name: input.workshopName,
    role_label: ROLE_NAMES_ES[input.role],
    expires_at: input.expiresAt.toISOString(),
  }) as InvitationDeliverySnapshot;
}

/** Template v1: a pure function of (snapshot, recipient, accept link). */
export function renderInvitationEmail(snapshot: InvitationDeliverySnapshot, to: string, acceptUrl: string): EmailMessage {
  const workshop = singleLine(snapshot.workshop_name);
  const roleName = singleLine(snapshot.role_label);
  const expires = new Date(snapshot.expires_at).toISOString().slice(0, 10);
  const text = [
    `Te invitaron a unirte a ${workshop} en TallerMecario como ${roleName}.`,
    '',
    `Acepta la invitación (válida hasta ${expires} UTC) iniciando sesión con este mismo correo verificado:`,
    acceptUrl,
    '',
    'Si no esperabas esta invitación, ignora este correo.',
  ].join('\n');
  const html = [
    '<!doctype html><html><body>',
    `<p>Te invitaron a unirte a <strong>${escapeHtml(workshop)}</strong> en TallerMecario como ${escapeHtml(roleName)}.</p>`,
    `<p>Acepta la invitación (válida hasta ${expires} UTC) iniciando sesión con este mismo correo verificado:</p>`,
    `<p><a href="${escapeHtml(acceptUrl)}">Aceptar invitación</a></p>`,
    '<p>Si no esperabas esta invitación, ignora este correo.</p>',
    '</body></html>',
  ].join('');
  return { from: snapshot.from, to, subject: `Invitación a ${workshop} — TallerMecario`, html, text };
}

/* -------------------------------------------------------------------------- */
/* Phased outbox handler                                                      */
/* -------------------------------------------------------------------------- */

const payloadSchema = z.object({
  invitation_id: z.uuid(),
  token_nonce: z.string().regex(INVITATION_TOKEN_PATTERN),
  token_key_version: z.number().int().positive(),
  delivery: deliverySnapshotSchema,
}).strict();

export interface InvitationEmailPayload {
  readonly invitation_id: string;
  readonly token_nonce: string;
  readonly token_key_version: number;
  readonly delivery: InvitationDeliverySnapshot;
}

export type InvitationEmailPrepared =
  | {
    readonly kind: 'sent';
    readonly invitationId: string;
    readonly leaseId: string;
    readonly providerMessageId: string;
  }
  | {
    readonly kind: 'skipped';
    readonly invitationId: string;
    readonly reason: 'accepted' | 'revoked' | 'expired';
    readonly priorAttemptUnconfirmed: boolean;
  }
  | { readonly kind: 'already_sent'; readonly invitationId: string };

interface InvitationEmailRow {
  email: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  is_expired: boolean;
  token_hash: string;
}

type LeaseOutcome =
  | 'acquired'
  | 'skip_accepted'
  | 'skip_revoked'
  | 'skip_expired'
  | 'already_sent'
  | 'busy'
  | 'not_claimed'
  | 'not_found';

interface LeaseRow {
  lease_outcome: LeaseOutcome;
  lease_until: Date | null;
  prior_attempt_unconfirmed: boolean;
}

interface CompletionRow {
  delivery_outcome: 'recorded' | 'already_recorded';
  delivery_lease_state: 'held' | 'expired' | 'superseded' | null;
  delivery_invitation_status: string | null;
}

/** Lease = request timeout + this margin (DB clamps the lease to 2..120 s). */
export const INVITATION_EMAIL_LEASE_MARGIN_SECONDS = 15;
/** Local safety margin subtracted from the lease before any send may start. */
export const INVITATION_EMAIL_LEASE_SAFETY_MS = 2_000;
/** Below this remaining window the attempt gives up instead of sending. */
export const INVITATION_EMAIL_MIN_SEND_WINDOW_MS = 1_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface InvitationEmailHandlerOptions {
  readonly config: Pick<InvitationEmailConfig, 'tokenKey'>;
  readonly sender: EmailSender;
  /** The sender's own request timeout (RESEND_TIMEOUT_MS). */
  readonly sendTimeoutMs?: number;
  /** Override of the lease length in seconds (tests); default timeout + margin. */
  readonly leaseSeconds?: number;
  /** Monotonic clock in ms (tests); default performance.now. */
  readonly now?: () => number;
}

export function invitationEmailIdempotencyKey(invitationId: string): string {
  return `membership-invitation/${invitationId}`;
}

async function releaseLease(pool: postgres.Sql, event: OutboxEvent, leaseId: string): Promise<void> {
  // Best effort: a failed release only means the lease runs to expiry.
  await pool`SELECT app.worker_release_invitation_email_lease(${event.id}, ${leaseId}) AS released`.catch(() => undefined);
}

export function createInvitationEmailHandler(
  options: InvitationEmailHandlerOptions,
): PhasedOutboxHandler<InvitationEmailPrepared> {
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const leaseSeconds = options.leaseSeconds ?? Math.ceil(sendTimeoutMs / 1000) + INVITATION_EMAIL_LEASE_MARGIN_SECONDS;
  const now = options.now ?? (() => performance.now());

  return {
    kind: 'phased',

    async prepare(event: OutboxEvent, pool: postgres.Sql): Promise<InvitationEmailPrepared> {
      if (event.eventVersion !== INVITATION_EMAIL_EVENT_VERSION) {
        throw new PermanentDispatchError('INVITATION_EMAIL_EVENT_VERSION_UNSUPPORTED');
      }
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new PermanentDispatchError('INVITATION_EMAIL_PAYLOAD_INVALID');
      const payload = parsed.data as InvitationEmailPayload;
      if (!event.tenantId || event.aggregateId !== payload.invitation_id) {
        throw new PermanentDispatchError('INVITATION_EMAIL_PAYLOAD_INVALID');
      }
      if (payload.token_key_version !== options.config.tokenKey.version) {
        throw new PermanentDispatchError('INVITATION_TOKEN_KEY_VERSION_UNKNOWN');
      }

      // (1) Short tenant-scoped READ transaction, committed before anything else.
      const [row] = await pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${event.tenantId}, true)`;
        // Immutable columns only (0008 mi_immutable_columns) + status. Nothing
        // mutable that shapes the message is read here: see the snapshot.
        return tx<InvitationEmailRow[]>`
          SELECT i.email, i.status, (i.expires_at <= pg_catalog.clock_timestamp()) AS is_expired, i.token_hash
          FROM public.membership_invitations AS i
          WHERE i.id = ${payload.invitation_id} AND i.tenant_id = ${event.tenantId}
        `;
      });
      if (!row) throw new PermanentDispatchError('INVITATION_EMAIL_TARGET_NOT_FOUND');

      // This read only supplies the (immutable) recipient and token hash. It
      // never decides: skip/send is decided by the lease acquisition below,
      // which also reports an earlier attempt with an unknown outcome.
      let message: EmailMessage | null = null;
      if (row.status === 'pending' && !row.is_expired) {
        const token = deriveInvitationToken(options.config.tokenKey, payload.invitation_id, payload.token_nonce);
        if (!invitationTokenMatchesHash(token, row.token_hash)) {
          // Wrong secret/key version on this worker: never send a dead link.
          throw new PermanentDispatchError('INVITATION_TOKEN_MISMATCH');
        }
        message = renderInvitationEmail(
          payload.delivery,
          row.email,
          invitationAcceptUrl(payload.delivery.accept_url, token),
        );
      }

      // (2) Lease. The local deadline starts BEFORE the call, so it can only
      // end earlier than the database lease (which starts inside the call).
      const leaseId = uuidV7();
      const startedAt = now();
      const [lease] = await pool<LeaseRow[]>`
        SELECT lease_outcome, lease_until, prior_attempt_unconfirmed
        FROM app.worker_acquire_invitation_email_lease(${event.id}, ${leaseId}, ${leaseSeconds})
      `;
      switch (lease?.lease_outcome) {
        case 'acquired':
          break;
        case 'skip_accepted':
        case 'skip_revoked':
        case 'skip_expired':
          return {
            kind: 'skipped',
            invitationId: payload.invitation_id,
            reason: lease.lease_outcome.slice('skip_'.length) as 'accepted' | 'revoked' | 'expired',
            priorAttemptUnconfirmed: lease.prior_attempt_unconfirmed,
          };
        case 'already_sent':
          return { kind: 'already_sent', invitationId: payload.invitation_id };
        case 'busy':
          throw new TransientDispatchError('INVITATION_EMAIL_LEASE_BUSY');
        case 'not_claimed':
          throw new TransientDispatchError('INVITATION_EMAIL_JOB_NOT_CLAIMED');
        case 'not_found':
          throw new PermanentDispatchError('INVITATION_EMAIL_TARGET_NOT_FOUND');
        default:
          throw new TransientDispatchError('INVITATION_EMAIL_LEASE_RESULT_INVALID');
      }

      if (!message) {
        // Terminal/expired on the read but leased now: impossible (terminal
        // states are final, expiry is checked by the lease). Fail closed.
        await releaseLease(pool, event, leaseId);
        throw new TransientDispatchError('INVITATION_EMAIL_STATE_INCONSISTENT');
      }

      // (3) Send only if the whole request fits inside this attempt's lease.
      const deadline = startedAt + leaseSeconds * 1000 - INVITATION_EMAIL_LEASE_SAFETY_MS;
      const window = Math.min(sendTimeoutMs, deadline - now());
      if (window < INVITATION_EMAIL_MIN_SEND_WINDOW_MS) {
        await releaseLease(pool, event, leaseId); // no request was made
        throw new TransientDispatchError('INVITATION_EMAIL_LEASE_WINDOW_TOO_SHORT');
      }
      try {
        const { providerMessageId } = await options.sender.send(
          message,
          invitationEmailIdempotencyKey(payload.invitation_id),
          { timeoutMs: window },
        );
        return { kind: 'sent', invitationId: payload.invitation_id, leaseId, providerMessageId };
      } catch (error) {
        // Definitive refusal: nothing can be in flight, free the invitation
        // now. Ambiguous failure: keep the lease until it expires.
        if (isProviderRejection(error)) await releaseLease(pool, event, leaseId);
        throw error;
      }
    },

    async apply(event: OutboxEvent, prepared: InvitationEmailPrepared, tx: postgres.ReservedSql): Promise<void> {
      let action: string;
      let metadata: postgres.JSONValue;
      if (prepared.kind === 'already_sent') return; // recorded once already: no second audit
      if (prepared.kind === 'sent') {
        const [completion] = await tx<CompletionRow[]>`
          SELECT delivery_outcome, delivery_lease_state, delivery_invitation_status
          FROM app.worker_complete_invitation_email_delivery(${event.id}, ${prepared.leaseId}, ${prepared.providerMessageId})
        `;
        if (!completion) throw new Error('INVITATION_EMAIL_COMPLETION_MISSING');
        if (completion.delivery_outcome === 'already_recorded') return;
        action = 'membership.invitation_email_sent';
        metadata = {
          provider: 'resend',
          provider_message_id: prepared.providerMessageId,
          outbox_event_id: event.id,
          attempt: event.attempts,
          lease_state: completion.delivery_lease_state,
          // Only when this attempt's lease had lapsed before the recording.
          ...(completion.delivery_lease_state === 'held'
            ? {}
            : { invitation_status_at_record: completion.delivery_invitation_status }),
        };
      } else {
        action = 'membership.invitation_email_skipped';
        metadata = {
          reason: prepared.reason,
          outbox_event_id: event.id,
          attempt: event.attempts,
          ...(prepared.priorAttemptUnconfirmed ? { prior_attempt_unconfirmed: true } : {}),
        };
      }
      await tx`
        INSERT INTO public.audit_logs (
          id, tenant_id, actor_type, action, outcome, entity_type, entity_id,
          reason_code, metadata_json, request_id
        ) VALUES (
          ${uuidV7()}, ${event.tenantId}, 'system', ${action},
          'success', 'membership_invitation', ${prepared.invitationId}, 'membership_invitation',
          ${tx.json(metadata)}, ${`outbox:${event.id}`}
        )
      `;
    },
  };
}
