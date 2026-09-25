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
