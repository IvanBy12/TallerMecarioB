import { removeUnattachedMedia } from './deletion.js';
import { attachMedia, listAssociatedMedia, type AssociationTarget } from './associations.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import type { FastifyInstance } from 'fastify';
import { ApiError, getTenantRequestContext, markDurableTenantOutcome } from '../api/app.js';
import { runMediaInspectionWithoutTransaction, runMediaAssociationTransaction } from '../api/tenant-request.js';
import type { R2Config } from './r2.js';
import type { OperationalContext } from './operational-binding.js';
import {
  MediaError,
  completeUploadSession,
  prepareUploadCompletion,
  inspectUploadCompletion,
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
  app.post('/api/v1/media/:mediaAssetId/remove-unattached', {
    config: { permission: 'media.remove_unattached' }, bodyLimit: 2048,
    onRequest: async (_request, reply) => { reply.header('cache-control', 'no-store'); },
  }, async (request, reply) => {
    try {
      if (request.body !== undefined && (request.body === null || typeof request.body !== 'object'
        || Array.isArray(request.body) || Object.keys(request.body as object).length))
        throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
      if (Object.keys((request.query ?? {}) as object).length)
        throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');
      const id = parseCanonicalUuid((request.params as { mediaAssetId: string }).mediaAssetId);
      if (!id) throw new MediaError(404, 'MEDIA_ASSET_NOT_FOUND', 'The media asset was not found.');
      const result = await runMediaAssociationTransaction(request, context => removeUnattachedMedia(context.sql, id));
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof MediaError) return sendMediaError(request, reply, error);
      throw error;
    }
  });
  for (const type of ['reception', 'damage'] as const) {
    const url = type === 'reception' ? '/api/v1/receptions/:receptionId/media'
      : '/api/v1/receptions/:receptionId/damages/:damageId/media';
    const target = (params: unknown): AssociationTarget => {
      const p = params as { receptionId: string; damageId?: string };
      const receptionId = parseCanonicalUuid(p.receptionId), damageId = parseCanonicalUuid(p.damageId);
      if (!receptionId) throw new MediaError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
      if (type === 'damage') {
        if (!damageId) throw new MediaError(404, 'DAMAGE_NOT_FOUND', 'The damage was not found.');
        return { type, receptionId, damageId };
      }
      return { type, receptionId };
    };
    app.post(url, { bodyLimit: 2048, config: { permission: 'media.upload' },
      onRequest: async (request, reply) => {
        reply.header('cache-control', 'no-store');
        if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
          throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
      },
      schema: { body: { type: 'object', additionalProperties: false, required: ['mediaAssetId'], properties: {
        mediaAssetId: { type: 'string', format: 'uuid' },
        sortOrder: { type: 'integer', minimum: 0, maximum: 2147483647 },
      } } },
    }, async (request, reply) => {
      try {
        const body = request.body as { mediaAssetId: string; sortOrder?: number };
        if (!parseCanonicalUuid(body.mediaAssetId) || (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)))
          throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
        const association = await runMediaAssociationTransaction(request, context =>
          attachMedia(context.sql, context.tenant.tenantId, target(request.params), body));
        return reply.code(201).send({ media: association });
      } catch (error) {
        if (error instanceof MediaError) return sendMediaError(request, reply, error);
        throw error;
      }
    });
    app.get(url, { config: { permission: 'media.read' },
      onRequest: async (_request, reply) => { reply.header('cache-control', 'no-store'); },
    }, async (request, reply) => {
      try {
        if (Object.keys((request.query ?? {}) as object).length)
          throw new MediaError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');
        const context = getTenantRequestContext(request);
        return reply.send({ media: await listAssociatedMedia(context.sql, context.tenant.tenantId, target(request.params)) });
      } catch (error) {
        if (error instanceof MediaError) return sendMediaError(request, reply, error);
        throw error;
      }
    });
  }

  app.post(
    '/api/v1/media/upload-sessions',
    {
      // Security Baseline §10: uploads get a stricter per-route limit than
      // the global default (@fastify/rate-limit route-level override).
      // RBAC: tenant scope. Technician's `media.upload = assigned` stays
      // denied until an order-assignment resource check exists (Sprint 2+).
      config: {
        permission: 'media.upload',
        durableErrorCodes: ['UPLOAD_SESSION_EXPIRED'],
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mediaType', 'mimeType', 'retentionClass', 'idempotencyKey', 'expectedSizeBytes'],
          allOf: [{
            if: { properties: { mediaType: { enum: ['photo', 'video', 'video360'] } }, required: ['mediaType'] },
            then: { required: ['operationalContext'] },
            else: { not: { required: ['operationalContext'] } },
          }],
          properties: {
            mediaType: { type: 'string' },
            mimeType: { type: 'string' },
            retentionClass: { type: 'string' },
            idempotencyKey: { type: 'string', format: 'uuid' },
            expectedSizeBytes: { type: 'integer', minimum: 1 },
            capturedAt: { type: 'string', format: 'date-time' },
            operationalContext: { oneOf: [
              { type: 'object', additionalProperties: false, required: ['type', 'receptionId'],
                properties: { type: { const: 'reception' }, receptionId: { type: 'string', format: 'uuid' } } },
              { type: 'object', additionalProperties: false, required: ['type', 'damageId'],
                properties: { type: { const: 'damage' }, damageId: { type: 'string', format: 'uuid' } } },
            ] },
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
        expectedSizeBytes: number;
        capturedAt?: string;
        operationalContext?: OperationalContext;
      };
      try {
        const result = await createUploadSession(context.sql, r2, context.tenant.tenantId, context.tenant.membershipId, body);
        return reply.code(201).send(result);
      } catch (error) {
        if (error instanceof MediaError) {
          if (error.code === 'UPLOAD_SESSION_EXPIRED' && error.statusCode === 409) {
            markDurableTenantOutcome(request, 'UPLOAD_SESSION_EXPIRED');
          }
          return sendMediaError(request, reply, error);
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/media/upload-sessions/:id/complete',
    {
      config: { permission: 'media.upload', externalInspection: 'media-complete', durableErrorCodes: ['UPLOAD_SESSION_EXPIRED', 'MEDIA_SIZE_INVALID', 'MEDIA_METADATA_MISMATCH', 'MEDIA_CONTENT_INVALID'] },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { checksumSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } },
        },
      },
    },
    async (request, reply) => {
      const context = getTenantRequestContext(request);
      const { id } = request.params as { id: string };
      const { checksumSha256 } = (request.body ?? {}) as { checksumSha256?: string };
      try {
        const plan = await prepareUploadCompletion(context.sql, context.tenant.tenantId, id);
        const resumed = await runMediaInspectionWithoutTransaction(request, () => inspectUploadCompletion(r2, plan));
        const outcome = await completeUploadSession(resumed.context.sql, resumed.context.tenant.tenantId,
          id, plan, resumed.observation, checksumSha256 ?? null);
        if (outcome.kind === 'completed') return reply.send(outcome.result);
        const { error } = outcome;
        // Explicitly returned domain outcomes alone can commit their mutations.
        if (error.code === 'UPLOAD_SESSION_EXPIRED') markDurableTenantOutcome(request, 'UPLOAD_SESSION_EXPIRED');
        else if (error.code === 'MEDIA_SIZE_INVALID' || error.code === 'MEDIA_METADATA_MISMATCH' || error.code === 'MEDIA_CONTENT_INVALID') {
          markDurableTenantOutcome(request, error.code);
        } else throw new Error('MEDIA_COMPLETION_OUTCOME_INVALID');
        return sendMediaError(request, reply, error);
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
