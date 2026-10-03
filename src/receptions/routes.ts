import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, getTenantRequestContext } from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { RECEPTION_ACCEPTANCE_VERSION, receptionAcceptanceDocument } from './acceptance-document.js';
import { closeReception, mapCloseDbError } from './close.js';
import { getReception, listReceptions } from './queries.js';
import { parseListReceptionsQuery } from './queries-validation.js';
import { createReception, mapReceptionDbError, updateReception } from './service.js';
import { captureReceptionSignature, mapSignatureDbError, parseSignatureInput,
  SIGNATURE_BODY_LIMIT, signatureBodySchema } from './signature.js';
import { createReceptionBodySchema, parseCreateReception, parsePatchReception,
  patchReceptionBodySchema, RECEPTION_BODY_LIMIT } from './validation.js';

async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}
async function requireJson(request: FastifyRequest): Promise<void> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
}
export function registerReceptionRoutes(app: FastifyInstance): void {
  // The sole published acceptance text; the signature echoes its documentVersion.
  // The hash stays server-owned evidence and is not part of the response.
  app.get('/api/v1/reception-acceptance-document', {
    config: { permission: 'signatures.capture' }, onRequest: noStore,
  }, async (request, reply) => {
    if (Object.keys((request.query ?? {}) as object).length > 0)
      throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request query is invalid.');
    // Fastify does not parse GET payloads; reject their framing as well.
    if (request.body !== undefined || request.headers['transfer-encoding'] !== undefined
      || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))
      throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body must be empty.');
    const document = receptionAcceptanceDocument(RECEPTION_ACCEPTANCE_VERSION);
    if (!document) throw new Error('RECEPTION_ACCEPTANCE_DOCUMENT_MISSING');
    return reply.send({ acceptanceDocument: { documentVersion: document.version, text: document.text } });
  });
  app.get('/api/v1/receptions', {
    config: { permission: 'receptions.read' }, onRequest: noStore,
  }, async (request, reply) => reply.send(await listReceptions(
    getTenantRequestContext(request), parseListReceptionsQuery(request.query))));
  app.get('/api/v1/receptions/:receptionId', {
    config: { permission: 'receptions.read', permissionScope: 'resource' }, onRequest: noStore,
  }, async (request, reply) => {
    const receptionId = parseCanonicalUuid((request.params as { receptionId?: unknown }).receptionId);
    if (!receptionId) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
    return reply.send({ reception: await getReception(getTenantRequestContext(request), receptionId) });
  });
  app.post('/api/v1/receptions/:receptionId/close', {
    config: { permission: 'receptions.close' }, onRequest: [noStore],
  }, async (request, reply) => {
    if (request.body !== undefined)
      throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body must be empty.');
    const receptionId = parseCanonicalUuid((request.params as { receptionId?: unknown }).receptionId);
    if (!receptionId) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
    try {
      return reply.send(await closeReception(getTenantRequestContext(request), receptionId,
        { requestId: request.id, ipAddress: request.ip }));
    } catch (error) {
      throw mapCloseDbError(error) ?? error;
    }
  });
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
  app.patch('/api/v1/receptions/:receptionId', { bodyLimit: RECEPTION_BODY_LIMIT,
    config: { permission: 'receptions.update_open' }, schema: { body: patchReceptionBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const input = parsePatchReception(request.body);
    const receptionId = parseCanonicalUuid((request.params as { receptionId?: unknown }).receptionId);
    if (!receptionId) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
    let reception;
    try {
      reception = await updateReception(getTenantRequestContext(request), receptionId, input,
        { requestId: request.id, ipAddress: request.ip });
    } catch (error) {
      throw mapReceptionDbError(error) ?? error;
    }
    return reply.send({ reception });
  });
  app.post('/api/v1/receptions/:receptionId/signature', { bodyLimit: SIGNATURE_BODY_LIMIT,
    config: { permission: 'signatures.capture' }, schema: { body: signatureBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const receptionId = parseCanonicalUuid((request.params as { receptionId?: unknown }).receptionId);
    if (!receptionId) throw new ApiError(404, 'RECEPTION_NOT_FOUND', 'The reception was not found.');
    const input = parseSignatureInput(request.body);
    let signature;
    try {
      signature = await captureReceptionSignature(getTenantRequestContext(request), receptionId,
        input, { requestId: request.id, ipAddress: request.ip });
    } catch (error) {
      throw mapSignatureDbError(error) ?? error;
    }
    return reply.code(201).send({ signature });
  });
}
