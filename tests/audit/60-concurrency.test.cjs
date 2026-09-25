'use strict';

/**
 * S1-07 — audit rows under real concurrency (PostgreSQL row/advisory locks,
 * the 0013 owner-set lock). Competing requests are parked behind a barrier
 * and released together (pg_locks proves they were waiting), then:
 *
 *   - exactly one success row per logical change, none for the losers;
 *   - no lost rows: the audit chain is rebuilt BY CONTENT (before -> after)
 *     from the initial state to the final database state;
 *   - created_at is the transaction START (now()), not the commit order: it is
 *     never used to order the chain (a dedicated test shows the inversion).
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert } = h;
let app;
let t;

before(async () => {
  app = await h.buildAuditApp();
  t = await h.tenants({ extraTechnicians: 10 });
});
after(async () => {
  await app.close();
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await h.admin.end();
});

let nextExtra = 0;
const extra = () => t.a.extras[nextExtra++];

/** Starts every run while the tenant's owner-set lock is held, waits until all wait, releases. */
async function behindTenantLock(tenantId, runs) {
  const barrier = await h.holdTenantLock(tenantId);
  let pending;
  try {
    pending = runs.map((run) => h.settle(run()));
    await h.waitForLockWaiters(runs.length);
  } finally {
    await barrier.release();
  }
  return Promise.all(pending);
}

/**
 * Rebuilds the chain of `rows` by content: each row's `before` must equal the
 * state left by the previous one. Returns the ordered rows; throws on a gap,
 * a fork or a leftover row (lost or duplicated audit).
 */
function chain(rows, initial, key) {
  const remaining = [...rows];
  const ordered = [];
  let state = JSON.stringify(initial);
  while (remaining.length > 0) {
    const index = remaining.findIndex((row) => JSON.stringify(row.before_json[key]) === state);
    if (index < 0) throw new Error(`AUDIT_CHAIN_BROKEN at ${state}: ${remaining.map((row) => JSON.stringify(row.before_json)).join(' | ')}`);
    const [row] = remaining.splice(index, 1);
    ordered.push(row);
    state = JSON.stringify(row.after_json[key]);
  }
  return { ordered, final: JSON.parse(state) };
}

describe('S1-04', () => {
  test('5 concurrent invitations of the same email: one success row, no row for the 409s', async () => {
    const email = h.uniqueEmail('race');
    const responses = await Promise.all(Array.from({ length: 5 }, () => h.invite(app, t.a.owner, t.a.tenantId, { email, role: 'technician' })));
    const winners = responses.filter((response) => response.status === 201);
    assert.equal(winners.length, 1);
    for (const loser of responses.filter((response) => response.status !== 201)) {
      assert.equal(loser.status, 409);
      assert.equal((await h.auditsByRequest(loser.requestId)).length, 0);
    }
    const rows = await h.auditsForEntity(winners[0].json.invitation.id, 'membership.invited');
    assert.equal(rows.length, 1);
  });

  test('4 concurrent accepts of one token: one JIT, one accepted/activated/assigned trio, nothing for the losers', async () => {
    const newcomer = h.identity('raceaccept');
    const created = await h.invite(app, t.a.owner, t.a.tenantId, { email: newcomer.email, role: 'technician' });
    const invitationId = created.json.invitation.id;
    const raw = await h.tokenFromOutbox(invitationId);
    const barrier = await h.holdInvitationLock(invitationId);
    let pending;
    try {
      pending = Array.from({ length: 4 }, () => h.accept(app, newcomer, raw));
      await h.waitForLockWaiters(4);
    } finally {
      await barrier.release();
    }
    const responses = await Promise.all(pending);
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    for (const loser of responses.filter((response) => response.status !== 201)) {
      assert.ok([409, 410].includes(loser.status), String(loser.status));
      assert.equal((await h.auditsByRequest(loser.requestId)).length, 0);
    }
    const userId = await h.localUserId(newcomer.subject);
    assert.equal((await h.auditsForEntity(userId, 'identity.user_provisioned_jit')).length, 1);
    assert.equal((await h.auditsForEntity(invitationId, 'membership.invitation_accepted')).length, 1);
    const winner = responses.find((response) => response.status === 201);
    const membershipRows = await h.auditsForEntity(winner.json.membership.id);
    assert.deepEqual(membershipRows.map((row) => row.action).sort(), ['membership.activated', 'role.assigned']);
  });
});

describe('S1-05', () => {
  test('5 concurrent assignments of the same role: one success row, four 409 without rows', async () => {
    const target = extra();
    const results = await behindTenantLock(t.a.tenantId, Array.from({ length: 5 }, () => () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor')));
    assert.deepEqual(results.map((response) => response.status).sort(), [201, 409, 409, 409, 409]);
    const rows = await h.auditsForEntity(target.membershipId, 'role.');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].after_json, { roles: ['service_advisor', 'technician'] });
  });

  test('interleaved assign / remove on one membership: every committed change has exactly one row and the chain ends at the database state', async () => {
    const target = extra();
    const runs = [
      () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor'),
      () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'admin'),
      () => h.removeRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'technician'),
      () => h.removeRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor'),
      () => h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'technician'),
    ];
    const results = await behindTenantLock(t.a.tenantId, runs);
    const committed = results.filter((response) => response.status === 200 || response.status === 201).length;
    const rows = (await h.auditsForEntity(target.membershipId, 'role.')).filter((row) => row.outcome === 'success');
    assert.equal(rows.length, committed, 'one row per committed change, none lost, none extra');
    const { final } = chain(rows, ['technician'], 'roles');
    assert.deepEqual(final, await h.roleCodes(target.membershipId).then((codes) => ['owner', 'admin', 'service_advisor', 'technician'].filter((code) => codes.includes(code))));
  });
});

describe('S1-06 + S1-03', () => {
  test('concurrent suspend + revoke (API): chain active -> ... -> revoked, one row per committed transition', async () => {
    for (let round = 0; round < 3; round += 1) {
      const target = extra();
      const runs = round % 2 === 0
        ? [() => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId), () => h.revoke(app, t.a.owner, t.a.tenantId, target.membershipId)]
        : [() => h.revoke(app, t.a.owner, t.a.tenantId, target.membershipId), () => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId)];
      const results = await behindTenantLock(t.a.tenantId, runs);
      const committed = results.filter((response) => response.status === 200).length;
      for (const loser of results.filter((response) => response.status !== 200)) assert.equal(loser.status, 409);
      const rows = await h.auditsForEntity(target.membershipId, 'membership.');
      assert.equal(rows.length, committed);
      assert.deepEqual(chain(rows, 'active', 'status').final, 'revoked');
      assert.equal(await h.membershipStatus(target.membershipId), 'revoked');
    }
  });

  test('3 concurrent deliveries of the same S1-03 revocation job: one provider row', async () => {
    const target = extra();
    const job = h.revocationJob(t.a.tenantId, target.membershipId, target.user.id);
    const results = await behindTenantLock(t.a.tenantId, [0, 1, 2].map(() => () => h.runRevocation(job)));
    assert.deepEqual(results.flat().sort(), ['already_revoked', 'already_revoked', 'revoked']);
    const rows = await h.auditsForEntity(target.membershipId, 'membership.');
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].actor_type, rows[0].outcome], ['provider', 'success']);
  });

  test('API suspend vs worker revocation: consistent chain across actor types, nothing lost', async () => {
    for (let round = 0; round < 2; round += 1) {
      const target = extra();
      const job = h.revocationJob(t.a.tenantId, target.membershipId, target.user.id);
      const runs = [() => h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId), () => h.runRevocation(job)];
      const results = await behindTenantLock(t.a.tenantId, round === 0 ? runs : runs.reverse());
      const rows = await h.auditsForEntity(target.membershipId, 'membership.');
      const { ordered, final } = chain(rows, 'active', 'status');
      assert.equal(final, 'revoked');
      assert.equal(ordered.at(-1).actor_type, 'provider');
      const suspendResult = results.find((result) => result && result.status !== undefined);
      assert.equal(rows.length, suspendResult.status === 200 ? 2 : 1);
    }
  });
});

test('created_at is the transaction start, not the commit order (never use it to order audit history)', async () => {
  const early = extra();
  const late = extra();
  const gucs = { tenant_id: t.a.tenantId, user_id: t.a.owner.user.id, membership_id: t.a.owner.membershipId, request_id: randomUUID() };
  const conn = await h.apiPool.reserve();
  try {
    await conn.unsafe('BEGIN');
    for (const [name, value] of Object.entries(gucs)) await conn`SELECT set_config(${`app.${name}`}, ${value}, true)`;
    await conn`SELECT now()`; // fixes this transaction's now()
    await new Promise((resolve) => setTimeout(resolve, 50));
    const committedFirst = await h.suspend(app, t.a.owner, t.a.tenantId, late.membershipId);
    assert.equal(committedFirst.status, 200);
    await conn`INSERT INTO public.audit_logs ${conn(h.auditRow({
      tenant_id: t.a.tenantId, actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId,
      request_id: gucs.request_id, entity_id: early.membershipId, outcome: 'denied', reason_code: 'membership_management_not_permitted',
      metadata_json: conn.json({ command: 'suspend' }),
    }))}`;
    await conn.unsafe('COMMIT');
  } finally {
    conn.release();
  }
  const [committedLater] = await h.auditsByRequest(gucs.request_id);
  const [committedEarlier] = await h.auditsForEntity(late.membershipId, 'membership.suspended');
  assert.ok(committedLater.created_at < committedEarlier.created_at, 'the row committed LAST carries the EARLIER created_at');
});

test('no lost or duplicated rows; catalog invariants hold', async () => {
  assert.deepEqual(await h.duplicateSuccessRows(), []);
  assert.deepEqual(await h.catalogViolations(), []);
  assert.deepEqual(h.scanAudits(await h.allAudits()), []);
});
