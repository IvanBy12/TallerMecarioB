'use strict';

/**
 * S2-04 GET /api/v1/customers: keyset pagination id DESC (limit 20/100,
 * opaque versioned base64url cursor) and the canonical filters phone (exact),
 * documentNumber (exact) and name (case-insensitive, accent-sensitive prefix of
 * first_name OR last_name), combined with AND (Arquitectura §13 / §13.4).
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
const ids = (response) => response.json.customers.map((customer) => customer.customerId);
const cursorOf = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

async function seedMany(tenantId, count, overrides = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) rows.push(await h.seedCustomer(tenantId, { first_name: `Seed${index}`, ...overrides }));
  return rows.map((row) => row.id).sort().reverse();
}

test('list: default limit 20, id DESC, full walk with nextCursor has no gaps/duplicates, ends with null; no-store', async () => {
  const { a, b } = await h.twoTenants();
  const expected = await seedMany(a.tenantId, 45);
  await seedMany(b.tenantId, 3);
  const seen = [];
  let cursor = null;
  const pageSizes = [];
  for (let page = 0; page < 5; page += 1) {
    const response = await h.listCustomers(app, a.advisor, a.tenantId, cursor ? `cursor=${cursor}` : '');
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(response.json).sort(), ['customers', 'nextCursor']);
    for (const customer of response.json.customers) assert.deepEqual(Object.keys(customer).sort(), h.DTO_KEYS);
    pageSizes.push(response.json.customers.length);
    seen.push(...ids(response));
    cursor = response.json.nextCursor;
    if (cursor === null) break;
    assert.match(cursor, /^[A-Za-z0-9_-]+$/u, 'base64url');
  }
  assert.deepEqual(pageSizes, [20, 20, 5]);
  assert.deepEqual(seen, expected, 'id DESC across pages, tenant A only');
  assert.equal(cursor, null);
});

test('list: limit 100 max, 101 -> 400; exact page boundary returns nextCursor then empty page with null', async () => {
  const { a } = await h.twoTenants();
  const expected = await seedMany(a.tenantId, 105);
  const hundred = await h.listCustomers(app, a.owner, a.tenantId, 'limit=100');
  assert.equal(hundred.status, 200);
  assert.deepEqual(ids(hundred), expected.slice(0, 100));
  assert.notEqual(hundred.json.nextCursor, null);
  const rest = await h.listCustomers(app, a.owner, a.tenantId, `limit=100&cursor=${hundred.json.nextCursor}`);
  assert.deepEqual(ids(rest), expected.slice(100));
  assert.equal(rest.json.nextCursor, null);

  const five = await h.listCustomers(app, a.owner, a.tenantId, 'limit=5');
  assert.equal(five.json.customers.length, 5);
  const one = await h.listCustomers(app, a.owner, a.tenantId, 'limit=1');
  assert.deepEqual(ids(one), [expected[0]]);

  const { a: small } = await h.twoTenants();
  const two = await seedMany(small.tenantId, 2);
  const exact = await h.listCustomers(app, small.owner, small.tenantId, 'limit=2');
  assert.deepEqual(ids(exact), two);
  assert.equal(exact.json.nextCursor, null, 'no extra row -> no cursor');
});

test('list: empty tenant -> { customers: [], nextCursor: null }', async () => {
  const { a } = await h.twoTenants();
  const response = await h.listCustomers(app, a.owner, a.tenantId);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { customers: [], nextCursor: null });
});

test('list: invalid limit / cursor / unknown or repeated params -> 400 REQUEST_VALIDATION_FAILED', async () => {
  const { a, b } = await h.twoTenants();
  const invalid = [
    'limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'limit=020', 'limit=1&limit=2', 'limit=%201',
    'cursor=', 'cursor=@@@', 'cursor=not-base64', `cursor=${cursorOf({ v: 2, id: randomUUID() })}`,
    `cursor=${cursorOf({ v: 1, id: 'nope' })}`, `cursor=${cursorOf({ v: 1, id: randomUUID().toUpperCase() })}`,
    `cursor=${cursorOf({ v: 1, id: randomUUID(), extra: 1 })}`, `cursor=${cursorOf([1])}`,
    `cursor=${Buffer.from('{bad json').toString('base64url')}`,
    `tenantId=${b.tenantId}`, 'q=ana', 'email=a@b.co', 'firstName=Ana', 'lastName=Gomez', 'plate=ABC123',
    'name=Ana&name=Bea', 'phone=3001234567&phone=3007654321', 'name=', 'name=%20%20', 'phone=abc', 'documentNumber=',
    `name=${'a'.repeat(121)}`, 'name=a%0Ab', 'name=a%E2%80%AEb',
  ];
  for (const query of invalid) {
    const response = await h.listCustomers(app, a.owner, a.tenantId, query);
    assert.equal(response.status, 400, query);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED', query);
  }
});

test('list: a foreign/unknown id inside a well-formed cursor is harmless (only own rows below it)', async () => {
  const { a, b } = await h.twoTenants();
  const own = await seedMany(a.tenantId, 3);
  const [foreign] = await seedMany(b.tenantId, 1);
  const response = await h.listCustomers(app, a.owner, a.tenantId, `cursor=${cursorOf({ v: 1, id: foreign })}`);
  assert.equal(response.status, 200);
  assert.deepEqual(ids(response), own.filter((id) => id < foreign));
  const top = await h.listCustomers(app, a.owner, a.tenantId, `cursor=${cursorOf({ v: 1, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' })}`);
  assert.deepEqual(ids(top), own);
});

test('filters: phone exact (same normalization), documentNumber exact (trim/NFC), AND combination', async () => {
  const { a } = await h.twoTenants();
  const target = await h.seedCustomer(a.tenantId, { phone: '3001234567', document_type: 'CC', document_number: 'AB-123', first_name: 'Ana' });
  await h.seedCustomer(a.tenantId, { phone: '30012345678', first_name: 'Ana' });
  await h.seedCustomer(a.tenantId, { phone: '+573001234567', first_name: 'Ana' });
  const other = await h.seedCustomer(a.tenantId, { phone: '3001234567', document_type: 'CC', document_number: 'ab-123', first_name: 'Bea' });

  const byPhone = await h.listCustomers(app, a.owner, a.tenantId, `phone=${encodeURIComponent('(300) 123-45.67')}`);
  assert.deepEqual(ids(byPhone).sort(), [target.id, other.id].sort(), 'exact normalized phone, no prefix/suffix match');
  const byDoc = await h.listCustomers(app, a.owner, a.tenantId, `documentNumber=${encodeURIComponent('  AB-123 ')}`);
  assert.deepEqual(ids(byDoc), [target.id], 'exact and case-sensitive (no canonicalization)');
  const partialDoc = await h.listCustomers(app, a.owner, a.tenantId, 'documentNumber=AB');
  assert.deepEqual(ids(partialDoc), []);
  const both = await h.listCustomers(app, a.owner, a.tenantId, 'phone=3001234567&name=bea');
  assert.deepEqual(ids(both), [other.id], 'AND');
  const none = await h.listCustomers(app, a.owner, a.tenantId, 'phone=3001234567&documentNumber=zzz');
  assert.deepEqual(ids(none), []);
});

test('name: case-insensitive, accent-sensitive prefix of first_name OR last_name; % and _ are literal', async () => {
  const { a } = await h.twoTenants();
  const alvaro = await h.seedCustomer(a.tenantId, { first_name: 'Álvaro', last_name: 'Pérez' });
  const alvaroLower = await h.seedCustomer(a.tenantId, { first_name: 'álvaro', last_name: 'Ruiz' });
  const plain = await h.seedCustomer(a.tenantId, { first_name: 'Alvaro', last_name: 'Soto' });
  const maria = await h.seedCustomer(a.tenantId, { first_name: 'María José', last_name: 'Ñúñez' });
  const percent = await h.seedCustomer(a.tenantId, { first_name: '%Raro', last_name: 'Under_Score' });

  const cases = [
    ['ÁLVARO', [alvaro.id, alvaroLower.id]],
    ['álv', [alvaro.id, alvaroLower.id]],
    [`A${'́'}lvaro`, [alvaro.id, alvaroLower.id]],
    ['alvaro', [plain.id]],
    ['ALVARO', [plain.id]],
    ['pér', [alvaro.id]],
    ['PÉREZ', [alvaro.id]],
    ['perez', []],
    ['varo', []],
    ['maría j', [maria.id]],
    ['ÑÚÑ', [maria.id]],
    ['%', [percent.id]],
    ['under_', [percent.id]],
    ['_', []],
  ];
  for (const [name, expected] of cases) {
    const response = await h.listCustomers(app, a.owner, a.tenantId, `name=${encodeURIComponent(name)}`);
    assert.equal(response.status, 200, name);
    assert.deepEqual(ids(response).sort(), [...expected].sort(), `name=${name}`);
  }
});

test('filters never cross tenants: identical phone/document/name in B are not returned to A', async () => {
  const { a, b } = await h.twoTenants();
  const mine = await h.seedCustomer(a.tenantId, { first_name: 'Compartido', phone: '3009998877', document_type: 'CC', document_number: 'X1' });
  await h.seedCustomer(b.tenantId, { first_name: 'Compartido', phone: '3009998877', document_type: 'CC', document_number: 'X1' });
  for (const query of ['', 'phone=3009998877', 'documentNumber=X1', 'name=compart', 'limit=100']) {
    const response = await h.listCustomers(app, a.owner, a.tenantId, query);
    assert.deepEqual(ids(response), [mine.id], query);
  }
});
