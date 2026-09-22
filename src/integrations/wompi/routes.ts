import type { FastifyInstance } from 'fastify';
import { ApiError, getRawRequestBody } from '../../api/app.js';
import { uuidV7 } from '../../platform/uuid-v7.js';
import type { WompiWebhookRepository } from './repository.js';
import { verifyWompiWebhook, WompiWebhookError } from './webhook.js';

export interface RegisterWompiWebhookOptions {
  eventSecret: string;
  environment: 'test' | 'production';
  repository: WompiWebhookRepository;
  createId?: () => string;
}

export function registerWompiWebhookRoute(app: FastifyInstance, options: RegisterWompiWebhookOptions): void {
  const expectedSecretPrefix = options.environment === 'test' ? 'test_events_' : 'prod_events_';
  if (!options.eventSecret.startsWith(expectedSecretPrefix)) {
    throw new Error('WOMPI_EVENT_SECRET_ENVIRONMENT_MISMATCH');
  }
  const createId = options.createId ?? uuidV7;
  app.post('/api/v1/webhooks/wompi', {
    config: { publicWebhook: true },
  }, async (request, reply) => {
    const headerValue = request.headers['x-event-checksum'];
    const headerChecksum = Array.isArray(headerValue) ? undefined : headerValue;
    let verified;
    try {
      verified = verifyWompiWebhook({
        rawBody: getRawRequestBody(request),
        headerChecksum,
        eventSecret: options.eventSecret,
        expectedEnvironment: options.environment,
      });
    } catch (error) {
      if (error instanceof WompiWebhookError) {
        if (error.reason === 'signature') {
          throw new ApiError(401, 'WOMPI_WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
        }
        if (error.reason === 'environment') {
          throw new ApiError(400, 'WOMPI_WEBHOOK_ENVIRONMENT_INVALID', 'Webhook environment is invalid.');
        }
        throw new ApiError(400, 'WOMPI_WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid.');
      }
      throw error;
    }
    try {
      await options.repository.persistVerifiedWebhook({
        ...verified,
        webhookEventId: createId(),
        outboxEventId: createId(),
      });
    } catch {
      throw new ApiError(503, 'WOMPI_WEBHOOK_PERSISTENCE_UNAVAILABLE', 'Webhook persistence is unavailable.');
    }
    return reply.code(204).send();
  });
}
