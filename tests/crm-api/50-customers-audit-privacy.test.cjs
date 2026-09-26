'use strict';

/**
 * S2-04 audit (Operación §5.2 CRM catalog, DOC_GAP-05) and privacy
 * (Operación §6.3, Security Baseline §15): customer.created /
 * customer.updated in the same transaction as the change, actor from the
 * TenantContext, snake_case column names only; nothing audited for reads,
 * 4xx or no-ops; no PII in process output, error bodies or audit rows.
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

test('customer.created: one row, user actor from TenantContext, minimized, fields in canonical order regardless of body order', async () => {
  const { a } = await h.twoTenants();
  const response = await h.createCustomer(app, a.advisor, a.tenantId, {
    notes: 'n', documentNumber: '1', documentType: 'CC', email: 'x@example.com', phone: '3001234567', lastName: 'L', firstName: 'F',
  });
  assert.equal(response.status, 201);
  const [audit, ...rest] = await h.customerAudits(response.json.customer.customerId);
  assert.equal(rest.length, 0);
  assert.equal(audit.action, 'customer.created');
  assert.equal(audit.outcome, 'success');
  assert.equal(audit.tenant_id, a.tenantId);
  assert.equal(audit.actor_type, 'user');
  assert.equal(audit.actor_user_id, a.advisor.user.id);
  assert.equal(audit.actor_membership_id, a.advisor.membershipId);
  assert.equal(audit.entity_type, 'customer');
  assert.equal(audit.reason_code, null);
  assert.equal(audit.before_json, null);
  assert.equal(audit.after_json, null);
  assert.equal(audit.user_agent, null);
  assert.match(audit.request_id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(audit.metadata_json, { fields: h.AUDIT_FIELD_ORDER });

  const minimal = await h.createCustomer(app, a.owner, a.tenantId, { phone: '3001234567', firstName: 'F', lastName: 'L', email: null });
  const [minimalAudit] = await h.customerAudits(minimal.json.customer.customerId);
  assert.deepEqual(minimalAudit.metadata_json, { fields: ['first_name', 'last_name', 'phone', 'email'] }, 'informed fields, including an explicit null');
});

test('customer.updated: changed_fields only (normalized comparison), canonical order, never expected_updated_at/timestamps/values', async () => {
  const { a } = await h.twoTenants();
  const { json } = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ email: 'e@example.com' }));
  const customer = json.customer;
  const response = await h.patchCustomer(app, a.admin, a.tenantId, customer.customerId, {
    notes: 'nueva', phone: '300 123 4567', expectedUpdatedAt: customer.updatedAt, email: null, firstName: 'Nuevo',
  });
  assert.equal(response.status, 200);
  const audits = await h.customerAudits(customer.customerId);
  assert.deepEqual(audits.map((audit) => audit.action), ['customer.created', 'customer.updated']);
  const updated = audits[1];
  assert.deepEqual(updated.metadata_json, { changed_fields: ['first_name', 'email', 'notes'] });
  assert.equal(updated.actor_user_id, a.admin.user.id);
  assert.equal(updated.actor_membership_id, a.admin.membershipId);
  assert.equal(updated.before_json, null);
  assert.equal(updated.after_json, null);
  const serialized = JSON.stringify(updated);
  for (const forbidden of ['expected_updated_at', 'expectedUpdatedAt', 'updated_at', 'created_at', 'tenant_id', 'Nuevo', 'nueva', 'e@example.com', '3001234567']) {
    assert.equal(JSON.stringify(updated.metadata_json).includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes('Nuevo'), false);
});

test('not audited: reads, lists, 400, 403, 404, 409, 415 and the PATCH no-op', async () => {
  const { a } = await h.twoTenants();
  const { json } = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
  const customer = json.customer;
  const before = await h.tenantAuditCount(a.tenantId);
  await h.getCustomer(app, a.owner, a.tenantId, customer.customerId);
  await h.listCustomers(app, a.owner, a.tenantId, 'name=an');
  await h.createCustomer(app, a.owner, a.tenantId, { firstName: '' });
  await h.getCustomer(app, a.technician, a.tenantId, customer.customerId);
  await h.getCustomer(app, a.owner, a.tenantId, randomUUID());
  await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: '2000-01-01T00:00:00.000000Z', firstName: 'X' });
  await h.call(app, { subject: a.owner.subject, method: 'POST', url: '/api/v1/customers', tenantId: a.tenantId, rawBody: '{}', headers: { 'content-type': 'text/plain' } });
  const noop = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'Ana' });
  assert.equal(noop.status, 200);
  assert.equal(await h.tenantAuditCount(a.tenantId), before);
});

test('atomicity: a failing audit INSERT rolls back the customer INSERT/UPDATE (500 INTERNAL_ERROR, sanitized)', async () => {
  const { a } = await h.twoTenants();
  const { json } = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
  const customer = json.customer;
  const snapshot = await h.customerRow(customer.customerId);
  const countBefore = await h.tenantCustomerCount(a.tenantId);

  const removeCreate = await h.injectFailure('audit_logs', "NEW.action = 'customer.created'");
  try {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ firstName: 'Fantasma' }));
    assert.equal(response.status, 500);
    assert.equal(code(response), 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(response.json).includes('TEST_INJECTED_FAILURE'), false, 'no DB detail leaks');
  } finally {
    await removeCreate();
  }
  assert.equal(await h.tenantCustomerCount(a.tenantId), countBefore, 'no customer without its audit row');

  const removeUpdate = await h.injectFailure('audit_logs', "NEW.action = 'customer.updated'");
  try {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'Fantasma' });
    assert.equal(response.status, 500);
    assert.equal(code(response), 'INTERNAL_ERROR');
  } finally {
    await removeUpdate();
  }
  assert.deepEqual(await h.customerRow(customer.customerId), snapshot, 'UPDATE rolled back with its audit row');
  const retry = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'Real' });
  assert.equal(retry.status, 200, 'the token is still current after the rollback');
});

test('privacy: PII sentinels never reach stdout/stderr/console, error bodies or audit rows', async () => {
  const { a } = await h.twoTenants();
  const tag = randomUUID().replaceAll('-', '').slice(0, 10);
  const sentinel = {
    firstName: `Zpii${tag}first`,
    lastName: `Zpii${tag}last`,
    email: `zpii${tag}@sentinel.test`,
    documentNumber: `ZPII${tag}DOC`,
    notes: `Zpii${tag} nota\nprivada`,
    phone: `31${tag.replace(/\D/gu, '').padEnd(8, '7').slice(0, 8)}`,
  };
  const values = [sentinel.firstName, sentinel.lastName, sentinel.email, sentinel.documentNumber, `Zpii${tag}`, sentinel.phone];
  const bodies = [];
  const output = await h.captureOutput(async () => {
    const created = await h.createCustomer(app, a.owner, a.tenantId, { ...sentinel, documentType: 'CC' });
    assert.equal(created.status, 201, 'sentinel customer created');
    const { customerId, updatedAt } = created.json.customer;
    const q = (value) => encodeURIComponent(value);
    const errorResponses = [
      await h.listCustomers(app, a.owner, a.tenantId, `phone=${q(sentinel.phone)}&name=${q(sentinel.firstName)}&documentNumber=${q(sentinel.documentNumber)}`),
      await h.listCustomers(app, a.owner, a.tenantId, `email=${q(sentinel.email)}`),
      await h.listCustomers(app, a.owner, a.tenantId, `name=${q(sentinel.firstName)}%0Ax`),
      await h.createCustomer(app, a.owner, a.tenantId, { ...sentinel, email: `${sentinel.firstName}-not-an-email` }),
      await h.createCustomer(app, a.owner, a.tenantId, { ...sentinel, phone: `${sentinel.lastName}` }),
      await h.createCustomer(app, a.owner, a.tenantId, { ...sentinel, [sentinel.firstName]: sentinel.lastName }),
      await h.patchCustomer(app, a.owner, a.tenantId, customerId, { expectedUpdatedAt: updatedAt, notes: `${sentinel.notes}\tx` }),
      await h.patchCustomer(app, a.owner, a.tenantId, randomUUID(), { expectedUpdatedAt: updatedAt, firstName: sentinel.firstName }),
      await h.patchCustomer(app, a.owner, a.tenantId, customerId, { expectedUpdatedAt: '2000-01-01T00:00:00.000000Z', lastName: sentinel.lastName }),
      await h.getCustomer(app, a.technician, a.tenantId, customerId),
      await h.call(app, { subject: a.owner.subject, method: 'POST', url: '/api/v1/customers', tenantId: a.tenantId, rawBody: `{"firstName":"${sentinel.firstName}"` }),
    ];
    for (const response of errorResponses.slice(1)) {
      assert.ok(response.status >= 400, `expected an error status, got ${response.status}`);
      bodies.push(JSON.stringify(response.json));
    }
    const patched = await h.patchCustomer(app, a.owner, a.tenantId, customerId, { expectedUpdatedAt: updatedAt, lastName: `${sentinel.lastName}2` });
    assert.equal(patched.status, 200);
  });
  for (const value of values) {
    assert.equal(output.includes(value), false, 'no PII in process output');
    for (const body of bodies) assert.equal(body.includes(value), false, 'no PII reflected in error bodies');
  }
  const audits = await h.admin`
    SELECT concat_ws('|', action, entity_type, reason_code, before_json::text, after_json::text, metadata_json::text, request_id, user_agent) AS text
    FROM public.audit_logs WHERE tenant_id = ${a.tenantId}
  `;
  assert.ok(audits.length >= 2);
  for (const { text } of audits) {
    for (const value of values) assert.equal(text.includes(value), false, 'no PII in audit rows');
  }
});
