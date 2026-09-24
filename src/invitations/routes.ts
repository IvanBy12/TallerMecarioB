import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import {
  ApiError,
  getIdentityProfileRequestContext,
  getTenantRequestContext,
  identityAwareRateLimitKey,
  markDurableTenantOutcome,
} from '../api/app.js';
import { ROLE_CODES } from '../authz/rbac-matrix.js';
import { canonicalEmailSchema, verifiedProfileSchema } from '../identity/profile.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';
import {
  acceptInvitation,
  createInvitation,
  INVITATION_ERRORS,
  invitationError,
  InvitationRoleNotAllowedError,
  listInvitations,
  revokeInvitation,
  type RequestMeta,
} from './service.js';
import type { InvitationTokenKey } from './token.js';

/**
 * S1-04 HTTP surface (Arquitectura Técnica v1 §13: base /api/v1, stable error
 * code + request_id, DTO allowlists).
 *
 *   tenant routes (TenantContext + RBAC, one reserved transaction)
 *     POST /api/v1/membership-invitations              memberships.invite_staff
 *     GET  /api/v1/membership-invitations              memberships.read
 *     POST /api/v1/membership-invitations/:id/revoke   memberships.manage_staff
 *   identity-only route (verified identity + verified primary email)
 *     POST /api/v1/membership-invitations/accept       token in the body only
 *
 * The role being assigned additionally needs roles.assign_owner /
 * roles.assign_admin / roles.assign_staff (see service.ts).
 */

type RateLimit = { max: number; timeWindow: string | number };

/**
 * Audit request context: server-generated request id + socket-derived IP only.
 * No client-controlled free-form header (User-Agent, Referer, ...) is ever
 * persisted: it can carry any credential, including a live invitation token,
 * and no truncation or pattern-based redaction can prove otherwise
 * (Operación §5.1; audit_logs.user_agent is nullable and stays NULL).
 */
function requestMeta(request: FastifyRequest): RequestMeta {
  return { requestId: request.id, ipAddress: request.ip };
}

async function requireJson(request: FastifyRequest): Promise<void> {
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
}

/** Explicit reply for the one durable 4xx: its `denied` audit row must commit. */
function sendRoleNotAllowed(request: FastifyRequest, reply: FastifyReply) {
  markDurableTenantOutcome(request, 'INVITATION_ROLE_NOT_ALLOWED');
  const { status, message } = INVITATION_ERRORS.INVITATION_ROLE_NOT_ALLOWED;
  return reply.code(status).header('cache-control', 'no-store').send({
    error: { code: 'INVITATION_ROLE_NOT_ALLOWED', message, request_id: request.id },
  });
}

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'role'],
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 320 },
    role: { type: 'string', enum: [...ROLE_CODES] },
  },
} as const;

export interface RegisterInvitationRoutesOptions {
  readonly tokenKey: InvitationTokenKey;
  readonly rateLimit?: RateLimit;
}

export function registerInvitationRoutes(app: FastifyInstance, options: RegisterInvitationRoutesOptions): void {
  const rateLimit = { ...(options.rateLimit ?? { max: 30, timeWindow: '1 minute' }), keyGenerator: identityAwareRateLimitKey };

  app.post('/api/v1/membership-invitations', {
    bodyLimit: 4 * 1024,
    config: {
      permission: 'memberships.invite_staff',
      durableErrorCodes: ['INVITATION_ROLE_NOT_ALLOWED'],
      rateLimit,
    },
    schema: { body: createBodySchema },
    onRequest: requireJson,
  }, async (request, reply) => {
    const body = request.body as { email: string; role: (typeof ROLE_CODES)[number] };
    const normalized = canonicalEmailSchema.safeParse(body.email);
    if (!normalized.success) {
      throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
    }
    const context = getTenantRequestContext(request);
    try {
      const invitation = await createInvitation(context, {
        email: body.email.normalize('NFC').trim(),
        emailNormalized: normalized.data,
        role: body.role,
      }, options.tokenKey, requestMeta(request));
      return reply.code(201).header('cache-control', 'no-store').send({ invitation });
    } catch (error) {
      if (error instanceof InvitationRoleNotAllowedError) return sendRoleNotAllowed(request, reply);
      throw error;
    }
  });

  app.get('/api/v1/membership-invitations', {
    config: { permission: 'memberships.read' },
  }, async (request, reply) => {
    const invitations = await listInvitations(getTenantRequestContext(request));
    return reply.header('cache-control', 'no-store').send({ invitations });
  });

  app.post('/api/v1/membership-invitations/:id/revoke', {
    bodyLimit: 1024,
    config: {
      permission: 'memberships.manage_staff',
      durableErrorCodes: ['INVITATION_ROLE_NOT_ALLOWED'],
      rateLimit,
    },
  }, async (request, reply) => {
    const invitationId = parseCanonicalUuid((request.params as { id?: unknown }).id);
    if (invitationId === undefined) throw invitationError('INVITATION_NOT_FOUND');
    const context = getTenantRequestContext(request);
    try {
      const invitation = await revokeInvitation(context, invitationId, requestMeta(request));
      return reply.header('cache-control', 'no-store').send({ invitation });
    } catch (error) {
      if (error instanceof InvitationRoleNotAllowedError) return sendRoleNotAllowed(request, reply);
      throw error;
    }
  });
}

const acceptBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token'],
  properties: {
    token: { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' },
  },
} as const;

export interface RegisterInvitationAcceptRouteOptions {
  readonly database: postgres.Sql;
  readonly rateLimit?: RateLimit;
}

/** Identity-only: the invitee has no membership (and so no TenantContext) yet. */
export function registerInvitationAcceptRoute(app: FastifyInstance, options: RegisterInvitationAcceptRouteOptions): void {
  app.post('/api/v1/membership-invitations/accept', {
    bodyLimit: 1024,
    config: {
      // Security Baseline §10: strict limit on invitation acceptance.
      rateLimit: { ...(options.rateLimit ?? { max: 10, timeWindow: '1 minute' }), keyGenerator: identityAwareRateLimitKey },
      identityProfile: 'required',
    },
    schema: { body: acceptBodySchema },
    onRequest: requireJson,
  }, async (request, reply) => {
    const { token } = request.body as { token: string };
    const context = getIdentityProfileRequestContext(request);
    // Verified PRIMARY email only (ClerkIdentityProvider: primaryEmailAddressId
    // + verification.status === 'verified'), canonicalized exactly like the
    // invitation's email_normalized.
    const profile = verifiedProfileSchema.safeParse({
      email: context.profile.email,
      emailVerified: context.profile.emailVerified,
      fullName: context.profile.fullName,
    });
    if (!profile.success) {
      throw new ApiError(403, 'IDENTITY_PROFILE_INVALID', 'The verified identity profile is invalid.');
    }

    const result = await acceptInvitation({
      database: options.database,
      identity: context.identity,
      profile: profile.data,
      token,
      meta: requestMeta(request),
    });
    return reply.code(201).header('cache-control', 'no-store').send(result);
  });
}
