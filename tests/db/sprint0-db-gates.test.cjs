'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const h = require('./helpers.cjs');

const { admin, id, fixture, makeTenant } = h;
let api;
let worker;

const denied = (error) => {
  assert.equal(error.code, '42501', `expected insufficient_privilege, got ${error.code}: ${error.message}`);
  return true;
};

const APPEND_ONLY_TABLES = [
  'order_status_history',
  'quote_authorizations',
  'quote_authorization_items',
  'inventory_movements',
  'billing_events',
  'audit_logs',
  'webhook_events',
  'customer_payment_allocations',
  'customer_payment_reconciliation_runs',
  'legal_acceptances',
];

const BOOTSTRAP_FUNCTIONS = [
  'bootstrap_list_active_memberships',
  'bootstrap_validate_active_membership',
  'bootstrap_resolve_quote_token',
  'bootstrap_resolve_order_access_token',
  'bootstrap_resolve_whatsapp_account',
  'bootstrap_resolve_wompi_payment_by_reference',
  'bootstrap_resolve_wompi_payment_by_transaction',
  'bootstrap_claim_outbox_events',
];

test.before(async () => {
  await h.setupRoles();
  api = h.runtime('tallermecario_api');
  worker = h.runtime('tallermecario_worker');
});

test.after(async () => {
  await Promise.all([api.end(), worker.end()]);
  await admin.end();
});

test.describe('runtime database privilege boundary', () => {
  for (const [role, getConnection] of [
    ['tallermecario_api', () => api],
    ['tallermecario_worker', () => worker],
  ]) {
    test(`${role}: NOBYPASSRLS, non-owner, no DDL and no privileged SET ROLE`, async () => {
      const sql = getConnection();
      const [attributes] = await sql`
        SELECT current_user AS current_role,
          r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
          pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') AS create_public,
          pg_catalog.has_schema_privilege(current_user, 'app', 'CREATE') AS create_app,
          pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS create_database
        FROM pg_catalog.pg_roles AS r
        WHERE r.rolname = current_user
      `;
      assert.equal(attributes.current_role, role);
      for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'create_public', 'create_app', 'create_database']) {
        assert.equal(attributes[key], false, `${role}.${key}`);
      }

      const [owned] = await sql`
        SELECT count(*)::int AS count
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_roles AS r ON r.oid = c.relowner
        WHERE r.rolname = current_user
      `;
      assert.equal(owned.count, 0);

      for (const privileged of ['tallermecario_schema_owner', 'tallermecario_migrator', 'tallermecario_bootstrap_resolver']) {
        const [membership] = await sql`SELECT pg_catalog.pg_has_role(current_user, ${privileged}, 'SET') AS allowed`;
        assert.equal(membership.allowed, false, `${role} must not SET ROLE ${privileged}`);
        await assert.rejects(sql.unsafe(`SET ROLE ${privileged}`), denied);
      }

      await assert.rejects(sql.unsafe(`CREATE TABLE public.${role}_ddl_probe (id integer)`), denied);
      await assert.rejects(sql.unsafe('ALTER TABLE public.customers DISABLE ROW LEVEL SECURITY'), denied);
      await assert.rejects(sql.unsafe('CREATE POLICY runtime_probe ON public.customers USING (true)'), denied);
      await assert.rejects(sql.unsafe('SELECT * FROM drizzle.__drizzle_migrations'), denied);
    });
  }
});

test.describe('RLS catalog and transaction-local context', () => {
  test('every direct tenant table has ENABLE + FORCE, expected policies and schema-owner ownership', async () => {
    const uncovered = await admin`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, owner.rolname AS owner
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = c.relowner
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (
          c.relname IN ('workshops', 'audit_logs')
          OR EXISTS (
            SELECT 1 FROM information_schema.columns AS col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname
              AND col.column_name = 'tenant_id' AND col.is_nullable = 'NO'
          )
        )
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR owner.rolname <> 'tallermecario_schema_owner')
    `;
    assert.equal(uncovered.length, 0);

    const missingPolicies = await admin`
      WITH covered AS (
        SELECT c.relname
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (
            c.relname IN ('workshops', 'audit_logs')
            OR EXISTS (
              SELECT 1 FROM information_schema.columns AS col
              WHERE col.table_schema = 'public' AND col.table_name = c.relname
                AND col.column_name = 'tenant_id' AND col.is_nullable = 'NO'
            )
          )
      )
      SELECT covered.relname
      FROM covered
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policies AS p
        WHERE p.schemaname = 'public' AND p.tablename = covered.relname AND p.cmd = 'SELECT'
          AND p.roles @> ARRAY['tallermecario_api'::name, 'tallermecario_worker'::name]
      )
      OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policies AS p
        WHERE p.schemaname = 'public' AND p.tablename = covered.relname AND p.cmd = 'INSERT'
          AND p.roles @> ARRAY['tallermecario_api'::name, 'tallermecario_worker'::name]
      )
      ORDER BY covered.relname
    `;
    assert.equal(missingPolicies.length, 0);
  });

  test('missing context sees no tenant rows; A cannot read/write B; context clears after COMMIT and ROLLBACK', async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    assert.equal((await api`SELECT id FROM workshops`).length, 0);
    await assert.rejects(
      api`INSERT INTO workshop_locations ${api({ id: id(), tenant_id: tenantA.tenant, name: 'X', address_line: 'x', city: 'c', department: 'd' })}`,
      denied,
    );

    const conn = await api.reserve();
    try {
      await conn.unsafe('BEGIN');
      await conn`SELECT set_config('app.tenant_id', ${tenantA.tenant}, true)`;
      const visible = await conn`SELECT id FROM workshops ORDER BY id`;
      assert.deepEqual(visible.map((row) => row.id), [tenantA.tenant]);
      assert.equal((await conn`UPDATE workshop_locations SET name = 'blocked' WHERE id = ${tenantB.location}`).count, 0);
      await assert.rejects(
        conn`INSERT INTO workshop_locations ${conn({ id: id(), tenant_id: tenantB.tenant, name: 'X', address_line: 'x', city: 'c', department: 'd' })}`,
        denied,
      );
      await conn.unsafe('ROLLBACK');

      let [context] = await conn`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant`;
      assert.equal(context.tenant, null);

      await conn.unsafe('BEGIN');
      await conn`SELECT set_config('app.tenant_id', ${tenantA.tenant}, true)`;
      await conn.unsafe('COMMIT');
      [context] = await conn`SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant`;
      assert.equal(context.tenant, null);
      assert.equal((await conn`SELECT id FROM workshops`).length, 0);
    } finally {
      await conn.unsafe('ROLLBACK').catch(() => {});
      conn.release();
    }
  });
});

test.describe('append-only physical protection', () => {
  test('catalog grants, update policies, defensive triggers and FK delete actions are safe', async () => {
    for (const role of ['tallermecario_api', 'tallermecario_worker']) {
      for (const table of APPEND_ONLY_TABLES) {
        const [privileges] = await admin`
          SELECT
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'UPDATE') AS update,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'DELETE') AS delete,
            pg_catalog.has_table_privilege(${role}, ${`public.${table}`}, 'TRUNCATE') AS truncate
        `;
        assert.deepEqual(privileges, { update: false, delete: false, truncate: false }, `${role} ${table}`);
      }
    }

    const updatePolicies = await admin`
      SELECT tablename FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND tablename IN ('customer_payment_allocations', 'customer_payment_reconciliation_runs')
        AND cmd = 'UPDATE'
    `;
    assert.equal(updatePolicies.length, 0);

    const [triggerCount] = await admin`
      SELECT count(*)::int AS count
      FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${APPEND_ONLY_TABLES})
        AND NOT t.tgisinternal
        AND t.tgname LIKE '%append_only%'
    `;
    assert.equal(triggerCount.count, APPEND_ONLY_TABLES.length * 2);

    const [cascade] = await admin`
      SELECT count(*)::int AS count
      FROM pg_catalog.pg_constraint AS fk
      JOIN pg_catalog.pg_class AS child ON child.oid = fk.conrelid
      JOIN pg_catalog.pg_class AS parent ON parent.oid = fk.confrelid
      WHERE fk.contype = 'f' AND fk.confdeltype = 'c'
        AND (child.relname = ANY(${APPEND_ONLY_TABLES}) OR parent.relname = ANY(${APPEND_ONLY_TABLES}))
    `;
    assert.equal(cascade.count, 0);
  });

  for (const [role, getConnection] of [
    ['api', () => api],
    ['worker', () => worker],
  ]) {
    test(`${role}: UPDATE/DELETE/TRUNCATE are rejected on every append-only table`, async () => {
      const sql = getConnection();
      for (const table of APPEND_ONLY_TABLES) {
        await assert.rejects(sql.unsafe(`UPDATE public.${table} SET id = id WHERE false`), denied);
        await assert.rejects(sql.unsafe(`DELETE FROM public.${table} WHERE false`), denied);
        await assert.rejects(sql.unsafe(`TRUNCATE TABLE public.${table}`), denied);
      }
    });
  }
});

test.describe('bootstrap allowlist', () => {
  test('SECURITY DEFINER metadata, ownership, search_path and grants are minimal', async () => {
    const functions = await admin`
      SELECT p.proname, p.prosecdef, owner.rolname AS owner, p.proconfig,
        pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles AS owner ON owner.oid = p.proowner
      WHERE n.nspname = 'app' AND p.proname = ANY(${BOOTSTRAP_FUNCTIONS})
      ORDER BY p.proname
    `;
    assert.equal(functions.length, BOOTSTRAP_FUNCTIONS.length);
    for (const fn of functions) {
      assert.equal(fn.prosecdef, true, fn.proname);
      assert.equal(fn.owner, 'tallermecario_bootstrap_resolver', fn.proname);
      assert.equal(fn.public_execute, false, fn.proname);
      assert.ok(fn.proconfig.includes('search_path=pg_catalog, public'), fn.proname);
    }

    const [resolver] = await admin`
      SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_bootstrap_resolver'
    `;
    assert.deepEqual(resolver, {
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: true,
    });

    const unexpected = await admin`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'tallermecario_bootstrap_resolver'
        AND NOT (
          privilege_type = 'SELECT'
          AND table_name IN ('users', 'memberships', 'quote_authorization_tokens',
            'customer_order_access_tokens', 'tenant_whatsapp_accounts', 'payments', 'outbox_events')
        )
    `;
    assert.equal(unexpected.length, 0);
  });

  test('identity, exact-token, WhatsApp and Wompi resolvers do not enumerate unrelated tenants', async () => {
    const tenantA = id();
    const tenantB = id();
    const tenantSuspended = id();
    const userA = id();
    const userB = id();
    const memberA = id();
    const memberB = id();
    const memberSuspended = id();
    const quoteToken = id();
    const orderToken = id();
    const quoteVersion = id();
    const order = id();
    const whatsapp = id();
    const subscription = id();
    const payment = id();
    const now = new Date();
    const later = new Date(Date.now() + 3600_000);

    await fixture(async (tx) => {
      for (const tenant of [tenantA, tenantB, tenantSuspended]) {
        await tx`INSERT INTO workshops ${tx({ id: tenant, slug: `w-${tenant}`, legal_name: 'T', display_name: 'T' })}`;
      }
      await tx`INSERT INTO users ${tx({ id: userA, external_subject: `subject-${userA}`, email: `${userA}@test.local` })}`;
      await tx`INSERT INTO users ${tx({ id: userB, external_subject: `subject-${userB}`, email: `${userB}@test.local` })}`;
      await tx`INSERT INTO memberships ${tx({ id: memberA, tenant_id: tenantA, user_id: userA })}`;
      await tx`INSERT INTO memberships ${tx({ id: memberB, tenant_id: tenantB, user_id: userA })}`;
      await tx`INSERT INTO memberships ${tx({ id: memberSuspended, tenant_id: tenantSuspended, user_id: userA, status: 'suspended', suspended_at: now })}`;
      await tx`INSERT INTO memberships ${tx({ id: id(), tenant_id: tenantA, user_id: userB })}`;

      await tx`INSERT INTO quote_authorization_tokens ${tx({ id: quoteToken, tenant_id: tenantA, quote_version_id: quoteVersion, token_hash: `hash-${quoteToken}`, created_by_membership_id: memberA, expires_at: later })}`;
      await tx`INSERT INTO customer_order_access_tokens ${tx({ id: orderToken, tenant_id: tenantB, order_id: order, token_hash: `hash-${orderToken}`, access_scope: 'order_tracking', created_by_membership_id: memberB, expires_at: later })}`;
      await tx`INSERT INTO tenant_whatsapp_accounts ${tx({ id: whatsapp, tenant_id: tenantA, waba_id: `waba-${whatsapp}`, phone_number_id: `phone-${whatsapp}`, status: 'active', connected_by_membership_id: memberA, connected_at: now })}`;
      await tx`INSERT INTO payments ${tx({ id: payment, tenant_id: tenantB, subscription_id: subscription, environment: 'test', reference: `ref-${payment}`, provider_transaction_id: `tx-${payment}`, amount: 1000 })}`;
    });

    const memberships = await api`SELECT * FROM app.bootstrap_list_active_memberships('clerk', ${`subject-${userA}`})`;
    assert.deepEqual(new Set(memberships.map((row) => row.tenant_id)), new Set([tenantA, tenantB]));
    assert.equal(memberships.length, 2);
    assert.equal((await api`SELECT * FROM app.bootstrap_validate_active_membership('clerk', ${`subject-${userA}`}, ${tenantA})`).length, 1);
    assert.equal((await api`SELECT * FROM app.bootstrap_validate_active_membership('clerk', ${`subject-${userA}`}, ${tenantSuspended})`).length, 0);
    assert.equal((await api`SELECT * FROM app.bootstrap_list_active_memberships('clerk', 'missing-subject')`).length, 0);

    const [quote] = await api`SELECT * FROM app.bootstrap_resolve_quote_token(${`hash-${quoteToken}`})`;
    assert.equal(quote.tenant_id, tenantA);
    assert.deepEqual(Object.keys(quote).sort(), ['expires_at', 'quote_version_id', 'tenant_id', 'token_id', 'token_status']);
    assert.equal((await api`SELECT * FROM app.bootstrap_resolve_quote_token('missing-hash')`).length, 0);

    const [tracking] = await api`SELECT * FROM app.bootstrap_resolve_order_access_token(${`hash-${orderToken}`})`;
    assert.equal(tracking.tenant_id, tenantB);
    assert.equal((await api`SELECT * FROM app.bootstrap_resolve_order_access_token('missing-hash')`).length, 0);

    const [wa] = await worker`SELECT * FROM app.bootstrap_resolve_whatsapp_account(${`phone-${whatsapp}`})`;
    assert.deepEqual(wa, { tenant_id: tenantA, whatsapp_account_id: whatsapp });
    assert.equal((await worker`SELECT * FROM app.bootstrap_resolve_whatsapp_account('missing-phone')`).length, 0);

    const [byReference] = await worker`SELECT * FROM app.bootstrap_resolve_wompi_payment_by_reference('test', ${`ref-${payment}`})`;
    const [byTransaction] = await worker`SELECT * FROM app.bootstrap_resolve_wompi_payment_by_transaction('test', ${`tx-${payment}`})`;
    assert.equal(byReference.tenant_id, tenantB);
    assert.equal(byTransaction.payment_id, payment);
    assert.equal((await worker`SELECT * FROM app.bootstrap_resolve_wompi_payment_by_reference('production', ${`ref-${payment}`})`).length, 0);

    for (const table of ['users', 'outbox_events']) {
      await assert.rejects(api.unsafe(`SELECT * FROM public.${table} LIMIT 1`), denied);
    }
    for (const table of ['memberships', 'quote_authorization_tokens', 'customer_order_access_tokens', 'tenant_whatsapp_accounts', 'payments']) {
      assert.equal((await api.unsafe(`SELECT * FROM public.${table} LIMIT 1`)).length, 0);
    }
  });

  test('worker claims globally only through the allowlisted function, then returns to tenant-scoped RLS', async () => {
    const tenantA = id();
    const tenantB = id();
    const eventA = id();
    const eventB = id();
    await fixture(async (tx) => {
      await tx`INSERT INTO workshops ${tx({ id: tenantA, slug: `w-${tenantA}`, legal_name: 'A', display_name: 'A' })}`;
      await tx`INSERT INTO workshops ${tx({ id: tenantB, slug: `w-${tenantB}`, legal_name: 'B', display_name: 'B' })}`;
      await tx`INSERT INTO outbox_events ${tx({ id: eventA, tenant_id: tenantA, aggregate_type: 'test', event_type: 'test.a', payload_json: {}, available_at: new Date(Date.now() - 1000) })}`;
      await tx`INSERT INTO outbox_events ${tx({ id: eventB, tenant_id: tenantB, aggregate_type: 'test', event_type: 'test.b', payload_json: {}, available_at: new Date(Date.now() - 500) })}`;
    });

    await assert.rejects(api`SELECT * FROM app.bootstrap_claim_outbox_events(1)`, denied);
    assert.equal((await worker`SELECT * FROM app.bootstrap_claim_outbox_events(-1)`).length, 0);
    const first = await worker`SELECT * FROM app.bootstrap_claim_outbox_events(1)`;
    const second = await worker`SELECT * FROM app.bootstrap_claim_outbox_events(10)`;
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.deepEqual(new Set([first[0].tenant_id, second[0].tenant_id]), new Set([tenantA, tenantB]));

    const conn = await worker.reserve();
    try {
      await conn.unsafe('BEGIN');
      await conn`SELECT set_config('app.tenant_id', ${first[0].tenant_id}, true)`;
      const visible = await conn`SELECT id FROM workshops ORDER BY id`;
      assert.deepEqual(visible.map((row) => row.id), [first[0].tenant_id]);
      await conn.unsafe('COMMIT');
      assert.equal((await conn`SELECT id FROM workshops`).length, 0);
    } finally {
      await conn.unsafe('ROLLBACK').catch(() => {});
      conn.release();
    }
  });
});

test('truncated FK name is deterministic and collision-free', async () => {
  const intended = 'webhook_processing_attempts_webhook_event_id_webhook_events_id_fk';
  const expected = intended.slice(0, 63);
  const constraints = await admin`
    SELECT conname FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.webhook_processing_attempts'::regclass
  `;
  assert.ok(constraints.some((row) => row.conname === expected));

  const sql = readFileSync('drizzle/0000_initial_schema.sql', 'utf8');
  const intendedNames = [...sql.matchAll(/CONSTRAINT\s+"([^"]+)"/g)].map((match) => match[1]);
  const truncated = new Map();
  for (const name of intendedNames) {
    const physical = name.slice(0, 63);
    const matches = truncated.get(physical) || [];
    matches.push(name);
    truncated.set(physical, matches);
  }
  const collisions = [...truncated.values()].filter((names) => new Set(names).size > 1);
  assert.deepEqual(collisions, []);
});
