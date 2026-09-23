/**
 * PostgreSQL primitives for S1-02 TenantContext.
 *
 * Canonical sources: ADR-009 §3 (transaction-local `app.*` GUCs), §7 case 1
 * (bootstrap: list the verified user's active memberships and validate the
 * chosen tenant), §8 (SECURITY DEFINER hardening); RBAC matrix §1/§18
 * (JWT → local user → active membership → roles → permissions → scope).
 *
 * Authority chain implemented here (PostgreSQL only — no network, no Fastify):
 *
 *   verified external identity          (IdentityProvider, ADR-006 — input)
 *     → discoverActiveMemberships       app.bootstrap_list_active_memberships
 *     → application selection           (TypeScript core — not here)
 *     → BEGIN                           (caller)
 *     → validateActiveMembership        app.bootstrap_validate_active_membership
 *     → bindTenantContext               set_config('app.*', ..., true)
 *     → loadMembershipAuthorization     memberships ⋈ membership_roles ⋈ roles
 *                                       ⋈ role_permissions ⋈ permissions (RLS)
 *     → tenant-owned queries            ENABLE/FORCE RLS as NOBYPASSRLS runtime
 *     → COMMIT / ROLLBACK               (caller)
 *
 * Clerk is identity authority only. Roles, permissions and resource scopes
 * are read from PostgreSQL rows on every call; nothing here derives them from
 * JWT claims, provider metadata, headers, bodies or RBAC_MATRIX_V1.
 *
 * Connection/transaction contract. No helper reserves a connection, opens a
 * transaction or ends one. The caller owns reserve → BEGIN → COMMIT/ROLLBACK →
 * release and passes the SAME client (a `ReservedSql` inside an explicit
 * BEGIN, or the `TransactionSql` of `sql.begin`) to validate, bind, load and
 * the handler's queries. This is enforced, not just documented:
 *   - validate records (pg_backend_pid, transaction_timestamp) of the
 *     transaction it ran in; bind refuses to set the GUCs unless its own
 *     statement runs on that same backend and transaction, and load refuses
 *     unless it runs in the transaction bind ran in. Autocommit statements,
 *     a BEGIN issued after validation, a pooled client that hops backends,
 *     or a load after COMMIT all fail with TENANT_CONTEXT_TRANSACTION_MISMATCH.
 *   - the validated/bound objects are only minted by this module (runtime
 *     registry, not just a type brand) and are tied to the client object they
 *     were produced on.
 * Discovery is a pre-transaction candidate list and is never authorization
 * proof: a candidate must be revalidated inside the request transaction.
 */

import type postgres from 'postgres';
import { RESOURCE_SCOPES, type ResourceScope } from '../authz/rbac-matrix.js';
import type { VerifiedIdentity } from '../identity/identity-provider.js';

/**
 * Any caller-owned postgres.js client: a `ReservedSql` (explicit BEGIN), the
 * `TransactionSql` handed to `sql.begin`, or — for discovery only — the pool.
 */
export type TenantDbClient = postgres.ISql;

export const TENANT_ACCESS_DENIED = 'TENANT_ACCESS_DENIED';

/**
 * The single fail-closed result for revalidation and authorization loading.
 * Unknown, other user's, other tenant's, suspended and revoked memberships
 * (and a disabled user) are indistinguishable here by design; the future HTTP
 * layer maps this to TENANT_ACCESS_DENIED without an enumeration oracle.
 */
export interface TenantAccessDenied {
  readonly ok: false;
  readonly code: typeof TENANT_ACCESS_DENIED;
}

const DENIED: TenantAccessDenied = Object.freeze({ ok: false, code: TENANT_ACCESS_DENIED });

/** Internal contract violations. They carry no HTTP status and no row data. */
export type TenantContextDbErrorCode =
  | 'TENANT_CONTEXT_ARGUMENT_INVALID'
  | 'TENANT_CONTEXT_NOT_VALIDATED'
  | 'TENANT_CONTEXT_NOT_BOUND'
  | 'TENANT_CONTEXT_CLIENT_MISMATCH'
  | 'TENANT_CONTEXT_TRANSACTION_MISMATCH'
  | 'TENANT_CONTEXT_ALREADY_BOUND'
  | 'TENANT_CONTEXT_BIND_FAILED'
  | 'AUTHORIZATION_DATA_INVALID';

export class TenantContextDbError extends Error {
  readonly code: TenantContextDbErrorCode;

  constructor(code: TenantContextDbErrorCode) {
    super(code);
    this.name = 'TenantContextDbError';
    this.code = code;
  }
}

/** Minimal discovery row. `userId` is the verified caller's own `users.id`. */
export interface MembershipCandidate {
  readonly userId: string;
  readonly membershipId: string;
  readonly tenantId: string;
}

declare const validatedBrand: unique symbol;
declare const boundBrand: unique symbol;

/** Only `validateActiveMembership` produces this; required by `bindTenantContext`. */
export interface ValidatedMembership extends MembershipCandidate {
  readonly [validatedBrand]: true;
}

/** Only `bindTenantContext` produces this; required by `loadMembershipAuthorization`. */
export interface BoundTenantContext extends MembershipCandidate {
  readonly requestId: string;
  readonly [boundBrand]: true;
}

export type MembershipValidationResult =
  | { readonly ok: true; readonly membership: ValidatedMembership }
  | TenantAccessDenied;

/**
 * One raw `role_permissions` cell reached through an assigned role. Rows are
 * NOT combined here: the same permission may appear once per role with
 * different scopes, and the TypeScript core applies tenant dominance and the
 * assigned ∪ quality_control union.
 */
export interface AuthorizationGrantRow {
  readonly roleCode: string;
  readonly permissionCode: string;
  readonly resourceScope: ResourceScope;
}

export type MembershipAuthorizationResult =
  | {
    readonly ok: true;
    readonly membershipId: string;
    /** Distinct role codes assigned to the membership, byte-order sorted. */
    readonly roles: readonly string[];
    /** Ordered by (permission_code, role_code, resource_scope), COLLATE "C". */
    readonly grants: readonly AuthorizationGrantRow[];
  }
  | TenantAccessDenied;

interface TransactionProof {
  readonly client: TenantDbClient;
  readonly backendPid: number;
  readonly transactionMarker: string;
}

const validatedMemberships = new WeakMap<object, TransactionProof>();
const boundContexts = new WeakMap<object, TransactionProof>();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST_ID_LENGTH = 128;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Same bounds as the protected hook in api/app.ts and users.* column widths. */
function assertVerifiedIdentity(identity: VerifiedIdentity): void {
  if (!identity
    || typeof identity.identityProvider !== 'string'
    || identity.identityProvider.length === 0
    || identity.identityProvider.length > 32
    || typeof identity.externalSubject !== 'string'
    || identity.externalSubject.length === 0
    || identity.externalSubject.length > 255) {
    throw new TenantContextDbError('TENANT_CONTEXT_ARGUMENT_INVALID');
  }
}

function requireProof(
  registry: WeakMap<object, TransactionProof>,
  value: object,
  sql: TenantDbClient,
  missing: TenantContextDbErrorCode,
): TransactionProof {
  const proof = typeof value === 'object' && value !== null ? registry.get(value) : undefined;
  if (!proof) throw new TenantContextDbError(missing);
  if (proof.client !== sql) throw new TenantContextDbError('TENANT_CONTEXT_CLIENT_MISMATCH');
  return proof;
}

interface DiscoveryRow {
  user_id: string;
  membership_id: string;
  tenant_id: string;
}

/**
 * Lists the verified identity's ACTIVE memberships (active user + active
 * membership) through the ADR-009 bootstrap function — the only pre-tenant
 * read path; runtime has no SELECT on `users` and memberships are under RLS.
 * Returns only (userId, membershipId, tenantId), one row per tenant, ordered
 * by (tenant_id, membership_id). Never returns another user's memberships.
 *
 * May run on the pool before BEGIN. The result is a candidate list for
 * selection, not authorization proof.
 */
export async function discoverActiveMemberships(
  sql: TenantDbClient,
  identity: VerifiedIdentity,
): Promise<readonly MembershipCandidate[]> {
  assertVerifiedIdentity(identity);

  const rows = await sql<DiscoveryRow[]>`
    SELECT d.user_id, d.membership_id, d.tenant_id
    FROM app.bootstrap_list_active_memberships(
      ${identity.identityProvider},
      ${identity.externalSubject}
    ) AS d
    ORDER BY d.tenant_id, d.membership_id
  `;

  // UNIQUE(identity_provider, external_subject) and UNIQUE(tenant_id, user_id)
  // make anything else impossible; if it happens, fail closed.
  const tenants = new Set<string>();
  for (const row of rows) {
    if (row.user_id !== rows[0].user_id || tenants.has(row.tenant_id)) {
      throw new TenantContextDbError('AUTHORIZATION_DATA_INVALID');
    }
    tenants.add(row.tenant_id);
  }

  return Object.freeze(rows.map((row) => Object.freeze({
    userId: row.user_id,
    membershipId: row.membership_id,
    tenantId: row.tenant_id,
  })));
}

interface ValidationRow extends DiscoveryRow {
  backend_pid: number;
  transaction_marker: string;
}

/**
 * Revalidates a selected candidate INSIDE the request transaction, with a
 * fresh READ COMMITTED snapshot. Valid only if the verified identity maps to
 * an active user AND the membership exists, belongs to that user and to the
 * given tenant, and is active. Everything else — including malformed ids —
 * returns the same frozen TENANT_ACCESS_DENIED value.
 */
export async function validateActiveMembership(
  sql: TenantDbClient,
  identity: VerifiedIdentity,
  candidate: MembershipCandidate,
): Promise<MembershipValidationResult> {
  assertVerifiedIdentity(identity);
  if (!candidate
    || !isUuid(candidate.userId)
    || !isUuid(candidate.membershipId)
    || !isUuid(candidate.tenantId)) {
    return DENIED;
  }

  const rows = await sql<ValidationRow[]>`
    SELECT
      v.user_id,
      v.membership_id,
      v.tenant_id,
      pg_catalog.pg_backend_pid() AS backend_pid,
      ((EXTRACT(EPOCH FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text AS transaction_marker
    FROM app.bootstrap_validate_active_membership(
      ${identity.identityProvider},
      ${identity.externalSubject},
      ${candidate.tenantId}::uuid
    ) AS v
    WHERE v.membership_id = ${candidate.membershipId}::uuid
      AND v.user_id = ${candidate.userId}::uuid
  `;
  if (rows.length !== 1) return DENIED;

  const row = rows[0];
  const membership = Object.freeze({
    userId: row.user_id,
    membershipId: row.membership_id,
    tenantId: row.tenant_id,
  }) as ValidatedMembership;
  validatedMemberships.set(membership, {
    client: sql,
    backendPid: row.backend_pid,
    transactionMarker: row.transaction_marker,
  });
  return Object.freeze({ ok: true as const, membership });
}

interface BindRow {
  backend_pid: number;
  transaction_marker: string;
  same_transaction: boolean;
  context_compatible: boolean;
  tenant_id: string | null;
  user_id: string | null;
  membership_id: string | null;
  request_id: string | null;
}

/**
 * Binds the canonical ADR-009 GUCs — app.tenant_id, app.user_id,
 * app.membership_id, app.request_id — with set_config(..., true), i.e.
 * transaction-local: they vanish at COMMIT/ROLLBACK and cannot follow a
 * pooled connection into the next request. The tenant is taken only from a
 * membership validated in this same transaction; there is no way to bind an
 * arbitrary tenant id.
 *
 * The GUCs are only written when the statement runs in the validation's
 * transaction and no different context is already bound (re-binding the
 * identical context is a no-op). The checks and the writes are one statement.
 */
export async function bindTenantContext(
  sql: TenantDbClient,
  membership: ValidatedMembership,
  options: { readonly requestId: string },
): Promise<BoundTenantContext> {
  const proof = requireProof(validatedMemberships, membership, sql, 'TENANT_CONTEXT_NOT_VALIDATED');
  const requestId = options?.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TenantContextDbError('TENANT_CONTEXT_ARGUMENT_INVALID');
  }

  // OFFSET 0 keeps the guard subquery from being flattened, so both flags are
  // computed once, before any CASE branch calls set_config.
  const [row] = await sql<BindRow[]>`
    SELECT
      s.backend_pid,
      s.transaction_marker,
      s.same_transaction,
      s.context_compatible,
      CASE WHEN s.same_transaction AND s.context_compatible
        THEN pg_catalog.set_config('app.tenant_id', ${membership.tenantId}, true) END AS tenant_id,
      CASE WHEN s.same_transaction AND s.context_compatible
        THEN pg_catalog.set_config('app.user_id', ${membership.userId}, true) END AS user_id,
      CASE WHEN s.same_transaction AND s.context_compatible
        THEN pg_catalog.set_config('app.membership_id', ${membership.membershipId}, true) END AS membership_id,
      CASE WHEN s.same_transaction AND s.context_compatible
        THEN pg_catalog.set_config('app.request_id', ${requestId}, true) END AS request_id
    FROM (
      SELECT
        pg_catalog.pg_backend_pid() AS backend_pid,
        ((EXTRACT(EPOCH FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text AS transaction_marker,
        (
          pg_catalog.pg_backend_pid() = ${proof.backendPid}::int4
          AND ((EXTRACT(EPOCH FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text = ${proof.transactionMarker}
        ) AS same_transaction,
        (
          COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') IN ('', ${membership.tenantId})
          AND COALESCE(pg_catalog.current_setting('app.user_id', true), '') IN ('', ${membership.userId})
          AND COALESCE(pg_catalog.current_setting('app.membership_id', true), '') IN ('', ${membership.membershipId})
          AND COALESCE(pg_catalog.current_setting('app.request_id', true), '') IN ('', ${requestId})
        ) AS context_compatible
      OFFSET 0
    ) AS s
  `;

  if (!row || row.same_transaction !== true) {
    throw new TenantContextDbError('TENANT_CONTEXT_TRANSACTION_MISMATCH');
  }
  if (row.context_compatible !== true) {
    throw new TenantContextDbError('TENANT_CONTEXT_ALREADY_BOUND');
  }
  if (row.tenant_id !== membership.tenantId
    || row.user_id !== membership.userId
    || row.membership_id !== membership.membershipId
    || row.request_id !== requestId) {
    throw new TenantContextDbError('TENANT_CONTEXT_BIND_FAILED');
  }

  const context = Object.freeze({
    tenantId: membership.tenantId,
    userId: membership.userId,
    membershipId: membership.membershipId,
    requestId,
  }) as BoundTenantContext;
  boundContexts.set(context, proof);
  return context;
}

interface AuthorizationRow {
  backend_pid: number;
  transaction_marker: string;
  membership_id: string | null;
  role_code: string | null;
  permission_code: string | null;
  resource_scope: string | null;
}

/**
 * Loads raw (role_code, permission_code, resource_scope) rows for the bound
 * membership, as `tallermecario_api` under normal RLS, in one statement.
 *
 * Trust boundary: the loader does not rely on the caller having validated.
 * The same statement re-requires that the membership row is visible under the
 * bound tenant (RLS + explicit app.current_tenant_id()), matches the bound
 * app.membership_id / app.user_id GUCs and is still `active` at this
 * statement's snapshot. A membership suspended/revoked after validation, a
 * tampered GUC, or a context from another transaction yields DENIED/throws —
 * never another membership's grants. `users.status` is not re-read here
 * (runtime cannot read `users`); it was checked by validation in this same
 * transaction.
 */
export async function loadMembershipAuthorization(
  sql: TenantDbClient,
  context: BoundTenantContext,
): Promise<MembershipAuthorizationResult> {
  const proof = requireProof(boundContexts, context, sql, 'TENANT_CONTEXT_NOT_BOUND');

  // The anchor row always comes back, so the transaction check runs even when
  // the membership is no longer visible/active.
  const rows = await sql<AuthorizationRow[]>`
    SELECT
      pg_catalog.pg_backend_pid() AS backend_pid,
      ((EXTRACT(EPOCH FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text AS transaction_marker,
      g.membership_id,
      g.role_code,
      g.permission_code,
      g.resource_scope
    FROM (SELECT 1) AS anchor
    LEFT JOIN (
      SELECT
        m.id AS membership_id,
        r.code AS role_code,
        p.code AS permission_code,
        rp.resource_scope
      FROM public.memberships AS m
      LEFT JOIN public.membership_roles AS mr
        ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
      LEFT JOIN public.roles AS r ON r.id = mr.role_id
      LEFT JOIN public.role_permissions AS rp ON rp.role_id = r.id
      LEFT JOIN public.permissions AS p ON p.id = rp.permission_id
      WHERE m.id = ${context.membershipId}::uuid
        AND m.tenant_id = ${context.tenantId}::uuid
        AND m.user_id = ${context.userId}::uuid
        AND m.status = 'active'
        AND m.tenant_id = app.current_tenant_id()
        AND m.id = NULLIF(pg_catalog.current_setting('app.membership_id', true), '')::uuid
        AND m.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
    ) AS g ON true
    ORDER BY
      g.permission_code COLLATE "C",
      g.role_code COLLATE "C",
      g.resource_scope COLLATE "C"
  `;

  const anchor = rows[0];
  if (!anchor
    || anchor.backend_pid !== proof.backendPid
    || anchor.transaction_marker !== proof.transactionMarker) {
    throw new TenantContextDbError('TENANT_CONTEXT_TRANSACTION_MISMATCH');
  }
  if (anchor.membership_id === null) return DENIED;

  const roles = new Set<string>();
  const grants: AuthorizationGrantRow[] = [];
  for (const row of rows) {
    if (row.membership_id !== context.membershipId) {
      throw new TenantContextDbError('AUTHORIZATION_DATA_INVALID');
    }
    if (row.role_code === null) {
      // Membership without any role: the only legal shape is a single row.
      if (rows.length !== 1 || row.permission_code !== null || row.resource_scope !== null) {
        throw new TenantContextDbError('AUTHORIZATION_DATA_INVALID');
      }
      continue;
    }
    roles.add(row.role_code);
    if (row.permission_code === null) {
      // Role with no permission rows (not seeded today); contributes nothing.
      if (row.resource_scope !== null) throw new TenantContextDbError('AUTHORIZATION_DATA_INVALID');
      continue;
    }
    if (!(RESOURCE_SCOPES as readonly string[]).includes(row.resource_scope ?? '')) {
      throw new TenantContextDbError('AUTHORIZATION_DATA_INVALID');
    }
    grants.push(Object.freeze({
      roleCode: row.role_code,
      permissionCode: row.permission_code,
      resourceScope: row.resource_scope as ResourceScope,
    }));
  }

  return Object.freeze({
    ok: true as const,
    membershipId: context.membershipId,
    roles: Object.freeze([...roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    grants: Object.freeze(grants),
  });
}
