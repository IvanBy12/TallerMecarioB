'use strict';

/**
 * S1-07 — atomicity of audit with the business write, in real PostgreSQL:
 *
 *   A  business write + audit -> one COMMIT (both or neither)
 *   B  the business write fails (row trigger or at COMMIT) -> no orphan success row
 *   C  the audit INSERT fails -> the business write rolls back with it (same tx:
 *      Estados y Transiciones §1 "todo ocurre en la misma transacción")
 *   D  durable denied rows: committed with the 403; if the denied row cannot be
 *      written the request fails closed (never a 403 without its row)
 *   E  retry after a failure / idempotent retries -> exactly one success row
 *
 * Failures are injected with test-only triggers (admin DDL, removed after each
 * test). A deferred constraint trigger makes COMMIT itself fail, which is what
 * catches an audit committed in its own transaction before the business one.
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert } = h;
let app;
let t;

before(async () => {
  app = await h.buildAuditApp();
  t = await h.tenants({ extraTechnicians: 12 });
});
after(async () => {
  await app.close();
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await h.admin.end();
});

let nextExtra = 0;
const extra = () => t.a.extras[nextExtra++];

async function withFailure(table, options, fn) {
  const remove = await h.injectTrigger(table, options);
  try {
    return await fn();
  } finally {
    await remove();
  }
}

const successRows = async (entityId, action) => (await h.auditsForEntity(entityId, action)).filter((row) => row.outcome === 'success');

describe('A: one transaction (runtime SQL)', () => {
  test('business UPDATE + audit INSERT commit together, and roll back together', async () => {
    const target = extra();
    const gucs = { tenant_id: t.a.tenantId, user_id: t.a.owner.user.id, membership_id: t.a.owner.membershipId, request_id: randomUUID() };
    const work = async (tx) => {
      await tx`UPDATE public.memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = ${target.membershipId}`;
      await tx`INSERT INTO public.audit_logs ${tx(h.auditRow({
        tenant_id: t.a.tenantId, actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId,
        request_id: gucs.request_id, entity_id: target.membershipId,
        before_json: tx.json({ status: 'active' }), after_json: tx.json({ status: 'suspended' }), metadata_json: tx.json({ command: 'suspend', roles: ['technician'] }),
      }))}`;
    };
    await h.runtimeTx(h.apiPool, gucs, work, { commit: false });
    assert.equal(await h.membershipStatus(target.membershipId), 'active');
    assert.equal((await h.auditsByRequest(gucs.request_id)).length, 0);
    await h.runtimeTx(h.apiPool, gucs, work, { commit: true });
    assert.equal(await h.membershipStatus(target.membershipId), 'suspended');
    assert.equal((await h.auditsByRequest(gucs.request_id)).length, 1);
  });
});

describe('B: business write fails -> no orphan success row', () => {
  test('S1-06 suspend: failing UPDATE and failing COMMIT', async () => {
    for (const options of [
      { timing: 'BEFORE', event: 'UPDATE' },
      { event: 'UPDATE', deferred: true },
    ]) {
      const target = extra();
      const response = await withFailure('memberships', { ...options, when: `NEW.id = '${target.membershipId}'` },
        () => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId));
      assert.equal(response.status, 500, JSON.stringify(options));
      assert.equal(await h.membershipStatus(target.membershipId), 'active');
      assert.deepEqual(await h.auditsForEntity(target.membershipId, 'membership.'), [], JSON.stringify(options));
    }
  });

  test('S1-05 assign: failing COMMIT leaves neither the role nor role.assigned', async () => {
    const target = extra();
    const response = await withFailure('membership_roles', { event: 'INSERT', deferred: true, when: `NEW.membership_id = '${target.membershipId}'` },
      () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor'));
    assert.equal(response.status, 500);
    assert.deepEqual(await h.roleCodes(target.membershipId), ['technician']);
    assert.deepEqual(await h.auditsForEntity(target.membershipId, 'role.'), []);
  });

  test('S1-04 invite / accept and S1-01 onboarding: failing COMMIT leaves no audit (not even JIT)', async () => {
    const email = h.uniqueEmail('boom');
    const invited = await withFailure('membership_invitations', { event: 'INSERT', deferred: true, when: `NEW.email_normalized = '${email}'` },
      () => h.invite(app, t.a.owner, t.a.tenantId, { email, role: 'technician' }));
    assert.equal(invited.status, 500);
    assert.equal((await h.auditsByRequest(invited.requestId)).length, 0);

    const owner = await h.member('acceptowner');
    const ws = await h.createWorkshop([{ user: owner.user, roles: ['owner'] }]);
    const newcomer = h.identity('boomaccept');
    const created = await h.invite(app, { ...owner, membershipId: ws.memberships[0] }, ws.tenantId, { email: newcomer.email, role: 'technician' });
    assert.equal(created.status, 201);
    const raw = await h.tokenFromOutbox(created.json.invitation.id);
    const accepted = await withFailure('memberships', { event: 'INSERT', deferred: true, when: `NEW.tenant_id = '${ws.tenantId}'` },
      () => h.accept(app, newcomer, raw));
    assert.equal(accepted.status, 500);
    assert.equal((await h.auditsByRequest(accepted.requestId)).length, 0, 'no trio and no identity.user_provisioned_jit');
    assert.equal(await h.localUserId(newcomer.subject), null, 'the JIT user rolled back with its audit row');
    assert.equal((await h.invitationRow(created.json.invitation.id)).status, 'pending');

    const founder = h.identity('boomfounder');
    const onboarded = await withFailure('workshops', { event: 'INSERT', deferred: true, when: "NEW.display_name = 'Taller Boom'" },
      () => h.onboard(app, founder, 'Boom'));
    assert.equal(onboarded.status, 500);
    assert.equal((await h.auditsByRequest(onboarded.requestId)).length, 0);
    assert.equal(await h.localUserId(founder.subject), null);
  });

  test('S1-03 worker revocation: failing UPDATE leaves no provider row', async () => {
    const target = extra();
    const job = h.revocationJob(t.a.tenantId, target.membershipId, target.user.id);
    await withFailure('memberships', { timing: 'BEFORE', event: 'UPDATE', when: `NEW.id = '${target.membershipId}'` },
      () => assert.rejects(h.runRevocation(job)));
    assert.equal(await h.membershipStatus(target.membershipId), 'active');
    assert.deepEqual(await h.auditsForEntity(target.membershipId, 'membership.'), []);
  });
});

describe('C: audit INSERT fails -> the business write rolls back', () => {
  test('S1-06 suspend / S1-05 assign / S1-04 invite / S1-01 onboarding', async () => {
    const target = extra();
    const suspended = await withFailure('audit_logs', { when: `NEW.action = 'membership.suspended' AND NEW.entity_id = '${target.membershipId}'` },
      () => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId));
    assert.equal(suspended.status, 500);
    assert.equal(await h.membershipStatus(target.membershipId), 'active');

    const assigned = await withFailure('audit_logs', { when: `NEW.action = 'role.assigned' AND NEW.entity_id = '${target.membershipId}'` },
      () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor'));
    assert.equal(assigned.status, 500);
    assert.deepEqual(await h.roleCodes(target.membershipId), ['technician']);

    const email = h.uniqueEmail('noaudit');
    const emailJobs = async () => (await h.admin`
      SELECT count(*)::int AS n FROM public.outbox_events WHERE tenant_id = ${t.a.tenantId} AND event_type = ${h.EMAIL_EVENT}`)[0].n;
    const jobsBefore = await emailJobs();
    const invited = await withFailure('audit_logs', { when: "NEW.action = 'membership.invited'" },
      () => h.invite(app, t.a.owner, t.a.tenantId, { email, role: 'technician' }));
    assert.equal(invited.status, 500);
    const [inv] = await h.admin`SELECT count(*)::int AS n FROM public.membership_invitations WHERE email_normalized = ${email}`;
    assert.equal(inv.n, 0, 'no invitation without its audit row');
    assert.equal(await emailJobs(), jobsBefore, 'no email job without its audit row');

    const founder = h.identity('noauditfounder');
    const onboarded = await withFailure('audit_logs', { when: "NEW.action = 'workshop.created'" }, () => h.onboard(app, founder, 'NoAudit'));
    assert.equal(onboarded.status, 500);
    assert.equal(await h.localUserId(founder.subject), null);
    const [ws] = await h.admin`SELECT count(*)::int AS n FROM public.workshops WHERE display_name = 'Taller NoAudit'`;
    assert.equal(ws.n, 0);
  });

  test('S1-04 accept: a failing audit row rolls back membership, role, acceptance and JIT', async () => {
    const newcomer = h.identity('acceptnoaudit');
    const created = await h.invite(app, t.a.owner, t.a.tenantId, { email: newcomer.email, role: 'technician' });
    const raw = await h.tokenFromOutbox(created.json.invitation.id);
    const response = await withFailure('audit_logs', { when: `NEW.action = 'membership.invitation_accepted' AND NEW.entity_id = '${created.json.invitation.id}'` },
      () => h.accept(app, newcomer, raw));
    assert.equal(response.status, 500);
    assert.equal((await h.invitationRow(created.json.invitation.id)).status, 'pending');
    assert.equal(await h.localUserId(newcomer.subject), null);
    const retried = await h.accept(app, newcomer, raw);
    assert.equal(retried.status, 201, 'E: the retry succeeds once the failure is gone');
    assert.equal((await h.auditsForEntity(created.json.invitation.id, 'membership.invitation_accepted')).length, 1);
  });

  test('S1-03 worker revocation: a failing provider row keeps the membership active', async () => {
    const target = extra();
    const job = h.revocationJob(t.a.tenantId, target.membershipId, target.user.id);
    await withFailure('audit_logs', { when: `NEW.entity_id = '${target.membershipId}'` }, () => assert.rejects(h.runRevocation(job)));
    assert.equal(await h.membershipStatus(target.membershipId), 'active');
    assert.deepEqual(await h.runRevocation(job), ['revoked'], 'E: retried job applies once');
    assert.equal((await successRows(target.membershipId, 'membership.revoked')).length, 1);
  });

  test('S1-04 email worker: a failing email_sent row keeps the job unprocessed; the retry records exactly one row', async () => {
    const created = await h.invite(app, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('mailfail'), role: 'technician' });
    const invitationId = created.json.invitation.id;
    const sender = new h.RecordingSender();
    await withFailure('audit_logs', { when: `NEW.action = 'membership.invitation_email_sent' AND NEW.entity_id = '${invitationId}'` },
      () => h.drain(sender));
    assert.equal((await h.auditsForEntity(invitationId, 'membership.invitation_email')).length, 0);
    const [job] = await h.admin`SELECT id, status FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
    assert.notEqual(job.status, 'processed', 'no processed job without its audit row');
    assert.equal((await h.deliveryRow(invitationId)).sent_at, null, 'provider acceptance not recorded without its audit row');

    await h.expireDeliveryLease(invitationId);
    await h.admin`UPDATE public.outbox_events SET available_at = now() WHERE id = ${job.id}`;
    await h.drain(sender);
    const rows = await h.auditsForEntity(invitationId, 'membership.invitation_email');
    assert.deepEqual(rows.map((row) => row.action), ['membership.invitation_email_sent']);
    const [done] = await h.admin`SELECT status FROM public.outbox_events WHERE id = ${job.id}`;
    assert.equal(done.status, 'processed');
    const keys = new Set(sender.calls.filter((call) => call.idempotencyKey.endsWith(invitationId)).map((call) => call.idempotencyKey));
    assert.equal(keys.size, 1, 'both attempts used the same provider idempotency key');
  });
});

describe('D: durable denied rows', () => {
  test('each denied attempt commits its own row with the 403; the business state is untouched', async () => {
    const requests = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await h.suspend(app, t.a.admin, t.a.tenantId, t.a.owner.membershipId);
      assert.equal(response.status, 403);
      requests.push(response.requestId);
    }
    for (const requestId of requests) {
      const rows = await h.auditsByRequest(requestId);
      assert.deepEqual(rows.map((row) => `${row.action}:${row.outcome}`), ['membership.suspended:denied']);
    }
    assert.equal(await h.membershipStatus(t.a.owner.membershipId), 'active');
  });

  test('if the denied row cannot be written the request fails closed (500, never a 403 without its row)', async () => {
    for (const [send, action] of [
      [() => h.suspend(app, t.a.admin, t.a.tenantId, t.a.owner.membershipId), 'membership.suspended'],
      [() => h.assignRole(app, t.a.admin, t.a.tenantId, t.a.advisor.membershipId, 'owner'), 'role.assigned'],
      [() => h.invite(app, t.a.admin, t.a.tenantId, { email: h.uniqueEmail('x'), role: 'admin' }), 'membership.invited'],
    ]) {
      const response = await withFailure('audit_logs', { when: `NEW.action = '${action}' AND NEW.outcome = 'denied'` }, send);
      assert.equal(response.status, 500, action);
      assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    }
  });
});

describe('E: retry after a failure', () => {
  test('a failed suspend (500) retried succeeds with exactly one success row', async () => {
    const target = extra();
    const failed = await withFailure('memberships', { event: 'UPDATE', deferred: true, when: `NEW.id = '${target.membershipId}'` },
      () => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId));
    assert.equal(failed.status, 500);
    const retried = await h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId);
    assert.equal(retried.status, 200);
    const again = await h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId);
    assert.equal(again.status, 409);
    assert.equal((await successRows(target.membershipId, 'membership.suspended')).length, 1);
  });
});

test('catalog invariants hold after every injected failure', async () => {
  assert.deepEqual(await h.catalogViolations(), []);
  assert.deepEqual(await h.duplicateSuccessRows(), []);
  assert.deepEqual(h.scanAudits(await h.allAudits()), []);
});
