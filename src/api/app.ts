import fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type postgres from 'postgres';
import type {
  IdentityProvider,
  VerifiedIdentity,
  VerifiedIdentityProfile,
} from '../identity/identity-provider.js';
import { IdentityProfileNotFoundError } from '../identity/identity-provider.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { checkDatabaseReady } from './health.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  membershipId: string;
  requestId: string;
}

export interface TenantRequestContext {
  tenant: TenantContext;
  sql: postgres.ReservedSql;
}

export interface IdentityOnlyRequestContext {
  identity: VerifiedIdentity;
}

export interface IdentityProfileRequestContext {
  identity: VerifiedIdentity;
  profile: VerifiedIdentityProfile;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    identityProfile?: 'required';
  }
}

interface ActiveMembershipRow {
  tenant_id: string;
  user_id: string;
  membership_id: string;
}

interface RequestState extends TenantRequestContext {
  transactionOpen: boolean;
}

export interface RateLimitOptions {
  max: number;
  timeWindow: string | number;
}

export interface BuildApiOptions {
  database: postgres.Sql;
  identityProvider: IdentityProvider;
  registerPublicRoutes?: (app: FastifyInstance) => void | Promise<void>;
  registerIdentityOnlyRoutes?: (app: FastifyInstance) => void | Promise<void>;
  registerRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Security Baseline §16: explicit allowlist, never `*` with credentials. Empty = no browser cross-origin caller allowed. */
  corsAllowedOrigins?: string[];
  /** Security Baseline §10 global baseline. Routes needing stricter limits (login, OTP, uploads, webhooks) set their own `config.rateLimit` per-route. */
  rateLimit?: RateLimitOptions;
  readinessTimeoutMs?: number;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 300, timeWindow: '1 minute' };
const DEFAULT_READINESS_TIMEOUT_MS = 2000;

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}

const requestStates = new WeakMap<FastifyRequest, RequestState>();
const identityOnlyStates = new WeakMap<FastifyRequest, IdentityOnlyRequestContext>();
const identityProfileStates = new WeakMap<FastifyRequest, IdentityProfileRequestContext>();
const rawRequestBodies = new WeakMap<FastifyRequest, Buffer>();

export function getRawRequestBody(request: FastifyRequest): Buffer {
  const body = rawRequestBodies.get(request);
  if (!body) throw new ApiError(400, 'RAW_BODY_UNAVAILABLE', 'Raw request body is unavailable.');
  return body;
}

async function finishTransaction(
  request: FastifyRequest,
  action: 'COMMIT' | 'ROLLBACK',
): Promise<void> {
  const state = requestStates.get(request);
  if (!state?.transactionOpen) return;

  state.transactionOpen = false;
  try {
    await state.sql.unsafe(action);
  } finally {
    state.sql.release();
  }
}

export function getTenantRequestContext(request: FastifyRequest): TenantRequestContext {
  const state = requestStates.get(request);
  if (!state?.transactionOpen) {
    throw new ApiError(500, 'TENANT_CONTEXT_UNAVAILABLE', 'Tenant context is unavailable.');
  }
  return state;
}

export function getIdentityOnlyRequestContext(request: FastifyRequest): IdentityOnlyRequestContext {
  const state = identityOnlyStates.get(request);
  if (!state) {
    throw new ApiError(500, 'IDENTITY_CONTEXT_UNAVAILABLE', 'Identity context is unavailable.');
  }
  return state;
}

export function getIdentityProfileRequestContext(request: FastifyRequest): IdentityProfileRequestContext {
  const state = identityProfileStates.get(request);
  if (!state) {
    throw new ApiError(500, 'IDENTITY_PROFILE_CONTEXT_UNAVAILABLE', 'Identity profile context is unavailable.');
  }
  return state;
}

function mapFrameworkError(error: unknown): ApiError | null {
  const candidate = error as { code?: string; statusCode?: number; validation?: unknown };
  if (candidate.code === 'FST_ERR_VALIDATION' || candidate.validation) {
    return new ApiError(400, 'REQUEST_VALIDATION_FAILED', 'The request body is invalid.');
  }
  if (candidate.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || candidate.statusCode === 413) {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }
  if (candidate.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || candidate.statusCode === 415) {
    return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  if (candidate.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
    || (candidate.statusCode === 400 && error instanceof SyntaxError)) {
    return new ApiError(400, 'REQUEST_BODY_MALFORMED', 'The JSON request body is malformed.');
  }
  return null;
}

export async function buildApi(options: BuildApiOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: false,
    genReqId: () => uuidV7(),
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    rawRequestBodies.set(request, rawBody);
    try {
      done(null, JSON.parse(rawBody.toString('utf8')));
    } catch {
      done(new ApiError(400, 'REQUEST_BODY_MALFORMED', 'The JSON request body is malformed.'), undefined);
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const mapped = error instanceof ApiError ? error : mapFrameworkError(error);
    const statusCode = mapped?.statusCode ?? 500;
    const code = mapped?.code ?? 'INTERNAL_ERROR';
    const message = mapped?.message ?? 'The request could not be completed.';

    for (const [name, value] of Object.entries(mapped?.headers ?? {})) {
      reply.header(name, value);
    }

    await reply.code(statusCode).send({
      error: { code, message, request_id: request.id },
    });
  });

  // NOTE: none of the `.register()` calls below are awaited individually.
  // Fastify instances are "thenable" -- awaiting `app.register(...)`
  // (it returns `this`) silently triggers a premature `ready()` boot of
  // everything queued so far, and plugins/routes added afterwards (e.g. the
  // rate-limit plugin's `onRoute` hook wiring) then miss anything declared
  // later. Queue everything in order, boot exactly once via `app.ready()`
  // right before returning.

  // Security Baseline §16: restrictive baseline headers. This is a JSON API,
  // never a browser-rendered surface, hence `default-src 'none'`.
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // Security Baseline §16: explicit allowlist, never `*` with credentials.
  const allowedOrigins = new Set(options.corsAllowedOrigins ?? []);
  app.register(cors, {
    origin(origin, callback) {
      // No Origin header = same-origin/non-browser caller; CORS does not apply to it.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: allowedOrigins.size > 0,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Security Baseline §10 global baseline (by IP; in-memory store -- fine for
  // a single Sprint-0 instance, revisit with a shared store before scaling
  // horizontally). Routes with stricter documented limits (uploads, OTP,
  // login) override via their own route `config.rateLimit`.
  const rateLimitConfig = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  app.register(rateLimit, {
    global: true,
    max: rateLimitConfig.max,
    timeWindow: rateLimitConfig.timeWindow,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request) => ({
      error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.', request_id: request.id },
    }),
  });

  // Arquitectura Técnica v1 §16: liveness/readiness. Unauthenticated,
  // exempt from rate limiting (orchestrators poll these frequently), and
  // outside the tenant-transaction plugin below -- they never open a DB
  // transaction, `/health/ready` only probes connectivity.
  app.get('/health/live', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.code(200).send({ status: 'live' });
  });

  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const ready = await checkDatabaseReady(options.database, options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks: { database: ready } });
  });

  if (options.registerPublicRoutes) await options.registerPublicRoutes(app);

  // Identity-only routes authenticate and rate-limit but deliberately do not
  // resolve a membership, create TenantContext or reserve a DB connection.
  // This is the narrow bootstrap surface used by onboarding.
  const registerIdentityOnlyRoutes = options.registerIdentityOnlyRoutes;
  if (registerIdentityOnlyRoutes) {
    app.register(async (identityOnlyApp) => {
      const checkRateLimitBeforeAuth = identityOnlyApp.createRateLimit();
      identityOnlyApp.addHook('onRequest', async (request, reply) => {
        const limit = await checkRateLimitBeforeAuth(request);
        if (!limit.isAllowed && limit.isExceeded) {
          reply.header('retry-after', limit.ttlInSeconds);
          return reply.code(429).send({
            error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.', request_id: request.id },
          });
        }
      });

      identityOnlyApp.addHook('onRequest', async (request) => {
        let identity: VerifiedIdentity | null;
        try {
          identity = await options.identityProvider.verifyRequest(request);
        } catch {
          throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
        }

        if (!identity
          || !identity.identityProvider
          || identity.identityProvider.length > 32
          || !identity.externalSubject
          || identity.externalSubject.length > 255) {
          throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
        }

        identityOnlyStates.set(request, { identity });

        if (request.routeOptions.config.identityProfile === 'required') {
          let profile: VerifiedIdentityProfile;
          try {
            profile = await options.identityProvider.getIdentityProfile(identity);
          } catch (error) {
            if (error instanceof IdentityProfileNotFoundError
              || (error as { code?: string })?.code === 'IDENTITY_PROFILE_NOT_FOUND') {
              throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
            }
            throw new ApiError(
              503,
              'IDENTITY_PROVIDER_UNAVAILABLE',
              'The identity provider is temporarily unavailable.',
              { 'retry-after': '5' },
            );
          }

          if (profile.emailVerified !== true) {
            throw new ApiError(403, 'IDENTITY_EMAIL_UNVERIFIED', 'A verified email address is required.');
          }

          identityProfileStates.set(request, { identity, profile });
        }
      });

      await registerIdentityOnlyRoutes(identityOnlyApp);
    });
  }

  // Everything else lives in its own encapsulated context: the tenant
  // transaction hooks below must never run for /health/*.
  app.register(async (protectedApp) => {
    // Fastify always runs a context's own instance-level `onRequest` hooks
    // before a route's per-route hook array -- and that per-route array is
    // exactly where @fastify/rate-limit's automatic `global: true` wiring
    // (registered above) attaches itself, per route, to support per-route
    // overrides. So registered as a plugin it would only ever run AFTER our
    // auth hook below, never protecting the auth step itself. This manual
    // check (Security Baseline §10: "límites especialmente estrictos en
    // login") reuses the same store/keyGenerator/max configured above and
    // runs first, as this context's first instance hook, ahead of auth --
    // a well-behaved client never gets close to it; the per-route wiring
    // still applies afterwards for authenticated traffic (e.g. the stricter
    // media upload-sessions override).
    const checkRateLimitBeforeAuth = protectedApp.createRateLimit();
    protectedApp.addHook('onRequest', async (request, reply) => {
      const limit = await checkRateLimitBeforeAuth(request);
      if (!limit.isAllowed && limit.isExceeded) {
        reply.header('retry-after', limit.ttlInSeconds);
        return reply.code(429).send({
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.', request_id: request.id },
        });
      }
    });

    protectedApp.addHook('onRequest', async (request) => {
      let identity;
      try {
        identity = await options.identityProvider.verifyRequest(request);
      } catch {
        throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
      }

      if (!identity) {
        throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
      }

      const memberships = await options.database<ActiveMembershipRow[]>`
        SELECT user_id, membership_id, tenant_id
        FROM app.bootstrap_list_active_memberships(
          ${identity.identityProvider},
          ${identity.externalSubject}
        )
      `;

      if (memberships.length === 0) {
        throw new ApiError(403, 'ACTIVE_MEMBERSHIP_REQUIRED', 'An active membership is required.');
      }
      if (memberships.length !== 1) {
        throw new ApiError(409, 'TENANT_SELECTION_REQUIRED', 'A workshop must be selected.');
      }

      const membership = memberships[0];
      const sql = await options.database.reserve();
      try {
        await sql.unsafe('BEGIN');
        await sql`
          SELECT
            set_config('app.tenant_id', ${membership.tenant_id}, true),
            set_config('app.user_id', ${membership.user_id}, true),
            set_config('app.membership_id', ${membership.membership_id}, true),
            set_config('app.request_id', ${request.id}, true)
        `;
      } catch (error) {
        await sql.unsafe('ROLLBACK').catch(() => undefined);
        sql.release();
        throw error;
      }

      requestStates.set(request, {
        sql,
        transactionOpen: true,
        tenant: {
          tenantId: membership.tenant_id,
          userId: membership.user_id,
          membershipId: membership.membership_id,
          requestId: request.id,
        },
      });
    });

    protectedApp.addHook('onSend', async (request, _reply, payload) => {
      await finishTransaction(request, 'COMMIT');
      return payload;
    });

    protectedApp.addHook('onError', async (request) => {
      await finishTransaction(request, 'ROLLBACK');
    });

    protectedApp.addHook('onResponse', async (request) => {
      await finishTransaction(request, 'ROLLBACK');
    });

    if (options.registerRoutes) await options.registerRoutes(protectedApp);
  });

  // Single boot pass: this is what actually runs every queued plugin (and
  // wires up rate-limit's per-route `onRoute` hook) in registration order.
  await app.ready();
  return app;
}
