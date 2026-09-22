import type { FastifyRequest } from 'fastify';

export interface VerifiedIdentity {
  identityProvider: string;
  externalSubject: string;
}

/**
 * Authentication boundary from ADR-006. Implementations verify the request;
 * they never supply tenant, membership, roles, or permissions.
 */
export interface IdentityProvider {
  verifyRequest(request: FastifyRequest): Promise<VerifiedIdentity | null>;
}
