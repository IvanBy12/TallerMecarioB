'use strict';

/**
 * S1-07 — the audit_logs boundary in PostgreSQL itself, probed with direct
 * SQL through the NOBYPASSRLS runtime logins (never owner / migrator /
 * superuser, AGENTS.md §10) and a privilege-less role standing for PUBLIC:
 * catalog privileges, append-only, RLS read/write across tenants, the 0017
 * actor guard, the 0017 column grants and the allowlisted SECURITY DEFINER
 * writers.
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert, admin } = h;
let t;
let nobody;
const RUNTIMES = ['tallermecario_api', 'tallermecario_worker'];
const COMMON = ['action', 'actor_membership_id', 'actor_type', 'actor_user_id', 'after_json', 'before_json', 'entity_id',
  'entity_type', 'id', 'metadata_json', 'outcome', 'reason_code', 'request_id', 'tenant_id', 'trace_id'];
const EXPECTED_INSERT = {
  tallermecario_api: [...COMMON, 'ip_address'].sort(),
  tallermecario_worker: [...COMMON].sort(),
  tallermecario_bootstrap_resolver: ['action', 'actor_type', 'actor_user_id', 'entity_id', 'entity_type', 'id', 'metadata_json', 'outcome', 'request_id', 'tenant_id'],
  tallermecario_identity_sync: [],
};

before(async () => {
  t = await h.tenants();
  nobody = `tm_s107_nobody_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.unsafe(`CREATE ROLE ${nobody} NOLOGIN NOINHERIT NOBYPASSRLS`);
  // One committed row per tenant (valid for the catalog) to probe UPDATE/DELETE/SELECT.
  for (const tenant of [t.a, t.b]) {
    await admin`INSERT INTO public.audit_logs ${admin({
      id: randomUUID(), tenant_id: tenant.tenantId, actor_type: 'user', actor_user_id: tenant.owner.user.id,
      actor_membership_id: tenant.owner.membershipId, action: 'membership.suspended', outcome: 'denied',
      entity_type: 'membership', entity_id: tenant.owner.membershipId, reason_code: 'self_membership_modification',
      request_id: `seed-${randomUUID()}`, metadata_json: admin.json({ command: 'suspend' }),
    })}`;
  }
});
after(async () => {
  await admin.unsafe(`DROP ROLE IF EXISTS ${nobody}`);
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await admin.end();
});

const denied = (error) => {
  assert.equal(error?.code, '42501', `expected 42501, got ${error?.code}: ${error?.message}`);
  return true;
};
const guard = (error) => {
  assert.equal(error?.code, '42501', `expected 42501, got ${error?.code}: ${error?.message}`);
  assert.equal(error?.constraint_name, 'audit_logs_actor_guard');
  return true;
};

/** API TenantContext GUCs of a member. */
const apiGucs = (tenant, member, requestId = randomUUID()) => ({
  tenant_id: tenant.tenantId, user_id: member.user.id, membership_id: member.membershipId, request_id: requestId,
});

async function insertAs(pool, gucs, row) {
  return h.runtimeTx(pool, gucs, (tx) => tx`INSERT INTO public.audit_logs ${tx(row)}`);
}

/** Runs `fn` as the privilege-less role (standing for PUBLIC) inside an admin transaction. */
async function asNobody(fn) {
  const conn = await admin.reserve();
  try {
    await conn.unsafe('BEGIN');
    await conn.unsafe(`SET LOCAL ROLE ${nobody}`);
    return await fn(conn);
  } finally {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    conn.release();
  }
}

describe('catalog: privileges, policies, triggers, functions', () => {
  test('runtime: SELECT + column INSERT only (no user_agent, no created_at); no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER', async () => {
    for (const role of RUNTIMES) {
      const [table] = await admin`
        SELECT has_table_privilege(${role}, 'public.audit_logs', 'SELECT') AS select,
          has_table_privilege(${role}, 'public.audit_logs', 'INSERT') AS insert,
          has_table_privilege(${role}, 'public.audit_logs', 'UPDATE') AS update,
          has_table_privilege(${role}, 'public.audit_logs', 'DELETE') AS delete,
          has_table_privilege(${role}, 'public.audit_logs', 'TRUNCATE') AS truncate,
          has_table_privilege(${role}, 'public.audit_logs', 'REFERENCES') AS references,
          has_table_privilege(${role}, 'public.audit_logs', 'TRIGGER') AS trigger`;
      assert.deepEqual({ ...table }, { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false }, role);
    }
  });

  test('column INSERT/UPDATE sets per role (api, worker, resolver, identity_sync, PUBLIC)', async () => {
    for (const [role, expected] of Object.entries(EXPECTED_INSERT)) {
      const rows = await admin`
        SELECT a.attname,
          has_column_privilege(${role}, 'public.audit_logs', a.attname, 'INSERT') AS ins,
          has_column_privilege(${role}, 'public.audit_logs', a.attname, 'UPDATE') AS upd
        FROM pg_attribute a WHERE a.attrelid = 'public.audit_logs'::regclass AND a.attnum > 0 AND NOT a.attisdropped`;
      assert.deepEqual(rows.filter((row) => row.ins).map((row) => row.attname).sort(), expected, `${role} INSERT columns`);
      assert.deepEqual(rows.filter((row) => row.upd).map((row) => row.attname), [], `${role} UPDATE columns`);
    }
    const [publicAcl] = await admin`
      SELECT has_any_column_privilege('public', 'public.audit_logs', 'SELECT') AS s,
        has_any_column_privilege('public', 'public.audit_logs', 'INSERT') AS i,
        has_any_column_privilege('public', 'public.audit_logs', 'UPDATE') AS u,
        EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = 'public.audit_logs'::regclass AND x.grantee = 0) AS acl`;
    assert.deepEqual({ ...publicAcl }, { s: false, i: false, u: false, acl: false });
  });

  test('RLS ENABLE + FORCE, owner schema_owner, exactly tenant_select + tenant_insert bound to the TenantContext tenant', async () => {
    const [rel] = await admin`
      SELECT relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE oid = 'public.audit_logs'::regclass`;
    assert.deepEqual({ ...rel }, { relrowsecurity: true, relforcerowsecurity: true, owner: 'tallermecario_schema_owner' });
    const policies = await admin`
      SELECT policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'audit_logs' ORDER BY policyname`;
    assert.deepEqual(policies.map((row) => ({ ...row })), [
      { policyname: 'tenant_insert', cmd: 'INSERT', roles: ['tallermecario_api', 'tallermecario_worker'], qual: null, with_check: '(tenant_id = app.current_tenant_id())' },
      { policyname: 'tenant_select', cmd: 'SELECT', roles: ['tallermecario_api', 'tallermecario_worker'], qual: '(tenant_id = app.current_tenant_id())', with_check: null },
    ]);
  });

  test('append-only + actor-guard triggers enabled; guard function is SECURITY INVOKER, owned by schema_owner, not executable by anyone', async () => {
    const triggers = await admin`
      SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal ORDER BY tgname`;
    assert.deepEqual(triggers.map((row) => `${row.tgname}:${row.tgenabled}`), [
      'audit_logs_actor_guard_trg:O', 'audit_logs_append_only_row_trg:O', 'audit_logs_append_only_truncate_trg:O',
    ]);
    const [fn] = await admin`
      SELECT prosecdef, pg_get_userbyid(proowner) AS owner, proconfig,
        has_function_privilege('tallermecario_api', oid, 'EXECUTE') AS api,
        has_function_privilege('tallermecario_worker', oid, 'EXECUTE') AS worker,
        EXISTS (SELECT 1 FROM aclexplode(proacl) x WHERE x.grantee = 0) AS public
      FROM pg_proc WHERE oid = 'app.enforce_audit_log_actor()'::regprocedure`;
    assert.deepEqual({ ...fn }, { prosecdef: false, owner: 'tallermecario_schema_owner', proconfig: ['search_path=pg_catalog'], api: false, worker: false, public: false });
  });

  test('only two allowlisted SECURITY DEFINER writers; runtime/PUBLIC reach only the one granted to them', async () => {
    const writers = await admin`
      SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
        has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api,
        has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker,
        has_function_privilege('tallermecario_identity_sync', p.oid, 'EXECUTE') AS identity_sync,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.prosecdef AND p.prosrc ILIKE '%insert into public.audit_logs%'
      ORDER BY 1`;
    assert.deepEqual(writers.map((row) => ({ ...row })), [
      { fn: 'app.bootstrap_append_identity_audit(text,text,text,uuid,jsonb,text)', owner: 'tallermecario_bootstrap_resolver', prosecdef: true, api: false, worker: false, identity_sync: true, public: false },
      { fn: 'app.bootstrap_provision_user(text,text,uuid,text,text,text)', owner: 'tallermecario_bootstrap_resolver', prosecdef: true, api: true, worker: false, identity_sync: false, public: false },
    ]);
  });

  test('history is never a CASCADE target; audit_logs FKs are NO ACTION', async () => {
    const [incoming] = await admin`SELECT count(*)::int AS n FROM pg_constraint WHERE confrelid = 'public.audit_logs'::regclass`;
    assert.equal(incoming.n, 0);
    const outgoing = await admin`SELECT conname, confdeltype FROM pg_constraint WHERE conrelid = 'public.audit_logs'::regclass AND contype = 'f' ORDER BY 1`;
    assert.deepEqual(outgoing.map((row) => row.confdeltype), ['a', 'a', 'a']);
  });
});

describe('append-only (runtime SQL)', () => {
  for (const [kind, pool, gucs] of [
    ['api', () => h.apiPool, () => apiGucs(t.a, t.a.owner)],
    ['worker', () => h.workerPool, () => ({ tenant_id: t.a.tenantId })],
  ]) {
    test(`${kind}: UPDATE, DELETE and TRUNCATE of audit_logs are refused (42501) and the row is unchanged`, async () => {
      const [row] = await admin`SELECT id, action, outcome, metadata_json FROM public.audit_logs WHERE tenant_id = ${t.a.tenantId} LIMIT 1`;
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`UPDATE public.audit_logs SET outcome = 'success' WHERE id = ${row.id}`), denied);
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`UPDATE public.audit_logs SET metadata_json = '{}' WHERE true`), denied);
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`DELETE FROM public.audit_logs WHERE id = ${row.id}`), denied);
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`TRUNCATE public.audit_logs`), denied);
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_actor_guard_trg`), (error) => ['42501'].includes(error.code));
      await assert.rejects(h.runtimeTx(pool(), gucs(), (tx) => tx`SET LOCAL session_replication_role = replica`), denied);
      const [unchanged] = await admin`SELECT id, action, outcome, metadata_json FROM public.audit_logs WHERE id = ${row.id}`;
      assert.deepEqual({ ...unchanged }, { ...row });
    });
  }

  test('PUBLIC (a role with no grant) can neither read, write, nor call the audit writers', async () => {
    await assert.rejects(asNobody((tx) => tx`SELECT count(*) FROM public.audit_logs`), denied);
    await assert.rejects(asNobody((tx) => tx`INSERT INTO public.audit_logs ${tx(h.auditRow({ tenant_id: t.a.tenantId, request_id: 'x' }))}`), denied);
    await assert.rejects(asNobody((tx) => tx`UPDATE public.audit_logs SET outcome = 'success'`), denied);
    await assert.rejects(asNobody((tx) => tx`DELETE FROM public.audit_logs`), denied);
    await assert.rejects(asNobody((tx) => tx`SELECT app.bootstrap_append_identity_audit('identity.user_deleted','success','user',${randomUUID()}::uuid,'{}'::jsonb,'x')`), denied);
    await assert.rejects(asNobody((tx) => tx`SELECT * FROM app.bootstrap_provision_user('clerk','user_x',${randomUUID()}::uuid,'x@y.z',NULL,'x')`), denied);
  });

  test('runtime cannot call the tenant-less identity audit writer', async () => {
    for (const pool of [h.apiPool, h.workerPool]) {
      await assert.rejects(h.runtimeTx(pool, { tenant_id: t.a.tenantId }, (tx) => tx`
        SELECT app.bootstrap_append_identity_audit('identity.user_deleted', 'success', 'user', ${t.a.owner.user.id}::uuid, '{}'::jsonb, 'forged')`), denied);
    }
  });
});

describe('tenant isolation (RLS, runtime SQL)', () => {
  test('read: A sees only A rows, never B rows nor tenant-less identity rows; no context sees nothing', async () => {
    for (const [pool, gucs] of [[h.apiPool, apiGucs(t.a, t.a.owner)], [h.workerPool, { tenant_id: t.a.tenantId }]]) {
      const rows = await h.runtimeTx(pool, gucs, (tx) => tx`SELECT DISTINCT tenant_id FROM public.audit_logs`);
      assert.deepEqual(rows.map((row) => row.tenant_id), [t.a.tenantId]);
      const [b] = await h.runtimeTx(pool, gucs, (tx) => tx`SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = ${t.b.tenantId} OR tenant_id IS NULL`);
      assert.equal(b.n, 0);
      const [none] = await h.runtimeTx(pool, {}, (tx) => tx`SELECT count(*)::int AS n FROM public.audit_logs`);
      assert.equal(none.n, 0);
    }
  });

  test('write: A cannot insert a row for B, a tenant-less row, or any row without context (tenant spoof impossible)', async () => {
    const gucs = apiGucs(t.a, t.a.owner);
    const base = { actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId, request_id: gucs.request_id, entity_id: t.a.technician.membershipId };
    await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...base, tenant_id: t.b.tenantId })), denied);
    await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...base, tenant_id: null })), denied);
    await assert.rejects(insertAs(h.apiPool, {}, h.auditRow({ ...base, tenant_id: t.a.tenantId })), denied);
    await assert.rejects(insertAs(h.workerPool, { tenant_id: t.a.tenantId }, h.auditRow({ actor_type: 'provider', tenant_id: t.b.tenantId, request_id: 'job' })), denied);
    // Control: the same row for its own tenant is accepted (rolled back).
    await insertAs(h.apiPool, gucs, h.auditRow({ ...base, tenant_id: t.a.tenantId }));
  });
});

describe('actor trust (0017 guard, runtime SQL)', () => {
  test('API: the user actor must be the bound TenantContext (user, membership, request id); provider/platform refused', async () => {
    const gucs = apiGucs(t.a, t.a.owner);
    const ok = { tenant_id: t.a.tenantId, actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId, request_id: gucs.request_id, entity_id: t.a.technician.membershipId };
    await insertAs(h.apiPool, gucs, h.auditRow(ok));
    const spoofs = {
      'another member of A as user': { actor_user_id: t.a.admin.user.id },
      'a user of tenant B': { actor_user_id: t.b.owner.user.id },
      'another membership of A': { actor_membership_id: t.a.admin.membershipId },
      'membership omitted': { actor_membership_id: null },
      'user omitted': { actor_user_id: null },
      'forged request id': { request_id: `forged-${randomUUID()}` },
      'provider actor': { actor_type: 'provider', actor_user_id: null, actor_membership_id: null },
      'platform actor': { actor_type: 'platform', actor_user_id: null, actor_membership_id: null },
      'system row carrying a user': { actor_type: 'system' },
    };
    for (const [label, change] of Object.entries(spoofs)) {
      await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...ok, ...change })), guard, label);
    }
    await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...ok, actor_membership_id: t.b.owner.membershipId })), (error) => ['42501', '23503'].includes(error.code));
    await insertAs(h.apiPool, gucs, h.auditRow({ ...ok, actor_type: 'system', actor_user_id: null, actor_membership_id: null }));
    // No request context bound at all.
    await assert.rejects(insertAs(h.apiPool, { tenant_id: t.a.tenantId }, h.auditRow({ ...ok, actor_type: 'system', actor_user_id: null, actor_membership_id: null })), guard);
  });

  test('worker: only system/provider rows without a user actor — a job is never attributed to a user (existing or not)', async () => {
    const gucs = { tenant_id: t.a.tenantId, user_id: t.a.owner.user.id, membership_id: t.a.owner.membershipId };
    const base = { tenant_id: t.a.tenantId, action: 'membership.revoked', reason_code: 'identity_provider_user_deleted', request_id: randomUUID(), entity_id: t.a.technician.membershipId };
    await insertAs(h.workerPool, gucs, h.auditRow({ ...base, actor_type: 'provider' }));
    await insertAs(h.workerPool, gucs, h.auditRow({ ...base, actor_type: 'system' }));
    for (const change of [
      { actor_type: 'user', actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId },
      { actor_type: 'user', actor_user_id: randomUUID() },
      { actor_type: 'user' },
      { actor_type: 'provider', actor_user_id: t.a.technician.user.id },
      { actor_type: 'system', actor_membership_id: t.a.owner.membershipId },
      { actor_type: 'platform' },
    ]) {
      await assert.rejects(insertAs(h.workerPool, gucs, h.auditRow({ ...base, ...change })), guard, JSON.stringify(change));
    }
  });

  test('column grants: raw user_agent and a caller-chosen created_at are refused; the worker cannot write ip_address', async () => {
    const gucs = apiGucs(t.a, t.a.owner);
    const ok = { tenant_id: t.a.tenantId, actor_user_id: t.a.owner.user.id, actor_membership_id: t.a.owner.membershipId, request_id: gucs.request_id, entity_id: t.a.technician.membershipId };
    await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...ok, user_agent: 'Mozilla/5.0' })), denied);
    await assert.rejects(insertAs(h.apiPool, gucs, h.auditRow({ ...ok, created_at: new Date('2020-01-01T00:00:00Z') })), denied);
    await assert.rejects(insertAs(h.workerPool, { tenant_id: t.a.tenantId }, h.auditRow({
      tenant_id: t.a.tenantId, actor_type: 'provider', action: 'membership.revoked', reason_code: 'identity_provider_user_deleted', request_id: 'job', ip_address: '10.0.0.1',
    })), denied);
    const [row] = await h.runtimeTx(h.apiPool, gucs, (tx) => tx`
      INSERT INTO public.audit_logs ${tx(h.auditRow(ok))} RETURNING created_at, user_agent, now() AS tx_start`);
    assert.equal(row.user_agent, null);
    assert.equal(row.created_at.getTime(), row.tx_start.getTime(), 'created_at is the PostgreSQL transaction clock');
  });
});
