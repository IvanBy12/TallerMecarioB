import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, getTenantRequestContext } from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import { createVehicle, getVehicle, listOwnerHistory, listVehicles, mapVehicleDbError, transferOwner, updateVehicle,
  type RequestMeta } from './service.js';
import { createVehicleBodySchema, parseCreateVehicle, parseListVehiclesQuery,
  parsePatchVehicle, parseTransferOwner, patchVehicleBodySchema, transferOwnerBodySchema } from './validation.js';

const meta = (request: FastifyRequest): RequestMeta => ({ requestId: request.id, ipAddress: request.ip });
const vehicleIdParam = (request: FastifyRequest): string => {
  const id = parseCanonicalUuid((request.params as { vehicleId?: unknown }).vehicleId);
  if (!id) throw new ApiError(404, 'VEHICLE_NOT_FOUND', 'The vehicle was not found.');
  return id;
};
async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}
async function requireJson(request: FastifyRequest): Promise<void> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
}
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw mapVehicleDbError(error) ?? error; }
}
export function registerVehicleRoutes(app: FastifyInstance): void {
  app.post('/api/v1/vehicles', { config: { permission: 'vehicles.create' },
    schema: { body: createVehicleBodySchema }, onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const input = parseCreateVehicle(request.body);
    const result = await mapped(() => createVehicle(getTenantRequestContext(request), input, meta(request)));
    return reply.code(201).send(result);
  });
  app.get('/api/v1/vehicles', { config: { permission: 'vehicles.read' }, onRequest: noStore,
  }, async (request, reply) => {
    const query = parseListVehiclesQuery(request.query);
    return reply.send(await listVehicles(getTenantRequestContext(request), query));
  });
  app.get('/api/v1/vehicles/:vehicleId', {
    config: { permission: 'vehicles.read', permissionScope: 'resource' }, onRequest: noStore,
  }, async (request, reply) => reply.send({ vehicle: await getVehicle(getTenantRequestContext(request), vehicleIdParam(request)) }));
  app.patch('/api/v1/vehicles/:vehicleId', { config: { permission: 'vehicles.update' },
    schema: { body: patchVehicleBodySchema }, onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const input = parsePatchVehicle(request.body);
    const vehicle = await mapped(() => updateVehicle(getTenantRequestContext(request), vehicleIdParam(request), input, meta(request)));
    return reply.send({ vehicle });
  });
  app.get('/api/v1/vehicles/:vehicleId/owners', {
    config: { permission: 'customers.read' }, onRequest: noStore,
  }, async (request, reply) => reply.send({
    owners: await listOwnerHistory(getTenantRequestContext(request), vehicleIdParam(request)),
  }));
  app.post('/api/v1/vehicles/:vehicleId/owners', {
    config: { permission: 'vehicle_owners.manage' },
    schema: { body: transferOwnerBodySchema }, onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const vehicleId = vehicleIdParam(request);
    const input = parseTransferOwner(request.body);
    const result = await mapped(() => transferOwner(getTenantRequestContext(request), vehicleId, input, meta(request)));
    return reply.code(result.changed ? 201 : 200).send({ ownership: result.ownership });
  });
}
