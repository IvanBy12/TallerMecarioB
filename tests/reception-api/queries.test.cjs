'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { uuidV7 } = h.load('platform/uuid-v7.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const staffKeys = ['receptionId', 'vehicleId', 'customerId', 'appointmentId', 'locationId',
  'receivedByMembershipId', 'mileageKm', 'fuelLevelPct', 'customerNotes', 'advisorNotes',
  'status', 'receivedAt', 'closedAt', 'createdAt', 'updatedAt', 'checklist', 'damages'].sort();
const techKeys = ['receptionId', 'vehicleId', 'mileageKm', 'fuelLevelPct', 'status',
  'receivedAt', 'closedAt', 'checklist', 'damages'].sort();
const listKeys = ['receptionId', 'vehicleId', 'customerId', 'mileageKm', 'fuelLevelPct',
  'status', 'receivedAt', 'closedAt', 'updatedAt'].sort();
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool, identityProvider: provider,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes(server) {
      registerReceptionRoutes(server);
      server.get('/api/v1/__s307/tripwire', {
        config: { permission: 'receptions.read', permissionScope: 'resource' },
      }, async () => ({ unchecked: true }));
    } });
});
after(async () => h.closeAll(app));

const call = (actor, tenantId, url) => h.call(app, { subject: actor.subject, tenantId, url });
const list = (actor, tenantId, query = '') => call(actor, tenantId,
  `/api/v1/receptions${query ? `?${query}` : ''}`);
const detail = (actor, tenantId, id) => call(actor, tenantId, `/api/v1/receptions/${id}`);
const code = (result) => result.json?.error?.code;
const keys = (value) => Object.keys(value).sort();

test('explicit tenant predicates remain in every compiled reception read query despite RLS', () => {
  const source = readFileSync(join(process.env.TEST_MODULE_ROOT, 'receptions/queries.js'), 'utf8');
  assert.match(source, /WHERE r\.tenant_id = \$\{tenant\.tenantId\}\s+\$\{query\.afterId/u);
  assert.match(source, /AND a\.tenant_id = \$\{tenant\.tenantId\} AND a\.membership_id/u);
  assert.match(source, /FROM public\.receptions AS r\s+WHERE r\.tenant_id = \$\{tenant\.tenantId\} AND r\.id = \$\{receptionId\}/u);
  assert.match(source, /JOIN public\.assignments AS a ON a\.tenant_id = so\.tenant_id AND a\.order_id = so\.id/u);
  assert.match(source, /WHERE so\.tenant_id = \$\{tenant\.tenantId\} AND so\.reception_id = r\.id/u);
  assert.match(source, /FROM public\.reception_check_items AS c\s+WHERE c\.tenant_id = \$\{tenant\.tenantId\} AND c\.reception_id = \$\{receptionId\}/u);
  assert.match(source, /FROM public\.vehicle_damages AS d\s+WHERE d\.tenant_id = \$\{tenant\.tenantId\} AND d\.reception_id = \$\{receptionId\}/u);
});

test('syntactically valid base64url cursors reject invalid semantics and noncanonical encodings', async () => {
  const { a } = await h.twoTenants();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  const valid = encode({ v: 1, id });
  assert.equal((await list(a.advisor, a.tenantId, `cursor=${valid}`)).status, 200);
  const invalid = [
    encode({ v: 2, id }), encode({ v: 0, id }), encode({ v: '1', id }),
    encode({ v: 1, id: 'not-a-uuid' }), encode({ v: 1, id: 123 }),
    encode({ v: 1, id, extra: true }), encode({ v: 1 }), encode({ id }),
    encode({ v: 1, id: id.toUpperCase() }), encode({ v: 1, id: ` ${id}` }),
    encode([]), encode(null),
  ];
  // Alternate trailing pad bits decode to the same bytes but are not canonical
  // base64url. Keep the input alphabet and length syntactically valid.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const withWhitespace = Buffer.from(`${JSON.stringify({ v: 1, id })} `).toString('base64url');
  assert.notEqual(withWhitespace.length % 4, 0);
  const noncanonical = withWhitespace.slice(0, -1)
    + alphabet[alphabet.indexOf(withWhitespace.at(-1)) + 1];
  assert.deepEqual(Buffer.from(noncanonical, 'base64url'), Buffer.from(withWhitespace, 'base64url'));
  invalid.push(noncanonical);
  for (const cursor of invalid) {
    assert.match(cursor, /^[A-Za-z0-9_-]{1,128}$/u);
    const response = await list(a.advisor, a.tenantId, `cursor=${cursor}`);
    assert.equal(response.status, 400, `${cursor}: ${JSON.stringify(response.json)}`);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
});

async function fixture(tenant, { closed = false, children = false, customer = randomUUID(),
  receivedBy = tenant.owner.membershipId } = {}) {
  const vehicle = uuidV7(), reception = uuidV7();
  let consent = randomUUID();
  let order;
  await h.admin.begin(async (tx) => {
    const [exists] = await tx`SELECT 1 FROM public.customers WHERE tenant_id=${tenant.tenantId} AND id=${customer}`;
    if (!exists) await tx`INSERT INTO public.customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant.tenantId},'Private','Person','3000000000')`;
    await tx`INSERT INTO public.vehicles (id,tenant_id,plate,vehicle_type,brand,model)
      VALUES (${vehicle},${tenant.tenantId},${`Q${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`},
        'car','Brand','Model')`;
    await tx`INSERT INTO public.vehicle_owners
      (id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES (${randomUUID()},${tenant.tenantId},${vehicle},${customer},'owner',true)`;
    const [existingConsent] = await tx`SELECT id FROM public.privacy_consents
      WHERE tenant_id=${tenant.tenantId} AND customer_id=${customer}
        AND purpose_code='service_provision' AND status='granted'`;
    if (existingConsent) consent = existingConsent.id;
    else await tx`INSERT INTO public.privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
        authorization_text_hash,channel,captured_at,controller_notice_snapshot)
      VALUES (${consent},${tenant.tenantId},${customer},'service_provision','test-notice-1',
        'test-service-1',${'f'.repeat(64)},'in_person',now(),
        ${tx.json({ legalName: 'TEST', address: 'TEST', phone: '+5700000000',
          email: null, rightsChannel: 'TEST' })})`;
    await tx`INSERT INTO public.receptions
      (id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,
        mileage_km,fuel_level_pct,customer_notes,advisor_notes)
      VALUES (${reception},${tenant.tenantId},${vehicle},${customer},${consent},
        ${receivedBy},1234,50,'Private note','Advisor note')`;
    if (children) {
      await tx`INSERT INTO public.reception_check_items
        (id,tenant_id,reception_id,code,label,status,notes) VALUES
        (${randomUUID()},${tenant.tenantId},${reception},'Z','Last','ok',NULL),
        (${randomUUID()},${tenant.tenantId},${reception},'A','First','issue','note')`;
      await tx`INSERT INTO public.vehicle_damages
        (id,tenant_id,reception_id,zone_code,damage_type,severity,description,created_at) VALUES
        (${randomUUID()},${tenant.tenantId},${reception},'rear','scratch','minor','one','2026-01-01'),
        (${randomUUID()},${tenant.tenantId},${reception},'front','dent','severe','two','2026-01-02')`;
    }
    if (closed) {
      const media = randomUUID();
      order = uuidV7();
      await tx`INSERT INTO public.media_assets
        (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
        VALUES (${media},${tenant.tenantId},'test',${media},'signature','image/png',
          'active','authorization_evidence','v1')`;
      await tx`INSERT INTO public.signatures
        (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at,document_version,document_hash)
        VALUES (${randomUUID()},${tenant.tenantId},${reception},'Private Person',${media},now(),
          'v1',${'a'.repeat(64)})`;
      await tx`UPDATE public.receptions SET status='closed',closed_at=now() WHERE id=${reception}`;
      await tx`INSERT INTO public.service_orders
        (id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
        VALUES (${order},${tenant.tenantId},${reception},${vehicle},${customer},
          ${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)},${receivedBy})`;
      await tx`INSERT INTO public.order_status_history (id,tenant_id,order_id,to_status,request_id)
        VALUES (${randomUUID()},${tenant.tenantId},${order},'reception',${randomUUID()})`;
    }
  });
  return { customer, vehicle, consent, reception, order };
}
async function assignment(tenant, order, type, member = tenant.technician.membershipId) {
  const id = randomUUID();
  await h.admin`INSERT INTO public.assignments
    (id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
    VALUES (${id},${tenant.tenantId},${order},${member},${type},${tenant.advisor.membershipId})`;
  return id;
}

test('staff and restricted detail use exact DTOs, ordered children, effective multi-role grant', async () => {
  const { a, b } = await h.twoTenants([{ label: 'dual', roles: ['service_advisor', 'technician'] }]);
  const f = await fixture(a, { closed: true, children: true });
  const foreign = await fixture(b);
  for (const actor of [a.owner, a.admin, a.advisor, a.dual]) {
    const result = await detail(actor, a.tenantId, f.reception);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const r = result.json.reception;
    assert.deepEqual(keys(r), staffKeys);
    assert.deepEqual(r.checklist.map((c) => c.code), ['A', 'Z']);
    assert.deepEqual(r.damages.map((d) => d.zoneCode), ['rear', 'front']);
    assert.deepEqual(keys(r.checklist[0]), ['checkItemId', 'code', 'label', 'status', 'notes', 'createdAt'].sort());
    assert.deepEqual(keys(r.damages[0]), ['damageId', 'zoneCode', 'damageType', 'severity', 'description', 'createdAt'].sort());
  }
  const lead = await assignment(a, f.order, 'lead_technician');
  const tech = await detail(a.technician, a.tenantId, f.reception);
  assert.equal(tech.status, 200, JSON.stringify(tech.json));
  assert.deepEqual(keys(tech.json.reception), techKeys);
  assert.equal(JSON.stringify(tech.json).includes(f.customer), false);
  assert.equal(JSON.stringify(tech.json).includes('Private'), false);
  assert.equal(JSON.stringify(tech.json).includes('Advisor'), false);
  assert.equal(JSON.stringify(tech.json).includes(f.order), false);
  for (const actor of [a.owner, a.admin, a.advisor]) {
    assert.equal((await list(actor, a.tenantId)).status, 200);
    assert.deepEqual(keys((await list(actor, a.tenantId)).json.receptions[0]), listKeys);
  }
  assert.equal((await list(a.technician, a.tenantId)).status, 403);
  assert.equal((await list(b.technician, b.tenantId)).status, 403);
  assert.equal((await detail(a.owner, a.tenantId, foreign.reception)).status, 404);
  assert.equal((await detail(b.owner, b.tenantId, f.reception)).status, 404);
  assert.equal((await list(a.owner, a.tenantId)).json.receptions.some((r) => r.receptionId === foreign.reception), false);
  await h.admin`UPDATE public.assignments SET released_at=clock_timestamp() WHERE id=${lead}`;
});

test('assigned resolver rejects released, QC, wrong order, foreign, absent and malformed identically', async () => {
  const { a, b } = await h.twoTenants();
  const target = await fixture(a, { closed: true });
  const other = await fixture(a, { closed: true });
  const foreign = await fixture(b, { closed: true });
  const missing = h.errorShape(await detail(a.technician, a.tenantId, randomUUID()));
  const denied = async (id) => {
    const response = await detail(a.technician, a.tenantId, id);
    assert.equal(response.status, 404);
    assert.equal(code(response), 'RECEPTION_NOT_FOUND');
    assert.equal(h.errorShape(response), missing);
  };
  await denied('bad-uuid');
  await denied(foreign.reception);
  await denied(target.reception);
  const wrong = await assignment(a, other.order, 'lead_technician');
  await denied(target.reception);
  const qc = await assignment(a, target.order, 'quality_control');
  await denied(target.reception);
  await h.admin`UPDATE public.assignments SET released_at=clock_timestamp() WHERE id=${qc}`;
  const lead = await assignment(a, target.order, 'lead_technician');
  assert.equal((await detail(a.technician, a.tenantId, target.reception)).status, 200);
  await h.admin`UPDATE public.assignments SET released_at=clock_timestamp() WHERE id=${lead}`;
  await denied(target.reception);
  const support = await assignment(a, target.order, 'support_technician');
  assert.equal((await detail(a.technician, a.tenantId, target.reception)).status, 200);
  await h.admin`UPDATE public.assignments SET released_at=clock_timestamp() WHERE id=${support}`;
  await denied(target.reception);
  assert.equal((await list(a.technician, a.tenantId)).status, 403);
  for (const id of [foreign.reception, randomUUID(), 'bad-uuid']) {
    assert.equal(h.errorShape(await detail(a.owner, a.tenantId, id)),
      h.errorShape(await detail(a.owner, a.tenantId, randomUUID())));
  }
  assert.ok(wrong && qc);
});

test('list filters, validation and keyset pages are tenant scoped', async () => {
  const { a, b } = await h.twoTenants();
  const commonCustomer = randomUUID();
  const first = await fixture(a, { customer: commonCustomer });
  const closed = await fixture(a, { customer: commonCustomer, closed: true });
  const ids = [first.reception, closed.reception];
  for (let i = 0; i < 26; i++) ids.push((await fixture(a)).reception);
  const foreign = await fixture(b);
  const open = await list(a.owner, a.tenantId, 'status=open');
  assert.equal(open.status, 200);
  assert.ok(open.json.receptions.every((r) => r.status === 'open'));
  const closedList = await list(a.owner, a.tenantId, 'status=closed');
  assert.equal(closedList.status, 200);
  assert.ok(closedList.json.receptions.some((r) => r.receptionId === closed.reception));
  assert.ok(closedList.json.receptions.every((r) => r.status === 'closed'));
  for (const [query, wanted] of [
    [`vehicleId=${first.vehicle}`, [first.reception]],
    [`customerId=${commonCustomer}`, [first.reception, closed.reception]],
    [`status=closed&customerId=${commonCustomer}`, [closed.reception]],
    [`status=open&vehicleId=${first.vehicle}&customerId=${commonCustomer}`, [first.reception]],
  ]) {
    const result = await list(a.owner, a.tenantId, query);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.receptions.map((r) => r.receptionId).sort(), wanted.sort());
  }
  assert.equal((await list(a.owner, a.tenantId)).json.receptions.length, 25);
  for (const query of ['limit=1', 'limit=100']) assert.equal((await list(a.owner, a.tenantId, query)).status, 200);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=bad',
    'status=cancelled', 'status=invalid', 'vehicleId=bad', 'customerId=bad',
    'unknown=x', 'assigned=true', 'tenantId=x', 'membershipId=x', 'role=x',
    'permission=x', 'limit=1&limit=2', 'status=open&status=closed',
    'vehicleId=x&vehicleId=y']) {
    const response = await list(a.owner, a.tenantId, query);
    assert.equal(response.status, 400, `${query}: ${JSON.stringify(response.json)}`);
    assert.equal(code(response), 'REQUEST_VALIDATION_FAILED');
  }
  const seen = [];
  let cursor = null;
  do {
    const page = await list(a.owner, a.tenantId,
      `limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.status, 200, JSON.stringify(page.json));
    seen.push(...page.json.receptions.map((r) => r.receptionId));
    cursor = page.json.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ids.sort().reverse());
  assert.equal(seen.includes(foreign.reception), false);
  const pageOne = await list(a.owner, a.tenantId, 'limit=1');
  const inserted = await fixture(a);
  const pageTwo = await list(a.owner, a.tenantId, `limit=1&cursor=${pageOne.json.nextCursor}`);
  assert.notEqual(pageTwo.json.receptions[0].receptionId, pageOne.json.receptions[0].receptionId);
  assert.equal(pageTwo.json.receptions.some((r) => r.receptionId === inserted.reception), false);
});

test('real request lifecycle fails closed when restricted handler omits the resource mark', async () => {
  const { a } = await h.twoTenants();
  const url = '/api/v1/__s307/tripwire';
  assert.equal((await call(a.owner, a.tenantId, url)).status, 200);
  const denied = await call(a.technician, a.tenantId, url);
  assert.equal(denied.status, 500, JSON.stringify(denied.json));
  assert.equal(code(denied), 'RESOURCE_AUTHORIZATION_CHECK_MISSING');
});
