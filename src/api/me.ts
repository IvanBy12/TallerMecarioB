import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { discoverActiveMemberships } from '../tenancy/tenant-context-db.js';
import {
  ActiveMembershipRequiredError,
  NO_TENANT_SELECTION,
  selectTenantCandidate,
  TenantSelectionRequiredError,
} from '../tenancy/tenant-selection.js';
import { getIdentityOnlyRequestContext } from './request-context.js';

/**
 * GET /api/v1/me — deliberately minimal (no canonical DTO exists yet; see the
 * S1-02 integration report, DOC_DECISION_REQUIRED).
 *
 *  - `user`: the caller's own `users.id`, or null when PostgreSQL has no
 *    ACTIVE user with an ACTIVE membership for the verified identity. The only
 *    pre-tenant read path (ADR-009 §7, app.bootstrap_list_active_memberships)
 *    cannot tell "no local user", "active user without memberships" and
 *    "disabled user" apart, so /me does not either.
 *  - `memberships`: the caller's own active memberships (ids only).
 *  - `tenantSelection`: what a tenant route does WITHOUT `X-Tenant-Id` —
 *    `unavailable` (0 → ACTIVE_MEMBERSHIP_REQUIRED), `automatic` (1, with its
 *    tenantId) or `required` (N → TENANT_SELECTION_REQUIRED). The frontend
 *    shows the tenant selector only for `required`.
 *
 * Identity-authenticated only: no provider profile fetch, no tenant
 * transaction, no roles/permissions, never creates users or memberships.
 * The list is a snapshot, not authorization proof: every tenant route
 * revalidates its membership inside its own transaction.
 */
export interface MeResponse {
  readonly user: { readonly id: string } | null;
  readonly memberships: readonly { readonly membershipId: string; readonly tenantId: string }[];
  readonly tenantSelection: {
    readonly mode: 'unavailable' | 'automatic' | 'required';
    readonly tenantId: string | null;
  };
}

function tenantSelectionOf(candidates: Parameters<typeof selectTenantCandidate>[0]): MeResponse['tenantSelection'] {
  try {
    const selected = selectTenantCandidate(candidates, NO_TENANT_SELECTION);
    return { mode: 'automatic', tenantId: selected.tenantId };
  } catch (error) {
    if (error instanceof ActiveMembershipRequiredError) return { mode: 'unavailable', tenantId: null };
    if (error instanceof TenantSelectionRequiredError) return { mode: 'required', tenantId: null };
    throw error;
  }
}

export function registerMeRoute(app: FastifyInstance, options: { readonly database: postgres.Sql }): void {
  app.get('/api/v1/me', async (request, reply) => {
    const { identity } = getIdentityOnlyRequestContext(request);
    const candidates = await discoverActiveMemberships(options.database, identity);

    const body: MeResponse = {
      user: candidates.length > 0 ? { id: candidates[0].userId } : null,
      memberships: candidates.map((candidate) => ({
        membershipId: candidate.membershipId,
        tenantId: candidate.tenantId,
      })),
      tenantSelection: tenantSelectionOf(candidates),
    };
    return reply.header('cache-control', 'no-store').send(body);
  });
}
