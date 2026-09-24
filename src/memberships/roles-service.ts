/**
 * S1-05 member role management: read, assign and remove the roles of an
 * EXISTING membership of the current tenant (RBAC v1 §4/§16/§20,
 * Diccionario 01 §9, ERD "todo taller conserva al menos un owner activo").
 *
 * Every command runs inside the tenant request's single transaction
 * (TenantContext GUCs bound, FORCE RLS, NOBYPASSRLS runtime) in this order:
 *
 *   tenant role-change lock   pg_advisory_xact_lock(owner_set/<tenant>): every
 *                             role change of a tenant serializes here; it is
 *                             the same key the 0011 trigger takes (re-entrant)
 *   lock actor                memberships FOR SHARE (status cannot change under us)
 *   lock target               memberships FOR UPDATE (status/role race)
 *   permission check          FRESH from DB rows, after the locks: a concurrent
 *                             demotion of the actor committed before our lock is
 *                             seen here, not the request-start snapshot
 *   invariant check           active target, duplicate/absent role, last owner
 *   write membership_roles    INSERT or DELETE only (never UPDATE)
 *   audit                     role.assigned / role.revoked (RBAC §20)
 *
 * Any thrown error rolls the whole transaction back. The only 4xx outcomes
 * that COMMIT are the denied privilege-escalation attempts (their `denied`
 * audit row must persist): ROLE_ASSIGNMENT_NOT_ALLOWED and
 * SELF_ROLE_MODIFICATION_FORBIDDEN, raised as `RoleChangeDeniedError` and
 * marked durable by the route.
 *
 * Authorization is by permission code only. To change a role R on a target T
 * the actor needs memberships.manage_staff, the assignment permission of R
 * AND the assignment permission of every role T currently holds (an admin,
 * who only holds roles.assign_staff, can therefore never touch an owner/admin
 * membership nor grant/remove owner/admin). Nobody changes their own roles
 * through these generic commands (RBAC §16.6). assigned_by_membership_id is
 * always the authenticated actor's TenantContext membership.
 */

import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { PermissionDeniedError } from '../authz/authorize.js';
import { ROLE_CODES, type PermissionCode, type RoleCode } from '../authz/rbac-matrix.js';
import { ROLE_ASSIGNMENT_PERMISSION } from '../authz/role-assignment.js';
import { uuidV7 } from '../platform/uuid-v7.js';

const REASON_CODE = 'member_role_management';
const MANAGE_PERMISSION: PermissionCode = 'memberships.manage_staff';
/** The invariant subject of ERD "al menos un owner activo" (not an authorization shortcut). */
const OWNER_ROLE: RoleCode = 'owner';

export const MEMBER_ROLE_ERRORS = Object.freeze({
  MEMBERSHIP_NOT_FOUND: { status: 404, message: 'The membership was not found.' },
  MEMBERSHIP_NOT_ACTIVE: { status: 409, message: 'Roles can only be changed on an active membership.' },
  ROLE_ALREADY_ASSIGNED: { status: 409, message: 'The membership already holds this role.' },
  ROLE_NOT_ASSIGNED: { status: 404, message: 'The membership does not hold this role.' },
  LAST_OWNER_REQUIRED: { status: 409, message: 'The workshop must keep at least one active owner.' },
  ROLE_ASSIGNMENT_NOT_ALLOWED: { status: 403, message: 'This membership cannot change the requested role.' },
  SELF_ROLE_MODIFICATION_FORBIDDEN: { status: 403, message: 'A membership cannot change its own roles.' },
} as const);

export type MemberRoleErrorCode = keyof typeof MEMBER_ROLE_ERRORS;
export type DurableRoleDenialCode = 'ROLE_ASSIGNMENT_NOT_ALLOWED' | 'SELF_ROLE_MODIFICATION_FORBIDDEN';

export function memberRoleError(code: MemberRoleErrorCode): ApiError {
  const { status, message } = MEMBER_ROLE_ERRORS[code];
  return new ApiError(status, code, message);
}

/** Thrown AFTER the denied audit row was written; the route commits it. */
export class RoleChangeDeniedError extends Error {
  constructor(readonly code: DurableRoleDenialCode) {
    super(code);
    this.name = 'RoleChangeDeniedError';
  }
}

/** Server-derived request context only (never a client-supplied free-form header). */
export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string;
}

export interface MemberRoleDto {
  readonly role: RoleCode;
  readonly assignedAt: string;
}

export interface MemberRolesDto {
  readonly membershipId: string;
  readonly status: 'active' | 'suspended' | 'revoked';
  readonly roles: readonly MemberRoleDto[];
}

type MembershipStatus = MemberRolesDto['status'];
type RoleAction = 'role.assigned' | 'role.revoked';

interface DatabaseError {
  code?: string;
  constraint_name?: string;
}

function isDatabaseError(error: unknown, code: string, constraint: string): boolean {
  const candidate = error as DatabaseError | null;
  return candidate?.code === code && candidate.constraint_name === constraint;
}

function parseRole(value: unknown): RoleCode {
  const role = ROLE_CODES.find((code) => code === value);
  if (!role) throw new Error('MEMBER_ROLE_UNKNOWN');
  return role;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Canonical order (ROLE_CODES), independent of the database row order. */
function sortedRoles(roles: Iterable<RoleCode>): RoleCode[] {
  const held = new Set(roles);
  return ROLE_CODES.filter((code) => held.has(code));
}

/* -------------------------------------------------------------------------- */
/* Queries (all on the request's reserved, tenant-bound transaction)          */
/* -------------------------------------------------------------------------- */

interface TargetRow {
  id: string;
  status: MembershipStatus;
}

interface RoleRow {
  role_code: string;
  assigned_at: Date;
}

/** Same key as the 0011 trigger: one serialization point per tenant. */
async function lockTenantRoleChanges(sql: postgres.ReservedSql, tenantId: string): Promise<void> {
  await sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${'tallermecario.membership_roles.owner_set/' + tenantId}, 0)
    )
  `;
}

async function lockTarget(sql: postgres.ReservedSql, tenantId: string, membershipId: string): Promise<TargetRow> {
  const [row] = await sql<TargetRow[]>`
    SELECT m.id, m.status FROM public.memberships AS m
    WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}
    FOR UPDATE OF m
  `;
  if (!row) throw memberRoleError('MEMBERSHIP_NOT_FOUND');
  return row;
}

async function readTarget(sql: postgres.ReservedSql, tenantId: string, membershipId: string): Promise<TargetRow> {
  const [row] = await sql<TargetRow[]>`
    SELECT m.id, m.status FROM public.memberships AS m
    WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}
  `;
  if (!row) throw memberRoleError('MEMBERSHIP_NOT_FOUND');
  return row;
}

async function rolesOf(sql: postgres.ReservedSql, tenantId: string, membershipId: string): Promise<MemberRoleDto[]> {
  const rows = await sql<RoleRow[]>`
    SELECT r.code AS role_code, mr.assigned_at
    FROM public.membership_roles AS mr
    JOIN public.roles AS r ON r.id = mr.role_id
    WHERE mr.tenant_id = ${tenantId} AND mr.membership_id = ${membershipId}
  `;
  const byRole = new Map(rows.map((row) => [parseRole(row.role_code), iso(row.assigned_at)]));
  return sortedRoles(byRole.keys()).map((role) => ({ role, assignedAt: byRole.get(role)! }));
}

/**
 * The actor's tenant-wide permission codes, re-read from PostgreSQL rows
 * AFTER the locks (never from the request-start TenantContext snapshot, the
 * JWT, the body or RBAC_MATRIX_V1). The actor row is share-locked so its
 * status cannot change before COMMIT; an inactive actor has no permissions.
 */
async function freshActorPermissions(sql: postgres.ReservedSql, context: TenantRequestContext): Promise<Set<string>> {
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

async function remainingActiveOwners(sql: postgres.ReservedSql, tenantId: string, excludedMembershipId: string): Promise<number> {
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

interface AuditInput {
  readonly action: RoleAction;
  readonly outcome: 'success' | 'denied';
  readonly targetMembershipId: string;
  readonly reasonCode?: string;
  readonly before?: postgres.JSONValue;
  readonly after?: postgres.JSONValue;
  readonly metadata: postgres.JSONValue;
}

/**
 * Minimized, allowlisted audit row (RBAC §16.8: actor, target membership,
 * before/after, tenant, request_id). Ids and role codes only: no email, no
 * token, no JWT, no client header (user_agent stays NULL).
 */
async function insertAudit(sql: postgres.ReservedSql, context: TenantRequestContext, meta: RequestMeta, row: AuditInput): Promise<void> {
  const { tenant } = context;
  await sql`
    INSERT INTO public.audit_logs (
      id, tenant_id, actor_type, actor_user_id, actor_membership_id,
      action, outcome, entity_type, entity_id, reason_code,
      before_json, after_json, metadata_json, request_id, ip_address
    ) VALUES (
      ${uuidV7()}, ${tenant.tenantId}, 'user', ${tenant.userId}, ${tenant.membershipId},
      ${row.action}, ${row.outcome}, 'membership_role', ${row.targetMembershipId}, ${row.reasonCode ?? REASON_CODE},
      ${row.before === undefined ? null : sql.json(row.before)},
      ${row.after === undefined ? null : sql.json(row.after)},
      ${sql.json(row.metadata)},
      ${meta.requestId}, ${meta.ipAddress}::inet
    )
  `;
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export async function listMemberRoles(context: TenantRequestContext, membershipId: string): Promise<MemberRolesDto> {
  const { sql, tenant } = context;
  const target = await readTarget(sql, tenant.tenantId, membershipId);
  return { membershipId: target.id, status: target.status, roles: await rolesOf(sql, tenant.tenantId, target.id) };
}

interface PreparedChange {
  readonly target: TargetRow;
  readonly roles: readonly MemberRoleDto[];
}

/**
 * Shared prologue of assign/remove: self-modification, locks, fresh
 * permission check (with durable denied audit), then target status.
 */
async function prepareChange(
  context: TenantRequestContext,
  action: RoleAction,
  membershipId: string,
  role: RoleCode,
  meta: RequestMeta,
): Promise<PreparedChange> {
  const { sql, tenant } = context;

  if (membershipId === tenant.membershipId) {
    await insertAudit(sql, context, meta, {
      action,
      outcome: 'denied',
      targetMembershipId: membershipId,
      reasonCode: 'self_role_modification',
      metadata: { role },
    });
    throw new RoleChangeDeniedError('SELF_ROLE_MODIFICATION_FORBIDDEN');
  }

  await lockTenantRoleChanges(sql, tenant.tenantId);
  const permissions = await freshActorPermissions(sql, context);
  const target = await lockTarget(sql, tenant.tenantId, membershipId);
  const roles = await rolesOf(sql, tenant.tenantId, target.id);

  if (!permissions.has(MANAGE_PERMISSION)) throw new PermissionDeniedError(MANAGE_PERMISSION);

  const required = new Set<PermissionCode>([ROLE_ASSIGNMENT_PERMISSION[role]]);
  for (const held of roles) required.add(ROLE_ASSIGNMENT_PERMISSION[held.role]);
  const missing = [...required].filter((code) => !permissions.has(code)).sort();
  if (missing.length > 0) {
    await insertAudit(sql, context, meta, {
      action,
      outcome: 'denied',
      targetMembershipId: target.id,
      reasonCode: 'role_assignment_not_permitted',
      metadata: { role, missing_permissions: missing },
    });
    throw new RoleChangeDeniedError('ROLE_ASSIGNMENT_NOT_ALLOWED');
  }

  // No reactivation and no role change on suspended/revoked memberships.
  if (target.status !== 'active') throw memberRoleError('MEMBERSHIP_NOT_ACTIVE');
  return { target, roles };
}

export async function assignMemberRole(
  context: TenantRequestContext,
  membershipId: string,
  roleInput: RoleCode,
  meta: RequestMeta,
): Promise<MemberRolesDto> {
  const { sql, tenant } = context;
  const role = parseRole(roleInput);
  const { target, roles } = await prepareChange(context, 'role.assigned', membershipId, role, meta);
  if (roles.some((held) => held.role === role)) throw memberRoleError('ROLE_ALREADY_ASSIGNED');

  let inserted: { assigned_at: Date }[];
  try {
    inserted = await sql<{ assigned_at: Date }[]>`
      INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      SELECT ${tenant.tenantId}, ${target.id}, r.id, ${tenant.membershipId}
      FROM public.roles AS r
      WHERE r.code = ${role} AND r.scope = 'tenant' AND r.is_system
      ON CONFLICT (tenant_id, membership_id, role_id) DO NOTHING
      RETURNING assigned_at
    `;
  } catch (error) {
    if (isDatabaseError(error, '23514', 'mr_membership_not_active')) throw memberRoleError('MEMBERSHIP_NOT_ACTIVE');
    throw error;
  }
  if (inserted.length !== 1) throw memberRoleError('ROLE_ALREADY_ASSIGNED');

  const after = await rolesOf(sql, tenant.tenantId, target.id);
  await insertAudit(sql, context, meta, {
    action: 'role.assigned',
    outcome: 'success',
    targetMembershipId: target.id,
    before: { roles: roles.map((held) => held.role) },
    after: { roles: after.map((held) => held.role) },
    metadata: { role },
  });
  return { membershipId: target.id, status: target.status, roles: after };
}

export async function removeMemberRole(
  context: TenantRequestContext,
  membershipId: string,
  roleInput: RoleCode,
  meta: RequestMeta,
): Promise<MemberRolesDto> {
  const { sql, tenant } = context;
  const role = parseRole(roleInput);
  const { target, roles } = await prepareChange(context, 'role.revoked', membershipId, role, meta);
  if (!roles.some((held) => held.role === role)) throw memberRoleError('ROLE_NOT_ASSIGNED');

  if (role === OWNER_ROLE && await remainingActiveOwners(sql, tenant.tenantId, target.id) === 0) {
    throw memberRoleError('LAST_OWNER_REQUIRED');
  }

  let deleted: postgres.RowList<postgres.Row[]>;
  try {
    deleted = await sql`
      DELETE FROM public.membership_roles AS mr
      USING public.roles AS r
      WHERE r.id = mr.role_id AND r.code = ${role}
        AND mr.tenant_id = ${tenant.tenantId} AND mr.membership_id = ${target.id}
      RETURNING mr.membership_id
    `;
  } catch (error) {
    if (isDatabaseError(error, '23514', 'mr_last_active_owner')) throw memberRoleError('LAST_OWNER_REQUIRED');
    throw error;
  }
  if (deleted.count !== 1) throw memberRoleError('ROLE_NOT_ASSIGNED');

  const after = await rolesOf(sql, tenant.tenantId, target.id);
  await insertAudit(sql, context, meta, {
    action: 'role.revoked',
    outcome: 'success',
    targetMembershipId: target.id,
    before: { roles: roles.map((held) => held.role) },
    after: { roles: after.map((held) => held.role) },
    metadata: { role },
  });
  return { membershipId: target.id, status: target.status, roles: after };
}
