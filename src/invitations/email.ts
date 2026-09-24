/**
 * S1-04 invitation email delivery (ADR-004 outbox + ADR-009 §9 phased worker).
 *
 *   API transaction      invitation row + outbox job (nonce only, no token/PII)
 *   worker PHASE A       claim + payload read (autocommit)
 *   worker PHASE B       one short READ transaction under the job's tenant
 *                        (committed before any network call): the invitation
 *                        must still be pending and unexpired; the token is
 *                        re-derived and checked against token_hash; then ONE
 *                        Resend call with no transaction, no reserved
 *                        connection and no lock, with a finite timeout and
 *                        `Idempotency-Key: membership-invitation/<id>`
 *   worker PHASE C       new short transaction: audit the delivery outcome
 *
 * Retries never create an invitation or a token: the same nonce reproduces the
 * same token, every other message input comes from the immutable delivery
 * snapshot in the job payload (see InvitationDeliverySnapshot), so the same
 * idempotency key always carries the same request and Resend deduplicates.
 * accepted/revoked/expired invitations are never emailed.
 */

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

export interface EmailSender {
  /** Throws TransientDispatchError (retryable) or PermanentDispatchError. */
  send(message: EmailMessage, idempotencyKey: string): Promise<{ readonly providerMessageId: string }>;
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

  async send(message: EmailMessage, idempotencyKey: string): Promise<{ providerMessageId: string }> {
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
        signal: AbortSignal.timeout(this.config.resendTimeoutMs),
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
    // Same key still in flight on Resend's side: retry later.
    if (status === 409 && name === 'concurrent_idempotent_requests') {
      throw new TransientDispatchError('RESEND_HTTP_409_CONCURRENT');
    }
    if (status === 408 || status === 429 || status >= 500 || status === 401 || status === 403) {
      throw new TransientDispatchError(`RESEND_HTTP_${status}`);
    }
    throw new PermanentDispatchError(`RESEND_HTTP_${status}`);
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
  | { readonly kind: 'sent'; readonly invitationId: string; readonly providerMessageId: string }
  | { readonly kind: 'skipped'; readonly invitationId: string; readonly reason: 'accepted' | 'revoked' | 'expired' };

interface InvitationEmailRow {
  email: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  is_expired: boolean;
  token_hash: string;
}

export interface InvitationEmailHandlerOptions {
  readonly config: Pick<InvitationEmailConfig, 'tokenKey'>;
  readonly sender: EmailSender;
}

export function invitationEmailIdempotencyKey(invitationId: string): string {
  return `membership-invitation/${invitationId}`;
}

export function createInvitationEmailHandler(
  options: InvitationEmailHandlerOptions,
): PhasedOutboxHandler<InvitationEmailPrepared> {
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

      // Short tenant-scoped READ transaction, committed before the network call.
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

      if (row.status === 'accepted' || row.status === 'revoked') {
        return { kind: 'skipped', invitationId: payload.invitation_id, reason: row.status };
      }
      if (row.status === 'expired' || row.is_expired) {
        return { kind: 'skipped', invitationId: payload.invitation_id, reason: 'expired' };
      }

      const token = deriveInvitationToken(options.config.tokenKey, payload.invitation_id, payload.token_nonce);
      if (!invitationTokenMatchesHash(token, row.token_hash)) {
        // Wrong secret/key version on this worker: never send a dead link.
        throw new PermanentDispatchError('INVITATION_TOKEN_MISMATCH');
      }

      const message = renderInvitationEmail(
        payload.delivery,
        row.email,
        invitationAcceptUrl(payload.delivery.accept_url, token),
      );
      const { providerMessageId } = await options.sender.send(message, invitationEmailIdempotencyKey(payload.invitation_id));
      return { kind: 'sent', invitationId: payload.invitation_id, providerMessageId };
    },

    async apply(event: OutboxEvent, prepared: InvitationEmailPrepared, tx: postgres.ReservedSql): Promise<void> {
      await tx`
        INSERT INTO public.audit_logs (
          id, tenant_id, actor_type, action, outcome, entity_type, entity_id,
          reason_code, metadata_json, request_id
        ) VALUES (
          ${uuidV7()}, ${event.tenantId}, 'system',
          ${prepared.kind === 'sent' ? 'membership.invitation_email_sent' : 'membership.invitation_email_skipped'},
          'success', 'membership_invitation', ${prepared.invitationId}, 'membership_invitation',
          ${tx.json(prepared.kind === 'sent'
            ? { provider: 'resend', provider_message_id: prepared.providerMessageId, outbox_event_id: event.id, attempt: event.attempts }
            : { reason: prepared.reason, outbox_event_id: event.id, attempt: event.attempts })},
          ${`outbox:${event.id}`}
        )
      `;
    },
  };
}
