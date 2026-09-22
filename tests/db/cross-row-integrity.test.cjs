'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.cjs');

const { admin, id, begin, commit, rollback, inTx, fixture, makeTenant } = h;
let api;

const violation = (constraint, code = '23514') => (e) => {
  assert.equal(e.code, code, `expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
  if (constraint) assert.equal(e.constraint_name, constraint);
  return true;
};
const rlsDenied = (e) => {
  assert.equal(e.code, '42501', `expected RLS denial 42501, got ${e.code}: ${e.message}`);
  return true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await h.setupRoles();
  api = h.runtime('tallermecario_api');
  const [who] = await api`SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass`;
  assert.equal(who.u, 'tallermecario_api');
  assert.equal(who.bypass, false, 'tests must run as a NOBYPASSRLS runtime role');
});
test.after(async () => { await api.end(); await admin.end(); });

// ------------------------------------------------------------ 1. primary location
test.describe('1. exactly one primary workshop_location', () => {
  const newWorkshop = (t, c) => c`INSERT INTO workshops ${c({ id: t, slug: `w-${t}`, legal_name: 'T', display_name: 'T' })}`;
  const newLoc = async (t, c, primary, locId = id()) => {
    await c`INSERT INTO workshop_locations ${c({ id: locId, tenant_id: t, name: 'L', address_line: 'x', city: 'c', department: 'd', is_primary: primary })}`;
    return locId;
  };

  test('valid: workshop + primary location in one transaction commits', async () => {
    const t = id();
    await inTx(api, t, async (c) => { await newWorkshop(t, c); await newLoc(t, c, true); });
    const [r] = await admin`SELECT count(*)::int AS n FROM workshop_locations WHERE tenant_id = ${t} AND is_primary`;
    assert.equal(r.n, 1);
  });

  test('invalid: workshop without location is rejected AT COMMIT (statements succeed)', async () => {
    const t = id();
    const c = await begin(api, t);
    await newWorkshop(t, c); // no error here: the check is deferred
    await assert.rejects(c.unsafe('COMMIT'), violation('workshop_primary_location_required'));
    await rollback(c);
    assert.equal((await admin`SELECT 1 FROM workshops WHERE id = ${t}`).length, 0);
  });

  test('invalid: workshop with only a non-primary location is rejected at COMMIT', async () => {
    const t = id();
    const c = await begin(api, t);
    await newWorkshop(t, c);
    await newLoc(t, c, false);
    await assert.rejects(c.unsafe('COMMIT'), violation('workshop_primary_location_required'));
    await rollback(c);
  });

  test('invalid: two primaries rejected immediately by the partial UNIQUE (existing coverage)', async () => {
    const t = await makeTenant();
    const c = await begin(api, t.tenant);
    await assert.rejects(newLoc(t.tenant, c, true), violation('workshop_locations_one_primary_uq', '23505'));
    await rollback(c);
  });

  test('valid: swap primary (demote old, promote new) in one transaction', async () => {
    const t = await makeTenant();
    const other = id();
    await inTx(api, t.tenant, async (c) => {
      await newLoc(t.tenant, c, false, other);
      await c`UPDATE workshop_locations SET is_primary = false WHERE id = ${t.location}`;
      await c`UPDATE workshop_locations SET is_primary = true WHERE id = ${other}`;
    });
    const [r] = await admin`SELECT id FROM workshop_locations WHERE tenant_id = ${t.tenant} AND is_primary`;
    assert.equal(r.id, other);
  });

  test('invalid: demoting the only primary without replacement fails at COMMIT', async () => {
    const t = await makeTenant();
    const c = await begin(api, t.tenant);
    await c`UPDATE workshop_locations SET is_primary = false WHERE id = ${t.location}`;
    await assert.rejects(c.unsafe('COMMIT'), violation('workshop_primary_location_required'));
    await rollback(c);
  });

  test('invalid: deleting the primary without replacement fails at COMMIT (superuser: runtime has no DELETE grant)', async () => {
    const t = await makeTenant();
    const conn = await admin.reserve();
    await conn.unsafe('BEGIN');
    await conn`DELETE FROM workshop_locations WHERE id = ${t.location}`;
    await assert.rejects(conn.unsafe('COMMIT'), violation('workshop_primary_location_required'));
    await conn.unsafe('ROLLBACK').catch(() => {});
    conn.release();
  });

  test('valid: deleting a non-primary location, and deleting the primary after atomic replacement', async () => {
    const t = await makeTenant();
    const extra = id();
    const swap = id();
    await inTx(api, t.tenant, async (c) => { await newLoc(t.tenant, c, false, extra); await newLoc(t.tenant, c, false, swap); });
    await admin`DELETE FROM workshop_locations WHERE id = ${extra}`;
    await admin.begin(async (tx) => {
      await tx`UPDATE workshop_locations SET is_primary = false WHERE id = ${t.location}`;
      await tx`UPDATE workshop_locations SET is_primary = true WHERE id = ${swap}`;
      await tx`DELETE FROM workshop_locations WHERE id = ${t.location}`;
    });
    const [r] = await admin`SELECT count(*)::int AS n FROM workshop_locations WHERE tenant_id = ${t.tenant} AND is_primary`;
    assert.equal(r.n, 1);
  });

  test('cross-tenant: tenant B cannot create/alter tenant A locations', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const c = await begin(api, b.tenant);
    await assert.rejects(newLoc(a.tenant, c, false), rlsDenied);
    await rollback(c);
    const c2 = await begin(api, b.tenant);
    const res = await c2`UPDATE workshop_locations SET is_primary = false WHERE id = ${a.location}`;
    assert.equal(res.count, 0);
    await commit(c2);
  });
});

// ------------------------------------------------------------ 2. QC separation
test.describe('2. QC vs executing technician separation', () => {
  const assign = (c, t, order, member, type, extra = {}) => c`INSERT INTO assignments ${c({ id: id(), tenant_id: t, order_id: order, membership_id: member, assignment_type: type, assigned_by_membership_id: member, ...extra })}`;

  test('valid: different memberships as technician and QC', async () => {
    const t = await makeTenant({ withOrder: true });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, t.order, t.members[1], 'quality_control');
    });
  });

  for (const type of ['lead_technician', 'support_technician']) {
    test(`invalid: same membership ${type} then quality_control`, async () => {
      const t = await makeTenant({ withOrder: true });
      const c = await begin(api, t.tenant);
      await assign(c, t.tenant, t.order, t.members[0], type);
      await assert.rejects(assign(c, t.tenant, t.order, t.members[0], 'quality_control'), violation('assignments_qc_separation'));
      await rollback(c);
    });
    test(`invalid: same membership quality_control then ${type} (reverse order)`, async () => {
      const t = await makeTenant({ withOrder: true });
      const c = await begin(api, t.tenant);
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
      await assert.rejects(assign(c, t.tenant, t.order, t.members[0], type), violation('assignments_qc_separation'));
      await rollback(c);
    });
  }

  test('valid: same membership after releasing the technician assignment', async () => {
    const t = await makeTenant({ withOrder: true });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await c`UPDATE assignments SET released_at = now() + interval '1 second' WHERE tenant_id = ${t.tenant} AND membership_id = ${t.members[0]}`;
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
    });
  });

  test('invalid: re-activating a released assignment that would collide', async () => {
    const t = await makeTenant({ withOrder: true });
    const released = id();
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician', { id: released, assigned_at: new Date(Date.now() - 5000), released_at: new Date(Date.now() - 1000) });
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
    });
    const c = await begin(api, t.tenant);
    await assert.rejects(c`UPDATE assignments SET released_at = NULL WHERE id = ${released}`, violation('assignments_qc_separation'));
    await rollback(c);
  });

  test('valid: same membership on different orders', async () => {
    const t = await makeTenant({ withOrder: true });
    const order2 = id();
    const reception2 = id();
    await fixture(async (tx) => {
      await tx`INSERT INTO receptions ${tx({ id: reception2, tenant_id: t.tenant, vehicle_id: t.vehicle, customer_id: t.customer, received_by_membership_id: t.members[0], mileage_km: 2 })}`;
      await tx`INSERT INTO service_orders ${tx({ id: order2, tenant_id: t.tenant, reception_id: reception2, vehicle_id: t.vehicle, customer_id: t.customer, order_number: 2, created_by_membership_id: t.members[0] })}`;
    });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, order2, t.members[0], 'quality_control');
    });
  });

  test('valid (documented exception): sole active membership can hold both', async () => {
    const t = await makeTenant({ members: 1, withOrder: true });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
    });
  });

  test('exception counts only ACTIVE memberships: suspended peer -> allowed; active peer -> rejected', async () => {
    const t = await makeTenant({ members: 2, withOrder: true });
    await fixture(async (tx) => { await tx`UPDATE memberships SET status = 'suspended', suspended_at = now() WHERE id = ${t.members[1]}`; });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
    });
    const t2 = await makeTenant({ members: 2, withOrder: true });
    const c = await begin(api, t2.tenant);
    await assign(c, t2.tenant, t2.order, t2.members[0], 'lead_technician');
    await assert.rejects(assign(c, t2.tenant, t2.order, t2.members[0], 'quality_control'), violation('assignments_qc_separation'));
    await rollback(c);
  });

  test('race: concurrent technician + QC assignment for one membership cannot both commit', async () => {
    const t = await makeTenant({ withOrder: true });
    const c1 = await begin(api, t.tenant);
    const c2 = await begin(api, t.tenant);
    await assign(c1, t.tenant, t.order, t.members[0], 'lead_technician');
    const second = assign(c2, t.tenant, t.order, t.members[0], 'quality_control'); // blocks on advisory lock
    second.catch(() => {});
    await sleep(400);
    await commit(c1);
    await assert.rejects(second, violation('assignments_qc_separation'));
    await rollback(c2);
  });

  test('quality_checks: executing technician cannot be the checker; another member can', async () => {
    const t = await makeTenant({ withOrder: true });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, t.order, t.members[1], 'quality_control');
    });
    const qc = (c, who) => c`INSERT INTO quality_checks ${c({ id: id(), tenant_id: t.tenant, order_id: t.order, checked_by_membership_id: who })}`;
    const c = await begin(api, t.tenant);
    await assert.rejects(qc(c, t.members[0]), violation('quality_checks_separation_of_duties'));
    await rollback(c);
    await inTx(api, t.tenant, (c2) => qc(c2, t.members[1]));
  });

  test('quality_checks: checker needs an active quality_control assignment', async () => {
    const t = await makeTenant({ withOrder: true });
    const c = await begin(api, t.tenant);
    await assert.rejects(
      c`INSERT INTO quality_checks ${c({ id: id(), tenant_id: t.tenant, order_id: t.order, checked_by_membership_id: t.members[1] })}`,
      violation('quality_checks_active_assignment_required'),
    );
    await rollback(c);
  });

  test('quality_checks: sole active membership exception allows own QC', async () => {
    const t = await makeTenant({ members: 1, withOrder: true });
    await inTx(api, t.tenant, async (c) => {
      await assign(c, t.tenant, t.order, t.members[0], 'lead_technician');
      await assign(c, t.tenant, t.order, t.members[0], 'quality_control');
      await c`INSERT INTO quality_checks ${c({ id: id(), tenant_id: t.tenant, order_id: t.order, checked_by_membership_id: t.members[0] })}`;
    });
  });

  test('cross-tenant: tenant B cannot assign on tenant A order', async () => {
    const a = await makeTenant({ withOrder: true });
    const b = await makeTenant();
    const c = await begin(api, b.tenant);
    await assert.rejects(assign(c, a.tenant, a.order, a.members[0], 'lead_technician'), rlsDenied);
    await rollback(c);
  });
});

// ------------------------------------------------------------ 3. allocations
test.describe('3. SUM(allocations) <= customer_payment.amount', () => {
  async function payment(t, amount = 100000) {
    const p = id();
    await fixture(async (tx) => {
      await tx`INSERT INTO customer_payments ${tx({ id: p, tenant_id: t.tenant, customer_id: t.customer, payment_method: 'cash', status: 'confirmed', amount, confirmed_at: new Date(), recorded_by_membership_id: t.members[0] })}`;
    });
    return p;
  }
  const alloc = (c, t, p, amount) => c`INSERT INTO customer_payment_allocations ${c({ id: id(), tenant_id: t.tenant, customer_payment_id: p, order_id: t.order, allocated_amount: amount })}`;
  const total = async (p) => String((await admin`SELECT COALESCE(sum(allocated_amount), 0)::bigint AS s FROM customer_payment_allocations WHERE customer_payment_id = ${p}`)[0].s);

  test('valid: partial allocations summing exactly to the amount', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    await inTx(api, t.tenant, async (c) => { await alloc(c, t, p, 60000); await alloc(c, t, p, 40000); });
    assert.equal(await total(p), '100000');
  });

  test('invalid: single allocation above the amount', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    const c = await begin(api, t.tenant);
    await assert.rejects(alloc(c, t, p, 100001), violation('customer_payment_allocations_cap'));
    await rollback(c);
  });

  test('invalid: cumulative allocations above the amount (across transactions)', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    await inTx(api, t.tenant, (c) => alloc(c, t, p, 60000));
    const c = await begin(api, t.tenant);
    await assert.rejects(alloc(c, t, p, 40001), violation('customer_payment_allocations_cap'));
    await rollback(c);
    assert.equal(await total(p), '60000');
  });

  test('invalid: cumulative overflow inside one transaction', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    const c = await begin(api, t.tenant);
    await alloc(c, t, p, 70000);
    await assert.rejects(alloc(c, t, p, 30001), violation('customer_payment_allocations_cap'));
    await rollback(c);
  });

  test('invalid: privileged UPDATE of an allocation cannot bypass the cap', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    await inTx(api, t.tenant, (c) => alloc(c, t, p, 50000));
    await assert.rejects(
      admin`UPDATE customer_payment_allocations SET allocated_amount = 100001 WHERE customer_payment_id = ${p}`,
      violation('customer_payment_allocations_cap'),
    );
  });

  test('payment.amount: lowering below allocated is rejected; lowering to exactly the sum is valid', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    await inTx(api, t.tenant, (c) => alloc(c, t, p, 80000));
    const c = await begin(api, t.tenant);
    try {
      await assert.rejects(c`UPDATE customer_payments SET amount = 79999 WHERE id = ${p}`, violation('customer_payment_allocations_cap'));
    } finally {
      await rollback(c);
    }
    await inTx(api, t.tenant, (c2) => c2`UPDATE customer_payments SET amount = 80000 WHERE id = ${p}`);
  });

  test('valid: each payment has its own budget', async () => {
    const t = await makeTenant({ withOrder: true });
    const p1 = await payment(t, 1000);
    const p2 = await payment(t, 1000);
    await inTx(api, t.tenant, async (c) => { await alloc(c, t, p1, 1000); await alloc(c, t, p2, 1000); });
  });

  test('race: two concurrent allocations that fit alone but overflow together -> one is rejected', async () => {
    const t = await makeTenant({ withOrder: true });
    const p = await payment(t);
    const c1 = await begin(api, t.tenant);
    const c2 = await begin(api, t.tenant);
    await alloc(c1, t, p, 60000);
    const second = alloc(c2, t, p, 60000); // waits for the payment row lock
    second.catch(() => {});
    await sleep(400);
    await commit(c1);
    await assert.rejects(second, violation('customer_payment_allocations_cap'));
    await rollback(c2);
    assert.equal(await total(p), '60000');
  });

  test('cross-tenant: tenant B cannot allocate against tenant A payment', async () => {
    const a = await makeTenant({ withOrder: true });
    const b = await makeTenant({ withOrder: true });
    const p = await payment(a);
    const c = await begin(api, b.tenant);
    await assert.rejects(alloc(c, a, p, 1), rlsDenied);
    await rollback(c);
    const c2 = await begin(api, b.tenant);
    await assert.rejects(c2`INSERT INTO customer_payment_allocations ${c2({ id: id(), tenant_id: b.tenant, customer_payment_id: p, order_id: b.order, allocated_amount: 1 })}`, violation(null, '23503'));
    await rollback(c2);
  });
});

// ------------------------------------------------------------ 4. stock never negative
test.describe('4. inventory balance never negative (covered by CHECK ib_quantity_check; no trigger)', () => {
  async function balance(t, qty) {
    const item = id();
    const bal = id();
    await fixture(async (tx) => {
      await tx`INSERT INTO catalog_items ${tx({ id: item, tenant_id: t.tenant, item_type: 'part', name: 'Filtro', default_unit_price: 1000, track_inventory: true })}`;
      await tx`INSERT INTO inventory_balances ${tx({ id: bal, tenant_id: t.tenant, catalog_item_id: item, location_id: t.location, quantity_on_hand: qty })}`;
    });
    return { item, bal };
  }
  const outMovement = (c, t, item, qty) => c`INSERT INTO inventory_movements ${c({ id: id(), tenant_id: t.tenant, catalog_item_id: item, location_id: t.location, movement_type: 'adjustment_out', quantity_delta: `-${qty}`, reason: 'test', performed_by_membership_id: t.members[0] })}`;

  test('valid: movement + balance update down to exactly zero', async () => {
    const t = await makeTenant();
    const { item, bal } = await balance(t, '5');
    await inTx(api, t.tenant, async (c) => {
      await outMovement(c, t, item, '5');
      await c`UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand - 5, version = version + 1 WHERE id = ${bal}`;
    });
    const [r] = await admin`SELECT quantity_on_hand FROM inventory_balances WHERE id = ${bal}`;
    assert.equal(Number(r.quantity_on_hand), 0);
  });

  test('invalid: balance below zero is rejected and the movement rolls back with it', async () => {
    const t = await makeTenant();
    const { item, bal } = await balance(t, '2');
    const c = await begin(api, t.tenant);
    await outMovement(c, t, item, '3');
    await assert.rejects(c`UPDATE inventory_balances SET quantity_on_hand = quantity_on_hand - 3 WHERE id = ${bal}`, violation('ib_quantity_check'));
    await rollback(c);
    const [r] = await admin`SELECT quantity_on_hand, (SELECT count(*)::int FROM inventory_movements WHERE catalog_item_id = ${item}) AS mv FROM inventory_balances WHERE id = ${bal}`;
    assert.equal(Number(r.quantity_on_hand), 2);
    assert.equal(r.mv, 0);
  });

  test('invalid: a fractional negative balance (insert and update)', async () => {
    const t = await makeTenant();
    const { item } = await balance(t, '1');
    const c = await begin(api, t.tenant);
    await assert.rejects(c`INSERT INTO inventory_balances ${c({ id: id(), tenant_id: t.tenant, catalog_item_id: item, location_id: t.location, quantity_on_hand: '-0.0001' })}`, (e) => ['23514', '23505'].includes(e.code));
    await rollback(c);
    const c2 = await begin(api, t.tenant);
    await assert.rejects(c2`UPDATE inventory_balances SET quantity_on_hand = -0.0001 WHERE catalog_item_id = ${item}`, violation('ib_quantity_check'));
    await rollback(c2);
  });

  test('cross-tenant: tenant B cannot touch tenant A balance', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { bal } = await balance(a, '9');
    const c = await begin(api, b.tenant);
    const res = await c`UPDATE inventory_balances SET quantity_on_hand = 0 WHERE id = ${bal}`;
    assert.equal(res.count, 0);
    await commit(c);
  });
});

// ------------------------------------------------------------ 5. partially_approved
test.describe('5. partially_approved needs an approved line and a rejected/reduced line', () => {
  async function quote(t) {
    const q = id();
    const v = id();
    const items = [id(), id()];
    await fixture(async (tx) => {
      await tx`INSERT INTO quotes ${tx({ id: q, tenant_id: t.tenant, order_id: t.order, status: 'awaiting_authorization', created_by_membership_id: t.members[0] })}`;
      await tx`INSERT INTO quote_versions ${tx({ id: v, tenant_id: t.tenant, quote_id: q, order_id: t.order, version_number: 1, subtotal_amount: 2000, total_amount: 2000, created_by_membership_id: t.members[0], sent_at: new Date() })}`;
      for (const [i, qi] of items.entries()) {
        await tx`INSERT INTO quote_items ${tx({ id: qi, tenant_id: t.tenant, quote_version_id: v, order_id: t.order, sales_originator_membership_id: t.members[0], item_type: 'labor', name_snapshot: `L${i}`, quantity: '2', unit_price: 1000, line_total: 2000, sort_order: i })}`;
      }
    });
    return { q, v, items };
  }
  const authorize = async (c, t, qt, decision, lines) => {
    const a = id();
    await c`INSERT INTO quote_authorizations ${c({ id: a, tenant_id: t.tenant, quote_version_id: qt.v, decision, authorized_amount: decision === 'rejected' ? null : 1000, customer_name: 'Cliente', channel: 'manual_in_person', recorded_by_membership_id: t.members[0], authorized_at: new Date() })}`;
    for (const [i, [d, qty]] of lines.entries()) {
      await c`INSERT INTO quote_authorization_items ${c({ id: id(), tenant_id: t.tenant, authorization_id: a, quote_version_id: qt.v, quote_item_id: qt.items[i], decision: d, authorized_quantity: qty ?? null })}`;
    }
    return a;
  };
  const ctx = async () => {
    const t = await makeTenant({ withOrder: true });
    return [t, await quote(t)];
  };

  test('valid: one approved + one rejected line', async () => {
    const [t, qt] = await ctx();
    await inTx(api, t.tenant, (c) => authorize(c, t, qt, 'partially_approved', [['approved', '2'], ['rejected']]));
  });

  test('valid: approved line with reduced quantity counts as adjusted (Dic. 02 §15 "rejected/quantity reducida")', async () => {
    const [t, qt] = await ctx();
    await inTx(api, t.tenant, (c) => authorize(c, t, qt, 'partially_approved', [['approved', '1'], ['approved', '2']]));
  });

  test('invalid: only fully approved lines -> fails AT COMMIT (row inserts succeed first)', async () => {
    const [t, qt] = await ctx();
    const c = await begin(api, t.tenant);
    await authorize(c, t, qt, 'partially_approved', [['approved', '2'], ['approved', '2']]);
    await assert.rejects(c.unsafe('COMMIT'), violation('quote_authorizations_partial_lines'));
    await rollback(c);
    assert.equal((await admin`SELECT 1 FROM quote_authorizations WHERE quote_version_id = ${qt.v}`).length, 0);
  });

  test('invalid: only rejected lines -> fails at COMMIT', async () => {
    const [t, qt] = await ctx();
    const c = await begin(api, t.tenant);
    await authorize(c, t, qt, 'partially_approved', [['rejected'], ['rejected']]);
    await assert.rejects(c.unsafe('COMMIT'), violation('quote_authorizations_partial_lines'));
    await rollback(c);
  });

  test('invalid: no lines at all -> fails at COMMIT', async () => {
    const [t, qt] = await ctx();
    const c = await begin(api, t.tenant);
    await authorize(c, t, qt, 'partially_approved', []);
    await assert.rejects(c.unsafe('COMMIT'), violation('quote_authorizations_partial_lines'));
    await rollback(c);
  });

  test('other decisions are not constrained by this trigger (approved / rejected commit)', async () => {
    const [t1, q1] = await ctx();
    const [t2, q2] = await ctx();
    await inTx(api, t1.tenant, (c) => authorize(c, t1, q1, 'approved', [['approved', '2'], ['approved', '2']]));
    await inTx(api, t2.tenant, (c) => authorize(c, t2, q2, 'rejected', [['rejected'], ['rejected']]));
  });

  test('existing coverage: second authorization for the same version violates qa_one_per_version_key', async () => {
    const [t, qt] = await ctx();
    await inTx(api, t.tenant, (c) => authorize(c, t, qt, 'rejected', []));
    const c = await begin(api, t.tenant);
    await assert.rejects(authorize(c, t, qt, 'rejected', []), violation('qa_one_per_version_key', '23505'));
    await rollback(c);
  });

  test('cross-tenant: tenant B cannot authorize tenant A quote version', async () => {
    const [a, qa] = await ctx();
    const b = await makeTenant({ withOrder: true });
    const c = await begin(api, b.tenant);
    await assert.rejects(authorize(c, a, qa, 'rejected', []), rlsDenied);
    await rollback(c);
  });
});
