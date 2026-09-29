import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, getTenantRequestContext } from '../api/app.js';
import { createReception, mapReceptionDbError } from './service.js';
import { createReceptionBodySchema, parseCreateReception, RECEPTION_BODY_LIMIT } from './validation.js';

async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}
async function requireJson(request: FastifyRequest): Promise<void> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
}
export function registerReceptionRoutes(app: FastifyInstance): void {
  app.post('/api/v1/receptions', { bodyLimit: RECEPTION_BODY_LIMIT,
    config: { permission: 'receptions.create' }, schema: { body: createReceptionBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const input = parseCreateReception(request.body);
    let reception;
    try {
      reception = await createReception(getTenantRequestContext(request), input,
        { requestId: request.id, ipAddress: request.ip });
    } catch (error) {
      throw mapReceptionDbError(error) ?? error;
    }
    return reply.code(201).send({ reception });
  });
}
