'use strict';

const h = require('../audit/helpers.cjs');
const { randomUUID, createHash } = require('node:crypto');
const { before, after, test } = require('node:test');

const { assert, admin } = h;
let t;
let invitationB;

before(async () => {
  t = await h.tenants();
  invitationB = await h.seedInvitation({ tenantId: t.b.tenantId, email: h.uniqueEmail('s108-resolver'),
    invitedBy: t.b.owner.membershipId, expiresAt: new Date(Date.now() + 86_400_000) });
});
after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

test('inventory every app function EXECUTE grant across API, worker, identity_sync, resolver and PUBLIC', async () => {
  const rows = await admin`
    SELECT p.oid::regprocedure::text AS signature, p.proname, p.prosecdef,
      has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api,
      has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker,
      has_function_privilege('tallermecario_identity_sync', p.oid, 'EXECUTE') AS identity_sync,
      has_function_privilege('tallermecario_bootstrap_resolver', p.oid, 'EXECUTE') AS resolver,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
        WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE') AS public
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' ORDER BY 1`;
  assert.ok(rows.length >= 20, `function inventory too small: ${rows.length}`);
  for (const row of rows) assert.equal(row.public, false, `${row.signature} executable by PUBLIC`);
  const byName = new Map(rows.map((row) => [row.proname, row]));
  for (const removed of ['lock_tenant_owner_set', 'assert_tenant_keeps_active_owner']) {
    assert.equal(byName.has(removed), false, `${removed} accepts arbitrary tenant UUID`);
  }
  const currentLock = byName.get('lock_current_tenant_owner_set');
  assert.ok(currentLock);
  assert.equal(currentLock.signature.endsWith('()'), true);
  assert.equal(currentLock.api, true);
  assert.equal(currentLock.worker, true);
  assert.equal(byName.get('enforce_audit_log_actor').api, false);
  assert.equal(byName.get('enforce_audit_log_actor').worker, false);
  assert.equal(byName.get('bootstrap_resolve_membership_invitation').api, true);
  assert.equal(byName.get('bootstrap_resolve_membership_invitation').worker, false);
  assert.equal(byName.get('bootstrap_list_user_memberships_for_revocation').api, false);
  assert.equal(byName.get('bootstrap_list_user_memberships_for_revocation').identity_sync, true);
  assert.equal(byName.get('identity_sync_apply').api, false);
  assert.equal(byName.get('identity_sync_apply').worker, true);
  assert.equal(byName.get('bootstrap_append_identity_audit').api, false);
  assert.equal(byName.get('bootstrap_append_identity_audit').identity_sync, true);
  for (const name of ['worker_get_outbox_event', 'worker_complete_outbox_event', 'worker_requeue_stalled_outbox_events',
    'worker_acquire_invitation_email_lease', 'worker_complete_invitation_email_delivery', 'worker_release_invitation_email_lease']) {
    assert.equal(byName.get(name).api, false, name);
    assert.equal(byName.get(name).worker, true, name);
  }
});

test('invitation resolver accepts exact token hash only, returns minimal id/tenant, and cannot enumerate by UUID', async () => {
  const tokenHash = createHash('sha256').update(invitationB.token).digest('hex');
  const rows = await h.runtimeTx(h.apiPool, {}, (tx) => tx`SELECT * FROM app.bootstrap_resolve_membership_invitation(${tokenHash})`);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { invitation_id: invitationB.id, tenant_id: t.b.tenantId });
  const misses = [randomUUID(), tokenHash.slice(0, 24), createHash('sha256').update(randomUUID()).digest('hex')];
  for (const miss of misses) {
    const result = await h.runtimeTx(h.apiPool, {}, (tx) => tx`SELECT * FROM app.bootstrap_resolve_membership_invitation(${miss})`);
    assert.equal(result.length, 0);
  }
  await assert.rejects(h.runtimeTx(h.workerPool, {}, (tx) => tx`SELECT * FROM app.bootstrap_resolve_membership_invitation(${tokenHash})`), (e) => e.code === '42501');
});

test('owner-lock helper never accepts a tenant ID; A scope locks only A workshop row', async () => {
  const row = await h.runtimeTx(h.apiPool, { tenant_id: t.a.tenantId }, async (tx) => {
    await tx`SELECT app.lock_current_tenant_owner_set()`;
    const [current] = await tx`SELECT app.current_tenant_id() AS tenant_id`;
    return current;
  });
  assert.equal(row.tenant_id, t.a.tenantId);
  await assert.rejects(h.runtimeTx(h.apiPool, { tenant_id: t.a.tenantId }, (tx) => tx`SELECT app.lock_current_tenant_owner_set(${t.b.tenantId}::uuid)`),
    (e) => e.code === '42883');
});

test('identity/global and audit helper functions are not callable as a tenant API to write B', async () => {
  const forbidden = [
    (tx) => tx`SELECT app.identity_sync_apply(${randomUUID()}::uuid, ${randomUUID()}::uuid)`,
    (tx) => tx`SELECT app.bootstrap_list_user_memberships_for_revocation(${t.b.owner.user.id}::uuid)`,
    (tx) => tx`SELECT app.bootstrap_append_identity_audit('x', 'x', 'x', ${t.b.owner.user.id}::uuid, ${tx.json({})}, 'x')`,
  ];
  for (const invoke of forbidden) {
    await assert.rejects(h.runtimeTx(h.apiPool, { tenant_id: t.a.tenantId }, invoke),
      (e) => ['42501', '42883'].includes(e.code));
  }
});

test('Wompi and outbox helpers are global integration boundaries, not callable by API as tenant-scoped writers', async () => {
  const rows = await admin`
    SELECT proname,
      has_function_privilege('tallermecario_api', oid, 'EXECUTE') AS api,
      has_function_privilege('tallermecario_worker', oid, 'EXECUTE') AS worker
    FROM pg_proc WHERE pronamespace = 'app'::regnamespace
      AND (proname LIKE 'worker_%outbox%' OR proname LIKE '%wompi%' OR proname = 'bootstrap_claim_outbox_events')`;
  assert.ok(rows.some((r) => r.proname === 'worker_get_outbox_event'));
  assert.ok(rows.some((r) => r.proname === 'bootstrap_claim_outbox_events'));
  for (const row of rows.filter((r) => r.proname.startsWith('worker_') || r.proname === 'bootstrap_claim_outbox_events'
    || r.proname === 'append_wompi_webhook_attempt' || r.proname === 'apply_wompi_payment_status')) {
    assert.equal(row.api, false, row.proname);
    assert.equal(row.worker, true, row.proname);
  }
});
