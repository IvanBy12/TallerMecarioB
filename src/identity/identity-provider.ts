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

/**
 * Authentication boundary from ADR-006. Implementations verify the request;
 * they never supply tenant, membership, roles, or permissions.
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
