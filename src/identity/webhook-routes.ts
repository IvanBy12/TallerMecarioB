import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { ApiError, getRawRequestBody } from '../api/app.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { ClerkWebhookError, verifyClerkWebhook, type VerifiedClerkUserEvent } from './clerk/webhook.js';

/**
 * POST /api/v1/webhooks/clerk — thin webhook (ADR-004/ADR-006, Contratos
 * Externos convention `/api/v1/webhooks/<provider>`).
 *
 * Public route: no user JWT, no TenantContext, no X-Tenant-Id. Authentication
 * is the Svix signature over the raw body. Flow:
 *   verify signature -> minimal envelope -> ONE transaction
 *   (webhook_events projection + outbox job) -> 204.
 * No Clerk Backend API call and no identity mutation happen here; the worker
 * fetches the current identity state (fetch-on-process).
 */

export type ClerkIngestResult = 'accepted' | 'duplicate' | 'conflict';

export interface ClerkWebhookRepository {
  ingest(event: VerifiedClerkUserEvent, ids: {
    webhookEventId: string;
    outboxEventId: string;
    requestId: string;
  }): Promise<ClerkIngestResult>;
}

export class PostgresClerkWebhookRepository implements ClerkWebhookRepository {
  constructor(private readonly database: postgres.Sql) {}

  async ingest(event: VerifiedClerkUserEvent, ids: {
    webhookEventId: string;
    outboxEventId: string;
    requestId: string;
  }): Promise<ClerkIngestResult> {
    const [row] = await this.database<{ result: ClerkIngestResult }[]>`
      SELECT result FROM app.ingest_verified_clerk_webhook(
        ${ids.webhookEventId}::uuid,
        ${ids.outboxEventId}::uuid,
        ${event.providerEventId},
        ${event.payloadHash},
        ${event.eventType},
        ${event.externalSubject},
        ${event.occurredAt.toISOString()}::timestamptz,
        ${this.database.json(event.headers)},
        ${ids.requestId}
      )
    `;
    if (!row) throw new Error('CLERK_WEBHOOK_PERSISTENCE_FAILED');
    return row.result;
  }
}

export interface RegisterClerkWebhookRouteOptions {
  readonly signingSecret: string;
  readonly repository: ClerkWebhookRepository;
  readonly createId?: () => string;
}

export function registerClerkWebhookRoute(app: FastifyInstance, options: RegisterClerkWebhookRouteOptions): void {
  const createId = options.createId ?? uuidV7;
  app.post('/api/v1/webhooks/clerk', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    let verified;
    try {
      verified = await verifyClerkWebhook({
        rawBody: getRawRequestBody(request),
        headers: request.headers,
        signingSecret: options.signingSecret,
      });
    } catch (error) {
      if (error instanceof ClerkWebhookError && error.reason === 'payload') {
        throw new ApiError(400, 'CLERK_WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid.');
      }
      throw new ApiError(401, 'CLERK_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
    }

    // Verified but not an S1-03 identity event: ACK, nothing stored.
    if (verified.kind === 'ignored') return reply.code(204).send();

    let result: ClerkIngestResult;
    try {
      result = await options.repository.ingest(verified, {
        webhookEventId: createId(),
        outboxEventId: createId(),
        requestId: request.id,
      });
    } catch {
      throw new ApiError(503, 'CLERK_WEBHOOK_PERSISTENCE_UNAVAILABLE', 'Webhook persistence is unavailable.');
    }
    if (result === 'conflict') {
      throw new ApiError(409, 'CLERK_WEBHOOK_EVENT_CONFLICT', 'Webhook event conflicts with a stored event.');
    }
    return reply.code(204).send();
  });
}
