import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import {
  ApiError,
  getIdentityProfileRequestContext,
  identityAwareRateLimitKey,
} from '../api/app.js';
import { createWorkshopForIdentity } from './service.js';
import { onboardingRequestSchema, verifiedProfileSchema } from './validation.js';

const textProperty = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });

const onboardingBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['workshop', 'primaryLocation'],
  properties: {
    workshop: {
      type: 'object',
      additionalProperties: false,
      required: ['legalName', 'displayName'],
      properties: {
        legalName: textProperty(200),
        displayName: textProperty(160),
        taxId: textProperty(40),
        phone: textProperty(32),
        email: textProperty(320),
      },
    },
    primaryLocation: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'addressLine', 'city', 'department'],
      properties: {
        name: textProperty(160),
        addressLine: textProperty(300),
        city: textProperty(120),
        department: textProperty(120),
        phone: textProperty(32),
      },
    },
  },
} as const;

export interface RegisterOnboardingRoutesOptions {
  database: postgres.Sql;
  slugFactory?: (displayName: string) => string;
  rateLimit?: { max: number; timeWindow: string | number };
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  options: RegisterOnboardingRoutesOptions,
): void {
  app.post('/api/v1/onboarding/workshops', {
    bodyLimit: 16 * 1024,
    config: {
      // Bucketed by identity (provider + external subject), not just IP:
      // this hook runs after the identity-only `onRequest` auth hook has
      // resolved `identityContext`, so two different callers sharing one
      // IP (NAT, corporate proxy) never share a bucket. Falls back to IP
      // only for the sliver of a request that has no resolved identity yet.
      rateLimit: { ...(options.rateLimit ?? { max: 10, timeWindow: '1 minute' }), keyGenerator: identityAwareRateLimitKey },
      identityProfile: 'required',
    },
    schema: { body: onboardingBodySchema },
    onRequest: async (request) => {
      const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
      }
    },
  }, async (request, reply) => {
    const parsedBody = onboardingRequestSchema.safeParse(request.body);
    if (!parsedBody.success) {
      throw new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
    }

    const identityContext = getIdentityProfileRequestContext(request);
    const parsedProfile = verifiedProfileSchema.safeParse({
      email: identityContext.profile.email,
      emailVerified: identityContext.profile.emailVerified,
      fullName: identityContext.profile.fullName,
    });
    if (!parsedProfile.success) {
      throw new ApiError(403, 'IDENTITY_PROFILE_INVALID', 'The verified identity profile is invalid.');
    }

    const result = await createWorkshopForIdentity({
      database: options.database,
      identity: identityContext.identity,
      profile: parsedProfile.data,
      payload: parsedBody.data,
      requestId: request.id,
      ipAddress: request.ip,
      ...(options.slugFactory ? { slugFactory: options.slugFactory } : {}),
    });

    // LOW-03: the response carries no cache-affecting body-agnostic
    // metadata worth caching, and the caller must always see a fresh view
    // of what was just created (never a stale/shared cache entry).
    return reply.code(201).header('cache-control', 'no-store').send(result);
  });
}
