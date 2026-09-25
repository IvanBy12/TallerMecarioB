import type { FastifyRequest } from 'fastify';

export interface VerifiedIdentity {
  identityProvider: string;
  externalSubject: string;
}

export interface VerifiedIdentityProfile {
  email: string;
  emailVerified: boolean;
  fullName: string | null;
}

/** Provider contract signal: the already-authenticated subject no longer exists. */
export class IdentityProfileNotFoundError extends Error {
  readonly code = 'IDENTITY_PROFILE_NOT_FOUND';

  constructor() {
    super('IDENTITY_PROFILE_NOT_FOUND');
  }
}

/**
 * The provider could not answer right now (timeout, network error, 429, 5xx
 * or a provider-side auth/config failure). Always retryable; never a statement
 * about the identity itself.
 */
export class IdentityProviderUnavailableError extends Error {
  readonly code = 'IDENTITY_PROVIDER_UNAVAILABLE';
  readonly retryable = true as const;

  constructor(readonly reason: string) {
    super('IDENTITY_PROVIDER_UNAVAILABLE');
    this.name = 'IdentityProviderUnavailableError';
  }
}

/** The provider rejected the lookup in a way retries cannot fix (e.g. 400/422). */
export class IdentityProviderRequestError extends Error {
  readonly code = 'IDENTITY_PROVIDER_REQUEST_REJECTED';
  readonly retryable = false as const;

  constructor(readonly reason: string) {
    super('IDENTITY_PROVIDER_REQUEST_REJECTED');
    this.name = 'IdentityProviderRequestError';
  }
}

/**
 * Authentication boundary from ADR-006. Implementations verify the request;
 * they never supply tenant, membership, roles, or permissions.
 *
 * `verifyRequest` is the per-request hot path and must be networkless.
 * `getIdentityProfile` may call the provider and is only used by routes that
 * opt in with `config.identityProfile: 'required'`.
 */
export interface IdentityProvider {
  verifyRequest(request: FastifyRequest): Promise<VerifiedIdentity | null>;
  /**
   * Loads only provider-verified profile fields needed for local identity
   * reconciliation. Tenant, roles, permissions and provider metadata are
   * intentionally absent from this contract.
   */
  getIdentityProfile(identity: VerifiedIdentity): Promise<VerifiedIdentityProfile>;
}

/**
 * Current provider-side state of one subject, as fetched by the lifecycle
 * worker (fetch-on-process: webhooks are triggers, never the data source).
 * `verifiedPrimaryEmail` is the PRIMARY address only when it is verified;
 * `fullName` is raw (callers sanitize). No metadata, roles, organizations,
 * phone numbers, images or external accounts are part of this contract.
 */
export type IdentityLifecycleSnapshot =
  | {
    readonly kind: 'found';
    readonly verifiedPrimaryEmail: string | null;
    readonly fullName: string | null;
    readonly banned: boolean;
    readonly locked: boolean;
  }
  | { readonly kind: 'not_found' };

export interface IdentitySnapshotSource {
  /** Throws IdentityProviderUnavailableError (retryable) or IdentityProviderRequestError. */
  fetchIdentitySnapshot(externalSubject: string): Promise<IdentityLifecycleSnapshot>;
}
