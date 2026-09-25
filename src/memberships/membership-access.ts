/**
 * PostgreSQL primitives shared by the membership administration commands:
 * S1-05 role management (./roles-service.ts) and S1-06 membership lifecycle
 * (./lifecycle-service.ts). One definition of the lock entry point, of the
 * fresh actor permission read and of the target-authority rule, so both
 * command families serialize and authorize identically.
 *
 * Every function runs on the tenant request's reserved transaction (TenantContext
 * GUCs bound, FORCE RLS, NOBYPASSRLS runtime); none opens a transaction or
 * accepts a tenant id from the request.
 */

import type postgres from 'postgres';
import type { TenantRequestContext } from '../api/app.js';
import { ROLE_CODES, type PermissionCode, type RoleCode } from '../authz/rbac-matrix.js';
import { ROLE_ASSIGNMENT_PERMISSION } from '../authz/role-assignment.js';

export type MembershipStatus = 'active' | 'suspended' | 'revoked';

/** The invariant subject of ERD "al menos un owner activo" (not an authorization shortcut). */
export const OWNER_ROLE: RoleCode = 'owner';

export interface MemberRoleDto {
  readonly role: RoleCode;
  readonly assignedAt: string;
}

export function parseRole(value: unknown): RoleCode {
  const role = ROLE_CODES.find((code) => code === value);
  if (!role) throw new Error('MEMBER_ROLE_UNKNOWN');
  return role;
}

export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Role DTOs in canonical order (ROLE_CODES), independent of the database row order. */
export function orderedRoles(assignedAtByRole: ReadonlyMap<RoleCode, string>): MemberRoleDto[] {
  return ROLE_CODES
    .filter((code) => assignedAtByRole.has(code))
    .map((role) => ({ role, assignedAt: assignedAtByRole.get(role)! }));
}

/**
 * The tenant owner-set lock (0013/0014): owner_mutation_gate ACCESS SHARE, then
 * the TenantContext tenant's workshop row FOR NO KEY UPDATE (under RLS: only the
 * bound tenant can be locked; no tenant id is passed). The single serialization
 * point of every role change and every membership status change of a tenant,
 * always taken before any membership row lock (ADR-009 §10.1).
 */
export async function lockCurrentTenantOwnerSet(sql: postgres.ReservedSql): Promise<void> {
  await sql`SELECT app.lock_current_tenant_owner_set()`;
}

interface RoleRow {
  role_code: string;
  assigned_at: Date;
}

export async function rolesOf(sql: postgres.ReservedSql, tenantId: string, membershipId: string): Promise<MemberRoleDto[]> {
  const rows = await sql<RoleRow[]>`
    SELECT r.code AS role_code, mr.assigned_at
    FROM public.membership_roles AS mr
    JOIN public.roles AS r ON r.id = mr.role_id
    WHERE mr.tenant_id = ${tenantId} AND mr.membership_id = ${membershipId}
  `;
  return orderedRoles(new Map(rows.map((row) => [parseRole(row.role_code), iso(row.assigned_at)])));
}

/**
 * The actor's tenant-wide permission codes, re-read from PostgreSQL rows
 * AFTER the locks (never from the request-start TenantContext snapshot, the
 * JWT, the body or RBAC_MATRIX_V1). The actor row is share-locked so its
 * status cannot change before COMMIT; an inactive actor has no permissions.
 */
export async function freshActorPermissions(sql: postgres.ReservedSql, context: TenantRequestContext): Promise<Set<string>> {
  const { tenant } = context;
  const [actor] = await sql<{ id: string }[]>`
    SELECT m.id FROM public.memberships AS m
    WHERE m.id = ${tenant.membershipId} AND m.tenant_id = ${tenant.tenantId}
      AND m.user_id = ${tenant.userId} AND m.status = 'active'
    FOR SHARE OF m
  `;
  if (!actor) return new Set();
  const rows = await sql<{ code: string }[]>`
    SELECT DISTINCT p.code
    FROM public.membership_roles AS mr
    JOIN public.role_permissions AS rp ON rp.role_id = mr.role_id AND rp.resource_scope = 'tenant'
    JOIN public.permissions AS p ON p.id = rp.permission_id
    WHERE mr.tenant_id = ${tenant.tenantId} AND mr.membership_id = ${tenant.membershipId}
  `;
  return new Set(rows.map((row) => row.code));
}

export async function remainingActiveOwners(sql: postgres.ReservedSql, tenantId: string, excludedMembershipId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM public.membership_roles AS mr
    JOIN public.roles AS r ON r.id = mr.role_id
    JOIN public.memberships AS m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
    WHERE mr.tenant_id = ${tenantId}
      AND r.code = ${OWNER_ROLE}
      AND m.status = 'active'
      AND mr.membership_id <> ${excludedMembershipId}
  `;
  return row?.n ?? 0;
}

/**
 * Target authority (RBAC v1 §2, §4 note, §16.4, §16.5): administering a
 * membership that holds role R requires the permission that could assign R
 * (owner -> roles.assign_owner, admin -> roles.assign_admin, service_advisor |
 * technician -> roles.assign_staff). Only owner holds assign_owner/assign_admin,
 * so an admin can never manage an owner/admin membership. Permission codes
 * only; never a role name as a shortcut.
 */
export function missingTargetAuthority(permissions: ReadonlySet<string>, heldRoles: Iterable<RoleCode>): PermissionCode[] {
  const required = new Set<PermissionCode>();
  for (const role of heldRoles) required.add(ROLE_ASSIGNMENT_PERMISSION[role]);
  return [...required].filter((code) => !permissions.has(code)).sort();
}
