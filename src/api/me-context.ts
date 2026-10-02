import type { FastifyInstance } from 'fastify';
import type { PermissionGrant, RestrictedScope } from '../authz/permission-grants.js';
import { RESOURCE_SCOPES, type PermissionCode, type ResourceScope, type RoleCode } from '../authz/rbac-matrix.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { getTenantRequestContext } from './tenant-request.js';

/**
 * GET /api/v1/me/context — the caller's context in ONE workshop (frontend G5).
 *
 * A regular tenant route, not an identity-only one: the workshop comes only
 * from the server-side selection (`X-Tenant-Id`, or the single active
 * membership), the membership is revalidated inside the request transaction
 * and the guard requires `workshop.read`. Every failure is the pipeline's own
 * (401/400/403/409/429/500); the handler adds none.
 *
 * `roles` and `permissions` are the already-built `TenantContext` — the same
 * effective grants every other tenant route authorizes against (union of the
 * active roles, tenant dominating restricted scopes). Nothing is rebuilt from
 * headers or from the identity provider, and `roles` is informative only.
 *
 * The workshop read goes through the request transaction, so RLS
 * (`workshops.id = app.current_tenant_id()`) is the boundary; only the three
 * presentation columns are selected. No server-side "selected workshop" state
 * exists: the client sends `X-Tenant-Id` on every request.
 */

export interface MeContextPermission {
  readonly code: PermissionCode;
  /** `['tenant']`, or a non-empty subset of `['assigned', 'quality_control']` in that order. */
  readonly scopes: readonly ResourceScope[];
}

export interface MeContextResponse {
  readonly context: {
    readonly tenantId: string;
    readonly membershipId: string;
    readonly userId: string;
    readonly workshop: {
      readonly displayName: string;
      readonly timezone: string;
      readonly currency: string;
    };
    readonly roles: readonly RoleCode[];
    readonly permissions: readonly MeContextPermission[];
  };
}

const RESTRICTED_SCOPE_ORDER = RESOURCE_SCOPES.filter((scope): scope is RestrictedScope => scope !== 'tenant');

function scopesOf(grant: PermissionGrant): readonly ResourceScope[] {
  if (grant.kind === 'tenant') return ['tenant'];
  return RESTRICTED_SCOPE_ORDER.filter((scope) => grant.scopes.has(scope));
}

/**
 * Effective grants → wire format, sorted by permission code (code-point
 * order, locale independent). A grant without any scope is not a grant and
 * is omitted.
 */
export function serializeTenantPermissions(
  permissions: TenantContext['permissions'],
): readonly MeContextPermission[] {
  const serialized: MeContextPermission[] = [];
  for (const [code, grant] of permissions) {
    const scopes = scopesOf(grant);
    if (scopes.length > 0) serialized.push({ code, scopes });
  }
  return serialized.sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
}

interface WorkshopRow {
  display_name: string;
  timezone: string;
  currency: string;
}

const uuid = { type: 'string', minLength: 36, maxLength: 36 } as const;

// additionalProperties:false makes the serializer drop anything not listed.
const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['context'],
  properties: {
    context: {
      type: 'object',
      additionalProperties: false,
      required: ['tenantId', 'membershipId', 'userId', 'workshop', 'roles', 'permissions'],
      properties: {
        tenantId: uuid,
        membershipId: uuid,
        userId: uuid,
        workshop: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName', 'timezone', 'currency'],
          properties: {
            displayName: { type: 'string' },
            timezone: { type: 'string' },
            currency: { type: 'string' },
          },
        },
        roles: { type: 'array', items: { type: 'string' } },
        permissions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'scopes'],
            properties: {
              code: { type: 'string' },
              scopes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const;

export function registerMeContextRoute(app: FastifyInstance): void {
  app.get('/api/v1/me/context', {
    config: { permission: 'workshop.read' },
    schema: { response: { 200: responseSchema } },
  }, async (request, reply) => {
    const { tenant, sql } = getTenantRequestContext(request);

    // RLS already limits workshops to the bound tenant; the predicate states the intent.
    const [workshop] = await sql<WorkshopRow[]>`
      SELECT w.display_name, w.timezone, w.currency
      FROM public.workshops AS w
      WHERE w.id = ${tenant.tenantId}
    `;
    // memberships.tenant_id → workshops.id is a FK: a missing row is a server fault (sanitized 500).
    if (!workshop) throw new Error('ME_CONTEXT_WORKSHOP_NOT_FOUND');

    const body: MeContextResponse = {
      context: {
        tenantId: tenant.tenantId,
        membershipId: tenant.membershipId,
        userId: tenant.userId,
        workshop: {
          displayName: workshop.display_name,
          timezone: workshop.timezone,
          currency: workshop.currency,
        },
        roles: [...tenant.roles],
        permissions: serializeTenantPermissions(tenant.permissions),
      },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });
}
