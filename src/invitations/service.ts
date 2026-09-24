/**
 * S1-04 membership invitations (ERD §membership_invitations, Dic. 01 §5,
 * RBAC §4 "Invitaciones internas", ADR-009 §7).
 *
 *   create / list / revoke   tenant routes: the caller's TenantContext and its
 *                            single reserved transaction (RLS). tenant_id is
 *                            never read from the request.
 *   accept                   identity-only route: verified Clerk identity +
 *                            verified PRIMARY email. The token hash is resolved
 *                            to (invitation, tenant) by one allowlisted
 *                            SECURITY DEFINER function; everything after that
 *                            runs under that tenant's GUCs and RLS, in ONE
 *                            transaction (lock invitation -> user -> membership
 *                            -> membership_role -> accepted -> audit).
 *
 * Authorization is by permission code only. The ROLE BEING ASSIGNED (a data
 * value, not the caller's role) maps to the permission that allows assigning
 * it: owner -> roles.assign_owner, admin -> roles.assign_admin,
 * service_advisor/technician -> roles.assign_staff (RBAC §4).
 */

import type postgres from 'postgres';
import { ApiError, type TenantRequestContext } from '../api/app.js';
import { resolvePermissionDecision } from '../authz/authorize.js';
import type { PermissionCode, RoleCode } from '../authz/rbac-matrix.js';
import { ROLE_CODES } from '../authz/rbac-matrix.js';
import type { VerifiedIdentity } from '../identity/identity-provider.js';
import type { VerifiedProfileInput } from '../identity/profile.js';
import { publishOutboxEvent } from '../outbox/publish.js';
import { INVITATION_EMAIL_EVENT_TYPE } from './email.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import {
  deriveInvitationToken,
  hashInvitationToken,
  newInvitationTokenNonce,
  type InvitationTokenKey,
} from './token.js';

export const INVITATION_TTL_DAYS = 7;
const REASON_CODE = 'membership_invitation';
const LIST_LIMIT = 200;

export const ROLE_ASSIGNMENT_PERMISSION: Readonly<Record<RoleCode, PermissionCode>> = Object.freeze({
  owner: 'roles.assign_owner',
  admin: 'roles.assign_admin',
  service_advisor: 'roles.assign_staff',
  technician: 'roles.assign_staff',
});

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface InvitationDto {
  readonly id: string;
  readonly email: string;
  readonly role: RoleCode;
  /** Effective status: a pending invitation past expires_at is reported as expired. */
  readonly status: InvitationStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}

/** Server-derived request context only: never a client-supplied free-form header. */
export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string;
}

/** Stable, sanitized invitation errors (Arquitectura Técnica v1 §13). */
export const INVITATION_ERRORS = Object.freeze({
  INVITATION_ALREADY_PENDING: { status: 409, message: 'A pending invitation already exists for this email.' },
  INVITATION_ROLE_NOT_ALLOWED: { status: 403, message: 'The requested role cannot be assigned by this membership.' },
  INVITATION_NOT_FOUND: { status: 404, message: 'The invitation was not found.' },
  INVITATION_INVALID: { status: 404, message: 'The invitation is invalid.' },
  INVITATION_EXPIRED: { status: 410, message: 'The invitation has expired.' },
  INVITATION_REVOKED: { status: 410, message: 'The invitation has been revoked.' },
  INVITATION_ALREADY_ACCEPTED: { status: 409, message: 'The invitation has already been used.' },
  INVITATION_EMAIL_MISMATCH: { status: 403, message: 'The invitation was issued for a different email address.' },
  MEMBERSHIP_ALREADY_EXISTS: { status: 409, message: 'The user already has a membership in this workshop.' },
  INVITATION_IN_PROGRESS: { status: 409, message: 'The invitation is being processed. Retry shortly.' },
} as const);

export type InvitationErrorCode = keyof typeof INVITATION_ERRORS;

export function invitationError(code: InvitationErrorCode): ApiError {
  const definition = INVITATION_ERRORS[code];
  return new ApiError(definition.status, code, definition.message);
}

/** Signals a denied role assignment whose `denied` audit row must be committed. */
export class InvitationRoleNotAllowedError extends Error {
  readonly code = 'INVITATION_ROLE_NOT_ALLOWED';
  constructor() {
    super('INVITATION_ROLE_NOT_ALLOWED');
    this.name = 'InvitationRoleNotAllowedError';
  }
}

interface DatabaseError {
  code?: string;
  constraint_name?: string;
}

function isDatabaseError(error: unknown, code: string, constraint?: string): boolean {
  const candidate = error as DatabaseError | null;
  return candidate?.code === code && (constraint === undefined || candidate.constraint_name === constraint);
}

function parseRole(value: unknown): RoleCode {
  const role = ROLE_CODES.find((code) => code === value);
  if (!role) throw new Error('INVITATION_ROLE_UNKNOWN');
  return role;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface InvitationRow {
  id: string;
  email: string;
  role_code: string;
  status: InvitationStatus;
  is_expired: boolean;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

function toDto(row: InvitationRow): InvitationDto {
  return {
    id: row.id,
    email: row.email,
    role: parseRole(row.role_code),
    status: row.status === 'pending' && row.is_expired ? 'expired' : row.status,
    expiresAt: iso(row.expires_at)!,
    createdAt: iso(row.created_at)!,
    acceptedAt: iso(row.accepted_at),
    revokedAt: iso(row.revoked_at),
  };
}

/** Tenant-wide grant for the permission that allows assigning `role`. */
function canAssignRole(context: TenantRequestContext, role: RoleCode): boolean {
  return resolvePermissionDecision(context.tenant, ROLE_ASSIGNMENT_PERMISSION[role]).kind === 'tenant';
}

interface AuditRow {
  tenantId: string;
  actorType: 'user' | 'system';
  actorUserId: string | null;
  actorMembershipId: string | null;
  action: string;
  outcome: 'success' | 'denied';
  entityType: string;
  entityId: string | null;
  reasonCode?: string;
  before?: postgres.JSONValue | null;
  after?: postgres.JSONValue | null;
  metadata?: postgres.JSONValue | null;
}

/**
 * Minimized, allowlisted audit rows (Operación §5.1): ids, role codes and
 * statuses only. Never the token, its hash, the nonce, the invitee email or
 * any client-supplied header (user_agent stays NULL, see routes.ts).
 */
async function insertAudit(sql: postgres.ReservedSql, meta: RequestMeta, rows: readonly AuditRow[]): Promise<void> {
  for (const row of rows) {
    await sql`
      INSERT INTO public.audit_logs (
        id, tenant_id, actor_type, actor_user_id, actor_membership_id,
        action, outcome, entity_type, entity_id, reason_code,
        before_json, after_json, metadata_json, request_id, ip_address
      ) VALUES (
        ${uuidV7()}, ${row.tenantId}, ${row.actorType}, ${row.actorUserId}, ${row.actorMembershipId},
        ${row.action}, ${row.outcome}, ${row.entityType}, ${row.entityId}, ${row.reasonCode ?? REASON_CODE},
        ${row.before == null ? null : sql.json(row.before)},
        ${row.after == null ? null : sql.json(row.after)},
        ${row.metadata == null ? null : sql.json(row.metadata)},
        ${meta.requestId}, ${meta.ipAddress}::inet
      )
    `;
  }
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateInvitationInput {
  /** Display form (NFC, trimmed). */
  readonly email: string;
  /** Canonical comparison form (see identity/profile.ts canonicalEmailSchema). */
  readonly emailNormalized: string;
  readonly role: RoleCode;
}

export async function createInvitation(
  context: TenantRequestContext,
  input: CreateInvitationInput,
  tokenKey: InvitationTokenKey,
  meta: RequestMeta,
): Promise<InvitationDto> {
  const { sql, tenant } = context;
  const role = parseRole(input.role);

  if (!canAssignRole(context, role)) {
    await insertAudit(sql, meta, [{
      tenantId: tenant.tenantId,
      actorType: 'user',
      actorUserId: tenant.userId,
      actorMembershipId: tenant.membershipId,
      action: 'membership.invited',
      outcome: 'denied',
      entityType: 'membership_invitation',
      entityId: null,
      reasonCode: 'role_assignment_not_permitted',
      metadata: { target_role: role, required_permission: ROLE_ASSIGNMENT_PERMISSION[role] },
    }]);
    throw new InvitationRoleNotAllowedError();
  }

  const [roleRow] = await sql<{ id: string }[]>`
    SELECT id FROM public.roles WHERE code = ${role} AND scope = 'tenant' AND is_system = true
  `;
  if (!roleRow) throw new Error('INVITATION_ROLE_NOT_CONFIGURED');

  // A pending invitation whose expires_at already passed would still occupy
  // the partial unique index: materialize its real `expired` transition first.
  const expired = await sql<{ id: string; role_code: string }[]>`
    UPDATE public.membership_invitations AS i
    SET status = 'expired'
    FROM public.roles AS r
    WHERE r.id = i.target_role_id
      AND i.tenant_id = ${tenant.tenantId}
      AND i.email_normalized = ${input.emailNormalized}
      AND i.status = 'pending'
      AND i.expires_at <= pg_catalog.clock_timestamp()
    RETURNING i.id, r.code AS role_code
  `;
  await insertAudit(sql, meta, expired.map((row) => ({
    tenantId: tenant.tenantId,
    actorType: 'system' as const,
    actorUserId: null,
    actorMembershipId: null,
    action: 'membership.invitation_expired',
    outcome: 'success' as const,
    entityType: 'membership_invitation',
    entityId: row.id,
    before: { status: 'pending' },
    after: { status: 'expired' },
    metadata: { materialized_by: 'invitation_create', target_role: row.role_code },
  })));

  const invitationId = uuidV7();
  const nonce = newInvitationTokenNonce();
  const tokenHash = hashInvitationToken(deriveInvitationToken(tokenKey, invitationId, nonce));

  let created: InvitationRow;
  try {
    [created] = await sql<InvitationRow[]>`
      INSERT INTO public.membership_invitations (
        id, tenant_id, email, email_normalized, target_role_id, token_hash,
        status, expires_at, invited_by_membership_id
      ) VALUES (
        ${invitationId}, ${tenant.tenantId}, ${input.email}, ${input.emailNormalized}, ${roleRow.id},
        ${tokenHash}, 'pending',
        pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => ${INVITATION_TTL_DAYS}),
        ${tenant.membershipId}
      )
      RETURNING id, email, ${role}::text AS role_code, status, false AS is_expired,
        expires_at, created_at, accepted_at, revoked_at
    `;
  } catch (error) {
    if (isDatabaseError(error, '23505', 'mi_one_pending_per_email_uq')) {
      throw invitationError('INVITATION_ALREADY_PENDING');
    }
    throw error;
  }

  // ADR-004: the email job commits (or rolls back) with the invitation. The
  // payload carries the nonce, never the token (see ./token.ts), and no PII.
  await publishOutboxEvent(sql, {
    id: uuidV7(),
    tenantId: tenant.tenantId,
    aggregateType: 'membership_invitation',
    aggregateId: invitationId,
    eventType: INVITATION_EMAIL_EVENT_TYPE,
    payload: { invitation_id: invitationId, token_nonce: nonce, token_key_version: tokenKey.version },
    idempotencyKey: invitationId,
  });

  await insertAudit(sql, meta, [{
    tenantId: tenant.tenantId,
    actorType: 'user',
    actorUserId: tenant.userId,
    actorMembershipId: tenant.membershipId,
    action: 'membership.invited',
    outcome: 'success',
    entityType: 'membership_invitation',
    entityId: invitationId,
    after: { status: 'pending', target_role: role, expires_at: iso(created.expires_at) },
  }]);

  return toDto(created);
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export async function listInvitations(context: TenantRequestContext): Promise<InvitationDto[]> {
  const rows = await context.sql<InvitationRow[]>`
    SELECT i.id, i.email, r.code AS role_code, i.status,
      (i.expires_at <= pg_catalog.clock_timestamp()) AS is_expired,
      i.expires_at, i.created_at, i.accepted_at, i.revoked_at
    FROM public.membership_invitations AS i
    JOIN public.roles AS r ON r.id = i.target_role_id
    WHERE i.tenant_id = ${context.tenant.tenantId}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ${LIST_LIMIT}
  `;
  return rows.map(toDto);
}

/* -------------------------------------------------------------------------- */
/* Revoke                                                                     */
/* -------------------------------------------------------------------------- */

export async function revokeInvitation(
  context: TenantRequestContext,
  invitationId: string,
  meta: RequestMeta,
): Promise<InvitationDto> {
  const { sql, tenant } = context;
  // RLS + explicit tenant predicate: another tenant's id is indistinguishable
  // from a nonexistent one.
  const [row] = await sql<InvitationRow[]>`
    SELECT i.id, i.email, r.code AS role_code, i.status,
      (i.expires_at <= pg_catalog.clock_timestamp()) AS is_expired,
      i.expires_at, i.created_at, i.accepted_at, i.revoked_at
    FROM public.membership_invitations AS i
    JOIN public.roles AS r ON r.id = i.target_role_id
    WHERE i.id = ${invitationId} AND i.tenant_id = ${tenant.tenantId}
    FOR UPDATE OF i
  `;
  if (!row) throw invitationError('INVITATION_NOT_FOUND');
  const role = parseRole(row.role_code);

  // Symmetric with creation: managing an owner/admin invitation needs the
  // permission that could have assigned that role.
  if (!canAssignRole(context, role)) {
    await insertAudit(sql, meta, [{
      tenantId: tenant.tenantId,
      actorType: 'user',
      actorUserId: tenant.userId,
      actorMembershipId: tenant.membershipId,
      action: 'membership.invitation_revoked',
      outcome: 'denied',
      entityType: 'membership_invitation',
      entityId: row.id,
      reasonCode: 'role_assignment_not_permitted',
      metadata: { target_role: role, required_permission: ROLE_ASSIGNMENT_PERMISSION[role] },
    }]);
    throw new InvitationRoleNotAllowedError();
  }

  if (row.status === 'revoked') return toDto(row); // idempotent, no second audit
  if (row.status === 'accepted') throw invitationError('INVITATION_ALREADY_ACCEPTED');
  if (row.status === 'expired' || row.is_expired) throw invitationError('INVITATION_EXPIRED');

  const [revoked] = await sql<InvitationRow[]>`
    UPDATE public.membership_invitations AS i
    SET status = 'revoked',
      revoked_at = pg_catalog.clock_timestamp(),
      revoked_by_membership_id = ${tenant.membershipId}
    WHERE i.id = ${row.id} AND i.tenant_id = ${tenant.tenantId} AND i.status = 'pending'
    RETURNING i.id, i.email, ${role}::text AS role_code, i.status, false AS is_expired,
      i.expires_at, i.created_at, i.accepted_at, i.revoked_at
  `;
  if (!revoked) throw new Error('INVITATION_REVOKE_RESULT_MISSING');

  await insertAudit(sql, meta, [{
    tenantId: tenant.tenantId,
    actorType: 'user',
    actorUserId: tenant.userId,
    actorMembershipId: tenant.membershipId,
    action: 'membership.invitation_revoked',
    outcome: 'success',
    entityType: 'membership_invitation',
    entityId: row.id,
    before: { status: 'pending' },
    after: { status: 'revoked' },
    metadata: { target_role: role },
  }]);
  return toDto(revoked);
}

/* -------------------------------------------------------------------------- */
/* Accept                                                                     */
/* -------------------------------------------------------------------------- */

export interface AcceptInvitationInput {
  readonly database: postgres.Sql;
  readonly identity: VerifiedIdentity;
  /** Provider profile already validated: verified PRIMARY email, canonical form. */
  readonly profile: VerifiedProfileInput;
  /** Format-validated raw token (never logged, never persisted). */
  readonly token: string;
  readonly meta: RequestMeta;
}

export interface AcceptInvitationResult {
  readonly membership: { readonly id: string; readonly tenantId: string; readonly status: 'active'; readonly roles: readonly RoleCode[] };
  readonly workshop: { readonly id: string; readonly displayName: string };
}

interface LockedInvitationRow {
  id: string;
  tenant_id: string;
  email_normalized: string;
  status: InvitationStatus;
  is_expired: boolean;
  target_role_id: string;
  role_code: string;
  invited_by_membership_id: string;
}

async function rollbackAndRelease(sql: postgres.ReservedSql): Promise<void> {
  try {
    await sql.unsafe('ROLLBACK');
  } catch {
    // Already ended (failed COMMIT).
  } finally {
    sql.release();
  }
}

/** Ends the transaction with COMMIT so a durable outcome (audit, expiry) survives, then throws. */
class CommitThenThrow extends Error {
  constructor(readonly outcome: ApiError) {
    super(outcome.code);
  }
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
  const tokenHash = hashInvitationToken(input.token);
  const proposedUserId = uuidV7();
  const membershipId = uuidV7();

  const sql = await input.database.reserve();
  try {
    await sql.unsafe('BEGIN');
    await sql`
      SELECT
        set_config('lock_timeout', '3s', true),
        set_config('statement_timeout', '10s', true),
        set_config('idle_in_transaction_session_timeout', '10s', true)
    `;

    // Local user through the existing safe JIT path (ADR-006 §7): never from
    // the request body; blocked/deleted identities come back 'disabled'.
    const [user] = await sql<{ user_id: string; user_status: 'active' | 'disabled' }[]>`
      SELECT user_id, user_status
      FROM app.bootstrap_provision_user(
        ${input.identity.identityProvider}, ${input.identity.externalSubject},
        ${proposedUserId}::uuid, ${input.profile.email}, ${input.profile.fullName}, ${input.meta.requestId}
      )
    `;
    if (!user) throw new Error('BOOTSTRAP_USER_RESULT_MISSING');
    if (user.user_status !== 'active') throw new ApiError(403, 'USER_DISABLED', 'The user is disabled.');

    // ADR-009 §7: exact hash -> (invitation, tenant). Nothing else.
    const [resolved] = await sql<{ invitation_id: string; tenant_id: string }[]>`
      SELECT invitation_id, tenant_id FROM app.bootstrap_resolve_membership_invitation(${tokenHash})
    `;
    if (!resolved) throw invitationError('INVITATION_INVALID');

    await sql`
      SELECT
        set_config('app.tenant_id', ${resolved.tenant_id}, true),
        set_config('app.user_id', ${user.user_id}, true),
        set_config('app.membership_id', '', true),
        set_config('app.request_id', ${input.meta.requestId}, true)
    `;

    // Row lock: concurrent accept / revoke of the same invitation serialize
    // here; the loser re-reads the committed row (READ COMMITTED).
    const [invitation] = await sql<LockedInvitationRow[]>`
      SELECT i.id, i.tenant_id, i.email_normalized, i.status,
        (i.expires_at <= pg_catalog.clock_timestamp()) AS is_expired,
        i.target_role_id, r.code AS role_code, i.invited_by_membership_id
      FROM public.membership_invitations AS i
      JOIN public.roles AS r ON r.id = i.target_role_id
      WHERE i.id = ${resolved.invitation_id}
        AND i.tenant_id = ${resolved.tenant_id}
        AND i.token_hash = ${tokenHash}
      FOR UPDATE OF i
    `;
    if (!invitation) throw invitationError('INVITATION_INVALID');
    const role = parseRole(invitation.role_code);

    // Exact comparison of canonical forms; no fuzzy matching. Checked before
    // any status is revealed. The denied attempt is audited and committed.
    if (invitation.email_normalized !== input.profile.email) {
      await insertAudit(sql, input.meta, [{
        tenantId: invitation.tenant_id,
        actorType: 'user',
        actorUserId: user.user_id,
        actorMembershipId: null,
        action: 'membership.invitation_accepted',
        outcome: 'denied',
        entityType: 'membership_invitation',
        entityId: invitation.id,
        reasonCode: 'invitation_email_mismatch',
      }]);
      throw new CommitThenThrow(invitationError('INVITATION_EMAIL_MISMATCH'));
    }

    if (invitation.status === 'accepted') throw invitationError('INVITATION_ALREADY_ACCEPTED');
    if (invitation.status === 'revoked') throw invitationError('INVITATION_REVOKED');
    if (invitation.status === 'expired') throw invitationError('INVITATION_EXPIRED');
    if (invitation.is_expired) {
      // PostgreSQL clock is the authority; materialize the real transition.
      await sql`
        UPDATE public.membership_invitations
        SET status = 'expired'
        WHERE id = ${invitation.id} AND tenant_id = ${invitation.tenant_id} AND status = 'pending'
      `;
      await insertAudit(sql, input.meta, [{
        tenantId: invitation.tenant_id,
        actorType: 'system',
        actorUserId: null,
        actorMembershipId: null,
        action: 'membership.invitation_expired',
        outcome: 'success',
        entityType: 'membership_invitation',
        entityId: invitation.id,
        before: { status: 'pending' },
        after: { status: 'expired' },
        metadata: { materialized_by: 'invitation_accept', target_role: role },
      }]);
      throw new CommitThenThrow(invitationError('INVITATION_EXPIRED'));
    }

    // Any existing membership (active, suspended or revoked) blocks: no
    // duplicate row (UNIQUE(tenant_id,user_id)) and no undocumented
    // reactivation. The invitation stays pending (rolled back).
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM public.memberships
      WHERE tenant_id = ${invitation.tenant_id} AND user_id = ${user.user_id}
      FOR UPDATE
    `;
    if (existing) throw invitationError('MEMBERSHIP_ALREADY_EXISTS');

    const [workshop] = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM public.workshops WHERE id = ${invitation.tenant_id}
    `;
    if (!workshop) throw new Error('INVITATION_WORKSHOP_NOT_VISIBLE');

    await sql`
      INSERT INTO public.memberships (id, tenant_id, user_id, status)
      VALUES (${membershipId}, ${invitation.tenant_id}, ${user.user_id}, 'active')
    `;
    await sql`
      INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      VALUES (${invitation.tenant_id}, ${membershipId}, ${invitation.target_role_id}, ${invitation.invited_by_membership_id})
    `;
    await sql`SELECT set_config('app.membership_id', ${membershipId}, true)`;

    // The lifecycle trigger re-checks expiry and membership/role coherence.
    const accepted = await sql`
      UPDATE public.membership_invitations
      SET status = 'accepted',
        accepted_at = pg_catalog.clock_timestamp(),
        accepted_by_user_id = ${user.user_id},
        accepted_membership_id = ${membershipId}
      WHERE id = ${invitation.id} AND tenant_id = ${invitation.tenant_id} AND status = 'pending'
    `;
    if (accepted.count !== 1) throw new Error('INVITATION_ACCEPT_RESULT_MISSING');

    const actor = {
      tenantId: invitation.tenant_id,
      actorType: 'user' as const,
      actorUserId: user.user_id,
      actorMembershipId: membershipId,
      outcome: 'success' as const,
    };
    await insertAudit(sql, input.meta, [
      {
        ...actor,
        action: 'membership.invitation_accepted',
        entityType: 'membership_invitation',
        entityId: invitation.id,
        before: { status: 'pending' },
        after: { status: 'accepted', accepted_membership_id: membershipId },
      },
      {
        ...actor,
        action: 'membership.activated',
        entityType: 'membership',
        entityId: membershipId,
        after: { status: 'active', user_id: user.user_id },
        metadata: { invitation_id: invitation.id },
      },
      {
        ...actor,
        action: 'role.assigned',
        entityType: 'membership_role',
        entityId: membershipId,
        before: { roles: [] },
        after: { roles: [role] },
        metadata: { assigned_by_membership_id: invitation.invited_by_membership_id, invitation_id: invitation.id },
      },
    ]);

    await sql.unsafe('COMMIT');
    sql.release();
    return {
      membership: { id: membershipId, tenantId: invitation.tenant_id, status: 'active', roles: [role] },
      workshop: { id: workshop.id, displayName: workshop.display_name },
    };
  } catch (error) {
    if (error instanceof CommitThenThrow) {
      try {
        await sql.unsafe('COMMIT');
      } catch {
        await rollbackAndRelease(sql);
        throw new Error('INVITATION_OUTCOME_COMMIT_FAILED');
      }
      sql.release();
      throw error.outcome;
    }
    await rollbackAndRelease(sql);
    if (isDatabaseError(error, '23514', 'mi_accept_after_deadline')) throw invitationError('INVITATION_EXPIRED');
    if (isDatabaseError(error, '23505', 'memberships_tenant_user_key')) throw invitationError('MEMBERSHIP_ALREADY_EXISTS');
    if (isDatabaseError(error, '55P03')) throw invitationError('INVITATION_IN_PROGRESS');
    throw error;
  }
}
