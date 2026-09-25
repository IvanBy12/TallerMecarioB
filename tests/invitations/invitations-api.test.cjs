'use strict';

/**
 * S1-04 membership invitations — API + real PostgreSQL (runtime roles
 * NOBYPASSRLS; admin only for fixtures and inspection).
 * Letters refer to the S1-04 test plan (A..Z).
 */

const test = require('node:test');
const { randomUUID } = require('node:crypto');
const h = require('./helpers.cjs');

const { assert } = h;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/u;

let app;
let t;

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

async function createFor(actor, tenantId, role = 'technician', address = h.uniqueEmail('inv')) {
  const response = await h.createInvitation(app, actor, tenantId, { email: address, role });
  return { response, email: address, id: response.json?.invitation?.id };
}

/* -------------------------------------------------------------------------- */
/* A / D / U — create                                                         */
/* -------------------------------------------------------------------------- */

test('A/D/U: owner creates an invitation; email normalized; outbox + audit in the same commit', async () => {
  const raw = `  Ana.Perez+${randomUUID().slice(0, 6)}@Example.COM `;
  const response = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: raw, role: 'technician' });
  assert.equal(response.status, 201, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const dto = response.json.invitation;
  assert.deepEqual(Object.keys(dto).sort(), ['acceptedAt', 'createdAt', 'email', 'expiresAt', 'id', 'revokedAt', 'role', 'status']);
  assert.equal(dto.email, raw.trim());
  assert.equal(dto.role, 'technician');
  assert.equal(dto.status, 'pending');

  const row = await h.invitationRow(dto.id);
  assert.equal(row.tenant_id, t.a.tenantId);
  assert.equal(row.email_normalized, raw.trim().toLowerCase());
  assert.equal(row.invited_by_membership_id, t.a.owner.membershipId);
  assert.equal(row.target_role_id, await h.roleId('technician'));
  assert.match(row.token_hash, /^[0-9a-f]{64}$/u);
  const ttlMs = row.expires_at.getTime() - row.created_at.getTime();
  assert.ok(Math.abs(ttlMs - 7 * 86_400_000) < 5_000, 'TTL baseline 7 days from PostgreSQL clock');

  const outbox = await h.admin`SELECT tenant_id, aggregate_type, aggregate_id, event_type, event_version, payload_json, idempotency_key, status FROM public.outbox_events WHERE aggregate_id = ${dto.id}`;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].tenant_id, t.a.tenantId);
  assert.equal(outbox[0].event_type, h.EMAIL_EVENT);
  assert.equal(outbox[0].event_version, 2);
  assert.equal(outbox[0].idempotency_key, dto.id);
  assert.deepEqual(Object.keys(outbox[0].payload_json).sort(), ['delivery', 'invitation_id', 'token_key_version', 'token_nonce']);
  // S104-02 delivery snapshot: message inputs only, no recipient, no token material.
  const [workshop] = await h.admin`SELECT display_name FROM public.workshops WHERE id = ${t.a.tenantId}`;
  assert.deepEqual(outbox[0].payload_json.delivery, {
    template_version: 1,
    from: h.FROM,
    accept_url: h.ACCEPT_URL,
    workshop_name: workshop.display_name,
    role_label: 'Técnico',
    expires_at: row.expires_at.toISOString(),
  });

  const audits = await h.auditsFor(dto.id);
  assert.deepEqual(audits.map((a) => `${a.action}:${a.outcome}`), ['membership.invited:success']);
  assert.equal(audits[0].actor_membership_id, t.a.owner.membershipId);
  assert.deepEqual(Object.keys(audits[0].after_json).sort(), ['expires_at', 'status', 'target_role']);
});

test('S/T: owner may invite owner/admin; admin only service_advisor/technician (denied attempt audited)', async () => {
  for (const role of ['owner', 'admin', 'service_advisor', 'technician']) {
    const { response } = await createFor(t.a.owner, t.a.tenantId, role);
    assert.equal(response.status, 201, `owner -> ${role}`);
  }
  for (const role of ['service_advisor', 'technician']) {
    const { response } = await createFor(t.a.admin, t.a.tenantId, role);
    assert.equal(response.status, 201, `admin -> ${role}`);
  }
  for (const role of ['owner', 'admin']) {
    const address = h.uniqueEmail('esc');
    const response = await h.createInvitation(app, t.a.admin, t.a.tenantId, { email: address, role });
    assert.equal(response.status, 403, `admin -> ${role}`);
    assert.equal(response.json.error.code, 'INVITATION_ROLE_NOT_ALLOWED');
    assert.ok(response.json.error.request_id);
    const rows = await h.admin`SELECT id FROM public.membership_invitations WHERE email_normalized = ${address}`;
    assert.equal(rows.length, 0, 'no invitation row');
    const denied = await h.admin`
      SELECT outcome, reason_code, metadata_json, actor_membership_id FROM public.audit_logs
      WHERE action = 'membership.invited' AND outcome = 'denied' AND request_id = ${response.json.error.request_id}
    `;
    assert.equal(denied.length, 1, 'denied escalation attempt committed to audit_logs');
    assert.equal(denied[0].actor_membership_id, t.a.admin.membershipId);
    assert.deepEqual(denied[0].metadata_json, { target_role: role, required_permission: `roles.assign_${role}` });
  }
});

/* -------------------------------------------------------------------------- */
/* B / C — permissions and tenant isolation                                   */
/* -------------------------------------------------------------------------- */

test('B: advisor/technician cannot create, list or revoke invitations', async () => {
  const { id } = await createFor(t.a.owner, t.a.tenantId);
  for (const actor of [t.a.advisor, t.a.technician]) {
    const created = await h.createInvitation(app, actor, t.a.tenantId, { email: h.uniqueEmail('b'), role: 'technician' });
    assert.equal(created.status, 403);
    assert.equal(created.json.error.code, 'PERMISSION_DENIED');
    const listed = await h.call(app, { subject: actor.subject, url: '/api/v1/membership-invitations', tenantId: t.a.tenantId });
    assert.equal(listed.status, 403);
    const revoked = await h.revokeInvitation(app, actor, t.a.tenantId, id);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.json.error.code, 'PERMISSION_DENIED');
  }
  assert.equal((await h.invitationRow(id)).status, 'pending');
  const unauthenticated = await h.call(app, { method: 'POST', url: '/api/v1/membership-invitations', body: { email: 'x@y.test', role: 'technician' } });
  assert.equal(unauthenticated.status, 401);
});

test('C: tenant B cannot list, read, revoke or target tenant A invitations (API)', async () => {
  const { id } = await createFor(t.a.owner, t.a.tenantId);
  const listB = await h.call(app, { subject: t.b.owner.subject, url: '/api/v1/membership-invitations', tenantId: t.b.tenantId });
  assert.equal(listB.status, 200);
  assert.ok(!listB.json.invitations.some((row) => row.id === id));
  const listA = await h.call(app, { subject: t.a.owner.subject, url: '/api/v1/membership-invitations', tenantId: t.a.tenantId });
  assert.ok(listA.json.invitations.some((row) => row.id === id));

  const revokeB = await h.revokeInvitation(app, t.b.owner, t.b.tenantId, id);
  assert.equal(revokeB.status, 404);
  assert.equal(revokeB.json.error.code, 'INVITATION_NOT_FOUND');
  assert.equal((await h.invitationRow(id)).status, 'pending');

  const forgedHeader = await h.revokeInvitation(app, t.b.owner, t.a.tenantId, id);
  assert.equal(forgedHeader.status, 403);
  assert.equal(forgedHeader.json.error.code, 'TENANT_ACCESS_DENIED');

  for (const body of [
    { email: h.uniqueEmail('c'), role: 'technician', tenantId: t.a.tenantId },
    { email: h.uniqueEmail('c'), role: 'technician', tenant_id: t.a.tenantId },
    { email: h.uniqueEmail('c'), role: 'technician', permissions: ['*'] },
    { email: h.uniqueEmail('c'), role: 'platform_admin' },
  ]) {
    const response = await h.createInvitation(app, t.b.owner, t.b.tenantId, body);
    assert.equal(response.status, 400, JSON.stringify(Object.keys(body)));
  }
});

test('C (DB): runtime role under RLS cannot see/update/insert across tenants; composite FKs hold', async () => {
  const { id } = await createFor(t.a.owner, t.a.tenantId);
  const insufficient = (error) => ['42501', '23503', '23514'].includes(error.code) || /row-level security/u.test(error.message);

  const noContext = await h.apiPool.begin(async (tx) => tx`SELECT id FROM public.membership_invitations WHERE id = ${id}`);
  assert.equal(noContext.length, 0, 'no tenant GUC -> no rows');

  await h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.b.tenantId}, true)`;
    assert.equal((await tx`SELECT id FROM public.membership_invitations WHERE id = ${id}`).length, 0);
    const updated = await tx`UPDATE public.membership_invitations SET status = 'revoked', revoked_at = now(), revoked_by_membership_id = ${t.b.owner.membershipId} WHERE id = ${id}`;
    assert.equal(updated.count, 0);
  });
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.b.tenantId}, true)`;
    await tx`INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, expires_at, invited_by_membership_id)
      VALUES (${randomUUID()}, ${t.a.tenantId}, 'x@y.test', 'x@y.test', ${await h.roleId('technician')}, ${'a'.repeat(64)}, now() + interval '1 day', ${t.a.owner.membershipId})`;
  }), insufficient, 'WITH CHECK rejects tenant_id=A under tenant B');
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, expires_at, invited_by_membership_id)
      VALUES (${randomUUID()}, ${t.a.tenantId}, 'x@y.test', 'x@y.test', ${await h.roleId('technician')}, ${'b'.repeat(64)}, now() + interval '1 day', ${t.b.owner.membershipId})`;
  }), (error) => error.code === '23503', 'invited_by_membership_id cannot cross tenants');
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`UPDATE public.membership_invitations SET tenant_id = ${t.b.tenantId} WHERE id = ${id}`;
  }), insufficient, 'tenant_id A -> B rejected');
  assert.equal((await h.invitationRow(id)).tenant_id, t.a.tenantId);
});

/* -------------------------------------------------------------------------- */
/* E / Q — duplicates                                                         */
/* -------------------------------------------------------------------------- */

test('E: one pending invitation per (tenant, normalized email); revoked/expired free the slot', async () => {
  const address = h.uniqueEmail('dup');
  const first = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: address, role: 'technician' });
  assert.equal(first.status, 201);
  const second = await h.createInvitation(app, t.a.admin, t.a.tenantId, { email: address.toUpperCase(), role: 'service_advisor' });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'INVITATION_ALREADY_PENDING');
  assert.equal((await h.admin`SELECT count(*)::int AS n FROM public.outbox_events WHERE event_type = ${h.EMAIL_EVENT} AND aggregate_id IN (SELECT id FROM public.membership_invitations WHERE email_normalized = ${address})`)[0].n, 1);

  // Same email in ANOTHER tenant is independent.
  assert.equal((await h.createInvitation(app, t.b.owner, t.b.tenantId, { email: address, role: 'technician' })).status, 201);

  assert.equal((await h.revokeInvitation(app, t.a.owner, t.a.tenantId, first.json.invitation.id)).status, 200);
  const third = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: address, role: 'technician' });
  assert.equal(third.status, 201);

  // A pending-but-past-expiry row is materialized as expired (audited) on create.
  const stale = h.uniqueEmail('stale');
  const seeded = await h.seedInvitation({ tenantId: t.a.tenantId, email: stale, invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 60_000) });
  const fresh = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: stale, role: 'technician' });
  assert.equal(fresh.status, 201, fresh.body);
  assert.equal((await h.invitationRow(seeded.id)).status, 'expired');
  const audit = await h.auditsFor(seeded.id);
  assert.deepEqual(audit.map((a) => `${a.action}:${a.actor_type}`), ['membership.invitation_expired:system']);
});

test('Q: concurrent creates for the same tenant/email -> exactly one invitation, one job, one audit', async () => {
  const address = h.uniqueEmail('race');
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    h.createInvitation(app, i % 2 === 0 ? t.a.owner : t.a.admin, t.a.tenantId, { email: address, role: 'technician' })));
  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
  assert.ok(responses.filter((r) => r.status === 409).every((r) => r.json.error.code === 'INVITATION_ALREADY_PENDING'));
  const rows = await h.admin`SELECT id FROM public.membership_invitations WHERE tenant_id = ${t.a.tenantId} AND email_normalized = ${address}`;
  assert.equal(rows.length, 1);
  assert.equal((await h.admin`SELECT count(*)::int AS n FROM public.outbox_events WHERE aggregate_id = ${rows[0].id}`)[0].n, 1);
  assert.equal((await h.admin`SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'membership.invited' AND outcome = 'success' AND entity_id = ${rows[0].id}`)[0].n, 1);
});

/* -------------------------------------------------------------------------- */
/* G / V — token never persisted or leaked                                    */
/* -------------------------------------------------------------------------- */

test('G/V: raw token, nonce-derived link and email never reach invitations/outbox/audit rows or output', async () => {
  const writes = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = function capture(chunk, ...rest) { writes.push(String(chunk)); return originalOut.call(this, chunk, ...rest); };
  process.stderr.write = function capture(chunk, ...rest) { writes.push(String(chunk)); return originalErr.call(this, chunk, ...rest); };
  let raw;
  let invitationId;
  let responses = [];
  const person = h.invitee('leak');
  try {
    const created = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: person.email, role: 'technician' });
    invitationId = created.json.invitation.id;
    raw = await h.tokenFromOutbox(invitationId);
    const other = h.invitee('leak2');
    responses = [
      created,
      await h.acceptInvitation(app, other, raw),
      await h.acceptInvitation(app, person, raw),
      await h.acceptInvitation(app, person, raw),
    ];
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.match(raw, TOKEN_RE);
  const tokenHash = h.token.hashInvitationToken(raw);
  for (const response of responses) {
    assert.ok(!response.body.includes(raw), 'response body never contains the token');
    assert.ok(!response.body.includes(tokenHash), 'response body never contains the token hash');
  }
  assert.ok(!writes.join('').includes(raw), 'no token in process output');

  const [found] = await h.admin`
    SELECT
      (SELECT count(*)::int FROM public.membership_invitations i WHERE i::text LIKE ${`%${raw}%`}) AS invitations,
      (SELECT count(*)::int FROM public.outbox_events o WHERE o::text LIKE ${`%${raw}%`}) AS outbox,
      (SELECT count(*)::int FROM public.audit_logs a WHERE a::text LIKE ${`%${raw}%`} OR a::text LIKE ${`%${tokenHash}%`}) AS audit,
      (SELECT count(*)::int FROM public.audit_logs a WHERE a.entity_id = ${invitationId} AND a::text ILIKE ${`%${person.email}%`}) AS audit_email,
      (SELECT count(*)::int FROM public.outbox_events o WHERE o.aggregate_id = ${invitationId} AND o::text ILIKE ${`%${person.email}%`}) AS outbox_email
  `;
  assert.deepEqual({ ...found }, { invitations: 0, outbox: 0, audit: 0, audit_email: 0, outbox_email: 0 });
});

test('G (control-negative): PostgreSQL refuses a raw token as token_hash', async () => {
  const raw = h.token.deriveInvitationToken(h.tokenKey, randomUUID(), h.token.newInvitationTokenNonce());
  await assert.rejects(h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    await tx`INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, expires_at, invited_by_membership_id)
      VALUES (${randomUUID()}, ${t.a.tenantId}, 'raw@y.test', 'raw@y.test', ${await h.roleId('technician')}, ${raw}, now() + interval '1 day', ${t.a.owner.membershipId})`;
  }), (error) => error.code === '23514' && error.constraint_name === 'mi_token_hash_format_check');
});

/* -------------------------------------------------------------------------- */
/* H..O — acceptance                                                          */
/* -------------------------------------------------------------------------- */

test('K/S: invitee without local user accepts; JIT user, membership + target role, accepted, audited; tenant access works', async () => {
  const person = h.invitee('accept');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'service_advisor', person.email);
  const raw = await h.tokenFromOutbox(id);
  assert.equal(await h.localUserId(person.subject), null, 'no local user before acceptance');

  const response = await h.acceptInvitation(app, person, raw);
  assert.equal(response.status, 201, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  const userId = await h.localUserId(person.subject);
  assert.ok(userId, 'local user JIT-provisioned');
  const memberships = await h.membershipsOf(t.a.tenantId, userId);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].status, 'active');
  assert.deepEqual(memberships[0].roles, ['service_advisor']);
  assert.deepEqual(response.json, {
    membership: { id: memberships[0].id, tenantId: t.a.tenantId, status: 'active', roles: ['service_advisor'] },
    workshop: { id: t.a.tenantId, displayName: 'Taller' },
  });

  const row = await h.invitationRow(id);
  assert.equal(row.status, 'accepted');
  assert.equal(row.accepted_by_user_id, userId);
  assert.equal(row.accepted_membership_id, memberships[0].id);
  const [roleRow] = await h.admin`SELECT assigned_by_membership_id FROM public.membership_roles WHERE membership_id = ${memberships[0].id}`;
  assert.equal(roleRow.assigned_by_membership_id, t.a.owner.membershipId);

  const audits = await h.admin`SELECT action, outcome, entity_type, actor_user_id, actor_membership_id FROM public.audit_logs WHERE request_id = (SELECT request_id FROM public.audit_logs WHERE entity_id = ${id} AND action = 'membership.invitation_accepted') ORDER BY action`;
  assert.deepEqual(audits.map((a) => `${a.action}:${a.entity_type}`), [
    'identity.user_provisioned_jit:user',
    'membership.activated:membership',
    'membership.invitation_accepted:membership_invitation',
    'role.assigned:membership_role',
  ]);
  for (const audit of audits.filter((a) => a.action !== 'identity.user_provisioned_jit')) {
    assert.equal(audit.actor_user_id, userId);
    assert.equal(audit.actor_membership_id, memberships[0].id);
  }

  const whoami = await h.call(app, { subject: person.subject, url: '/api/v1/__s104/whoami', tenantId: t.a.tenantId });
  assert.equal(whoami.status, 200);
  assert.deepEqual(whoami.json.roles, ['service_advisor']);
  assert.equal(whoami.json.canInvite, false);
});

test('S: invited admin / owner get exactly those roles and their permissions', async () => {
  for (const role of ['admin', 'owner']) {
    const person = h.invitee(`role${role}`);
    const { id } = await createFor(t.a.owner, t.a.tenantId, role, person.email);
    const response = await h.acceptInvitation(app, person, await h.tokenFromOutbox(id));
    assert.equal(response.status, 201, response.body);
    assert.deepEqual(response.json.membership.roles, [role]);
    const whoami = await h.call(app, { subject: person.subject, url: '/api/v1/__s104/whoami', tenantId: t.a.tenantId });
    assert.deepEqual(whoami.json.roles, [role]);
    assert.equal(whoami.json.canInvite, true);
  }
});

test('K (existing Clerk user with local user but no membership) accepts without a duplicate user', async () => {
  const existing = await h.member('existing');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', existing.email);
  const response = await h.acceptInvitation(app, existing, await h.tokenFromOutbox(id));
  assert.equal(response.status, 201, response.body);
  const [count] = await h.admin`SELECT count(*)::int AS n FROM public.users WHERE external_subject = ${existing.subject}`;
  assert.equal(count.n, 1);
  assert.equal((await h.membershipsOf(t.a.tenantId, existing.user.id)).length, 1);
});

test('H: unknown or malformed token -> no oracle, nothing created', async () => {
  const person = h.invitee('wrong');
  const unknown = await h.acceptInvitation(app, person, h.token.newInvitationTokenNonce());
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'INVITATION_INVALID');
  for (const bad of ['short', 'x'.repeat(44), `${'a'.repeat(42)}=`, '../../etc/passwd..................................']) {
    const response = await h.acceptInvitation(app, person, bad);
    assert.equal(response.status, 400);
  }
  const extra = await h.call(app, { subject: person.subject, method: 'POST', url: '/api/v1/membership-invitations/accept', body: { token: h.token.newInvitationTokenNonce(), tenantId: t.a.tenantId, role: 'owner' } });
  assert.equal(extra.status, 400, 'tenant/role in the accept payload are rejected');
  const userId = await h.localUserId(person.subject);
  if (userId) assert.equal((await h.admin`SELECT count(*)::int AS n FROM public.memberships WHERE user_id = ${userId}`)[0].n, 0);
});

test('I: expired invitation (status still pending) is refused by the PostgreSQL clock; expiry materialized + audited', async () => {
  const person = h.invitee('expired');
  const seeded = await h.seedInvitation({ tenantId: t.a.tenantId, email: person.email, invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 1_000) });
  const response = await h.acceptInvitation(app, person, seeded.token);
  assert.equal(response.status, 410);
  assert.equal(response.json.error.code, 'INVITATION_EXPIRED');
  assert.equal((await h.invitationRow(seeded.id)).status, 'expired');
  assert.deepEqual((await h.auditsFor(seeded.id)).map((a) => a.action), ['membership.invitation_expired']);
  const userId = await h.localUserId(person.subject);
  assert.equal((await h.membershipsOf(t.a.tenantId, userId)).length, 0);
  const again = await h.acceptInvitation(app, person, seeded.token);
  assert.equal(again.json.error.code, 'INVITATION_EXPIRED');
});

test('J/L: revoked and already-accepted invitations cannot be (re)used', async () => {
  const person = h.invitee('revoked');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
  const raw = await h.tokenFromOutbox(id);
  const revoked = await h.revokeInvitation(app, t.a.admin, t.a.tenantId, id);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.invitation.status, 'revoked');
  const accept = await h.acceptInvitation(app, person, raw);
  assert.equal(accept.status, 410);
  assert.equal(accept.json.error.code, 'INVITATION_REVOKED');

  const replayer = h.invitee('replay');
  const second = await createFor(t.a.owner, t.a.tenantId, 'technician', replayer.email);
  const raw2 = await h.tokenFromOutbox(second.id);
  assert.equal((await h.acceptInvitation(app, replayer, raw2)).status, 201);
  const replay = await h.acceptInvitation(app, replayer, raw2);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.error.code, 'INVITATION_ALREADY_ACCEPTED');
  const userId = await h.localUserId(replayer.subject);
  assert.equal((await h.membershipsOf(t.a.tenantId, userId)).length, 1);
  assert.equal((await h.admin`SELECT count(*)::int AS n FROM public.audit_logs WHERE entity_id = ${second.id} AND action = 'membership.invitation_accepted' AND outcome = 'success'`)[0].n, 1);
});

test('M: a different verified email (incl. a verified NON-primary address matching the invite) is rejected and audited', async () => {
  const intended = h.uniqueEmail('intended');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', intended);
  const raw = await h.tokenFromOutbox(id);

  const stranger = h.invitee('stranger');
  const mismatch = await h.acceptInvitation(app, stranger, raw);
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.json.error.code, 'INVITATION_EMAIL_MISMATCH');

  // Secondary verified address equals the invite, primary differs -> still rejected.
  const secondary = h.invitee('secondary', { decoyFirst: intended });
  const viaSecondary = await h.acceptInvitation(app, secondary, raw);
  assert.equal(viaSecondary.status, 403);
  assert.equal(viaSecondary.json.error.code, 'INVITATION_EMAIL_MISMATCH');

  assert.equal((await h.invitationRow(id)).status, 'pending');
  const denied = (await h.auditsFor(id)).filter((a) => a.outcome === 'denied');
  assert.equal(denied.length, 2);
  assert.ok(denied.every((a) => a.action === 'membership.invitation_accepted' && a.reason_code === 'invitation_email_mismatch'));
  for (const identity of [stranger, secondary]) {
    const userId = await h.localUserId(identity.subject);
    assert.equal((await h.membershipsOf(t.a.tenantId, userId)).length, 0);
  }
});

test('N: unverified primary email cannot accept even if it equals the invitation email', async () => {
  const address = h.uniqueEmail('unverified');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', address);
  const raw = await h.tokenFromOutbox(id);
  const person = h.invitee('unverified', { email: address, verified: false });
  const response = await h.acceptInvitation(app, person, raw);
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'IDENTITY_EMAIL_UNVERIFIED');
  assert.equal((await h.invitationRow(id)).status, 'pending');
  assert.equal(await h.localUserId(person.subject), null);
});

test('O: an existing membership (active or revoked) blocks acceptance; nothing duplicated; invitation stays pending', async () => {
  // Active member invited again under the same verified email.
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'service_advisor', t.a.technician.email);
  const response = await h.acceptInvitation(app, t.a.technician, await h.tokenFromOutbox(id));
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'MEMBERSHIP_ALREADY_EXISTS');
  assert.equal((await h.invitationRow(id)).status, 'pending');
  const memberships = await h.membershipsOf(t.a.tenantId, t.a.technician.user.id);
  assert.equal(memberships.length, 1);
  assert.deepEqual(memberships[0].roles, ['technician'], 'no role added');

  const revokedMember = await h.member('formerly');
  await h.createWorkshop([]); // unrelated
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.memberships ${tx({ id: randomUUID(), tenant_id: t.a.tenantId, user_id: revokedMember.user.id, status: 'revoked', revoked_at: new Date() })}`;
  });
  const second = await createFor(t.a.owner, t.a.tenantId, 'technician', revokedMember.email);
  const blocked = await h.acceptInvitation(app, revokedMember, await h.tokenFromOutbox(second.id));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'MEMBERSHIP_ALREADY_EXISTS');
  assert.equal((await h.membershipsOf(t.a.tenantId, revokedMember.user.id))[0].status, 'revoked', 'no silent reactivation');
});

test('disabled local user cannot accept', async () => {
  const disabled = await h.member('disabled');
  await h.admin`UPDATE public.users SET status = 'disabled' WHERE id = ${disabled.user.id}`;
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', disabled.email);
  const response = await h.acceptInvitation(app, disabled, await h.tokenFromOutbox(id));
  assert.equal(response.status, 403);
  assert.equal(response.json.error.code, 'USER_DISABLED');
  assert.equal((await h.invitationRow(id)).status, 'pending');
});

/* -------------------------------------------------------------------------- */
/* P / R — concurrency                                                        */
/* -------------------------------------------------------------------------- */

test('P: concurrent acceptances of one token -> one membership, one role, one accepted transition', async () => {
  const person = h.invitee('parallel');
  const twin = h.invitee('twin', { email: person.email }); // second Clerk identity, same verified email
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
  const raw = await h.tokenFromOutbox(id);
  const lock = await h.holdInvitationLock(id);
  const pending = [
    ...Array.from({ length: 4 }, () => h.acceptInvitation(app, person, raw)),
    h.acceptInvitation(app, twin, raw),
  ];
  await h.waitForLockWaiters(2);
  await lock.release();
  const responses = await Promise.all(pending);
  const ok = responses.filter((r) => r.status === 201);
  assert.equal(ok.length, 1, responses.map((r) => `${r.status}:${r.json?.error?.code}`).join(','));
  for (const response of responses.filter((r) => r.status !== 201)) {
    assert.equal(response.status, 409);
    assert.ok(['INVITATION_ALREADY_ACCEPTED', 'INVITATION_IN_PROGRESS'].includes(response.json.error.code), response.json.error.code);
  }
  const [counts] = await h.admin`
    SELECT
      (SELECT count(*)::int FROM public.memberships m JOIN public.users u ON u.id = m.user_id
        WHERE m.tenant_id = ${t.a.tenantId} AND u.external_subject IN (${person.subject}, ${twin.subject})) AS memberships,
      (SELECT count(*)::int FROM public.membership_roles mr WHERE mr.membership_id = (SELECT accepted_membership_id FROM public.membership_invitations WHERE id = ${id})) AS roles,
      (SELECT count(*)::int FROM public.audit_logs WHERE entity_id = ${id} AND action = 'membership.invitation_accepted' AND outcome = 'success') AS accepted
  `;
  assert.deepEqual({ ...counts }, { memberships: 1, roles: 1, accepted: 1 });
});

test('R: revoke vs accept race -> exactly one outcome wins, state is consistent', async () => {
  for (let round = 0; round < 4; round += 1) {
    const person = h.invitee(`rva${round}`);
    const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
    const raw = await h.tokenFromOutbox(id);
    const lock = await h.holdInvitationLock(id);
    const acceptP = h.acceptInvitation(app, person, raw);
    const revokeP = h.revokeInvitation(app, t.a.owner, t.a.tenantId, id);
    await h.waitForLockWaiters(2);
    await lock.release();
    const [accept, revoke] = await Promise.all([acceptP, revokeP]);
    const row = await h.invitationRow(id);
    const userId = await h.localUserId(person.subject);
    const memberships = userId ? await h.membershipsOf(t.a.tenantId, userId) : [];
    if (row.status === 'accepted') {
      assert.equal(accept.status, 201);
      assert.equal(revoke.status, 409);
      assert.equal(revoke.json.error.code, 'INVITATION_ALREADY_ACCEPTED');
      assert.equal(memberships.length, 1);
    } else {
      assert.equal(row.status, 'revoked');
      assert.equal(revoke.status, 200);
      assert.equal(accept.status, 410);
      assert.equal(accept.json.error.code, 'INVITATION_REVOKED');
      assert.equal(memberships.length, 0);
    }
  }
});

test('R (time boundary): acceptance blocked across expires_at fails as expired, never half-accepted', async () => {
  const person = h.invitee('boundary');
  const seeded = await h.seedInvitation({
    tenantId: t.a.tenantId, email: person.email, invitedBy: t.a.owner.membershipId,
    createdAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 1_200),
  });
  const lock = await h.holdInvitationLock(seeded.id);
  const acceptP = h.acceptInvitation(app, person, seeded.token);
  await h.waitForLockWaiters(1);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await lock.release();
  const response = await acceptP;
  assert.equal(response.status, 410, response.body);
  assert.equal(response.json.error.code, 'INVITATION_EXPIRED');
  // Either the service's expiry check (materialized 'expired') or the DB
  // trigger's deadline guard (rolled back, still 'pending' but past
  // expires_at) refused it; in both cases nothing was accepted.
  const row = await h.invitationRow(seeded.id);
  assert.ok(['pending', 'expired'].includes(row.status), row.status);
  assert.ok(row.expires_at.getTime() <= Date.now());
  assert.equal(row.accepted_membership_id, null);
  const userId = await h.localUserId(person.subject);
  if (userId) assert.equal((await h.membershipsOf(t.a.tenantId, userId)).length, 0);
  const listed = await h.call(app, { subject: t.a.owner.subject, url: '/api/v1/membership-invitations', tenantId: t.a.tenantId });
  assert.equal(listed.json.invitations.find((entry) => entry.id === seeded.id).status, 'expired');
});

/* -------------------------------------------------------------------------- */
/* Revoke semantics                                                           */
/* -------------------------------------------------------------------------- */

test('revoke: idempotent, audited once, never touches an accepted membership; admin cannot revoke owner/admin invitations', async () => {
  const { id } = await createFor(t.a.owner, t.a.tenantId);
  const first = await h.revokeInvitation(app, t.a.admin, t.a.tenantId, id);
  assert.equal(first.status, 200);
  const row = await h.invitationRow(id);
  assert.equal(row.revoked_by_membership_id, t.a.admin.membershipId);
  const second = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id);
  assert.equal(second.status, 200);
  assert.equal(second.json.invitation.status, 'revoked');
  assert.equal((await h.invitationRow(id)).revoked_by_membership_id, t.a.admin.membershipId);
  assert.deepEqual((await h.auditsFor(id)).map((a) => `${a.action}:${a.outcome}`), ['membership.invited:success', 'membership.invitation_revoked:success']);

  const ownerInvite = await createFor(t.a.owner, t.a.tenantId, 'owner');
  const denied = await h.revokeInvitation(app, t.a.admin, t.a.tenantId, ownerInvite.id);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'INVITATION_ROLE_NOT_ALLOWED');
  assert.equal((await h.invitationRow(ownerInvite.id)).status, 'pending');
  assert.ok((await h.auditsFor(ownerInvite.id)).some((a) => a.action === 'membership.invitation_revoked' && a.outcome === 'denied'));

  const person = h.invitee('accrev');
  const accepted = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
  await h.acceptInvitation(app, person, await h.tokenFromOutbox(accepted.id));
  const late = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, accepted.id);
  assert.equal(late.status, 409);
  assert.equal(late.json.error.code, 'INVITATION_ALREADY_ACCEPTED');
  assert.equal((await h.membershipsOf(t.a.tenantId, await h.localUserId(person.subject)))[0].status, 'active');

  for (const bad of ['not-a-uuid', randomUUID()]) {
    const response = await h.revokeInvitation(app, t.a.owner, t.a.tenantId, bad);
    assert.equal(response.status, 404);
    assert.equal(response.json.error.code, 'INVITATION_NOT_FOUND');
  }
});

test('list: minimal DTO, effective status for pending-but-expired, no token material or internal ids', async () => {
  const stale = await h.seedInvitation({ tenantId: t.a.tenantId, email: h.uniqueEmail('liststale'), invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 1_000) });
  const response = await h.call(app, { subject: t.a.admin.subject, url: '/api/v1/membership-invitations', tenantId: t.a.tenantId });
  assert.equal(response.status, 200);
  const entry = response.json.invitations.find((row) => row.id === stale.id);
  assert.equal(entry.status, 'expired');
  for (const row of response.json.invitations) {
    assert.deepEqual(Object.keys(row).sort(), ['acceptedAt', 'createdAt', 'email', 'expiresAt', 'id', 'revokedAt', 'role', 'status']);
  }
  assert.ok(!/token|hash|nonce|membership_id|tenant/iu.test(response.body));
});

/* -------------------------------------------------------------------------- */
/* W — atomicity                                                              */
/* -------------------------------------------------------------------------- */

test('W: invitation, outbox job and audit commit together or not at all', async () => {
  for (const [table, when] of [
    ['outbox_events', `NEW.event_type = '${h.EMAIL_EVENT}'`],
    ['audit_logs', "NEW.action = 'membership.invited'"],
  ]) {
    const remove = await h.injectFailure(table, when);
    const address = h.uniqueEmail('atomic');
    try {
      const response = await h.createInvitation(app, t.a.owner, t.a.tenantId, { email: address, role: 'technician' });
      assert.equal(response.status, 500);
      assert.equal(response.json.error.code, 'INTERNAL_ERROR');
    } finally {
      await remove();
    }
    const rows = await h.admin`SELECT id FROM public.membership_invitations WHERE email_normalized = ${address}`;
    assert.equal(rows.length, 0, `${table} failure rolls the invitation back`);
  }
});

test('W (accept): a failure at any later step rolls back membership, role and accepted state', async () => {
  for (const [table, when] of [
    ['membership_roles', 'true'],
    ['audit_logs', "NEW.action = 'role.assigned'"],
  ]) {
    const person = h.invitee('atomacc');
    const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
    const raw = await h.tokenFromOutbox(id);
    const remove = await h.injectFailure(table, when);
    try {
      const response = await h.acceptInvitation(app, person, raw);
      assert.equal(response.status, 500);
      assert.ok(!response.body.includes('TEST_INJECTED_FAILURE'), 'internal error sanitized');
    } finally {
      await remove();
    }
    assert.equal((await h.invitationRow(id)).status, 'pending');
    assert.equal(await h.localUserId(person.subject), null, 'even the JIT user is rolled back');
    const retry = await h.acceptInvitation(app, person, raw);
    assert.equal(retry.status, 201, 'a clean retry succeeds afterwards');
  }
});

/* -------------------------------------------------------------------------- */
/* DB invariants + mutation checks                                            */
/* -------------------------------------------------------------------------- */

test('DB lifecycle trigger: terminal states, immutable identity columns, deadline and role coherence', async () => {
  const person = h.invitee('trg');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
  await h.acceptInvitation(app, person, await h.tokenFromOutbox(id));
  const revoked = await createFor(t.a.owner, t.a.tenantId);
  await h.revokeInvitation(app, t.a.owner, t.a.tenantId, revoked.id);
  const pending = await createFor(t.a.owner, t.a.tenantId);
  const expiredSeed = await h.seedInvitation({ tenantId: t.a.tenantId, email: h.uniqueEmail('trgexp'), invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 1_000) });

  const asApi = (fn) => h.apiPool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${t.a.tenantId}, true)`;
    return fn(tx);
  });
  const violates = (constraint) => (error) => error.code === '23514' && error.constraint_name === constraint;

  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET status = 'pending', accepted_at = NULL, accepted_by_user_id = NULL, accepted_membership_id = NULL WHERE id = ${id}`), violates('mi_terminal_state'));
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET status = 'pending', revoked_at = NULL, revoked_by_membership_id = NULL WHERE id = ${revoked.id}`), violates('mi_terminal_state'));
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET token_hash = ${'c'.repeat(64)} WHERE id = ${pending.id}`), violates('mi_immutable_columns'));
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET expires_at = expires_at + interval '30 days' WHERE id = ${pending.id}`), violates('mi_immutable_columns'));
  const ownerRoleId = await h.roleId('owner');
  const techRoleId = await h.roleId('technician');
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET target_role_id = ${ownerRoleId} WHERE id = ${pending.id}`), violates('mi_immutable_columns'));
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET email_normalized = 'other@y.test' WHERE id = ${pending.id}`), violates('mi_immutable_columns'));
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET status = 'expired' WHERE id = ${pending.id}`), violates('mi_expire_before_deadline'));
  await assert.rejects(asApi((tx) => tx`INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, status, expires_at, invited_by_membership_id, accepted_at, accepted_by_user_id, accepted_membership_id)
    VALUES (${randomUUID()}, ${t.a.tenantId}, 'i@y.test', 'i@y.test', ${techRoleId}, ${'d'.repeat(64)}, 'accepted', now() + interval '1 day', ${t.a.owner.membershipId}, now(), ${t.a.owner.user.id}, ${t.a.owner.membershipId})`), violates('mi_created_pending'));

  // Accept onto a membership WITHOUT the target role / of ANOTHER user / after the deadline.
  const other = await h.member('trgother');
  await assert.rejects(asApi(async (tx) => {
    const membershipId = randomUUID();
    await tx`INSERT INTO public.memberships (id, tenant_id, user_id) VALUES (${membershipId}, ${t.a.tenantId}, ${other.user.id})`;
    await tx`UPDATE public.membership_invitations SET status = 'accepted', accepted_at = now(), accepted_by_user_id = ${other.user.id}, accepted_membership_id = ${membershipId} WHERE id = ${pending.id}`;
  }), violates('mi_accepted_role_missing'));
  await assert.rejects(asApi(async (tx) => {
    await tx`UPDATE public.membership_invitations SET status = 'accepted', accepted_at = now(), accepted_by_user_id = ${other.user.id}, accepted_membership_id = ${t.a.owner.membershipId} WHERE id = ${pending.id}`;
  }), violates('mi_accepted_membership_mismatch'));
  await assert.rejects(asApi(async (tx) => {
    const membershipId = randomUUID();
    await tx`INSERT INTO public.memberships (id, tenant_id, user_id) VALUES (${membershipId}, ${t.a.tenantId}, ${other.user.id})`;
    await tx`INSERT INTO public.membership_roles (tenant_id, membership_id, role_id, assigned_by_membership_id) VALUES (${t.a.tenantId}, ${membershipId}, ${await h.roleId('technician')}, ${t.a.owner.membershipId})`;
    await tx`UPDATE public.membership_invitations SET status = 'accepted', accepted_at = now(), accepted_by_user_id = ${other.user.id}, accepted_membership_id = ${membershipId} WHERE id = ${expiredSeed.id}`;
  }), violates('mi_accept_after_deadline'));
  // The BEFORE trigger rejects an incoherent accept first; the CHECK is the
  // independent second layer (proved with triggers off).
  await assert.rejects(asApi((tx) => tx`UPDATE public.membership_invitations SET status = 'accepted' WHERE id = ${pending.id}`), violates('mi_accepted_membership_mismatch'));
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE public.membership_invitations SET status = 'accepted' WHERE id = ${pending.id}`;
  }), (error) => error.code === '23514' && error.constraint_name === 'mi_accepted_coherence_check');
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE public.membership_invitations SET status = 'revoked' WHERE id = ${pending.id}`;
  }), (error) => error.code === '23514' && error.constraint_name === 'mi_revoked_coherence_check');
  await assert.rejects(asApi((tx) => tx`DELETE FROM public.membership_invitations WHERE id = ${pending.id}`), (error) => error.code === '42501');
  assert.equal((await h.invitationRow(pending.id)).status, 'pending');
});

test('mutation checks: without the partial unique index / lifecycle trigger the invariants WOULD break', async () => {
  const roleId = await h.roleId('technician');
  const insertPending = (tx, address, hash) => tx`
    INSERT INTO public.membership_invitations (id, tenant_id, email, email_normalized, target_role_id, token_hash, expires_at, invited_by_membership_id)
    VALUES (${randomUUID()}, ${t.a.tenantId}, ${address}, ${address}, ${roleId}, ${hash}, now() + interval '1 day', ${t.a.owner.membershipId})`;
  const MUTATION_ROLLBACK = new Error('MUTATION_ROLLBACK');

  // Index present: second pending rejected.
  await assert.rejects(h.admin.begin(async (tx) => {
    const address = h.uniqueEmail('mut');
    await insertPending(tx, address, 'e'.repeat(64));
    await insertPending(tx, address, 'f'.repeat(64));
  }), (error) => error.code === '23505' && error.constraint_name === 'mi_one_pending_per_email_uq');
  // Index dropped (rolled back): the duplicate goes through -> the index is the guard.
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`DROP INDEX public.mi_one_pending_per_email_uq`;
    const address = h.uniqueEmail('mut');
    await insertPending(tx, address, '1'.repeat(64));
    await insertPending(tx, address, '2'.repeat(64));
    const [row] = await tx`SELECT count(*)::int AS n FROM public.membership_invitations WHERE email_normalized = ${address}`;
    assert.equal(row.n, 2);
    throw MUTATION_ROLLBACK;
  }), (error) => error === MUTATION_ROLLBACK);

  // Trigger disabled (rolled back): a revoked invitation could go back to pending.
  const revoked = await createFor(t.a.owner, t.a.tenantId);
  await h.revokeInvitation(app, t.a.owner, t.a.tenantId, revoked.id);
  await assert.rejects(h.admin.begin(async (tx) => {
    await tx`ALTER TABLE public.membership_invitations DISABLE TRIGGER membership_invitations_lifecycle_trg`;
    await tx`UPDATE public.membership_invitations SET status = 'pending', revoked_at = NULL, revoked_by_membership_id = NULL WHERE id = ${revoked.id}`;
    throw MUTATION_ROLLBACK;
  }), (error) => error === MUTATION_ROLLBACK);
  assert.equal((await h.invitationRow(revoked.id)).status, 'revoked');
  const [{ enabled }] = await h.admin`SELECT tgenabled = 'O' AS enabled FROM pg_catalog.pg_trigger WHERE tgname = 'membership_invitations_lifecycle_trg'`;
  assert.equal(enabled, true);
  const [{ present }] = await h.admin`SELECT to_regclass('public.mi_one_pending_per_email_uq') IS NOT NULL AS present`;
  assert.equal(present, true);
});

test('resolver: exact hash only, minimal output, least privilege, no PUBLIC/worker EXECUTE', async () => {
  const [fn] = await h.admin`
    SELECT p.prosecdef, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.proconfig,
      has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
      has_function_privilege('tallermecario_api', p.oid, 'EXECUTE') AS api_execute,
      has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE') AS worker_execute,
      pg_catalog.pg_get_function_result(p.oid) AS result
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'bootstrap_resolve_membership_invitation'
  `;
  assert.deepEqual({ ...fn }, {
    prosecdef: true, owner: 'tallermecario_bootstrap_resolver', proconfig: ['search_path=pg_catalog, public'],
    public_execute: false, api_execute: true, worker_execute: false,
    result: 'TABLE(invitation_id uuid, tenant_id uuid)',
  });
  const [trigger] = await h.admin`
    SELECT p.prosecdef, has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute, p.proconfig
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'enforce_membership_invitation_lifecycle'
  `;
  assert.deepEqual({ ...trigger }, { prosecdef: false, public_execute: false, proconfig: ['search_path=pg_catalog, public'] });

  const columnGrants = await h.admin`
    SELECT column_name, privilege_type FROM information_schema.role_column_grants
    WHERE grantee = 'tallermecario_bootstrap_resolver' AND table_name = 'membership_invitations'
    ORDER BY column_name, privilege_type
  `;
  // 0008: id/tenant_id/token_hash (exact-hash resolver). 0009: status/expires_at
  // (read-only, delivery-lease functions). Never any write on this table.
  assert.deepEqual(columnGrants.map((g) => `${g.column_name}:${g.privilege_type}`), [
    'expires_at:SELECT', 'id:SELECT', 'status:SELECT', 'tenant_id:SELECT', 'token_hash:SELECT',
  ]);
  const tableGrants = await h.admin`
    SELECT privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'tallermecario_bootstrap_resolver' AND table_name = 'membership_invitations'
  `;
  assert.equal(tableGrants.length, 0);
  const [roles] = await h.admin`
    SELECT
      (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_api') AS api_bypass,
      (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_worker') AS worker_bypass,
      (SELECT count(*)::int FROM pg_catalog.pg_roles WHERE rolbypassrls AND rolname LIKE 'tallermecario%') AS bypass_roles
  `;
  assert.deepEqual({ ...roles }, { api_bypass: false, worker_bypass: false, bypass_roles: 1 });

  const { id } = await createFor(t.a.owner, t.a.tenantId);
  const raw = await h.tokenFromOutbox(id);
  const hash = h.token.hashInvitationToken(raw);
  const exact = await h.apiPool`SELECT * FROM app.bootstrap_resolve_membership_invitation(${hash})`;
  assert.deepEqual(exact.map((r) => ({ ...r })), [{ invitation_id: id, tenant_id: t.a.tenantId }]);
  for (const probe of [raw, hash.slice(0, 63), `${hash.slice(0, 63)}%`, '%', hash.toUpperCase(), '']) {
    assert.equal((await h.apiPool`SELECT * FROM app.bootstrap_resolve_membership_invitation(${probe})`).length, 0, probe);
  }
  await assert.rejects(h.workerPool`SELECT * FROM app.bootstrap_resolve_membership_invitation(${hash})`, (error) => error.code === '42501');
});

/* -------------------------------------------------------------------------- */
/* Z — tenant GUC cleanup                                                     */
/* -------------------------------------------------------------------------- */

test('Z: no pooled connection keeps app.* GUCs after accept/create/revoke (success or failure)', async () => {
  const person = h.invitee('guc');
  const { id } = await createFor(t.a.owner, t.a.tenantId, 'technician', person.email);
  const raw = await h.tokenFromOutbox(id);
  await h.acceptInvitation(app, h.invitee('gucx'), raw); // mismatch (commit path)
  await h.acceptInvitation(app, person, raw); // success
  await h.acceptInvitation(app, person, raw); // replay (rollback path)
  await h.revokeInvitation(app, t.a.owner, t.a.tenantId, id); // 409
  const probes = await Promise.all(Array.from({ length: 24 }, () => h.apiPool`
    SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.user_id', true) AS "user",
      current_setting('app.membership_id', true) AS membership
  `));
  for (const [row] of probes) {
    for (const value of Object.values(row)) assert.ok(value === null || value === '', `leaked GUC: ${value}`);
  }
  const idle = await h.admin`
    SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
    WHERE datname = pg_catalog.current_database() AND state = 'idle in transaction'
  `;
  assert.equal(idle[0].n, 0, 'no connection left inside a transaction');
});
