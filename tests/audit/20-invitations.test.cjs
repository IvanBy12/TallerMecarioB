'use strict';

/**
 * S1-07 — audit events of S1-04 (membership invitations): create / revoke /
 * accept (+ JIT, activation, role), on-access expiry materialization, email
 * worker sent / skipped, and the durable denied outcomes. Real routes, real
 * worker (recording sender), real PostgreSQL through the runtime logins.
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert } = h;
let app;
let t;
const sensitive = [];
const UA = `curl/8 (s107-${randomUUID()})`;

before(async () => {
  app = await h.buildAuditApp();
  t = await h.tenants();
});
after(async () => {
  await app.close();
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await h.admin.end();
});

async function remember(invitationId) {
  const raw = await h.tokenFromOutbox(invitationId);
  const [row] = await h.admin`SELECT token_hash, email, email_normalized FROM public.membership_invitations WHERE id = ${invitationId}`;
  const [job] = await h.admin`SELECT payload_json ->> 'token_nonce' AS nonce FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
  sensitive.push(raw, row.token_hash, row.email, row.email_normalized, job.nonce);
  return raw;
}

const only = (rows, action) => {
  const matching = rows.filter((row) => row.action === action);
  assert.equal(matching.length, 1, `exactly one ${action}`);
  return matching[0];
};

describe('create / revoke', () => {
  test('membership.invited success: actor = TenantContext, minimized after, exact request id, no UA', async () => {
    const email = h.uniqueEmail('invitee');
    const response = await h.invite(app, t.a.owner, t.a.tenantId, { email, role: 'technician' }, { headers: { 'user-agent': UA } });
    assert.equal(response.status, 201);
    const invitationId = response.json.invitation.id;
    await remember(invitationId);
    const rows = await h.auditsByRequest(response.requestId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(
      [row.action, row.outcome, row.actor_type, row.tenant_id, row.actor_user_id, row.actor_membership_id, row.entity_type, row.entity_id, row.reason_code],
      ['membership.invited', 'success', 'user', t.a.tenantId, t.a.owner.user.id, t.a.owner.membershipId, 'membership_invitation', invitationId, 'membership_invitation'],
    );
    assert.deepEqual(Object.keys(row.after_json).sort(), ['expires_at', 'status', 'target_role']);
    assert.equal(row.after_json.status, 'pending');
    assert.equal(row.user_agent, null);
  });

  test('membership.invited denied (admin -> owner): durable denied row, no entity, no invitation created', async () => {
    const email = h.uniqueEmail('owner-wannabe');
    sensitive.push(email);
    const response = await h.invite(app, t.a.admin, t.a.tenantId, { email, role: 'owner' });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'INVITATION_ROLE_NOT_ALLOWED');
    const [row] = await h.auditsByRequest(response.requestId);
    assert.deepEqual(
      [row.action, row.outcome, row.reason_code, row.actor_membership_id, row.entity_id],
      ['membership.invited', 'denied', 'role_assignment_not_permitted', t.a.admin.membershipId, null],
    );
    assert.deepEqual(row.metadata_json, { target_role: 'owner', required_permission: 'roles.assign_owner' });
    const [count] = await h.admin`SELECT count(*)::int AS n FROM public.membership_invitations WHERE email_normalized = ${email}`;
    assert.equal(count.n, 0);
  });

  test('revoke: success once; a repeated revoke is idempotent with no second row; admin on an owner invitation is a durable denied row', async () => {
    const created = await h.invite(app, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('torevoke'), role: 'service_advisor' });
    const invitationId = created.json.invitation.id;
    await remember(invitationId);
    const first = await h.revokeInvite(app, t.a.owner, t.a.tenantId, invitationId);
    assert.equal(first.status, 200);
    const [row] = await h.auditsByRequest(first.requestId);
    assert.deepEqual([row.action, row.outcome, row.entity_id], ['membership.invitation_revoked', 'success', invitationId]);
    assert.deepEqual([row.before_json, row.after_json, row.metadata_json], [{ status: 'pending' }, { status: 'revoked' }, { target_role: 'service_advisor' }]);
    const second = await h.revokeInvite(app, t.a.owner, t.a.tenantId, invitationId);
    assert.equal(second.status, 200);
    assert.equal((await h.auditsByRequest(second.requestId)).length, 0);
    assert.equal((await h.auditsForEntity(invitationId, 'membership.invitation_revoked')).length, 1);

    const ownerInvite = await h.invite(app, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('coowner'), role: 'owner' });
    await remember(ownerInvite.json.invitation.id);
    const denied = await h.revokeInvite(app, t.a.admin, t.a.tenantId, ownerInvite.json.invitation.id);
    assert.equal(denied.status, 403);
    const [deniedRow] = await h.auditsByRequest(denied.requestId);
    assert.deepEqual(
      [deniedRow.action, deniedRow.outcome, deniedRow.reason_code, deniedRow.entity_id],
      ['membership.invitation_revoked', 'denied', 'role_assignment_not_permitted', ownerInvite.json.invitation.id],
    );
  });

  test("another tenant's invitation id: 404, nothing audited anywhere that mentions it", async () => {
    const foreign = await h.invite(app, t.b.owner, t.b.tenantId, { email: h.uniqueEmail('foreign'), role: 'technician' });
    const foreignId = foreign.json.invitation.id;
    await remember(foreignId);
    const before = await h.auditsMentioning(foreignId);
    const response = await h.revokeInvite(app, t.a.owner, t.a.tenantId, foreignId);
    assert.equal(response.status, 404);
    assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    assert.deepEqual(await h.auditsMentioning(foreignId), before);
    assert.ok(before.every((row) => row.tenant_id === t.b.tenantId));
  });
});

describe('email worker', () => {
  test('email_sent / email_skipped are system rows correlated to the outbox job; replays add nothing', async () => {
    const sendMe = await h.invite(app, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('mail'), role: 'technician' });
    const skipMe = await h.invite(app, t.a.owner, t.a.tenantId, { email: h.uniqueEmail('skip'), role: 'technician' });
    await remember(sendMe.json.invitation.id);
    await remember(skipMe.json.invitation.id);
    await h.revokeInvite(app, t.a.owner, t.a.tenantId, skipMe.json.invitation.id);
    const sender = new h.RecordingSender();
    await h.drain(sender);

    for (const [invitationId, action] of [[sendMe.json.invitation.id, 'membership.invitation_email_sent'], [skipMe.json.invitation.id, 'membership.invitation_email_skipped']]) {
      const rows = await h.auditsForEntity(invitationId, 'membership.invitation_email');
      assert.equal(rows.length, 1, action);
      const [job] = await h.admin`SELECT id FROM public.outbox_events WHERE aggregate_id = ${invitationId}`;
      assert.deepEqual(
        [rows[0].action, rows[0].actor_type, rows[0].actor_user_id, rows[0].actor_membership_id, rows[0].tenant_id, rows[0].request_id, rows[0].ip_address],
        [action, 'system', null, null, t.a.tenantId, `outbox:${job.id}`, null],
      );
    }
    const sent = only(await h.auditsForEntity(sendMe.json.invitation.id, 'membership.invitation_email'), 'membership.invitation_email_sent');
    assert.deepEqual(Object.keys(sent.metadata_json).sort(), ['attempt', 'lease_state', 'outbox_event_id', 'provider', 'provider_message_id']);
    // Rendered message carried the token (in the link) and the recipient; the audit row carries neither.
    for (const call of sender.calls) sensitive.push(call.message.to, call.message.html, call.message.text);

    const before = await h.auditCount();
    await h.drain(sender);
    assert.equal(await h.auditCount(), before, 'nothing left to deliver: no audit');
  });
});

describe('accept', () => {
  test('success: JIT + invitation_accepted + membership.activated + role.assigned; actor = the new membership; tenant and role from the invitation', async () => {
    const newcomer = h.identity('newcomer');
    const created = await h.invite(app, t.a.admin, t.a.tenantId, { email: newcomer.email, role: 'technician' });
    const invitationId = created.json.invitation.id;
    const raw = await remember(invitationId);
    const response = await h.accept(app, newcomer, raw, { headers: { 'user-agent': UA, 'x-tenant-id': t.b.tenantId } });
    assert.equal(response.status, 201);
    const membershipId = response.json.membership.id;
    assert.equal(response.json.membership.tenantId, t.a.tenantId, 'tenant comes from the invitation, not the header');
    const [user] = await h.admin`SELECT id FROM public.users WHERE external_subject = ${newcomer.subject}`;

    const rows = await h.auditsByRequest(response.requestId);
    assert.deepEqual(rows.map((row) => row.action).sort(), [
      'identity.user_provisioned_jit', 'membership.activated', 'membership.invitation_accepted', 'role.assigned',
    ]);
    for (const row of rows.filter((item) => item.tenant_id !== null)) {
      assert.deepEqual([row.tenant_id, row.actor_type, row.actor_user_id, row.actor_membership_id, row.reason_code, row.user_agent],
        [t.a.tenantId, 'user', user.id, membershipId, 'membership_invitation', null]);
    }
    assert.deepEqual(only(rows, 'membership.invitation_accepted').after_json, { status: 'accepted', accepted_membership_id: membershipId });
    assert.deepEqual(only(rows, 'membership.activated').metadata_json, { invitation_id: invitationId });
    const role = only(rows, 'role.assigned');
    assert.deepEqual([role.entity_id, role.before_json, role.after_json], [membershipId, { roles: [] }, { roles: ['technician'] }]);
    assert.deepEqual(role.metadata_json, { assigned_by_membership_id: t.a.admin.membershipId, invitation_id: invitationId });
    assert.equal(only(rows, 'identity.user_provisioned_jit').tenant_id, null);

    const replay = await h.accept(app, newcomer, raw);
    assert.equal(replay.status, 409);
    assert.equal((await h.auditsByRequest(replay.requestId)).length, 0, 'an already-used token writes nothing');
  });

  test('email mismatch: durable denied row, actor = the verified user without membership; nothing else commits', async () => {
    const intended = h.identity('intended');
    const intruder = h.identity('intruder');
    sensitive.push(intended.email, intruder.email);
    const created = await h.invite(app, t.a.owner, t.a.tenantId, { email: intended.email, role: 'technician' });
    const raw = await remember(created.json.invitation.id);
    const response = await h.accept(app, intruder, raw);
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'INVITATION_EMAIL_MISMATCH');
    const rows = await h.auditsByRequest(response.requestId);
    const denied = only(rows, 'membership.invitation_accepted');
    const [user] = await h.admin`SELECT id FROM public.users WHERE external_subject = ${intruder.subject}`;
    assert.deepEqual(
      [denied.outcome, denied.reason_code, denied.tenant_id, denied.actor_user_id, denied.actor_membership_id, denied.entity_id],
      ['denied', 'invitation_email_mismatch', t.a.tenantId, user.id, null, created.json.invitation.id],
    );
    assert.equal(denied.before_json, null);
    assert.equal(rows.filter((row) => row.action === 'membership.activated' || row.action === 'role.assigned').length, 0);
    assert.equal((await h.invitationRow(created.json.invitation.id)).status, 'pending');
  });

  test('expiry is materialized as a system row (on accept and on re-invite), never attributed to the caller', async () => {
    const late = h.identity('late');
    const seeded = await h.seedInvitation({ tenantId: t.a.tenantId, email: late.email, invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 60_000) });
    sensitive.push(seeded.token, seeded.nonce);
    const response = await h.accept(app, late, seeded.token);
    assert.equal(response.status, 410);
    const expired = only(await h.auditsByRequest(response.requestId), 'membership.invitation_expired');
    assert.deepEqual(
      [expired.actor_type, expired.actor_user_id, expired.actor_membership_id, expired.tenant_id, expired.entity_id],
      ['system', null, null, t.a.tenantId, seeded.id],
    );
    assert.deepEqual(expired.metadata_json, { materialized_by: 'invitation_accept', target_role: 'technician' });

    const again = h.identity('again');
    const stale = await h.seedInvitation({ tenantId: t.a.tenantId, email: again.email, invitedBy: t.a.owner.membershipId, expiresAt: new Date(Date.now() - 60_000) });
    sensitive.push(stale.token, stale.nonce);
    const reinvite = await h.invite(app, t.a.owner, t.a.tenantId, { email: again.email, role: 'technician' });
    assert.equal(reinvite.status, 201);
    await remember(reinvite.json.invitation.id);
    const rows = await h.auditsByRequest(reinvite.requestId);
    assert.deepEqual(rows.map((row) => row.action).sort(), ['membership.invitation_expired', 'membership.invited']);
    const materialized = only(rows, 'membership.invitation_expired');
    assert.deepEqual([materialized.actor_type, materialized.entity_id, materialized.metadata_json.materialized_by], ['system', stale.id, 'invitation_create']);
  });
});

test('data rules: no token, hash, nonce, email, rendered message or client header in any row; catalog invariants hold', async () => {
  const rows = await h.allAudits();
  assert.deepEqual(h.scanAudits(rows, [...sensitive, UA]), []);
  assert.deepEqual(await h.catalogViolations(), []);
  assert.deepEqual(await h.duplicateSuccessRows(), []);
});
