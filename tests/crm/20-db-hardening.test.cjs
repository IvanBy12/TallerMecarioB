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
  return postgres(target.toString(), { max: 3, onnotice: () => {}, connection: { role } });
}
const api = runtime(process.env.TEST_API_LOGIN, process.env.TEST_API_PASSWORD, 'tallermecario_api');
const worker = runtime(process.env.TEST_WORKER_LOGIN, process.env.TEST_WORKER_PASSWORD, 'tallermecario_worker');
const id = () => randomUUID();
const a = { tenant: id(), customer: id(), vehicle: id(), owner: id() };
const b = { tenant: id(), customer: id(), vehicle: id(), owner: id() };
function denied(code, constraint) {
  return (e) => {
    assert.equal(e.code, code, e.message);
    if (constraint) assert.equal(e.constraint_name || e.constraint, constraint);
    return true;
  };
}
async function scoped(sql, tenant, fn, commit = true) {
  const c = await sql.reserve();
  try {
    await c.unsafe('BEGIN');
    await c`SELECT set_config('app.tenant_id', ${tenant}, true)`;
    const result = await fn(c);
    await c.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (e) { await c.unsafe('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}
async function insertVehicle(c, tenant, plate) {
  const vehicleId = id();
  await c`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
    VALUES (${vehicleId},${tenant},${plate},'car','B','M')`;
  return vehicleId;
}
test.before(async () => {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const t of [a, b]) {
      await tx`INSERT INTO workshops (id,slug,legal_name,display_name)
        VALUES (${t.tenant},${`hd-${t.tenant}`},'HD','HD')`;
    }
  });
  for (const t of [a, b]) await scoped(api, t.tenant, async (c) => {
    await c`INSERT INTO customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${t.customer},${t.tenant},'A','B','3000000000')`;
    await c`INSERT INTO vehicles (id,tenant_id,plate,vehicle_type,brand,model)
      VALUES (${t.vehicle},${t.tenant},'ABC123','car','B','M')`;
    await c`INSERT INTO vehicle_owners (id,tenant_id,vehicle_id,customer_id)
      VALUES (${t.owner},${t.tenant},${t.vehicle},${t.customer})`;
  });
});
test.after(async () => { await Promise.all([api.end({ timeout: 5 }), worker.end({ timeout: 5 }), admin.end({ timeout: 5 })]); });

test('HD-01 exact API table and column privileges', async () => {
  const allowed = {
    customers: ['document_type','document_number','first_name','last_name','phone','email','notes','updated_at'],
    vehicles: ['plate','vin','vehicle_type','brand','model','model_year','color','engine_number','current_mileage_km','updated_at'],
    vehicle_owners: ['valid_to'],
  };
  for (const [table, columns] of Object.entries(allowed)) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) {
      const [row] = await admin`SELECT has_table_privilege('tallermecario_api', ${`public.${table}`}, ${privilege}) AS yes`;
      assert.equal(row.yes, ['SELECT','INSERT'].includes(privilege), `${table}.${privilege}`);
    }
    const rows = await admin`SELECT attname FROM pg_attribute WHERE attrelid=${`public.${table}`}::regclass AND attnum>0 AND NOT attisdropped`;
    for (const { attname } of rows) {
      const [row] = await admin`SELECT has_column_privilege('tallermecario_api', ${`public.${table}`}, ${attname}, 'UPDATE') AS yes`;
      assert.equal(row.yes, columns.includes(attname), `${table}.${attname}`);
    }
  }
});
test('HD-02/03 worker and PUBLIC have no CRM privileges or trigger EXECUTE', async () => {
  for (const role of ['tallermecario_worker', 'public']) for (const table of ['customers','vehicles','vehicle_owners']) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) {
      const [row] = await admin`SELECT has_table_privilege(${role}, ${`public.${table}`}, ${privilege}) AS yes`;
      assert.equal(row.yes, false, `${role}.${table}.${privilege}`);
    }
    for (const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']) {
      const [row] = await admin`SELECT has_any_column_privilege(${role}, ${`public.${table}`}, ${privilege}) AS yes`;
      assert.equal(row.yes, false, `${role}.${table}.${privilege}`);
    }
  }
  const [fn] = await admin`SELECT has_function_privilege('public','app.enforce_vehicle_owner_history()','EXECUTE') AS yes`;
  assert.equal(fn.yes, false);
});
test('HD-04 RLS flags, exact policies, NOBYPASSRLS, function and trigger', async () => {
  const tables = await admin`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
    WHERE relname IN ('customers','vehicles','vehicle_owners') AND relnamespace='public'::regnamespace`;
  assert.equal(tables.length, 3);
  assert.ok(tables.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  const policies = await admin`SELECT tablename,policyname,cmd,roles,permissive,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('customers','vehicles','vehicle_owners')`;
  assert.equal(policies.length, 9);
  for (const table of ['customers','vehicles','vehicle_owners']) {
    assert.deepEqual(policies.filter((p) => p.tablename === table).map((p) => p.policyname).sort(),
      ['tenant_insert','tenant_select','tenant_update']);
    for (const p of policies.filter((row) => row.tablename === table)) {
      assert.deepEqual([...p.roles], ['tallermecario_api','tallermecario_worker']);
      assert.equal(p.permissive, 'PERMISSIVE');
      const expr = '(tenant_id = app.current_tenant_id())';
      const expected = {
        tenant_select: { cmd: 'SELECT', qual: expr, with_check: null },
        tenant_insert: { cmd: 'INSERT', qual: null, with_check: expr },
        tenant_update: { cmd: 'UPDATE', qual: expr, with_check: expr },
      }[p.policyname];
      assert.equal(p.cmd, expected.cmd);
      assert.equal(p.qual, expected.qual);
      assert.equal(p.with_check, expected.with_check);
    }
  }
  const roles = await admin`SELECT rolname,rolbypassrls FROM pg_roles WHERE rolname IN ('tallermecario_api','tallermecario_worker')`;
  assert.equal(roles.length, 2);
  assert.ok(roles.every((r) => !r.rolbypassrls));
  const [fn] = await admin`SELECT prosecdef,proowner::regrole::text AS owner,proconfig FROM pg_proc
    WHERE oid='app.enforce_vehicle_owner_history()'::regprocedure`;
  assert.equal(fn.prosecdef, false);
  assert.equal(fn.owner, 'tallermecario_schema_owner');
  assert.deepEqual(fn.proconfig, ['search_path=pg_catalog']);
  const [trg] = await admin`SELECT tgenabled,tgtype,tgattr::text AS attrs,tgfoid::regprocedure::text AS fn
    FROM pg_trigger WHERE tgrelid='public.vehicle_owners'::regclass AND tgname='vehicle_owners_history_guard_trg'`;
  assert.equal(trg.tgenabled, 'O');
  assert.equal(trg.tgtype, 19);
  assert.equal(trg.attrs, '');
  assert.equal(trg.fn, 'app.enforce_vehicle_owner_history()');
});
test('HD-10/11 API immutable identities, allowed updates and plate checks', async () => {
  for (const table of ['customers','vehicles']) for (const column of ['id','tenant_id','created_at']) {
    await assert.rejects(scoped(api, a.tenant, (c) => c.unsafe(`UPDATE ${table} SET ${column}=${column} WHERE false`)), denied('42501'));
  }
  await scoped(api, a.tenant, async (c) => {
    assert.equal((await c`UPDATE customers SET notes='ok' WHERE id=${a.customer}`).count, 1);
    assert.equal((await c`UPDATE vehicles SET model='N' WHERE id=${a.vehicle}`).count, 1);
    assert.equal((await c`UPDATE vehicles SET plate='XYZ123' WHERE id=${a.vehicle}`).count, 1);
    assert.equal((await c`UPDATE vehicles SET plate='ABC123' WHERE id=${a.vehicle}`).count, 1);
  });
  const duplicate = await scoped(api, a.tenant, (c) => insertVehicle(c, a.tenant, 'DUP123'));
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE vehicles SET plate='DUP123' WHERE id=${a.vehicle}`),
    denied('23505','vehicles_tenant_plate_key'));
  assert.ok(duplicate);
  for (const plate of ['abc123',' AbC123','ABC123 ','AbC123']) {
    await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE vehicles SET plate=${plate} WHERE id=${a.vehicle}`),
      denied('23514','vehicles_plate_normalized_check'));
  }
});
test('HD-12/13/15/40/41/42 ownership history guards privileged and runtime writes', async () => {
  for (const column of ['id','tenant_id','vehicle_id','customer_id','relationship_type','is_primary','valid_from','created_at']) {
    await assert.rejects(scoped(api, a.tenant, (c) => c.unsafe(`UPDATE vehicle_owners SET ${column}=${column} WHERE id='${a.owner}'`)), denied('42501'));
  }
  await assert.rejects(scoped(api, a.tenant, (c) => c`UPDATE vehicle_owners SET valid_to='2000-01-01' WHERE id=${a.owner}`),
    denied('23514','vehicle_owners_validity_check'));
  await scoped(api, a.tenant, (c) => c`UPDATE vehicle_owners SET valid_to=clock_timestamp() WHERE id=${a.owner}`);
  for (const expression of ['valid_to','NULL','clock_timestamp()']) {
    await assert.rejects(scoped(api, a.tenant, (c) => c.unsafe(`UPDATE vehicle_owners SET valid_to=${expression} WHERE id='${a.owner}'`)),
      denied('23514','vehicle_owners_history_guard'));
  }
  await assert.rejects(admin`UPDATE vehicle_owners SET valid_from=valid_from WHERE id=${a.owner}`,
    denied('23514','vehicle_owners_history_guard'));
  await assert.rejects(admin`UPDATE vehicle_owners SET customer_id=customer_id WHERE id=${a.owner}`,
    denied('23514','vehicle_owners_history_guard'));
  await assert.rejects(admin`UPDATE vehicle_owners SET valid_to=NULL WHERE id=${a.owner}`,
    denied('23514','vehicle_owners_history_guard'));
  await assert.rejects(admin`UPDATE vehicle_owners SET valid_from=valid_from + interval '1 second' WHERE id=${b.owner}`,
    denied('23514','vehicle_owners_history_guard'));
});
test('HD-14/16/20 row locks remain available; forbidden DML fails for both roles', async () => {
  for (const table of ['customers','vehicles','vehicle_owners']) {
    for (const sql of [api,worker]) {
      await assert.rejects(scoped(sql,a.tenant,(c) => c.unsafe(`DELETE FROM ${table} WHERE false`)),denied('42501'));
      await assert.rejects(sql.unsafe(`TRUNCATE ${table}`),denied('42501'));
    }
    for (const statement of [`SELECT * FROM ${table}`,`INSERT INTO ${table} DEFAULT VALUES`,`UPDATE ${table} SET id=id`]) {
      await assert.rejects(scoped(worker,a.tenant,(c) => c.unsafe(statement)),denied('42501'));
    }
  }
  await scoped(api,a.tenant,async (c) => {
    for (const [table,rowId] of [['customers',a.customer],['vehicles',a.vehicle],['vehicle_owners',a.owner]]) {
      assert.equal((await c.unsafe(`SELECT id FROM ${table} WHERE id='${rowId}' FOR UPDATE`)).length,1);
      assert.equal((await c.unsafe(`SELECT id FROM ${table} WHERE id='${rowId}' FOR NO KEY UPDATE`)).length,1);
    }
  });
});
test('HD-30/31/32 normalized uniqueness, tenant scope, and DOC_GAP-01 characterization', async () => {
  await scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,'QWE123'));
  await assert.rejects(scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,'QWE123')),
    denied('23505','vehicles_tenant_plate_key'));
  await scoped(api,b.tenant,(c) => insertVehicle(c,b.tenant,'QWE123'));
  for (const plate of ['abc123',' ABC123','ABC123 ','AbC123']) {
    await assert.rejects(scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,plate)),
      denied('23514','vehicles_plate_normalized_check'));
  }
  await scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,'ABC-123'));
  await scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,'ABC 123'));
  await scoped(api,a.tenant,(c) => insertVehicle(c,a.tenant,''));
});
test('HD-50 cross-tenant UPDATE on permitted column affects zero rows', async () => {
  assert.equal((await scoped(api,a.tenant,(c) => c`UPDATE customers SET notes='leak' WHERE id=${b.customer}`)).count,0);
  assert.equal((await scoped(api,a.tenant,(c) => c`UPDATE vehicles SET model='leak' WHERE id=${b.vehicle}`)).count,0);
  assert.equal((await scoped(api,a.tenant,(c) => c`UPDATE vehicle_owners SET valid_to=clock_timestamp() WHERE id=${b.owner}`)).count,0);
});
