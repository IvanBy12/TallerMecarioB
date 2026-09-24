'use strict';

/**
 * S1-04 invitation email delivery through the outbox (phased worker) and the
 * Resend client, plus token/config unit checks. Hermetic: Resend is a fake
 * sender / fake fetch; the global fetch trap must stay at zero calls.
 */

const test = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const h = require('./helpers.cjs');

const { assert, worker, email, token } = h;
const config = h.load('invitations/config.js');

let app;
let t;
// The API config frozen into every delivery snapshot (helpers.apiConfig).
const { ACCEPT_URL, FROM } = h;

class RecordingSender {
  constructor() {
    this.calls = [];
    this.behaviors = [];
    this.onSend = null;
  }

  next(behavior) {
    this.behaviors.push(behavior);
  }

  async send(message, idempotencyKey) {
    this.calls.push({ message, idempotencyKey });
    if (this.onSend) await this.onSend(message, idempotencyKey);
    const behavior = this.behaviors.shift();
    if (behavior) return behavior();
    return { providerMessageId: `re_msg_${randomUUID()}` };
  }

  for(invitationId) {
    return this.calls.filter((call) => call.idempotencyKey === email.invitationEmailIdempotencyKey(invitationId));
  }
}

function handlerOptions(sender, overrides = {}) {
  return {
    database: h.workerPool,
    handlers: {},
    phasedHandlers: {
      [h.EMAIL_EVENT]: email.createInvitationEmailHandler({
        config: { tokenKey: h.tokenKey, ...overrides },
        sender,
      }),
    },
    baseDelaySeconds: 1,
  };
}

async function drain(sender, overrides) {
  return h.drainOutbox(worker, handlerOptions(sender, overrides));
}

async function jobOf(invitationId) {
  const [row] = await h.admin`SELECT status, attempts, last_error FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
  return row;
}

async function makeDue(invitationId) {
  await h.admin`UPDATE public.outbox_events SET available_at = now() - interval '1 second' WHERE aggregate_id = ${invitationId}`;
}

test.before(async () => {
  app = await h.buildTestApp();
  t = await h.twoTenants();
});

test.after(async () => {
  if (app) await app.close();
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
});

async function invite(address = h.uniqueEmail('mail'), role = 'technician') {
  const response = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: address, role });
  assert.equal(response.status, 201, response.body);
  return { id: response.json.invitation.id, email: address };
}

test('X: email sent by the worker with NO PostgreSQL transaction/lock held during the provider call', async () => {
  const { id, email: address } = await invite();
  const sender = new RecordingSender();
  const workerLogin = process.env.TEST_WORKER_LOGIN;
  const observed = [];
  sender.onSend = async () => {
    const [state] = await h.admin`
      SELECT
        (SELECT count(*)::int FROM pg_catalog.pg_stat_activity
          WHERE usename = ${workerLogin} AND xact_start IS NOT NULL) AS worker_transactions,
        (SELECT count(*)::int FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
          WHERE a.usename = ${workerLogin} AND l.relation = 'public.membership_invitations'::regclass) AS invitation_locks
    `;
    observed.push({ ...state });
  };
  const results = await drain(sender);
  assert.ok(results.some((result) => result.outcome === 'processed'));
  assert.deepEqual(observed, [{ worker_transactions: 0, invitation_locks: 0 }]);

  const [call] = sender.for(id);
  assert.equal(call.message.to, address);
  assert.equal(call.message.from, FROM);
  const raw = await h.tokenFromOutbox(id);
  assert.ok(call.message.text.includes(`${ACCEPT_URL}#token=${raw}`), 'link carries the token in the URL fragment');
  assert.ok(call.message.html.includes(`${ACCEPT_URL}#token=${raw}`));
  assert.ok(!call.message.text.includes(`/invite/${raw}`), 'token never in the URL path');
  assert.equal(h.token.hashInvitationToken(raw), (await h.invitationRow(id)).token_hash, 'emailed token matches the stored hash');

  assert.equal((await jobOf(id)).status, 'processed');
  const audits = (await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_type, 'system');
  assert.ok(!JSON.stringify(audits[0]).includes(raw));
  assert.ok(!JSON.stringify(audits[0]).includes(address));
  assert.equal(h.network.calls, 0, 'hermetic: no real network');
});

test('Y: transient failure -> retry reuses the same invitation, token, body and idempotency key', async () => {
  const { id } = await invite();
  const hashBefore = (await h.invitationRow(id)).token_hash;
  const sender = new RecordingSender();
  sender.next(() => { throw new worker.TransientDispatchError('RESEND_HTTP_503'); });
  await drain(sender);
  let job = await jobOf(id);
  assert.equal(job.status, 'pending', 'scheduled for retry');
  assert.equal(job.last_error, 'RESEND_HTTP_503');
  await makeDue(id);
  await drain(sender);
  job = await jobOf(id);
  assert.equal(job.status, 'processed');
  assert.equal(job.attempts, 2);

  const calls = sender.for(id);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].idempotencyKey, `membership-invitation/${id}`);
  assert.deepEqual(calls[1], calls[0], 'byte-identical retry (same token, same body, same key)');
  assert.equal((await h.invitationRow(id)).token_hash, hashBefore, 'no new token');
  const [count] = await h.admin`SELECT count(*)::int AS n FROM public.membership_invitations WHERE email_normalized = (SELECT email_normalized FROM public.membership_invitations WHERE id = ${id})`;
  assert.equal(count.n, 1, 'no new invitation');
  assert.equal((await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_sent').length, 1);
});

test('Y: a re-delivered job after a lost completion re-sends idempotently (same key)', async () => {
  const { id } = await invite();
  const sender = new RecordingSender();
  // Provider accepted, then PHASE C fails (e.g. DB outage): the job retries.
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'membership.invitation_email_sent'");
  try {
    await drain(sender);
  } finally {
    await remove();
  }
  assert.equal((await jobOf(id)).status, 'pending');
  await makeDue(id);
  await drain(sender);
  const calls = sender.for(id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey, 'Resend deduplicates the second delivery');
  assert.equal((await jobOf(id)).status, 'processed');
});

test('Y: accepted / revoked / expired invitations are never emailed', async () => {
  const sender = new RecordingSender();
  const person = h.invitee('mailaccepted');
  const accepted = await invite(person.email);
  assert.equal((await h.acceptInvitation(app, person, await h.tokenFromOutbox(accepted.id))).status, 201);
  const revoked = await invite();
  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, revoked.id)).status, 200);
  const expired = await h.seedInvitation({
    tenantId: t.a.tenantId, email: h.uniqueEmail('mailexp'), invitedBy: t.a.owner.membershipId,
    expiresAt: new Date(Date.now() - 1_000), withOutbox: true,
  });

  await drain(sender);
  for (const [id, reason] of [[accepted.id, 'accepted'], [revoked.id, 'revoked'], [expired.id, 'expired']]) {
    assert.equal(sender.for(id).length, 0, `${reason} not emailed`);
    assert.equal((await jobOf(id)).status, 'processed');
    const skipped = (await h.auditsFor(id)).filter((a) => a.action === 'membership.invitation_email_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].metadata_json.reason, reason);
  }
});

test('permanent failures: wrong worker key / unknown key version / provider 4xx never send a dead link', async () => {
  const wrongKey = await invite();
  const sender = new RecordingSender();
  await h.drainOutbox(worker, handlerOptions(sender, { tokenKey: token.createInvitationTokenKey(randomBytes(32)) }));
  assert.equal(sender.for(wrongKey.id).length, 0);
  let job = await jobOf(wrongKey.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.last_error, 'INVITATION_TOKEN_MISMATCH');

  const otherVersion = await invite();
  await h.drainOutbox(worker, handlerOptions(sender, { tokenKey: token.createInvitationTokenKey(randomBytes(32), 2) }));
  job = await jobOf(otherVersion.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.last_error, 'INVITATION_TOKEN_KEY_VERSION_UNKNOWN');

  const rejected = await invite();
  sender.next(() => { throw new worker.PermanentDispatchError('RESEND_HTTP_422'); });
  await drain(sender);
  job = await jobOf(rejected.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.last_error, 'RESEND_HTTP_422');
  assert.equal(sender.for(rejected.id).length, 1);
});

test('W: the email job only exists if the invitation committed (and vice versa)', async () => {
  const remove = await h.injectFailure('audit_logs', "NEW.action = 'membership.invited'");
  const address = h.uniqueEmail('atomicmail');
  try {
    assert.equal((await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: address, role: 'technician' })).status, 500);
  } finally {
    await remove();
  }
  const [counts] = await h.admin`
    SELECT
      (SELECT count(*)::int FROM public.membership_invitations WHERE email_normalized = ${address}) AS invitations,
      (SELECT count(*)::int FROM public.outbox_events o WHERE o.event_type = ${h.EMAIL_EVENT}
        AND NOT EXISTS (SELECT 1 FROM public.membership_invitations i WHERE i.id = o.aggregate_id)) AS orphan_jobs
  `;
  assert.deepEqual({ ...counts }, { invitations: 0, orphan_jobs: 0 });
});

/* -------------------------------------------------------------------------- */
/* Resend client (fake fetch)                                                 */
/* -------------------------------------------------------------------------- */

const resendConfig = { resendApiKey: `re_test_${randomUUID()}`, resendBaseUrl: 'https://api.resend.test', resendTimeoutMs: 200 };
const sample = { from: FROM, to: 'secret-person@invite.test', subject: 'S', html: '<p>h</p>', text: 't' };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Resend client: request shape, idempotency key and success', async () => {
  const seen = [];
  const sender = new email.ResendEmailSender(resendConfig, async (url, init) => {
    seen.push({ url, init });
    return jsonResponse(200, { id: 're_123' });
  });
  const result = await sender.send(sample, 'membership-invitation/abc');
  assert.deepEqual(result, { providerMessageId: 're_123' });
  assert.equal(seen[0].url, 'https://api.resend.test/emails');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${resendConfig.resendApiKey}`);
  assert.equal(seen[0].init.headers['idempotency-key'], 'membership-invitation/abc');
  assert.equal(seen[0].init.redirect, 'error');
  assert.ok(seen[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(seen[0].init.body), { from: FROM, to: [sample.to], subject: 'S', html: '<p>h</p>', text: 't' });
});

test('Resend client: failure classification never leaks the key or recipient', async () => {
  const cases = [
    [429, {}, worker.TransientDispatchError, 'RESEND_HTTP_429'],
    [500, {}, worker.TransientDispatchError, 'RESEND_HTTP_500'],
    [401, {}, worker.TransientDispatchError, 'RESEND_HTTP_401'],
    [409, { name: 'concurrent_idempotent_requests' }, worker.TransientDispatchError, 'RESEND_HTTP_409_CONCURRENT'],
    [409, { name: 'invalid_idempotent_request' }, worker.PermanentDispatchError, 'RESEND_HTTP_409'],
    [422, { message: `bad ${sample.to}` }, worker.PermanentDispatchError, 'RESEND_HTTP_422'],
    [200, { nope: true }, worker.TransientDispatchError, 'RESEND_RESPONSE_INVALID'],
  ];
  for (const [status, body, type, message] of cases) {
    const sender = new email.ResendEmailSender(resendConfig, async () => jsonResponse(status, body));
    await assert.rejects(sender.send(sample, 'k'), (error) => error instanceof type && error.message === message
      && !error.message.includes(resendConfig.resendApiKey) && !error.message.includes(sample.to), `${status}`);
  }
  const network = new email.ResendEmailSender(resendConfig, async () => { throw new Error(`ECONNRESET ${resendConfig.resendApiKey}`); });
  await assert.rejects(network.send(sample, 'k'), (error) => error instanceof worker.TransientDispatchError && error.message === 'RESEND_NETWORK_ERROR');
  const hanging = new email.ResendEmailSender(resendConfig, (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  await assert.rejects(hanging.send(sample, 'k'), (error) => error instanceof worker.TransientDispatchError);
  assert.ok(Date.now() - started < 2_000, 'finite timeout');
});

test('message: escapes workshop name, header-safe subject, Spanish role name', () => {
  const snapshot = email.buildInvitationDeliverySnapshot({
    from: FROM, acceptUrl: ACCEPT_URL, workshopName: 'Taller <script>alert(1)</script>\r\nBcc: evil@x', role: 'service_advisor',
    expiresAt: new Date('2026-10-01T00:00:00Z'),
  });
  const message = email.renderInvitationEmail(snapshot, 'x@invite.test', `${ACCEPT_URL}#token=abc`);
  assert.deepEqual(email.renderInvitationEmail(snapshot, 'x@invite.test', `${ACCEPT_URL}#token=abc`), message, 'pure/deterministic');
  assert.equal(snapshot.template_version, 1);
  assert.equal(snapshot.role_label, 'Asesor de servicio', 'role label frozen, not re-read from code at send time');
  assert.ok(!message.html.includes('<script>'));
  assert.ok(message.html.includes('&lt;script&gt;'));
  assert.ok(!/[\r\n]/u.test(message.subject));
  assert.ok(message.text.includes('Asesor de servicio'));
  assert.ok(message.text.includes('2026-10-01'));
});

/* -------------------------------------------------------------------------- */
/* F — token; configuration                                                   */
/* -------------------------------------------------------------------------- */

test('F: tokens are 256-bit, URL-safe, unique, deterministic per (key, id, nonce), key-bound', () => {
  const seen = new Set();
  const id = randomUUID();
  for (let i = 0; i < 2_000; i += 1) {
    const nonce = token.newInvitationTokenNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/u);
    const raw = token.deriveInvitationToken(h.tokenKey, id, nonce);
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(Buffer.from(raw, 'base64url').length, 32);
    assert.ok(!seen.has(raw));
    seen.add(raw);
    assert.equal(token.deriveInvitationToken(h.tokenKey, id, nonce), raw);
  }
  const nonce = token.newInvitationTokenNonce();
  const otherKey = token.createInvitationTokenKey(randomBytes(32));
  assert.notEqual(token.deriveInvitationToken(otherKey, id, nonce), token.deriveInvitationToken(h.tokenKey, id, nonce));
  assert.notEqual(token.deriveInvitationToken(h.tokenKey, randomUUID(), nonce), token.deriveInvitationToken(h.tokenKey, id, nonce));
  const raw = token.deriveInvitationToken(h.tokenKey, id, nonce);
  assert.equal(token.invitationTokenMatchesHash(raw, token.hashInvitationToken(raw)), true);
  assert.equal(token.invitationTokenMatchesHash(raw, 'f'.repeat(64)), false);
  assert.equal(token.invitationTokenMatchesHash(raw, raw), false);
  assert.throws(() => token.createInvitationTokenKey(randomBytes(31)));
  assert.throws(() => token.deriveInvitationToken(h.tokenKey, id, 'not-a-nonce'));
  assert.equal(token.invitationAcceptUrl('https://app.test/invite', raw), `https://app.test/invite#token=${raw}`);
});

test('config: fail closed on partial/invalid configuration; errors never echo values', () => {
  const secret = randomBytes(32).toString('base64url');
  const full = {
    MEMBERSHIP_INVITATION_TOKEN_SECRET: secret,
    MEMBERSHIP_INVITATION_ACCEPT_URL: 'https://app.tallermecario.test/invite',
    MEMBERSHIP_INVITATION_EMAIL_FROM: 'invitaciones@tallermecario.test',
    RESEND_API_KEY: 're_live_abcdef',
  };
  assert.equal(config.invitationsConfigured({}), false);
  assert.equal(config.invitationsConfigured({ RESEND_API_KEY: 'x' }), true);
  // Worker: token secret + Resend transport only (no message content).
  const loaded = config.loadInvitationEmailConfig(full);
  assert.deepEqual(Object.keys(loaded).sort(), ['resendApiKey', 'resendBaseUrl', 'resendTimeoutMs', 'tokenKey']);
  assert.equal(loaded.resendBaseUrl, 'https://api.resend.com/');
  assert.equal(loaded.resendTimeoutMs, 10_000);
  assert.equal(loaded.tokenKey.secret.length, 32);
  // API: token secret + the message inputs frozen into each delivery snapshot.
  const api = config.loadInvitationApiConfig(full);
  assert.deepEqual(Object.keys(api).sort(), ['acceptUrl', 'from', 'tokenKey']);
  assert.equal(api.acceptUrl, 'https://app.tallermecario.test/invite');

  const secretSafe = (error) => error instanceof config.InvitationConfigurationError
    && !error.message.includes(secret) && !error.message.includes('re_live_abcdef');
  const invalidWorker = [
    { MEMBERSHIP_INVITATION_TOKEN_SECRET: undefined },
    { MEMBERSHIP_INVITATION_TOKEN_SECRET: randomBytes(16).toString('base64') },
    { RESEND_API_KEY: undefined },
    { RESEND_API_KEY: 'sk_wrong' },
    { RESEND_TIMEOUT_MS: '0' },
    { RESEND_API_BASE_URL: 'http://evil.test' },
  ];
  for (const override of invalidWorker) {
    assert.throws(() => config.loadInvitationEmailConfig({ ...full, ...override }), secretSafe, `worker ${JSON.stringify(Object.keys(override))}`);
  }
  const invalidApi = [
    { MEMBERSHIP_INVITATION_TOKEN_SECRET: undefined },
    { MEMBERSHIP_INVITATION_TOKEN_SECRET: randomBytes(16).toString('base64') },
    { MEMBERSHIP_INVITATION_ACCEPT_URL: undefined },
    { MEMBERSHIP_INVITATION_ACCEPT_URL: 'http://app.tallermecario.test/invite' },
    { MEMBERSHIP_INVITATION_ACCEPT_URL: 'https://app.tallermecario.test/invite?x=1' },
    { MEMBERSHIP_INVITATION_ACCEPT_URL: 'https://app.tallermecario.test/invite#frag' },
    { MEMBERSHIP_INVITATION_EMAIL_FROM: undefined },
    { MEMBERSHIP_INVITATION_EMAIL_FROM: 'no-at-sign' },
  ];
  for (const override of invalidApi) {
    assert.throws(() => config.loadInvitationApiConfig({ ...full, ...override }), secretSafe, `api ${JSON.stringify(Object.keys(override))}`);
  }
  // Partial configuration: a single variable present => the process's own set is mandatory.
  assert.throws(() => config.loadInvitationApiConfig({ MEMBERSHIP_INVITATION_EMAIL_FROM: 'a@b.test' }), secretSafe);
  assert.throws(() => config.loadInvitationEmailConfig({ RESEND_API_KEY: 're_x' }), secretSafe);
  assert.equal(config.loadInvitationApiConfig({ ...full, MEMBERSHIP_INVITATION_ACCEPT_URL: 'http://localhost:5173/invite' }).acceptUrl, 'http://localhost:5173/invite');
});
