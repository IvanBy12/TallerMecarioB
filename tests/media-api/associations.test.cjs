'use strict';
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const { Writable } = require('node:stream');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { parent } = require('./operational-helpers.cjs');
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const retention = h.load('media/retention.js');
const associations = h.load('media/associations.js');
const f = require('../media/fixtures.cjs');
const originalFetch = globalThis.fetch;
let app, a, b, port, storageCalls = 0, verifications = 0;
before(async () => {
  ({ a, b } = await h.twoTenants());
  app = await buildApi({ database: h.apiPool, identityProvider: { async verifyRequest(request) {
    verifications++;
    const subject = request.headers.authorization?.slice(7);
    return subject ? { identityProvider:'clerk',externalSubject:subject } : null;
  } }, rateLimit:{max:100000,timeWindow:'1 minute'}, logStream:new Writable({write(_chunk,_encoding,done){done();}}), registerRoutes(server) {
    const post=server.post;
    server.post=function(url,options,handler) { options.config.rateLimit={max:100000,timeWindow:'1 minute'};return post.call(this,url,options,handler); };
    try { registerMediaRoutes(server,f.r2);registerReceptionRoutes(server); } finally { server.post=post; }
  } });
  await app.listen({host:'127.0.0.1',port:0});port=app.server.address().port;
});
after(async()=>{globalThis.fetch=originalFetch;await h.closeAll(app);});
const runtime=(t=a)=>({tenantId:t.tenantId,userId:t.owner.user.id,membershipId:t.owner.membershipId});
const run=(fn,t=a)=>h.asRuntime(h.apiPool,runtime(t),fn);
function call(path,payload,method='POST',tenant=a,actor=tenant.owner) {
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?undefined:JSON.stringify(payload);
    const req=http.request({host:'127.0.0.1',port,path,method,agent:false,headers:{
      ...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)}),
      ...(actor?{authorization:`Bearer ${actor.subject}`} : {}),'x-tenant-id':tenant.tenantId,
    }},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>{text+=c;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});
    req.on('error',reject);req.end(body);
  });
}
const path=(p,type='reception')=>`/api/v1/receptions/${p.reception}${type==='damage'?'/damages/'+p.damage:''}/media`;
const attach=(p,s,type='reception',sortOrder=0,t=a,actor=t.owner)=>call(path(p,type),{mediaAssetId:s.mediaAssetId,sortOrder},'POST',t,actor);
const list=(p,type='reception',t=a,actor=t.owner)=>call(path(p,type),undefined,'GET',t,actor);
const close=p=>call(`/api/v1/receptions/${p.reception}/close`);
function error(r,status,code){assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.body.error.code,code);}
async function upload(p,type='reception',mediaType='photo',tenant=a,complete=true) {
  const bytes=mediaType==='photo'?f.png:readFileSync(join(__dirname,'../media/fixtures/clip.mp4'));
  const mime=mediaType==='photo'?'image/png':'video/mp4';
  const r=await call('/api/v1/media/upload-sessions',{mediaType,mimeType:mime,retentionClass:'operational',
    idempotencyKey:randomUUID(),expectedSizeBytes:bytes.length,operationalContext:type==='reception'
      ?{type,receptionId:p.reception}:{type,damageId:p.damage}},'POST',tenant);
  assert.equal(r.status,201,JSON.stringify(r.body));
  if(complete) {
    const objectFetch=f.objectFetch(bytes,mime);
    globalThis.fetch=async(...args)=>{storageCalls++;return objectFetch(...args);};
    const done=await call(`/api/v1/media/upload-sessions/${r.body.uploadSessionId}/complete`,{},'POST',tenant);
    assert.equal(done.status,200,JSON.stringify(done.body));
  }
  return r.body;
}
async function state(s) {
  const [row]=await h.admin`SELECT row_to_json(m)::text asset,to_char(m.retention_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') retention_until,
    (SELECT count(*)::int FROM reception_media WHERE media_asset_id=m.id) receptions,
    (SELECT count(*)::int FROM damage_media WHERE media_asset_id=m.id) damages,
    (SELECT count(*)::int FROM media_upload_bindings b JOIN upload_sessions us ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id WHERE us.media_asset_id=m.id) bindings,
    (SELECT count(*)::int FROM audit_logs WHERE entity_id=m.id AND action='media.associated') audits,
    (SELECT count(*)::int FROM audit_logs WHERE entity_id=m.id AND action='media.retention_updated') retention_audits
    FROM media_assets m WHERE id=${s.mediaAssetId}`;
  return {...row};
}
const decision=s=>run(sql=>retention.evaluateMediaRetention(sql,a.tenantId,s.mediaAssetId));
async function direct(p,s,type='reception',purpose=type==='reception'?'intake_evidence':'damage_evidence',sort=0,t=a) {
  return run(sql=>type==='reception'?sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose,sort_order)
    VALUES(${t.tenantId},${p.reception},${s.mediaAssetId},${purpose},${sort})`
    :sql`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose,sort_order)
    VALUES(${t.tenantId},${p.damage},${s.mediaAssetId},${purpose},${sort})`,t);
}
for(const type of ['reception','damage']) for(const mediaType of ['photo','video','video360']) test(`${type} ${mediaType}: end-to-end completion, canonical purpose, safe list and binding release`,async()=>{
  const p=await parent(a),s=await upload(p,type,mediaType),before=await decision(s),calls=storageCalls;
  assert.ok(before.blockers.includes('UNRESOLVED_PROTECTION'));
  const r=await attach(p,s,type);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'no-store');
  assert.deepEqual(Object.keys(r.body.media).sort(),['mediaAssetId','mediaType','mimeType','sizeBytes','capturedAt','uploadedAt','purpose','sortOrder'].sort());
  assert.equal(r.body.media.purpose,type==='reception'?'intake_evidence':'damage_evidence');assert.equal(r.body.media.mediaType,mediaType);
  assert.deepEqual((await list(p,type)).body.media,[r.body.media]);
  const d=await decision(s);assert.deepEqual(d.blockers,['CLOCK_NOT_STARTED']);assert.equal(d.sources.some(x=>x.kind==='upload_binding'),false);
  const snapshot=await state(s);assert.equal(snapshot.bindings,1);assert.equal(snapshot.audits,1);assert.equal(snapshot.retention_until,null);
  const [audit]=await h.admin`SELECT metadata_json FROM audit_logs WHERE entity_id=${s.mediaAssetId} AND action='media.associated'`;
  assert.deepEqual(audit.metadata_json,{target_type:type,target_id:type==='reception'?p.reception:p.damage,purpose:r.body.media.purpose,sort_order:0});
  for(const secret of [s.objectKey,s.uploadUrl,f.r2.bucket])assert.equal(JSON.stringify([r.body,audit]).includes(secret),false);
  assert.equal(storageCalls,calls,'attach/list never call storage');
  assert.equal((await call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,'GET')).status,200);
});
for(const type of ['reception','damage']) test(`${type}: same-sort replay has one link/audit; different-sort is conflict`,async()=>{
  const p=await parent(a),s=await upload(p,type),r=await attach(p,s,type,2147483647);assert.equal(r.status,201);
  const before=await state(s);assert.deepEqual((await attach(p,s,type,2147483647)).body,r.body);assert.deepEqual(await state(s),before);
  error(await attach(p,s,type,0),409,'MEDIA_ASSOCIATION_CONFLICT');assert.deepEqual(await state(s),before);
});
for(const type of ['reception','damage']) test(`${type}: stable tie order, default sort and closed historical list`,async()=>{
  const p=await parent(a),ss=[];
  for(let i=0;i<4;i++)ss.push(await upload(p,type));
  // Insert in reverse ID/creation order: ties must not follow association time.
  for(const i of [3,2,1,0]){const r=await call(path(p,type),{mediaAssetId:ss[i].mediaAssetId,...(i===0?{}:{sortOrder:i===3?1:0})});assert.equal(r.status,201);}
  const expected=ss.slice(0,3).map(s=>s.mediaAssetId).sort().concat(ss[3].mediaAssetId);
  assert.deepEqual((await list(p,type)).body.media.map(m=>m.mediaAssetId),expected);
  assert.equal((await close(p)).status,200);assert.deepEqual((await list(p,type)).body.media.map(m=>m.mediaAssetId),expected);
  const before=await state(ss[0]);error(await attach(p,ss[0],type),409,'RECEPTION_NOT_EDITABLE');assert.deepEqual(await state(ss[0]),before);
});
for(const type of ['reception','damage']) for(const invalid of [{purpose:'other'},{purpose:'intake_evidence'},{tenantId:randomUUID()},
  {privacyConsentId:randomUUID()},{uploadSessionId:randomUUID()},{retentionUntil:'2040-01-01'},{capturedAt:'2020-01-01'},
  {sortOrder:-1},{sortOrder:2147483648},{sortOrder:0.5},{sortOrder:'0'},{sortOrder:null},{mediaAssetId:'bad'}])
  test(`${type} strict body rejects ${JSON.stringify(invalid)}`,async()=>{
    error(await call(path({reception:randomUUID(),damage:randomUUID()},type),{mediaAssetId:randomUUID(),...invalid}),400,'REQUEST_VALIDATION_FAILED');
  });
for(const actor of ['owner','admin','advisor']) test(`${actor} can attach/read reception and damage`,async()=>{
  const p=await parent(a);
  for(const type of ['reception','damage']){const s=await upload(p,type);assert.equal((await attach(p,s,type,0,a,a[actor])).status,201);assert.equal((await list(p,type,a,a[actor])).status,200);}
});
for(const type of ['reception','damage']) test(`${type}: technician fails closed before malformed body/target lookup`,async()=>{
  const p=await parent(a),s=await upload(p,type),before=await state(s);
  error(await attach(p,s,type,0,a,a.technician),403,'PERMISSION_DENIED');error(await list(p,type,a,a.technician),403,'PERMISSION_DENIED');
  error(await call(path(p,type),{purpose:'other'},'POST',a,a.technician),403,'PERMISSION_DENIED');assert.deepEqual(await state(s),before);
});
for(const type of ['reception','damage']) test(`${type}: cross-tenant assets/targets/list and missing IDs have no writes/foreign audit`,async()=>{
  const own=await parent(a),foreign=await parent(b),s=await upload(own,type),other=await upload(foreign,type,'photo',b);
  const before=await state(s),otherBefore=await state(other),code=type==='reception'?'RECEPTION_NOT_FOUND':'DAMAGE_NOT_FOUND';
  error(await attach(own,other,type),404,'MEDIA_ASSET_NOT_FOUND');error(await attach(foreign,s,type),404,code);error(await list(foreign,type),404,code);
  const missing={reception:randomUUID(),damage:randomUUID()};const r=await list(missing,type),f=await list(foreign,type);
  assert.deepEqual({...r.body.error,request_id:null},{...f.body.error,request_id:null});
  assert.deepEqual(await state(s),before);assert.deepEqual(await state(other),otherBefore);
});
for(const [from,to] of [['reception','reception'],['reception','damage'],['damage','reception'],['damage','damage']])
  test(`binding ${from} cannot retarget ${to}`,async()=>{
    const p=await parent(a),q=await parent(a),s=await upload(p,from),before=await state(s);
    error(await attach(from===to?q:p,s,to),409,'MEDIA_ASSOCIATION_CONTEXT_MISMATCH');assert.deepEqual(await state(s),before);
  });
test('nested damage route must match actual reception',async()=>{
  const p=await parent(a),q=await parent(a),s=await upload(p,'damage'),before=await state(s);
  error(await attach({...p,reception:q.reception},s,'damage'),404,'DAMAGE_NOT_FOUND');error(await list({...p,reception:q.reception},'damage'),404,'DAMAGE_NOT_FOUND');assert.deepEqual(await state(s),before);
});
test('later consent revocation preserves historical attach evidence',async()=>{
  const p=await parent(a),s=await upload(p);
  await run(sql=>sql`UPDATE privacy_consents SET status='revoked',revoked_at=now(),updated_at=now() WHERE tenant_id=${a.tenantId} AND id=${p.consent}`);
  assert.equal((await attach(p,s)).status,201);assert.deepEqual((await decision(s)).blockers,['CLOCK_NOT_STARTED']);
});
for(const type of ['reception','damage']) for(const mediaType of ['photo','video','video360']) test(`SQL ${type}+${mediaType} valid INSERT`,async()=>{
  const p=await parent(a),s=await upload(p,type,mediaType);await direct(p,s,type);assert.equal((await list(p,type)).body.media[0].mediaAssetId,s.mediaAssetId);
});
for(const type of ['reception','damage']) for(const invalid of ['purpose','negative-sort','closed','pending_upload','uploaded','quarantined','deleted',
  'retention','signature','document','quote_pdf','mismatch','pending','failed','expired','deletion_requested_at','deleted_at','purged_at','foreign-target'])
  test(`SQL ${type}: rejects ${invalid} without mutation`,async()=>{
    const p=await parent(a),q=await parent(a),s=await upload(p,type),t=type==='reception'?'reception_media':'damage_media';
    let purpose=type==='reception'?'intake_evidence':'damage_evidence',sort=0,target=p;
    if(invalid==='purpose')purpose='other';if(invalid==='negative-sort')sort=-1;
    if(invalid==='closed')assert.equal((await close(p)).status,200);
    if(['pending_upload','uploaded','quarantined','deleted'].includes(invalid))await fixtureStatus(s,invalid);
    if(invalid==='retention')await h.admin`UPDATE media_assets SET retention_class='document' WHERE id=${s.mediaAssetId}`;
    if(['signature','document','quote_pdf'].includes(invalid))await h.admin`UPDATE media_assets SET media_type=${invalid} WHERE id=${s.mediaAssetId}`;
    if(invalid==='mismatch')target=q;if(invalid==='foreign-target')target=await parent(b);
    if(['pending','failed','expired'].includes(invalid))await h.admin`UPDATE upload_sessions SET status=${invalid} WHERE id=${s.uploadSessionId}`;
    if(['deletion_requested_at','deleted_at','purged_at'].includes(invalid))await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx.unsafe(`UPDATE media_assets SET ${invalid}=now()${invalid==='purged_at'?',deleted_at=now()':''} WHERE id=$1`,[s.mediaAssetId]);});
    const before=await state(s);await assert.rejects(direct(target,s,type,purpose,sort),e=>{assert.equal(e.code,'23514');assert.equal(e.constraint_name,invalid==='purpose'?(type==='reception'?'reception_media_purpose_check':'damage_media_purpose_check'):invalid==='negative-sort'?'media_association_sort_order_guard':['closed','foreign-target'].includes(invalid)?'media_association_parent_guard':['mismatch','pending','failed','expired'].includes(invalid)?'media_association_context_guard':'media_association_asset_guard');return true;});assert.deepEqual(await state(s),before);
    assert.equal((await h.admin.unsafe(`SELECT count(*)::int n FROM ${t} WHERE media_asset_id=$1`,[s.mediaAssetId]))[0].n,0);
  });
for(const type of ['reception','damage']) for(const status of ['pending_upload','uploaded','quarantined','deleted']) test(`HTTP ${type} rejects ${status}`,async()=>{
  const p=await parent(a),s=await upload(p,type);await fixtureStatus(s,status);
  const before=await state(s);error(await attach(p,s,type),409,'MEDIA_ASSET_NOT_ELIGIBLE');assert.deepEqual(await state(s),before);
});
for(const status of ['pending','failed','expired']) test(`active asset requires completed session: ${status}`,async()=>{
  const p=await parent(a),s=await upload(p);await h.admin`UPDATE upload_sessions SET status=${status} WHERE id=${s.uploadSessionId}`;
  const before=await state(s);error(await attach(p,s),409,'MEDIA_ASSOCIATION_CONTEXT_MISMATCH');assert.deepEqual(await state(s),before);
});
for(const marker of ['deletion_requested_at','deleted_at','purged_at']) test(`${marker} blocks attach and canonical download`,async()=>{
  const p=await parent(a),s=await upload(p);await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx.unsafe(`UPDATE media_assets SET ${marker}=now()${marker==='purged_at'?',deleted_at=now()':''} WHERE id=$1`,[s.mediaAssetId]);});
  error(await attach(p,s),409,'MEDIA_ASSET_NOT_ELIGIBLE');error(await call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,'GET'),404,'MEDIA_ASSET_NOT_FOUND');
});
test('conflicting historical bindings for one asset fail safe; foreign binding FK cannot enter',async()=>{
  const p=await parent(a),q=await parent(a),s=await upload(p),other=await upload(q);
  // Explicit historical corruption probe, never a runtime path.
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx`UPDATE upload_sessions SET media_asset_id=${s.mediaAssetId} WHERE id=${other.uploadSessionId}`;});
  const before=await state(s);error(await attach(p,s),409,'MEDIA_ASSOCIATION_CONTEXT_MISMATCH');await assert.rejects(direct(p,s),e=>e.code==='23514'&&e.constraint_name==='media_association_context_guard');assert.deepEqual(await state(s),before);
  const foreign=await parent(b),foreignUpload=await upload(foreign,'reception','photo',b);
  await assert.rejects(run(sql=>sql`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,privacy_consent_id)
    VALUES(${a.tenantId},${foreignUpload.uploadSessionId},${p.reception},${p.consent})`),e=>['23514','23503'].includes(e.code));
});
for(const type of ['reception','damage']) for(const [pool,role] of [[h.apiPool,'api'],[h.workerPool,'worker']]) test(`${role} ${type}: raw forbidden mutations`,async()=>{
  const table=type==='reception'?'reception_media':'damage_media';
  for(const statement of [`UPDATE ${table} SET sort_order=sort_order WHERE false`,`DELETE FROM ${table} WHERE false`,`TRUNCATE ${table}`,
    ...(role==='worker'?[`SELECT * FROM ${table}`,`INSERT INTO ${table}(tenant_id) VALUES('${a.tenantId}')`]:[])])
    await assert.rejects(h.asRuntime(pool,runtime(),sql=>sql.unsafe(statement)),e=>e.code==='42501');
});
for(const fail of ['association','retention','audit']) test(`${fail} failure rolls back association, floor and audit`,async()=>{
  const p=await parent(a),s=await upload(p);await terminalOrder(p);
  const before=await state(s);const remove=fail==='retention'?await updateFailure():await h.injectFailure(fail==='association'?'reception_media':'audit_logs',
    fail==='audit'?"NEW.action='media.associated'":'true');
  try {error(await attach(p,s),500,'INTERNAL_ERROR');}finally{await remove();}
  assert.deepEqual(await state(s),before);assert.equal((await attach(p,s)).status,201);
});
async function terminalOrder(p,status='delivered',closedAt='2024-02-29T10:15:30.123456Z') {
  const id=randomUUID();
  // TEST-ONLY future order lifecycle fixture; no runtime terminal command is added.
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
    await tx`INSERT INTO service_orders(id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id,status,closed_at)
      VALUES(${id},${a.tenantId},${p.reception},${p.vehicle},${p.customer},${BigInt('0x'+id.replaceAll('-','').slice(0,12))},${a.owner.membershipId},${status},
      ${['delivered','cancelled'].includes(status)?closedAt:null}::text::timestamptz)`;
  });return id;
}
for(const type of ['reception','damage']) for(const status of ['delivered','cancelled','in_progress']) test(`${type}: order ${status} floor is atomic, calendar based, preserves hold/version`,async()=>{
  const p=await parent(a),s=await upload(p,type);await terminalOrder(p,status);
  await h.admin`UPDATE media_assets SET retention_policy_version='historical-v0',legal_hold_until='2040-01-01T00:00:00Z' WHERE id=${s.mediaAssetId}`;
  const r=await attach(p,s,type);assert.equal(r.status,201,JSON.stringify(r.body));const d=await decision(s),st=await state(s),m=JSON.parse(st.asset);
  assert.equal(st.retention_until,status==='in_progress'?null:'2025-02-28T10:15:30.123456Z');
  assert.equal(m.retention_policy_version,'historical-v0');assert.ok(d.blockers.includes('LEGAL_HOLD'));assert.equal(d.blockers.includes('UNRESOLVED_PROTECTION'),false);
  if(status==='in_progress')assert.ok(d.blockers.includes('DOMAIN_LINK_NONTERMINAL'));
});
async function until(check){const end=Date.now()+10000;while(!await check()){assert.ok(Date.now()<end,'PostgreSQL overlap barrier reached');await yieldTurn();}}
async function blocked(pid,pattern,count=1){await until(async()=>{const [r]=await h.admin`SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname=current_database() AND (${pid}=ANY(pg_blocking_pids(pid)) OR (${count}>1 AND cardinality(pg_blocking_pids(pid))>0)) AND query LIKE ${pattern}`;return r.n>=count;});}
async function holdParent(p){const holder=await h.admin.reserve();await holder`BEGIN`;await holder`SELECT id FROM receptions WHERE id=${p.reception} FOR NO KEY UPDATE`;
  const [r]=await holder`SELECT pg_backend_pid() pid`;return {sql:holder,pid:r.pid,async release(){await holder`ROLLBACK`;holder.release();}};}
async function auditBarrier(){const holder=await h.admin.reserve(),key=String(BigInt('0x'+randomUUID().replaceAll('-','').slice(0,15))),name='b04b_gate_'+randomUUID().replaceAll('-','').slice(0,12);
  await holder`BEGIN`;await holder`SELECT pg_advisory_xact_lock(${key}::bigint)`;const [r]=await holder`SELECT pg_backend_pid() pid`;
  await h.admin.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.action='media.associated' THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $f$;
    CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
  return {pid:r.pid,async reached(){await blocked(r.pid,'%INSERT INTO public.audit_logs%');},async release(){await holder`ROLLBACK`;holder.release();},async cleanup(){await h.admin.unsafe(`DROP TRIGGER ${name} ON audit_logs;DROP FUNCTION public.${name}();`);}};
}
for(const type of ['reception','damage']) for(const different of [false,true]) test(`${type}: concurrent ${different?'different':'equal'} sort serializes to one row/audit`,async()=>{
  const p=await parent(a),s=await upload(p,type),holder=await holdParent(p);let pending;
  try{pending=Promise.all([attach(p,s,type,0),attach(p,s,type,different?1:0)]);await blocked(holder.pid,'%FROM public.receptions%',2);}finally{await holder.release();}
  const rs=await pending;assert.deepEqual(rs.map(r=>r.status).sort(),different?[201,409]:[201,201]);
  if(different)error(rs.find(r=>r.status===409),409,'MEDIA_ASSOCIATION_CONFLICT');else assert.deepEqual(rs[0].body,rs[1].body);
  const st=await state(s);assert.equal(st.receptions+st.damages,1);assert.equal(st.audits,1);
});
for(const type of ['reception','damage']) test(`${type}: attach wins close barrier; committed retention/link/audit`,async()=>{
  const p=await parent(a),s=await upload(p,type),gate=await auditBarrier();let attaching,closing;
  try{attaching=attach(p,s,type);await gate.reached();closing=close(p);await until(async()=>{const [r]=await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%FROM public.receptions%FOR NO KEY UPDATE%' AND cardinality(pg_blocking_pids(pid))>0`;return r.n>0;});}
  finally{await gate.release();}
  try{assert.equal((await attaching).status,201);assert.equal((await closing).status,200);assert.equal((await state(s)).audits,1);}finally{await gate.cleanup();}
});
for(const type of ['reception','damage']) test(`${type}: close wins parent lock, attach sees closed with zero association audit`,async()=>{
  const p=await parent(a),s=await upload(p,type),holder=await holdParent(p);let pending;
  try{pending=attach(p,s,type);await blocked(holder.pid,'%FROM public.receptions%');
    // Same transaction commits a canonical close via production service while holding the parent.
    const service=h.load('receptions/close.js');
    await holder.sql`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.user_id',${a.owner.user.id},true),set_config('app.membership_id',${a.owner.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
    await service.closeReception({sql:holder.sql,tenant:runtime()},p.reception,{requestId:randomUUID(),ipAddress:null});await holder.sql`COMMIT`;
  }finally{await holder.release();}
  error(await pending,409,'RECEPTION_NOT_EDITABLE');const st=await state(s);assert.equal(st.audits,0);assert.equal(st.receptions+st.damages,0);
});
for(const attachFirst of [true,false]) test(`attach vs retention: first=${attachFirst}, longest floor survives`,async()=>{
  const p=await parent(a),s=await upload(p);await terminalOrder(p);let attaching,recalculating;
  if(attachFirst){const gate=await auditBarrier();try{attaching=attach(p,s);await gate.reached();recalculating=run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId));
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%FROM public.receptions%' AND cardinality(pg_blocking_pids(pid))>0`;return r.n>0;});}finally{await gate.release();}
    try{assert.equal((await attaching).status,201);await recalculating;}finally{await gate.cleanup();}
  }else{const holder=await h.apiPool.reserve();try{await holder`BEGIN`;await holder`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
    const token=await retention.lockMediaRetention(holder,a.tenantId,[s.mediaAssetId]);attaching=attach(p,s);const [r]=await holder`SELECT pg_backend_pid() pid`;await blocked(r.pid,'%FROM public.receptions%');
    await holder`UPDATE media_assets SET retention_until='2045-01-01T00:00:00Z' WHERE tenant_id=${a.tenantId} AND id=${s.mediaAssetId}`;
    await retention.evaluateLockedMediaRetention(token,s.mediaAssetId);await holder`COMMIT`;
  }finally{await holder`ROLLBACK`;holder.release();}assert.equal((await attaching).status,201);}
  const st=await state(s);assert.equal(st.retention_until,attachFirst?'2025-02-28T10:15:30.123456Z':'2045-01-01T00:00:00.000000Z');assert.equal(st.audits,1);
});
test('damage mutation waits behind association parent/damage locks',async()=>{
  const p=await parent(a),s=await upload(p,'damage'),gate=await auditBarrier();let attaching,mutating;
  try{attaching=attach(p,s,'damage');await gate.reached();
    const [r]=await h.admin`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') token FROM receptions WHERE id=${p.reception}`;
    mutating=call(`/api/v1/receptions/${p.reception}/damages`,{expectedUpdatedAt:r.token,damages:[{operation:'update',damageId:p.damage,zoneCode:'rear',damageType:'dent',severity:'minor',description:null}]},'PATCH');
    await until(async()=>{const [r]=await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND query LIKE '%FROM public.receptions%' AND cardinality(pg_blocking_pids(pid))>0`;return r.n>0;});
  }finally{await gate.release();}
  try{assert.equal((await attaching).status,201);assert.equal((await mutating).status,200);assert.equal((await list(p,'damage')).body.media[0].mediaAssetId,s.mediaAssetId);}finally{await gate.cleanup();}
});

// Deleted historical state is constructed only in the disposable admin fixture;
// B05's runtime deletion guard remains enabled during all attach assertions.
async function fixtureStatus(s,status) {
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
    await tx`UPDATE media_assets SET status=${status} WHERE id=${s.mediaAssetId}`;
  });
}
async function updateFailure() {
  const name='b04b_update_fail_'+randomUUID().replaceAll('-','').slice(0,12);
  await h.admin.unsafe(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'TEST_RETENTION_FAILURE'; END $f$;
    CREATE TRIGGER ${name} BEFORE UPDATE OF retention_until ON media_assets FOR EACH ROW EXECUTE FUNCTION public.${name}();`);
  return ()=>h.admin.unsafe(`DROP TRIGGER ${name} ON media_assets;DROP FUNCTION public.${name}();`);
}
test('new service-order lineage while attach waits retries whole transaction with fresh authorization',async()=>{
  const p=await parent(a),s=await upload(p),holder=await holdParent(p),before=verifications;let pending;
  try{pending=attach(p,s);await blocked(holder.pid,'%FROM public.receptions%FOR NO KEY UPDATE%');await terminalOrder(p);}finally{await holder.release();}
  const r=await pending;assert.equal(r.status,201,JSON.stringify(r.body));assert.ok(verifications>=before+2,'fresh membership/RBAC transaction');
  assert.equal((await state(s)).audits,1);assert.equal((await state(s)).retention_until,'2025-02-28T10:15:30.123456Z');
});

for(const type of ['reception','damage']) test(`${type}: malformed path is anti-enumeration 404; GET query rejected`,async()=>{
  const p=await parent(a);error(await list({...p,reception:'bad'},type),404,'RECEPTION_NOT_FOUND');
  if(type==='damage')error(await list({...p,damage:'bad'},type),404,'DAMAGE_NOT_FOUND');
  error(await call(path(p,type)+'?purpose=other',undefined,'GET'),400,'REQUEST_VALIDATION_FAILED');
  error(await call(path(p,type),undefined),415,'UNSUPPORTED_MEDIA_TYPE');
});
for(const variant of ['equivalent','missing-binding']) test(`multiple completed sessions: ${variant} is resolved without selecting one arbitrarily`,async()=>{
  const p=await parent(a),s=await upload(p),other=await upload(p);
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
    await tx`UPDATE upload_sessions SET media_asset_id=${s.mediaAssetId} WHERE id=${other.uploadSessionId}`;
    if(variant==='missing-binding')await tx`DELETE FROM media_upload_bindings WHERE upload_session_id=${other.uploadSessionId}`;
  });
  if(variant==='equivalent'){assert.equal((await attach(p,s)).status,201);assert.equal((await state(s)).audits,1);}
  else{error(await attach(p,s),409,'MEDIA_ASSOCIATION_CONTEXT_MISMATCH');await assert.rejects(direct(p,s),e=>e.code==='23514'&&e.constraint_name==='media_association_context_guard');}
});
test('historical damage/reception lineage corruption fails both HTTP and runtime SQL',async()=>{
  const p=await parent(a),q=await parent(a),s=await upload(p,'damage');
  // Deliberate corruption fixture only; composite binding FK normally forbids it.
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
    await tx`UPDATE vehicle_damages SET reception_id=${q.reception} WHERE id=${p.damage}`;
  });
  const target={...p,reception:q.reception},before=await state(s);
  error(await attach(target,s,'damage'),409,'MEDIA_ASSOCIATION_CONTEXT_MISMATCH');
  await assert.rejects(direct(target,s,'damage'),e=>e.code==='23514'&&e.constraint_name==='media_association_context_guard');assert.deepEqual(await state(s),before);
});


// ---------------------------------------------------------------------------
// R1: timezone independence. Timestamptz text depends on the SESSION zone, so
// permanent assertions compare a canonical UTC microsecond string or an instant.
// The zones below are set explicitly per transaction, never read from the host.
// ---------------------------------------------------------------------------
const ZONES={'UTC':'+00','America/Bogota':'-05','Asia/Kolkata':'+05:30','Pacific/Auckland':'+13'};
// 2024-02-28T23:30Z is already 2024-02-29 in Auckland/Kolkata: a floor computed in
// the session zone would land on a different instant than the UTC calendar floor.
const ZONE_CLOSED_AT='2024-02-28T23:30:00.123456Z',ZONE_FLOOR='2025-02-28T23:30:00.123456Z';
for(const zone of Object.keys(ZONES)) for(const type of ['reception','damage']) test(`timezone ${zone}: ${type} attach floor is one UTC instant with microseconds`,async()=>{
  const p=await parent(a),s=await upload(p,type);await terminalOrder(p,'delivered',ZONE_CLOSED_AT);
  const target=type==='reception'?{type,receptionId:p.reception}:{type,receptionId:p.reception,damageId:p.damage};
  const seen=await h.asRuntime(h.apiPool,runtime(),async sql=>{
    await sql`SELECT set_config('TimeZone',${zone},true)`;
    await associations.attachMedia(sql,a.tenantId,target,{mediaAssetId:s.mediaAssetId});
    const [r]=await sql`SELECT current_setting('TimeZone') zone,m.retention_until::text raw,row_to_json(m)->>'retention_until' json,
      to_char(m.retention_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') canonical,
      m.retention_until=${ZONE_FLOOR}::text::timestamptz same_instant,
      m.retention_until-'2025-02-28T23:30:00Z'::timestamptz=interval '0.123456 seconds' micros
      FROM media_assets m WHERE m.tenant_id=${a.tenantId} AND m.id=${s.mediaAssetId}`;
    return {...r,known:(await retention.evaluateMediaRetention(sql,a.tenantId,s.mediaAssetId)).knownRetentionUntil};
  });
  assert.equal(seen.zone,zone);assert.ok(seen.raw.endsWith(ZONES[zone]),`${zone} serializes ${seen.raw}`);
  // The original defect: naive text equality is zone dependent, instants are not.
  assert.equal(seen.json===ZONE_FLOOR.replace('Z','+00:00'),zone==='UTC');
  assert.equal(seen.canonical,ZONE_FLOOR);assert.equal(seen.same_instant,true);assert.equal(seen.micros,true);assert.equal(seen.known,ZONE_FLOOR);
  assert.equal((await state(s)).retention_until,ZONE_FLOOR,'committed value is read identically from the default session zone');
});

// ---------------------------------------------------------------------------
// R2: only a MATCHING canonical final association releases the binding blocker.
// Mismatching associations are admin fixtures (replica) because the runtime guard
// correctly refuses to create them; retention must still not trust them.
// ---------------------------------------------------------------------------
async function fixtureAssociation(kind,target,s) {
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
    if(kind==='reception')await tx`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose,sort_order)
      VALUES(${a.tenantId},${target},${s.mediaAssetId},'intake_evidence',0)`;
    else await tx`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose,sort_order)
      VALUES(${a.tenantId},${target},${s.mediaAssetId},'damage_evidence',0)`;});
}
async function persisted(s) {
  const [row]=await h.admin`SELECT
    coalesce((SELECT json_agg(reception_id ORDER BY reception_id) FROM reception_media WHERE media_asset_id=${s.mediaAssetId}),'[]'::json) receptions,
    coalesce((SELECT json_agg(damage_id ORDER BY damage_id) FROM damage_media WHERE media_asset_id=${s.mediaAssetId}),'[]'::json) damages,
    (SELECT json_agg(json_build_object('reception',b.reception_id,'damage',b.damage_id,'status',us.status))
      FROM media_upload_bindings b JOIN upload_sessions us ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
      WHERE us.media_asset_id=${s.mediaAssetId}) bindings`;
  return row;
}
const bindingSource=d=>d.sources.find(x=>x.kind==='upload_binding');
function assertProtective(d,s) {
  assert.deepEqual(bindingSource(d),{kind:'upload_binding',id:s.uploadSessionId,knownRetentionUntil:null,blocker:'UNRESOLVED_PROTECTION'});
  assert.ok(d.blockers.includes('UNRESOLVED_PROTECTION'));assert.equal(d.blocksAutomaticPurge,true);
  assert.notEqual(d.eligibility,'ELIGIBLE_AFTER_DATE');
}
async function secondDamage(p) {
  const id=randomUUID();
  await h.admin`INSERT INTO vehicle_damages(id,tenant_id,reception_id,zone_code,damage_type) VALUES(${id},${a.tenantId},${p.reception},'rear','dent')`;
  return id;
}
const MISMATCHES=[
  {name:'another reception',type:'reception',make:async(p,q)=>['reception',q.reception],expected:(p,q)=>({receptions:[q.reception],damages:[]})},
  {name:'another reception (damage binding)',type:'damage',make:async(p,q)=>['damage',q.damage],expected:(p,q)=>({receptions:[],damages:[q.damage]})},
  {name:'another damage in the same reception',type:'damage',make:async p=>['damage',await secondDamage(p)],expected:(p,q,x)=>({receptions:[],damages:[x]})},
  {name:'damage association for a reception binding',type:'reception',make:async p=>['damage',p.damage],expected:p=>({receptions:[],damages:[p.damage]})},
  {name:'reception association for a damage binding',type:'damage',make:async p=>['reception',p.reception],expected:p=>({receptions:[p.reception],damages:[]})},
];
for(const c of MISMATCHES) test(`binding release: ${c.name} does not release the ${c.type} binding blocker`,async()=>{
  const p=await parent(a),q=await parent(a),s=await upload(p,c.type),[kind,target]=await c.make(p,q);
  const bindings=(await persisted(s)).bindings;
  await fixtureAssociation(kind,target,s);
  const d=await decision(s);assertProtective(d,s);
  const recalculated=await run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId));assertProtective(recalculated,s);
  const after=await persisted(s);assert.deepEqual({receptions:after.receptions,damages:after.damages},c.expected(p,q,target));
  assert.deepEqual(after.bindings,bindings);assert.deepEqual(bindings,[{reception:p.reception,damage:c.type==='damage'?p.damage:null,status:'completed'}]);
  assert.equal((await state(s)).retention_until,null);
});
for(const type of ['reception','damage']) test(`binding release: association of another asset does not release the ${type} binding`,async()=>{
  const p=await parent(a),s=await upload(p,type),other=await upload(p,type);
  assert.equal((await attach(p,other,type)).status,201);
  const d=await decision(s);assertProtective(d,s);assert.equal(d.sources.some(x=>x.kind===`${type}_media`),false);
  const od=await decision(other);assert.equal(bindingSource(od),undefined);assert.deepEqual(od.blockers,['CLOCK_NOT_STARTED']);
  const mine=await persisted(s),theirs=await persisted(other);
  assert.deepEqual([mine.receptions,mine.damages],[[],[]]);assert.deepEqual(type==='reception'?theirs.receptions:theirs.damages,[type==='reception'?p.reception:p.damage]);
});
for(const type of ['reception','damage']) test(`binding release: pending ${type} binding stays protective even with a matching-looking association`,async()=>{
  const p=await parent(a),s=await upload(p,type,'photo',a,false);
  await fixtureAssociation(type,type==='reception'?p.reception:p.damage,s);
  const d=await decision(s);assertProtective(d,s);assert.ok(d.blockers.includes('ACTIVE_UPLOAD'));assert.equal(d.eligibility,'NOT_ELIGIBLE_ACTIVE_UPLOAD');
  const after=await persisted(s);assert.deepEqual(after.bindings,[{reception:p.reception,damage:type==='damage'?p.damage:null,status:'pending'}]);
  assert.deepEqual(type==='reception'?after.receptions:after.damages,[type==='reception'?p.reception:p.damage]);
});
for(const type of ['reception','damage']) test(`binding release: matching completed ${type} association releases exactly the binding blocker`,async()=>{
  const p=await parent(a),s=await upload(p,type),before=await decision(s);assertProtective(before,s);
  assert.equal((await attach(p,s,type)).status,201);
  const d=await decision(s);assert.equal(bindingSource(d),undefined);assert.deepEqual(d.blockers,['CLOCK_NOT_STARTED']);
  assert.equal(d.eligibility,'NOT_ELIGIBLE_CLOCK_NOT_STARTED');assert.equal(d.blocksAutomaticPurge,true);assert.equal(d.knownRetentionUntil,null);
  assert.deepEqual(d.sources.map(x=>x.kind),[`${type}_media`]);
  const after=await persisted(s);assert.deepEqual(type==='reception'?after.receptions:after.damages,[type==='reception'?p.reception:p.damage]);
  assert.deepEqual(after.bindings,[{reception:p.reception,damage:type==='damage'?p.damage:null,status:'completed'}],'binding evidence is retained');
});

// ---------------------------------------------------------------------------
// R3: direct SQL as tallermecario_api against the 0028 SECURITY INVOKER guard.
// No application pre-lock: every transaction below is a bare INSERT, and every
// barrier is a PostgreSQL lock wait (pg_blocking_pids), never a sleep.
// ---------------------------------------------------------------------------
async function apiTx(t=a) {
  const conn=await h.apiPool.reserve();
  await conn`BEGIN`;
  await conn`SELECT set_config('app.tenant_id',${t.tenantId},true),set_config('app.user_id',${t.owner.user.id},true),
    set_config('app.membership_id',${t.owner.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
  const [me]=await conn`SELECT pg_backend_pid() pid,current_user who,session_user login,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) privileged`;
  assert.equal(me.who,'tallermecario_api');assert.notEqual(me.login,me.who);assert.equal(me.privileged,false);
  let done=false;
  return {sql:conn,pid:me.pid,async end(command='COMMIT'){if(done)return;done=true;try{await conn.unsafe(command);}finally{conn.release();}}};
}
const settle=query=>Promise.resolve(query).then(()=>({ok:true}),error=>({ok:false,error}));
const insertAssociation=(sql,type,p,s)=>type==='reception'
  ?sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose,sort_order)
    VALUES(${a.tenantId},${p.reception},${s.mediaAssetId},'intake_evidence',0)`
  :sql`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose,sort_order)
    VALUES(${a.tenantId},${p.damage},${s.mediaAssetId},'damage_evidence',0)`;
const waitsOn=(blockerPid,waiterPid)=>until(async()=>(await h.admin`SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname=current_database() AND pid=${waiterPid} AND ${blockerPid}=ANY(pg_blocking_pids(pid))`)[0].n===1);
const waitsOnAny=(blockerPid,pattern)=>until(async()=>(await h.admin`SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname=current_database() AND ${blockerPid}=ANY(pg_blocking_pids(pid)) AND query LIKE ${pattern}`)[0].n>0);
const rowsOf=async(type,s)=>(await h.admin.unsafe(`SELECT count(*)::int n FROM ${type==='reception'?'reception_media':'damage_media'} WHERE media_asset_id=$1`,[s.mediaAssetId]))[0].n;
const receptionStatus=async p=>(await h.admin`SELECT status FROM receptions WHERE id=${p.reception}`)[0].status;
const noDeadlock=r=>{assert.ok(!r.error||!['40P01','40001'].includes(r.error.code),`deadlock/serialization: ${r.error&&r.error.message}`);};

test('direct SQL runs as tallermecario_api: no tenant context is refused by RLS and nothing is written',async()=>{
  const p=await parent(a),s=await upload(p),conn=await h.apiPool.reserve();
  try{await conn`BEGIN`;const [me]=await conn`SELECT current_user who`;assert.equal(me.who,'tallermecario_api');
    await assert.rejects(insertAssociation(conn,'reception',p,s),e=>e.code==='42501'||e.code==='23514');}
  finally{await conn`ROLLBACK`.catch(()=>{});conn.release();}
  assert.equal(await rowsOf('reception',s),0);
});
for(const type of ['reception','damage']) test(`direct SQL ${type}: INSERT wins, close waits on the guard's parent lock and then proceeds`,async()=>{
  const p=await parent(a),s=await upload(p,type),writer=await apiTx();let closing;
  try{
    await insertAssociation(writer.sql,type,p,s);                       // guard locks acquired, still uncommitted
    closing=close(p);await waitsOnAny(writer.pid,'%FROM public.receptions%');
    assert.equal(await receptionStatus(p),'open');await writer.end();
  }finally{await writer.end('ROLLBACK');}
  const r=await closing;assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(await receptionStatus(p),'closed');assert.equal(await rowsOf(type,s),1);
  assert.deepEqual((await list(p,type)).body.media.map(m=>m.mediaAssetId),[s.mediaAssetId]);
});
for(const type of ['reception','damage']) test(`direct SQL ${type}: close wins, guard rejects the waiting INSERT with no row`,async()=>{
  const p=await parent(a),s=await upload(p,type),holder=await holdParent(p),writer=await apiTx(),before=await state(s);let pending;
  try{
    pending=settle(insertAssociation(writer.sql,type,p,s));await waitsOn(holder.pid,writer.pid);
    const service=h.load('receptions/close.js');
    await holder.sql`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.user_id',${a.owner.user.id},true),set_config('app.membership_id',${a.owner.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
    await service.closeReception({sql:holder.sql,tenant:runtime()},p.reception,{requestId:randomUUID(),ipAddress:null});await holder.sql`COMMIT`;
  }finally{await holder.release();}
  const r=await pending;assert.equal(r.ok,false);assert.equal(r.error.code,'23514');assert.equal(r.error.constraint_name,'media_association_parent_guard');
  await writer.end('ROLLBACK');
  assert.equal(await rowsOf(type,s),0);assert.equal(await receptionStatus(p),'closed');assert.deepEqual(await state(s),before);
});
for(const type of ['reception','damage']) for(const insertFirst of [true,false]) test(`direct SQL ${type} vs retention: ${insertFirst?'INSERT':'retention'} wins; floor and guard stay canonical`,async()=>{
  const p=await parent(a),s=await upload(p,type);await terminalOrder(p);
  const floor='2025-02-28T10:15:30.123456Z',writer=await apiTx();let other;
  if(insertFirst){
    try{await insertAssociation(writer.sql,type,p,s);
      other=settle(run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId)));
      await waitsOnAny(writer.pid,'%FROM public.receptions%');await writer.end();}finally{await writer.end('ROLLBACK');}
    noDeadlock(await other);assert.equal((await other).ok,true,String((await other).error));
    const d=await decision(s);assert.equal((await state(s)).retention_until,floor);assert.equal(d.knownRetentionUntil,floor);
    assert.equal(bindingSource(d),undefined);assert.equal(d.blockers.includes('UNRESOLVED_PROTECTION'),false);
  }else{
    const holder=await h.apiPool.reserve();let pending;
    try{await holder`BEGIN`;await holder`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.request_id',${randomUUID()},true)`;
      const token=await retention.lockMediaRetention(holder,a.tenantId,[s.mediaAssetId]);const [me]=await holder`SELECT pg_backend_pid() pid`;
      pending=settle(insertAssociation(writer.sql,type,p,s));await waitsOn(me.pid,writer.pid);
      // Retention evaluated under its own lock still sees the not-yet-associated binding: strict serialization.
      assertProtective(await retention.evaluateLockedMediaRetention(token,s.mediaAssetId),s);
      await holder`UPDATE media_assets SET retention_until='2045-01-01T00:00:00Z' WHERE tenant_id=${a.tenantId} AND id=${s.mediaAssetId}`;
      await holder`COMMIT`;}
    finally{await holder`ROLLBACK`.catch(()=>{});holder.release();}
    const r=await pending;noDeadlock(r);assert.equal(r.ok,true,String(r.error));await writer.end();
    const d=await run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId));
    assert.equal(d.knownRetentionUntil,'2045-01-01T00:00:00.000000Z','the longer committed floor is never lost');
    assert.equal((await state(s)).retention_until,'2045-01-01T00:00:00.000000Z');assert.equal(bindingSource(d),undefined);
  }
  assert.equal(await rowsOf(type,s),1);
});
// Which locks has the guard ALREADY taken when it blocks on tier T? Probe with NOWAIT
// from a third connection: earlier tiers must be held, later tiers untouched.
for(const type of ['reception','damage']) {
  const chain=type==='reception'?['reception','orders','sessions','asset']:['reception','damage','orders','sessions','asset'];
  for(const tier of chain.slice(1)) test(`direct SQL ${type}: canonical lock order, blocked at ${tier} holds only earlier tiers`,async()=>{
    const p=await parent(a),s=await upload(p,type),order=await terminalOrder(p),writer=await apiTx(),holder=await h.admin.reserve();
    const lockSql={
      reception:`SELECT id FROM receptions WHERE id='${p.reception}' FOR NO KEY UPDATE`,
      damage:`SELECT id FROM vehicle_damages WHERE id='${p.damage}' FOR UPDATE`,
      orders:`SELECT id FROM service_orders WHERE id='${order}' FOR NO KEY UPDATE`,
      sessions:`SELECT id FROM upload_sessions WHERE id='${s.uploadSessionId}' FOR UPDATE`,
      asset:`SELECT id FROM media_assets WHERE id='${s.mediaAssetId}' FOR UPDATE`};
    let pending;
    try{
      await holder`BEGIN`;await holder.unsafe(lockSql[tier]);const [me]=await holder`SELECT pg_backend_pid() pid`;
      pending=settle(insertAssociation(writer.sql,type,p,s));await waitsOn(me.pid,writer.pid);
      for(const probe of chain.filter(x=>x!==tier)) {
        const prober=await h.admin.reserve();
        try{await prober`BEGIN`;const outcome=await prober.unsafe(`${lockSql[probe]} NOWAIT`).then(()=>'free',e=>e.code==='55P03'?'held':e.code);
          assert.equal(outcome,chain.indexOf(probe)<chain.indexOf(tier)?'held':'free',`${probe} while the guard waits on ${tier}`);}
        finally{await prober`ROLLBACK`;prober.release();}
      }
    }finally{await holder`ROLLBACK`.catch(()=>{});holder.release();}
    const r=await pending;noDeadlock(r);assert.equal(r.ok,true,String(r.error));await writer.end();assert.equal(await rowsOf(type,s),1);
  });
}
for(const type of ['reception','damage']) test(`direct SQL ${type}: concurrent INSERTs and retention recalculations on one parent never deadlock`,async()=>{
  const p=await parent(a);await terminalOrder(p);
  for(let round=0;round<3;round++){
    const assets=[];for(let i=0;i<3;i++)assets.push(await upload(p,type));
    const work=[];
    for(const s of assets){
      work.push(settle(run(sql=>insertAssociation(sql,type,p,s))));
      work.push(settle(run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId))));
    }
    const results=await Promise.all(work);for(const r of results){noDeadlock(r);assert.equal(r.ok,true,String(r.error));}
    for(const s of assets){
      assert.equal(await rowsOf(type,s),1);const d=await run(sql=>retention.recalculateMediaRetention(sql,a.tenantId,s.mediaAssetId));
      assert.equal(d.knownRetentionUntil,'2025-02-28T10:15:30.123456Z');assert.equal(bindingSource(d),undefined);
      assert.equal((await state(s)).retention_until,'2025-02-28T10:15:30.123456Z');
    }
  }
});
