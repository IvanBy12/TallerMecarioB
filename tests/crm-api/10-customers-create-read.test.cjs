'use strict';

/**
 * S2-04 POST /api/v1/customers and GET /api/v1/customers/:customerId through
 * the real HTTP pipeline (Clerk JWT -> TenantContext transaction -> RBAC route
 * guard -> service -> PostgreSQL as the NOBYPASSRLS api runtime).
 * Contract: Arquitectura §13.4 (+ «Clientes — cierre S2-04»), Diccionario 01 §10.
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
const bidi = String.fromCodePoint(0x202e);

/* -------------------------------------------------------------------------- */
/* POST success + DTO                                                         */
/* -------------------------------------------------------------------------- */

test('POST: 201 { customer } with the exact CustomerDto, UUIDv7 server id, tenant from TenantContext, no-store', async () => {
  const { a } = await h.twoTenants();
  const response = await h.createCustomer(app, a.advisor, a.tenantId, h.validCustomer({
    email: 'Ana.Gomez@Example.COM', documentType: 'CC', documentNumber: '1020304050', notes: 'Cliente frecuente',
  }));
  assert.equal(response.status, 201, JSON.stringify(response.json));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.json), ['customer']);
  const { customer } = response.json;
  assert.deepEqual(Object.keys(customer).sort(), h.DTO_KEYS);
  assert.match(customer.customerId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, 'UUIDv7');
  assert.equal(customer.firstName, 'Ana');
  assert.equal(customer.lastName, 'Gómez');
  assert.equal(customer.phone, '3001234567');
  assert.equal(customer.email, 'Ana.Gomez@Example.COM', 'email is never lowercased');
  assert.equal(customer.documentType, 'CC');
  assert.equal(customer.documentNumber, '1020304050');
  assert.equal(customer.notes, 'Cliente frecuente');
  assert.match(customer.createdAt, h.TOKEN_FORMAT);
  assert.match(customer.updatedAt, h.TOKEN_FORMAT);
  assert.equal(customer.createdAt, customer.updatedAt);

  const row = await h.customerRow(customer.customerId);
  assert.equal(row.tenant_id, a.tenantId);
  assert.equal(row.updated_at, customer.updatedAt, 'DTO timestamp is the exact PostgreSQL value (microseconds)');
  assert.equal(row.created_at, customer.createdAt);
});

test('POST: minimal body stores optional fields as null; GET returns the same DTO', async () => {
  const { a } = await h.twoTenants();
  const created = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
  assert.equal(created.status, 201);
  const { customer } = created.json;
  assert.equal(customer.email, null);
  assert.equal(customer.documentType, null);
  assert.equal(customer.documentNumber, null);
  assert.equal(customer.notes, null);
  const read = await h.getCustomer(app, a.admin, a.tenantId, customer.customerId);
  assert.equal(read.status, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.deepEqual(read.json, { customer });
});

test('GET: uppercase UUID path resolves the same customer (canonicalized)', async () => {
  const { a } = await h.twoTenants();
  const { json } = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer());
  const read = await h.getCustomer(app, a.owner, a.tenantId, json.customer.customerId.toUpperCase());
  assert.equal(read.status, 200);
  assert.equal(read.json.customer.customerId, json.customer.customerId);
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

test('normalization: NFC + trim on text, internal whitespace kept; phone strips only space - . ( ); no +57', async () => {
  const { a } = await h.twoTenants();
  const response = await h.createCustomer(app, a.owner, a.tenantId, {
    firstName: '  José  Luis ',
    lastName: '\tPérez\n',
    phone: ' (300) 123-45.67 ',
    documentType: ' CC ',
    documentNumber: '  AB 123  ',
    email: '  ana@example.com  ',
  });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  const { customer } = response.json;
  assert.equal(customer.firstName, 'José  Luis', 'NFC, trimmed, internal double space preserved');
  assert.equal(customer.lastName, 'Pérez');
  assert.equal(customer.phone, '3001234567');
  assert.equal(customer.documentType, 'CC');
  assert.equal(customer.documentNumber, 'AB 123');
  assert.equal(customer.email, 'ana@example.com');

  const plus = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ phone: '+57 300 123 4567' }));
  assert.equal(plus.json.customer.phone, '+573001234567');
  const local = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ phone: '3001234567' }));
  assert.equal(local.json.customer.phone, '3001234567', 'no implicit country code');
});

test('phone: only the approved separators are removed; boundaries 7 and 15 digits', async () => {
  const { a } = await h.twoTenants();
  for (const phone of ['1234567', '123456789012345', '+123456789012345']) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ phone }));
    assert.equal(response.status, 201, phone);
  }
  for (const phone of [
    '123456', '1234567890123456', '300\t1234567', '300 1234567', '300_1234567', '300/1234567',
    '300 123 456a', '++3001234567', '300+1234567', '', '   ', '١٢٣٤٥٦٧٨',
  ]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ phone }));
    assert.equal(response.status, 400, JSON.stringify(phone));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
});

test('email: trimmed, case preserved, existing shape check; "" -> null; invalid -> 400', async () => {
  const { a } = await h.twoTenants();
  const empty = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ email: '   ' }));
  assert.equal(empty.status, 201);
  assert.equal(empty.json.customer.email, null);
  for (const email of ['not-an-email', 'a@b', 'a b@example.com', `a${bidi}@example.com`, 'a\u0000@example.com', `${'x'.repeat(310)}@example.com`]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ email }));
    assert.equal(response.status, 400, email.slice(0, 20));
  }
});

test('DOC_GAP-02: required fields reject null, "" and whitespace-only; nullable fields accept null in POST and "" -> null', async () => {
  const { a } = await h.twoTenants();
  for (const field of ['firstName', 'lastName', 'phone']) {
    for (const value of [null, '', '   ']) {
      const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ [field]: value }));
      assert.equal(response.status, 400, `${field}=${JSON.stringify(value)}`);
      assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
    }
  }
  const nulls = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({
    email: null, documentType: null, documentNumber: null, notes: null,
  }));
  assert.equal(nulls.status, 201, JSON.stringify(nulls.json));
  const blanks = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({
    email: '', documentType: '  ', documentNumber: '', notes: '   ',
  }));
  assert.equal(blanks.status, 201, JSON.stringify(blanks.json));
  const row = await h.customerRow(blanks.json.customer.customerId);
  for (const column of ['email', 'document_type', 'document_number', 'notes']) {
    assert.equal(row[column], null, `${column} stored as NULL, never ''`);
  }
});

test('DOC_GAP-02: document pair is both-or-neither after normalization', async () => {
  const { a } = await h.twoTenants();
  for (const body of [
    { documentType: 'CC' },
    { documentNumber: '123' },
    { documentType: 'CC', documentNumber: '' },
    { documentType: '   ', documentNumber: '123' },
    { documentType: 'CC', documentNumber: null },
  ]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  const ok = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ documentType: 'NIT', documentNumber: '900.123.456-7' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.json.customer.documentNumber, '900.123.456-7', 'no document canonicalization');
});

test('text rule: control and bidi characters rejected (names, document, email); lengths from the Dictionary', async () => {
  const { a } = await h.twoTenants();
  const bad = [
    { firstName: 'An\na' }, { lastName: 'Gó\tmez' }, { firstName: `Ana${bidi}` }, { lastName: 'x\u0085y' },
    { firstName: 'a'.repeat(121) }, { lastName: 'b'.repeat(121) },
    { documentType: 'x'.repeat(25), documentNumber: '1' }, { documentType: 'CC', documentNumber: '9'.repeat(41) },
    { documentType: 'C\nC', documentNumber: '1' }, { documentType: 'CC', documentNumber: `1${bidi}2` },
    { firstName: '\uD800' },
  ];
  for (const body of bad) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer(body));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const edge = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({
    firstName: 'ñ'.repeat(120), lastName: '😀'.repeat(120), documentType: 'x'.repeat(24), documentNumber: '9'.repeat(40),
  }));
  assert.equal(edge.status, 201, 'limits count Unicode code points');
});

test('DOC_GAP-03/04: notes multiline (CRLF/CR -> LF, internal spacing kept), TAB/controls/bidi rejected, 2000 code points', async () => {
  const { a } = await h.twoTenants();
  const multi = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({
    notes: '\r\n  Línea 1\r\nLínea  2\rLínea 3\n\n\nfin  \n',
  }));
  assert.equal(multi.status, 201, JSON.stringify(multi.json));
  assert.equal(multi.json.customer.notes, 'Línea 1\nLínea  2\nLínea 3\n\n\nfin');
  assert.equal((await h.customerRow(multi.json.customer.customerId)).notes, 'Línea 1\nLínea  2\nLínea 3\n\n\nfin');

  for (const notes of ['a\tb', 'a\u0000b', 'a\u000Bb', 'a\u001Fb', 'a\u007Fb', 'a\u0085b', `a${bidi}b`]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ notes }));
    assert.equal(response.status, 400, JSON.stringify(notes));
  }
  const max = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ notes: '😀'.repeat(2000) }));
  assert.equal(max.status, 201, '2000 code points (4000 UTF-16 units) is allowed');
  const over = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ notes: 'n'.repeat(2001) }));
  assert.equal(over.status, 400);
  assert.equal(code(over), 'REQUEST_VALIDATION_FAILED');
  const trimmedToLimit = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ notes: `  ${'n'.repeat(2000)}\n\n` }));
  assert.equal(trimmedToLimit.status, 201, 'limit applies after normalization');
});

test('LF exception is exclusive to notes: names reject LF', async () => {
  const { a } = await h.twoTenants();
  const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ firstName: 'Ana\nMaría' }));
  assert.equal(response.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Strict body / media type / size                                            */
/* -------------------------------------------------------------------------- */

test('POST strict body: unknown, server-owned and tenant keys are 400; wrong JSON types are 400', async () => {
  const { a, b } = await h.twoTenants();
  for (const extra of [
    { tenantId: b.tenantId }, { tenant_id: b.tenantId }, { customerId: randomUUID() }, { id: randomUUID() },
    { createdAt: '2026-01-01T00:00:00.000000Z' }, { updatedAt: '2026-01-01T00:00:00.000000Z' },
    { whatsappOptIn: true }, { archived: false },
  ]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer(extra));
    assert.equal(response.status, 400, Object.keys(extra)[0]);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  for (const body of [
    h.validCustomer({ phone: 3001234567 }), h.validCustomer({ firstName: ['Ana'] }), h.validCustomer({ notes: 5 }),
    { lastName: 'x', phone: '3001234567' }, [], 'text', null,
  ]) {
    const response = await h.createCustomer(app, a.owner, a.tenantId, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(await h.tenantCustomerCount(b.tenantId), 0, 'nothing was created in B');
});

test('POST: 415 without application/json, 400 malformed JSON, 413 over 16 KiB, 16 KiB accepted by size', async () => {
  const { a } = await h.twoTenants();
  const text = await h.call(app, {
    subject: a.owner.subject, method: 'POST', url: '/api/v1/customers', tenantId: a.tenantId,
    rawBody: JSON.stringify(h.validCustomer()), headers: { 'content-type': 'text/plain' },
  });
  assert.equal(text.status, 415);
  assert.equal(code(text), 'UNSUPPORTED_MEDIA_TYPE');
  const broken = await h.call(app, {
    subject: a.owner.subject, method: 'POST', url: '/api/v1/customers', tenantId: a.tenantId, rawBody: '{"firstName":',
  });
  assert.equal(broken.status, 400);
  assert.equal(code(broken), 'REQUEST_BODY_MALFORMED');

  const baseBytes = Buffer.byteLength(JSON.stringify(h.validCustomer({ notes: '' })));
  const fits = h.validCustomer({ notes: ' '.repeat(16384 - baseBytes) });
  assert.equal(Buffer.byteLength(JSON.stringify(fits)), 16384);
  const atLimit = await h.createCustomer(app, a.owner, a.tenantId, fits);
  assert.equal(atLimit.status, 201, 'exactly 16384 bytes passes the body limit');
  const tooBig = await h.createCustomer(app, a.owner, a.tenantId, h.validCustomer({ notes: ' '.repeat(16384 - baseBytes + 1) }));
  assert.equal(tooBig.status, 413);
  assert.equal(code(tooBig), 'PAYLOAD_TOO_LARGE');
});

/* -------------------------------------------------------------------------- */
/* GET anti-oracle                                                            */
/* -------------------------------------------------------------------------- */

test('GET anti-oracle: malformed, nonexistent and other-tenant ids return the identical 404 CUSTOMER_NOT_FOUND', async () => {
  const { a, b } = await h.twoTenants();
  const foreign = await h.createCustomer(app, b.owner, b.tenantId, h.validCustomer());
  assert.equal(foreign.status, 201);
  const shapes = new Set();
  for (const id of [
    foreign.json.customer.customerId, randomUUID(), 'not-a-uuid', '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff', `${randomUUID()}x`, '1',
  ]) {
    const response = await h.getCustomer(app, a.owner, a.tenantId, id);
    assert.equal(response.status, 404, id);
    assert.equal(code(response), 'CUSTOMER_NOT_FOUND');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.json.error.request_id, /^[0-9a-f-]{36}$/u);
    shapes.add(h.errorShape(response));
  }
  assert.equal(shapes.size, 1, 'one indistinguishable body');
});
