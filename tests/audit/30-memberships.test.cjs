'use strict';

/**
 * S1-07 — audit events of S1-05 (role assignment / removal) and S1-06
 * (membership suspend / revoke) through the real routes: success rows, the
 * durable denied rows (escalation, self-modification, insufficient target
 * authority), actor/tenant spoofing through the request, resource ids of
 * another tenant, and the denied outcomes that are deliberately NOT audited
 * (route-level PERMISSION_DENIED, cross-tenant selection, 404/409).
 */

const h = require('./helpers.cjs');
const { after, before, describe, test } = require('node:test');
const { randomUUID } = require('node:crypto');

const { assert } = h;
let app;
let t;
const UA = `Mozilla/5.0 (s107-members-${randomUUID()})`;

before(async () => {
  app = await h.buildAuditApp();
  t = await h.tenants({ extraTechnicians: 6 });
});
after(async () => {
  await app.close();
  await Promise.all([h.apiPool.end(), h.workerPool.end()]);
  await h.admin.end();
});

const SPOOF = () => ({
  'user-agent': UA,
  'x-actor-membership-id': t.a.admin.membershipId,
  'x-actor-user-id': t.a.admin.user.id,
  'x-audit-tenant-id': t.b.tenantId,
  'x-request-id': `forged-${randomUUID()}`,
  cookie: `__session=${randomUUID()}`,
});

function assertActor(row, actor, tenantId) {
  assert.equal(row.tenant_id, tenantId, `${row.action}: tenant`);
  assert.equal(row.actor_type, 'user');
  assert.equal(row.actor_user_id, actor.user.id, `${row.action}: actor user = authenticated`);
  assert.equal(row.actor_membership_id, actor.membershipId, `${row.action}: actor membership = TenantContext`);
  assert.equal(row.user_agent, null);
  assert.equal(row.ip_address, '127.0.0.1');
}

describe('S1-05 roles', () => {
  test('role.assigned / role.revoked success: before/after role sets, actor from the TenantContext despite spoofing headers', async () => {
    const target = t.a.extras[0];
    const assigned = await h.assignRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor', { headers: SPOOF() });
    assert.equal(assigned.status, 201);
    const [assignRow] = await h.auditsByRequest(assigned.requestId);
    assertActor(assignRow, t.a.owner, t.a.tenantId);
    assert.deepEqual(
      [assignRow.action, assignRow.outcome, assignRow.entity_type, assignRow.entity_id, assignRow.reason_code],
      ['role.assigned', 'success', 'membership_role', target.membershipId, 'member_role_management'],
    );
    assert.deepEqual([assignRow.before_json, assignRow.after_json, assignRow.metadata_json],
      [{ roles: ['technician'] }, { roles: ['service_advisor', 'technician'] }, { role: 'service_advisor' }]);

    const removed = await h.removeRole(app, t.a.owner, t.a.tenantId, target.membershipId, 'service_advisor', { headers: SPOOF() });
    assert.equal(removed.status, 200);
    const [removeRow] = await h.auditsByRequest(removed.requestId);
    assertActor(removeRow, t.a.owner, t.a.tenantId);
    assert.deepEqual([removeRow.action, removeRow.before_json, removeRow.after_json],
      ['role.revoked', { roles: ['service_advisor', 'technician'] }, { roles: ['technician'] }]);
  });

  test('actor / tenant / assigned_by in the body are rejected (400) and never audited', async () => {
    for (const body of [
      { role_code: 'service_advisor', actor_membership_id: t.a.admin.membershipId },
      { role_code: 'service_advisor', tenant_id: t.b.tenantId },
      { role_code: 'service_advisor', assigned_by_membership_id: t.a.admin.membershipId },
    ]) {
      const response = await h.call(app, {
        subject: t.a.owner.subject, method: 'POST', url: `/api/v1/memberships/${t.a.extras[0].membershipId}/roles`, body, tenantId: t.a.tenantId,
      });
      assert.equal(response.status, 400);
      assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    }
  });

  test('denied escalation (admin -> admin role) and self modification are durable denied rows', async () => {
    const escalation = await h.assignRole(app, t.a.admin, t.a.tenantId, t.a.advisor.membershipId, 'admin');
    assert.equal(escalation.status, 403);
    assert.equal(escalation.json.error.code, 'ROLE_ASSIGNMENT_NOT_ALLOWED');
    const [escalationRow] = await h.auditsByRequest(escalation.requestId);
    assertActor(escalationRow, t.a.admin, t.a.tenantId);
    assert.deepEqual(
      [escalationRow.action, escalationRow.outcome, escalationRow.reason_code, escalationRow.entity_id, escalationRow.metadata_json],
      ['role.assigned', 'denied', 'role_assignment_not_permitted', t.a.advisor.membershipId, { role: 'admin', missing_permissions: ['roles.assign_admin'] }],
    );
    assert.deepEqual(await h.roleCodes(t.a.advisor.membershipId), ['service_advisor']);

    const self = await h.removeRole(app, t.a.owner, t.a.tenantId, t.a.owner.membershipId, 'owner');
    assert.equal(self.status, 403);
    assert.equal(self.json.error.code, 'SELF_ROLE_MODIFICATION_FORBIDDEN');
    const [selfRow] = await h.auditsByRequest(self.requestId);
    assert.deepEqual([selfRow.action, selfRow.outcome, selfRow.reason_code, selfRow.entity_id],
      ['role.revoked', 'denied', 'self_role_modification', t.a.owner.membershipId]);
  });

  test("another tenant's membership id: 404 without any audit row mentioning it", async () => {
    const before = await h.auditsMentioning(t.b.technician.membershipId);
    const response = await h.assignRole(app, t.a.owner, t.a.tenantId, t.b.technician.membershipId, 'service_advisor');
    assert.equal(response.status, 404);
    assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    assert.deepEqual(await h.auditsMentioning(t.b.technician.membershipId), before);
    assert.deepEqual(await h.roleCodes(t.b.technician.membershipId), ['technician']);
  });
});

describe('S1-06 membership lifecycle', () => {
  test('membership.suspended then membership.revoked: status before/after, roles in metadata, actor from the TenantContext despite spoofing', async () => {
    const target = t.a.extras[1];
    const suspended = await h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId, { headers: SPOOF() });
    assert.equal(suspended.status, 200);
    const [suspendRow] = await h.auditsByRequest(suspended.requestId);
    assertActor(suspendRow, t.a.owner, t.a.tenantId);
    assert.deepEqual(
      [suspendRow.action, suspendRow.outcome, suspendRow.entity_type, suspendRow.entity_id, suspendRow.reason_code, suspendRow.before_json, suspendRow.after_json, suspendRow.metadata_json],
      ['membership.suspended', 'success', 'membership', target.membershipId, 'member_status_management', { status: 'active' }, { status: 'suspended' }, { command: 'suspend', roles: ['technician'] }],
    );
    const revoked = await h.revoke(app, t.a.owner, t.a.tenantId, target.membershipId, { headers: SPOOF() });
    assert.equal(revoked.status, 200);
    const [revokeRow] = await h.auditsByRequest(revoked.requestId);
    assertActor(revokeRow, t.a.owner, t.a.tenantId);
    assert.deepEqual([revokeRow.action, revokeRow.before_json, revokeRow.after_json], ['membership.revoked', { status: 'suspended' }, { status: 'revoked' }]);
  });

  test('denied insufficient target authority (admin -> owner) and self suspend/revoke are durable denied rows; state unchanged', async () => {
    const authority = await h.suspend(app, t.a.admin, t.a.tenantId, t.a.owner.membershipId);
    assert.equal(authority.status, 403);
    assert.equal(authority.json.error.code, 'DOMAIN_ACTION_FORBIDDEN');
    const [authorityRow] = await h.auditsByRequest(authority.requestId);
    assertActor(authorityRow, t.a.admin, t.a.tenantId);
    assert.deepEqual(
      [authorityRow.action, authorityRow.outcome, authorityRow.reason_code, authorityRow.entity_id, authorityRow.metadata_json],
      ['membership.suspended', 'denied', 'membership_management_not_permitted', t.a.owner.membershipId,
        { command: 'suspend', roles: ['owner'], missing_permissions: ['roles.assign_owner'] }],
    );
    assert.equal(await h.membershipStatus(t.a.owner.membershipId), 'active');

    for (const [command, action] of [[h.suspend, 'membership.suspended'], [h.revoke, 'membership.revoked']]) {
      const self = await command(app, t.a.admin, t.a.tenantId, t.a.admin.membershipId);
      assert.equal(self.status, 403);
      const [row] = await h.auditsByRequest(self.requestId);
      assert.deepEqual([row.action, row.outcome, row.reason_code, row.entity_id, row.actor_membership_id],
        [action, 'denied', 'self_membership_modification', t.a.admin.membershipId, t.a.admin.membershipId]);
    }
    assert.equal(await h.membershipStatus(t.a.admin.membershipId), 'active');
  });

  test("another tenant's membership id: 404 without any audit row mentioning it; B's state unchanged", async () => {
    const before = await h.auditsMentioning(t.b.owner.membershipId);
    for (const command of [h.suspend, h.revoke]) {
      const response = await command(app, t.a.owner, t.a.tenantId, t.b.owner.membershipId);
      assert.equal(response.status, 404);
      assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    }
    assert.deepEqual(await h.auditsMentioning(t.b.owner.membershipId), before);
    assert.equal(await h.membershipStatus(t.b.owner.membershipId), 'active');
  });

  test('a non-empty body (actor / tenant / status) is rejected (400) and never audited', async () => {
    for (const body of [{ actor_membership_id: t.a.admin.membershipId }, { tenant_id: t.b.tenantId }, { status: 'active' }]) {
      const response = await h.call(app, {
        subject: t.a.owner.subject, method: 'POST', url: `/api/v1/memberships/${t.a.extras[2].membershipId}/suspend`, body, tenantId: t.a.tenantId,
      });
      assert.equal(response.status, 400);
      assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    }
    assert.equal(await h.membershipStatus(t.a.extras[2].membershipId), 'active');
  });
});

describe('denied outcomes that are deliberately not audited (policy: docs/S1-07-DOC-CHANGES.md §6)', () => {
  test('route-level PERMISSION_DENIED (advisor / technician on staff management) writes nothing', async () => {
    const before = await h.auditCount();
    const attempts = [
      await h.suspend(app, t.a.advisor, t.a.tenantId, t.a.extras[3].membershipId),
      await h.assignRole(app, t.a.technician, t.a.tenantId, t.a.technician.membershipId, 'owner'),
      await h.invite(app, t.a.advisor, t.a.tenantId, { email: h.uniqueEmail('nope'), role: 'technician' }),
    ];
    for (const response of attempts) {
      assert.equal(response.status, 403);
      assert.equal(response.json.error.code, 'PERMISSION_DENIED');
    }
    assert.equal(await h.auditCount(), before);
  });

  test('cross-tenant selection (member of A asking for B) is 403 and writes into neither tenant', async () => {
    const beforeA = (await h.auditsForTenant(t.a.tenantId)).length;
    const beforeB = (await h.auditsForTenant(t.b.tenantId)).length;
    const response = await h.suspend(app, t.a.owner, t.b.tenantId, t.b.technician.membershipId);
    assert.equal(response.status, 403);
    assert.equal((await h.auditsByRequest(response.requestId)).length, 0);
    assert.equal((await h.auditsForTenant(t.a.tenantId)).length, beforeA);
    assert.equal((await h.auditsForTenant(t.b.tenantId)).length, beforeB);
    assert.equal(await h.membershipStatus(t.b.technician.membershipId), 'active');
  });

  test('invalid transition (409) and repeated success commands write nothing', async () => {
    const target = t.a.extras[4];
    assert.equal((await h.revoke(app, t.a.owner, t.a.tenantId, target.membershipId)).status, 200);
    const before = await h.auditCount();
    const again = await h.revoke(app, t.a.owner, t.a.tenantId, target.membershipId);
    const suspendRevoked = await h.suspend(app, t.a.owner, t.a.tenantId, target.membershipId);
    assert.deepEqual([again.status, suspendRevoked.status], [409, 409]);
    const dup = await h.assignRole(app, t.a.owner, t.a.tenantId, t.a.extras[5].membershipId, 'technician');
    assert.equal(dup.status, 409);
    assert.equal(await h.auditCount(), before);
  });
});

test('data rules: no header, cookie, JWT or PII in any row; catalog invariants hold', async () => {
  const rows = await h.allAudits();
  assert.deepEqual(h.scanAudits(rows, [UA, '__session=']), []);
  assert.deepEqual(await h.catalogViolations(), []);
  assert.deepEqual(await h.duplicateSuccessRows(), []);
});
