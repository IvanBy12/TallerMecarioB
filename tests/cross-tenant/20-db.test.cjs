'use strict';

const h = require('../audit/helpers.cjs');
const { randomUUID, createHash } = require('node:crypto');
const { before, after, test } = require('node:test');

const { assert, admin } = h;
let t;
let invitationB;
let outboxB;
const gucs = (tenant, member) => ({ tenant_id: tenant.tenantId, user_id: member.user.id, membership_id: member.membershipId, request_id: randomUUID() });
const rejectOrZero = (result) => result === 0 || result === '42501' || result === '23503';

before(async () => {
  t = await h.tenants();
  invitationB = await h.seedInvitation({ tenantId: t.b.tenantId, email: h.uniqueEmail('s108-db'), invitedBy: t.b.owner.membershipId,
    expiresAt: new Date(Date.now() + 86_400_000), withOutbox: true });
  await admin`INSERT INTO public.membership_invitation_deliveries (tenant_id, invitation_id) VALUES (${t.b.tenantId}, ${invitationB.id})`;
  [outboxB] = await admin`SELECT id FROM public.outbox_events WHERE aggregate_id = ${invitationB.id}`;
  assert.ok(outboxB);
});
after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

test('runtime roles are NOBYPASSRLS, nonowners; all Sprint 1 tenant tables have ENABLE and FORCE', async () => {
  const roles = await admin`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('tallermecario_api', 'tallermecario_worker') ORDER BY rolname`;
  assert.deepEqual(roles.map((r) => [r.rolname, r.rolbypassrls, r.rolsuper]), [
    ['tallermecario_api', false, false], ['tallermecario_worker', false, false],
  ]);
  const tables = ['workshops', 'workshop_locations', 'memberships', 'membership_roles', 'membership_invitations',
    'membership_invitation_deliveries', 'audit_logs', 'outbox_events'];
  const rows = await admin`SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${tables}) ORDER BY relname`;
  assert.equal(rows.length, tables.length);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, row.relname);
    assert.equal(row.relforcerowsecurity, true, row.relname);
    assert.notEqual(row.owner, 'tallermecario_api');
    assert.notEqual(row.owner, 'tallermecario_worker');
  }
});

test('A context cannot SELECT known B rows from each Sprint 1 tenant table, for API or worker', async () => {
  const probes = [
    ['workshops', 'id', t.b.tenantId],
    ['memberships', 'id', t.b.owner.membershipId],
    ['membership_roles', 'membership_id', t.b.owner.membershipId],
    ['membership_invitations', 'id', invitationB.id],
    ['membership_invitation_deliveries', 'invitation_id', invitationB.id],
    ['audit_logs', 'entity_id', t.b.owner.membershipId],
    ['outbox_events', 'id', outboxB.id],
  ];
  await admin`INSERT INTO public.audit_logs (id, tenant_id, actor_type, actor_user_id, actor_membership_id,
    action, outcome, entity_type, entity_id, reason_code, request_id)
    VALUES (${randomUUID()}, ${t.b.tenantId}, 'user', ${t.b.owner.user.id}, ${t.b.owner.membershipId},
      'membership.suspended', 'denied', 'membership', ${t.b.owner.membershipId}, 'self_membership_modification', ${randomUUID()})`;
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const [table, column, id] of probes) {
      const [privilege] = await admin`SELECT has_table_privilege(${pool === h.apiPool ? 'tallermecario_api' : 'tallermecario_worker'}, ${`public.${table}`}, 'SELECT') AS allowed`;
      if (!privilege.allowed) continue;
      const rows = await h.runtimeTx(pool, { tenant_id: t.a.tenantId }, (tx) => tx.unsafe(`SELECT 1 FROM public.${table} WHERE ${column} = $1`, [id]));
      assert.equal(rows.length, 0, `${table} exposed B`);
    }
  }
  const [globalGrant] = await admin`SELECT has_table_privilege('tallermecario_api', 'public.identity_sync_states', 'SELECT') AS api,
    has_table_privilege('tallermecario_worker', 'public.identity_sync_states', 'SELECT') AS worker`;
  assert.deepEqual({ ...globalGrant }, { api: false, worker: false });
});

test('direct UPDATE/DELETE against B rows yield zero or privilege denial; B state cannot change', async () => {
  const operations = [
    ['UPDATE public.workshops SET display_name = display_name WHERE id = $1', t.b.tenantId],
    ['UPDATE public.memberships SET status = status WHERE id = $1', t.b.technician.membershipId],
    ['UPDATE public.membership_invitations SET status = status WHERE id = $1', invitationB.id],
    ['DELETE FROM public.membership_roles WHERE membership_id = $1', t.b.technician.membershipId],
    ['UPDATE public.audit_logs SET outcome = outcome WHERE entity_id = $1', t.b.owner.membershipId],
    ['DELETE FROM public.outbox_events WHERE id = $1', outboxB.id],
  ];
  for (const pool of [h.apiPool, h.workerPool]) {
    for (const [query, id] of operations) {
      let result;
      try {
        result = await h.runtimeTx(pool, { tenant_id: t.a.tenantId }, async (tx) => (await tx.unsafe(query, [id])).count);
      } catch (error) { result = error.code; }
      assert.equal(rejectOrZero(result), true, `${query}: ${result}`);
    }
  }
  const [row] = await admin`SELECT status FROM public.memberships WHERE id = ${t.b.technician.membershipId}`;
  assert.equal(row.status, 'active');
  const [invitation] = await admin`SELECT status FROM public.membership_invitations WHERE id = ${invitationB.id}`;
  assert.equal(invitation.status, 'pending');
  const [job] = await admin`SELECT status FROM public.outbox_events WHERE id = ${outboxB.id}`;
  assert.equal(job.status, 'pending');
});

test('spoofed B tenant on INSERT is refused; composite FKs reject B membership and assigned_by under A', async () => {
  const a = gucs(t.a, t.a.owner);
  const roleId = await h.roleId('service_advisor');
  const attempts = [
    (tx) => tx`INSERT INTO public.workshops (id, slug, legal_name, display_name)
      VALUES (${randomUUID()}, ${`s108-${randomUUID()}`}, 'Legal', 'Spoof')`,
    (tx) => tx`INSERT INTO public.memberships (id, tenant_id, user_id, status)
      VALUES (${randomUUID()}, ${t.b.tenantId}, ${t.b.owner.user.id}, 'active')`,
    (tx) => tx`INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      VALUES (${t.b.tenantId}, ${t.b.technician.membershipId}, ${roleId}, ${t.b.owner.membershipId})`,
    (tx) => tx`INSERT INTO public.outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
      VALUES (${randomUUID()}, ${t.b.tenantId}, 'membership_invitation', ${invitationB.id}, 's108.probe', ${tx.json({})})`,
    (tx) => tx`INSERT INTO public.audit_logs (id, tenant_id, actor_type, actor_user_id, actor_membership_id,
      action, outcome, entity_type, entity_id, request_id)
      VALUES (${randomUUID()}, ${t.b.tenantId}, 'user', ${t.a.owner.user.id}, ${t.a.owner.membershipId},
        'membership.suspended', 'success', 'membership', ${t.b.technician.membershipId}, ${a.request_id})`,
  ];
  for (const attempt of attempts) await assert.rejects(h.runtimeTx(h.apiPool, a, attempt), (e) => ['42501', '23503'].includes(e.code));

  const mismatch = [
    (tx) => tx`INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      VALUES (${t.a.tenantId}, ${t.b.technician.membershipId}, ${roleId}, ${t.a.owner.membershipId})`,
    (tx) => tx`INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id)
      VALUES (${t.a.tenantId}, ${t.a.technician.membershipId}, ${roleId}, ${t.b.owner.membershipId})`,
    (tx) => tx`INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id,
      token_hash, expires_at, invited_by_membership_id)
      VALUES (${randomUUID()}, ${t.a.tenantId}, 's108@example.test', 's108@example.test', ${roleId},
        ${createHash('sha256').update(randomUUID()).digest('hex')}, ${new Date(Date.now() + 86_400_000)}, ${t.b.owner.membershipId})`,
  ];
  for (const attempt of mismatch) await assert.rejects(h.runtimeTx(h.apiPool, a, attempt), (e) => e.code === '23503');
});

test('audit actor and resource contamination are blocked on the supported API path', async () => {
  const a = gucs(t.a, t.a.owner);
  for (const change of [
    { actor_user_id: t.b.owner.user.id, actor_membership_id: t.a.owner.membershipId },
    { actor_user_id: t.a.owner.user.id, actor_membership_id: t.b.owner.membershipId },
  ]) {
    await assert.rejects(h.runtimeTx(h.apiPool, a, (tx) => tx`INSERT INTO public.audit_logs ${tx(h.auditRow({
      tenant_id: t.a.tenantId, actor_user_id: change.actor_user_id, actor_membership_id: change.actor_membership_id,
      entity_id: t.b.technician.membershipId, request_id: a.request_id,
    }))}`), (e) => ['42501', '23503'].includes(e.code));
  }
  const count = await h.auditsMentioning(t.b.technician.membershipId);
  assert.equal(count.filter((row) => row.tenant_id === t.a.tenantId).length, 0);
});
