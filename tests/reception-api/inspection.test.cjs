'use strict';
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const privacy = require('./privacy-helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerVehicleRoutes } = h.load('vehicles/routes.js');
let app;
before(async () => { app = await buildApi({ database: h.apiPool,
  identityProvider: new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers }),
  rateLimit: { max: 100000, timeWindow: '1 minute' }, registerRoutes(server) {
    registerCustomerRoutes(server); registerVehicleRoutes(server);
    privacy.registerTestPrivacyRoutes(server); registerReceptionRoutes(server);
  } }); });
after(() => h.closeAll(app));
const check = (extra = {}) => ({ code: 'lights', label: 'Luces', status: 'ok', notes: null, ...extra });
const damage = (extra = {}) => ({ operation: 'create', zoneCode: 'front', damageType: 'scratch',
  severity: 'minor', description: null, ...extra });
const write = (a, r, kind, entries, token = r.updatedAt, actor = a.owner, extra = {}) => h.call(app,
  { subject: actor.subject, tenantId: a.tenantId, method: 'PATCH',
    url: '/api/v1/receptions/' + r.receptionId + '/' + kind,
    body: { expectedUpdatedAt: token, [kind === 'checklist' ? 'items' : 'damages']: entries }, ...extra });
const detail = (a, r) => h.call(app, { subject: a.owner.subject, tenantId: a.tenantId,
  url: '/api/v1/receptions/' + r.receptionId });
const audits = (r, kind) => h.admin.unsafe('SELECT * FROM public.audit_logs WHERE entity_id=$1 AND action=$2 ORDER BY created_at, id',
  [r.receptionId, 'reception.' + kind + '_updated']);
async function created(tenant, extra = {}) {
  const c = await h.createCustomer(app, tenant.owner, tenant.tenantId, h.validCustomer());
  assert.equal(c.status, 201);
  const v = await h.call(app, { subject: tenant.owner.subject, tenantId: tenant.tenantId,
    method: 'POST', url: '/api/v1/vehicles', body: {
      customerId: c.json.customer.customerId, plate: `R${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      vehicleType: 'car', brand: 'Marca', model: 'Modelo',
    } });
  assert.equal(v.status, 201);
  // S3-04.5: every reception needs the owner's service_provision consent.
  const privacyConsentId = await privacy.serviceConsent(app, tenant.owner, tenant.tenantId,
    c.json.customer.customerId);
  const r = await h.call(app, { subject: tenant.owner.subject, tenantId: tenant.tenantId,
    method: 'POST', url: '/api/v1/receptions', body: {
      vehicleId: v.json.vehicle.vehicleId, customerId: c.json.customer.customerId, privacyConsentId,
      mileageKm: 1000, ...extra,
    } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.reception;
}
async function closeFixture(tx, tenant, reception) {
  // DB-only fixture follows the existing reception DB suite. All 0019 guards
  // remain enabled, including signature, order lineage and initial history.
  const mediaId = randomUUID();
  const orderId = randomUUID();
  await tx`INSERT INTO public.media_assets ${tx({ id: mediaId, tenant_id: tenant.tenantId,
    bucket: 'test', object_key: mediaId, media_type: 'signature', mime_type: 'image/png',
    status: 'active', retention_class: 'authorization_evidence', retention_policy_version: 'v1' })}`;
  await tx`INSERT INTO public.signatures ${tx({ id: randomUUID(), tenant_id: tenant.tenantId,
    reception_id: reception.receptionId, signed_by_name: 'Customer', signature_media_id: mediaId,
    signed_at: new Date(), document_version: 'v1', document_hash: 'a'.repeat(64) })}`;
  await tx`UPDATE public.receptions SET status='closed', closed_at=now() WHERE id=${reception.receptionId}`;
  await tx`INSERT INTO public.service_orders ${tx({ id: orderId, tenant_id: tenant.tenantId,
    reception_id: reception.receptionId, vehicle_id: reception.vehicleId, customer_id: reception.customerId,
    order_number: 1, created_by_membership_id: tenant.owner.membershipId })}`;
  await tx`INSERT INTO public.order_status_history ${tx({ id: randomUUID(), tenant_id: tenant.tenantId,
    order_id: orderId, from_status: null, to_status: 'reception',
    changed_by_membership_id: tenant.owner.membershipId, request_id: randomUUID() })}`;
}
// Scope the barrier to the holder and the reception SELECT, including indirect
// tuple-lock waiters. Both requests must reach the lock before it is released.
async function waitForBlockedOn(holderPid, expected, queryPart) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const [r] = await h.admin`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND ${holderPid}=ANY(pg_catalog.pg_blocking_pids(pid))
      UNION
      SELECT a.pid FROM pg_catalog.pg_stat_activity a
      JOIN waiting w ON w.pid=ANY(pg_catalog.pg_blocking_pids(a.pid))
      WHERE a.datname=pg_catalog.current_database()
    ) SELECT count(DISTINCT a.pid)::int AS n FROM waiting w
      JOIN pg_catalog.pg_stat_activity a ON a.pid=w.pid
      WHERE a.wait_event_type='Lock' AND a.query LIKE ${`%${queryPart}%`}`;
    if (r.n >= expected) return;
    if (Date.now() > deadline) throw new Error(`RECEPTION_PATCH_BARRIER_TIMEOUT ${r.n}/${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const kind of ['checklist', 'damages']) {
  const entry = kind === 'checklist' ? check : damage;
  test(kind + ': batch enums/null/text, stable IDs, GET reconciliation, version advancement and minimal audit', async () => {
    const { a } = await h.twoTenants(); let r = await created(a);
    const values = kind === 'checklist' ? ['ok', 'issue', 'not_checked', 'not_applicable'] : ['minor', 'moderate', 'severe'];
    const entries = values.map((value, i) => kind === 'checklist'
      ? check({ code: 'c' + i, status: value, notes: i ? 'PrivateInspectionText' : null })
      : damage({ severity: value, description: i ? 'PrivateInspectionText' : null }));
    let result; const output = await h.captureOutput(async () => { result = await write(a, r, kind, entries, r.updatedAt, a.advisor); });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(result.json.reception.updatedAt > r.updatedAt);
    assert.deepEqual((await detail(a, r)).json, result.json);
    for (const [i, item] of result.json.reception[kind].entries()) {
      if (kind === 'checklist') {
        assert.equal(item.status, values[i]); assert.equal(item.notes, entries[i].notes);
      } else {
        assert.equal(item.severity, values[i]); assert.equal(item.description, entries[i].description);
      }
    }
    const first = result.json.reception[kind][0];
    const idKey = kind === 'checklist' ? 'checkItemId' : 'damageId'; r = result.json.reception;
    const corrected = kind === 'checklist' ? check({ code: first.code, status: 'issue', notes: 'Corregido' })
      : damage({ operation: 'update', damageId: first.damageId.toUpperCase(), severity: 'severe', description: 'Corregido' });
    const next = await write(a, r, kind, [corrected], r.updatedAt, a.admin);
    assert.equal(next.status, 200, JSON.stringify(next.json));
    assert.equal(next.json.reception[kind].length, values.length);
    const kept = next.json.reception[kind].find(item => item[idKey] === first[idKey]);
    assert.equal(kept[kind === 'checklist' ? 'notes' : 'description'], 'Corregido');
    assert.equal(kept[kind === 'checklist' ? 'status' : 'severity'], kind === 'checklist' ? 'issue' : 'severe');
    assert.equal(kept.createdAt, first.createdAt); assert.ok(next.json.reception.updatedAt > r.updatedAt);
    const evidence = await audits(r, kind); assert.equal(evidence.length, 2);
    assert.deepEqual(evidence[0].metadata_json, { count: values.length });
    assert.equal(evidence[0].actor_membership_id, a.advisor.membershipId);
    assert.equal(evidence[0].outcome, 'success'); assert.equal(evidence[0].before_json, null);
    assert.equal(JSON.stringify(evidence).includes('PrivateInspectionText'), false);
    assert.equal(output.includes('PrivateInspectionText'), false);
    assert.deepEqual((await detail(a, r)).json, next.json);
  });
  test(kind + ': strict payload shape/count/text/enums/IDs, malformed JSON, content-type and size', async () => {
    const { a } = await h.twoTenants(); const r = await created(a);
    const invalidEntries = [[], Array.from({ length: 101 }, () => entry()), [entry({ extra: true })],
      [entry(kind === 'checklist' ? { code: '' } : { zoneCode: '' })],
      [entry(kind === 'checklist' ? { code: 'x'.repeat(65) } : { damageType: 'x'.repeat(65) })],
      [entry(kind === 'checklist' ? { label: 'x'.repeat(161) } : { zoneCode: 'x'.repeat(65) })],
      [entry(kind === 'checklist' ? { status: 'unknown' } : { severity: 'unknown' })],
      [entry(kind === 'checklist' ? { notes: 'x'.repeat(2001) } : { description: 'x'.repeat(2001) })],
      [entry(kind === 'checklist' ? { notes: '\u0000' } : { description: '\u202E' })]];
    if (kind === 'checklist') invalidEntries.push([check(), check()], [check({ code: ' lights ' }), check()]);
    else invalidEntries.push([damage({ damageId: randomUUID() })], [damage({ operation: 'delete' })],
      [damage({ operation: 'update', damageId: 'invalid' })],
      [damage({ operation: 'update', damageId: '00000000-0000-0000-0000-000000000000' })]);
    for (const entries of invalidEntries) {
      const response = await write(a, r, kind, entries);
      assert.equal(response.status, 400, JSON.stringify(response.json)); assert.equal(response.json.error.code, 'REQUEST_VALIDATION_FAILED');
    }
    for (const token of [null, '', '2026-01-01T00:00:00.123Z']) assert.equal((await write(a, r, kind, [entry()], token)).status, 400);
    assert.equal((await write(a, r, kind, [entry()], r.updatedAt, a.owner,
      { body: { expectedUpdatedAt: r.updatedAt, [kind === 'checklist' ? 'items' : 'damages']: [entry()], tenantId: a.tenantId } })).status, 400);
    assert.equal((await write(a, r, kind, [entry()], r.updatedAt, a.owner,
      { rawBody: '{', headers: { 'content-type': 'application/json' } })).json.error.code, 'REQUEST_BODY_MALFORMED');
    assert.equal((await write(a, r, kind, [entry()], r.updatedAt, a.owner, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await write(a, r, kind, [entry()], r.updatedAt, a.owner,
      { rawBody: JSON.stringify({ expectedUpdatedAt: r.updatedAt, [kind === 'checklist' ? 'items' : 'damages']:
        [entry(kind === 'checklist' ? { notes: 'x'.repeat(70000) } : { description: 'x'.repeat(70000) })] }) })).status, 413);
    assert.equal((await audits(r, kind)).length, 0); assert.equal((await detail(a, r)).json.reception[kind].length, 0);
  });
  test(kind + ': opaque microseconds and stale OCC; two overlapping writers have one winner', async () => {
    const { a } = await h.twoTenants(); const r = await created(a); const exact = '2999-01-01T00:00:00.123456Z';
    await h.admin`UPDATE public.receptions SET updated_at=${exact}::text::timestamptz WHERE id=${r.receptionId}`;
    assert.equal((await write(a, r, kind, [entry()], '2999-01-01T00:00:00.123000Z')).json.error.code, 'RESOURCE_VERSION_CONFLICT');
    let pending;
    await h.admin.begin(async tx => {
      const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE`;
      pending = Promise.all([write(a, r, kind, [entry()], exact), write(a, r, kind, [entry()], exact, a.advisor)]);
      await waitForBlockedOn(holder.pid, 2, 'FROM public.receptions AS r');
    });
    const results = await pending; assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
    assert.equal(results.find(x => x.status === 409).json.error.code, 'RESOURCE_VERSION_CONFLICT');
    assert.equal(results.find(x => x.status === 200).json.reception.updatedAt, '2999-01-01T00:00:00.123457Z');
    assert.equal((await audits(r, kind)).length, 1);
  });
  test(kind + ': cross-tenant anti-oracle, technician denied before validation, close wins parent lock', async () => {
    const { a, b } = await h.twoTenants(); const r = await created(a);
    const foreign = await write(b, r, kind, [entry()]); const absent = await write(b, { ...r, receptionId: randomUUID() }, kind, [entry()]);
    assert.equal(foreign.status, 404); assert.equal(h.errorShape(foreign), h.errorShape(absent));
    assert.equal((await write(a, r, kind, [{ invalid: true }], r.updatedAt, a.technician)).json.error.code, 'PERMISSION_DENIED');
    let pending;
    await h.admin.begin(async tx => {
      const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE`;
      await closeFixture(tx, a, r); pending = write(a, r, kind, [entry()]);
      await waitForBlockedOn(holder.pid, 1, 'FROM public.receptions AS r');
    });
    const result = await pending; assert.equal(result.status, 409); assert.equal(result.json.error.code, 'RECEPTION_NOT_EDITABLE');
    assert.equal((await write(a, r, kind, [entry()], '2999-01-01T00:00:00.123456Z')).json.error.code, 'RECEPTION_NOT_EDITABLE');
    assert.equal((await audits(r, kind)).length, 0);
  });
  test(kind + ': audit failure rolls back children and version', async () => {
    const { a } = await h.twoTenants(); const r = await created(a); const requestId = randomUUID();
    await h.admin.unsafe("ALTER TABLE public.audit_logs ADD CONSTRAINT inspection_audit_probe CHECK (action <> 'reception." + kind + "_updated') NOT VALID");
    try {
      const response = await write(a, r, kind, [entry()], r.updatedAt, a.owner, { headers: { 'x-request-id': requestId } });
      assert.equal(response.status, 500);
      const stored = (await detail(a, r)).json.reception; assert.equal(stored.updatedAt, r.updatedAt); assert.equal(stored[kind].length, 0);
      assert.equal((await audits(r, kind)).length, 0);
    } finally { await h.admin`ALTER TABLE public.audit_logs DROP CONSTRAINT inspection_audit_probe`; }
  });
}
test('damages: foreign reception/tenant/nonexistent IDs have identical errors and atomic mixed batch rollback', async () => {
  const { a, b } = await h.twoTenants(); const r = await created(a); const other = await created(a); const foreign = await created(b);
  const otherDamage = (await write(a, other, 'damages', [damage()])).json.reception.damages[0].damageId;
  const foreignDamage = (await write(b, foreign, 'damages', [damage()])).json.reception.damages[0].damageId;
  let shape;
  for (const id of [otherDamage, foreignDamage, randomUUID()]) {
    const response = await write(a, r, 'damages', [damage(), damage({ operation: 'update', damageId: id })]);
    assert.equal(response.status, 404); assert.equal(response.json.error.code, 'DAMAGE_NOT_FOUND');
    shape ??= h.errorShape(response); assert.equal(h.errorShape(response), shape);
    const stored = (await detail(a, r)).json.reception; assert.equal(stored.updatedAt, r.updatedAt); assert.equal(stored.damages.length, 0);
    assert.equal((await audits(r, 'damages')).length, 0);
  }
  assert.equal((await write(a, r, 'damages', [damage({ operation: 'update', damageId: otherDamage }),
    damage({ operation: 'update', damageId: otherDamage.toUpperCase() })])).status, 400);
});
async function signFixture(tx, tenant, reception) {
  // DB-only fixture follows the existing reception DB suite. All 0019 guards
  // remain enabled, including signature, order lineage and initial history.
  const mediaId = randomUUID();
  await tx`INSERT INTO public.media_assets ${tx({ id: mediaId, tenant_id: tenant.tenantId,
    bucket: 'test', object_key: mediaId, media_type: 'signature', mime_type: 'image/png',
    status: 'active', retention_class: 'authorization_evidence', retention_policy_version: 'v1' })}`;
  await tx`INSERT INTO public.signatures ${tx({ id: randomUUID(), tenant_id: tenant.tenantId,
    reception_id: reception.receptionId, signed_by_name: 'Customer', signature_media_id: mediaId,
    signed_at: new Date(), document_version: 'v1', document_hash: 'a'.repeat(64) })}`;
}

for (const kind of ['checklist', 'damages']) {
  test(kind + ': writer wins close race; persisted child retained, assigned technician remains read-only', async () => {
    const { a } = await h.twoTenants(); const r = await created(a);
    await signFixture(h.admin, a, r);
    let writer; let closer;
    await h.admin.begin(async tx => {
      const [holder] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT id FROM public.receptions WHERE id=${r.receptionId} FOR NO KEY UPDATE`;
      writer = write(a, r, kind, [kind === 'checklist' ? check() : damage()]);
      await waitForBlockedOn(holder.pid, 1, 'FROM public.receptions AS r');
      closer = h.call(app, { subject: a.owner.subject, tenantId: a.tenantId, method: 'POST',
        url: '/api/v1/receptions/' + r.receptionId + '/close' });
      await waitForBlockedOn(holder.pid, 2, 'FROM public.receptions AS r');
    });
    assert.equal((await writer).status, 200);
    const closed = await closer; assert.equal(closed.status, 200, JSON.stringify(closed.json));
    const stored = (await detail(a, r)).json.reception;
    assert.equal(stored.status, 'closed'); assert.equal(stored[kind].length, 1);
    await h.admin`INSERT INTO public.assignments
      (id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
      VALUES (${randomUUID()},${a.tenantId},${stored.serviceOrder.id},${a.technician.membershipId},
        'lead_technician',${a.owner.membershipId})`;
    const assigned = await h.call(app, { subject: a.technician.subject, tenantId: a.tenantId,
      url: '/api/v1/receptions/' + r.receptionId });
    assert.equal(assigned.status, 200); assert.equal(assigned.json.reception[kind].length, 1);
    assert.equal(assigned.json.reception.customerId, undefined); assert.equal(assigned.json.reception.updatedAt, undefined);
    const denied = await write(a, r, kind, [kind === 'checklist' ? check() : damage()], stored.updatedAt, a.technician);
    assert.equal(denied.status, 403); assert.equal(denied.json.error.code, 'PERMISSION_DENIED');
    assert.equal((await audits(r, kind)).length, 1);
  });
}
