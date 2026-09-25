/**
 * S1-06 membership lifecycle administration: list/read the memberships of the
 * current tenant and the administrative status commands on an EXISTING
 * membership (RBAC v1 §4/§16/§20, Diccionario 01 §4, ERD «Invariante de owner
 * activo», ADR-009 §10.1, Estados y Transiciones v1 §1/§9).
 *
 * The only transitions this module performs:
 *
 *   suspend   active    -> suspended   audit membership.suspended
 *   revoke    active    -> revoked     audit membership.revoked
 *   revoke    suspended -> revoked     audit membership.revoked (suspended_at kept)
 *
 * Anything else is 409 DOMAIN_INVALID_STATE_TRANSITION with no effect. There is
 * NO reactivation command (suspended|revoked -> active): the canonical docs do
 * not define it (DECISION_REQUIRED, docs/S1-06-DOC-CHANGES.md), so it fails
 * closed. `revoked` is terminal here (Estados §1). Memberships are never
 * deleted, roles are kept (history), and users.status is never touched
 * (user disabled != membership revoked, S1-03).
 *
 * Every command runs inside the tenant request's single transaction, with the
 * same lock hierarchy as the S1-05 role commands and the S1-03 revocation
 * handler (ADR-009 §10.1):
 *
 *   owner-set lock   app.lock_current_tenant_owner_set(): gate ACCESS SHARE +
 *                    the TenantContext workshop row (before any row lock)
 *   actor            memberships FOR SHARE, permissions re-read from rows
 *   target           memberships FOR UPDATE, status re-read after the wait
 *   checks           manage permission, target authority, transition
 *   UPDATE           memberships status + lifecycle timestamp; the 0012-0014
 *                    trigger enforces the active-owner invariant in PostgreSQL
 *                    (23514 m_last_active_owner -> 409 LAST_OWNER_REQUIRED);
 *                    this module does not re-implement that count
 *   audit            membership.suspended / membership.revoked (RBAC §20)
 *
 * Any thrown error rolls the whole transaction back, except the durable 403
 * DOMAIN_ACTION_FORBIDDEN (self-management or insufficient authority over the
 * target), whose `denied` audit row is committed by the route.
 */

import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { PermissionDeniedError } from '../authz/authorize.js';
import type { PermissionCode, RoleCode } from '../authz/rbac-matrix.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import {
  freshActorPermissions,
  iso,
  lockCurrentTenantOwnerSet,
  type MemberRoleDto,
  type MembershipStatus,
  missingTargetAuthority,
  orderedRoles,
  parseRole,
  rolesOf,
} from './membership-access.js';

const REASON_CODE = 'member_status_management';
const MANAGE_PERMISSION: PermissionCode = 'memberships.manage_staff';
const LIST_LIMIT = 200;

export const MEMBER_LIFECYCLE_ERRORS = Object.freeze({
  MEMBERSHIP_NOT_FOUND: { status: 404, message: 'The membership was not found.' },
  DOMAIN_INVALID_STATE_TRANSITION: { status: 409, message: 'The membership cannot make this transition from its current state.' },
  LAST_OWNER_REQUIRED: { status: 409, message: 'The workshop must keep at least one active owner.' },
  DOMAIN_ACTION_FORBIDDEN: { status: 403, message: 'This membership cannot be managed by the current member.' },
} as const);

export type MemberLifecycleErrorCode = keyof typeof MEMBER_LIFECYCLE_ERRORS;

export function memberLifecycleError(code: MemberLifecycleErrorCode): ApiError {
  const { status, message } = MEMBER_LIFECYCLE_ERRORS[code];
  return new ApiError(status, code, message);
}

/** Thrown AFTER the denied audit row was written; the route commits it. */
export class MembershipActionDeniedError extends Error {
  readonly code = 'DOMAIN_ACTION_FORBIDDEN' as const;
  constructor() {
    super('DOMAIN_ACTION_FORBIDDEN');
    this.name = 'MembershipActionDeniedError';
  }
}

/** Server-derived request context only (never a client-supplied free-form header). */
export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string;
}

/** Minimized DTO: membership + role data only (runtime has no access to `users`). */
export interface MembershipDto {
  readonly membershipId: string;
  readonly status: MembershipStatus;
  readonly joinedAt: string;
  readonly suspendedAt: string | null;
  readonly revokedAt: string | null;
  readonly roles: readonly MemberRoleDto[];
}

export type MembershipCommand = 'suspend' | 'revoke';
type LifecycleAction = 'membership.suspended' | 'membership.revoked';

/** The canonical transition table of this module (see header). */
const TRANSITIONS: Readonly<Record<MembershipCommand, {
  readonly action: LifecycleAction;
  readonly to: MembershipStatus;
  readonly from: readonly MembershipStatus[];
}>> = Object.freeze({
  suspend: { action: 'membership.suspended', to: 'suspended', from: ['active'] },
  revoke: { action: 'membership.revoked', to: 'revoked', from: ['active', 'suspended'] },
});

interface MembershipRow {
  id: string;
  status: MembershipStatus;
  joined_at: Date;
  suspended_at: Date | null;
  revoked_at: Date | null;
}

function toDto(row: MembershipRow, roles: readonly MemberRoleDto[]): MembershipDto {
  return {
    membershipId: row.id,
    status: row.status,
    joinedAt: iso(row.joined_at),
    suspendedAt: row.suspended_at ? iso(row.suspended_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    roles,
  };
}

function isDatabaseError(error: unknown, code: string, constraint: string): boolean {
  const candidate = error as { code?: string; constraint_name?: string } | null;
  return candidate?.code === code && candidate.constraint_name === constraint;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function listMemberships(context: TenantRequestContext): Promise<MembershipDto[]> {
  const { sql, tenant } = context;
  const rows = await sql<MembershipRow[]>`
    SELECT m.id, m.status, m.joined_at, m.suspended_at, m.revoked_at
    FROM public.memberships AS m
    WHERE m.tenant_id = ${tenant.tenantId}
    ORDER BY m.joined_at, m.id
    LIMIT ${LIST_LIMIT}
  `;
  if (rows.length === 0) return [];
  const roleRows = await sql<{ membership_id: string; role_code: string; assigned_at: Date }[]>`
    SELECT mr.membership_id, r.code AS role_code, mr.assigned_at
    FROM public.membership_roles AS mr
    JOIN public.roles AS r ON r.id = mr.role_id
    WHERE mr.tenant_id = ${tenant.tenantId} AND mr.membership_id = ANY(${rows.map((row) => row.id)}::uuid[])
  `;
  const byMembership = new Map<string, Map<RoleCode, string>>();
  for (const row of roleRows) {
    const held = byMembership.get(row.membership_id) ?? new Map<RoleCode, string>();
    held.set(parseRole(row.role_code), iso(row.assigned_at));
    byMembership.set(row.membership_id, held);
  }
  return rows.map((row) => toDto(row, orderedRoles(byMembership.get(row.id) ?? new Map())));
}

export async function getMembership(context: TenantRequestContext, membershipId: string): Promise<MembershipDto> {
  const { sql, tenant } = context;
  const [row] = await sql<MembershipRow[]>`
    SELECT m.id, m.status, m.joined_at, m.suspended_at, m.revoked_at
    FROM public.memberships AS m
    WHERE m.id = ${membershipId} AND m.tenant_id = ${tenant.tenantId}
  `;
  if (!row) throw memberLifecycleError('MEMBERSHIP_NOT_FOUND');
  return toDto(row, await rolesOf(sql, tenant.tenantId, row.id));
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

interface AuditInput {
  readonly action: LifecycleAction;
  readonly outcome: 'success' | 'denied';
  readonly targetMembershipId: string;
  readonly reasonCode: string;
  readonly before?: postgres.JSONValue;
  readonly after?: postgres.JSONValue;
  readonly metadata: postgres.JSONValue;
}

/**
 * Minimized, allowlisted audit row (RBAC §16.8: actor, target membership,
 * before/after, tenant, request_id). Ids, statuses and role codes only: no
 * email, no token, no JWT, no client header (user_agent stays NULL).
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
      ${row.action}, ${row.outcome}, 'membership', ${row.targetMembershipId}, ${row.reasonCode},
      ${row.before === undefined ? null : sql.json(row.before)},
      ${row.after === undefined ? null : sql.json(row.after)},
      ${sql.json(row.metadata)},
      ${meta.requestId}, ${meta.ipAddress}::inet
    )
  `;
}

async function lockTarget(sql: postgres.ReservedSql, tenantId: string, membershipId: string): Promise<MembershipRow> {
  const [row] = await sql<MembershipRow[]>`
    SELECT m.id, m.status, m.joined_at, m.suspended_at, m.revoked_at
    FROM public.memberships AS m
    WHERE m.id = ${membershipId} AND m.tenant_id = ${tenantId}
    FOR UPDATE OF m
  `;
  if (!row) throw memberLifecycleError('MEMBERSHIP_NOT_FOUND');
  return row;
}

async function writeStatus(
  sql: postgres.ReservedSql,
  tenantId: string,
  target: MembershipRow,
  to: MembershipStatus,
): Promise<MembershipRow | undefined> {
  // Only the lifecycle columns granted to the API by 0015 are written.
  const [row] = to === 'suspended'
    ? await sql<MembershipRow[]>`
      UPDATE public.memberships AS m
      SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE m.tenant_id = ${tenantId} AND m.id = ${target.id} AND m.status = ${target.status}
      RETURNING m.id, m.status, m.joined_at, m.suspended_at, m.revoked_at
    `
    : await sql<MembershipRow[]>`
      UPDATE public.memberships AS m
      SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE m.tenant_id = ${tenantId} AND m.id = ${target.id} AND m.status = ${target.status}
      RETURNING m.id, m.status, m.joined_at, m.suspended_at, m.revoked_at
    `;
  return row;
}

export async function changeMembershipStatus(
  context: TenantRequestContext,
  command: MembershipCommand,
  membershipId: string,
  meta: RequestMeta,
): Promise<MembershipDto> {
  const { sql, tenant } = context;
  const transition = TRANSITIONS[command];

  // Self-management is not defined by the docs: fail closed, audited, durable.
  if (membershipId === tenant.membershipId) {
    await insertAudit(sql, context, meta, {
      action: transition.action,
      outcome: 'denied',
      targetMembershipId: membershipId,
      reasonCode: 'self_membership_modification',
      metadata: { command },
    });
    throw new MembershipActionDeniedError();
  }

  await lockCurrentTenantOwnerSet(sql);
  const permissions = await freshActorPermissions(sql, context);
  const target = await lockTarget(sql, tenant.tenantId, membershipId);
  const roles = await rolesOf(sql, tenant.tenantId, target.id);
  const heldRoles = roles.map((held) => held.role);

  if (!permissions.has(MANAGE_PERMISSION)) throw new PermissionDeniedError(MANAGE_PERMISSION);

  const missing = missingTargetAuthority(permissions, heldRoles);
  if (missing.length > 0) {
    await insertAudit(sql, context, meta, {
      action: transition.action,
      outcome: 'denied',
      targetMembershipId: target.id,
      reasonCode: 'membership_management_not_permitted',
      metadata: { command, roles: heldRoles, missing_permissions: missing },
    });
    throw new MembershipActionDeniedError();
  }

  if (!transition.from.includes(target.status)) throw memberLifecycleError('DOMAIN_INVALID_STATE_TRANSITION');

  let updated: MembershipRow | undefined;
  try {
    updated = await writeStatus(sql, tenant.tenantId, target, transition.to);
  } catch (error) {
    if (isDatabaseError(error, '23514', 'm_last_active_owner')) throw memberLifecycleError('LAST_OWNER_REQUIRED');
    throw error;
  }
  // The row is locked FOR UPDATE: a mismatch here is a broken invariant, not a race.
  if (!updated) throw new Error('MEMBERSHIP_STATUS_UPDATE_FAILED');

  await insertAudit(sql, context, meta, {
    action: transition.action,
    outcome: 'success',
    targetMembershipId: target.id,
    reasonCode: REASON_CODE,
    before: { status: target.status },
    after: { status: updated.status },
    metadata: { command, roles: heldRoles },
  });
  return toDto(updated, roles);
}
