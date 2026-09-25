import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiError,
  getTenantRequestContext,
  identityAwareRateLimitKey,
  markDurableTenantOutcome,
} from '../api/app.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import {
  changeMembershipStatus,
  getMembership,
  listMemberships,
  MEMBER_LIFECYCLE_ERRORS,
  memberLifecycleError,
  MembershipActionDeniedError,
  type MembershipCommand,
  type RequestMeta,
} from './lifecycle-service.js';

/**
 * S1-06 HTTP surface (Arquitectura Técnica v1 §13: base /api/v1, stable error
 * code + request_id, strict DTO allowlists; Estados y Transiciones §1: one
 * explicit command per transition, never a generic status write). All tenant
 * routes: TenantContext + RBAC + one reserved transaction.
 *
 *   GET  /api/v1/memberships                           memberships.read
 *   GET  /api/v1/memberships/:membershipId             memberships.read
 *   POST /api/v1/memberships/:membershipId/suspend     memberships.manage_staff (+ target authority)
 *   POST /api/v1/memberships/:membershipId/revoke      memberships.manage_staff (+ target authority)
 *
 * No reactivation route (DECISION_REQUIRED). Commands take no input besides
 * the path id: the body must be absent or exactly `{}`; tenant, actor, status,
 * roles, permissions or provider claims are never read from the request.
 */

type RateLimit = { max: number; timeWindow: string | number };

const DURABLE_CODES = ['DOMAIN_ACTION_FORBIDDEN'] as const;

/** Audit request context: server-generated request id + socket-derived IP only. */
function requestMeta(request: FastifyRequest): RequestMeta {
  return { requestId: request.id, ipAddress: request.ip };
}

function membershipIdParam(request: FastifyRequest): string {
  const id = parseCanonicalUuid((request.params as { membershipId?: unknown }).membershipId);
  if (id === undefined) throw memberLifecycleError('MEMBERSHIP_NOT_FOUND');
  return id;
}

/**
 * A command body is optional; when present it must be the empty JSON object
 * `{}` sent as application/json (Fastify also parses text/plain natively).
 */
async function requireEmptyCommandBody(request: FastifyRequest): Promise<void> {
  const body = request.body;
  if (body === undefined) return;
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0) return;
  throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
}

/** Explicit reply for the durable 4xx: its `denied` audit row must commit. */
function sendDenied(request: FastifyRequest, reply: FastifyReply, error: MembershipActionDeniedError) {
  markDurableTenantOutcome(request, error.code);
  const { status, message } = MEMBER_LIFECYCLE_ERRORS[error.code];
  return reply.code(status).header('cache-control', 'no-store').send({
    error: { code: error.code, message, request_id: request.id },
  });
}

export interface RegisterMemberLifecycleRoutesOptions {
  readonly rateLimit?: RateLimit;
}

export function registerMemberLifecycleRoutes(app: FastifyInstance, options: RegisterMemberLifecycleRoutesOptions = {}): void {
  const rateLimit = { ...(options.rateLimit ?? { max: 30, timeWindow: '1 minute' }), keyGenerator: identityAwareRateLimitKey };

  app.get('/api/v1/memberships', {
    config: { permission: 'memberships.read' },
  }, async (request, reply) => {
    const memberships = await listMemberships(getTenantRequestContext(request));
    return reply.header('cache-control', 'no-store').send({ memberships });
  });

  app.get('/api/v1/memberships/:membershipId', {
    config: { permission: 'memberships.read' },
  }, async (request, reply) => {
    const membership = await getMembership(getTenantRequestContext(request), membershipIdParam(request));
    return reply.header('cache-control', 'no-store').send({ membership });
  });

  for (const command of ['suspend', 'revoke'] as const satisfies readonly MembershipCommand[]) {
    app.post(`/api/v1/memberships/:membershipId/${command}`, {
      bodyLimit: 1024,
      config: { permission: 'memberships.manage_staff', durableErrorCodes: DURABLE_CODES, rateLimit },
      preValidation: requireEmptyCommandBody,
    }, async (request, reply) => {
      const membershipId = membershipIdParam(request);
      try {
        const membership = await changeMembershipStatus(getTenantRequestContext(request), command, membershipId, requestMeta(request));
        return reply.header('cache-control', 'no-store').send({ membership });
      } catch (error) {
        if (error instanceof MembershipActionDeniedError) return sendDenied(request, reply, error);
        throw error;
      }
    });
  }
}
