'use strict';

/**
 * S1-06 test harness, layered on the S1-05 harness (itself on the S1-03 one,
 * which installs the hermetic fetch trap before any compiled module loads).
 * Real ClerkIdentityProvider (per-run RS256 keys), real PostgreSQL through the
 * NOBYPASSRLS api/worker runtime logins (ADR-009). The app registers BOTH the
 * S1-05 role routes and the S1-06 lifecycle routes, so status/role races go
 * through the production handlers.
 */

const h = require('../member-roles/helpers.cjs');
const { randomUUID } = require('node:crypto');

const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerMemberRoleRoutes } = h.load('memberships/roles-routes.js');
const { registerMemberLifecycleRoutes } = h.load('memberships/lifecycle-routes.js');
const { createMembershipRevocationHandler, MEMBERSHIP_REVOCATION_EVENT_TYPE } = h.load('identity/sync/membership-revocation.js');

const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const BIG_LIMIT = { max: 100_000, timeWindow: '1 minute' };

async function buildTestApp() {
  return buildApi({
    database: h.apiPool,
    identityProvider: provider,
    rateLimit: BIG_LIMIT,
    registerRoutes(server) {
      registerMemberRoleRoutes(server, { rateLimit: BIG_LIMIT });
      registerMemberLifecycleRoutes(server, { rateLimit: BIG_LIMIT });
      server.get('/api/v1/__s106/whoami', { config: { permission: 'workshop.read' } }, async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId, membershipId: context.tenant.membershipId };
      });
    },
  });
}

const listMembers = (app, actor, tenantId, extra = {}) => h.call(app, {
  subject: actor.subject, url: '/api/v1/memberships', tenantId, ...extra,
});
const getMember = (app, actor, tenantId, membershipId, extra = {}) => h.call(app, {
  subject: actor.subject, url: `/api/v1/memberships/${membershipId}`, tenantId, ...extra,
});
const command = (name) => (app, actor, tenantId, membershipId, extra = {}) => h.call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/memberships/${membershipId}/${name}`, tenantId, ...extra,
});
const suspend = command('suspend');
const revoke = command('revoke');
const whoami = (app, actor, tenantId) => h.call(app, { subject: actor.subject, url: '/api/v1/__s106/whoami', tenantId });

async function membershipRow(membershipId) {
  const [row] = await h.admin`
    SELECT id, tenant_id, user_id, status, joined_at, suspended_at, revoked_at, created_at
    FROM public.memberships WHERE id = ${membershipId}
  `;
  return row ? { ...row } : null;
}

async function userStatus(userId) {
  const [row] = await h.admin`SELECT status FROM public.users WHERE id = ${userId}`;
  return row?.status ?? null;
}

async function lifecycleAudits(entityId) {
  const rows = await h.admin`
    SELECT action, outcome, tenant_id, actor_type, actor_user_id, actor_membership_id, entity_type, entity_id,
      reason_code, before_json, after_json, metadata_json, request_id, user_agent, ip_address
    FROM public.audit_logs
    WHERE entity_id = ${entityId} AND action IN ('membership.suspended', 'membership.revoked', 'membership.activated')
    ORDER BY created_at, id
  `;
  return rows.map((row) => ({ ...row }));
}

async function tenantLifecycleAudits(tenantId) {
  const rows = await h.admin`
    SELECT action, outcome, entity_id, reason_code, actor_type FROM public.audit_logs
    WHERE tenant_id = ${tenantId} AND action IN ('membership.suspended', 'membership.revoked', 'membership.activated')
  `;
  return rows.map((row) => ({ ...row }));
}

/**
 * Backends of this database waiting on any lock (pg_locks not granted): the
 * owner gate (relation), a workshop/membership row (transactionid/tuple).
 */
async function waitForWaiters(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`
      SELECT count(DISTINCT l.pid)::int AS n FROM pg_catalog.pg_locks AS l
      JOIN pg_catalog.pg_stat_activity AS a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = pg_catalog.current_database()
    `;
    if (row.n >= count) return;
    if (Date.now() > deadline) throw new Error(`LOCK_WAITERS_NOT_REACHED ${row.n}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Starts `runs` in a FORCED queue order behind the tenant owner-set barrier:
 * run i is parked on the lock before run i+1 starts. Returns the results in
 * the same order.
 */
async function forcedOrder(tenantId, runs) {
  const barrier = await h.holdTenantRoleLock(tenantId);
  const pending = [];
  try {
    for (const [index, run] of runs.entries()) {
      pending.push(run());
      await waitForWaiters(index + 1);
    }
  } finally {
    await barrier.release();
  }
  return Promise.all(pending);
}

/**
 * Opens a privileged (superuser) transaction that performs `fn` and keeps it
 * open. Its UPDATE/DELETE on memberships / membership_roles takes the owner
 * gate in ACCESS EXCLUSIVE (0013), so every runtime command of every tenant
 * parks on the gate until commit(): used to change state "while a request waits".
 */
async function openPrivileged(fn) {
  const conn = await h.admin.reserve();
  await conn.unsafe('BEGIN');
  try {
    await fn(conn);
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    conn.release();
    throw error;
  }
  return {
    async commit() { try { await conn.unsafe('COMMIT'); } finally { conn.release(); } },
    async rollback() { try { await conn.unsafe('ROLLBACK'); } finally { conn.release(); } },
  };
}

function revocationEvent(tenantId, membershipId, userId) {
  return {
    id: randomUUID(),
    tenantId,
    aggregateId: membershipId,
    eventType: MEMBERSHIP_REVOCATION_EVENT_TYPE,
    attempts: 1,
    payload: {
      type: MEMBERSHIP_REVOCATION_EVENT_TYPE,
      version: 1,
      reason: 'identity_provider_user_deleted',
      user_id: userId,
      membership_id: membershipId,
      webhook_event_id: randomUUID(),
    },
  };
}

/** Runs the REAL S1-03 revocation handler as the worker runtime, tenant-bound like the worker does. */
async function runRevocationHandler(tenantId, target) {
  const outcomes = [];
  const handler = createMembershipRevocationHandler({ onOutcome: (outcome) => outcomes.push(outcome.outcome) });
  await h.asRuntime(h.workerPool, { tenantId }, (tx) => handler(revocationEvent(tenantId, target.membershipId, target.user.id), tx));
  return outcomes;
}

const settle = (promise) => promise.then((value) => value, (error) => error);

module.exports = {
  ...h,
  buildTestApp,
  listMembers,
  getMember,
  suspend,
  revoke,
  whoami,
  membershipRow,
  userStatus,
  lifecycleAudits,
  tenantLifecycleAudits,
  waitForWaiters,
  forcedOrder,
  openPrivileged,
  runRevocationHandler,
  settle,
};
