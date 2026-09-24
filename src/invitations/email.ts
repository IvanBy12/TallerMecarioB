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
 * same token, the request body is deterministic and Resend deduplicates on the
 * idempotency key. accepted/revoked/expired invitations are never emailed.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { ROLE_NAMES_ES, type RoleCode } from '../authz/rbac-matrix.js';
import { ROLE_CODES } from '../authz/rbac-matrix.js';
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

export interface InvitationMessageInput {
  readonly from: string;
  readonly to: string;
  readonly workshopName: string;
  readonly role: RoleCode;
  readonly acceptUrl: string;
  readonly expiresAt: Date;
}

export function buildInvitationMessage(input: InvitationMessageInput): EmailMessage {
  const workshop = singleLine(input.workshopName);
  const roleName = ROLE_NAMES_ES[input.role];
  const expires = input.expiresAt.toISOString().slice(0, 10);
  const text = [
    `Te invitaron a unirte a ${workshop} en TallerMecario como ${roleName}.`,
    '',
    `Acepta la invitación (válida hasta ${expires} UTC) iniciando sesión con este mismo correo verificado:`,
    input.acceptUrl,
    '',
    'Si no esperabas esta invitación, ignora este correo.',
  ].join('\n');
  const html = [
    '<!doctype html><html><body>',
    `<p>Te invitaron a unirte a <strong>${escapeHtml(workshop)}</strong> en TallerMecario como ${escapeHtml(roleName)}.</p>`,
    `<p>Acepta la invitación (válida hasta ${expires} UTC) iniciando sesión con este mismo correo verificado:</p>`,
    `<p><a href="${escapeHtml(input.acceptUrl)}">Aceptar invitación</a></p>`,
    '<p>Si no esperabas esta invitación, ignora este correo.</p>',
    '</body></html>',
  ].join('');
  return { from: input.from, to: input.to, subject: `Invitación a ${workshop} — TallerMecario`, html, text };
}

/* -------------------------------------------------------------------------- */
/* Phased outbox handler                                                      */
/* -------------------------------------------------------------------------- */

const payloadSchema = z.object({
  invitation_id: z.uuid(),
  token_nonce: z.string().regex(INVITATION_TOKEN_PATTERN),
  token_key_version: z.number().int().positive(),
}).strict();

export type InvitationEmailPrepared =
  | { readonly kind: 'sent'; readonly invitationId: string; readonly providerMessageId: string }
  | { readonly kind: 'skipped'; readonly invitationId: string; readonly reason: 'accepted' | 'revoked' | 'expired' };

interface InvitationEmailRow {
  email: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  is_expired: boolean;
  token_hash: string;
  role_code: string;
  display_name: string;
  expires_at: Date;
}

export interface InvitationEmailHandlerOptions {
  readonly config: Pick<InvitationEmailConfig, 'tokenKey' | 'acceptUrl' | 'from'>;
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
      const parsed = payloadSchema.safeParse(event.payload);
      if (!parsed.success) throw new PermanentDispatchError('INVITATION_EMAIL_PAYLOAD_INVALID');
      const payload = parsed.data;
      if (!event.tenantId || event.aggregateId !== payload.invitation_id) {
        throw new PermanentDispatchError('INVITATION_EMAIL_PAYLOAD_INVALID');
      }
      if (payload.token_key_version !== options.config.tokenKey.version) {
        throw new PermanentDispatchError('INVITATION_TOKEN_KEY_VERSION_UNKNOWN');
      }

      // Short tenant-scoped READ transaction, committed before the network call.
      const [row] = await pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${event.tenantId}, true)`;
        return tx<InvitationEmailRow[]>`
          SELECT i.email, i.status, (i.expires_at <= pg_catalog.clock_timestamp()) AS is_expired,
            i.token_hash, r.code AS role_code, w.display_name, i.expires_at
          FROM public.membership_invitations AS i
          JOIN public.roles AS r ON r.id = i.target_role_id
          JOIN public.workshops AS w ON w.id = i.tenant_id
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

      const role = ROLE_CODES.find((code) => code === row.role_code);
      if (!role) throw new PermanentDispatchError('INVITATION_EMAIL_ROLE_INVALID');
      const token = deriveInvitationToken(options.config.tokenKey, payload.invitation_id, payload.token_nonce);
      if (!invitationTokenMatchesHash(token, row.token_hash)) {
        // Wrong secret/key version on this worker: never send a dead link.
        throw new PermanentDispatchError('INVITATION_TOKEN_MISMATCH');
      }

      const message = buildInvitationMessage({
        from: options.config.from,
        to: row.email,
        workshopName: row.display_name,
        role,
        acceptUrl: invitationAcceptUrl(options.config.acceptUrl, token),
        expiresAt: row.expires_at,
      });
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
