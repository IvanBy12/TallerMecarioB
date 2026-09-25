import fastify, {
  type FastifyInstance,
  type FastifyReply,
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
import { ApiError, mapDomainError } from './errors.js';
import { checkDatabaseReady } from './health.js';
import { registerMeRoute } from './me.js';
import {
  recordVerifiedIdentity,
  setIdentityOnlyRequestContext,
  setIdentityProfileRequestContext,
} from './request-context.js';
import { registerTenantRequestLifecycle, rollbackTenantRequest } from './tenant-request.js';

export { ApiError } from './errors.js';
export {
  getIdentityOnlyRequestContext,
  getIdentityProfileRequestContext,
  identityAwareRateLimitKey,
  type IdentityOnlyRequestContext,
  type IdentityProfileRequestContext,
} from './request-context.js';
export {
  getTenantRequestContext,
  markDurableTenantOutcome,
  TenantRouteConfigurationError,
  type TenantRequestContext,
} from './tenant-request.js';
export { markResourceAuthorizationSatisfied } from '../authz/resource-authorization.js';
export type { TenantContext } from '../tenancy/tenant-context.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    identityProfile?: 'required';
  }
}

export interface RateLimitOptions {
  max: number;
  timeWindow: string | number;
}

export interface BuildApiOptions {
  database: postgres.Sql;
  identityProvider: IdentityProvider;
  registerPublicRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Identity-authenticated routes without TenantContext (onboarding, /me). */
  registerIdentityOnlyRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /**
   * Tenant routes. Every route MUST declare `config.permission` (and may set
   * `config.permissionScope: 'resource'`); registration fails otherwise.
   */
  registerRoutes?: (app: FastifyInstance) => void | Promise<void>;
  /** Security Baseline §16: explicit allowlist, never `*` with credentials. Empty = no browser cross-origin caller allowed. */
  corsAllowedOrigins?: string[];
  /** Security Baseline §10 global baseline. Routes needing stricter limits (login, OTP, uploads, webhooks) set their own `config.rateLimit` per-route. */
  rateLimit?: RateLimitOptions;
  readinessTimeoutMs?: number;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 300, timeWindow: '1 minute' };
const DEFAULT_READINESS_TIMEOUT_MS = 2000;

const rawRequestBodies = new WeakMap<FastifyRequest, Buffer>();

export function getRawRequestBody(request: FastifyRequest): Buffer {
  const body = rawRequestBodies.get(request);
  if (!body) throw new ApiError(400, 'RAW_BODY_UNAVAILABLE', 'Raw request body is unavailable.');
  return body;
}

function authenticationRequired(): ApiError {
  return new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
}

/**
 * ADR-006 boundary: the provider only proves WHO the caller is. Only
 * `identityProvider` + `externalSubject` are kept (bounded like the users.*
 * columns); any other field a provider returns — claims, metadata, roles —
 * is dropped here and never reaches membership discovery or authorization.
 */
async function authenticate(
  identityProvider: IdentityProvider,
  request: FastifyRequest,
): Promise<VerifiedIdentity> {
  let verified: VerifiedIdentity | null;
  try {
    verified = await identityProvider.verifyRequest(request);
  } catch {
    throw authenticationRequired();
  }

  if (!verified
    || typeof verified.identityProvider !== 'string'
    || verified.identityProvider.length === 0
    || verified.identityProvider.length > 32
    || typeof verified.externalSubject !== 'string'
    || verified.externalSubject.length === 0
    || verified.externalSubject.length > 255) {
    throw authenticationRequired();
  }

  const identity: VerifiedIdentity = Object.freeze({
    identityProvider: verified.identityProvider,
    externalSubject: verified.externalSubject,
  });
  recordVerifiedIdentity(request, identity);
  return identity;
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

const TENANT_ERROR_HEADERS = new Set([
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-expose-headers', 'vary', 'retry-after', 'www-authenticate',
  'cache-control', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'origin-agent-cluster', 'referrer-policy',
  'strict-transport-security', 'x-content-type-options', 'x-dns-prefetch-control',
  'x-download-options', 'x-frame-options', 'x-permitted-cross-domain-policies',
  'x-xss-protection',
]);

/** Fastify's fallback exposes error.message if an error response's onSend fails. */
function sendTenantErrorWithoutOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): void {
  const payload = JSON.stringify({ error: { code, message, request_id: request.id } });
  if (reply.raw.headersSent) {
    reply.raw.destroy();
    return;
  }
  const headers = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([name]) =>
    TENANT_ERROR_HEADERS.has(name.toLowerCase())
    || name.toLowerCase().startsWith('ratelimit-')
    || name.toLowerCase().startsWith('x-ratelimit-')));
  reply.hijack();
  reply.raw.writeHead(statusCode, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  reply.raw.end(payload);
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
    // Backstop: an error response never leaves a tenant transaction open
    // (the tenant context's onError hook normally rolled back already).
    await rollbackTenantRequest(request);

    const mapped = error instanceof ApiError
      ? error
      : mapDomainError(error) ?? mapFrameworkError(error);
    const statusCode = mapped?.statusCode ?? 500;
    const tenantRoute = request.routeOptions.config.permission !== undefined;
    const explicitTripwire = mapped?.code === 'RESOURCE_AUTHORIZATION_CHECK_MISSING';
    const code = tenantRoute && statusCode === 500 && !explicitTripwire
      ? 'INTERNAL_ERROR' : mapped?.code ?? 'INTERNAL_ERROR';
    const message = tenantRoute && statusCode === 500 ? 'The request could not be completed.'
      : mapped?.message ?? 'The request could not be completed.';

    for (const [name, value] of Object.entries(mapped?.headers ?? {})) {
      reply.header(name, value);
    }

    // Error responses on tenant routes must not re-enter route or ancestor
    // onSend hooks. A second onSend failure makes Fastify's fallback serialize
    // the internal exception rather than invoking this mapper again.
    if (tenantRoute) {
      sendTenantErrorWithoutOnSend(request, reply, statusCode, code, message);
      return;
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
  //
  // `errorResponseBuilder` feeds two different call sites: our own manual
  // `createRateLimit()` hooks below (which only read the returned value's
  // shape and reply directly -- never throw it) AND `@fastify/rate-limit`'s
  // own automatic per-route enforcement, wired via `config.rateLimit` on
  // individual routes (e.g. onboarding, media uploads). That second path
  // does `throw params.errorResponseBuilder(...)` internally, so it MUST
  // return a real `Error`; returning a plain object here previously meant
  // that throw reached our `setErrorHandler` as an unrecognized error and
  // was reported as 500 INTERNAL_ERROR instead of 429. An `ApiError`
  // satisfies both call sites: its fields are readable like the old plain
  // object, and `instanceof ApiError` still maps it to 429 when thrown.
  const rateLimitConfig = options.rateLimit ?? DEFAULT_RATE_LIMIT;
  app.register(rateLimit, {
    global: true,
    max: rateLimitConfig.max,
    timeWindow: rateLimitConfig.timeWindow,
    keyGenerator: (request) => request.ip,
    // `Retry-After` is already set on the reply by the plugin itself
    // (`addHeaders[retryAfter]`, before it throws this); `request_id` is
    // added by `setErrorHandler` from `request.id`. Nothing else to attach.
    errorResponseBuilder: () => new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests.'),
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
  // This is the narrow bootstrap surface: onboarding and GET /api/v1/me.
  app.register(async (identityOnlyApp) => {
    // Same pre-auth manual rate-limit reasoning as the tenant context below.
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
      const identity = await authenticate(options.identityProvider, request);
      setIdentityOnlyRequestContext(request, identity);

      // Provider profile is opt-in per route (S1-01 onboarding/invitation);
      // it is never fetched for /me or for tenant routes.
      if (request.routeOptions.config.identityProfile === 'required') {
        let profile: VerifiedIdentityProfile;
        try {
          profile = await options.identityProvider.getIdentityProfile(identity);
        } catch (error) {
          if (error instanceof IdentityProfileNotFoundError
            || (error as { code?: string })?.code === 'IDENTITY_PROFILE_NOT_FOUND') {
            throw authenticationRequired();
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

        setIdentityProfileRequestContext(request, identity, profile);
      }
    });

    // A permission here would be silently ignored (no TenantContext): refuse it.
    identityOnlyApp.addHook('onRoute', (routeOptions) => {
      if (routeOptions.config?.permission !== undefined || routeOptions.config?.permissionScope !== undefined) {
        throw new Error(`IDENTITY_ROUTE_CONFIGURATION_INVALID ${String(routeOptions.method)} ${routeOptions.url}: permission requires a tenant route`);
      }
    });

    registerMeRoute(identityOnlyApp, { database: options.database });
    if (options.registerIdentityOnlyRoutes) await options.registerIdentityOnlyRoutes(identityOnlyApp);
  });

  // Tenant routes live in their own encapsulated context: the tenant
  // transaction hooks below must never run for /health/* or identity-only.
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

    // S1-02: identity → memberships → X-Tenant-Id → one transaction →
    // revalidation → GUCs → RBAC rows → TenantContext → permission guard →
    // handler → resource tripwire → COMMIT/ROLLBACK (see ./tenant-request.ts).
    registerTenantRequestLifecycle(protectedApp, {
      database: options.database,
      authenticate: (request) => authenticate(options.identityProvider, request),
    });

    if (options.registerRoutes) await options.registerRoutes(protectedApp);
  });

  // Single boot pass: this is what actually runs every queued plugin (and
  // wires up rate-limit's per-route `onRoute` hook) in registration order.
  await app.ready();
  return app;
}
