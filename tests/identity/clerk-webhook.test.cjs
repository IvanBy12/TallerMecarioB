'use strict';

/**
 * S1-03 — POST /api/v1/webhooks/clerk with REAL Svix/Standard-Webhooks
 * signatures (HMAC computed in-test, independently of the SDK under test),
 * persisted through the real ingest function as tallermecario_api.
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert, admin, load, network } = h;
const { buildApi } = load('api/app.js');
const { PostgresClerkWebhookRepository, registerClerkWebhookRoute } = load('identity/webhook-routes.js');

const apiPool = h.runtimePool('api', 4);
const secret = h.newWebhookSecret();
const providerCalls = { verify: 0, profile: 0 };
const identityProvider = {
  async verifyRequest() { providerCalls.verify += 1; return null; },
  async getIdentityProfile() { providerCalls.profile += 1; throw new Error('PROFILE_MUST_NOT_BE_FETCHED'); },
};

let app;

before(async () => {
  app = await buildApi({
    database: apiPool,
    identityProvider,
    rateLimit: { max: 10_000, timeWindow: '1 minute' },
    registerPublicRoutes(server) {
      registerClerkWebhookRoute(server, { signingSecret: secret, repository: new PostgresClerkWebhookRepository(apiPool) });
    },
  });
});

after(async () => {
  if (app) await app.close();
  await apiPool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

function deliver(delivery, extraHeaders = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/clerk',
    headers: { ...delivery.headers, ...extraHeaders },
    payload: delivery.body,
  });
}

async function storedFor(svixId) {
  const events = await admin`
    SELECT id, provider, provider_event_id, tenant_id, payload_hash, payload_json, headers_json
    FROM public.webhook_events WHERE provider = 'clerk' AND provider_event_id = ${svixId}
  `;
  const outbox = events.length === 0 ? [] : await admin`
    SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json, idempotency_key, status
    FROM public.outbox_events WHERE idempotency_key = ${events[0].id}
  `;
  return { events, outbox };
}

describe('signature verification over the exact raw bytes', () => {
  test('valid signature -> 204; one webhook_events projection + one outbox job in the same commit', async () => {
    const subject = h.newSubject('valid');
    const timestampMs = Date.now() - 1000;
    const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, timestampMs));
    const networkBefore = network.calls;

    const response = await deliver(delivery);
    assert.equal(response.statusCode, 204);
    assert.equal(network.calls, networkBefore, 'thin webhook: no Clerk Backend API call');

    const { events, outbox } = await storedFor(delivery.id);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.provider_event_id, delivery.id, 'svix-id is the delivery identity');
    assert.notEqual(event.provider_event_id, subject, 'never the Clerk user id');
    assert.equal(event.payload_hash, h.sha256Hex(delivery.body));
    assert.equal(event.tenant_id, null);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].tenant_id, null);
    assert.equal(outbox[0].event_type, 'identity.provider_user_lifecycle_received');
    assert.equal(outbox[0].aggregate_type, 'identity_subject');
    assert.equal(outbox[0].status, 'pending');
    assert.equal(outbox[0].payload_json.external_subject, subject);
    assert.equal(outbox[0].payload_json.provider_event_id, delivery.id);
    assert.equal(outbox[0].payload_json.provider_event_type, 'user.created');
    assert.equal(outbox[0].payload_json.webhook_event_id, event.id);
    assert.equal(new Date(outbox[0].payload_json.occurred_at).getTime(), timestampMs, 'Clerk event timestamp, not received_at');
  });

  test('non-canonical JSON bytes (spacing, key order, \\u escapes) still verify: the raw body is used, not JSON.stringify(req.body)', async () => {
    const subject = h.newSubject('raw');
    const body = `{\n  "type" : "user.updated",\n  "timestamp": ${Date.now()},\n  "object":"event",\n  "data": {"id":"${subject}", "first_name":"Jos\\u00e9"}   \n}`;
    assert.notEqual(JSON.stringify(JSON.parse(body)), body);
    const delivery = h.signedDelivery(secret, body);
    assert.equal((await deliver(delivery)).statusCode, 204);
    assert.equal((await storedFor(delivery.id)).events[0].payload_hash, h.sha256Hex(body));
  });

  const rejections = [
    ['tampered body (same headers)', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      return { ...delivery, body: delivery.body.replace('"user.created"', '"user.deleted"') };
    }],
    ['wrong secret', (subject) => h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()), { signWith: h.newWebhookSecret() })],
    ['signature for a different svix-id', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      return { ...delivery, headers: { ...delivery.headers, 'svix-id': `msg_${randomUUID().replaceAll('-', '')}` } };
    }],
    ['stale svix-timestamp (replay outside tolerance)', (subject) => h.signedDelivery(
      secret, h.clerkEventBody('user.created', subject, Date.now()), { timestamp: Math.floor(Date.now() / 1000) - 3600 },
    )],
    ['missing svix-id', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      const headers = { ...delivery.headers };
      delete headers['svix-id'];
      return { ...delivery, headers };
    }],
    ['missing svix-timestamp', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      const headers = { ...delivery.headers };
      delete headers['svix-timestamp'];
      return { ...delivery, headers };
    }],
    ['missing svix-signature', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      const headers = { ...delivery.headers };
      delete headers['svix-signature'];
      return { ...delivery, headers };
    }],
    ['garbage signature', (subject) => {
      const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', subject, Date.now()));
      return { ...delivery, headers: { ...delivery.headers, 'svix-signature': 'v1,AAAA' } };
    }],
  ];

  for (const [label, build] of rejections) {
    test(`401 CLERK_WEBHOOK_SIGNATURE_INVALID and nothing stored: ${label}`, async () => {
      const subject = h.newSubject('reject');
      const delivery = build(subject);
      const response = await deliver(delivery);
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error.code, 'CLERK_WEBHOOK_SIGNATURE_INVALID');
      assert.ok(response.json().error.request_id);
      const [{ n }] = await admin`
        SELECT count(*)::int AS n FROM public.outbox_events WHERE payload_json ->> 'external_subject' = ${subject}
      `;
      assert.equal(n, 0);
      const [{ w }] = await admin`SELECT count(*)::int AS w FROM public.webhook_events WHERE payload_json -> 'data' ->> 'id' = ${subject}`;
      assert.equal(w, 0);
    });
  }
});

describe('envelope, idempotency and minimization', () => {
  test('all seven S1-03 user events are accepted', async () => {
    for (const type of ['user.created', 'user.updated', 'user.deleted', 'user.banned', 'user.unbanned', 'user.locked', 'user.unlocked']) {
      const delivery = h.signedDelivery(secret, h.clerkEventBody(type, h.newSubject('all'), Date.now()));
      assert.equal((await deliver(delivery)).statusCode, 204, type);
      const { events, outbox } = await storedFor(delivery.id);
      assert.equal(events.length, 1, type);
      assert.equal(outbox[0].payload_json.provider_event_type, type);
    }
  });

  test('a verified unsupported event is ACKed and ignored: no webhook_events, no outbox', async () => {
    const before = await admin`SELECT (SELECT count(*) FROM public.webhook_events)::int AS w, (SELECT count(*) FROM public.outbox_events)::int AS o`;
    for (const type of ['session.created', 'organization.created', 'email.created', 'organizationMembership.created']) {
      const body = JSON.stringify({ type, object: 'event', timestamp: Date.now(), data: { id: `x_${randomUUID()}` } });
      const response = await deliver(h.signedDelivery(secret, body));
      assert.equal(response.statusCode, 204, type);
    }
    const afterRows = await admin`SELECT (SELECT count(*) FROM public.webhook_events)::int AS w, (SELECT count(*) FROM public.outbox_events)::int AS o`;
    assert.deepEqual(afterRows[0], before[0]);
  });

  test('a verified user event with an invalid envelope -> 400 and nothing stored', async () => {
    for (const body of [
      JSON.stringify({ type: 'user.created', object: 'event', timestamp: Date.now(), data: {} }),
      JSON.stringify({ type: 'user.created', object: 'event', data: { id: h.newSubject('nots') } }),
      JSON.stringify({ type: 'user.created', object: 'event', timestamp: 'yesterday', data: { id: h.newSubject('strts') } }),
      JSON.stringify({ type: 'user.created', object: 'event', timestamp: Date.now(), data: { id: 'org_notauser' } }),
    ]) {
      const delivery = h.signedDelivery(secret, body);
      const response = await deliver(delivery);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'CLERK_WEBHOOK_PAYLOAD_INVALID');
      assert.equal((await storedFor(delivery.id)).events.length, 0);
    }
  });

  test('duplicate delivery (same svix-id + same bytes) -> 2xx, no duplicate side effects', async () => {
    const delivery = h.signedDelivery(secret, h.clerkEventBody('user.updated', h.newSubject('dup'), Date.now()));
    for (let i = 0; i < 3; i += 1) assert.equal((await deliver(delivery)).statusCode, 204);
    const { events, outbox } = await storedFor(delivery.id);
    assert.equal(events.length, 1);
    assert.equal(outbox.length, 1);
  });

  test('same svix-id + different payload hash -> 409 fail-closed, nothing enqueued, anomaly audited', async () => {
    const subject = h.newSubject('conflict');
    const first = h.signedDelivery(secret, h.clerkEventBody('user.updated', subject, Date.now()));
    assert.equal((await deliver(first)).statusCode, 204);
    const second = h.signedDelivery(secret, h.clerkEventBody('user.deleted', subject, Date.now() + 1), { id: first.id });
    const response = await deliver(second);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'CLERK_WEBHOOK_EVENT_CONFLICT');

    const { events, outbox } = await storedFor(first.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload_hash, h.sha256Hex(first.body), 'original event untouched');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].payload_json.provider_event_type, 'user.updated');
    const audits = await admin`
      SELECT tenant_id, actor_type, outcome, entity_type, entity_id, metadata_json
      FROM public.audit_logs WHERE action = 'identity.webhook_event_conflict' AND entity_id = ${events[0].id}
    `;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].tenant_id, null);
    assert.equal(audits[0].outcome, 'denied');
    assert.deepEqual(Object.keys(audits[0].metadata_json).sort(), ['identity_provider', 'reason']);
  });

  test('PII minimization: only {object,type,data.id,occurred_at} and {svix_id,svix_timestamp} are persisted', async () => {
    const subject = h.newSubject('pii');
    const delivery = h.signedDelivery(secret, h.clerkEventBody('user.updated', subject, Date.now(), { email: 'very.private@example.test' }));
    assert.equal((await deliver(delivery)).statusCode, 204);
    const { events, outbox } = await storedFor(delivery.id);
    const [event] = events;
    assert.deepEqual(Object.keys(event.payload_json).sort(), ['data', 'object', 'occurred_at', 'type']);
    assert.deepEqual(event.payload_json.data, { id: subject });
    assert.deepEqual(Object.keys(event.headers_json).sort(), ['svix_id', 'svix_timestamp']);
    const everything = JSON.stringify({ event, outbox });
    for (const forbidden of [
      'very.private@example.test', 'payload-pii', '+57300', 'img.example.test', 'metadata', 'first_name', 'Payload',
      'oauth_google', '203.0.113.9', 'pii-agent', delivery.headers['svix-signature'], 'v1,',
    ]) {
      assert.equal(everything.includes(forbidden), false, `must not persist ${forbidden}`);
    }
  });

  test('the webhook uses neither user JWT, TenantContext nor X-Tenant-Id', async () => {
    const before = { ...providerCalls };
    const delivery = h.signedDelivery(secret, h.clerkEventBody('user.created', h.newSubject('notenant'), Date.now()));
    const response = await deliver(delivery, { 'x-tenant-id': randomUUID(), authorization: `Bearer ${h.sessionToken(h.newSubject())}` });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(providerCalls, before, 'identity provider never consulted');
    const { events, outbox } = await storedFor(delivery.id);
    assert.equal(events[0].tenant_id, null);
    assert.equal(outbox[0].tenant_id, null);
  });

  test('runtime roles cannot read or write webhook_events / identity_sync_states / users directly', async () => {
    const denied = (error) => error.code === '42501';
    await assert.rejects(apiPool`SELECT 1 FROM public.webhook_events LIMIT 1`, denied);
    await assert.rejects(apiPool`SELECT 1 FROM public.identity_sync_states LIMIT 1`, denied);
    await assert.rejects(apiPool`SELECT 1 FROM public.users LIMIT 1`, denied);
    await assert.rejects(apiPool`INSERT INTO public.webhook_events (id, provider, provider_event_id, payload_hash, payload_json) VALUES (${randomUUID()}, 'clerk', 'x', ${'0'.repeat(64)}, '{}')`, denied);
    await assert.rejects(apiPool`UPDATE public.users SET status = 'active'`, denied);
  });
});
