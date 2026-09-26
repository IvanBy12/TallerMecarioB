import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, getTenantRequestContext } from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import {
  createCustomer,
  customerError,
  getCustomer,
  listCustomers,
  type RequestMeta,
  updateCustomer,
} from './service.js';
import {
  CUSTOMER_BODY_LIMIT,
  createCustomerBodySchema,
  parseCreateCustomer,
  parseListCustomersQuery,
  parsePatchCustomer,
  patchCustomerBodySchema,
} from './validation.js';

/**
 * S2-04 HTTP surface (Arquitectura Técnica v1 §13 / §13.4). All tenant routes:
 * TenantContext + RBAC route guard (deny-by-default permission codes, scope
 * tenant) + one reserved transaction, committed only on 2xx.
 *
 *   POST  /api/v1/customers                  customers.create
 *   GET   /api/v1/customers                  customers.read   (?phone, documentNumber, name, limit, cursor)
 *   GET   /api/v1/customers/:customerId      customers.read
 *   PATCH /api/v1/customers/:customerId      customers.update
 *
 * No DELETE/archive (D-02), no Idempotency-Key (D-22), no durable 4xx (no CRM
 * denied audit). Nothing here logs the URL, query or body: CRM query strings
 * and bodies carry PII (Operación §6.3).
 */

/** Audit request context: server-generated request id + socket-derived IP only. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return { requestId: request.id, ipAddress: request.ip };
}

/** Malformed, nonexistent and foreign ids share one 404 (anti-oracle). */
function customerIdParam(request: FastifyRequest): string {
  const id = parseCanonicalUuid((request.params as { customerId?: unknown }).customerId);
  if (id === undefined) throw customerError('CUSTOMER_NOT_FOUND');
  return id;
}

/** Runs after the tenant guard: every response the route produces (2xx and 4xx) is no-store. */
async function noStore(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('cache-control', 'no-store');
}

async function requireJson(request: FastifyRequest): Promise<void> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
}

export function registerCustomerRoutes(app: FastifyInstance): void {
  app.post('/api/v1/customers', {
    bodyLimit: CUSTOMER_BODY_LIMIT,
    config: { permission: 'customers.create' },
    schema: { body: createCustomerBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    const input = parseCreateCustomer(request.body);
    const customer = await createCustomer(getTenantRequestContext(request), input, requestMeta(request));
    return reply.code(201).send({ customer });
  });

  app.get('/api/v1/customers', {
    config: { permission: 'customers.read' },
    onRequest: noStore,
  }, async (request, reply) => {
    const query = parseListCustomersQuery(request.query);
    const page = await listCustomers(getTenantRequestContext(request), query);
    return reply.send(page);
  });

  app.get('/api/v1/customers/:customerId', {
    config: { permission: 'customers.read' },
    onRequest: noStore,
  }, async (request, reply) => {
    const customer = await getCustomer(getTenantRequestContext(request), customerIdParam(request));
    return reply.send({ customer });
  });

  app.patch('/api/v1/customers/:customerId', {
    bodyLimit: CUSTOMER_BODY_LIMIT,
    config: { permission: 'customers.update' },
    schema: { body: patchCustomerBodySchema },
    onRequest: [noStore, requireJson],
  }, async (request, reply) => {
    // Body first: an invalid body is 400 whatever the id, so the 404 stays identical
    // for malformed, nonexistent and foreign ids.
    const input = parsePatchCustomer(request.body);
    const customer = await updateCustomer(getTenantRequestContext(request), customerIdParam(request), input, requestMeta(request));
    return reply.send({ customer });
  });
}
