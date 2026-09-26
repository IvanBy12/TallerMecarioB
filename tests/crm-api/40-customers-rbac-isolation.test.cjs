'use strict';

/**
 * S2-04 authorization (RBAC §5: customers.read/create/update for owner, admin
 * and service_advisor; technician none) and tenant isolation proven at both
 * layers: through the API (A <-> B) and directly in PostgreSQL as the
 * NOBYPASSRLS runtime (ADR-009 §3-§5/§10, 0018 grants).
 */

const h = require('./helpers.cjs');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');

const { assert } = h;
let app;

before(async () => {
  app = await h.buildCustomersApp();
});

after(async () => {
  await h.closeAll(app);
});

const code = (response) => response.json?.error?.code;

async function created(actor, tenantId, overrides = {}) {
  const response = await h.createCustomer(app, actor, tenantId, h.validCustomer(overrides));
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return response.json.customer;
}

/* -------------------------------------------------------------------------- */
/* RBAC                                                                       */
/* -------------------------------------------------------------------------- */

test('RBAC: owner, admin and service_advisor can create, read, list and update', async () => {
  const { a } = await h.twoTenants();
  for (const actor of [a.owner, a.admin, a.advisor]) {
    const customer = await created(actor, a.tenantId);
    assert.equal((await h.getCustomer(app, actor, a.tenantId, customer.customerId)).status, 200);
    assert.equal((await h.listCustomers(app, actor, a.tenantId)).status, 200);
    const patch = await h.patchCustomer(app, actor, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, lastName: 'Editado' });
    assert.equal(patch.status, 200);
  }
});

test('RBAC: technician gets 403 PERMISSION_DENIED on all four routes, before any id/body/query validation, with no effect', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  const auditsBefore = await h.tenantAuditCount(a.tenantId);
  const countBefore = await h.tenantCustomerCount(a.tenantId);
  const attempts = [
    () => h.createCustomer(app, a.technician, a.tenantId, h.validCustomer()),
    () => h.createCustomer(app, a.technician, a.tenantId, { bogus: true }),
    () => h.getCustomer(app, a.technician, a.tenantId, customer.customerId),
    () => h.getCustomer(app, a.technician, a.tenantId, 'not-a-uuid'),
    () => h.getCustomer(app, a.technician, a.tenantId, randomUUID()),
    () => h.listCustomers(app, a.technician, a.tenantId),
    () => h.listCustomers(app, a.technician, a.tenantId, `phone=${customer.phone}`),
    () => h.listCustomers(app, a.technician, a.tenantId, 'limit=999&q=x'),
    () => h.patchCustomer(app, a.technician, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'X' }),
    () => h.patchCustomer(app, a.technician, a.tenantId, 'not-a-uuid', { nonsense: 1 }),
  ];
  for (const attempt of attempts) {
    const response = await attempt();
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(code(response), 'PERMISSION_DENIED');
    assert.equal(JSON.stringify(response.json).includes(customer.phone), false);
  }
  assert.equal(await h.tenantAuditCount(a.tenantId), auditsBefore, 'PERMISSION_DENIED is not audited');
  assert.equal(await h.tenantCustomerCount(a.tenantId), countBefore);
  assert.equal((await h.customerRow(customer.customerId)).first_name, 'Ana');
});

test('RBAC: unauthenticated requests are 401 and never reach the handler', async () => {
  const { a } = await h.twoTenants();
  for (const [method, url] of [['POST', '/api/v1/customers'], ['GET', '/api/v1/customers'], ['GET', `/api/v1/customers/${randomUUID()}`], ['PATCH', `/api/v1/customers/${randomUUID()}`]]) {
    const response = await h.call(app, { method, url, tenantId: a.tenantId, body: method === 'GET' ? undefined : h.validCustomer() });
    assert.equal(response.status, 401, `${method} ${url}`);
    assert.equal(code(response), 'AUTHENTICATION_REQUIRED');
  }
  assert.equal(await h.tenantCustomerCount(a.tenantId), 0);
});

test('no DELETE/archive route exists for customers', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  for (const [method, url] of [
    ['DELETE', `/api/v1/customers/${customer.customerId}`],
    ['POST', `/api/v1/customers/${customer.customerId}/archive`],
    ['POST', `/api/v1/customers/${customer.customerId}/unarchive`],
    ['PUT', `/api/v1/customers/${customer.customerId}`],
  ]) {
    const response = await h.call(app, { subject: a.owner.subject, method, url, tenantId: a.tenantId });
    assert.equal(response.status, 404, `${method} ${url}`);
  }
  assert.ok(await h.customerRow(customer.customerId), 'customer still exists');
});

/* -------------------------------------------------------------------------- */
/* Cross-tenant through the API                                               */
/* -------------------------------------------------------------------------- */

test('cross-tenant E2E: A cannot read, update, list or search B customers and vice versa; B rows untouched', async () => {
  const { a, b } = await h.twoTenants();
  const shared = { firstName: 'Compartida', lastName: 'Mismo', phone: '3115556677', documentType: 'CC', documentNumber: 'DUP-1' };
  const inA = await created(a.owner, a.tenantId, shared);
  const inB = await created(b.owner, b.tenantId, shared);
  const snapshotA = await h.customerRow(inA.customerId);
  const snapshotB = await h.customerRow(inB.customerId);

  for (const [actor, tenantId, own, foreign] of [[a.owner, a.tenantId, inA, inB], [b.owner, b.tenantId, inB, inA]]) {
    const read = await h.getCustomer(app, actor, tenantId, foreign.customerId);
    assert.equal(read.status, 404);
    assert.equal(code(read), 'CUSTOMER_NOT_FOUND');
    const patch = await h.patchCustomer(app, actor, tenantId, foreign.customerId, { expectedUpdatedAt: foreign.updatedAt, firstName: 'Robado' });
    assert.equal(patch.status, 404);
    assert.equal(code(patch), 'CUSTOMER_NOT_FOUND');
    for (const query of ['', 'limit=100', `phone=${shared.phone}`, `documentNumber=${shared.documentNumber}`, 'name=compart', 'name=mismo']) {
      const list = await h.listCustomers(app, actor, tenantId, query);
      assert.equal(list.status, 200);
      assert.deepEqual(list.json.customers.map((customer) => customer.customerId), [own.customerId], query);
    }
  }
  assert.deepEqual(await h.customerRow(inA.customerId), snapshotA);
  assert.deepEqual(await h.customerRow(inB.customerId), snapshotB);
  for (const [tenantId, id] of [[a.tenantId, inB.customerId], [b.tenantId, inA.customerId]]) {
    const [row] = await h.admin`SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = ${tenantId} AND entity_id = ${id}`;
    assert.equal(row.n, 0, 'no audit row references the other tenant\'s customer');
  }
});

test('tenant comes only from the TenantContext: a member of two workshops writes where X-Tenant-Id selects; no membership -> 403', async () => {
  const { a, b } = await h.twoTenants();
  const c = await h.createWorkshop([{ user: a.advisor.user, roles: ['service_advisor'] }]);
  const noSelection = await h.createCustomer(app, a.advisor, undefined, h.validCustomer());
  assert.equal(noSelection.status, 409);
  assert.equal(code(noSelection), 'TENANT_SELECTION_REQUIRED');
  const inC = await h.createCustomer(app, a.advisor, c.tenantId, h.validCustomer({ firstName: 'EnC' }));
  assert.equal(inC.status, 201);
  assert.equal((await h.customerRow(inC.json.customer.customerId)).tenant_id, c.tenantId);
  const inA = await h.createCustomer(app, a.advisor, a.tenantId, h.validCustomer({ firstName: 'EnA' }));
  assert.equal((await h.customerRow(inA.json.customer.customerId)).tenant_id, a.tenantId);
  const fromA = await h.getCustomer(app, a.advisor, a.tenantId, inC.json.customer.customerId);
  assert.equal(fromA.status, 404, 'selected tenant scopes reads even for a user who belongs to both');

  const denied = await h.createCustomer(app, a.owner, b.tenantId, h.validCustomer());
  assert.equal(denied.status, 403);
  assert.equal(code(denied), 'TENANT_ACCESS_DENIED');
  const deniedList = await h.listCustomers(app, a.owner, b.tenantId);
  assert.equal(deniedList.status, 403);
  assert.equal(await h.tenantCustomerCount(b.tenantId), 0);
});

/* -------------------------------------------------------------------------- */
/* Direct PostgreSQL probes (runtime roles, never owner/superuser)            */
/* -------------------------------------------------------------------------- */

test('runtime role: api login acts as tallermecario_api, NOBYPASSRLS, not superuser, customers FORCE RLS', async () => {
  const [role] = await h.apiPool`
    SELECT current_user AS who, r.rolbypassrls, r.rolsuper,
      (SELECT relforcerowsecurity AND relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.customers'::regclass) AS forced
    FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user
  `;
  assert.equal(role.who, 'tallermecario_api');
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  assert.equal(role.forced, true);
});

test('RLS probes as the api runtime bound to A: B rows invisible and unwritable, cross-tenant INSERT and tenant moves rejected', async () => {
  const { a, b } = await h.twoTenants();
  const own = await h.seedCustomer(a.tenantId, { first_name: 'Propio' });
  const foreign = await h.seedCustomer(b.tenantId, { first_name: 'Ajeno' });
  const bind = { tenantId: a.tenantId, userId: a.owner.user.id, membershipId: a.owner.membershipId };

  const visible = await h.asRuntime(h.apiPool, bind, (tx) => tx`SELECT id FROM public.customers`);
  assert.deepEqual(visible.map((row) => row.id), [own.id]);
  const byId = await h.asRuntime(h.apiPool, bind, (tx) => tx`SELECT id FROM public.customers WHERE id = ${foreign.id}`);
  assert.equal(byId.length, 0);
  const updated = await h.asRuntime(h.apiPool, bind, (tx) => tx`UPDATE public.customers SET first_name = 'Hack' WHERE id = ${foreign.id} RETURNING id`);
  assert.equal(updated.length, 0);
  const locked = await h.asRuntime(h.apiPool, bind, (tx) => tx`SELECT id FROM public.customers WHERE id = ${foreign.id} FOR NO KEY UPDATE`);
  assert.equal(locked.length, 0);

  await assert.rejects(
    h.asRuntime(h.apiPool, bind, (tx) => tx`INSERT INTO public.customers (id, tenant_id, first_name, last_name, phone) VALUES (${randomUUID()}, ${b.tenantId}, 'X', 'Y', '3000000000')`),
    (error) => error.code === '42501',
    'RLS WITH CHECK rejects a row for another tenant',
  );
  await assert.rejects(
    h.asRuntime(h.apiPool, bind, (tx) => tx`UPDATE public.customers SET tenant_id = ${b.tenantId} WHERE id = ${own.id}`),
    (error) => error.code === '42501',
    'no UPDATE privilege on tenant_id (0018)',
  );
  for (const column of ['id', 'created_at']) {
    await assert.rejects(
      h.asRuntime(h.apiPool, bind, (tx) => tx.unsafe(`UPDATE public.customers SET ${column} = ${column} WHERE id = $1`, [own.id])),
      (error) => error.code === '42501',
      `${column} immutable for runtime`,
    );
  }
  await assert.rejects(
    h.asRuntime(h.apiPool, bind, (tx) => tx`DELETE FROM public.customers WHERE id = ${own.id}`),
    (error) => error.code === '42501',
    'no DELETE for runtime',
  );
  assert.equal((await h.customerRow(foreign.id)).first_name, 'Ajeno');
  assert.equal((await h.customerRow(own.id)).tenant_id, a.tenantId);
});

test('RLS without TenantContext: api runtime sees 0 customers; worker has no privilege on customers', async () => {
  const { a } = await h.twoTenants();
  await h.seedCustomer(a.tenantId);
  const [row] = await h.apiPool`SELECT count(*)::int AS n FROM public.customers`;
  assert.equal(row.n, 0);
  await assert.rejects(h.workerPool`SELECT count(*) FROM public.customers`, (error) => error.code === '42501');
});

test('pool hygiene: after success, 4xx and 5xx customer requests no connection keeps tenant GUCs', async () => {
  const { a, b } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  await h.getCustomer(app, a.owner, a.tenantId, randomUUID());
  await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: '2000-01-01T00:00:00.000000Z', firstName: 'X' });
  await h.listCustomers(app, b.owner, b.tenantId, 'limit=0');
  await h.getCustomer(app, a.technician, a.tenantId, customer.customerId);
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'customer.created'");
  try {
    const failed = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
    assert.equal(failed.status, 500);
  } finally {
    await remove();
  }
  const probes = await Promise.all(Array.from({ length: 20 }, () => h.apiPool`
    SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.membership_id', true) AS membership,
      current_setting('app.user_id', true) AS "user", (SELECT count(*)::int FROM public.customers) AS visible
  `));
  for (const [probe] of probes) {
    assert.ok(probe.tenant === null || probe.tenant === '', `leaked tenant ${probe.tenant}`);
    assert.ok(probe.membership === null || probe.membership === '');
    assert.ok(probe.user === null || probe.user === '');
    assert.equal(probe.visible, 0);
  }
});
