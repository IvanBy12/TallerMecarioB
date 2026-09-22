'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const h = require(path.join('..', 'db', 'helpers.cjs'));

const publishModulePath = process.env.TEST_OUTBOX_PUBLISH_MODULE;
const workerModulePath = process.env.TEST_OUTBOX_WORKER_MODULE;
if (!publishModulePath || !workerModulePath) {
  throw new Error('TEST_OUTBOX_PUBLISH_MODULE and TEST_OUTBOX_WORKER_MODULE are required');
}
const { publishOutboxEvent } = require(publishModulePath);
const {
  claimBatch,
  requeueStalled,
  getClaimedEvent,
  finishOutboxEvent,
  processClaimedJob,
  computeRetryDelaySeconds,
  TransientDispatchError,
  PermanentDispatchError,
} = require(workerModulePath);

const { admin, id, begin, commit, rollback, inTx, fixture, makeTenant } = h;
let api;
let worker;

const rlsDenied = (e) => {
  assert.equal(e.code, '42501', `expected 42501, got ${e.code}: ${e.message}`);
  return true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await h.setupRoles();
  api = h.runtime('tallermecario_api');
  worker = h.runtime('tallermecario_worker');
  const [[apiWho], [workerWho]] = await Promise.all([
    api`SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`,
    worker`SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`,
  ]);
  assert.equal(apiWho.u, 'tallermecario_api');
  assert.equal(workerWho.u, 'tallermecario_worker');
  assert.equal(apiWho.bypass, false, 'api must run NOBYPASSRLS');
  assert.equal(workerWho.bypass, false, 'worker must run NOBYPASSRLS');
});
test.after(async () => { await api.end(); await worker.end(); await admin.end(); });

async function publishedRow(eventId) {
  const [row] = await admin`SELECT * FROM outbox_events WHERE id = ${eventId}`;
  return row;
}

// Claims a generous batch and returns the caller's own job by id. A single
// shared throwaway DB backs the whole file, so an earlier section's job that
// was claimed-but-never-finished can still be 'pending'/'processing' when a
// later section runs; filtering by id (instead of assuming position 0 in a
// batch of 1) keeps every test correct regardless of run order or leftovers.
// Any OTHER row incidentally swept up by the batch claim is simply left
// 'processing' and never finished -- harmless in an ephemeral per-run DB.
async function claimMine(eventId, batchSize = 50) {
  const jobs = await claimBatch(worker, batchSize);
  const mine = jobs.find((j) => j.outboxEventId === eventId);
  if (!mine) {
    throw new Error(`expected to claim ${eventId}, got [${jobs.map((j) => j.outboxEventId).join(', ')}]`);
  }
  return mine;
}

// ---------------------------------------------------------------- 1. enqueue
test.describe('1. publish: outbox event created with the business operation', () => {
  test('valid: business write + outbox insert commit atomically', async () => {
    const t = await makeTenant();
    const eventId = id();
    await inTx(api, t.tenant, async (c) => {
      await c`UPDATE customers SET notes = 'confirmation queued' WHERE id = ${t.customer}`;
      const result = await publishOutboxEvent(c, {
        id: eventId,
        tenantId: t.tenant,
        aggregateType: 'customer',
        aggregateId: t.customer,
        eventType: 'test.customer_note_recorded',
        payload: { customerId: t.customer, note: 'queued' },
      });
      assert.equal(result.deduplicated, false);
      assert.equal(result.id, eventId);
    });
    const [customer] = await admin`SELECT notes FROM customers WHERE id = ${t.customer}`;
    assert.equal(customer.notes, 'confirmation queued');
    const row = await publishedRow(eventId);
    assert.equal(row.status, 'pending');
    assert.equal(row.tenant_id, t.tenant);
  });

  test('invalid (rolled back): a failed business statement loses the outbox row too', async () => {
    const t = await makeTenant();
    const eventId = id();
    const c = await begin(api, t.tenant);
    await c`UPDATE customers SET notes = 'about to fail' WHERE id = ${t.customer}`;
    await publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.customer_note_recorded', payload: {},
    });
    await assert.rejects(c`INSERT INTO customers (id) VALUES (${id()})`); // missing NOT NULL columns
    await rollback(c);
    assert.equal(await publishedRow(eventId), undefined);
    const [customer] = await admin`SELECT notes FROM customers WHERE id = ${t.customer}`;
    assert.notEqual(customer.notes, 'about to fail');
  });

  test('idempotency: republishing the same Idempotency-Key does not create a second row', async () => {
    const t = await makeTenant();
    const key = id();
    // inTx() commits/rolls back but does not forward fn's return value, so
    // each publish result is captured via closure instead of `await inTx(...)`.
    let first;
    await inTx(api, t.tenant, async (c) => {
      first = await publishOutboxEvent(c, {
        id: id(), tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
        eventType: 'test.customer_note_recorded', payload: { n: 1 }, idempotencyKey: key,
      });
    });
    let second;
    await inTx(api, t.tenant, async (c) => {
      second = await publishOutboxEvent(c, {
        id: id(), tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
        eventType: 'test.customer_note_recorded', payload: { n: 2 }, idempotencyKey: key,
      });
    });
    assert.equal(second.id, first.id);
    assert.equal(second.deduplicated, true);
    const [count] = await admin`SELECT count(*)::int AS n FROM outbox_events WHERE idempotency_key = ${key}`;
    assert.equal(count.n, 1);
  });

  test('cross-tenant: cannot enqueue an event under another tenant\'s id', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const c = await begin(api, b.tenant);
    await assert.rejects(
      publishOutboxEvent(c, {
        id: id(), tenantId: a.tenant, aggregateType: 'customer', aggregateId: a.customer,
        eventType: 'test.customer_note_recorded', payload: {},
      }),
      rlsDenied,
    );
    await rollback(c);
  });

  test('authorization: raw table access outside publish/worker functions is denied to both roles', async () => {
    const t = await makeTenant();
    // Each probe gets its own transaction: once one statement is rejected the
    // connection's transaction is aborted, so a second statement on the same
    // connection would just echo 25P02 regardless of its own privileges.
    const c1 = await begin(api, t.tenant);
    await assert.rejects(c1`SELECT payload_json FROM outbox_events LIMIT 1`, rlsDenied);
    await rollback(c1);
    const c2 = await begin(api, t.tenant);
    await assert.rejects(c2`UPDATE outbox_events SET status = 'processed' WHERE tenant_id = ${t.tenant}`, rlsDenied);
    await rollback(c2);
    // `id` is intentionally readable (it backs the publish-side idempotency
    // lookup); `payload_json` never is -- only worker_get_outbox_event()
    // exposes it, and only for a row that row currently owns as 'processing'.
    const wc = await begin(worker, t.tenant);
    await assert.rejects(wc`SELECT payload_json FROM outbox_events LIMIT 1`, rlsDenied);
    await rollback(wc);
  });

  // Keeps the shared throwaway queue empty going into later sections: the
  // tests above intentionally publish without claiming/finishing.
  test('cleanup: drain every event left pending by the tests above', async () => {
    for (let i = 0; i < 20; i += 1) {
      const jobs = await claimBatch(worker, 50);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        await processClaimedJob({ database: worker, handlers: {} }, job); // no handler -> 'failed'; just drains
      }
    }
    assert.deepEqual(await claimBatch(worker, 50), []);
  });
});

// ---------------------------------------------------------------- 2. claim
test.describe('2. claim: safe and concurrent', () => {
  test('only tallermecario_worker can claim; tallermecario_api cannot', async () => {
    await assert.rejects(api`SELECT * FROM app.bootstrap_claim_outbox_events(1)`, rlsDenied);
  });

  test('concurrent claims never overlap and together drain the pending set', async () => {
    const t = await makeTenant();
    const eventIds = [id(), id(), id(), id()];
    await inTx(api, t.tenant, async (c) => {
      for (const eventId of eventIds) {
        await publishOutboxEvent(c, {
          id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
          eventType: 'test.noop', payload: {},
        });
      }
    });
    const [batchA, batchB] = await Promise.all([claimBatch(worker, 2), claimBatch(worker, 2)]);
    const claimedIds = [...batchA, ...batchB].map((j) => j.outboxEventId);
    // Robust to any other pending row in the shared throwaway DB: only assert
    // about THIS test's four events, not exact-equality of the whole batch.
    for (const eventId of eventIds) {
      assert.equal(claimedIds.filter((x) => x === eventId).length, 1, `event ${eventId} claimed exactly once`);
    }
    assert.equal(new Set(claimedIds).size, claimedIds.length, 'no event claimed twice across concurrent batches');
    const statuses = await admin`SELECT status FROM outbox_events WHERE id = ANY(${eventIds})`;
    assert.ok(statuses.every((r) => r.status === 'processing'));
  });

  test('claim only returns pending, available rows (not already processing)', async () => {
    const t = await makeTenant();
    const eventId = id();
    await inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.noop', payload: {},
    }));
    const first = await claimBatch(worker, 10);
    assert.ok(first.some((j) => j.outboxEventId === eventId));
    const second = await claimBatch(worker, 10);
    assert.ok(!second.some((j) => j.outboxEventId === eventId));
  });
});

// ---------------------------------------------------------------- 3. process: success
test.describe('3. processClaimedJob: success path', () => {
  test('valid: handler runs under TenantContext, its writes and "processed" commit atomically', async () => {
    const t = await makeTenant();
    const eventId = id();
    await inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.record_note', payload: { customerId: t.customer, note: 'dispatched by worker' },
    }));
    const job = await claimMine(eventId);
    assert.equal(job.tenantId, t.tenant);

    const result = await processClaimedJob({
      database: worker,
      handlers: {
        'test.record_note': async (event, tx) => {
          await tx`UPDATE customers SET notes = ${event.payload.note} WHERE id = ${event.payload.customerId}`;
        },
      },
    }, job);

    assert.equal(result.outcome, 'processed');
    const row = await publishedRow(eventId);
    assert.equal(row.status, 'processed');
    assert.ok(row.processed_at);
    const [customer] = await admin`SELECT notes FROM customers WHERE id = ${t.customer}`;
    assert.equal(customer.notes, 'dispatched by worker');
  });

  test('a job with no registered handler fails permanently (unknown event_type is not retried)', async () => {
    const t = await makeTenant();
    const eventId = id();
    await inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.unregistered', payload: {},
    }));
    const job = await claimMine(eventId);
    const result = await processClaimedJob({ database: worker, handlers: {} }, job);
    assert.equal(result.outcome, 'failed');
    assert.equal((await publishedRow(eventId)).status, 'failed');
  });
});

// ---------------------------------------------------------------- 4. process: errors & retry
test.describe('4. retry, permanent errors and dead-letter', () => {
  function publishControllable(t, mode, extra = {}) {
    const eventId = id();
    return inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.controllable', payload: { mode, ...extra },
    })).then(() => eventId);
  }
  const controllableHandlers = {
    'test.controllable': async (event) => {
      const { mode } = event.payload;
      if (mode === 'permanent') throw new PermanentDispatchError('rejected by provider');
      if (mode === 'transient') throw new TransientDispatchError('provider timeout');
      // 'succeed': no-op
    },
  };

  test('permanent error -> failed, terminal (not reclaimable)', async () => {
    const t = await makeTenant();
    const eventId = await publishControllable(t, 'permanent');
    const job = await claimMine(eventId);
    const result = await processClaimedJob({ database: worker, handlers: controllableHandlers }, job);
    assert.equal(result.outcome, 'failed');
    assert.equal((await publishedRow(eventId)).status, 'failed');
    assert.ok(!(await claimBatch(worker, 50)).some((j) => j.outboxEventId === eventId));
  });

  test('transient error -> retry: scheduled in the future, then reclaimable once available_at passes', async () => {
    const t = await makeTenant();
    const eventId = await publishControllable(t, 'transient');
    const job = await claimMine(eventId);
    const result = await processClaimedJob(
      { database: worker, handlers: controllableHandlers, maxAttempts: 5, baseDelaySeconds: 1, maxDelaySeconds: 1 },
      job,
    );
    assert.equal(result.outcome, 'retry');

    const immediate = await claimBatch(worker, 50);
    assert.ok(!immediate.some((j) => j.outboxEventId === eventId), 'must not be claimable before available_at');

    await sleep(1200);
    const later = await claimBatch(worker, 50);
    assert.ok(later.some((j) => j.outboxEventId === eventId));
    const [row] = await admin`SELECT attempts FROM outbox_events WHERE id = ${eventId}`;
    assert.equal(row.attempts, 2);
  });

  test('exhausted retries -> dead_letter, terminal (not reclaimable)', async () => {
    const t = await makeTenant();
    const eventId = await publishControllable(t, 'transient');
    const options = { database: worker, handlers: controllableHandlers, maxAttempts: 2, baseDelaySeconds: 0, maxDelaySeconds: 0 };

    let outcome;
    for (let i = 0; i < 5; i += 1) {
      const job = await claimMine(eventId);
      ({ outcome } = await processClaimedJob(options, job));
      if (outcome !== 'retry') break;
    }
    assert.equal(outcome, 'dead_letter');
    assert.equal((await publishedRow(eventId)).status, 'dead_letter');
    assert.ok(!(await claimBatch(worker, 50)).some((j) => j.outboxEventId === eventId));
  });

  test('computeRetryDelaySeconds backs off exponentially and caps at maxDelaySeconds', () => {
    assert.equal(computeRetryDelaySeconds(1, 30, 900), 30);
    assert.equal(computeRetryDelaySeconds(2, 30, 900), 60);
    assert.equal(computeRetryDelaySeconds(3, 30, 900), 120);
    assert.equal(computeRetryDelaySeconds(10, 30, 900), 900);
  });
});

// ---------------------------------------------------------------- 5. recovery & idempotent dispatch
test.describe('5. worker restart recovery and duplicate-dispatch safety', () => {
  test('a job stuck in "processing" past the stall window is requeued and completes on retry', async () => {
    const t = await makeTenant();
    const eventId = id();
    await inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.noop', payload: {},
    }));
    await claimMine(eventId); // claimed, then the "worker" disappears without finishing
    assert.equal((await publishedRow(eventId)).status, 'processing');

    await sleep(50);
    const requeued = await requeueStalled(worker, 0, 50);
    assert.ok(requeued.some((j) => j.outboxEventId === eventId));
    assert.equal((await publishedRow(eventId)).status, 'pending');

    const job = await claimMine(eventId);
    const result = await processClaimedJob({ database: worker, handlers: { 'test.noop': async () => {} } }, job);
    assert.equal(result.outcome, 'processed');
  });

  test('duplicate dispatch after a crash-and-recover cycle does not duplicate the external effect', async () => {
    const t = await makeTenant();
    const key = id();
    const eventId = id();
    await inTx(api, t.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: t.tenant, aggregateType: 'customer', aggregateId: t.customer,
      eventType: 'test.idempotent_dispatch', payload: {}, idempotencyKey: key,
    }));

    // Mimics an idempotent external adapter/provider: dedupes by idempotencyKey.
    const effectLedger = new Map();
    let dispatchInvocations = 0;
    const handler = async (event) => {
      dispatchInvocations += 1;
      if (effectLedger.has(event.idempotencyKey)) return; // already applied: idempotent no-op
      effectLedger.set(event.idempotencyKey, 1);
    };

    // First attempt: handler runs (the effect happens) but the worker "crashes"
    // before finishing/committing -- simulate by rolling back without calling finish.
    const firstJob = await claimMine(eventId);
    const tx1 = await worker.reserve();
    await tx1.unsafe('BEGIN');
    await tx1`SELECT set_config('app.tenant_id', ${firstJob.tenantId}, true)`;
    const event1 = await getClaimedEvent(tx1, firstJob.outboxEventId);
    await handler(event1, tx1);
    await tx1.unsafe('ROLLBACK'); // crash: never called finishOutboxEvent, never committed
    tx1.release();
    assert.equal((await publishedRow(eventId)).status, 'processing', 'crash leaves the job processing, not lost');

    // Recovery: stall-requeue brings it back, a (possibly different) worker reprocesses it.
    await sleep(50);
    await requeueStalled(worker, 0, 50);
    const secondJob = await claimMine(eventId);
    const result = await processClaimedJob({ database: worker, handlers: { 'test.idempotent_dispatch': handler } }, secondJob);
    assert.equal(result.outcome, 'processed');

    assert.equal(dispatchInvocations, 2, 'the handler DID run twice (crash + recovery)');
    assert.equal(effectLedger.get(key), 1, 'but the idempotency-key-aware effect was recorded only once');
  });
});

// ---------------------------------------------------------------- 6. tenant isolation while processing
test.describe('6. cross-tenant isolation during worker processing', () => {
  test("processing tenant A's job cannot read or write tenant B's data", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const eventId = id();
    await inTx(api, a.tenant, (c) => publishOutboxEvent(c, {
      id: eventId, tenantId: a.tenant, aggregateType: 'customer', aggregateId: a.customer,
      eventType: 'test.cross_tenant_probe', payload: { otherCustomerId: b.customer },
    }));
    const job = await claimMine(eventId);
    assert.equal(job.tenantId, a.tenant);

    let sawOtherTenantRow = false;
    let blockedWrite = null;
    const result = await processClaimedJob({
      database: worker,
      handlers: {
        'test.cross_tenant_probe': async (event, tx) => {
          const rows = await tx`SELECT 1 FROM customers WHERE id = ${event.payload.otherCustomerId}`;
          sawOtherTenantRow = rows.length > 0;
          try {
            await tx`UPDATE customers SET notes = 'leaked' WHERE id = ${event.payload.otherCustomerId}`;
          } catch (e) {
            blockedWrite = e;
          }
        },
      },
    }, job);

    assert.equal(result.outcome, 'processed');
    assert.equal(sawOtherTenantRow, false, 'RLS must hide tenant B rows while processing tenant A job');
    // No error is expected: the UPDATE matches zero rows under RLS rather than raising.
    assert.equal(blockedWrite, null);
    const [customerB] = await admin`SELECT notes FROM customers WHERE id = ${b.customer}`;
    assert.notEqual(customerB.notes, 'leaked');
  });

  test('a global-scope job (tenant_id NULL) never receives a TenantContext', async () => {
    const eventId = id();
    await fixture(async (tx) => {
      await tx`
        INSERT INTO outbox_events (id, tenant_id, aggregate_type, event_type, payload_json)
        VALUES (${eventId}, NULL, 'platform', 'test.global_probe', '{}'::jsonb)
      `;
    });
    const jobs = await claimBatch(worker, 50);
    const job = jobs.find((j) => j.outboxEventId === eventId);
    assert.ok(job);
    assert.equal(job.tenantId, null);

    let observedTenantSetting;
    const result = await processClaimedJob({
      database: worker,
      handlers: {
        'test.global_probe': async (_event, tx) => {
          const [row] = await tx`SELECT current_setting('app.tenant_id', true) AS v`;
          observedTenantSetting = row.v;
        },
      },
    }, job);

    assert.equal(result.outcome, 'processed');
    assert.ok(observedTenantSetting === null || observedTenantSetting === '', 'no tenant leaks into a global job');
  });
});
