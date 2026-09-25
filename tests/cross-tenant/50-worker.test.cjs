'use strict';

const h = require('../audit/helpers.cjs');
const { randomUUID } = require('node:crypto');
const { before, after, test } = require('node:test');

const { assert, admin } = h;
const { createMembershipRevocationHandler } = h.load('identity/sync/membership-revocation.js');
let t;

before(async () => { t = await h.tenants(); });
after(async () => {
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

async function enqueue(tenantId, target) {
  const id = randomUUID();
  const payload = {
    type: h.MEMBERSHIP_REVOCATION_EVENT_TYPE, version: 1, reason: 'identity_provider_user_deleted',
    user_id: target.user.id, membership_id: target.membershipId, webhook_event_id: randomUUID(),
  };
  await admin`INSERT INTO public.outbox_events (id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json)
    VALUES (${id}, ${tenantId}, 'membership', ${target.membershipId}, ${h.MEMBERSHIP_REVOCATION_EVENT_TYPE}, ${admin.json(payload)})`;
  const claimed = await h.worker.claimBatch(h.workerPool, 10);
  return claimed.find((job) => job.outboxEventId === id);
}

const options = () => ({ database: h.workerPool,
  handlers: { [h.MEMBERSHIP_REVOCATION_EVENT_TYPE]: createMembershipRevocationHandler() },
});

test('A outbox job naming real B membership is a no-op under A TenantContext, without B audit', async () => {
  const job = await enqueue(t.a.tenantId, t.b.technician);
  assert.ok(job);
  const beforeAudits = (await h.auditsForTenant(t.b.tenantId)).length;
  const result = await h.worker.processClaimedJob(options(), job);
  assert.equal(result.outcome, 'processed');
  assert.equal(await h.membershipStatus(t.b.technician.membershipId), 'active');
  assert.equal((await h.auditsForTenant(t.b.tenantId)).length, beforeAudits);
  assert.equal((await h.auditsMentioning(t.b.technician.membershipId)).filter((r) => r.tenant_id === t.a.tenantId).length, 0);
});

test('claimed B row with a forged A job tenant must stop before handler and completion', async () => {
  const job = await enqueue(t.b.tenantId, t.b.technician);
  assert.ok(job);
  const beforeAudits = await h.auditCount();
  await assert.rejects(h.worker.processClaimedJob(options(), { ...job, tenantId: t.a.tenantId }),
    (e) => e.message === 'OUTBOX_CLAIM_TENANT_MISMATCH');
  const [row] = await admin`SELECT status FROM public.outbox_events WHERE id = ${job.outboxEventId}`;
  assert.equal(row.status, 'processing');
  assert.equal(await h.membershipStatus(t.b.technician.membershipId), 'active');
  assert.equal(await h.auditCount(), beforeAudits);
});

test('phased B job rejects A claim before prepare/network, then stall recovery processes once as B', async () => {
  const app = await h.buildAuditApp();
  try {
    const invited = await h.invite(app, t.b.owner, t.b.tenantId,
      { email: h.uniqueEmail('s108-phased'), role: 'technician' });
    assert.equal(invited.status, 201, JSON.stringify(invited.json));
    const invitationId = invited.json.invitation.id;
    const [outbox] = await admin`SELECT id FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
    assert.ok(outbox);
    const job = (await h.worker.claimBatch(h.workerPool, 20)).find((row) => row.outboxEventId === outbox.id);
    assert.ok(job);
    assert.equal(job.tenantId, t.b.tenantId);
    const event = await h.worker.getClaimedEvent(h.workerPool, job.outboxEventId);
    assert.ok(event);

    const sender = new h.RecordingSender();
    const workerOptions = h.workerOptions(sender);
    const delegate = workerOptions.phasedHandlers[h.EMAIL_EVENT];
    let prepareCalls = 0;
    let applyCalls = 0;
    const handler = {
      ...delegate,
      async prepare(...args) { prepareCalls += 1; return delegate.prepare(...args); },
      async apply(...args) { applyCalls += 1; return delegate.apply(...args); },
    };
    workerOptions.phasedHandlers[h.EMAIL_EVENT] = handler;
    const before = await admin`SELECT status, attempts, last_error, updated_at
      FROM public.outbox_events WHERE id = ${job.outboxEventId}`;
    const auditBefore = await h.auditCount();
    const [deliveryBefore] = await admin`SELECT count(*)::int AS n FROM public.membership_invitation_deliveries
      WHERE invitation_id = ${invitationId}`;

    // Direct entry tests the guard in processPhasedJob itself, independent of
    // processClaimedJob's earlier prefetch guard.
    await assert.rejects(h.worker.processPhasedJob(workerOptions,
      { ...job, tenantId: t.a.tenantId }, event, handler),
    (error) => error.message === 'OUTBOX_CLAIM_TENANT_MISMATCH');
    assert.equal(prepareCalls, 0);
    assert.equal(applyCalls, 0);
    assert.equal(sender.calls.length, 0, 'no provider/network call');
    assert.deepEqual(await admin`SELECT status, attempts, last_error, updated_at
      FROM public.outbox_events WHERE id = ${job.outboxEventId}`, before);
    assert.equal(await h.auditCount(), auditBefore);
    const [deliveryAfter] = await admin`SELECT count(*)::int AS n FROM public.membership_invitation_deliveries
      WHERE invitation_id = ${invitationId}`;
    assert.equal(deliveryAfter.n, deliveryBefore.n);

    const recovered = await h.worker.requeueStalled(h.workerPool, 0, 20);
    assert.ok(recovered.some((row) => row.outboxEventId === job.outboxEventId && row.tenantId === t.b.tenantId));
    const [pending] = await admin`SELECT status, attempts FROM public.outbox_events WHERE id = ${job.outboxEventId}`;
    assert.equal(pending.status, 'pending');
    assert.equal(pending.attempts, before[0].attempts, 'stall requeue does not spend an attempt');
    const legitimate = (await h.worker.claimBatch(h.workerPool, 20)).find((row) => row.outboxEventId === job.outboxEventId);
    assert.ok(legitimate);
    assert.equal(legitimate.tenantId, t.b.tenantId);
    const processed = await h.worker.processClaimedJob(workerOptions, legitimate);
    assert.equal(processed.outcome, 'processed');
    const [finalJob] = await admin`SELECT status, attempts FROM public.outbox_events WHERE id = ${job.outboxEventId}`;
    assert.equal(finalJob.status, 'processed');
    assert.equal(finalJob.attempts, before[0].attempts + 1);
    assert.equal(prepareCalls, 1);
    assert.equal(applyCalls, 1);
    assert.equal(sender.calls.length, 1);
    const sent = (await h.auditsForEntity(invitationId))
      .filter((row) => row.action === 'membership.invitation_email_sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].tenant_id, t.b.tenantId);
    const duplicate = await h.worker.processClaimedJob(workerOptions, legitimate);
    assert.equal(duplicate.outcome, 'already_finished');
    assert.equal(sender.calls.length, 1);
    assert.equal((await h.auditsForEntity(invitationId))
      .filter((row) => row.action === 'membership.invitation_email_sent').length, 1);
  } finally {
    await app.close();
  }
});
