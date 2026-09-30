'use strict';

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { RECEPTION_ACCEPTANCE_VERSION } = h.load('receptions/acceptance-document.js');
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
let app;
before(async () => {
  app = await buildApi({ database: h.apiPool, identityProvider: provider,
    rateLimit: { max: 100_000, timeWindow: '1 minute' },
    registerRoutes: registerReceptionRoutes });
});
after(async () => h.closeAll(app));

async function fixture(tenant, { mileage = 1000, vehicleMileage = null, signed = true } = {}) {
  const customer = randomUUID(), vehicle = randomUUID(), consent = randomUUID(), reception = randomUUID();
  await h.admin.begin(async (tx) => {
    await tx`INSERT INTO public.customers (id,tenant_id,first_name,last_name,phone)
      VALUES (${customer},${tenant.tenantId},'Close','Test','3000000000')`;
    await tx`INSERT INTO public.vehicles
      (id,tenant_id,plate,vehicle_type,brand,model,current_mileage_km)
      VALUES (${vehicle},${tenant.tenantId},${`C${vehicle.replaceAll('-', '').slice(0, 12).toUpperCase()}`},
        'car','Marca','Modelo',${vehicleMileage})`;
    await tx`INSERT INTO public.vehicle_owners
      (id,tenant_id,vehicle_id,customer_id,relationship_type,is_primary)
      VALUES (${randomUUID()},${tenant.tenantId},${vehicle},${customer},'owner',true)`;
    await tx`INSERT INTO public.privacy_consents
      (id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
        authorization_text_hash,channel,captured_at,controller_notice_snapshot)
      VALUES (${consent},${tenant.tenantId},${customer},'service_provision','test-notice-1',
        'test-service-1',${'f'.repeat(64)},'in_person',now(),
        ${tx.json({ legalName: 'TEST', address: 'TEST', phone: '+5700000000',
          email: null, rightsChannel: 'TEST' })})`;
    await tx`INSERT INTO public.receptions
      (id,tenant_id,vehicle_id,customer_id,privacy_consent_id,received_by_membership_id,mileage_km)
      VALUES (${reception},${tenant.tenantId},${vehicle},${customer},${consent},
        ${tenant.owner.membershipId},${mileage})`;
    if (signed) {
      const media = randomUUID();
      await tx`INSERT INTO public.media_assets
        (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
        VALUES (${media},${tenant.tenantId},'test',${media},'signature','image/png',
          'active','authorization_evidence','v1')`;
      await tx`INSERT INTO public.signatures
        (id,tenant_id,reception_id,signed_by_name,signature_media_id,signed_at,
          document_version,document_hash)
        VALUES (${randomUUID()},${tenant.tenantId},${reception},'Customer',${media},now(),
          'v1',${'a'.repeat(64)})`;
    }
  });
  return { customer, vehicle, consent, reception };
}
const close = (actor, tenantId, id, extra = {}) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST', url: `/api/v1/receptions/${id}/close`, ...extra,
});
const errorCode = (response) => response.json?.error?.code;
const orders = (id) => h.admin`SELECT * FROM public.service_orders WHERE reception_id=${id}`;
const audits = (id) => h.admin`SELECT * FROM public.audit_logs
  WHERE entity_id=${id} AND action='reception.closed'`;
async function signatureMedia(tenantId) {
  const media = randomUUID();
  await h.admin`INSERT INTO public.media_assets
    (id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
    VALUES (${media},${tenantId},'test',${media},'signature','image/png',
      'active','authorization_evidence','v1')`;
  return media;
}
const sign = (actor, tenantId, id, media) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST', url: `/api/v1/receptions/${id}/signature`,
  body: { signatureMediaId: media, signedByName: 'Customer',
    documentVersion: RECEPTION_ACCEPTANCE_VERSION },
});
const patch = (actor, tenantId, id, expectedUpdatedAt, mileageKm) => h.call(app, {
  subject: actor.subject, tenantId, method: 'PATCH', url: `/api/v1/receptions/${id}`,
  body: { expectedUpdatedAt, mileageKm },
});
const create = (actor, tenantId, f, mileageKm) => h.call(app, {
  subject: actor.subject, tenantId, method: 'POST', url: '/api/v1/receptions',
  body: { vehicleId: f.vehicle, customerId: f.customer, privacyConsentId: f.consent, mileageKm },
});
async function blockedBy(pid, count, fragment) {
  const deadline = Date.now() + 6000;
  for (;;) {
    const [row] = await h.admin`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_catalog.pg_stat_activity
      WHERE datname=pg_catalog.current_database() AND ${pid}=ANY(pg_catalog.pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_catalog.pg_stat_activity a JOIN waiting w
        ON w.pid=ANY(pg_catalog.pg_blocking_pids(a.pid))
      WHERE a.datname=pg_catalog.current_database()
    ) SELECT count(DISTINCT a.pid)::int AS n FROM waiting w
      JOIN pg_catalog.pg_stat_activity a ON a.pid=w.pid
      WHERE a.wait_event_type='Lock' AND a.query LIKE ${`%${fragment}%`}`;
    if (row.n >= count) return;
    if (Date.now() > deadline) assert.fail(`close barrier ${row.n}/${count} ${fragment}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('close persists exactly one order, history, mileage and audit; retry is read-only', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const first = await close(a.advisor, a.tenantId, f.reception);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.reception.status, 'closed');
  assert.equal(first.json.serviceOrder.orderNumber, '1');
  assert.equal(first.json.serviceOrder.status, 'reception');
  assert.equal(first.json.serviceOrder.version, 1);
  const [r] = await h.admin`SELECT status,closed_at,updated_at,xmin::text AS xmin
    FROM public.receptions WHERE id=${f.reception}`;
  const [v] = await h.admin`SELECT current_mileage_km,updated_at,xmin::text AS xmin
    FROM public.vehicles WHERE id=${f.vehicle}`;
  const [o] = await orders(f.reception);
  assert.deepEqual([o.status, o.priority, o.promised_at, o.closed_at,
    o.created_by_membership_id, o.version],
    ['reception', 'normal', null, null, a.advisor.membershipId, 1]);
  const [history] = await h.admin`SELECT * FROM public.order_status_history WHERE order_id=${o.id}`;
  const [audit] = await audits(f.reception);
  assert.equal(r.status, 'closed');
  assert.ok(r.closed_at);
  assert.equal(v.current_mileage_km, 1000);
  assert.deepEqual([history.from_status, history.to_status, history.request_id],
    [null, 'reception', audit.request_id]);
  assert.deepEqual(audit.metadata_json, { service_order_id: o.id, order_number: '1' });
  const again = await close(a.owner, a.tenantId, f.reception);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual(again.json, first.json);
  assert.deepEqual({ ...(await h.admin`SELECT status,closed_at,updated_at,xmin::text AS xmin
    FROM public.receptions WHERE id=${f.reception}`)[0] }, { ...r });
  assert.deepEqual({ ...(await h.admin`SELECT current_mileage_km,updated_at,xmin::text AS xmin
    FROM public.vehicles WHERE id=${f.vehicle}`)[0] }, { ...v });
  assert.equal((await orders(f.reception)).length, 1);
  assert.deepEqual({ ...(await orders(f.reception))[0] }, { ...o });
  assert.equal((await audits(f.reception)).length, 1);
  assert.equal((await h.admin`SELECT id FROM public.order_status_history WHERE order_id=${o.id}`).length, 1);
});

test('close is strictly bodyless, including empty JSON values, with no rejection side effects', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const rejected = [
    { body: {} }, { body: null }, { body: { status: 'closed' } },
    { body: { orderNumber: '1' } }, { body: [] }, { body: '' },
    { rawBody: '   ', headers: { 'content-type': 'application/json' } },
    { rawBody: '   ', headers: { 'content-type': 'text/plain' } },
  ];
  for (const extra of rejected) {
    const result = await close(a.owner, a.tenantId, f.reception, extra);
    assert.equal(result.status, 400, JSON.stringify({ extra, response: result.json }));
    const [reception] = await h.admin`SELECT status,closed_at FROM public.receptions
      WHERE id=${f.reception}`;
    assert.deepEqual([reception.status, reception.closed_at], ['open', null]);
    assert.equal((await orders(f.reception)).length, 0);
    assert.equal((await h.admin`SELECT h.id FROM public.order_status_history h
      JOIN public.service_orders o ON o.id=h.order_id WHERE o.reception_id=${f.reception}`).length, 0);
    assert.equal((await audits(f.reception)).length, 0);
  }
  const bodyless = await close(a.owner, a.tenantId, f.reception);
  assert.equal(bodyless.status, 200, JSON.stringify(bodyless.json));
});

test('late retry returns an advanced persisted order without resetting state', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const first = await close(a.owner, a.tenantId, f.reception);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const orderId = first.json.serviceOrder.id;
  await h.admin.begin(async (tx) => {
    await tx`UPDATE public.service_orders SET status='diagnosis', version=2,
      updated_at=GREATEST(now(),updated_at + interval '1 microsecond')
      WHERE id=${orderId}`;
    await tx`INSERT INTO public.order_status_history
      (id,tenant_id,order_id,from_status,to_status,changed_by_membership_id,request_id)
      VALUES (${randomUUID()},${a.tenantId},${orderId},'reception','diagnosis',
        ${a.owner.membershipId},${randomUUID()})`;
  });
  const [receptionBefore] = await h.admin`SELECT *,xmin::text AS xmin FROM public.receptions
    WHERE id=${f.reception}`;
  const [vehicleBefore] = await h.admin`SELECT *,xmin::text AS xmin FROM public.vehicles
    WHERE id=${f.vehicle}`;
  const [orderBefore] = await h.admin`SELECT *,xmin::text AS xmin FROM public.service_orders
    WHERE id=${orderId}`;
  const historiesBefore = await h.admin`SELECT * FROM public.order_status_history
    WHERE order_id=${orderId} ORDER BY changed_at,id`;
  const auditsBefore = await audits(f.reception);
  assert.equal(historiesBefore.length, 2);
  assert.equal(auditsBefore.length, 1);

  const retry = await close(a.advisor, a.tenantId, f.reception);
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.equal(retry.json.serviceOrder.id, orderId);
  assert.equal(retry.json.serviceOrder.orderNumber, first.json.serviceOrder.orderNumber);
  assert.equal(retry.json.reception.closedAt, first.json.reception.closedAt);
  assert.equal(retry.json.serviceOrder.openedAt, first.json.serviceOrder.openedAt);
  assert.equal(retry.json.serviceOrder.status, 'diagnosis');
  assert.equal(retry.json.serviceOrder.version, 2);
  assert.deepEqual({ ...(await h.admin`SELECT *,xmin::text AS xmin FROM public.receptions
    WHERE id=${f.reception}`)[0] }, { ...receptionBefore });
  assert.deepEqual({ ...(await h.admin`SELECT *,xmin::text AS xmin FROM public.vehicles
    WHERE id=${f.vehicle}`)[0] }, { ...vehicleBefore });
  assert.deepEqual({ ...(await h.admin`SELECT *,xmin::text AS xmin FROM public.service_orders
    WHERE id=${orderId}`)[0] }, { ...orderBefore });
  assert.deepEqual(Array.from(await h.admin`SELECT * FROM public.order_status_history
    WHERE order_id=${orderId} ORDER BY changed_at,id`), Array.from(historiesBefore));
  assert.deepEqual(Array.from(await audits(f.reception)), Array.from(auditsBefore));
});

test('RBAC, anti-oracle, body, missing signature, and mileage conflict', async () => {
  const { a, b } = await h.twoTenants();
  const f = await fixture(a, { signed: false });
  for (const [actor, tenant, id, extra, status, code] of [
    [a.technician, a.tenantId, f.reception, {}, 403, 'PERMISSION_DENIED'],
    [b.owner, b.tenantId, f.reception, {}, 404, 'RECEPTION_NOT_FOUND'],
    [a.owner, a.tenantId, randomUUID(), {}, 404, 'RECEPTION_NOT_FOUND'],
    ...['orderNumber', 'status', 'closedAt', 'currentMileageKm', 'serviceOrder',
      'priority', 'version', 'tenantId', 'customerId', 'vehicleId'].map((field) =>
      [a.owner, a.tenantId, f.reception, { body: { [field]: 'forged' } }, 400,
        'REQUEST_VALIDATION_FAILED']),
    [a.owner, a.tenantId, f.reception, {}, 409, 'RECEPTION_SIGNATURE_REQUIRED'],
  ]) {
    const result = await close(actor, tenant, id, extra);
    assert.deepEqual([result.status, errorCode(result)], [status, code], JSON.stringify(result.json));
  }
  assert.equal((await orders(f.reception)).length, 0);
  const g = await fixture(a, { mileage: 1000, vehicleMileage: 900 });
  // The ordinary vehicle trigger prevents this stale state. Introduce it only
  // as a corruption fixture to prove close's own post-lock revalidation.
  await h.admin`ALTER TABLE public.vehicles DISABLE TRIGGER vehicles_open_reception_mileage_trg`;
  try {
    await h.admin`UPDATE public.vehicles SET current_mileage_km=1001 WHERE id=${g.vehicle}`;
  } finally {
    await h.admin`ALTER TABLE public.vehicles ENABLE TRIGGER vehicles_open_reception_mileage_trg`;
  }
  const result = await close(a.owner, a.tenantId, g.reception);
  assert.deepEqual([result.status, errorCode(result)], [409, 'RECEPTION_MILEAGE_CONFLICT']);
  assert.equal((await orders(g.reception)).length, 0);
});

test('equal vehicle mileage avoids a vehicle UPDATE', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a, { mileage: 1000, vehicleMileage: 1000 });
  const [before] = await h.admin`SELECT current_mileage_km,updated_at,xmin::text AS xmin
    FROM public.vehicles WHERE id=${f.vehicle}`;
  assert.equal((await close(a.owner, a.tenantId, f.reception)).status, 200);
  const [after] = await h.admin`SELECT current_mileage_km,updated_at,xmin::text AS xmin
    FROM public.vehicles WHERE id=${f.vehicle}`;
  assert.deepEqual({ ...after }, { ...before });
});

test('missing signature fails before trying the vehicle lock', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a, { signed: false });
  const holder = await h.admin.reserve();
  let pending, early;
  try {
    await holder.unsafe('BEGIN');
    await holder`SELECT id FROM public.vehicles WHERE id=${f.vehicle} FOR NO KEY UPDATE`;
    pending = close(a.owner, a.tenantId, f.reception);
    early = await Promise.race([pending.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500))]);
  } finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
    await Promise.allSettled([pending].filter(Boolean));
  }
  assert.equal(early, true, 'close must not wait for vehicle when signature is absent');
  const result = await pending;
  assert.deepEqual([result.status, errorCode(result)], [409, 'RECEPTION_SIGNATURE_REQUIRED']);
});

test('corrupt closed reception without order fails closed and is not repaired', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  await h.admin`ALTER TABLE public.receptions DISABLE TRIGGER receptions_order_required_ct`;
  try {
    await h.admin`UPDATE public.receptions SET status='closed',closed_at=now()
      WHERE id=${f.reception}`;
  } finally {
    await h.admin`ALTER TABLE public.receptions ENABLE TRIGGER receptions_order_required_ct`;
  }
  const result = await close(a.owner, a.tenantId, f.reception);
  assert.equal(result.status, 500);
  assert.equal(errorCode(result), 'INTERNAL_ERROR');
  assert.equal((await orders(f.reception)).length, 0);
  assert.equal((await audits(f.reception)).length, 0);
});

test('signed media quarantine and historical consent revocation permit close', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  await h.admin`UPDATE public.media_assets SET status='quarantined'
    WHERE id=(SELECT signature_media_id FROM public.signatures WHERE reception_id=${f.reception})`;
  await h.admin`UPDATE public.privacy_consents SET status='revoked',
    revoked_at=now(),updated_at=now() WHERE id=${f.consent}`;
  assert.equal((await close(a.owner, a.tenantId, f.reception)).status, 200);
});

test('same reception overlap waits on row lock and returns the same order', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const holder = await h.admin.reserve();
  let pending;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.receptions WHERE id=${f.reception} FOR NO KEY UPDATE`;
    pending = [close(a.owner, a.tenantId, f.reception),
      close(a.advisor, a.tenantId, f.reception)];
    await blockedBy(backend.pid, 2, 'FROM public.receptions AS r');
  } finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
    await Promise.allSettled(pending ?? []);
  }
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.deepEqual(results[0].json, results[1].json);
  assert.equal((await orders(f.reception)).length, 1);
  assert.equal((await audits(f.reception)).length, 1);
});

test('number allocation uses per-tenant max and serializes different receptions', async () => {
  const { a, b } = await h.twoTenants();
  const first = await fixture(a);
  assert.equal((await close(a.owner, a.tenantId, first.reception)).json.serviceOrder.orderNumber, '1');
  await h.admin`UPDATE public.service_orders SET order_number=7 WHERE reception_id=${first.reception}`;
  const second = await fixture(a), third = await fixture(a), foreign = await fixture(b);
  const holder = await h.admin.reserve();
  let pending;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'service_order_number:' || ${a.tenantId}::text, 0))`;
    pending = [close(a.owner, a.tenantId, second.reception),
      close(a.advisor, a.tenantId, third.reception)];
    await blockedBy(backend.pid, 2, 'pg_advisory_xact_lock');
  } finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
    await Promise.allSettled(pending ?? []);
  }
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.deepEqual(results.map((r) => r.json.serviceOrder.orderNumber).sort(), ['8', '9']);
  assert.equal((await close(b.owner, b.tenantId, foreign.reception)).json.serviceOrder.orderNumber, '1');
});

test('signature and close serialize in both orders through real endpoints', async () => {
  const { a } = await h.twoTenants();
  for (const signatureFirst of [true, false]) {
    const f = await fixture(a, { signed: false });
    const media = await signatureMedia(a.tenantId);
    const holder = await h.admin.reserve();
    let first, second;
    try {
      await holder.unsafe('BEGIN');
      const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
      await holder`SELECT id FROM public.receptions WHERE id=${f.reception} FOR NO KEY UPDATE`;
      first = signatureFirst ? sign(a.owner, a.tenantId, f.reception, media)
        : close(a.owner, a.tenantId, f.reception);
      await blockedBy(backend.pid, 1, 'FROM public.receptions');
      second = signatureFirst ? close(a.advisor, a.tenantId, f.reception)
        : sign(a.advisor, a.tenantId, f.reception, media);
      await blockedBy(backend.pid, 2, 'FROM public.receptions');
    } finally {
      await holder.unsafe('ROLLBACK');
      holder.release();
      await Promise.allSettled([first, second].filter(Boolean));
    }
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual([one.status, two.status], signatureFirst ? [201, 200] : [409, 201]);
    if (!signatureFirst) {
      assert.equal(errorCode(one), 'RECEPTION_SIGNATURE_REQUIRED');
      assert.equal((await close(a.owner, a.tenantId, f.reception)).status, 200);
    }
    assert.equal((await orders(f.reception)).length, 1);
  }
});

test('PATCH and close serialize in both orders without lost updates', async () => {
  const { a } = await h.twoTenants();
  for (const patchFirst of [true, false]) {
    const f = await fixture(a);
    const [token] = await h.admin`SELECT to_char(updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value FROM public.receptions WHERE id=${f.reception}`;
    const holder = await h.admin.reserve();
    let first, second;
    try {
      await holder.unsafe('BEGIN');
      const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
      await holder`SELECT id FROM public.receptions WHERE id=${f.reception} FOR NO KEY UPDATE`;
      first = patchFirst ? patch(a.owner, a.tenantId, f.reception, token.value, 1100)
        : close(a.owner, a.tenantId, f.reception);
      await blockedBy(backend.pid, 1, 'FROM public.receptions AS r');
      second = patchFirst ? close(a.advisor, a.tenantId, f.reception)
        : patch(a.advisor, a.tenantId, f.reception, token.value, 1100);
      await blockedBy(backend.pid, 2, 'FROM public.receptions AS r');
    } finally {
      await holder.unsafe('ROLLBACK');
      holder.release();
      await Promise.allSettled([first, second].filter(Boolean));
    }
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual([one.status, two.status], patchFirst ? [200, 200] : [200, 409]);
    if (!patchFirst) assert.equal(errorCode(two), 'RECEPTION_NOT_EDITABLE');
    const [vehicle] = await h.admin`SELECT current_mileage_km FROM public.vehicles WHERE id=${f.vehicle}`;
    assert.equal(vehicle.current_mileage_km, patchFirst ? 1100 : 1000);
  }
});

test('same-vehicle CREATE sees open reception before CLOSE and can create after commit', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const holder = await h.admin.reserve();
  let creating, closing;
  try {
    await holder.unsafe('BEGIN');
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    await holder`SELECT id FROM public.vehicles WHERE id=${f.vehicle} FOR NO KEY UPDATE`;
    creating = create(a.owner, a.tenantId, f, 1000);
    await blockedBy(backend.pid, 1, 'FROM public.vehicles');
    closing = close(a.advisor, a.tenantId, f.reception);
    await blockedBy(backend.pid, 2, 'FROM public.vehicles');
  } finally {
    await holder.unsafe('ROLLBACK');
    holder.release();
    await Promise.allSettled([creating, closing].filter(Boolean));
  }
  const [created, closed] = await Promise.all([creating, closing]);
  assert.deepEqual([created.status, errorCode(created), closed.status],
    [409, 'RECEPTION_ALREADY_OPEN', 200]);
  const later = await create(a.owner, a.tenantId, f, 1000);
  assert.equal(later.status, 201, JSON.stringify(later.json));
});

for (const table of ['audit_logs', 'order_status_history']) {
  test(`${table} failure rolls back close, mileage, and order`, async () => {
    const { a } = await h.twoTenants();
    const f = await fixture(a);
    const name = `s306_fail_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await h.admin.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END $f$;
      CREATE TRIGGER ${name} BEFORE INSERT ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try {
      const result = await close(a.owner, a.tenantId, f.reception);
      assert.equal(result.status, 500);
      const [r] = await h.admin`SELECT status,closed_at FROM public.receptions WHERE id=${f.reception}`;
      const [v] = await h.admin`SELECT current_mileage_km FROM public.vehicles WHERE id=${f.vehicle}`;
      assert.deepEqual([r.status, r.closed_at, v.current_mileage_km], ['open', null, null]);
      assert.equal((await orders(f.reception)).length, 0);
      assert.equal((await audits(f.reception)).length, 0);
    } finally {
      await h.admin.unsafe(`DROP TRIGGER ${name} ON public.${table}; DROP FUNCTION public.${name}()`);
    }
  });
}

test('deferred commit failure rolls back even the success audit', async () => {
  const { a } = await h.twoTenants();
  const f = await fixture(a);
  const name = `s306_deferred_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await h.admin.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'TEST_DEFERRED_FAILURE'; END $f$;
    CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON public.service_orders
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try {
    const result = await close(a.owner, a.tenantId, f.reception);
    assert.equal(result.status, 500);
    const [r] = await h.admin`SELECT status,closed_at FROM public.receptions WHERE id=${f.reception}`;
    const [v] = await h.admin`SELECT current_mileage_km FROM public.vehicles WHERE id=${f.vehicle}`;
    assert.deepEqual([r.status, r.closed_at, v.current_mileage_km], ['open', null, null]);
    assert.equal((await orders(f.reception)).length, 0);
    assert.equal((await audits(f.reception)).length, 0);
  } finally {
    await h.admin.unsafe(`DROP TRIGGER ${name} ON public.service_orders; DROP FUNCTION public.${name}()`);
  }
});
