import type { FastifyInstance } from 'fastify';
import { getTenantRequestContext } from '../api/app.js';
import type { R2Config } from './r2.js';
import {
  MediaError,
  completeUploadSession,
  createUploadSession,
  getMediaDownloadUrl,
} from './service.js';

/** API conventions (base path, stable error codes + request_id): Arquitectura Técnica v1 §13. */
function sendMediaError(request: { id: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: MediaError) {
  return reply.code(error.statusCode).send({
    error: { code: error.code, message: error.message, request_id: request.id },
  });
}

export function registerMediaRoutes(app: FastifyInstance, r2: R2Config): void {
  app.post(
    '/api/v1/media/upload-sessions',
    {
      // Security Baseline §10: uploads get a stricter per-route limit than
      // the global default (@fastify/rate-limit route-level override).
      // RBAC: tenant scope. Technician's `media.upload = assigned` stays
      // denied until an order-assignment resource check exists (Sprint 2+).
      config: { permission: 'media.upload', rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mediaType', 'mimeType', 'retentionClass', 'idempotencyKey'],
          properties: {
            mediaType: { type: 'string' },
            mimeType: { type: 'string' },
            retentionClass: { type: 'string' },
            idempotencyKey: { type: 'string', format: 'uuid' },
            expectedSizeBytes: { type: 'integer', minimum: 1 },
            capturedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const context = getTenantRequestContext(request);
      const body = request.body as {
        mediaType: string;
        mimeType: string;
        retentionClass: string;
        idempotencyKey: string;
        expectedSizeBytes?: number;
        capturedAt?: string;
      };
      try {
        const result = await createUploadSession(context.sql, r2, context.tenant.tenantId, context.tenant.membershipId, body);
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof MediaError) return sendMediaError(request, reply, error);
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/media/upload-sessions/:id/complete',
    {
      config: { permission: 'media.upload' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { checksumSha256: { type: 'string', minLength: 64, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const context = getTenantRequestContext(request);
      const { id } = request.params as { id: string };
      const { checksumSha256 } = (request.body ?? {}) as { checksumSha256?: string };
      try {
        const result = await completeUploadSession(context.sql, r2, context.tenant.tenantId, id, checksumSha256 ?? null);
        return reply.send(result);
      } catch (error) {
        if (error instanceof MediaError) return sendMediaError(request, reply, error);
        throw error;
      }
    },
  );

  app.get('/api/v1/media/:id/download-url', { config: { permission: 'media.read' } }, async (request, reply) => {
    const context = getTenantRequestContext(request);
    const { id } = request.params as { id: string };
    try {
      const result = await getMediaDownloadUrl(context.sql, r2, context.tenant.tenantId, id);
      return reply.send(result);
    } catch (error) {
      if (error instanceof MediaError) return sendMediaError(request, reply, error);
      throw error;
    }
  });
}
