import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiError,
  getTenantRequestContext,
  identityAwareRateLimitKey,
  markDurableTenantOutcome,
} from '../api/app.js';
import { ROLE_CODES, type RoleCode } from '../authz/rbac-matrix.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import {
  assignMemberRole,
  listMemberRoles,
  MEMBER_ROLE_ERRORS,
  memberRoleError,
  removeMemberRole,
  RoleChangeDeniedError,
  type RequestMeta,
} from './roles-service.js';

/**
 * S1-05 HTTP surface (Arquitectura Técnica v1 §13: base /api/v1, stable error
 * code + request_id, strict DTO allowlists). All tenant routes: TenantContext
 * + RBAC + one reserved transaction.
 *
 *   GET    /api/v1/memberships/:membershipId/roles              memberships.read
 *   POST   /api/v1/memberships/:membershipId/roles              memberships.manage_staff
 *          body { "role_code": "<role>" }                       + roles.assign_* (service)
 *   DELETE /api/v1/memberships/:membershipId/roles/:roleCode    memberships.manage_staff
 *                                                               + roles.assign_* (service)
 *
 * The body accepts ONLY role_code: tenant, actor/assigned_by, permissions or
 * provider claims are never read from the request (additionalProperties:false).
 */

type RateLimit = { max: number; timeWindow: string | number };

const DURABLE_CODES = ['ROLE_ASSIGNMENT_NOT_ALLOWED', 'SELF_ROLE_MODIFICATION_FORBIDDEN'] as const;

/** Audit request context: server-generated request id + socket-derived IP only. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return { requestId: request.id, ipAddress: request.ip };
}

async function requireJson(request: FastifyRequest): Promise<void> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
}

function membershipIdParam(request: FastifyRequest): string {
  const id = parseCanonicalUuid((request.params as { membershipId?: unknown }).membershipId);
  if (id === undefined) throw memberRoleError('MEMBERSHIP_NOT_FOUND');
  return id;
}

/** Explicit reply for the durable 4xx: its `denied` audit row must commit. */
function sendDenied(request: FastifyRequest, reply: FastifyReply, error: RoleChangeDeniedError) {
  markDurableTenantOutcome(request, error.code);
  const { status, message } = MEMBER_ROLE_ERRORS[error.code];
  return reply.code(status).header('cache-control', 'no-store').send({
    error: { code: error.code, message, request_id: request.id },
  });
}

const assignBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role_code'],
  properties: {
    role_code: { type: 'string', enum: [...ROLE_CODES] },
  },
} as const;

const roleParamsSchema = {
  type: 'object',
  required: ['membershipId', 'roleCode'],
  properties: {
    membershipId: { type: 'string' },
    roleCode: { type: 'string', enum: [...ROLE_CODES] },
  },
} as const;

export interface RegisterMemberRoleRoutesOptions {
  readonly rateLimit?: RateLimit;
}

export function registerMemberRoleRoutes(app: FastifyInstance, options: RegisterMemberRoleRoutesOptions = {}): void {
  const rateLimit = { ...(options.rateLimit ?? { max: 30, timeWindow: '1 minute' }), keyGenerator: identityAwareRateLimitKey };

  app.get('/api/v1/memberships/:membershipId/roles', {
    config: { permission: 'memberships.read' },
  }, async (request, reply) => {
    const membership = await listMemberRoles(getTenantRequestContext(request), membershipIdParam(request));
    return reply.header('cache-control', 'no-store').send({ membership });
  });

  app.post('/api/v1/memberships/:membershipId/roles', {
    bodyLimit: 1024,
    config: { permission: 'memberships.manage_staff', durableErrorCodes: DURABLE_CODES, rateLimit },
    schema: { body: assignBodySchema },
    onRequest: requireJson,
  }, async (request, reply) => {
    const { role_code: role } = request.body as { role_code: RoleCode };
    const membershipId = membershipIdParam(request);
    try {
      const membership = await assignMemberRole(getTenantRequestContext(request), membershipId, role, requestMeta(request));
      return reply.code(201).header('cache-control', 'no-store').send({ membership });
    } catch (error) {
      if (error instanceof RoleChangeDeniedError) return sendDenied(request, reply, error);
      throw error;
    }
  });

  app.delete('/api/v1/memberships/:membershipId/roles/:roleCode', {
    bodyLimit: 1024,
    config: { permission: 'memberships.manage_staff', durableErrorCodes: DURABLE_CODES, rateLimit },
    schema: { params: roleParamsSchema },
  }, async (request, reply) => {
    const { roleCode } = request.params as { roleCode: RoleCode };
    const membershipId = membershipIdParam(request);
    try {
      const membership = await removeMemberRole(getTenantRequestContext(request), membershipId, roleCode, requestMeta(request));
      return reply.header('cache-control', 'no-store').send({ membership });
    } catch (error) {
      if (error instanceof RoleChangeDeniedError) return sendDenied(request, reply, error);
      throw error;
    }
  });
}
