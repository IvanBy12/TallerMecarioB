'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertLogPrivacy } = require('../../scripts/staging-crm-e2e.cjs');
const notice = { level: 30, event: 'order_media_route_disabled', reason: 'cursor_key_missing' };
const completion = { level: 30, request_id: 'server-generated', method: 'GET',
  route: '/api/v1/customers/:customerId', status_code: 200, duration_ms: 1 };
const check = (line, sentinels = []) => assertLogPrivacy(JSON.stringify(line), sentinels, 0);
const denied = line => assert.throws(() => check(line), error =>
  error.code === 'ERR_ASSERTION' || /^STAGING_LOG_/u.test(error.message));

test('staging privacy: exact missing-cursor-key informational notice passes', () => {
  assert.equal(check(notice), 0);
});
test('staging privacy: startup, shutdown, internal diagnostic and completion contracts remain accepted', () => {
  const raw = [{ level: 30, msg: 'Server listening at http://127.0.0.1:3000' },
    { level: 30, msg: 'received SIGTERM, shutting down' }, notice,
    { level: 50, diagnostic: 'request_internal_error', request_id: 'server-generated' },
    completion].map(line => JSON.stringify(line)).join('\n');
  assert.equal(assertLogPrivacy(raw, [], 1), 1);
});
for (const event of ['other_event', 'order_media_route_disabled/private-value', null])
  test(`staging privacy: rejects unexpected event ${String(event)}`, () => denied({ ...notice, event }));
for (const reason of ['other_reason', 'cursor_key_missing/private-value', '', null, { value: 'cursor_key_missing' }])
  test(`staging privacy: rejects unexpected reason ${JSON.stringify(reason)}`, () => denied({ ...notice, reason }));
for (const field of ['tenant_id', 'user_id', 'membership_id', 'request_id', 'cursor', 'key',
  'token', 'config', 'msg', 'arbitrary'])
  test(`staging privacy: rejects notice extra field ${field}`, () => denied({ ...notice, [field]: 'private-value' }));
for (const level of [50, 20, 40, 60, '30', null, undefined])
  test(`staging privacy: rejects notice level ${String(level)}`, () => denied({ ...notice, level }));
test('staging privacy: rejects a missing fixed reason', () => {
  const { reason: _reason, ...line } = notice; denied(line);
});
for (const field of ['cursor', 'event', 'arbitrary'])
  test(`staging privacy: completion still rejects extra ${field}`, () => denied({ ...completion, [field]: 'private-value' }));
test('staging privacy: notice cannot smuggle fields through the diagnostic exception', () => {
  denied({ ...notice, diagnostic: 'request_internal_error', request_id: 'server-generated' });
});
test('staging privacy: existing private-value sentinel still rejects ordinary messages', () => {
  assert.throws(() => check({ level: 30, msg: 'PrivateStagingSentinel' }, ['PrivateStagingSentinel']),
    /STAGING_LOG_PRIVATE_VALUE_FAILED/u);
});
for (const msg of ['Bearer private-value', 'authorization: private-value', 'cookie: private-value',
  '/api/v1/customers?name=private-value'])
  test(`staging privacy: raw request material stays forbidden (${msg.split(' ')[0]})`, () => {
    assert.throws(() => check({ level: 30, msg }), /STAGING_LOG_RAW_REQUEST_FAILED/u);
  });
