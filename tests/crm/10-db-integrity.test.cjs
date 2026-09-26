'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');

const url = new URL(process.env.TEST_DATABASE_URL_ADMIN || 'postgresql://invalid');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  || !url.pathname.startsWith('/tm_test_crm_')) throw new Error('CRM_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
const admin = postgres(url.toString(), { max: 3, onnotice: () => {} });
function runtime(login, password, role) {
  if (!login?.startsWith('tm_test_crm') || !password) throw new Error('CRM_RUNTIME_LOGIN_REQUIRED');
  const target = new URL(url);
  target.username = login;
  target.password = password;
  return postgres(target.toString(), { max: 4, onnotice: () => {}, connection: { role } });
}
const api = runtime(process.env.TEST_API_LOGIN, process.env.TEST_API_PASSWORD, 'tallermecario_api');
const worker = runtime(process.env.TEST_WORKER_LOGIN, process.env.TEST_WORKER_PASSWORD, 'tallermecario_worker');
const id = () => randomUUID();
const a = { tenant: id(), customer: id(), customer2: id(), vehicle: id() };
const b = { tenant: id(), customer: id(), vehicle: id(), owner: id() };

async function begin(sql, tenant) {
  const c = await sql.reserve();
  await c.unsafe('BEGIN');
  if (tenant) await c`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  return c;
}
async function close(c, commit = false) {
  try { await c.unsafe(commit ? 'COMMIT' : 'ROLLBACK'); } finally { c.release(); }
}
async function scoped(sql, tenant, fn) {
  const c = await begin(sql, tenant);
  try { const result = await fn(c); await close(c, true); return result; }
  catch (e) { await close(c); throw e; }
}
function error(code, constraint) {
  return (e) => {
    assert.equal(e.code, code, e.message);
    if (constraint) assert.equal(e.constraint_name || e.constraint, constraint);
    return true;
  };
}
function vehicle(c, tenant, plate, vehicleId = id(), extra = {}) {
  return c`INSERT INTO vehicles ${c({ id: vehicleId, tenant_id: tenant, plate, vehicle_type: 'car', brand: 'B', model: 'M', ...extra })}`;
}
function customer(c, tenant, customerId = id()) {
  return c`INSERT INTO customers ${c({ id: customerId, tenant_id: tenant, first_name: 'A', last_name: 'B', phone: '3000000000' })}`;
}
function ownership(c, tenant, vehicleId, customerId, ownerId = id(), extra = {}) {
  return c`INSERT INTO vehicle_owners ${c({ id: ownerId, tenant_id: tenant, vehicle_id: vehicleId, customer_id: customerId, ...extra })}`;
}
async function blockedBy(waitingPid, holderPid) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [state] = await admin`SELECT pg_blocking_pids(${waitingPid}) AS blockers`;
    if (state.blockers.includes(holderPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`backend ${waitingPid} did not block on ${holderPid}`);
}

test.before(async () => {
  const [version] = await admin`SELECT current_setting('server_version_num')::int AS n`;
  assert.equal(Math.floor(version.n / 10000), 18);
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const t of [a, b]) {
      await tx`INSERT INTO workshops ${tx({ id: t.tenant, slug: `crm-${t.tenant}`, legal_name: 'CRM', display_name: 'CRM' })}`;
    }
  });
  await scoped(api, a.tenant, async (c) => {
    await customer(c, a.tenant, a.customer);
    await customer(c, a.tenant, a.customer2);
    await vehicle(c, a.tenant, 'ABC123', a.vehicle);
  });
  await scoped(api, b.tenant, async (c) => {
    await customer(c, b.tenant, b.customer);
    await vehicle(c, b.tenant, 'ABC123', b.vehicle);
    await ownership(c, b.tenant, b.vehicle, b.customer, b.owner);
  });
});
test.after(async () => { await Promise.all([api.end({ timeout: 5 }), worker.end({ timeout: 5 }), admin.end({ timeout: 5 })]); });

test('DB-01 catalog: CRM tables, tenant identities, composite FKs, CHECKs and indexes', async () => {
  const names = ['customers', 'vehicles', 'vehicle_owners'];
  const tables = await admin`SELECT relname FROM pg_class WHERE oid = ANY(ARRAY[to_regclass('public.customers'), to_regclass('public.vehicles'), to_regclass('public.vehicle_owners')]) ORDER BY relname`;
  assert.deepEqual(tables.map((x) => x.relname), [...names].sort());
  const constraints = await admin`
    SELECT c.conname, c.contype, c.conrelid::regclass::text AS table_name,
      c.confrelid::regclass::text AS parent, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid IN ('customers'::regclass, 'vehicles'::regclass, 'vehicle_owners'::regclass)
  `;
  const byName = new Map(constraints.map((x) => [x.conname, x]));
  for (const [name, type, detail] of [
    ['customers_tenant_id_key', 'u', /tenant_id, id/u],
    ['vehicles_tenant_id_key', 'u', /tenant_id, id/u],
    ['vehicles_tenant_plate_key', 'u', /tenant_id, plate/u],
    ['vehicle_owners_tenant_id_key', 'u', /tenant_id, id/u],
    ['vehicles_type_check', 'c', /vehicle_type/u],
    ['vehicles_model_year_check', 'c', /model_year/u],
    ['vehicles_mileage_check', 'c', /current_mileage_km/u],
    ['vehicle_owners_relationship_check', 'c', /relationship_type/u],
    ['vehicle_owners_validity_check', 'c', /valid_to/u],
    ['vehicle_owners_vehicle_fk', 'f', /FOREIGN KEY \(tenant_id, vehicle_id\) REFERENCES vehicles\(tenant_id, id\)/u],
    ['vehicle_owners_customer_fk', 'f', /FOREIGN KEY \(tenant_id, customer_id\) REFERENCES customers\(tenant_id, id\)/u],
  ]) {
    const actual = byName.get(name);
    assert.ok(actual, name);
    assert.equal(actual.contype, type, name);
    assert.match(actual.definition, detail, name);
  }
  const indexes = await admin`
    SELECT i.relname AS name, x.indisunique AS unique, pg_get_indexdef(x.indexrelid) AS definition,
      pg_get_expr(x.indpred, x.indrelid) AS predicate
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid IN ('customers'::regclass, 'vehicles'::regclass, 'vehicle_owners'::regclass)
  `;
  const ix = new Map(indexes.map((x) => [x.name, x]));
  for (const [name, columns] of [
    ['customers_tenant_phone_idx', '(tenant_id, phone)'],
    ['customers_tenant_document_idx', '(tenant_id, document_number)'],
    ['vehicle_owners_vehicle_idx', '(tenant_id, vehicle_id, valid_to)'],
    ['vehicle_owners_customer_idx', '(tenant_id, customer_id)'],
  ]) assert.ok(ix.get(name)?.definition.includes(columns), name);
  assert.equal(ix.get('vehicle_owners_one_primary_uq')?.unique, true);
  assert.match(ix.get('vehicle_owners_one_primary_uq').definition, /\(tenant_id, vehicle_id\)/u);
  assert.match(ix.get('vehicle_owners_one_primary_uq').predicate, /is_primary = true/u);
  assert.match(ix.get('vehicle_owners_one_primary_uq').predicate, /valid_to IS NULL/u);
});

test('DB-02 RLS catalog: ENABLE + FORCE and exactly SELECT/INSERT/UPDATE policies', async () => {
  const rows = await admin`SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname IN ('customers','vehicles','vehicle_owners') AND relnamespace = 'public'::regnamespace`;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true);
    assert.equal(row.relforcerowsecurity, true);
    assert.equal(row.owner, 'tallermecario_schema_owner');
  }
  const policies = await admin`SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('customers','vehicles','vehicle_owners')`;
  assert.equal(policies.length, 9);
  for (const table of ['customers', 'vehicles', 'vehicle_owners']) {
    const p = policies.filter((row) => row.tablename === table);
    assert.deepEqual(p.map((x) => x.policyname).sort(), ['tenant_insert', 'tenant_select', 'tenant_update']);
    for (const x of p) {
      assert.deepEqual([...x.roles].sort(), ['tallermecario_api', 'tallermecario_worker']);
      assert.equal(x.cmd, { tenant_select: 'SELECT', tenant_insert: 'INSERT', tenant_update: 'UPDATE' }[x.policyname]);
      assert.match(x.qual || x.with_check, /tenant_id = app\.current_tenant_id\(\)/u);
      if (x.cmd === 'UPDATE') assert.match(x.with_check, /tenant_id = app\.current_tenant_id\(\)/u);
    }
  }
});

test('DB-03 BASELINE SNAPSHOT: API/worker table grants and PUBLIC', async () => {
  for (const role of ['tallermecario_api', 'tallermecario_worker']) {
    for (const table of ['customers', 'vehicles', 'vehicle_owners']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        const [r] = await admin`SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS allowed`;
        assert.equal(r.allowed, ['SELECT', 'INSERT', 'UPDATE'].includes(privilege), `${role}.${table}.${privilege}`);
      }
    }
  }
  const publicGrants = await admin`SELECT c.relname, x.privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x WHERE c.relname IN ('customers','vehicles','vehicle_owners') AND c.relnamespace = 'public'::regnamespace AND x.grantee = 0`;
  assert.equal(publicGrants.length, 0);
});

test('DB-04 runtime isolation for all CRM tables, with and without tenant context; worker included', async () => {
  for (const sql of [api, worker]) {
    for (const [table, foreignId] of [['customers', b.customer], ['vehicles', b.vehicle], ['vehicle_owners', b.owner]]) {
      assert.equal((await sql.unsafe(`SELECT id FROM ${table}`)).length, 0);
      await scoped(sql, a.tenant, async (c) => {
        assert.equal((await c.unsafe(`SELECT id FROM ${table} WHERE tenant_id = '${b.tenant}'`)).length, 0);
        assert.equal((await c.unsafe(`UPDATE ${table} SET id = id WHERE id = '${foreignId}'`)).count, 0);
      });
    }
    await assert.rejects(customer(sql, a.tenant), error('42501'));
    await assert.rejects(vehicle(sql, a.tenant, `N${id().slice(0, 6)}`), error('42501'));
    await assert.rejects(ownership(sql, a.tenant, a.vehicle, a.customer), error('42501'));
    for (const kind of ['customer', 'vehicle', 'owner']) {
      await assert.rejects(scoped(sql, a.tenant, async (c) => {
        if (kind === 'customer') await customer(c, b.tenant);
        if (kind === 'vehicle') await vehicle(c, b.tenant, `X${id().slice(0, 6)}`);
        if (kind === 'owner') await ownership(c, b.tenant, b.vehicle, b.customer);
      }), error('42501'));
    }
  }
});

test('DB-05 plate uniqueness is tenant scoped and rejects duplicate with 23505', async () => {
  assert.equal((await admin`SELECT count(*)::int AS n FROM vehicles WHERE plate = 'ABC123'`)[0].n, 2);
  await assert.rejects(scoped(api, a.tenant, (c) => vehicle(c, a.tenant, 'ABC123')),
    error('23505', 'vehicles_tenant_plate_key'));
});

test('DB-06 concurrent plate INSERT blocks then loses on UNIQUE after winner COMMIT', async () => {
  const first = await begin(api, a.tenant), second = await begin(api, a.tenant);
  let firstClosed = false;
  try {
    const [p1] = await first`SELECT pg_backend_pid() AS pid`;
    const [p2] = await second`SELECT pg_backend_pid() AS pid`;
    await vehicle(first, a.tenant, 'XYZ789');
    const losing = Promise.resolve(vehicle(second, a.tenant, 'XYZ789')).then(
      () => null, (failure) => failure,
    );
    await blockedBy(p2.pid, p1.pid);
    await close(first, true); firstClosed = true;
    assert.equal(error('23505', 'vehicles_tenant_plate_key')(await losing), true);
  } finally {
    if (!firstClosed) await close(first).catch(() => undefined);
    await close(second).catch(() => undefined);
  }
  assert.equal((await admin`SELECT count(*)::int AS n FROM vehicles WHERE tenant_id=${a.tenant} AND plate='XYZ789'`)[0].n, 1);
});

test('CH-04 CHARACTERIZATION / KNOWN GAP: unnormalized plates remain distinct', async () => {
  await scoped(api, a.tenant, async (c) => {
    await vehicle(c, a.tenant, 'abc123');
    await vehicle(c, a.tenant, ' ABC123 ');
  });
  const plates = await admin`SELECT plate FROM vehicles WHERE tenant_id=${a.tenant} AND plate IN ('ABC123','abc123',' ABC123 ') ORDER BY plate`;
  assert.equal(plates.length, 3);
  process.stdout.write('CH-04 CHARACTERIZATION / KNOWN GAP: case and surrounding spaces accepted; Sprint 2 Gate remains open\n');
});

test('DB-07 composite FKs reject cross-tenant vehicle and customer even with privileged context', async () => {
  await assert.rejects(scoped(api, a.tenant, (c) => ownership(c, a.tenant, b.vehicle, a.customer)),
    error('23503', 'vehicle_owners_vehicle_fk'));
  await assert.rejects(scoped(api, a.tenant, (c) => ownership(c, a.tenant, a.vehicle, b.customer)),
    error('23503', 'vehicle_owners_customer_fk'));
  await assert.rejects(ownership(admin, a.tenant, b.vehicle, a.customer), error('23503', 'vehicle_owners_vehicle_fk'));
  await assert.rejects(ownership(admin, a.tenant, a.vehicle, b.customer), error('23503', 'vehicle_owners_customer_fk'));
});

test('DB-08 ownership transfer preserves exact boundary and one current primary', async () => {
  const oldId = id(), newId = id();
  await scoped(api, a.tenant, (c) => ownership(c, a.tenant, a.vehicle, a.customer, oldId));
  await assert.rejects(scoped(api, a.tenant, (c) => ownership(c, a.tenant, a.vehicle, a.customer2)),
    error('23505', 'vehicle_owners_one_primary_uq'));
  await scoped(api, a.tenant, async (c) => {
    const locked = await c`SELECT id FROM vehicles WHERE tenant_id=${a.tenant} AND id=${a.vehicle} FOR NO KEY UPDATE`;
    assert.equal(locked.length, 1);
    const [time] = await c`SELECT clock_timestamp() AS at`;
    await c`UPDATE vehicle_owners SET valid_to=${time.at} WHERE id=${oldId}`;
    await ownership(c, a.tenant, a.vehicle, a.customer2, newId, { valid_from: time.at });
  });
  const rows = await admin`SELECT customer_id, valid_from, valid_to FROM vehicle_owners WHERE tenant_id=${a.tenant} AND vehicle_id=${a.vehicle} ORDER BY valid_from`;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].customer_id, a.customer);
  assert.ok(rows[0].valid_to);
  assert.equal(rows[1].customer_id, a.customer2);
  assert.equal(rows[1].valid_to, null);
  assert.equal(rows[0].valid_to.getTime(), rows[1].valid_from.getTime());
  assert.equal(rows.filter((r) => r.valid_to === null).length, 1);
  await assert.rejects(scoped(api, a.tenant, (c) => ownership(c, a.tenant, a.vehicle, a.customer, id(), {
    is_primary: false, valid_from: new Date('2026-01-02'), valid_to: new Date('2026-01-01'),
  })), error('23514', 'vehicle_owners_validity_check'));
});

test('DB-09 concurrent ownership changes serialize on vehicle row and retain history', async () => {
  const v = id(), initial = id(), second = id(), third = id(), customer3 = id();
  await scoped(api, a.tenant, async (c) => {
    await customer(c, a.tenant, customer3);
    await vehicle(c, a.tenant, 'CON789', v);
    await ownership(c, a.tenant, v, a.customer, initial);
  });
  const c1 = await begin(api, a.tenant), c2 = await begin(api, a.tenant);
  let firstClosed = false, secondClosed = false;
  try {
    const [p1] = await c1`SELECT pg_backend_pid() AS pid`;
    const [p2] = await c2`SELECT pg_backend_pid() AS pid`;
    await c1`SELECT id FROM vehicles WHERE id=${v} FOR NO KEY UPDATE`;
    const waiting = Promise.resolve(c2`SELECT id FROM vehicles WHERE id=${v} FOR NO KEY UPDATE`);
    await blockedBy(p2.pid, p1.pid);
    const [t1] = await c1`SELECT clock_timestamp() AS at`;
    await c1`UPDATE vehicle_owners SET valid_to=${t1.at} WHERE id=${initial}`;
    await ownership(c1, a.tenant, v, a.customer2, second, { valid_from: t1.at });
    await close(c1, true); firstClosed = true;
    assert.equal((await waiting).length, 1);
    const current = await c2`SELECT id FROM vehicle_owners WHERE vehicle_id=${v} AND is_primary=true AND valid_to IS NULL`;
    assert.deepEqual(current.map((x) => x.id), [second]);
    const [t2] = await c2`SELECT clock_timestamp() AS at`;
    await c2`UPDATE vehicle_owners SET valid_to=${t2.at} WHERE id=${second}`;
    await ownership(c2, a.tenant, v, customer3, third, { valid_from: t2.at });
    await close(c2, true); secondClosed = true;
  } finally {
    if (!firstClosed) await close(c1).catch(() => undefined);
    if (!secondClosed) await close(c2).catch(() => undefined);
  }
  const rows = await admin`SELECT id, valid_to FROM vehicle_owners WHERE vehicle_id=${v} ORDER BY valid_from`;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.id), [initial, second, third]);
  assert.equal(rows.filter((r) => r.valid_to === null).length, 1);
  assert.ok(rows[0].valid_to && rows[1].valid_to);
});

test('CH-05 CHARACTERIZATION / KNOWN GAP: runtime can rewrite historical ownership fields', async () => {
  const [historical] = await admin`SELECT id, customer_id, created_at FROM vehicle_owners WHERE tenant_id=${a.tenant} AND vehicle_id=${a.vehicle} AND valid_to IS NOT NULL`;
  const c = await begin(api, a.tenant);
  try {
    const changed = await c`UPDATE vehicle_owners SET customer_id=${a.customer2}, created_at=${new Date('2020-01-01')}, is_primary=false WHERE id=${historical.id} RETURNING customer_id, created_at, is_primary`;
    assert.equal(changed.length, 1);
    assert.equal(changed[0].customer_id, a.customer2);
    assert.equal(changed[0].is_primary, false);
  } finally { await close(c); }
  const [preserved] = await admin`SELECT customer_id, created_at FROM vehicle_owners WHERE id=${historical.id}`;
  assert.equal(preserved.customer_id, historical.customer_id);
  assert.equal(preserved.created_at.getTime(), historical.created_at.getTime());
  process.stdout.write('CH-05 CHARACTERIZATION / KNOWN GAP: historical columns writable by runtime; Sprint 2 Gate remains open\n');
});

test('DB-10 CHECK constraints reject invalid vehicle and ownership values', async () => {
  for (const [extra, constraint] of [
    [{ vehicle_type: 'spaceship' }, 'vehicles_type_check'],
    [{ model_year: 1885 }, 'vehicles_model_year_check'],
    [{ current_mileage_km: -1 }, 'vehicles_mileage_check'],
  ]) {
    await assert.rejects(scoped(api, a.tenant, (c) => vehicle(c, a.tenant, `N${id().slice(0, 6)}`, id(), extra)),
      error('23514', constraint));
  }
  await assert.rejects(scoped(api, a.tenant, (c) => ownership(c, a.tenant, a.vehicle, a.customer, id(), {
    relationship_type: 'invented', is_primary: false,
  })), error('23514', 'vehicle_owners_relationship_check'));
});

test('DB-11 runtime role cannot own, elevate, disable RLS, DELETE or TRUNCATE CRM', async () => {
  const logins = await admin`SELECT rolname, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = ANY(${[process.env.TEST_API_LOGIN, process.env.TEST_WORKER_LOGIN]})`;
  assert.equal(logins.length, 2);
  for (const login of logins) { assert.equal(login.rolinherit, false); assert.equal(login.rolbypassrls, false); }
  for (const sql of [api, worker]) {
    const [role] = await sql`SELECT current_user AS name, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname=current_user`;
    assert.equal(role.rolbypassrls, false);
    assert.equal(role.rolsuper, false);
    assert.ok(['tallermecario_api', 'tallermecario_worker'].includes(role.name));
    const [owned] = await sql`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('customers','vehicles','vehicle_owners') AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`;
    assert.equal(owned.n, 0);
    await assert.rejects(sql.unsafe('SET ROLE tallermecario_schema_owner'), error('42501'));
    for (const table of ['customers', 'vehicles', 'vehicle_owners']) {
      await assert.rejects(sql.unsafe(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`), error('42501'));
      await assert.rejects(sql.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`), error('42501'));
      const c = await sql.reserve();
      try {
        await c.unsafe('SET row_security = off');
        await assert.rejects(c.unsafe(`SELECT count(*) FROM ${table}`), error('42501'));
      } finally { await c.unsafe('RESET row_security'); c.release(); }
      await assert.rejects(scoped(sql, a.tenant, (c) => c.unsafe(`DELETE FROM ${table} WHERE false`)), error('42501'));
      await assert.rejects(sql.unsafe(`TRUNCATE ${table}`), error('42501'));
    }
  }
});
