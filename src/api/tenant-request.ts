/**
 * S1-02 tenant request lifecycle (Fastify integration of the TenantContext
 * core, src/tenancy/*, and the RBAC core, src/authz/*).
 *
 * Every tenant-scoped request runs, in this order (ADR-009 §3/§7, RBAC §1/§18):
 *
 *   verified identity                    (caller: IdentityProvider.verifyRequest)
 *   → discoverActiveMemberships          pool, pre-transaction: candidates only
 *   → parseTenantSelection(X-Tenant-Id)  raw Fastify header value, no trimming
 *   → selectTenantCandidate              0/1/N rules; explicit never falls back
 *   → reserve ONE connection → BEGIN
 *   → validateActiveMembership           same tx: exact user/membership/tenant
 *   → bindTenantContext                  transaction-local app.* GUCs
 *   → loadMembershipAuthorization        same tx, under RLS
 *   → createTenantContext                buildPermissionGrantMap inside
 *   → route permission guard             authorizePermissionRequirement
 *   → handler                            queries through the SAME reserved sql
 *   → resource tripwire                  assertResourceAuthorizationComplete
 *   → COMMIT  (any error: ROLLBACK) → release
 *
 * Nothing here reads roles, permissions or tenants from the identity provider
 * or from the request body/params/query; the provider profile is never
 * fetched for tenant routes.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
} from 'fastify';
import type postgres from 'postgres';
import {
  authorizePermissionRequirement,
  definePermissionRequirement,
  PermissionDeniedError,
  type PermissionRequirement,
  type PermissionScopeRequirement,
} from '../authz/authorize.js';
import type { PermissionCode } from '../authz/rbac-matrix.js';
import {
  assertResourceAuthorizationComplete,
  createResourceAuthorizationState,
  type ResourceAuthorizationState,
} from '../authz/resource-authorization.js';
import type { VerifiedIdentity } from '../identity/identity-provider.js';
import { createTenantContext, type TenantContext } from '../tenancy/tenant-context.js';
import {
  bindTenantContext,
  discoverActiveMemberships,
  loadMembershipAuthorization,
  validateActiveMembership,
} from '../tenancy/tenant-context-db.js';
import {
  parseTenantSelection,
  selectTenantCandidate,
  TenantAccessDeniedError,
  TenantCandidateInvalidError,
} from '../tenancy/tenant-selection.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every tenant route; only codes from RBAC_MATRIX_V1 type-check. */
    permission?: PermissionCode;
    /**
     * 'tenant' (default): only a tenant-wide grant passes.
     * 'resource': a restricted grant (assigned / quality_control) also passes,
     * but the handler must then check the concrete resource and call
     * `markResourceAuthorizationSatisfied` before a non-error response.
     */
    permissionScope?: PermissionScopeRequirement;
    /** Server-declared durable 4xx outcomes; each also requires an explicit mark. */
    durableErrorCodes?: readonly DurableTenantOutcomeCode[];
  }
}

const DURABLE_OUTCOME_STATUS = Object.freeze({
  UPLOAD_SESSION_EXPIRED: 409,
  MEDIA_SIZE_INVALID: 422,
  // S1-04: a denied privilege-escalation attempt commits its `denied` audit row.
  INVITATION_ROLE_NOT_ALLOWED: 403,
  // S1-05: denied role-escalation / self-modification attempts commit their `denied` audit row.
  ROLE_ASSIGNMENT_NOT_ALLOWED: 403,
  SELF_ROLE_MODIFICATION_FORBIDDEN: 403,
  // S1-06: denied self-management / insufficient-authority membership commands
  // commit their `denied` audit row (Estados y Transiciones v1 §9).
  DOMAIN_ACTION_FORBIDDEN: 403,
} as const);

export type DurableTenantOutcomeCode = keyof typeof DURABLE_OUTCOME_STATUS;

export interface TenantRequestContext {
  /** Built only by `createTenantContext` from rows revalidated inside `sql`'s transaction. */
  readonly tenant: TenantContext;
  /**
   * The request's single reserved connection, inside its open transaction with
   * the app.* GUCs bound. Every tenant-owned query of the handler and of the
   * services it calls MUST go through this client (never the pool): RLS only
   * sees this transaction's context.
   */
  readonly sql: postgres.ReservedSql;
  /** The route's validated permission requirement. */
  readonly permission: PermissionRequirement;
  /**
   * Opaque tripwire handle. `not_required` for a tenant-wide grant;
   * `required_pending` for a restricted grant on a 'resource' route until the
   * handler verifies the concrete resource and calls
   * `markResourceAuthorizationSatisfied(handle, via)`.
   */
  readonly resourceAuthorization: ResourceAuthorizationState;
}

interface TenantRequestState {
  readonly context: TenantRequestContext;
  status: 'open' | 'closing' | 'closed';
  durableOutcome?: { readonly code: DurableTenantOutcomeCode; readonly statusCode: number };
  /** Set at preValidation: from then on route code may be using `sql`. */
  routeStarted: boolean;
}

const tenantRequestStates = new WeakMap<FastifyRequest, TenantRequestState>();

export function getTenantRequestContext(request: FastifyRequest): TenantRequestContext {
  const state = tenantRequestStates.get(request);
  if (state?.status !== 'open') {
    throw new ApiError(500, 'TENANT_CONTEXT_UNAVAILABLE', 'Tenant context is unavailable.');
  }
  return state.context;
}

/* -------------------------------------------------------------------------- */
/* Route contract                                                             */
/* -------------------------------------------------------------------------- */

/** A tenant route was registered without a valid permission contract. Fails the boot. */
export class TenantRouteConfigurationError extends Error {
  constructor(routeOptions: Pick<RouteOptions, 'method' | 'url'>, reason: string) {
    const method = Array.isArray(routeOptions.method) ? routeOptions.method.join(',') : routeOptions.method;
    super(`TENANT_ROUTE_CONFIGURATION_INVALID ${method} ${routeOptions.url}: ${reason}`);
    this.name = 'TenantRouteConfigurationError';
  }
}

function routeRequirement(config: RouteOptions['config'] | undefined): PermissionRequirement {
  return definePermissionRequirement(config?.permission, config?.permissionScope ?? 'tenant');
}

/**
 * Registration-time check (deny-by-default): a tenant route must declare a
 * known permission and a valid scope, and must not ask for the provider
 * profile. The requirement is re-validated per request as well.
 */
function assertTenantRouteConfig(routeOptions: RouteOptions): void {
  if (routeOptions.config?.identityProfile !== undefined) {
    throw new TenantRouteConfigurationError(routeOptions, 'identityProfile is not allowed on tenant routes');
  }
  try {
    routeRequirement(routeOptions.config);
  } catch {
    throw new TenantRouteConfigurationError(
      routeOptions,
      'config.permission must be a known permission code and config.permissionScope tenant|resource',
    );
  }
  const codes = routeOptions.config?.durableErrorCodes;
  if (codes !== undefined && (!Array.isArray(codes) || codes.length === 0
    || new Set(codes).size !== codes.length
    || codes.some((code) => !Object.hasOwn(DURABLE_OUTCOME_STATUS, code)))) {
    throw new TenantRouteConfigurationError(routeOptions, 'config.durableErrorCodes contains an unknown or duplicate outcome');
  }
}

/** Called only by a handler that emitted one of its declared durable outcomes. */
export function markDurableTenantOutcome(request: FastifyRequest, code: DurableTenantOutcomeCode): void {
  const state = tenantRequestStates.get(request);
  if (state?.status !== 'open'
    || !Object.hasOwn(DURABLE_OUTCOME_STATUS, code)
    || !request.routeOptions.config.durableErrorCodes?.includes(code)
    || state.durableOutcome !== undefined) {
    throw new Error('TENANT_DURABLE_OUTCOME_INVALID');
  }
  state.durableOutcome = Object.freeze({ code, statusCode: DURABLE_OUTCOME_STATUS[code] });
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Tenant permission guard. 'tenant' scope: only a tenant-wide grant passes; a
 * restricted grant is denied exactly like no grant. 'resource' scope: a
 * restricted grant opens a `required_pending` tripwire.
 */
function authorizeRoute(tenant: TenantContext, requirement: PermissionRequirement): ResourceAuthorizationState {
  const decision = authorizePermissionRequirement(tenant, requirement);
  switch (decision.kind) {
    case 'allowed':
      return createResourceAuthorizationState(decision.permission, { kind: 'tenant' });
    case 'resource_check_required':
      return createResourceAuthorizationState(decision.permission, { kind: 'resource', scopes: decision.scopes });
    case 'denied':
      throw new PermissionDeniedError(decision.permission);
  }
}

async function openTenantRequest(
  database: postgres.Sql,
  request: FastifyRequest,
  identity: VerifiedIdentity,
  requirement: PermissionRequirement,
): Promise<TenantRequestState> {
  const candidates = await discoverActiveMemberships(database, identity);
  // Raw Fastify value (string | string[] | undefined): the parser is the only
  // format authority — no trim/split/lowercase here.
  const selection = parseTenantSelection(request.headers['x-tenant-id']);
  const selected = selectTenantCandidate(candidates, selection);
  const candidate = candidates.find((row) =>
    row.tenantId === selected.tenantId && row.membershipId === selected.membershipId);
  if (candidate === undefined) throw new TenantCandidateInvalidError();

  // Discovery is not proof. From here on, ONE connection and ONE transaction.
  const sql = await database.reserve();
  try {
    await sql.unsafe('BEGIN');
    const validation = await validateActiveMembership(sql, identity, candidate);
    if (!validation.ok) throw new TenantAccessDeniedError();
    const bound = await bindTenantContext(sql, validation.membership, { requestId: request.id });
    const authorization = await loadMembershipAuthorization(sql, bound);
    if (!authorization.ok) throw new TenantAccessDeniedError();

    // Roles are informative; authorization reads only `permissions`.
    const tenant = createTenantContext({
      tenantId: bound.tenantId,
      userId: bound.userId,
      membershipId: bound.membershipId,
      roleCodes: authorization.roles,
      permissionRows: authorization.grants,
      requestId: bound.requestId,
    });
    const resourceAuthorization = authorizeRoute(tenant, requirement);

    return {
      status: 'open',
      routeStarted: false,
      context: Object.freeze({ tenant, sql, permission: requirement, resourceAuthorization }),
    };
  } catch (error) {
    await sql.unsafe('ROLLBACK').catch(() => undefined);
    sql.release();
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                 */
/* -------------------------------------------------------------------------- */

/** Ends the transaction exactly once and always releases the connection. */
async function endTransaction(state: TenantRequestState, action: 'COMMIT' | 'ROLLBACK'): Promise<void> {
  if (state.status !== 'open') return;
  state.status = 'closing';
  try {
    await state.context.sql.unsafe(action);
  } finally {
    state.status = 'closed';
    state.context.sql.release();
  }
}

/**
 * ROLLBACK + release if the request still owns an open transaction. Safe to
 * call from any error/teardown path; never throws.
 */
export async function rollbackTenantRequest(request: FastifyRequest): Promise<void> {
  const state = tenantRequestStates.get(request);
  if (state) await endTransaction(state, 'ROLLBACK').catch(() => undefined);
}

/**
 * Last route-level onSend hook: runs after serialization and after every other
 * onSend hook, so a serialization or onSend failure is still rolled back.
 *
 *  - 2xx: the tripwire must be complete, then COMMIT;
 *  - 4xx: ROLLBACK unless the handler explicitly marked a route-declared,
 *    status-matched durable outcome and the resource check is complete;
 *  - every other status: ROLLBACK.
 *
 * A failed COMMIT throws (connection already released) and becomes a 500.
 */
async function finalizeTenantTransaction(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const state = tenantRequestStates.get(request);
  if (state === undefined || state.status !== 'open') return payload;

  const { resourceAuthorization } = state.context;
  if (reply.statusCode >= 200 && reply.statusCode < 300) {
    assertResourceAuthorizationComplete(resourceAuthorization);
    await endTransaction(state, 'COMMIT');
  } else if (reply.statusCode >= 400 && reply.statusCode < 500
    && state.durableOutcome?.statusCode === reply.statusCode) {
    assertResourceAuthorizationComplete(resourceAuthorization);
    await endTransaction(state, 'COMMIT');
  } else {
    await endTransaction(state, 'ROLLBACK');
  }
  return payload;
}

export interface TenantRequestLifecycleOptions {
  readonly database: postgres.Sql;
  /** Verifies the request and returns the identity, or throws the 401 ApiError. */
  readonly authenticate: (request: FastifyRequest) => Promise<VerifiedIdentity>;
}

/**
 * Installs the lifecycle on an encapsulated Fastify context. Must be called
 * before that context registers its routes (the onRoute check applies only
 * to routes added afterwards).
 */
export function registerTenantRequestLifecycle(
  app: FastifyInstance,
  options: TenantRequestLifecycleOptions,
): void {
  app.addHook('onRoute', (routeOptions) => {
    assertTenantRouteConfig(routeOptions);
    const existing = routeOptions.onSend;
    const routeHooks = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    routeOptions.onSend = [...routeHooks, finalizeTenantTransaction];
  });

  app.addHook('onRequest', async (request) => {
    const identity = await options.authenticate(request);
    const requirement = routeRequirement(request.routeOptions.config);
    const state = await openTenantRequest(options.database, request, identity, requirement);
    tenantRequestStates.set(request, state);
  });

  app.addHook('preValidation', async (request) => {
    const state = tenantRequestStates.get(request);
    if (state) state.routeStarted = true;
  });

  // onError runs before the error handler: handler/hook/serialization/onSend
  // failures roll back here. onResponse is the fallback for any other path
  // that ends the response without passing through the final onSend hook.
  app.addHook('onError', async (request) => {
    await rollbackTenantRequest(request);
  });
  app.addHook('onResponse', async (request) => {
    await rollbackTenantRequest(request);
  });

  // Client gone while the body was still uploading: no route code can be
  // using the connection yet, so release it now. Once the route pipeline has
  // started, the in-flight handler still owns `sql`; its reply (or error)
  // finalizes through onSend/onError — a concurrent ROLLBACK here would let
  // its remaining statements run outside the transaction.
  app.addHook('onRequestAbort', async (request) => {
    const state = tenantRequestStates.get(request);
    if (state !== undefined && !state.routeStarted) await rollbackTenantRequest(request);
  });
}
