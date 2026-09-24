'use strict';

/**
 * S1-04 test harness, layered on the S1-03 identity harness (which MUST load
 * first: it installs the hermetic fetch trap before any compiled module).
 *
 * Authentication goes through the REAL ClerkIdentityProvider (per-run RS256
 * keys, networkless JWT verification) with a fake Backend Users API, so the
 * verified-PRIMARY-email rule is exercised exactly as in production.
 */

const h = require('../identity/helpers.cjs');
const { randomBytes, randomUUID } = require('node:crypto');

const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerInvitationRoutes, registerInvitationAcceptRoute } = h.load('invitations/routes.js');
const token = h.load('invitations/token.js');
const worker = h.load('worker/outbox-worker.js');
const email = h.load('invitations/email.js');

const tokenKey = token.createInvitationTokenKey(randomBytes(32));
const clerkUsers = new h.FakeClerkUsers();
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: clerkUsers });
const apiPool = h.runtimePool('api', 8);
const workerPool = h.runtimePool('worker', 4);
const BIG_LIMIT = { max: 100_000, timeWindow: '1 minute' };
const EMAIL_EVENT = email.INVITATION_EMAIL_EVENT_TYPE;

async function buildTestApp() {
  return buildApi({
    database: apiPool,
    identityProvider: provider,
    rateLimit: BIG_LIMIT,
    registerIdentityOnlyRoutes(server) {
      registerInvitationAcceptRoute(server, { database: apiPool, rateLimit: BIG_LIMIT });
    },
    registerRoutes(server) {
      registerInvitationRoutes(server, { tokenKey, rateLimit: BIG_LIMIT });
      server.get('/api/v1/__s104/whoami', { config: { permission: 'workshop.read' } }, async (request) => {
        const context = getTenantRequestContext(request);
        return {
          tenantId: context.tenant.tenantId,
          membershipId: context.tenant.membershipId,
          roles: [...context.tenant.roles],
          canInvite: context.tenant.permissions.has('memberships.invite_staff'),
        };
      });
    },
  });
}

const uniqueEmail = (label) => `${label}-${randomUUID().slice(0, 8)}@invite.test`;

/** A Clerk identity that also exists locally (tenant members). */
async function member(label, options = {}) {
  const subject = h.newSubject(label);
  const address = options.email ?? uniqueEmail(label);
  clerkUsers.put(h.clerkUser(subject, { email: address }));
  const user = await h.createUser({ subject, email: address });
  return { subject, user, email: address };
}

/** A Clerk identity with NO local users row yet (acceptance must JIT it). */
function invitee(label, options = {}) {
  const subject = h.newSubject(label);
  const address = options.email ?? uniqueEmail(label);
  clerkUsers.put(h.clerkUser(subject, { ...options, email: address }));
  return { subject, email: address };
}

/** Owner/admin/advisor/technician tenant + a second, unrelated tenant. */
async function twoTenants() {
  const owner = await member('owner');
  const admin = await member('admin');
  const advisor = await member('advisor');
  const technician = await member('tech');
  const a = await h.createWorkshop([
    { user: owner.user, roles: ['owner'] },
    { user: admin.user, roles: ['admin'] },
    { user: advisor.user, roles: ['service_advisor'] },
    { user: technician.user, roles: ['technician'] },
  ]);
  const ownerB = await member('ownerb');
  const b = await h.createWorkshop([{ user: ownerB.user, roles: ['owner'] }]);
  return {
    a: { tenantId: a.tenantId, owner: { ...owner, membershipId: a.memberships[0] }, admin: { ...admin, membershipId: a.memberships[1] }, advisor: { ...advisor, membershipId: a.memberships[2] }, technician: { ...technician, membershipId: a.memberships[3] } },
    b: { tenantId: b.tenantId, owner: { ...ownerB, membershipId: b.memberships[0] } },
  };
}

async function call(app, { subject, method = 'GET', url, body, tenantId, headers = {}, rawBody }) {
  const requestHeaders = { ...headers };
  if (subject) requestHeaders.authorization = `Bearer ${h.sessionToken(subject)}`;
  if (tenantId) requestHeaders['x-tenant-id'] = tenantId;
  if (body !== undefined || rawBody !== undefined) requestHeaders['content-type'] ??= 'application/json';
  const response = await app.inject({
    method,
    url,
    headers: requestHeaders,
    payload: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let json = null;
  try { json = response.json(); } catch { json = null; }
  return { status: response.statusCode, json, body: response.body, headers: response.headers };
}

const createInvitation = (app, actor, tenantId, body) => call(app, {
  subject: actor.subject, method: 'POST', url: '/api/v1/membership-invitations', body, tenantId,
});
const acceptInvitation = (app, identity, rawToken) => call(app, {
  subject: identity.subject, method: 'POST', url: '/api/v1/membership-invitations/accept', body: { token: rawToken },
});
const revokeInvitation = (app, actor, tenantId, invitationId) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/membership-invitations/${invitationId}/revoke`, tenantId,
});

/** The raw token exactly as the worker will derive it from the outbox nonce. */
async function tokenFromOutbox(invitationId) {
  const [row] = await h.admin`
    SELECT payload_json FROM public.outbox_events
    WHERE aggregate_id = ${invitationId} AND event_type = ${EMAIL_EVENT}
  `;
  if (!row) throw new Error('OUTBOX_EVENT_NOT_FOUND');
  const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
  return token.deriveInvitationToken(tokenKey, invitationId, payload.token_nonce);
}

/**
 * Invitation written directly (triggers off) for states the API cannot reach
 * on demand (e.g. already past expires_at). CHECK constraints still apply.
 */
async function seedInvitation({ tenantId, email: address, role = 'technician', invitedBy, createdAt, expiresAt, withOutbox = false }) {
  const id = randomUUID();
  const nonce = token.newInvitationTokenNonce();
  const raw = token.deriveInvitationToken(tokenKey, id, nonce);
  const roleId = await h.roleId(role);
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.membership_invitations ${tx({
      id, tenant_id: tenantId, email: address, email_normalized: address.toLowerCase(), target_role_id: roleId,
      token_hash: token.hashInvitationToken(raw), status: 'pending', expires_at: expiresAt,
      invited_by_membership_id: invitedBy, created_at: createdAt ?? new Date(Date.now() - 8 * 86_400_000),
    })}`;
    if (withOutbox) {
      await tx`INSERT INTO public.outbox_events ${tx({
        id: randomUUID(), tenant_id: tenantId, aggregate_type: 'membership_invitation', aggregate_id: id,
        event_type: EMAIL_EVENT, event_version: 1,
        payload_json: tx.json({ invitation_id: id, token_nonce: nonce, token_key_version: tokenKey.version }),
        idempotency_key: id,
      })}`;
    }
  });
  return { id, token: raw, nonce };
}

async function invitationRow(id) {
  const [row] = await h.admin`SELECT * FROM public.membership_invitations WHERE id = ${id}`;
  return row;
}

async function membershipsOf(tenantId, userId) {
  return h.admin`
    SELECT m.id, m.status, array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL) AS roles
    FROM public.memberships m
    LEFT JOIN public.membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
    LEFT JOIN public.roles r ON r.id = mr.role_id
    WHERE m.tenant_id = ${tenantId} AND m.user_id = ${userId}
    GROUP BY m.id, m.status
  `;
}

async function localUserId(subject) {
  const [row] = await h.admin`SELECT id FROM public.users WHERE identity_provider = 'clerk' AND external_subject = ${subject}`;
  return row?.id ?? null;
}

async function auditsFor(entityId) {
  return h.admin`
    SELECT action, outcome, actor_type, actor_user_id, actor_membership_id, entity_type, entity_id,
      reason_code, before_json, after_json, metadata_json, request_id
    FROM public.audit_logs WHERE entity_id = ${entityId} ORDER BY created_at, id
  `;
}

/** Test-only failing trigger (admin DDL), removed by the returned function. */
async function injectFailure(table, whenSql = 'true') {
  const name = `s104_fail_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await h.admin.unsafe(`
    CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF ${whenSql} THEN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${name} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}();
  `);
  return async () => {
    await h.admin.unsafe(`DROP TRIGGER IF EXISTS ${name} ON public.${table}; DROP FUNCTION IF EXISTS public.${name}();`);
  };
}

/** Holds a row lock on an invitation from an admin transaction. */
async function holdInvitationLock(invitationId) {
  const conn = await h.admin.reserve();
  await conn.unsafe('BEGIN');
  await conn`SELECT id FROM public.membership_invitations WHERE id = ${invitationId} FOR UPDATE`;
  return {
    async release() {
      try { await conn.unsafe('COMMIT'); } finally { conn.release(); }
    },
  };
}

/** Waits until `count` backends are blocked on a lock (proves real interleaving). */
async function waitForLockWaiters(count, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'
    `;
    if (row.n >= count) return;
    if (Date.now() > deadline) throw new Error(`LOCK_WAITERS_NOT_REACHED ${row.n}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

module.exports = {
  ...h,
  token,
  worker,
  email,
  tokenKey,
  clerkUsers,
  apiPool,
  workerPool,
  EMAIL_EVENT,
  buildTestApp,
  uniqueEmail,
  member,
  invitee,
  twoTenants,
  call,
  createInvitation,
  acceptInvitation,
  revokeInvitation,
  tokenFromOutbox,
  seedInvitation,
  invitationRow,
  membershipsOf,
  localUserId,
  auditsFor,
  injectFailure,
  holdInvitationLock,
  waitForLockWaiters,
};
