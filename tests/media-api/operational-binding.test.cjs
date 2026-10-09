'use strict';
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const { Writable } = require('node:stream');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { parent } = require('./operational-helpers.cjs');
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { uploadCreateLockKey } = h.load('media/service.js');
const f = require('../media/fixtures.cjs');
const originalFetch = globalThis.fetch;
const logs = [];
let app, a, b, port;
before(async () => {
  ({ a, b } = await h.twoTenants());
  app = await buildApi({ database: h.apiPool, identityProvider: { async verifyRequest(request) {
    const subject = request.headers.authorization?.slice(7);
    return subject ? { identityProvider: 'clerk', externalSubject: subject } : null;
  } }, rateLimit: { max: 100000, timeWindow: '1 minute' },
  logStream: new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } }),
  registerRoutes(server) {
    const post = server.post;
    server.post = function (url, options, handler) {
      options.config.rateLimit = { max: 100000, timeWindow: '1 minute' };
      return post.call(this, url, options, handler);
    };
    try { registerMediaRoutes(server, f.r2); registerReceptionRoutes(server); } finally { server.post = post; }
  } });
  await app.listen({ host: '127.0.0.1', port: 0 }); port = app.server.address().port;
});
after(async () => { globalThis.fetch = originalFetch; await h.closeAll(app); });
function call(path, payload, tenant = a, actor = tenant.owner) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      ...(actor ? { authorization: `Bearer ${actor.subject}` } : {}), 'x-tenant-id': tenant.tenantId,
    } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', c => { text += c; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); });
    req.on('error', reject); req.end(body);
  });
}
const context = (p, type = 'reception') => type === 'reception' ? { type, receptionId: p.reception } : { type, damageId: p.damage };
const payload = (p, extra = {}) => ({ mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational',
  expectedSizeBytes: f.png.length, idempotencyKey: randomUUID(), operationalContext: context(p), ...extra });
const create = (body, tenant = a, actor) => call('/api/v1/media/upload-sessions', body, tenant, actor);
const complete = (s, body = {}, tenant = a, actor) => call(`/api/v1/media/upload-sessions/${s.uploadSessionId}/complete`, body, tenant, actor);
const close = p => call(`/api/v1/receptions/${p.reception}/close`);
async function session(body, tenant = a, actor) { const r = await create(body, tenant, actor); assert.equal(r.status, 201, JSON.stringify(r)); return r.body; }
function error(r, status, code) { assert.equal(r.status, status, JSON.stringify(r)); assert.equal(r.body.error.code, code); assert.equal(r.body.uploadUrl, undefined); }
const runtime = (tenant = a) => ({ tenantId: tenant.tenantId, userId: tenant.owner.user.id, membershipId: tenant.owner.membershipId });
const revoke = p => h.asRuntime(h.apiPool, runtime(), sql => sql`UPDATE privacy_consents SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=${a.tenantId} AND id=${p.consent}`);
async function snapshot(s) {
  const [row] = await h.admin`SELECT row_to_json(us) AS session,row_to_json(ma) AS asset,
    (SELECT row_to_json(b) FROM media_upload_bindings b WHERE b.tenant_id=us.tenant_id AND b.upload_session_id=us.id) AS binding,
    (SELECT count(*)::int FROM audit_logs WHERE entity_id=ma.id AND action='media.upload_completed') AS completions
    FROM upload_sessions us JOIN media_assets ma ON ma.tenant_id=us.tenant_id AND ma.id=us.media_asset_id WHERE us.id=${s.uploadSessionId}`;
  return { ...row };
}
async function counts() {
  const [row] = await h.admin`SELECT (SELECT count(*)::int FROM media_assets) AS assets,
    (SELECT count(*)::int FROM upload_sessions) AS sessions,(SELECT count(*)::int FROM media_upload_bindings) AS bindings,
    (SELECT count(*)::int FROM audit_logs WHERE action='media.upload_session_created') AS audits`;
  return { ...row };
}
async function rejected(body, code, status = 409, tenant = a) {
  const before = await counts(); error(await create(body, tenant), status, code); assert.deepEqual(await counts(), before);
}
async function until(check) { const deadline = Date.now()+5000;
  while (!await check()) { assert.ok(Date.now()<deadline, 'deterministic DB barrier reached'); await yieldTurn(); } }
async function blocked(pid, pattern) {
  await until(async () => { const [r] = await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid)) AND query LIKE ${pattern}`; return r.n>0; });
}
async function auditBarrier(action) {
  const holder = await h.admin.reserve(), key = String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15)));
  const name = 'b04_gate_'+randomUUID().replaceAll('-','').slice(0,12);
  await holder`BEGIN`; const [r] = await holder`SELECT pg_backend_pid() AS pid`;
  await holder`SELECT pg_advisory_xact_lock(${key}::bigint)`;
  await h.admin.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.action = '${action}' THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
  return { pid: r.pid, async reached() { await blocked(r.pid, '%INSERT INTO public.audit_logs%'); },
    async release() { await holder`ROLLBACK`; holder.release(); },
    async cleanup() { await h.admin.unsafe(`DROP TRIGGER ${name} ON audit_logs; DROP FUNCTION public.${name}();`); } };
}
for (const [target, type] of [['reception','photo'],['reception','video'],['reception','video360'],['damage','photo'],['damage','video'],['damage','video360']]) {
  test(`new ${target} ${type}: verified binding, PUT, safe audit and no association/retention clock`, async () => {
    const p = await parent(a), body = payload(p, { operationalContext: context(p,target), mediaType: type,
      mimeType: type === 'photo' ? 'image/png' : 'video/mp4' });
    const before = await counts(), s = await session(body), after = await counts(), row = await snapshot(s);
    assert.deepEqual(after, Object.fromEntries(Object.entries(before).map(([k,v]) => [k,v+1])));
    assert.equal(row.binding.reception_id,p.reception); assert.equal(row.binding.damage_id,target === 'damage' ? p.damage : null);
    assert.equal(row.binding.privacy_consent_id,p.consent); assert.equal(row.binding.authorized_at,row.binding.created_at);
    assert.equal(row.asset.retention_until,null); assert.equal(s.uploadHeaders['If-None-Match'],'*');
    const [audit] = await h.admin`SELECT metadata_json FROM audit_logs WHERE entity_id=${s.mediaAssetId}`;
    assert.deepEqual(audit.metadata_json,{ upload_session_id:s.uploadSessionId,context_type:target,reception_id:p.reception,
      privacy_consent_id:p.consent,...(target==='damage'?{damage_id:p.damage}:{}) });
    const [links] = await h.admin`SELECT (SELECT count(*) FROM reception_media WHERE tenant_id=${a.tenantId})+(SELECT count(*) FROM damage_media WHERE tenant_id=${a.tenantId}) AS n`;
    assert.equal(Number(links.n),0);
    for(const secret of [s.uploadUrl,s.objectKey,f.r2.bucket]) assert.equal(JSON.stringify(audit).includes(secret),false);
  });
}
for (const actor of ['owner','admin','advisor']) test(`${actor} has tenant-wide operational upload`, async () => {
  const p = await parent(a); await session(payload(p),a,a[actor]);
});
test('technician remains denied on create/replay/complete with valid known context', async () => {
  const p = await parent(a), body = payload(p), s = await session(body), before = await snapshot(s);
  error(await create(body,a,a.technician),403,'PERMISSION_DENIED');
  error(await create(payload(p),a,a.technician),403,'PERMISSION_DENIED');
  error(await complete(s,{},a,a.technician),403,'PERMISSION_DENIED'); assert.deepEqual(await snapshot(s),before);
});
for (const invalidContext of [undefined,null,{}, { type:'reception' }, { type:'damage' }, { type:'unknown',receptionId:randomUUID() },
  { type:'reception',receptionId:'bad' },{type:'reception',receptionId:randomUUID(),damageId:randomUUID()},
  ...['tenantId','customerId','privacyConsentId','orderId','purpose','authorizedAt'].map(k=>({type:'reception',receptionId:randomUUID(),[k]:randomUUID()}))]) {
  test(`strict operational context rejects ${JSON.stringify(invalidContext)}`,async()=>{
    await rejected(payload({}, { operationalContext:invalidContext }),'REQUEST_VALIDATION_FAILED',400);
  });
}
for (const type of ['signature','document','quote_pdf']) test(`${type}: context forbidden; absent context preserves behavior`,async()=>{
  const p = await parent(a), body=payload(p,{mediaType:type,retentionClass:type==='signature'?'authorization_evidence':'document',
    mimeType:type==='quote_pdf'?'application/pdf':'image/png'});
  await rejected(body,'REQUEST_VALIDATION_FAILED',400); delete body.operationalContext;
  const s=await session(body); assert.equal((await snapshot(s)).binding,null);
});
for(const target of ['reception','damage']) test(`${target}: foreign and missing IDs are indistinguishable without writes`,async()=>{
  const p=await parent(b), body=payload(p,{operationalContext:context(p,target)});
  const foreign=await create(body); const missing=await create({...body,operationalContext:context({reception:randomUUID(),damage:randomUUID()},target)});
  error(foreign,404,target==='reception'?'RECEPTION_NOT_FOUND':'DAMAGE_NOT_FOUND');
  assert.deepEqual({...foreign.body.error,request_id:null},{...missing.body.error,request_id:null});
  await rejected(body,target==='reception'?'RECEPTION_NOT_FOUND':'DAMAGE_NOT_FOUND',404);
});
for(const target of ['reception','damage']) test(`closed parent rejects new ${target} create`,async()=>{
  const p=await parent(a); assert.equal((await close(p)).status,200);
  await rejected(payload(p,{operationalContext:context(p,target)}),'RECEPTION_NOT_EDITABLE');
});
test('revoked consent rejects a different new operation regardless of capturedAt',async()=>{
  const p=await parent(a); await revoke(p);
  await rejected(payload(p,{capturedAt:'2020-01-01T00:00:00Z'}),'PRIVACY_CONSENT_NOT_ELIGIBLE');
});
for(const change of ['purpose_code','customer_id']) test(`ineligible initial consent ${change}: safe conflict and zero writes`,async()=>{
  const p=await parent(a); let value='marketing';
  if(change==='customer_id') value=(await h.seedCustomer(a.tenantId)).id;
  // Explicit corruption probe in disposable DB; evidence guard restored before HTTP.
  await h.admin.begin(async tx=>{ await tx`ALTER TABLE privacy_consents DISABLE TRIGGER privacy_consents_evidence_guard_trg`;
    await tx.unsafe(`UPDATE privacy_consents SET ${change}=$1 WHERE id=$2`,[value,p.consent]);
    await tx`ALTER TABLE privacy_consents ENABLE TRIGGER privacy_consents_evidence_guard_trg`; });
  await rejected(payload(p),'PRIVACY_CONSENT_NOT_ELIGIBLE');
});
for(const target of ['reception','damage']) test(`${target} equivalent create replay survives revocation; new key denied; close blocks replay/complete`,async()=>{
  const p=await parent(a),body=payload(p,{operationalContext:context(p,target)}),s=await session(body), before=await snapshot(s);
  await revoke(p); const r=await create(body); assert.equal(r.status,201);
  for(const k of ['uploadSessionId','mediaAssetId','objectKey','expiresAt']) assert.equal(r.body[k],s[k]);
  assert.deepEqual(await snapshot(s),before); await rejected({...body,idempotencyKey:randomUUID()},'PRIVACY_CONSENT_NOT_ELIGIBLE');
  assert.equal((await close(p)).status,200); error(await create(body),409,'RECEPTION_NOT_EDITABLE');
  let heads=0,ranges=0; globalThis.fetch=async(_u,init)=>{if(init.method==='HEAD')heads++;else ranges++;throw Error('no storage work');};
  error(await complete(s),409,'RECEPTION_NOT_EDITABLE');assert.equal(heads,0);assert.equal(ranges,0);assert.deepEqual(await snapshot(s),before);
});
for(const [from,to] of [['reception','reception'],['reception','damage'],['damage','damage'],['damage','reception']]) {
  test(`same key cannot retarget ${from} to ${to}, even to nonexistent target`,async()=>{
    const p=await parent(a),q=await parent(a),body=payload(p,{operationalContext:context(p,from)}),s=await session(body),before=await snapshot(s);
    await rejected({...body,operationalContext:context(q,to)},'IDEMPOTENCY_PAYLOAD_MISMATCH');
    await rejected({...body,operationalContext:context({reception:randomUUID(),damage:randomUUID()},to)},'IDEMPOTENCY_PAYLOAD_MISMATCH');
    assert.deepEqual(await snapshot(s),before);
  });
}
// Valid semantic differences must win over parent lifecycle, with no target lookup.
for (const target of ['reception','damage']) test(`${target}: closed replay compares all v1 semantics before lifecycle`,async()=>{
  const p=await parent(a),foreign=await parent(b),body=payload(p,{operationalContext:context(p,target),capturedAt:'2026-01-01T00:00:00Z'});
  const upload=await session(body);assert.equal((await close(p)).status,200);const before=await snapshot(upload);
  for(const change of [
    {expectedSizeBytes:body.expectedSizeBytes+1},
    {mimeType:'image/jpeg'},
    {mediaType:'video',mimeType:'video/mp4'},
    {capturedAt:'2026-01-01T00:00:01Z'},
    {capturedAt:undefined},
    {operationalContext:context(foreign,target)},
    {operationalContext:context({reception:randomUUID(),damage:randomUUID()},target)},
    {operationalContext:context(p,target==='reception'?'damage':'reception')},
  ]) await rejected({...body,...change},'IDEMPOTENCY_PAYLOAD_MISMATCH');
  // The current type matrix has exactly one retention class per operational
  // media type. Alternate retention is rejected before semantic comparison.
  await rejected({...body,retentionClass:'document'},'RETENTION_CLASS_NOT_ALLOWED',422);
  await rejected(body,'RECEPTION_NOT_EDITABLE');
  await rejected({...body,capturedAt:'2025-12-31T19:00:00-05:00'},'RECEPTION_NOT_EDITABLE');
  error(await create({...body,expectedSizeBytes:body.expectedSizeBytes+1},a,a.technician),403,'PERMISSION_DENIED');
  error(await create({...body,expectedSizeBytes:body.expectedSizeBytes+1},b),404,target==='reception'?'RECEPTION_NOT_FOUND':'DAMAGE_NOT_FOUND');
  assert.deepEqual(await snapshot(upload),before);
});
test('closed replay compares mediaType independently of MIME and retention',async()=>{
  const p=await parent(a),body=payload(p,{mediaType:'video',mimeType:'video/mp4'}),upload=await session(body);
  assert.equal((await close(p)).status,200);const before=await snapshot(upload);
  await rejected({...body,mediaType:'video360'},'IDEMPOTENCY_PAYLOAD_MISMATCH');
  await rejected(body,'RECEPTION_NOT_EDITABLE');assert.deepEqual(await snapshot(upload),before);
});
for(const status of ['completed','failed','expired']) test(`${status}: incompatible create replay precedes terminal and closed-parent disclosure`,async()=>{
  const p=await parent(a),body=payload(p),upload=await session(body);
  if(status==='expired') {
    await h.admin`UPDATE upload_sessions SET expires_at=now()-interval '1 hour' WHERE id=${upload.uploadSessionId}`;
    error(await create(body),409,'UPLOAD_SESSION_EXPIRED');
  } else {
    globalThis.fetch=f.objectFetch(status==='completed'?f.png:f.pdf,'image/png');
    const result=await complete(upload);assert.equal(result.status,status==='completed'?200:422,JSON.stringify(result));
  }
  const before=await snapshot(upload);assert.equal(before.session.status,status);
  await rejected({...body,expectedSizeBytes:body.expectedSizeBytes+1},'IDEMPOTENCY_PAYLOAD_MISMATCH');
  await rejected(body,{completed:'UPLOAD_SESSION_ALREADY_COMPLETED',failed:'UPLOAD_SESSION_FAILED',expired:'UPLOAD_SESSION_EXPIRED'}[status]);
  assert.equal((await close(p)).status,200);
  await rejected({...body,mimeType:'image/jpeg'},'IDEMPOTENCY_PAYLOAD_MISMATCH');
  await rejected(body,'RECEPTION_NOT_EDITABLE');assert.deepEqual(await snapshot(upload),before);
});
async function createRace(body,bodies){const holder=await h.admin.reserve();let pending;
  try{await holder`BEGIN`;await holder`SELECT pg_advisory_xact_lock(${uploadCreateLockKey(a.tenantId,body.idempotencyKey)}::bigint)`;
    pending=Promise.all(bodies.map(createBody=>create(createBody)));
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;return r.n===bodies.length;});
  }finally{await holder`ROLLBACK`;holder.release();}return pending;}
test('six concurrent equivalent contexts create exactly one operation and audit',async()=>{
  const p=await parent(a),body=payload(p),before=await counts();
  const rs=await createRace(body,Array.from({length:6},()=>body));assert.ok(rs.every(r=>r.status===201),JSON.stringify(rs));
  assert.ok(rs.every(r=>r.body.uploadSessionId===rs[0].body.uploadSessionId));
  assert.deepEqual(await counts(),Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v+1])));
});
test('incompatible concurrent contexts: one winner, one mismatch, no orphan',async()=>{
  const p=await parent(a),q=await parent(a),body=payload(p),before=await counts();
  const rs=await createRace(body,[body,{...body,operationalContext:context(q,'damage')}]);
  assert.deepEqual(rs.map(r=>r.status).sort(),[201,409]);error(rs.find(r=>r.status===409),409,'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.deepEqual(await counts(),Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v+1])));
});
for(const target of ['reception','damage']) test(`${target} completion after revocation succeeds, checksum replay stays B03`,async()=>{
  const p=await parent(a),s=await session(payload(p,{operationalContext:context(p,target)}));await revoke(p);
  globalThis.fetch=f.objectFetch(f.png,'image/png'); const r=await complete(s,{checksumSha256:'A'.repeat(64)});assert.equal(r.status,200,JSON.stringify(r));
  const before=await snapshot(s);assert.equal(before.completions,1);assert.equal(before.asset.retention_until,null);
  globalThis.fetch=()=>{throw Error('replay must not inspect');};assert.deepEqual((await complete(s,{checksumSha256:'a'.repeat(64)})).body,r.body);
  error(await complete(s),409,'IDEMPOTENCY_PAYLOAD_MISMATCH');assert.deepEqual(await snapshot(s),before);
});
test('bound equivalent concurrent completions retain exactly one audit',async()=>{
  const p=await parent(a),s=await session(payload(p));let seen=0,release;
  const barrier=new Promise(r=>{release=r;}), transport=f.objectFetch(f.png,'image/png');
  globalThis.fetch=async(u,init)=>{if(init.method==='HEAD'){seen++;await barrier;}return transport(u,init);};
  const pending=Promise.all([complete(s),complete(s),complete(s)]);
  try{await until(async()=>seen===3);}finally{release();}
  const rs=await pending;assert.ok(rs.every(r=>r.status===200),JSON.stringify(rs));assert.equal((await snapshot(s)).completions,1);
});
test('closure during storage inspection is caught in Phase C with no parent/media locks during R2',async()=>{
  const p=await parent(a),s=await session(payload(p)),before=await snapshot(s),transport=f.objectFetch(f.png,'image/png');let closed=false;
  globalThis.fetch=async(u,init)=>{
    const [r]=await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND usename<>current_user AND state='idle in transaction'`;assert.equal(r.n,0);
    await h.admin.begin(async tx=>{await tx`SELECT id FROM receptions WHERE id=${p.reception} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM upload_sessions WHERE id=${s.uploadSessionId} FOR UPDATE NOWAIT`;
      await tx`SELECT id FROM media_assets WHERE id=${s.mediaAssetId} FOR UPDATE NOWAIT`;});
    if(!closed){closed=true;assert.equal((await close(p)).status,200);}return transport(u,init);
  };
  error(await complete(s),409,'RECEPTION_NOT_EDITABLE');assert.deepEqual(await snapshot(s),before);
});
test('revocation during R2 inspection preserves initial authorization',async()=>{
  const p=await parent(a),s=await session(payload(p)),transport=f.objectFetch(f.png,'image/png');let revoked=false;
  globalThis.fetch=async(u,init)=>{if(!revoked){revoked=true;await revoke(p);}return transport(u,init);};
  assert.equal((await complete(s)).status,200);assert.equal((await snapshot(s)).completions,1);
});
for(const corruption of ['missing','future-clock','invalid-lineage-evidence','foreign-binding','removed-damage']) {
  test(`completion fails closed before R2: ${corruption}`,async()=>{
    const p=await parent(a),s=await session(payload(p,{operationalContext:context(p,'damage')}));
    if(corruption==='missing'||corruption==='removed-damage')await h.admin`DELETE FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    if(corruption==='removed-damage')await h.admin`DELETE FROM vehicle_damages WHERE id=${p.damage}`;
    if(corruption==='future-clock')await h.admin`UPDATE media_upload_bindings SET authorized_at=now()+interval '1 day',created_at=now()+interval '1 day' WHERE upload_session_id=${s.uploadSessionId}`;
    if(corruption==='invalid-lineage-evidence'){const q=await parent(a);await h.admin`UPDATE media_upload_bindings SET reception_id=${q.reception},privacy_consent_id=${q.consent},damage_id=NULL WHERE upload_session_id=${s.uploadSessionId}`;
      // Valid relational retargeting by a privileged operator is not detectable without
      // the original request in Phase A; corrupt consent purpose to model invalid evidence.
      await h.admin.begin(async tx=>{await tx`ALTER TABLE privacy_consents DISABLE TRIGGER privacy_consents_evidence_guard_trg`;
        await tx`UPDATE privacy_consents SET purpose_code='marketing' WHERE id=${q.consent}`;
        await tx`ALTER TABLE privacy_consents ENABLE TRIGGER privacy_consents_evidence_guard_trg`;});}
    if(corruption==='foreign-binding'){error(await complete(s,{},b),404,'UPLOAD_SESSION_NOT_FOUND');return;}
    const before=await snapshot(s);let calls=0;globalThis.fetch=()=>{calls++;throw Error('no storage');};
    error(await complete(s),409,'MEDIA_ASSOCIATION_CONFLICT');assert.equal(calls,0);assert.deepEqual(await snapshot(s),before);
  });
}
test('damage/reception/session FKs prohibit deletion, inconsistent lineage and cross-tenant binding',async()=>{
  const p=await parent(a),q=await parent(a),s=await session(payload(p,{operationalContext:context(p,'damage')}));
  await assert.rejects(h.admin`DELETE FROM vehicle_damages WHERE id=${p.damage}`,e=>e.code==='23503');
  await assert.rejects(h.admin`UPDATE media_upload_bindings SET reception_id=${q.reception},privacy_consent_id=${q.consent} WHERE upload_session_id=${s.uploadSessionId}`,e=>e.code==='23503');
  await assert.rejects(h.admin`UPDATE media_upload_bindings SET tenant_id=${b.tenantId} WHERE upload_session_id=${s.uploadSessionId}`,e=>e.code==='23503');
});
// Only fixture prerequisites are seeded as admin. Every binding statement
// below runs through the NOBYPASSRLS login with current_role=tallermecario_api.
async function directSession(tenant=a,type='photo') {
  const uploadSessionId=randomUUID(),mediaAssetId=randomUUID();
  await h.admin.begin(async sql=>{
    await sql`INSERT INTO media_assets(id,tenant_id,bucket,object_key,media_type,mime_type,status,retention_class,retention_policy_version)
      VALUES(${mediaAssetId},${tenant.tenantId},'test',${mediaAssetId},${type},${type.startsWith('video')?'video/mp4':'image/png'},
        'pending_upload',${type==='signature'?'authorization_evidence':type==='document'?'document':'operational'},'v1')`;
    await sql`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,status,expires_at,expected_size_bytes,integrity_version)
      VALUES(${uploadSessionId},${tenant.tenantId},${mediaAssetId},${randomUUID()},'pending',now()+interval '1 hour',${f.png.length},'v1')`;
  });
  return {uploadSessionId,mediaAssetId};
}
async function directBinding(s,p,{tenantId=a.tenantId,receptionId=p.reception,damageId=null,consentId=p.consent,
  authorizedAt='2000-01-01T00:00:00Z',createdAt='2099-01-01T00:00:00Z'}={}) {
  return h.asRuntime(h.apiPool,runtime(),async sql=>{
    const [role]=await sql`SELECT current_role AS role`;assert.equal(role.role,'tallermecario_api');
    await sql`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,damage_id,privacy_consent_id,authorized_at,created_at)
      VALUES(${tenantId},${s.uploadSessionId},${receptionId},${damageId},${consentId},${authorizedAt}::timestamptz,${createdAt}::timestamptz)`;
  });
}
async function directState(sessions) {
  const rows=await Promise.all(sessions.map(snapshot));
  const [audit]=await h.admin`SELECT count(*)::int AS n FROM audit_logs`;
  return {rows,audits:audit.n};
}
for(const invalid of ['forged-tenant','foreign-session','foreign-reception','foreign-consent','signature','document',
  'wrong-damage-parent','revoked-consent','closed-reception']) test(`API-role direct INSERT rejects ${invalid} without side effects`,async()=>{
  const p=await parent(a),q=await parent(a),foreign=await parent(b);
  const type=['signature','document'].includes(invalid)?invalid:'photo';
  const own=await directSession(a,type),other=await directSession(b),options={};let upload=own;
  if(invalid==='forged-tenant')options.tenantId=b.tenantId;
  if(invalid==='foreign-session')upload=other;
  if(invalid==='foreign-reception')options.receptionId=foreign.reception;
  if(invalid==='foreign-consent')options.consentId=foreign.consent;
  if(invalid==='wrong-damage-parent')options.damageId=q.damage;
  if(invalid==='revoked-consent')await revoke(p);
  if(invalid==='closed-reception')assert.equal((await close(p)).status,200);
  const before=await directState([own,other]);
  const failure=['signature','document','foreign-session'].includes(invalid)?'invalid operational session':
    invalid==='wrong-damage-parent'?'invalid damage lineage':invalid==='revoked-consent'?'invalid initial consent authorization':'invalid operational parent';
  await assert.rejects(directBinding(upload,p,options),e=>{
    assert.equal(e.code,'23514');assert.equal(e.constraint_name,'media_upload_bindings_initial_authorization_guard');
    assert.equal(e.message,failure);return true;
  });
  assert.deepEqual(await directState([own,other]),before);
  for(const upload of [own,other])assert.equal((await snapshot(upload)).binding,null,'no binding inserted');
});
for(const [target,type] of [['reception','photo'],['reception','video360'],['damage','photo'],['damage','video'],['damage','video360']]) {
  test(`API-role direct valid ${target} ${type} INSERT owns timestamps and prevents retarget/mutation`,async()=>{
    const p=await parent(a),q=await parent(a),upload=await directSession(a,type),before=await directState([upload]);
    const [start]=await h.admin`SELECT clock_timestamp() AS time`;
    await directBinding(upload,p,{damageId:target==='damage'?p.damage:null});
    const [end]=await h.admin`SELECT clock_timestamp() AS time`,row=await snapshot(upload);
    assert.equal(row.binding.reception_id,p.reception);assert.equal(row.binding.privacy_consent_id,p.consent);
    assert.equal(row.binding.damage_id,target==='damage'?p.damage:null);assert.equal(row.binding.authorized_at,row.binding.created_at);
    const time=new Date(row.binding.authorized_at);assert.ok(time>=start.time&&time<=end.time,'server clock replaces both forged timestamps');
    const after=await directState([upload]);assert.deepEqual(after.rows[0].session,before.rows[0].session);
    assert.deepEqual(after.rows[0].asset,before.rows[0].asset);assert.equal(after.audits,before.audits);
    await h.asRuntime(h.apiPool,runtime(b),async sql=>{
      assert.equal((await sql`SELECT * FROM media_upload_bindings WHERE upload_session_id=${upload.uploadSessionId}`).length,0);
    });
    for(const statement of ['UPDATE media_upload_bindings SET authorized_at=now()','DELETE FROM media_upload_bindings','TRUNCATE media_upload_bindings']) {
      await assert.rejects(h.asRuntime(h.apiPool,runtime(),async sql=>{
        const [role]=await sql`SELECT current_role AS role`;assert.equal(role.role,'tallermecario_api');return sql.unsafe(statement);
      }),e=>e.code==='42501');
      assert.deepEqual(await directState([upload]),after);
    }
    await assert.rejects(directBinding(upload,q,{damageId:target==='damage'?q.damage:null}),e=>{
      assert.equal(e.code,'23505');assert.equal(e.constraint_name,'media_upload_bindings_pk');return true;
    });
    assert.deepEqual(await directState([upload]),after,'second valid INSERT cannot retarget or create audit');
  });
}
test('runtime API role has no superuser or RLS bypass',async()=>{
  const [role]=await h.admin`SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='tallermecario_api'`;
  assert.equal(role.rolbypassrls||role.rolsuper,false);
});
test('creation binding/audit failures roll back all three rows and allow clean retry',async()=>{
  for(const table of ['media_upload_bindings','audit_logs']){const p=await parent(a),body=payload(p),before=await counts();
    const remove=await h.injectFailure(table,table==='audit_logs'?"NEW.action='media.upload_session_created'":'true');
    try{await rejected(body,'INTERNAL_ERROR',500);}finally{await remove();}
    const s=await session(body);assert.ok((await snapshot(s)).binding);assert.deepEqual(await counts(),Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v+1])));
  }
});
test('revocation wins while create waits on consent: zero media writes',async()=>{
  const p=await parent(a),body=payload(p),before=await counts(),holder=await h.apiPool.reserve();let pending;
  try{await holder`BEGIN`;await holder`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
    await holder`UPDATE privacy_consents SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${a.tenantId} AND id=${p.consent}`;
    const [r]=await holder`SELECT pg_backend_pid() AS pid`;pending=create(body);await blocked(r.pid,'%FROM public.privacy_consents%FOR SHARE%');
    await holder`COMMIT`;
  }finally{await holder`ROLLBACK`;holder.release();}
  error(await pending,409,'PRIVACY_CONSENT_NOT_ELIGIBLE');assert.deepEqual(await counts(),before);
});
test('create authorization wins; runtime revoke waits for commit; replay remains valid',async()=>{
  const p=await parent(a),body=payload(p),gate=await auditBarrier('media.upload_session_created');let pending,revoking;
  try{pending=create(body);await gate.reached();revoking=revoke(p);
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%UPDATE privacy_consents SET status=%'`;return r.n>0;});
  }finally{await gate.release();}
  try{const r=await pending;assert.equal(r.status,201,JSON.stringify(r));await revoking;
    const replay=await create(body);assert.equal(replay.status,201);assert.equal(replay.body.uploadSessionId,r.body.uploadSessionId);
    await rejected({...body,idempotencyKey:randomUUID()},'PRIVACY_CONSENT_NOT_ELIGIBLE');
  }finally{await gate.cleanup();}
});
test('close wins; create waits on parent then rejects without operation',async()=>{
  const p=await parent(a),body=payload(p),before=await counts(),gate=await auditBarrier('reception.closed');let closing,pending;
  try{closing=close(p);await gate.reached();pending=create(body);
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%FROM public.receptions WHERE tenant_id=%FOR NO KEY UPDATE%'`;return r.n>0;});
  }finally{await gate.release();}
  try{assert.equal((await closing).status,200);error(await pending,409,'RECEPTION_NOT_EDITABLE');assert.deepEqual(await counts(),before);}finally{await gate.cleanup();}
});
test('create wins; close waits on parent; later completion detects lifecycle before storage',async()=>{
  const p=await parent(a),body=payload(p),gate=await auditBarrier('media.upload_session_created');let pending,closing;
  try{pending=create(body);await gate.reached();closing=close(p);
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query LIKE '%FOR NO KEY UPDATE OF r%'`;return r.n>0;});
  }finally{await gate.release();}
  try{const r=await pending;assert.equal(r.status,201);assert.equal((await closing).status,200);
    let calls=0;globalThis.fetch=()=>{calls++;throw Error('closed parent');};error(await complete(r.body),409,'RECEPTION_NOT_EDITABLE');assert.equal(calls,0);
  }finally{await gate.cleanup();}
});
test('logs do not contain capability, storage identity or privacy evidence',async()=>{
  const p=await parent(a),s=await session(payload(p));const text=logs.join('');
  for(const secret of [s.uploadUrl,s.objectKey,f.r2.bucket,'test-service-1','TEST-ONLY'])assert.equal(text.includes(secret),false);
});

test('Phase C rejects a privileged valid binding retarget during inspection',async()=>{
  const p=await parent(a),q=await parent(a),s=await session(payload(p)),transport=f.objectFetch(f.png,'image/png');
  let changed=false;
  globalThis.fetch=async(u,init)=>{if(!changed){changed=true;await h.admin`UPDATE media_upload_bindings
    SET reception_id=${q.reception},privacy_consent_id=${q.consent} WHERE upload_session_id=${s.uploadSessionId}`;}return transport(u,init);};
  error(await complete(s),409,'MEDIA_ASSOCIATION_CONFLICT');
  const row=await snapshot(s);assert.equal(row.session.status,'pending');assert.equal(row.asset.status,'pending_upload');assert.equal(row.completions,0);
});
for (const k of ['tenantId','customerId','privacyConsentId','orderId','purpose','authorizedAt']) {
  test(`server authority cannot be supplied at body root: ${k}`,async()=>{
    const p=await parent(a);await rejected(payload(p,{[k]:randomUUID()}),'REQUEST_VALIDATION_FAILED',400);
  });
}
test('context UUID spelling canonicalizes without retargeting',async()=>{
  for(const target of ['reception','damage']){const p=await parent(a),body=payload(p,{operationalContext:context(p,target)}),s=await session(body);
    const upper=context({reception:p.reception.toUpperCase(),damage:p.damage.toUpperCase()},target);
    const r=await create({...body,operationalContext:upper});assert.equal(r.status,201);assert.equal(r.body.uploadSessionId,s.uploadSessionId);}
});
