'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');

const url = new URL(process.env.TEST_DATABASE_URL_ADMIN || 'postgresql://invalid');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  || !url.pathname.startsWith('/tm_test_reception_')) throw new Error('RECEPTION_DISPOSABLE_DATABASE_REQUIRED');
const admin = postgres(url.toString(), { max: 4, onnotice: () => {} });
function runtime(login, password, role) {
  if (!login?.startsWith('tm_test_reception') || !password) throw new Error('RECEPTION_RUNTIME_REQUIRED');
  const target = new URL(url);
  target.username = login;
  target.password = password;
  return postgres(target.toString(), { max: 4, onnotice: () => {}, connection: { role } });
}
const api = runtime(process.env.TEST_API_LOGIN, process.env.TEST_API_PASSWORD, 'tallermecario_api');
const worker = runtime(process.env.TEST_WORKER_LOGIN, process.env.TEST_WORKER_PASSWORD, 'tallermecario_worker');
const id = () => randomUUID();
const a = { tenant: id(), customer: id(), otherCustomer: id(), vehicle: id(), member: id(), consent: id(),
  otherConsent: id() };
const b = { tenant: id(), customer: id(), vehicle: id(), member: id(), consent: id() };
/** S3-04.5: each customer's granted service_provision consent (privileged fixture). */
const consentOf = { [a.customer]: a.consent, [a.otherCustomer]: a.otherConsent, [b.customer]: b.consent };

async function begin(sql, tenant) {
  const c = await sql.reserve();
  await c.unsafe('BEGIN');
  if (tenant) await c`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  return c;
}
async function end(c, commit = false) {
  try { await c.unsafe(commit ? 'COMMIT' : 'ROLLBACK'); } finally { c.release(); }
}
async function scoped(sql, tenant, fn) {
  const c = await begin(sql, tenant);
  try { const out = await fn(c); await end(c, true); return out; }
  catch (e) { await end(c); throw e; }
}
function failure(code, constraint) {
  return (e) => {
    assert.equal(e.code, code, e.message);
    if (constraint) assert.equal(e.constraint_name || e.constraint, constraint, e.message);
    return true;
  };
}
async function reception(c, tenant = a.tenant, vehicle = a.vehicle, customer = a.customer,
  extra = {}) {
  const key = id();
  await c`INSERT INTO receptions ${c({ id: key, tenant_id: tenant, vehicle_id: vehicle,
    customer_id: customer, privacy_consent_id: consentOf[customer] ?? a.consent,
    received_by_membership_id: a.member, mileage_km: 0, ...extra })}`;
  return key;
}
/** D-PRIV-03: a reception vehicle needs a current primary owner. */
async function own(c, vehicleId, customerId = a.customer, tenant = a.tenant) {
  await c`INSERT INTO vehicle_owners ${c({ id: id(), tenant_id: tenant, vehicle_id: vehicleId,
    customer_id: customerId, relationship_type: 'owner', is_primary: true })}`;
}
async function newVehicle(mileage = 0) {
  const key = id();
  await scoped(api, a.tenant, async (c) => {
    await c`INSERT INTO vehicles ${c({ id: key,
      tenant_id: a.tenant, plate: `R${key.slice(0, 6).toUpperCase()}`,
      vehicle_type: 'car', brand: 'B', model: 'M', current_mileage_km: mileage })}`;
    await own(c, key);
  });
  return key;
}
async function media(c, tenant = a.tenant, type = 'signature', status = 'active') {
  const key = id();
  await c`INSERT INTO media_assets ${c({ id: key, tenant_id: tenant, bucket: 'test',
    object_key: key, media_type: type, mime_type: 'image/png', status,
    retention_class: 'operational', retention_policy_version: 'v1' })}`;
  return key;
}
async function signature(c, receptionId, mediaId, extra = {}) {
  const key = id();
  await c`INSERT INTO signatures ${c({ id: key, tenant_id: a.tenant, reception_id: receptionId,
    signed_by_name: 'Customer', signature_media_id: mediaId, signed_at: new Date(),
    document_version: 'v1', document_hash: 'a'.repeat(64), ...extra })}`;
  return key;
}
async function closeWithOrder(c, receptionId, number = 1n, vehicleId = a.vehicle) {
  const order = id();
  await c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${receptionId}`;
  await c`INSERT INTO service_orders ${c({ id: order, tenant_id: a.tenant,
    reception_id: receptionId, vehicle_id: vehicleId, customer_id: a.customer,
    order_number: number, created_by_membership_id: a.member })}`;
  await c`INSERT INTO order_status_history ${c({ id: id(), tenant_id: a.tenant,
    order_id: order, from_status: null, to_status: 'reception',
    changed_by_membership_id: a.member, request_id: id() })}`;
  return order;
}
async function blockedBy(waiter, holder) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [r] = await admin`SELECT pg_blocking_pids(${waiter}) AS blockers`;
    if (r.blockers.includes(holder)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('expected PostgreSQL row lock wait');
}

test.before(async () => {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const t of [a, b]) {
      const user = id();
      await tx`INSERT INTO workshops ${tx({ id: t.tenant, slug: `rec-${t.tenant}`,
        legal_name: 'Test', display_name: 'Test' })}`;
      await tx`INSERT INTO users ${tx({ id: user, external_subject: user,
        email: `${user}@example.test` })}`;
      await tx`INSERT INTO memberships ${tx({ id: t.member, tenant_id: t.tenant, user_id: user })}`;
      await tx`INSERT INTO customers ${tx({ id: t.customer, tenant_id: t.tenant,
        first_name: 'A', last_name: 'B', phone: '3000000000' })}`;
      await tx`INSERT INTO vehicles ${tx({ id: t.vehicle, tenant_id: t.tenant,
        plate: `R${t.vehicle.slice(0, 6).toUpperCase()}`, vehicle_type: 'car',
        brand: 'B', model: 'M', current_mileage_km: 0 })}`;
    }
    await tx`INSERT INTO customers ${tx({ id: a.otherCustomer, tenant_id: a.tenant,
      first_name: 'Other', last_name: 'Customer', phone: '3000000001' })}`;
    for (const [t, customer, consent] of [[a, a.customer, a.consent], [a, a.otherCustomer, a.otherConsent],
      [b, b.customer, b.consent]]) {
      await tx`INSERT INTO privacy_consents ${tx({ id: consent, tenant_id: t.tenant, customer_id: customer,
        purpose_code: 'service_provision', privacy_notice_version: 'test-notice-1',
        authorization_text_version: 'test-service-1', authorization_text_hash: 'f'.repeat(64),
        controller_notice_snapshot: tx.json({ legalName: 'TEST-ONLY', address: 'TEST-ONLY',
          phone: '+5700000000', email: null, rightsChannel: 'TEST-ONLY' }),
        channel: 'in_person', captured_at: new Date(), created_at: new Date(Date.now() - 60_000) })}`;
    }
    for (const t of [a, b]) {
      await tx`INSERT INTO vehicle_owners ${tx({ id: id(), tenant_id: t.tenant, vehicle_id: t.vehicle,
        customer_id: t.customer, relationship_type: 'owner', is_primary: true })}`;
    }
  });
});
test.after(async () => { await Promise.all([api.end({ timeout: 5 }), worker.end({ timeout: 5 }), admin.end({ timeout: 5 })]); });

test('catalog, grants and RLS enforce tenant boundary', async () => {
  const [roles] = await admin`SELECT bool_or(rolbypassrls) AS bypass FROM pg_roles
    WHERE rolname IN ('tallermecario_api','tallermecario_worker')`;
  assert.equal(roles.bypass, false);
  for (const table of ['receptions','reception_check_items','vehicle_damages','signatures',
    'service_orders','order_status_history']) {
    const [r] = await admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid=${`public.${table}`}::regclass`;
    assert.equal(r.relrowsecurity, true);
    assert.equal(r.relforcerowsecurity, true);
    for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
      const [p] = await admin`SELECT has_table_privilege('tallermecario_worker',
        ${`public.${table}`}, ${privilege}) AS allowed`;
      assert.equal(p.allowed, false, `worker ${table} ${privilege}`);
    }
    for (const privilege of ['DELETE','TRUNCATE']) {
      const [p] = await admin`SELECT has_table_privilege('tallermecario_api',
        ${`public.${table}`}, ${privilege}) AS allowed`;
      assert.equal(p.allowed, false, `api ${table} ${privilege}`);
    }
  }
  for (const table of ['receptions','reception_check_items','vehicle_damages','signatures','service_orders']) {
    const [p] = await admin`SELECT has_table_privilege('tallermecario_api',
      ${`public.${table}`}, 'UPDATE') AS allowed`;
    assert.equal(p.allowed, false, `api table UPDATE ${table}`);
  }
  for (const [table, column, allowed] of [
    ['receptions', 'status', true], ['receptions', 'vehicle_id', false],
    ['reception_check_items', 'notes', true], ['reception_check_items', 'reception_id', false],
    ['vehicle_damages', 'description', true], ['vehicle_damages', 'reception_id', false],
    ['signatures', 'document_hash', false], ['service_orders', 'status', true],
    ['service_orders', 'customer_id', false],
  ]) {
    const [p] = await admin`SELECT has_column_privilege('tallermecario_api',
      ${`public.${table}`}, ${column}, 'UPDATE') AS allowed`;
    assert.equal(p.allowed, allowed, `${table}.${column}`);
  }
  await assert.rejects(worker`SELECT id FROM receptions`, failure('42501'));
});

test('open reception values, cross-tenant FKs and D-PRIV-03 owner-only customer', async () => {
  // S3-04.5 deliberately hardens S3-02/S3-03: an unrelated same-tenant customer
  // (with its own valid consent) is no longer accepted; only the current owner.
  await assert.rejects(scoped(api, a.tenant, (c) => reception(c, a.tenant, a.vehicle, a.otherCustomer)),
    failure('23514', 'receptions_current_owner_guard'));
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, a.vehicle, a.customer,
    { mileage_km: 0, fuel_level_pct: 0 }));
  const [row] = await scoped(api, a.tenant, (c) => c`SELECT status, fuel_level_pct FROM receptions WHERE id=${r}`);
  assert.equal(row.status, 'open');
  assert.equal(row.fuel_level_pct, 0);
  await scoped(api, a.tenant, (c) => c`UPDATE receptions SET fuel_level_pct=100 WHERE id=${r}`);
  for (const [extra, constraint] of [
    [{ mileage_km: -1 }, 'receptions_mileage_check'],
    [{ fuel_level_pct: -1 }, 'receptions_fuel_check'],
    [{ fuel_level_pct: 101 }, 'receptions_fuel_check'],
    // A foreign customer is never the owner of a tenant vehicle: the owner
    // backstop fires before the (AFTER) composite FK check.
    [{ customer_id: b.customer }, 'receptions_current_owner_guard'],
    [{ vehicle_id: b.vehicle }, 'receptions_vehicle_fk'],
  ]) {
    const vehicleId = extra.vehicle_id || await newVehicle();
    await assert.rejects(scoped(api, a.tenant, (c) => reception(c, a.tenant,
      vehicleId, extra.customer_id || a.customer, extra)),
    (e) => { assert.ok(['23503','23514'].includes(e.code));
      assert.equal(e.constraint_name, constraint); return true; });
  }
  assert.equal((await scoped(api, b.tenant, (c) => c`SELECT id FROM receptions WHERE id=${r}`)).length, 0);
  assert.equal((await scoped(api, b.tenant, (c) => c`UPDATE receptions SET advisor_notes='x' WHERE id=${r}`)).count, 0);
  assert.equal((await scoped(api, b.tenant, (c) => c`SELECT id FROM receptions WHERE id=${r} FOR UPDATE`)).length, 0);
});

test('two concurrent open creates serialize on the vehicle lock; partial UNIQUE decides; later closed history', async () => {
  const v = id();
  await scoped(api, a.tenant, async (c) => {
    await c`INSERT INTO vehicles ${c({ id: v, tenant_id: a.tenant,
      plate: `R${v.slice(0, 6).toUpperCase()}`, vehicle_type: 'car', brand: 'B', model: 'M' })}`;
    await own(c, v);
  });
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstDone = false, secondDone = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    const r = await reception(first, a.tenant, v);
    const losing = Promise.resolve(reception(second, a.tenant, v)).then(() => null, (e) => e);
    await blockedBy(p2.pid, p1.pid);
    await end(first, true); firstDone = true;
    failure('23505', 'receptions_one_open_vehicle_uq')(await losing);
    await end(second); secondDone = true;
    const [count] = await admin`SELECT count(*)::int AS n FROM receptions WHERE vehicle_id=${v} AND status='open'`;
    assert.equal(count.n, 1);
    const m = await scoped(api, a.tenant, (c) => media(c));
    await scoped(api, a.tenant, (c) => signature(c, r, m));
    await scoped(api, a.tenant, (c) => c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`)
      .then(() => assert.fail('close without order committed'), failure('23514', 'receptions_order_required'));
    await scoped(api, a.tenant, async (c) => {
      await c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`;
      const order = id();
      await c`INSERT INTO service_orders ${c({ id: order, tenant_id: a.tenant,
        reception_id: r, vehicle_id: v, customer_id: a.customer,
        order_number: 101n, created_by_membership_id: a.member })}`;
      await c`INSERT INTO order_status_history ${c({ id: id(), tenant_id: a.tenant,
        order_id: order, to_status: 'reception', request_id: id() })}`;
    });
    await scoped(api, a.tenant, (c) => reception(c, a.tenant, v));
  } finally {
    if (!firstDone) await end(first).catch(() => undefined);
    if (!secondDone) await end(second).catch(() => undefined);
  }
});

test('signature evidence, media guard, append-only and close lifecycle', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions
    SET status='closed', closed_at=now() WHERE id=${r}`),
  failure('23514', 'receptions_signature_required'));
  const good = await scoped(api, a.tenant, (c) => media(c));
  const wrongType = await scoped(api, a.tenant, (c) => media(c, a.tenant, 'photo'));
  const pending = await scoped(api, a.tenant, (c) => media(c, a.tenant, 'signature', 'pending_upload'));
  const foreign = await scoped(api, b.tenant, (c) => media(c, b.tenant));
  const deleted = await scoped(api, a.tenant, async (c) => {
    const key = await media(c);
    await c`UPDATE media_assets SET deleted_at=now() WHERE id=${key}`;
    return key;
  });
  const purged = await scoped(api, a.tenant, async (c) => {
    const key = await media(c);
    await c`UPDATE media_assets SET deleted_at=now(), purged_at=now() WHERE id=${key}`;
    return key;
  });
  for (const [mediaId, constraint] of [[wrongType,'signatures_media_guard'],
    [pending,'signatures_media_guard'],[foreign,'signatures_media_guard'],
    [deleted,'signatures_media_guard'],[purged,'signatures_media_guard']]) {
    await assert.rejects(scoped(api, a.tenant, (c) => signature(c, r, mediaId)),
      failure('23514', constraint));
  }
  await assert.rejects(scoped(api, a.tenant, (c) => signature(c, r, good,
    { document_hash: '' })), failure('23514', 'signatures_acceptance_evidence_check'));
  await assert.rejects(scoped(api, a.tenant, (c) => signature(c, r, good,
    { delivery_id: id() })), failure('23514', 'signatures_parent_xor_check'));
  const sig = await scoped(api, a.tenant, (c) => signature(c, r, good));
  await assert.rejects(scoped(api, a.tenant, (c) => signature(c, r, good)),
    failure('23505', 'signatures_one_reception_uq'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE signatures SET signed_by_name='X' WHERE id=${sig}`), failure('42501'));
  await assert.rejects(admin`UPDATE signatures SET document_hash=${'b'.repeat(64)} WHERE id=${sig}`,
    failure('23514', 'signatures_append_only_guard'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`DELETE FROM signatures WHERE id=${sig}`), failure('42501'));
  const [signatureBefore] = await admin`SELECT row_to_json(s)::text AS snapshot FROM signatures s WHERE id=${sig}`;
  await scoped(api, a.tenant, (c) => c`UPDATE media_assets SET status='quarantined' WHERE id=${good}`);
  const [quarantined] = await admin`SELECT status,object_key FROM media_assets WHERE id=${good}`;
  assert.deepEqual([quarantined.status, quarantined.object_key], ['quarantined', good]);
  const [signatureAfter] = await admin`SELECT row_to_json(s)::text AS snapshot FROM signatures s WHERE id=${sig}`;
  assert.equal(signatureAfter.snapshot, signatureBefore.snapshot);
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE media_assets SET status='active' WHERE id=${good}`),
    failure('23514', 'signatures_media_guard'));
  for (const [column, value] of [
    ['object_key', id()], ['checksum_sha256', 'b'.repeat(64)], ['media_type', 'photo'],
    ['deleted_at', new Date()], ['purged_at', new Date()], ['bucket', 'other'],
    ['storage_provider', 'other'], ['mime_type', 'image/jpeg'], ['size_bytes', 12],
  ]) {
    await assert.rejects(scoped(api, a.tenant, (c) => c.unsafe(
      `UPDATE media_assets SET ${column}=$1 WHERE id=$2`, [value, good])),
    failure('23514', 'signatures_media_guard'));
  }
  await assert.rejects(admin`DELETE FROM media_assets WHERE id=${good}`,
    failure('23503', 'signatures_media_fk'));
  await scoped(api, a.tenant, (c) => c`UPDATE media_assets SET retention_policy_version='v2' WHERE id=${good}`);
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions SET status='cancelled', closed_at=now() WHERE id=${r}`),
    failure('23514', 'receptions_lifecycle_guard'));
  const order = await scoped(api, a.tenant, (c) => closeWithOrder(c, r, 1n, vehicleId));
  assert.ok(order);
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions SET status='open', closed_at=NULL WHERE id=${r}`),
    failure('23514', 'receptions_lifecycle_guard'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions SET customer_notes='late' WHERE id=${r}`),
    failure('23514', 'receptions_lifecycle_guard'));
  for (const table of ['reception_check_items','vehicle_damages']) {
    await assert.rejects(scoped(api, a.tenant, (c) => c.unsafe(
      `INSERT INTO ${table} (id,tenant_id,reception_id,${table === 'reception_check_items'
        ? 'code,label,status' : 'zone_code,damage_type'}) VALUES ($1,$2,$3,${table === 'reception_check_items'
        ? "'x','X','ok'" : "'front','scratch'"})`, [id(), a.tenant, r])),
    failure('23514', 'reception_child_parent_guard'));
  }
  await assert.rejects(scoped(api, a.tenant, (c) => signature(c, r,
    id())), failure('23514', 'reception_signature_parent_guard'));
});

test('children can change while open; child/close race cannot write after closure', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  const m = await scoped(api, a.tenant, (c) => media(c));
  await scoped(api, a.tenant, (c) => signature(c, r, m));
  const check = id(), damage = id();
  await scoped(api, a.tenant, async (c) => {
    await c`INSERT INTO reception_check_items ${c({ id: check, tenant_id: a.tenant,
      reception_id: r, code: 'lights', label: 'Lights', status: 'ok' })}`;
    await c`INSERT INTO vehicle_damages ${c({ id: damage, tenant_id: a.tenant,
      reception_id: r, zone_code: 'front', damage_type: 'scratch' })}`;
    await c`UPDATE reception_check_items SET notes='seen' WHERE id=${check}`;
    await c`UPDATE vehicle_damages SET description='seen' WHERE id=${damage}`;
  });
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstDone = false, secondDone = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    await first`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`;
    const waiting = Promise.resolve(second`UPDATE reception_check_items SET notes='late' WHERE id=${check}`)
      .then(() => null, (e) => e);
    await blockedBy(p2.pid, p1.pid);
    const order = id();
    await first`INSERT INTO service_orders ${first({ id: order, tenant_id: a.tenant,
      reception_id: r, vehicle_id: vehicleId, customer_id: a.customer,
      order_number: 202n, created_by_membership_id: a.member })}`;
    await first`INSERT INTO order_status_history ${first({ id: id(), tenant_id: a.tenant,
      order_id: order, to_status: 'reception', request_id: id() })}`;
    await end(first, true); firstDone = true;
    failure('23514', 'reception_child_parent_guard')(await waiting);
    await end(second); secondDone = true;
  } finally {
    if (!firstDone) await end(first).catch(() => undefined);
    if (!secondDone) await end(second).catch(() => undefined);
  }
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE vehicle_damages SET description='late' WHERE id=${damage}`),
    failure('23514', 'reception_child_parent_guard'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE reception_check_items SET notes='late' WHERE id=${check}`),
    failure('23514', 'reception_child_parent_guard'));
  await assert.rejects(admin`DELETE FROM vehicle_damages WHERE id=${damage}`,
    failure('23514', 'reception_child_parent_guard'));
});

test('mileage and service order lineage/initial history are guarded', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE vehicles SET current_mileage_km=1 WHERE id=${vehicleId}`),
    failure('23514', 'receptions_vehicle_mileage_guard'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions SET mileage_km=-1 WHERE id=${r}`),
    failure('23514', 'receptions_mileage_check'));
  await scoped(api, a.tenant, (c) => c`UPDATE receptions SET mileage_km=10 WHERE id=${r}`);
  await scoped(api, a.tenant, (c) => c`UPDATE vehicles SET current_mileage_km=10 WHERE id=${vehicleId}`);
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE receptions SET mileage_km=9 WHERE id=${r}`),
    failure('23514', 'receptions_vehicle_mileage_guard'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`INSERT INTO service_orders ${c({
    id: id(), tenant_id: a.tenant, reception_id: r, vehicle_id: vehicleId,
    customer_id: a.customer, order_number: 303n, created_by_membership_id: a.member })}`),
  failure('23514', 'service_orders_reception_guard'));
  const m = await scoped(api, a.tenant, (c) => media(c));
  await scoped(api, a.tenant, (c) => signature(c, r, m));
  await assert.rejects(scoped(api, a.tenant, async (c) => {
    await c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`;
    await c`INSERT INTO service_orders ${c({ id: id(), tenant_id: a.tenant,
      reception_id: r, vehicle_id: vehicleId, customer_id: a.otherCustomer,
      order_number: 304n, created_by_membership_id: a.member })}`;
  }), failure('23503', 'service_orders_reception_lineage_fk'));
  await assert.rejects(scoped(api, a.tenant, async (c) => {
    await c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`;
    await c`INSERT INTO service_orders ${c({ id: id(), tenant_id: a.tenant,
      reception_id: r, vehicle_id: vehicleId, customer_id: a.customer,
      order_number: 307n, created_by_membership_id: a.member })}`;
  }), failure('23514', 'service_orders_initial_history_guard'));
  for (const [status, version, closedAt] of [
    ['delivered', 7, new Date()], ['diagnosis', 1, null],
    ['reception', 2, null], ['reception', 1, new Date()],
  ]) {
    await assert.rejects(scoped(api, a.tenant, async (c) => {
      await c`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`;
      await c`INSERT INTO service_orders ${c({ id: id(), tenant_id: a.tenant,
        reception_id: r, vehicle_id: vehicleId, customer_id: a.customer,
        order_number: 400n, created_by_membership_id: a.member,
        status, version, closed_at: closedAt })}`;
    }), failure('23514', 'service_orders_initial_state_guard'));
  }
  const order = await scoped(api, a.tenant, (c) => closeWithOrder(c, r, 305n, vehicleId));
  const [initial] = await scoped(api, a.tenant, (c) => c`SELECT status,version,closed_at
    FROM service_orders WHERE id=${order}`);
  assert.deepEqual([initial.status, initial.version, initial.closed_at], ['reception', 1, null]);
  await scoped(api, a.tenant, (c) => c`UPDATE service_orders SET status='diagnosis',version=2 WHERE id=${order}`);
  await assert.rejects(scoped(api, a.tenant, (c) => c`INSERT INTO order_status_history ${c({
    id: id(), tenant_id: a.tenant, order_id: order, to_status: 'reception', request_id: id() })}`),
  failure('23505', 'osh_one_initial_reception_uq'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`INSERT INTO service_orders ${c({
    id: id(), tenant_id: a.tenant, reception_id: r, vehicle_id: vehicleId,
    customer_id: a.customer, order_number: 306n, created_by_membership_id: a.member })}`),
  failure('23505', 'service_orders_reception_key'));
  const secondVehicle = await newVehicle();
  const secondReception = await scoped(api, a.tenant,
    (c) => reception(c, a.tenant, secondVehicle));
  const secondMedia = await scoped(api, a.tenant, (c) => media(c));
  await scoped(api, a.tenant, (c) => signature(c, secondReception, secondMedia));
  await assert.rejects(scoped(api, a.tenant, (c) => closeWithOrder(c,
    secondReception, 305n, secondVehicle)),
  failure('23505', 'service_orders_number_key'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE service_orders SET customer_id=${a.otherCustomer} WHERE id=${order}`),
    failure('42501'));
});

test('direct closed INSERT fails the birth-state guard even with closure fields', async () => {
  const vehicleId = await newVehicle();
  await assert.rejects(scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId,
    a.customer, { status: 'closed', closed_at: new Date() })),
  failure('23514', 'receptions_lifecycle_guard'));
  assert.equal((await admin`SELECT id FROM receptions WHERE vehicle_id=${vehicleId}`).length, 0);
});

test('NULL vehicle mileage has no historical lower bound', async () => {
  const vehicleId = await newVehicle(null);
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId,
    a.customer, { mileage_km: 0 }));
  assert.ok(r);
});

test('signature media is single-use across receptions and delivery and runtime cannot truncate signatures', async () => {
  const firstVehicle = await newVehicle(), secondVehicle = await newVehicle();
  const firstReception = await scoped(api, a.tenant, (c) => reception(c, a.tenant, firstVehicle));
  const secondReception = await scoped(api, a.tenant, (c) => reception(c, a.tenant, secondVehicle));
  const m = await scoped(api, a.tenant, (c) => media(c));
  await scoped(api, a.tenant, (c) => signature(c, firstReception, m));
  await assert.rejects(scoped(api, a.tenant, (c) => signature(c, secondReception, m)),
    failure('23505', 'signatures_one_media_uq'));
  const delivery = id();
  const order = await scoped(api, a.tenant, (c) => closeWithOrder(c, firstReception, 934n, firstVehicle));
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO deliveries (id,tenant_id,order_id) VALUES (${delivery},${a.tenant},${order})`;
  });
  await assert.rejects(scoped(api, a.tenant, (c) => c`INSERT INTO signatures
    (id,tenant_id,delivery_id,signed_by_name,signature_media_id,signed_at,document_version,document_hash)
    VALUES (${id()},${a.tenant},${delivery},'Delivery',${m},now(),'v1',${'a'.repeat(64)})`),
  failure('23505', 'signatures_one_media_uq'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`TRUNCATE TABLE public.signatures`),
    failure('42501'));
  assert.equal((await admin`SELECT id FROM signatures WHERE signature_media_id=${m}`).length, 1);
});

test('signature and quarantine serialize in both commit orders', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  const m = await scoped(api, a.tenant, (c) => media(c));
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstDone = false, secondDone = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    await first`UPDATE media_assets SET status='quarantined' WHERE id=${m}`;
    const waiting = Promise.resolve(signature(second, r, m)).then(() => null, (e) => e);
    await blockedBy(p2.pid, p1.pid);
    await end(first, true); firstDone = true;
    failure('23514', 'signatures_media_guard')(await waiting);
    await end(second); secondDone = true;
    const [state] = await admin`SELECT status FROM media_assets WHERE id=${m}`;
    assert.equal(state.status, 'quarantined');
    assert.equal((await admin`SELECT id FROM signatures WHERE signature_media_id=${m}`).length, 0);
  } finally {
    if (!firstDone) await end(first).catch(() => undefined);
    if (!secondDone) await end(second).catch(() => undefined);
  }
  const secondVehicle = await newVehicle();
  const secondReception = await scoped(api, a.tenant,
    (c) => reception(c, a.tenant, secondVehicle));
  const secondMedia = await scoped(api, a.tenant, (c) => media(c));
  const signer = await begin(api, a.tenant), quarantiner = await begin(api, a.tenant);
  let signerDone = false, quarantinerDone = false;
  try {
    const [p1] = await signer`SELECT pg_backend_pid() AS pid`;
    const [p2] = await quarantiner`SELECT pg_backend_pid() AS pid`;
    await signature(signer, secondReception, secondMedia);
    const waiting = Promise.resolve(quarantiner`UPDATE media_assets
      SET status='quarantined' WHERE id=${secondMedia}`).then(() => null, (e) => e);
    await blockedBy(p2.pid, p1.pid);
    await end(signer, true); signerDone = true;
    assert.equal(await waiting, null);
    await end(quarantiner, true); quarantinerDone = true;
    const [state] = await admin`SELECT status FROM media_assets WHERE id=${secondMedia}`;
    assert.equal(state.status, 'quarantined');
    assert.equal((await admin`SELECT id FROM signatures WHERE signature_media_id=${secondMedia}`).length, 1);
  } finally {
    if (!signerDone) await end(signer).catch(() => undefined);
    if (!quarantinerDone) await end(quarantiner).catch(() => undefined);
  }
});

test('signature wins reception lock before close-like operation and becomes committed close evidence', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  const m = await scoped(api, a.tenant, (c) => media(c));
  const signer = await begin(api, a.tenant), closer = await begin(api, a.tenant);
  let signerDone = false, closerDone = false;
  try {
    const [p1] = await signer`SELECT pg_backend_pid() AS pid`;
    const [p2] = await closer`SELECT pg_backend_pid() AS pid`;
    await signature(signer, r, m);
    const waiting = Promise.resolve(closeWithOrder(closer, r, 501n, vehicleId));
    await blockedBy(p2.pid, p1.pid);
    await end(signer, true); signerDone = true;
    await waiting;
    await end(closer, true); closerDone = true;
    const [state] = await admin`SELECT status FROM receptions WHERE id=${r}`;
    assert.equal(state.status, 'closed');
    assert.equal((await admin`SELECT id FROM signatures WHERE reception_id=${r}`).length, 1);
  } finally {
    if (!signerDone) await end(signer).catch(() => undefined);
    if (!closerDone) await end(closer).catch(() => undefined);
  }
});

test('child insert wins parent lock before close and commits as pre-close evidence', async () => {
  const vehicleId = await newVehicle();
  const r = await scoped(api, a.tenant, (c) => reception(c, a.tenant, vehicleId));
  const m = await scoped(api, a.tenant, (c) => media(c));
  await scoped(api, a.tenant, (c) => signature(c, r, m));
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstDone = false, secondDone = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    const child = id();
    await first`INSERT INTO vehicle_damages ${first({ id: child, tenant_id: a.tenant,
      reception_id: r, zone_code: 'rear', damage_type: 'dent' })}`;
    const waiting = Promise.resolve(second`UPDATE receptions SET status='closed', closed_at=now() WHERE id=${r}`);
    await blockedBy(p2.pid, p1.pid);
    await end(first, true); firstDone = true;
    assert.equal((await waiting).count, 1);
    const order = id();
    await second`INSERT INTO service_orders ${second({ id: order, tenant_id: a.tenant,
      reception_id: r, vehicle_id: vehicleId, customer_id: a.customer,
      order_number: 404n, created_by_membership_id: a.member })}`;
    await second`INSERT INTO order_status_history ${second({ id: id(), tenant_id: a.tenant,
      order_id: order, to_status: 'reception', request_id: id() })}`;
    await end(second, true); secondDone = true;
    const [row] = await admin`SELECT status FROM receptions WHERE id=${r}`;
    assert.equal(row.status, 'closed');
    assert.equal((await admin`SELECT id FROM vehicle_damages WHERE id=${child}`).length, 1);
  } finally {
    if (!firstDone) await end(first).catch(() => undefined);
    if (!secondDone) await end(second).catch(() => undefined);
  }
});

test('vehicle mileage update and reception create serialize on the vehicle row', async () => {
  const vehicleId = await newVehicle();
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstDone = false, secondDone = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    await first`UPDATE vehicles SET current_mileage_km=15 WHERE id=${vehicleId}`;
    const waiting = Promise.resolve(reception(second, a.tenant, vehicleId,
      a.customer, { mileage_km: 14 })).then(() => null, (e) => e);
    await blockedBy(p2.pid, p1.pid);
    await end(first, true); firstDone = true;
    failure('23514', 'receptions_vehicle_mileage_guard')(await waiting);
    await end(second); secondDone = true;
    assert.equal((await admin`SELECT id FROM receptions WHERE vehicle_id=${vehicleId}`).length, 0);
  } finally {
    if (!firstDone) await end(first).catch(() => undefined);
    if (!secondDone) await end(second).catch(() => undefined);
  }
});
