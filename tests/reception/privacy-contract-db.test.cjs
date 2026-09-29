'use strict';

// S3-04.5 (migration 0020): PostgreSQL is the authority for RECEPTION-CONSENT-01,
// D-PRIV-02 evidence immutability and the D-PRIV-03 owner backstop.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');

const url = new URL(process.env.TEST_DATABASE_URL_ADMIN || 'postgresql://invalid');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  || !url.pathname.startsWith('/tm_test_reception_')) throw new Error('RECEPTION_DISPOSABLE_DATABASE_REQUIRED');
const admin = postgres(url.toString(), { max: 6, onnotice: () => {} });
function runtime(login, password, role) {
  if (!login?.startsWith('tm_test_reception') || !password) throw new Error('RECEPTION_RUNTIME_REQUIRED');
  const target = new URL(url);
  target.username = login;
  target.password = password;
  return postgres(target.toString(), { max: 6, onnotice: () => {}, connection: { role } });
}
const api = runtime(process.env.TEST_API_LOGIN, process.env.TEST_API_PASSWORD, 'tallermecario_api');
const id = () => randomUUID();
const SNAPSHOT = { legalName: 'TEST-ONLY', address: 'TEST-ONLY', phone: '+5700000000', email: null,
  rightsChannel: 'TEST-ONLY' };
const t = { tenant: id(), member: id(), owner: id(), buyer: id(), other: id() };
const u = { tenant: id(), member: id(), owner: id() };

async function begin(sql, tenant) {
  const c = await sql.reserve();
  await c.unsafe('BEGIN');
  if (tenant) await c`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  const [backend] = await c`SELECT pg_backend_pid() AS pid`;
  c.pid = backend.pid;
  return c;
}
async function end(c, commit = false) {
  try { await c.unsafe(commit ? 'COMMIT' : 'ROLLBACK'); } finally { c.release(); }
}
async function scoped(sql, tenant, fn) {
  const c = await begin(sql, tenant);
  try { const out = await fn(c); await end(c, true); return out; }
  catch (e) { await end(c).catch(() => undefined); throw e; }
}
function failure(code, constraint) {
  return (e) => {
    assert.equal(e.code, code, e.message);
    if (constraint) assert.equal(e.constraint_name || e.constraint, constraint, e.message);
    return true;
  };
}
async function blockedBy(waiter, holder) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [r] = await admin`SELECT pg_blocking_pids(${waiter}) AS blockers`;
    if (r.blockers.includes(holder)) return r.blockers;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return assert.fail('expected PostgreSQL row lock wait');
}
/** A fresh customer per scenario keeps one-granted-per-purpose fixtures independent. */
async function newCustomer(tenant = t.tenant) {
  const key = id();
  await admin`INSERT INTO customers ${admin({ id: key, tenant_id: tenant, first_name: 'A', last_name: 'B',
    phone: '3000000000' })}`;
  return key;
}
/** Privileged fixture consent (TEST-ONLY evidence); created_at defaults to now(). */
async function consent(sql, { tenant = t.tenant, customer = t.owner, purpose = 'service_provision',
  ...extra } = {}) {
  const key = id();
  await sql`INSERT INTO privacy_consents ${sql({ id: key, tenant_id: tenant, customer_id: customer,
    purpose_code: purpose, privacy_notice_version: 'test-notice-1', authorization_text_version: 'test-service-1',
    authorization_text_hash: 'f'.repeat(64), controller_notice_snapshot: sql.json(SNAPSHOT),
    channel: 'in_person', captured_at: new Date(), ...extra })}`;
  return key;
}
async function vehicle(owner = t.owner, tenant = t.tenant) {
  const key = id();
  await admin`INSERT INTO vehicles ${admin({ id: key, tenant_id: tenant,
    plate: `P${key.replaceAll('-', '').slice(0, 10).toUpperCase()}`, vehicle_type: 'car', brand: 'B', model: 'M' })}`;
  await admin`INSERT INTO vehicle_owners ${admin({ id: id(), tenant_id: tenant, vehicle_id: key,
    customer_id: owner, relationship_type: 'owner', is_primary: true })}`;
  return key;
}
function reception(c, vehicleId, consentId, { customer = t.owner, tenant = t.tenant, ...extra } = {}) {
  return c`INSERT INTO receptions ${c({ id: id(), tenant_id: tenant, vehicle_id: vehicleId,
    customer_id: customer, privacy_consent_id: consentId, received_by_membership_id: tenant === t.tenant
      ? t.member : u.member, mileage_km: 0, ...extra })} RETURNING id`;
}
/** The exact statements of transferOwner (src/vehicles/service.ts), same lock mode. */
async function transferSteps(c, vehicleId, buyer) {
  await c`SELECT id FROM public.vehicles WHERE tenant_id = ${t.tenant} AND id = ${vehicleId} FOR NO KEY UPDATE`;
  const [time] = await c`SELECT clock_timestamp() AS now`;
  await c`UPDATE public.vehicle_owners SET valid_to = ${time.now}
    WHERE tenant_id = ${t.tenant} AND vehicle_id = ${vehicleId} AND is_primary AND valid_to IS NULL`;
  await c`INSERT INTO public.vehicle_owners ${c({ id: id(), tenant_id: t.tenant, vehicle_id: vehicleId,
    customer_id: buyer, relationship_type: 'owner', is_primary: true, valid_from: time.now })}`;
}
const REVOKE = (c, consentId) => c`UPDATE privacy_consents
  SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = ${consentId}`;

test.before(async () => {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const x of [t, u]) {
      const user = id();
      await tx`INSERT INTO workshops ${tx({ id: x.tenant, slug: `pc-${x.tenant}`, legal_name: 'T', display_name: 'T' })}`;
      await tx`INSERT INTO users ${tx({ id: user, external_subject: user, email: `${user}@example.test` })}`;
      await tx`INSERT INTO memberships ${tx({ id: x.member, tenant_id: x.tenant, user_id: user })}`;
    }
    for (const [tenant, customer] of [[t.tenant, t.owner], [t.tenant, t.buyer], [t.tenant, t.other],
      [u.tenant, u.owner]]) {
      await tx`INSERT INTO customers ${tx({ id: customer, tenant_id: tenant, first_name: 'A', last_name: 'B',
        phone: '3000000000' })}`;
    }
  });
});
test.after(async () => { await Promise.all([api.end({ timeout: 5 }), admin.end({ timeout: 5 })]); });

test('catalog: trigger order, guard functions, FK/index, columns and runtime privileges', async () => {
  const triggers = await admin`SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.receptions'::regclass
    AND NOT tgisinternal AND (tgtype & 2) = 2 AND (tgtype & 4) = 4 ORDER BY tgname`;
  // BEFORE triggers fire in name order: vehicle/owner, then consent, then lifecycle.
  assert.deepEqual(triggers.map((r) => r.tgname), ['receptions_guard_10_current_owner_trg',
    'receptions_guard_20_privacy_consent_trg', 'receptions_lifecycle_trg']);
  const [fk] = await admin`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'public.receptions'::regclass AND conname = 'receptions_privacy_consent_fk'`;
  assert.equal(fk.def, 'FOREIGN KEY (tenant_id, privacy_consent_id) REFERENCES privacy_consents(tenant_id, id)');
  assert.ok(await admin`SELECT to_regclass('public.receptions_privacy_consent_idx') AS i`.then(([r]) => r.i));
  const columns = await admin`SELECT table_name, column_name, data_type, character_maximum_length AS len,
      is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'privacy_consents' AND column_name IN ('authorization_text_hash','controller_notice_snapshot'))
        OR (table_name = 'receptions' AND column_name = 'privacy_consent_id')) ORDER BY column_name`;
  assert.deepEqual(columns.map((c) => [c.column_name, c.data_type, c.len, c.is_nullable, c.column_default]), [
    ['authorization_text_hash', 'character', 64, 'NO', null],
    ['controller_notice_snapshot', 'jsonb', null, 'NO', null],
    ['privacy_consent_id', 'uuid', null, 'NO', null]]);
  for (const [column, allowed] of [['status', true], ['revoked_at', true], ['updated_at', true],
    ['authorization_text_hash', false], ['controller_notice_snapshot', false], ['customer_id', false],
    ['purpose_code', false], ['privacy_notice_version', false], ['authorization_text_version', false],
    ['captured_at', false], ['created_at', false], ['tenant_id', false], ['channel', false]]) {
    for (const role of ['tallermecario_api', 'tallermecario_worker']) {
      const [p] = await admin`SELECT has_column_privilege(${role}, 'public.privacy_consents', ${column}, 'UPDATE') AS ok`;
      assert.equal(p.ok, allowed, `${role} ${column}`);
    }
  }
  for (const privilege of ['DELETE', 'TRUNCATE']) {
    const [p] = await admin`SELECT has_table_privilege('tallermecario_api', 'public.privacy_consents', ${privilege}) AS ok`;
    assert.equal(p.ok, false, privilege);
  }
  const [immutable] = await admin`SELECT has_column_privilege('tallermecario_api', 'public.receptions',
    'privacy_consent_id', 'UPDATE') AS ok`;
  assert.equal(immutable.ok, false);
});

test('evidence CHECKs: hash format and controller snapshot shape are enforced by PostgreSQL', async () => {
  for (const [extra, code, constraint] of [
    [{ authorization_text_hash: 'A'.repeat(64) }, '23514', 'privacy_consents_authorization_text_hash_check'],
    [{ authorization_text_hash: 'f'.repeat(63) }, '23514', 'privacy_consents_authorization_text_hash_check'],
    [{ authorization_text_hash: `${'f'.repeat(63)}g` }, '23514', 'privacy_consents_authorization_text_hash_check'],
    [{ authorization_text_hash: null }, '23502', null],
    [{ controller_notice_snapshot: null }, '23502', null],
  ]) {
    await assert.rejects(scoped(api, t.tenant, (c) => consent(c, { customer: t.other, ...extra })),
      failure(code, constraint));
  }
  for (const snapshot of [{ ...SNAPSHOT, extra: 'x' }, { legalName: 'x', address: 'y', phone: null, email: null,
    rightsChannel: 'z' }, { ...SNAPSHOT, legalName: ' ' }, { ...SNAPSHOT, rightsChannel: null },
  (({ email: _e, ...rest }) => rest)(SNAPSHOT), { ...SNAPSHOT, phone: 5 }, ['x']]) {
    await assert.rejects(scoped(api, t.tenant, (c) => consent(c, { customer: t.other,
      controller_notice_snapshot: c.json(snapshot) })),
    failure('23514', 'privacy_consents_controller_snapshot_check'));
  }
  // Must be born granted: status/revoked_at are lifecycle, not insert-time evidence.
  await assert.rejects(scoped(api, t.tenant, (c) => consent(c, { customer: t.other, status: 'revoked',
    revoked_at: new Date() })), failure('23514', 'privacy_consents_evidence_guard'));
});

test('direct SQL backstop A-F: owner, customer, purpose, revoked, created_at, foreign tenant', async () => {
  const v = await vehicle();
  const ownerConsent = await scoped(api, t.tenant, (c) => consent(c));
  const otherConsent = await scoped(api, t.tenant, (c) => consent(c, { customer: t.other }));
  const marketing = await scoped(api, t.tenant, (c) => consent(c, { purpose: 'marketing' }));
  const foreign = await scoped(api, u.tenant, (c) => consent(c, { tenant: u.tenant, customer: u.owner }));
  const cases = [
    ['A non-owner customer', { customer: t.other }, otherConsent, '23514', 'receptions_current_owner_guard'],
    ['B consent of another customer', {}, otherConsent, '23514', 'receptions_privacy_consent_guard'],
    ['C wrong purpose', {}, marketing, '23514', 'receptions_privacy_consent_guard'],
    ['E reception created before the consent', { created_at: new Date(Date.now() - 3_600_000) }, ownerConsent,
      '23514', 'receptions_privacy_consent_guard'],
    ['F foreign tenant consent', {}, foreign, '23503', 'receptions_privacy_consent_fk'],
    ['absent consent', {}, id(), '23503', 'receptions_privacy_consent_fk'],
    ['NULL consent', {}, null, '23502', null],
  ];
  for (const [name, extra, consentId, code, constraint] of cases) {
    await assert.rejects(scoped(api, t.tenant, (c) => reception(c, v, consentId, extra)), failure(code, constraint),
      name);
  }
  // Superuser/owner SQL is guarded by the same triggers (not only RLS).
  await assert.rejects(admin.begin((tx) => reception(tx, v, otherConsent, { customer: t.other })),
    failure('23514', 'receptions_current_owner_guard'));
  await assert.rejects(admin.begin((tx) => reception(tx, v, foreign)), failure('23503', 'receptions_privacy_consent_fk'));
  // E (now() bound): a future consent cannot be covered by forging a future reception created_at.
  const future = await admin.begin((tx) => consent(tx, { customer: t.buyer,
    created_at: new Date(Date.now() + 86_400_000) }));
  const v2 = await vehicle(t.buyer);
  await assert.rejects(admin.begin((tx) => reception(tx, v2, future, { customer: t.buyer,
    created_at: new Date(Date.now() + 2 * 86_400_000) })), failure('23514', 'receptions_privacy_consent_guard'));
  // D revoked (status + revoked_at are coupled by privacy_consents_revoked_check).
  await scoped(api, t.tenant, (c) => REVOKE(c, ownerConsent));
  await assert.rejects(scoped(api, t.tenant, (c) => reception(c, v, ownerConsent)),
    failure('23514', 'receptions_privacy_consent_guard'), 'D revoked');
  assert.equal((await admin`SELECT id FROM receptions WHERE vehicle_id = ${v}`).length, 0);
  // Same-transaction consent (created_at = reception created_at) is valid.
  await scoped(api, t.tenant, async (c) => {
    const fresh = await consent(c);
    await reception(c, v, fresh);
  });
  assert.equal((await admin`SELECT id FROM receptions WHERE vehicle_id = ${v}`).length, 1);
});

test('G: direct INSERT vs owner change serialize on the vehicle row (both orders, no TOCTOU)', async () => {
  // Owner change first: the INSERT waits in the owner trigger, then sees the buyer.
  const owner = await newCustomer();
  const buyer = await newCustomer();
  const v = await vehicle(owner);
  const pc = await admin.begin((tx) => consent(tx, { customer: owner }));
  const mover = await begin(api, t.tenant);
  const inserter = await begin(api, t.tenant);
  let done = false;
  try {
    await transferSteps(mover, v, buyer);
    const waiting = Promise.resolve(reception(inserter, v, pc, { customer: owner })).then(() => null, (e) => e);
    await blockedBy(inserter.pid, mover.pid);
    await end(mover, true);
    failure('23514', 'receptions_current_owner_guard')(await waiting);
    await end(inserter); done = true;
  } finally { if (!done) { await end(mover).catch(() => {}); await end(inserter).catch(() => {}); } }
  // INSERT first: it holds the vehicle lock; the owner change waits and history stays.
  const v2 = await vehicle(owner);
  const first = await begin(api, t.tenant);
  const second = await begin(api, t.tenant);
  done = false;
  try {
    const [row] = await reception(first, v2, pc, { customer: owner });
    const waiting = Promise.resolve(transferSteps(second, v2, buyer)).then(() => null, (e) => e);
    await blockedBy(second.pid, first.pid);
    await end(first, true);
    assert.equal(await waiting, null);
    await end(second, true); done = true;
    const [stored] = await admin`SELECT customer_id FROM receptions WHERE id = ${row.id}`;
    assert.equal(stored.customer_id, owner);
    // Not re-evaluated after the owner change: the open reception stays editable.
    await scoped(api, t.tenant, (c) => c`UPDATE receptions SET advisor_notes = 'x' WHERE id = ${row.id}`);
  } finally { if (!done) { await end(first).catch(() => {}); await end(second).catch(() => {}); } }
});

test('consent FOR SHARE vs revoke UPDATE serialize in both commit orders', async () => {
  const holder = await newCustomer();
  const v = await vehicle(holder);
  const pc = await scoped(api, t.tenant, (c) => consent(c, { customer: holder }));
  // Revoke first: the INSERT blocks in the consent guard and then fails.
  const revoker = await begin(api, t.tenant);
  const inserter = await begin(api, t.tenant);
  let done = false;
  try {
    await REVOKE(revoker, pc);
    const waiting = Promise.resolve(reception(inserter, v, pc, { customer: holder })).then(() => null, (e) => e);
    await blockedBy(inserter.pid, revoker.pid);
    await end(revoker, true);
    failure('23514', 'receptions_privacy_consent_guard')(await waiting);
    await end(inserter); done = true;
  } finally { if (!done) { await end(revoker).catch(() => {}); await end(inserter).catch(() => {}); } }
  // Reception first: FOR SHARE (not the FK KEY SHARE) makes the revoke wait.
  const pc2 = await scoped(api, t.tenant, (c) => consent(c, { customer: holder }));
  const first = await begin(api, t.tenant);
  const second = await begin(api, t.tenant);
  done = false;
  try {
    const [row] = await reception(first, v, pc2, { customer: holder });
    const waiting = Promise.resolve(REVOKE(second, pc2)).then(() => null, (e) => e);
    await blockedBy(second.pid, first.pid);
    await end(first, true);
    assert.equal(await waiting, null);
    await end(second, true); done = true;
    const [state] = await admin`SELECT r.privacy_consent_id, c.status FROM receptions r
      JOIN privacy_consents c ON c.id = r.privacy_consent_id WHERE r.id = ${row.id}`;
    assert.deepEqual({ ...state }, { privacy_consent_id: pc2, status: 'revoked' });
  } finally { if (!done) { await end(first).catch(() => {}); await end(second).catch(() => {}); } }
});

test('effective lock order: vehicle before consent, even when both are contended', async () => {
  const holder = await newCustomer();
  const v = await vehicle(holder);
  const pc = await scoped(api, t.tenant, (c) => consent(c, { customer: holder }));
  const vehicleHolder = await begin(admin);
  const consentHolder = await begin(admin);
  const inserter = await begin(api, t.tenant);
  let done = false;
  try {
    await consentHolder`SELECT id FROM privacy_consents WHERE id = ${pc} FOR UPDATE`;
    await vehicleHolder`SELECT id FROM vehicles WHERE id = ${v} FOR UPDATE`;
    const waiting = Promise.resolve(reception(inserter, v, pc, { customer: holder })).then(() => null, (e) => e);
    const first = await blockedBy(inserter.pid, vehicleHolder.pid);
    assert.equal(first.includes(consentHolder.pid), false, 'must not touch the consent before the vehicle');
    await end(vehicleHolder);
    const second = await blockedBy(inserter.pid, consentHolder.pid);
    assert.equal(second.includes(vehicleHolder.pid), false);
    await end(consentHolder);
    assert.equal(await waiting, null);
    await end(inserter); done = true;
  } finally {
    if (!done) for (const c of [vehicleHolder, consentHolder, inserter]) await end(c).catch(() => {});
  }
});

test('PATCH (reception -> vehicle) vs CREATE (vehicle -> consent) on one vehicle: no deadlock', async () => {
  const owner = await newCustomer();
  const v = await vehicle(owner);
  const pc = await admin.begin((tx) => consent(tx, { customer: owner }));
  const [open] = await scoped(api, t.tenant, (c) => reception(c, v, pc, { customer: owner }));
  const patcher = await begin(api, t.tenant);
  const creator = await begin(api, t.tenant);
  let done = false;
  try {
    // PATCH locks the reception, then its lifecycle trigger locks the vehicle.
    await patcher`UPDATE receptions SET advisor_notes = 'p' WHERE id = ${open.id}`;
    const waiting = Promise.resolve(reception(creator, v, pc, { customer: owner })).then(() => null, (e) => e);
    await blockedBy(creator.pid, patcher.pid);
    await end(patcher, true);
    failure('23505', 'receptions_one_open_vehicle_uq')(await waiting);
    await end(creator); done = true;
  } finally { if (!done) { await end(patcher).catch(() => {}); await end(creator).catch(() => {}); } }
});

test('privacy consent evidence is immutable; only granted -> revoked; no delete/truncate', async () => {
  const subject = await newCustomer();
  const pc = await scoped(api, t.tenant, (c) => consent(c, { customer: subject, purpose: 'image_use' }));
  const evidence = [['authorization_text_hash', 'e'.repeat(64)],
    ['controller_notice_snapshot', { ...SNAPSHOT, legalName: 'Otro' }], ['privacy_notice_version', 'x2'],
    ['authorization_text_version', 'x2'], ['customer_id', t.buyer], ['purpose_code', 'marketing'],
    ['channel', 'web'], ['captured_at', new Date(0)], ['created_at', new Date(0)], ['evidence_hash', 'x'],
    ['ip_address', '10.0.0.1'], ['user_agent', 'x'], ['created_by_membership_id', t.member],
    ['tenant_id', u.tenant]];
  for (const [column, value] of evidence) {
    const param = column === 'controller_notice_snapshot' ? JSON.stringify(value) : value;
    // Runtime: no column privilege at all.
    await assert.rejects(scoped(api, t.tenant, (c) => c.unsafe(
      `UPDATE privacy_consents SET ${column} = $1 WHERE id = $2`, [param, pc])), failure('42501'), column);
    // Privileged SQL: the evidence trigger still rejects.
    await assert.rejects(admin.unsafe(`UPDATE privacy_consents SET ${column} = $1 WHERE id = $2`, [param, pc]),
      failure('23514', 'privacy_consents_evidence_guard'), column);
  }
  await assert.rejects(admin`UPDATE privacy_consents SET updated_at = now() WHERE id = ${pc}`,
    failure('23514', 'privacy_consents_evidence_guard'));
  await assert.rejects(scoped(api, t.tenant, (c) => c`DELETE FROM privacy_consents WHERE id = ${pc}`), failure('42501'));
  await assert.rejects(admin`DELETE FROM privacy_consents WHERE id = ${pc}`,
    failure('23514', 'privacy_consents_evidence_guard'));
  await assert.rejects(admin`TRUNCATE privacy_consents CASCADE`, failure('23514', 'privacy_consents_evidence_guard'));
  await assert.rejects(scoped(api, t.tenant, (c) => c`TRUNCATE privacy_consents`), failure('42501'));
  // Authorized lifecycle: granted -> revoked through the runtime role.
  await scoped(api, t.tenant, (c) => REVOKE(c, pc));
  for (const sql of [
    "UPDATE privacy_consents SET status = 'granted', revoked_at = NULL WHERE id = $1",
    'UPDATE privacy_consents SET revoked_at = now() + interval \'1 second\' WHERE id = $1',
  ]) {
    await assert.rejects(scoped(api, t.tenant, (c) => c.unsafe(sql, [pc])),
      failure('23514', 'privacy_consents_evidence_guard'), sql);
  }
  // Re-authorization is a new row; one granted per (tenant, customer, purpose).
  const renewed = await scoped(api, t.tenant, (c) => consent(c, { customer: subject, purpose: 'image_use' }));
  assert.notEqual(renewed, pc);
  await assert.rejects(scoped(api, t.tenant, (c) => consent(c, { customer: subject, purpose: 'image_use' })),
    failure('23505', 'privacy_consents_one_granted_uq'));
  assert.equal((await admin`SELECT status FROM privacy_consents WHERE id = ${pc}`)[0].status, 'revoked');
});

test('receptions.privacy_consent_id is immutable after INSERT, also for privileged SQL', async () => {
  const subject = await newCustomer();
  const v = await vehicle(subject);
  const pc = await admin.begin((tx) => consent(tx, { customer: subject }));
  const replacement = await scoped(api, t.tenant, (c) => consent(c, { customer: subject, purpose: 'marketing' }));
  const [row] = await scoped(api, t.tenant, (c) => reception(c, v, pc, { customer: subject }));
  await assert.rejects(scoped(api, t.tenant, (c) => c`UPDATE receptions SET privacy_consent_id = ${replacement}
    WHERE id = ${row.id}`), failure('42501'));
  await assert.rejects(admin`UPDATE receptions SET privacy_consent_id = ${replacement} WHERE id = ${row.id}`,
    failure('23514', 'receptions_privacy_consent_guard'));
  await scoped(api, t.tenant, (c) => c`UPDATE receptions SET advisor_notes = 'ok' WHERE id = ${row.id}`);
  // A later revocation does not invalidate the historical reception.
  await scoped(api, t.tenant, (c) => REVOKE(c, pc));
  const [stored] = await admin`SELECT privacy_consent_id, status FROM receptions WHERE id = ${row.id}`;
  assert.deepEqual({ ...stored }, { privacy_consent_id: pc, status: 'open' });
});

test('tenant isolation: RLS hides foreign consents; RLS insert keeps tenant boundary', async () => {
  const foreignCustomer = await newCustomer(u.tenant);
  const foreign = await admin.begin((tx) => consent(tx, { tenant: u.tenant, customer: foreignCustomer }));
  assert.equal((await scoped(api, t.tenant, (c) => c`SELECT id FROM privacy_consents WHERE id = ${foreign}`)).length, 0);
  assert.equal((await scoped(api, t.tenant, (c) => c`UPDATE privacy_consents SET status = 'revoked',
    revoked_at = now() WHERE id = ${foreign}`)).count, 0);
  await assert.rejects(scoped(api, t.tenant, (c) => consent(c, { tenant: u.tenant, customer: foreignCustomer,
    purpose: 'marketing' })), failure('42501'));
  const [state] = await admin`SELECT status FROM privacy_consents WHERE id = ${foreign}`;
  assert.equal(state.status, 'granted');
});
