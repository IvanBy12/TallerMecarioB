'use strict';

/**
 * S2-04 PATCH /api/v1/customers/:customerId: optimistic concurrency on the
 * exact updatedAt token (microseconds, never a JS Date), the no-op rule of
 * DOC_GAP-01, null/empty semantics and the document pair on the resulting
 * state (DOC_GAP-02), notes (DOC_GAP-03/04).
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

test('PATCH: 200 { customer }, only listed fields change, new updatedAt token (microseconds), no-store', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId, { email: 'a@example.com', notes: 'nota' });
  const before = await h.customerRow(customer.customerId);
  const response = await h.patchCustomer(app, a.advisor, a.tenantId, customer.customerId, {
    expectedUpdatedAt: customer.updatedAt, firstName: '  Beatriz ', phone: '300-765-4321',
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.headers['cache-control'], 'no-store');
  const updated = response.json.customer;
  assert.deepEqual(Object.keys(updated).sort(), h.DTO_KEYS);
  assert.equal(updated.firstName, 'Beatriz');
  assert.equal(updated.phone, '3007654321');
  assert.equal(updated.lastName, customer.lastName);
  assert.equal(updated.email, 'a@example.com');
  assert.equal(updated.notes, 'nota');
  assert.equal(updated.createdAt, customer.createdAt, 'createdAt never changes');
  assert.match(updated.updatedAt, h.TOKEN_FORMAT);
  assert.ok(updated.updatedAt > customer.updatedAt, 'strictly newer token');
  const after = await h.customerRow(customer.customerId);
  assert.equal(after.updated_at, updated.updatedAt);
  assert.equal(after.tenant_id, before.tenant_id);
  assert.notEqual(after.xmin, before.xmin, 'a real UPDATE happened');
});

test('OCC precision: the token is compared with PostgreSQL microseconds, never through a JS Date', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  await h.admin`UPDATE public.customers SET updated_at = '2026-03-04T05:06:07.123456Z' WHERE id = ${customer.customerId}`;
  const read = await h.getCustomer(app, a.owner, a.tenantId, customer.customerId);
  assert.equal(read.json.customer.updatedAt, '2026-03-04T05:06:07.123456Z', 'emitted with all 6 digits');

  for (const stale of ['2026-03-04T05:06:07.123000Z', '2026-03-04T05:06:07.123455Z', '2026-03-04T05:06:07.123457Z']) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: stale, firstName: 'X' });
    assert.equal(response.status, 409, stale);
    assert.equal(code(response), 'RESOURCE_VERSION_CONFLICT');
  }
  for (const malformed of [
    '2026-03-04T05:06:07.123Z', '2026-03-04T05:06:07.123456+00:00', '2026-03-04 05:06:07.123456Z',
    '2026-03-04T05:06:07.1234567Z', '1772600767123', '', 'garbage',
  ]) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: malformed, firstName: 'X' });
    assert.equal(response.status, 400, malformed);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  const exact = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: '2026-03-04T05:06:07.123456Z', firstName: 'Exacto',
  });
  assert.equal(exact.status, 200, JSON.stringify(exact.json));
  assert.equal(exact.json.customer.firstName, 'Exacto');
  assert.equal((await h.customerRow(customer.customerId)).first_name, 'Exacto');
});

test('OCC monotonic: a token in the future still yields a strictly newer updatedAt', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  await h.admin`UPDATE public.customers SET updated_at = '2999-01-01T00:00:00.000001Z' WHERE id = ${customer.customerId}`;
  const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: '2999-01-01T00:00:00.000001Z', lastName: 'Futuro',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.customer.updatedAt, '2999-01-01T00:00:00.000002Z');
});

test('OCC: a reused (stale) token is 409 with no write, even when the payload is identical to the current state', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  const first = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, lastName: 'Nuevo' });
  assert.equal(first.status, 200);
  const snapshot = await h.customerRow(customer.customerId);
  const auditsBefore = (await h.customerAudits(customer.customerId)).length;

  const staleChange = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, lastName: 'Otro' });
  assert.equal(staleChange.status, 409);
  assert.equal(code(staleChange), 'RESOURCE_VERSION_CONFLICT');
  assert.equal(staleChange.headers['cache-control'], 'no-store');
  const staleNoop = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, lastName: 'Nuevo' });
  assert.equal(staleNoop.status, 409, 'OCC is checked before the no-op decision');
  assert.deepEqual(await h.customerRow(customer.customerId), snapshot);
  assert.equal((await h.customerAudits(customer.customerId)).length, auditsBefore, '409 is not audited');
});

test('OCC concurrency: two PATCHes with the same token racing on the row lock -> exactly one 200 and one 409', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  const conn = await h.admin.reserve();
  let pending;
  try {
    await conn.unsafe('BEGIN');
    await conn`SELECT id FROM public.customers WHERE id = ${customer.customerId} FOR UPDATE`;
    pending = [
      h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'Uno' }),
      h.patchCustomer(app, a.advisor, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, firstName: 'Dos' }),
    ];
    await h.waitForLockWaiters(2);
  } finally {
    await conn.unsafe('COMMIT');
    conn.release();
  }
  const results = await Promise.all(pending);
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results.map((result) => result.json)));
  const winner = results.find((result) => result.status === 200).json.customer;
  const loser = results.find((result) => result.status === 409);
  assert.equal(code(loser), 'RESOURCE_VERSION_CONFLICT');
  const row = await h.customerRow(customer.customerId);
  assert.equal(row.first_name, winner.firstName, 'no silent last-write-wins');
  const audits = (await h.customerAudits(customer.customerId)).filter((audit) => audit.action === 'customer.updated');
  assert.equal(audits.length, 1);
});

test('DOC_GAP-01 no-op: identical normalized values -> 200 current DTO, no UPDATE, updatedAt unchanged, no audit', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId, { email: 'a@example.com', documentType: 'CC', documentNumber: '77', notes: 'uno\ndos' });
  const before = await h.customerRow(customer.customerId);
  const auditsBefore = await h.customerAudits(customer.customerId);
  const response = await h.patchCustomer(app, a.admin, a.tenantId, customer.customerId, {
    expectedUpdatedAt: customer.updatedAt,
    firstName: '  Ana ',
    phone: '(300) 123-4567',
    email: ' a@example.com ',
    documentType: 'CC',
    documentNumber: ' 77 ',
    notes: 'uno\r\ndos\n',
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json, { customer });
  const after = await h.customerRow(customer.customerId);
  assert.deepEqual(after, before, 'same row version (xmin), same updated_at');
  assert.deepEqual(await h.customerAudits(customer.customerId), auditsBefore, 'no customer.updated row');

  const again = await h.patchCustomer(app, a.admin, a.tenantId, customer.customerId, { expectedUpdatedAt: customer.updatedAt, lastName: 'Gómez' });
  assert.equal(again.status, 200, 'the unchanged token is still current after a no-op');

  const nullNoop = await created(a.owner, a.tenantId);
  const clearNothing = await h.patchCustomer(app, a.admin, a.tenantId, nullNoop.customerId, {
    expectedUpdatedAt: nullNoop.updatedAt, email: null, notes: '   ', documentType: '', documentNumber: null,
  });
  assert.equal(clearNothing.status, 200);
  assert.equal(clearNothing.json.customer.updatedAt, nullNoop.updatedAt, 'null/"" onto null fields is a no-op');
  assert.equal((await h.customerAudits(nullNoop.customerId)).filter((row) => row.action === 'customer.updated').length, 0);
});

test('DOC_GAP-02 PATCH: null clears nullable fields, "" -> null, required fields reject null/""', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId, { email: 'a@example.com', documentType: 'CC', documentNumber: '77', notes: 'nota' });
  const cleared = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: customer.updatedAt, email: '', notes: null, documentType: null, documentNumber: '  ',
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  const row = await h.customerRow(customer.customerId);
  for (const column of ['email', 'notes', 'document_type', 'document_number']) assert.equal(row[column], null, column);

  for (const [field, value] of [['firstName', null], ['lastName', ''], ['phone', null], ['phone', '  '], ['firstName', '   ']]) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
      expectedUpdatedAt: cleared.json.customer.updatedAt, [field]: value,
    });
    assert.equal(response.status, 400, `${field}=${JSON.stringify(value)}`);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
});

test('DOC_GAP-02 PATCH: document pair is evaluated on the merged resulting state', async () => {
  const { a } = await h.twoTenants();
  const withDoc = await created(a.owner, a.tenantId, { documentType: 'CC', documentNumber: '123' });
  const changeType = await h.patchCustomer(app, a.owner, a.tenantId, withDoc.customerId, { expectedUpdatedAt: withDoc.updatedAt, documentType: 'CE' });
  assert.equal(changeType.status, 200, 'only one side sent, but the resulting pair is complete');
  assert.equal(changeType.json.customer.documentNumber, '123');
  const token = changeType.json.customer.updatedAt;
  for (const body of [{ documentNumber: '' }, { documentType: null }, { documentNumber: null }, { documentType: 'CC', documentNumber: '' }]) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, withDoc.customerId, { expectedUpdatedAt: token, ...body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  assert.equal((await h.customerRow(withDoc.customerId)).document_type, 'CE', 'nothing written by the rejected patches');

  const withoutDoc = await created(a.owner, a.tenantId);
  const half = await h.patchCustomer(app, a.owner, a.tenantId, withoutDoc.customerId, { expectedUpdatedAt: withoutDoc.updatedAt, documentType: 'CC' });
  assert.equal(half.status, 400);
  const both = await h.patchCustomer(app, a.owner, a.tenantId, withoutDoc.customerId, {
    expectedUpdatedAt: withoutDoc.updatedAt, documentType: 'CC', documentNumber: '555',
  });
  assert.equal(both.status, 200);
  const clearBoth = await h.patchCustomer(app, a.owner, a.tenantId, withoutDoc.customerId, {
    expectedUpdatedAt: both.json.customer.updatedAt, documentType: null, documentNumber: null,
  });
  assert.equal(clearBoth.status, 200);
  assert.equal(clearBoth.json.customer.documentType, null);
});

test('DOC_GAP-03/04 PATCH: notes multiline normalization and limits apply exactly as in POST', async () => {
  const { a } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: customer.updatedAt, notes: ' uno\r\n\r\n  dos\rtres ',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.customer.notes, 'uno\n\n  dos\ntres');
  for (const notes of ['a\tb', 'x'.repeat(2001), `a${String.fromCodePoint(0x2066)}b`]) {
    const bad = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, { expectedUpdatedAt: response.json.customer.updatedAt, notes });
    assert.equal(bad.status, 400);
  }
  const big = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, {
    expectedUpdatedAt: response.json.customer.updatedAt, notes: ' '.repeat(16400),
  });
  assert.equal(big.status, 413);
  assert.equal(code(big), 'PAYLOAD_TOO_LARGE');
});

test('PATCH strict body: expectedUpdatedAt required, non-empty subset, immutable/unknown fields -> 400; 415', async () => {
  const { a, b } = await h.twoTenants();
  const customer = await created(a.owner, a.tenantId);
  const token = customer.updatedAt;
  const snapshot = await h.customerRow(customer.customerId);
  for (const body of [
    { firstName: 'X' },
    { expectedUpdatedAt: token },
    {},
    { expectedUpdatedAt: token, customerId: randomUUID() },
    { expectedUpdatedAt: token, id: randomUUID() },
    { expectedUpdatedAt: token, tenantId: b.tenantId },
    { expectedUpdatedAt: token, createdAt: token },
    { expectedUpdatedAt: token, updatedAt: token },
    { expectedUpdatedAt: token, archivedAt: null },
    { expectedUpdatedAt: token, firstName: 5 },
    { expectedUpdatedAt: 123, firstName: 'X' },
  ]) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, customer.customerId, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  const text = await h.call(app, {
    subject: a.owner.subject, method: 'PATCH', url: `/api/v1/customers/${customer.customerId}`, tenantId: a.tenantId,
    rawBody: JSON.stringify({ expectedUpdatedAt: token, firstName: 'X' }), headers: { 'content-type': 'text/plain' },
  });
  assert.equal(text.status, 415);
  assert.deepEqual(await h.customerRow(customer.customerId), snapshot, 'no rejected request wrote anything');
});

test('PATCH anti-oracle: malformed, nonexistent and other-tenant ids -> identical 404, no effect in the other tenant', async () => {
  const { a, b } = await h.twoTenants();
  const foreign = await created(b.owner, b.tenantId);
  const foreignBefore = await h.customerRow(foreign.customerId);
  const shapes = new Set();
  for (const id of [foreign.customerId, randomUUID(), 'not-a-uuid']) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, id, { expectedUpdatedAt: foreign.updatedAt, firstName: 'Hijack' });
    assert.equal(response.status, 404, id);
    assert.equal(code(response), 'CUSTOMER_NOT_FOUND');
    shapes.add(h.errorShape(response));
  }
  assert.equal(shapes.size, 1);
  assert.deepEqual(await h.customerRow(foreign.customerId), foreignBefore);
  assert.equal((await h.customerAudits(foreign.customerId)).length, 1, 'only B\'s own customer.created');
  // An invalid body is 400 for every id kind (no 404-vs-400 difference by existence).
  for (const id of [foreign.customerId, randomUUID(), 'not-a-uuid']) {
    const response = await h.patchCustomer(app, a.owner, a.tenantId, id, { expectedUpdatedAt: foreign.updatedAt, firstName: '' });
    assert.equal(response.status, 400, id);
  }
});
