'use strict';

const h = require('../audit/helpers.cjs');
const { randomUUID } = require('node:crypto');
const { before, after, test } = require('node:test');

const { assert, admin } = h;
const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerMemberRoleRoutes } = h.load('memberships/roles-routes.js');
let app;
let pool;
let t;
let invitationA;

before(async () => {
  t = await h.tenants({ extraOwners: 1 });
  invitationA = await h.seedInvitation({ tenantId: t.a.tenantId, email: h.uniqueEmail('s108-lock'),
    invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() + 86_400_000) });
  pool = h.runtimePool('api', 1);
  const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
  app = await buildApi({ database: pool, identityProvider: provider,
    registerRoutes(server) {
      registerMemberRoleRoutes(server, { rateLimit: h.BIG_LIMIT });
      server.get('/api/v1/__s108/context', { config: { permission: 'workshop.read' } }, async (request) => {
        const ctx = getTenantRequestContext(request);
        const [row] = await ctx.sql`SELECT pg_backend_pid() AS pid,
          current_setting('app.tenant_id', true) AS tenant_id,
          current_setting('app.user_id', true) AS user_id,
          current_setting('app.membership_id', true) AS membership_id,
          current_setting('app.request_id', true) AS request_id`;
        return row;
      });
      server.get('/api/v1/__s108/error', { config: { permission: 'workshop.read' } }, async () => { throw new Error('EXPECTED_S108_ERROR'); });
      server.get('/api/v1/__s108/early', { config: { permission: 'workshop.read' } }, async (_request, reply) => reply.code(204).send());
      server.get('/api/v1/__s108/denied', { config: { permission: 'memberships.read' } }, async () => ({ unexpected: true }));
    },
  });
});
after(async () => {
  await app?.close();
  await pool?.end({ timeout: 5 });
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

async function holdA(execute) {
  const tx = await h.apiPool.reserve();
  await tx.unsafe('BEGIN');
  for (const [name, value] of Object.entries({ tenant_id: t.a.tenantId, user_id: t.a.owner.user.id,
    membership_id: t.a.owner.membershipId, request_id: randomUUID() })) {
    await tx`SELECT set_config(${`app.${name}`}, ${value}, true)`;
  }
  try {
    await tx`SELECT app.lock_current_tenant_owner_set()`;
    await execute(tx);
    return { tx, async release() { try { await tx.unsafe('ROLLBACK'); } finally { tx.release(); } } };
  } catch (error) {
    await tx.unsafe('ROLLBACK').catch(() => undefined);
    tx.release();
    throw error;
  }
}

async function withTimeout(promise, ms = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('B_BLOCKED_BY_A')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('A role/status/invitation/audit transactions do not block B owner commands; global gate is ACCESS SHARE', async () => {
  const roleId = await h.roleId('owner');
  const cases = [
    async (tx) => tx`INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      VALUES (${t.a.tenantId}, ${t.a.technician.membershipId}, ${roleId}, ${t.a.owner.membershipId})`,
    async (tx) => tx`UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now()
      WHERE tenant_id = ${t.a.tenantId} AND id = ${t.a.owner.membershipId}`,
    async (tx) => tx`UPDATE public.membership_invitations SET status = 'revoked', revoked_at = now(),
      revoked_by_membership_id = ${t.a.owner.membershipId} WHERE id = ${invitationA.id}`,
    async (tx) => tx`INSERT INTO public.audit_logs (id, tenant_id, actor_type, actor_user_id, actor_membership_id,
      action, outcome, entity_type, entity_id, request_id)
      VALUES (${randomUUID()}, ${t.a.tenantId}, 'user', ${t.a.owner.user.id}, ${t.a.owner.membershipId},
      'membership.suspended', 'success', 'membership', ${t.a.technician.membershipId},
      ${await tx`SELECT current_setting('app.request_id') AS id`.then((rows) => rows[0].id)})`,
  ];
  const bActions = [
    () => h.assignRole(app, t.b.owner, t.b.tenantId, t.b.technician.membershipId, 'service_advisor'),
    () => h.assignRole(app, t.b.owner, t.b.tenantId, t.b.technician.membershipId, 'admin'),
    () => h.assignRole(app, t.b.owner, t.b.tenantId, t.b.technician.membershipId, 'owner'),
    () => h.removeRole(app, t.b.owner, t.b.tenantId, t.b.technician.membershipId, 'service_advisor'),
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const hold = await holdA(cases[i]);
    const pending = bActions[i]();
    try {
      const response = await withTimeout(pending);
      assert.ok([200, 201].includes(response.status), JSON.stringify(response.json));
      if (i < 2) {
        const [lock] = await admin`SELECT count(*)::int AS n FROM pg_locks
          WHERE pid = ${await hold.tx`SELECT pg_backend_pid() AS pid`.then((rows) => rows[0].pid)}
            AND relation = 'app.owner_mutation_gate'::regclass AND mode = 'AccessShareLock' AND granted`;
        assert.ok(lock.n >= 1);
      }
    } finally {
      await hold.release();
      await pending.catch(() => undefined);
    }
  }
});

test('A cannot take a row lock on known B workshop through the supported current-tenant function or SQL', async () => {
  const hold = await holdA(async (tx) => {
    await tx`SELECT app.lock_current_tenant_owner_set()`;
    const rows = await tx`SELECT id FROM public.workshops WHERE id = ${t.b.tenantId} FOR NO KEY UPDATE`;
    assert.equal(rows.length, 0);
  });
  const pending = h.assignRole(app, t.b.owner, t.b.tenantId, t.b.technician.membershipId, 'service_advisor');
  try {
    const response = await withTimeout(pending);
    assert.equal(response.status, 201, JSON.stringify(response.json));
  } finally {
    await hold.release();
    await pending.catch(() => undefined);
  }
});

async function request(actor, tenantId, path) {
  return h.call(app, { subject: actor.subject, tenantId, url: `/api/v1/__s108/${path}` });
}

async function noSessionGucs(expectedPid) {
  const conn = await pool.reserve();
  try {
    const [row] = await conn`SELECT pg_backend_pid() AS pid,
      nullif(current_setting('app.tenant_id', true), '') AS tenant_id,
      nullif(current_setting('app.user_id', true), '') AS user_id,
      nullif(current_setting('app.membership_id', true), '') AS membership_id,
      nullif(current_setting('app.request_id', true), '') AS request_id`;
    assert.equal(row.pid, expectedPid);
    assert.deepEqual([row.tenant_id, row.user_id, row.membership_id, row.request_id], [null, null, null, null]);
  } finally { conn.release(); }
}

test('same API connection clears all GUC after commit, error rollback, early return and denied request', async () => {
  const first = await request(t.a.owner, t.a.tenantId, 'context');
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const pid = first.json.pid;
  assert.deepEqual([first.json.tenant_id, first.json.user_id, first.json.membership_id],
    [t.a.tenantId, t.a.owner.user.id, t.a.owner.membershipId]);
  assert.ok(first.json.request_id);
  await noSessionGucs(pid);
  const scenarios = [
    [t.a.owner, t.a.tenantId, 'error', 500],
    [t.a.owner, t.a.tenantId, 'early', 204],
    [t.a.technician, t.a.tenantId, 'denied', 403],
  ];
  for (const [actor, tenantId, path, status] of scenarios) {
    const response = await request(actor, tenantId, path);
    assert.equal(response.status, status, JSON.stringify(response.json));
    await noSessionGucs(pid);
    const b = await request(t.b.owner, t.b.tenantId, 'context');
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(b.json.pid, pid, 'connection must actually be reused');
    assert.deepEqual([b.json.tenant_id, b.json.user_id, b.json.membership_id],
      [t.b.tenantId, t.b.owner.user.id, t.b.owner.membershipId]);
    assert.notEqual(b.json.request_id, first.json.request_id);
    await noSessionGucs(pid);
  }
});

test('direct rollback and failed statement leave no GUC on a reused backend', async () => {
  const conn = await pool.reserve();
  const [start] = await conn`SELECT pg_backend_pid() AS pid`;
  try {
    await conn.unsafe('BEGIN');
    await conn`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await conn.unsafe('ROLLBACK');
    await conn.unsafe('BEGIN');
    await conn`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await assert.rejects(conn`SELECT 1/0`, (e) => e.code === '22012');
    await conn.unsafe('ROLLBACK');
  } finally { conn.release(); }
  await noSessionGucs(start.pid);
});
