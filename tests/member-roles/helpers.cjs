'use strict';

/**
 * S1-05 test harness, layered on the S1-03 identity harness (which MUST load
 * first: it installs the hermetic fetch trap before any compiled module).
 * Authentication goes through the REAL ClerkIdentityProvider (per-run RS256
 * keys); PostgreSQL through NOBYPASSRLS runtime logins (ADR-009).
 */

const h = require('../identity/helpers.cjs');
const { randomUUID } = require('node:crypto');

const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerMemberRoleRoutes } = h.load('memberships/roles-routes.js');

const clerkUsers = new h.FakeClerkUsers();
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: clerkUsers });
const apiPool = h.runtimePool('api', 10);
const workerPool = h.runtimePool('worker', 2);
const BIG_LIMIT = { max: 100_000, timeWindow: '1 minute' };

async function buildTestApp() {
  return buildApi({
    database: apiPool,
    identityProvider: provider,
    rateLimit: BIG_LIMIT,
    registerRoutes(server) {
      registerMemberRoleRoutes(server, { rateLimit: BIG_LIMIT });
      server.get('/api/v1/__s105/whoami', { config: { permission: 'workshop.read' } }, async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId, membershipId: context.tenant.membershipId, roles: [...context.tenant.roles] };
      });
    },
  });
}

async function member(label) {
  const subject = h.newSubject(label);
  const address = `${label}-${randomUUID().slice(0, 8)}@roles.test`;
  clerkUsers.put(h.clerkUser(subject, { email: address }));
  const user = await h.createUser({ subject, email: address });
  return { subject, user, email: address };
}

/**
 * Tenant A: owner, admin, advisor, technician (+ optional extra members);
 * tenant B: one owner + one technician. Seeded with triggers off (fixtures).
 */
async function twoTenants(extraA = []) {
  const owner = await member('owner');
  const admin = await member('admin');
  const advisor = await member('advisor');
  const technician = await member('tech');
  const extras = [];
  for (const extra of extraA) extras.push({ ...extra, identity: await member(extra.label) });
  const a = await h.createWorkshop([
    { user: owner.user, roles: ['owner'] },
    { user: admin.user, roles: ['admin'] },
    { user: advisor.user, roles: ['service_advisor'] },
    { user: technician.user, roles: ['technician'] },
    ...extras.map((extra) => ({ user: extra.identity.user, roles: extra.roles, status: extra.status })),
  ]);
  const ownerB = await member('ownerb');
  const techB = await member('techb');
  const b = await h.createWorkshop([
    { user: ownerB.user, roles: ['owner'] },
    { user: techB.user, roles: ['technician'] },
  ]);
  const extraMembers = {};
  extras.forEach((extra, index) => {
    extraMembers[extra.label] = { ...extra.identity, membershipId: a.memberships[4 + index] };
  });
  return {
    a: {
      tenantId: a.tenantId,
      owner: { ...owner, membershipId: a.memberships[0] },
      admin: { ...admin, membershipId: a.memberships[1] },
      advisor: { ...advisor, membershipId: a.memberships[2] },
      technician: { ...technician, membershipId: a.memberships[3] },
      ...extraMembers,
    },
    b: {
      tenantId: b.tenantId,
      owner: { ...ownerB, membershipId: b.memberships[0] },
      technician: { ...techB, membershipId: b.memberships[1] },
    },
  };
}

async function call(app, { subject, method = 'GET', url, body, tenantId, headers = {}, claims, rawBody }) {
  const requestHeaders = { ...headers };
  if (subject) requestHeaders.authorization = `Bearer ${h.sessionToken(subject, claims)}`;
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
  return { status: response.statusCode, json, headers: response.headers };
}

const listRoles = (app, actor, tenantId, membershipId, extra = {}) => call(app, {
  subject: actor.subject, url: `/api/v1/memberships/${membershipId}/roles`, tenantId, ...extra,
});
const assignRole = (app, actor, tenantId, membershipId, body, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/memberships/${membershipId}/roles`, body, tenantId, ...extra,
});
const removeRole = (app, actor, tenantId, membershipId, role, extra = {}) => call(app, {
  subject: actor.subject, method: 'DELETE', url: `/api/v1/memberships/${membershipId}/roles/${role}`, tenantId, ...extra,
});

async function rolesOf(membershipId) {
  const rows = await h.admin`
    SELECT r.code, mr.assigned_by_membership_id
    FROM public.membership_roles mr JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.membership_id = ${membershipId} ORDER BY r.code
  `;
  return rows.map((row) => ({ ...row }));
}
const roleCodes = async (membershipId) => (await rolesOf(membershipId)).map((row) => row.code);

async function statusOf(membershipId) {
  const [row] = await h.admin`SELECT status FROM public.memberships WHERE id = ${membershipId}`;
  return row?.status ?? null;
}

async function activeOwners(tenantId) {
  const [row] = await h.admin`
    SELECT count(*)::int AS n
    FROM public.membership_roles mr
    JOIN public.roles r ON r.id = mr.role_id
    JOIN public.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
    WHERE mr.tenant_id = ${tenantId} AND r.code = 'owner' AND m.status = 'active'
  `;
  return row.n;
}

async function roleAudits(entityId) {
  const rows = await h.admin`
    SELECT action, outcome, tenant_id, actor_type, actor_user_id, actor_membership_id, entity_type, entity_id,
      reason_code, before_json, after_json, metadata_json, request_id, user_agent, ip_address
    FROM public.audit_logs
    WHERE entity_id = ${entityId} AND action IN ('role.assigned', 'role.revoked')
    ORDER BY created_at, id
  `;
  return rows.map((row) => ({ ...row }));
}

/**
 * Admin transaction holding a tenant's owner-set lock exactly like a runtime
 * holder (0013): owner gate ACCESS SHARE + the tenant's workshop row FOR NO KEY
 * UPDATE. Used as a barrier to park competing writers.
 */
async function holdTenantRoleLock(tenantId) {
  const conn = await h.admin.reserve();
  await conn.unsafe('BEGIN');
  await conn`LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE`;
  await conn`SELECT id FROM public.workshops WHERE id = ${tenantId} FOR NO KEY UPDATE`;
  return {
    async release() {
      try { await conn.unsafe('COMMIT'); } finally { conn.release(); }
    },
  };
}

/** Admin transaction holding a row lock on a membership, optionally changing its status. */
async function holdMembershipLock(membershipId, newStatus) {
  const conn = await h.admin.reserve();
  await conn.unsafe('BEGIN');
  if (newStatus) {
    await conn`
      UPDATE public.memberships
      SET status = ${newStatus},
        suspended_at = CASE WHEN ${newStatus} = 'suspended' THEN now() ELSE suspended_at END,
        revoked_at = CASE WHEN ${newStatus} = 'revoked' THEN now() ELSE revoked_at END
      WHERE id = ${membershipId}
    `;
  } else {
    await conn`SELECT id FROM public.memberships WHERE id = ${membershipId} FOR UPDATE`;
  }
  return {
    async release() {
      try { await conn.unsafe('COMMIT'); } finally { conn.release(); }
    },
  };
}

/** Waits until `count` backends are blocked on a lock (proves real interleaving). */
async function waitForLockWaiters(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`
      SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
      WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'
    `;
    if (row.n >= count) return;
    if (Date.now() > deadline) throw new Error(`LOCK_WAITERS_NOT_REACHED ${row.n}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Test-only failing trigger (admin DDL), removed by the returned function. */
async function injectFailure(table, whenSql = 'true') {
  const name = `s105_fail_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await h.admin.unsafe(`
    CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF ${whenSql} THEN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${name} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}();
  `);
  return async () => {
    await h.admin.unsafe(`DROP TRIGGER IF EXISTS ${name} ON public.${table}; DROP FUNCTION IF EXISTS public.${name}();`);
  };
}

/**
 * Runs `fn(tx)` as the NOBYPASSRLS api runtime inside one transaction with the
 * TenantContext GUCs bound exactly like the request pipeline does.
 */
async function asRuntime(pool, { tenantId, userId = randomUUID(), membershipId = randomUUID(), isolation }, fn) {
  const conn = await pool.reserve();
  try {
    await conn.unsafe(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    await conn`
      SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true),
        set_config('app.membership_id', ${membershipId}, true), set_config('app.request_id', ${randomUUID()}, true)
    `;
    const result = await fn(conn);
    await conn.unsafe('COMMIT');
    return result;
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  ...h,
  clerkUsers,
  apiPool,
  workerPool,
  buildTestApp,
  member,
  twoTenants,
  call,
  listRoles,
  assignRole,
  removeRole,
  rolesOf,
  roleCodes,
  statusOf,
  activeOwners,
  roleAudits,
  holdTenantRoleLock,
  holdMembershipLock,
  waitForLockWaiters,
  injectFailure,
  asRuntime,
};
