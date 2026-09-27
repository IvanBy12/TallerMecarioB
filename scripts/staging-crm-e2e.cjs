'use strict';

// S2-08: HTTP business actions against the deployed container. Admin SQL is
// confined to fixture setup and read-only evidence queries.
const assert = require('node:assert/strict');
const { createSign, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { readMigrationFiles } = require('drizzle-orm/migrator');

const root = join(__dirname, '..');
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const ownerFields = ['ownershipId', 'vehicleId', 'customerId', 'relationshipType',
  'isPrimary', 'validFrom', 'validTo'].sort();
const historyFields = ['ownershipId', 'customerId', 'customer', 'relationshipType',
  'isPrimary', 'validFrom', 'validTo'].sort();
function must(value, label) { if (!value) throw new Error(`STAGING_${label}_FAILED`); }

async function migrationState(admin) {
  const journal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  const files = readMigrationFiles({ migrationsFolder: join(root, 'drizzle') });
  assert.equal(journal.entries.length, 19);
  assert.equal(files.length, 19);
  assert.match(journal.entries.at(-1).tag, /^0018_/u);
  const ledger = await admin`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  assert.equal(ledger.length, 19);
  for (let i = 0; i < files.length; i += 1) {
    assert.equal(ledger[i].hash, files[i].hash, `migration ${i} SQL hash`);
    assert.equal(Number(ledger[i].created_at), files[i].folderMillis, `migration ${i} timestamp`);
    assert.equal(journal.entries[i].when, files[i].folderMillis, `migration ${i} journal`);
  }
  const [plate] = await admin`SELECT convalidated FROM pg_constraint
    WHERE conrelid='public.vehicles'::regclass AND conname='vehicles_plate_format_check'`;
  const [guard] = await admin`SELECT tgenabled FROM pg_trigger
    WHERE tgrelid='public.vehicle_owners'::regclass AND tgname='vehicle_owners_history_guard_trg'`;
  assert.equal(plate?.convalidated, true);
  assert.equal(guard?.tgenabled, 'O');
  const columns = await admin`SELECT table_name,column_name,data_type,is_nullable
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
  const constraints = await admin`SELECT conrelid::regclass::text AS relation,conname,
    pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE connamespace='public'::regnamespace ORDER BY relation,conname`;
  const triggers = await admin`SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,
    pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
    ORDER BY relation,tgname`;
  return JSON.stringify({ ledger, columns, constraints, triggers });
}

async function seedTwoTenants(admin) {
  const roleRows = await admin`SELECT id,code FROM public.roles
    WHERE code IN ('service_advisor','technician')`;
  const role = Object.fromEntries(roleRows.map((row) => [row.code, row.id]));
  must(role.service_advisor && role.technician, 'FIXTURE_ROLES');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const actor = (label) => ({ userId: randomUUID(), membershipId: randomUUID(),
    subject: `user_stage_${label}_${suffix}`,
    email: `stage-${label}-${suffix}@example.test` });
  const a = { tenantId: randomUUID(), advisor: actor('a'), technician: actor('tech') };
  const b = { tenantId: randomUUID(), advisor: actor('b') };
  await admin.begin(async (tx) => {
    // Existing hermetic fixture pattern: bypass actor triggers for admin-only
    // fixture insertion, while seeding a coherent primary location and roles.
    await tx`SET LOCAL session_replication_role = replica`;
    for (const tenant of [a, b]) {
      await tx`INSERT INTO public.workshops ${tx({ id: tenant.tenantId,
        slug: `stage-${suffix}-${tenant === a ? 'a' : 'b'}`,
        legal_name: 'Staging fixture', display_name: 'Staging fixture' })}`;
      await tx`INSERT INTO public.workshop_locations ${tx({ id: randomUUID(),
        tenant_id: tenant.tenantId, name: 'Principal', address_line: 'Fixture',
        city: 'Bogota', department: 'Bogota', is_primary: true })}`;
      for (const [kind, member] of Object.entries({ advisor: tenant.advisor,
        ...(tenant.technician ? { technician: tenant.technician } : {}) })) {
        await tx`INSERT INTO public.users ${tx({ id: member.userId, identity_provider: 'clerk',
          external_subject: member.subject, email: member.email, status: 'active' })}`;
        await tx`INSERT INTO public.memberships ${tx({ id: member.membershipId,
          tenant_id: tenant.tenantId, user_id: member.userId, status: 'active' })}`;
        await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: tenant.tenantId,
          membership_id: member.membershipId,
          role_id: role[kind === 'advisor' ? 'service_advisor' : 'technician'],
          assigned_by_membership_id: member.membershipId })}`;
      }
    }
  });
  return { a, b };
}

function sessionToken(actor, identity) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'ins_stage' });
  const claims = encode({ sub: actor.subject, iss: identity.issuer,
    azp: identity.authorizedParty, sid: `sess_${randomUUID().replaceAll('-', '')}`,
    iat: now - 5, nbf: now - 5, exp: now + 3600, v: 2 });
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`)
    .sign(identity.privateKey).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

async function readDataSnapshot(admin, vehicleId, tenantA, tenantB) {
  const ownership = await admin`SELECT id,customer_id,relationship_type,is_primary,
    pg_catalog.to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
    pg_catalog.to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to
    FROM public.vehicle_owners WHERE vehicle_id=${vehicleId} ORDER BY valid_from,id`;
  const counts = await admin`SELECT id AS tenant_id,
    (SELECT count(*)::int FROM public.customers c WHERE c.tenant_id=w.id) AS customers,
    (SELECT count(*)::int FROM public.vehicles v WHERE v.tenant_id=w.id) AS vehicles,
    (SELECT count(*)::int FROM public.audit_logs l WHERE l.tenant_id=w.id) AS audits
    FROM public.workshops w WHERE id IN (${tenantA},${tenantB}) ORDER BY id`;
  const audits = await admin`SELECT tenant_id,entity_id,action,before_json,after_json,metadata_json
    FROM public.audit_logs WHERE tenant_id IN (${tenantA},${tenantB})
    ORDER BY tenant_id,entity_id,created_at,id`;
  return JSON.stringify({ ownership, counts, audits });
}

function assertLogPrivacy(raw, sentinels, minimumCompletions, expectedErrors = []) {
  for (const value of sentinels) must(!raw.includes(value), 'LOG_PRIVATE_VALUE');
  must(!/Bearer\s|authorization|cookie|\/api\/v1\/[^"\s]*\?/iu.test(raw), 'LOG_RAW_REQUEST');
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
  const completions = lines.filter((line) => line.status_code !== undefined);
  must(completions.length >= minimumCompletions, 'LOG_COMPLETION_COUNT');
  for (const line of lines) {
    must(line.level === 30 || line.level === 50, 'LOG_LEVEL');
    if (line.status_code === undefined) {
      const fields = Object.keys(line).sort();
      if (line.diagnostic === 'request_internal_error')
        assert.deepEqual(fields, ['diagnostic', 'level', 'request_id']);
      else assert.deepEqual(fields, ['level', 'msg'], 'only a fixed startup/shutdown message is allowed');
      continue;
    }
    const keys = ['request_id', 'method', 'route', 'status_code', 'duration_ms'];
    if (line.error_code !== undefined) keys.push('error_code');
    if (line.tenant_id !== undefined) keys.push('tenant_id', 'user_id', 'membership_id');
    assert.deepEqual(Object.keys(line).filter((key) => key !== 'level').sort(), keys.sort());
    must(typeof line.request_id === 'string' && typeof line.method === 'string'
      && typeof line.route === 'string' && Number.isInteger(line.status_code)
      && Number.isFinite(line.duration_ms), 'LOG_COMPLETION_SHAPE');
    must(!/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu
      .test(line.route), 'LOG_ROUTE_TEMPLATE');
  }
  for (const expected of expectedErrors) {
    const matches = completions.filter((line) => line.request_id === expected.requestId);
    must(matches.length === 1 && matches[0].status_code === expected.status
      && matches[0].error_code === expected.code && matches[0].method === expected.method,
    'LOG_ERROR_CODE_CORRELATION');
  }
  return completions.length;
}

async function runCrmE2e(admin, baseUrl, identity, tenants, fetcher = fetch) {
  const { a, b } = tenants;
  const tokens = new Map([a.advisor, a.technician, b.advisor]
    .map((actor) => [actor, sessionToken(actor, identity)]));
  const cookieValue = 'StagePrivateCookie+S208/Probe';
  const privatePem = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sentinels = ['StagePrivateAlpha', 'StagePrivateBeta', 'StagePrivateGamma',
    'StagePrivateSurname', '3009988776', '3009988777', '3009988778',
    'stage-private@example.test', 'stage-beta@example.test', 'stage-gamma@example.test',
    'STAGEDOC987', 'ABC123', 'abc-123', 'ABC.123', 'ABC 123',
    'XYZ987', 'FOREIGN987', 'StagePrivateBrand',
    'StagePrivateModel', 'STAGEVINPRIV123', 'STAGEENGINEPRIV123',
    cookieValue, `session=${cookieValue}`, encodeURIComponent(cookieValue),
    encodeURIComponent(`session=${cookieValue}`), ...tokens.values(),
    identity.secretKey, identity.webhookSecret, privatePem,
    privatePem.split('\n')[1].slice(0, 32)];
  let requestCount = 0;
  const errors = [];
  const request = async (actor, tenantId, method, route, body, selectedTenant = tenantId) => {
    const response = await fetcher(`${baseUrl}${route}`, {
      method, signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${tokens.get(actor)}`,
        'x-tenant-id': selectedTenant, cookie: `session=${cookieValue}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requestCount += 1;
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const check = async (actor, tenantId, method, route, body, status, code, selectedTenant) => {
    const result = await request(actor, tenantId, method, route, body, selectedTenant);
    must(result.status === status, `HTTP_${method}_${status}`);
    if (code) {
      must(result.json?.error?.code === code, `ERROR_${code}`);
      must(typeof result.json.error.request_id === 'string', 'ERROR_REQUEST_ID');
      errors.push({ requestId: result.json.error.request_id, status, code, method });
    }
    return result.json;
  };
  const customerBody = (name, phone, email) => ({ firstName: name,
    lastName: 'StagePrivateSurname', phone, email,
    documentType: 'CC', documentNumber: 'STAGEDOC987' });
  const vehicleBody = (customerId, plate) => ({ customerId, plate,
    vehicleType: 'car', brand: 'StagePrivateBrand', model: 'StagePrivateModel',
    vin: 'STAGEVINPRIV123', engineNumber: 'STAGEENGINEPRIV123' });
  const c1 = (await check(a.advisor, a.tenantId, 'POST', '/api/v1/customers',
    customerBody('StagePrivateAlpha', '3009988776', 'stage-private@example.test'), 201)).customer.customerId;
  const created = await check(a.advisor, a.tenantId, 'POST', '/api/v1/vehicles',
    vehicleBody(c1, 'abc-123'), 201);
  const vehicleId = created.vehicle.vehicleId;
  const initialId = created.ownership.ownershipId;
  must(created.vehicle.plate === 'ABC123' && created.ownership.customerId === c1,
    'CANONICAL_PLATE_INITIAL_OWNER');
  const searchRoute = '/api/v1/vehicles?plate=a-b-c-123';
  sentinels.push(searchRoute, 'a-b-c-123');
  const search = await check(a.advisor, a.tenantId, 'GET', searchRoute, undefined, 200);
  must(search.vehicles.length === 1 && search.vehicles[0].vehicleId === vehicleId,
    'EXACT_PLATE_SEARCH');
  const c2 = (await check(a.advisor, a.tenantId, 'POST', '/api/v1/customers',
    customerBody('StagePrivateBeta', '3009988777', 'stage-beta@example.test'), 201)).customer.customerId;
  const ownerRoute = `/api/v1/vehicles/${vehicleId}/owners`;
  const transferBody = { customerId: c2, expectedCurrentOwnershipId: initialId };
  const changed = await check(a.advisor, a.tenantId, 'POST', ownerRoute, transferBody, 201);
  const successor = changed.ownership;
  assert.deepEqual(Object.keys(successor).sort(), ownerFields);
  must(successor.customerId === c2 && successor.validTo === null
    && successor.ownershipId !== initialId, 'OWNER_TRANSFER');
  const retry = await check(a.advisor, a.tenantId, 'POST', ownerRoute, transferBody, 200);
  assert.deepEqual(retry, changed, 'transfer retry is a no-op');
  await check(a.advisor, a.tenantId, 'POST', ownerRoute,
    { customerId: c1, expectedCurrentOwnershipId: initialId },
    409, 'VEHICLE_OWNERSHIP_CONFLICT');
  const history = (await check(a.advisor, a.tenantId, 'GET', ownerRoute, undefined, 200)).owners;
  must(history.length === 2 && history[0].ownershipId === successor.ownershipId
    && history[1].ownershipId === initialId, 'HISTORY_ORDER');
  for (const item of history) {
    assert.deepEqual(Object.keys(item).sort(), historyFields);
    assert.deepEqual(Object.keys(item.customer).sort(), ['firstName', 'lastName']);
    must(stamp.test(item.validFrom), 'HISTORY_MICROSECOND_FORMAT');
  }
  must(history[1].validTo === history[0].validFrom, 'HISTORY_CONTIGUITY');
  const [boundary] = await admin`SELECT previous.valid_to = current.valid_from AS equal,
    pg_catalog.to_char(previous.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS previous_to,
    pg_catalog.to_char(current.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS current_from
    FROM public.vehicle_owners previous JOIN public.vehicle_owners current
      ON current.id=${successor.ownershipId} WHERE previous.id=${initialId}`;
  must(boundary?.equal === true && boundary.previous_to === history[1].validTo
    && boundary.current_from === history[0].validFrom, 'POSTGRES_MICROSECOND_EQUALITY');
  must(!/300998877|stage-private@example|STAGEDOC|phone|email|document/iu
    .test(JSON.stringify(history)), 'HISTORY_PII');

  await check(a.advisor, a.tenantId, 'POST', '/api/v1/vehicles',
    vehicleBody(c1, 'ABC.123'), 409, 'VEHICLE_PLATE_ALREADY_EXISTS');
  const second = await check(a.advisor, a.tenantId, 'POST', '/api/v1/vehicles',
    vehicleBody(c1, 'XYZ987'), 201);
  await check(a.advisor, a.tenantId, 'PATCH', `/api/v1/vehicles/${second.vehicle.vehicleId}`,
    { expectedUpdatedAt: second.vehicle.updatedAt, plate: 'abc-123' },
    409, 'VEHICLE_PLATE_ALREADY_EXISTS');
  const bc = (await check(b.advisor, b.tenantId, 'POST', '/api/v1/customers',
    customerBody('StagePrivateGamma', '3009988778', 'stage-gamma@example.test'), 201)).customer.customerId;
  const bv = await check(b.advisor, b.tenantId, 'POST', '/api/v1/vehicles',
    vehicleBody(bc, 'ABC 123'), 201);
  must(bv.vehicle.plate === 'ABC123', 'CROSS_TENANT_PLATE_ALLOWED');
  const bSearch = await check(b.advisor, b.tenantId, 'GET', searchRoute, undefined, 200);
  must(bSearch.vehicles.length === 1 && bSearch.vehicles[0].vehicleId === bv.vehicle.vehicleId,
    'TENANT_B_PLATE_SEARCH');
  await check(b.advisor, b.tenantId, 'GET', `/api/v1/vehicles/${vehicleId}`,
    undefined, 404, 'VEHICLE_NOT_FOUND');
  await check(b.advisor, b.tenantId, 'GET', `/api/v1/customers/${c1}`,
    undefined, 404, 'CUSTOMER_NOT_FOUND');
  await check(b.advisor, b.tenantId, 'GET', ownerRoute,
    undefined, 404, 'VEHICLE_NOT_FOUND');
  await check(b.advisor, b.tenantId, 'POST', ownerRoute,
    { customerId: bc, expectedCurrentOwnershipId: initialId },
    404, 'VEHICLE_NOT_FOUND');
  await check(b.advisor, b.tenantId, 'POST', '/api/v1/vehicles',
    vehicleBody(c1, 'FOREIGN987'), 404, 'CUSTOMER_NOT_FOUND');
  await check(b.advisor, b.tenantId, 'GET', '/api/v1/vehicles',
    undefined, 403, 'TENANT_ACCESS_DENIED', a.tenantId);
  await check(a.technician, a.tenantId, 'GET', '/api/v1/vehicles',
    undefined, 403, 'PERMISSION_DENIED');
  await check(a.technician, a.tenantId, 'GET', ownerRoute,
    undefined, 403, 'PERMISSION_DENIED');
  await check(a.technician, a.tenantId, 'POST', ownerRoute,
    { customerId: c1, expectedCurrentOwnershipId: successor.ownershipId },
    403, 'PERMISSION_DENIED');

  const audits = await admin`SELECT tenant_id,entity_id,action,actor_user_id,
    actor_membership_id,before_json,after_json,metadata_json
    FROM public.audit_logs WHERE tenant_id IN (${a.tenantId},${b.tenantId})
    AND action IN ('customer.created','vehicle.created','vehicle.owner_changed')
    ORDER BY tenant_id,entity_id,created_at,id`;
  const actions = (tenantId, entityId) => audits.filter((row) =>
    row.tenant_id === tenantId && row.entity_id === entityId).map((row) => row.action).sort();
  assert.deepEqual(actions(a.tenantId, c1), ['customer.created']);
  assert.deepEqual(actions(a.tenantId, c2), ['customer.created']);
  assert.deepEqual(actions(b.tenantId, bc), ['customer.created']);
  assert.deepEqual(actions(a.tenantId, vehicleId),
    ['vehicle.created', 'vehicle.owner_changed', 'vehicle.owner_changed']);
  assert.deepEqual(actions(a.tenantId, second.vehicle.vehicleId),
    ['vehicle.created', 'vehicle.owner_changed']);
  assert.deepEqual(actions(b.tenantId, bv.vehicle.vehicleId),
    ['vehicle.created', 'vehicle.owner_changed']);
  must(audits.length === 10, 'AUDIT_EXACT_COUNT');
  const changes = audits.filter((row) => row.tenant_id === a.tenantId
    && row.entity_id === vehicleId && row.action === 'vehicle.owner_changed');
  assert.deepEqual(changes.map((row) => row.metadata_json?.command).sort(), ['create', 'transfer']);
  const transferAudit = changes.find((row) => row.metadata_json?.command === 'transfer');
  assert.deepEqual(transferAudit.before_json, { ownership_id: initialId, customer_id: c1 });
  assert.deepEqual(transferAudit.after_json,
    { ownership_id: successor.ownershipId, customer_id: c2 });
  for (const row of audits) {
    const actor = row.tenant_id === b.tenantId ? b.advisor : a.advisor;
    must(row.actor_user_id === actor.userId && row.actor_membership_id === actor.membershipId,
      'AUDIT_ACTOR');
  }
  must(!/StagePrivate|300998877|STAGEDOC|STAGEVIN|STAGEENGINE|ABC123/u
    .test(JSON.stringify(audits)), 'AUDIT_PII');
  const snapshot = await readDataSnapshot(admin, vehicleId, a.tenantId, b.tenantId);
  return { requestCount, sentinels, errors, ownerRoute, history, snapshot, vehicleId,
    recoveryToken: tokens.get(a.advisor) };
}

module.exports = { migrationState, seedTwoTenants, sessionToken,
  readDataSnapshot, assertLogPrivacy, runCrmE2e, must };
