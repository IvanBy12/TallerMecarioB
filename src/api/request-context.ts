import type { FastifyRequest } from 'fastify';
import type { VerifiedIdentity, VerifiedIdentityProfile } from '../identity/identity-provider.js';
import { ApiError } from './errors.js';

/**
 * Typed request scopes. Each Fastify context populates exactly one of them,
 * and a getter throws (500) instead of returning an optional value, so a
 * route never has to handle "maybe no context":
 *
 *   identity-only     verified identity; no profile, no tenant, no DB tx
 *   identity-profile  identity + provider profile (routes with
 *                     `config.identityProfile: 'required'` only)
 *   tenant            see ./tenant-request.ts (TenantContext + reserved tx)
 */

export interface IdentityOnlyRequestContext {
  readonly identity: VerifiedIdentity;
}

export interface IdentityProfileRequestContext {
  readonly identity: VerifiedIdentity;
  readonly profile: VerifiedIdentityProfile;
}

/** Every verified identity, whatever the context (rate-limit bucketing only). */
const verifiedIdentities = new WeakMap<FastifyRequest, VerifiedIdentity>();
const identityOnlyStates = new WeakMap<FastifyRequest, IdentityOnlyRequestContext>();
const identityProfileStates = new WeakMap<FastifyRequest, IdentityProfileRequestContext>();

export function recordVerifiedIdentity(request: FastifyRequest, identity: VerifiedIdentity): void {
  verifiedIdentities.set(request, identity);
}

export function setIdentityOnlyRequestContext(request: FastifyRequest, identity: VerifiedIdentity): void {
  identityOnlyStates.set(request, Object.freeze({ identity }));
}

export function setIdentityProfileRequestContext(
  request: FastifyRequest,
  identity: VerifiedIdentity,
  profile: VerifiedIdentityProfile,
): void {
  identityProfileStates.set(request, Object.freeze({ identity, profile }));
}

/**
 * Rate-limit bucket key for a per-route limiter. Once an auth hook has
 * resolved a verified identity for this request (they run as instance-level
 * `onRequest` hooks, ahead of any per-route hook such as
 * `@fastify/rate-limit`'s automatic `config.rateLimit` wiring), two different
 * identities behind the same IP get independent buckets instead of sharing
 * one. Before identity is available, IP is the only signal there is, so it
 * stays the fallback.
 */
export function identityAwareRateLimitKey(request: FastifyRequest): string {
  const identity = verifiedIdentities.get(request);
  if (identity) return `identity:${identity.identityProvider}:${identity.externalSubject}`;
  return `ip:${request.ip}`;
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
