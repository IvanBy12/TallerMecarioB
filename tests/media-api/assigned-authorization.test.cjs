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
let app, a, b, port, storageCalls = 0, verifications = 0, signedGets = 0;
const r2Module=h.load('media/r2.js'), originalPresign=r2Module.presignR2Url;
r2Module.presignR2Url=(config, options)=>{if(options.method==='GET')signedGets++;return originalPresign(config,options);};
before(async () => {
  ({ a, b } = await h.twoTenants([{label:'other',roles:['technician']} ]));
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
after(async()=>{globalThis.fetch=originalFetch;r2Module.presignR2Url=originalPresign;await h.closeAll(app);});
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
function error(r,status,code){assert.equal(r.status,status,r.body?.error?.code ?? 'unexpected response status');assert.equal(r.body.error.code,code);}
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
const download=(s,actor=a.technician,t=a)=>call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,'GET',t,actor);
async function assigned(p,kind='lead_technician',actor=a.technician,t=a) {
  const closed=await call(`/api/v1/receptions/${p.reception}/close`,undefined,'POST',t);
  assert.equal(closed.status,200,JSON.stringify(closed.body));
  const id=randomUUID(),order=closed.body.serviceOrder.id;
  if(kind==='none')return {id:null,order};
  await h.admin`INSERT INTO assignments(id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
    VALUES(${id},${t.tenantId},${order},${actor.membershipId},${kind},${t.owner.membershipId})`;
  return {id,order};
}
async function ready(type='reception',kind='lead_technician',actor=a.technician,t=a) {
  const p=await parent(t),s=await upload(p,type,'photo',t);
  assert.equal((await attach(p,s,type,0,t)).status,201);
  const assignment=await assigned(p,kind,actor,t);
  return {p,s,...assignment};
}
async function denied(s,actor=a.technician,t=a) {
  const before=signedGets,r=await download(s,actor,t);
  error(r,404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before,'denial never signs a GET capability');
  assert.equal(r.headers['cache-control'],'no-store');assert.equal(JSON.stringify(r.body).includes('downloadUrl'),false);
  return {...r.body.error,request_id:null};
}
for(const type of ['reception','damage']) for(const kind of ['lead_technician','support_technician']) test(`${type}: ${kind} can list and download only the assigned order`,async()=>{
  const {p,s}=await ready(type,kind),r=await list(p,type,a,a.technician);
  assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.media.map(m=>m.mediaAssetId),[s.mediaAssetId]);
  const d=await download(s);assert.equal(d.status,200,JSON.stringify(d.body));assert.equal(d.headers['cache-control'],'no-store');
  assert.ok(d.body.downloadUrl);assert.ok(new Date(d.body.expiresAt)-Date.now()<=300000);
  assert.equal(new URL(d.body.downloadUrl).searchParams.get('X-Amz-Expires'),'300');
  await denied(s,a.other);
});
for(const actor of ['owner','admin','advisor']) test(`${actor}: tenant-wide lists/download and upload remain available without assignments`,async()=>{
  const {p,s}=await ready();assert.equal((await list(p,'reception',a,a[actor])).status,200);
  assert.equal((await download(s,a[actor])).status,200);
  const open=await parent(a),body={mediaType:'photo',mimeType:'image/png',retentionClass:'operational',idempotencyKey:randomUUID(),
    expectedSizeBytes:f.png.length,operationalContext:{type:'reception',receptionId:open.reception}};
  assert.equal((await call('/api/v1/media/upload-sessions',body,'POST',a,a[actor])).status,201);
});
for(const kind of ['quality_control','released','none']) test(`${kind}: 404 for list and direct IDOR with no signed URL`,async()=>{
  const {p,s,id}=await ready('reception',kind==='released'?'lead_technician':kind);
  if(kind==='released')await h.admin`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${id}`;
  await denied(s);error(await list(p,'reception',a,a.technician),404,'RECEPTION_NOT_FOUND');
});
test('two orders: assignment on one never grants the other or a mismatched damage lineage',async()=>{
  const own=await ready('damage'),other=await ready('damage','lead_technician',a.other);
  await denied(other.s);error(await list(other.p,'damage',a,a.technician),404,'DAMAGE_NOT_FOUND');
  error(await list({...own.p,damage:other.p.damage},'damage',a,a.technician),404,'DAMAGE_NOT_FOUND');
  error(await list({...own.p,reception:other.p.reception},'damage',a,a.technician),404,'DAMAGE_NOT_FOUND');
});
test('foreign asset/target and missing asset have identical non-disclosing errors; runtime associations preserve tenant FKs',async()=>{
  const own=await ready(),foreign=await ready('reception','lead_technician',b.technician,b);
  const fError=await denied(foreign.s),missingError=await denied({mediaAssetId:randomUUID()});assert.deepEqual(fError,missingError);
  error(await list(foreign.p,'reception',a,a.technician),404,'RECEPTION_NOT_FOUND');
  const p=await parent(a);
  await assert.rejects(run(sql=>sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
    VALUES(${a.tenantId},${p.reception},${foreign.s.mediaAssetId},'intake_evidence')`),e=>['23503','23514'].includes(e.code));
  await assert.rejects(run(sql=>sql`INSERT INTO assignments(id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
    VALUES(${randomUUID()},${a.tenantId},${foreign.order},${a.technician.membershipId},'lead_technician',${a.owner.membershipId})`),e=>e.code==='23503');
  assert.equal((await download(own.s)).status,200);
});
for(const status of ['suspended','revoked']) test(`${status} membership: explicit route denial and no capability`,async()=>{
  const {s}=await ready(),before=signedGets;
  try {
    await h.admin`UPDATE memberships SET status=${status},suspended_at=${status==='suspended'?new Date():null},
      revoked_at=${status==='revoked'?new Date():null},updated_at=clock_timestamp() WHERE id=${a.technician.membershipId}`;
    const r=await download(s);assert.equal(r.status,403);assert.equal(signedGets,before);
  } finally {await corrupt(sql=>sql`UPDATE memberships SET status='active',suspended_at=NULL,revoked_at=NULL,updated_at=clock_timestamp() WHERE id=${a.technician.membershipId}`);}
});
test('removed role: media.read missing gives explicit 403 without signing',async()=>{
  const {s}=await ready(),before=signedGets;
  try {await h.admin`DELETE FROM membership_roles WHERE membership_id=${a.technician.membershipId}`;
    const r=await download(s);error(r,403,'PERMISSION_DENIED');assert.equal(signedGets,before);
  } finally {await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
    SELECT ${a.tenantId},${a.technician.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;}
});
async function corrupt(fn) {await h.admin.begin(async sql=>{await sql`SET LOCAL session_replication_role=replica`;await fn(sql);});}
for(const mutation of ['quarantined','deleted','deletion_requested_at','deleted_at','purged_at','signature','privacy','document']) test(`${mutation}: inaccessible asset never signs and is omitted from technician list`,async()=>{
  const {p,s}=await ready();
  await corrupt(sql=>['quarantined','deleted'].includes(mutation)?sql`UPDATE media_assets SET status=${mutation} WHERE id=${s.mediaAssetId}`
    :['signature','document'].includes(mutation)?sql`UPDATE media_assets SET media_type=${mutation},retention_class=${mutation==='signature'?'authorization_evidence':mutation} WHERE id=${s.mediaAssetId}`
    :mutation==='privacy'?sql`UPDATE privacy_consents SET evidence_media_id=${s.mediaAssetId} WHERE id=${p.consent}`
    :sql.unsafe(`UPDATE media_assets SET ${mutation}=clock_timestamp()${mutation==='purged_at'?',deleted_at=clock_timestamp()':''} WHERE id=$1`,[s.mediaAssetId]));
  await denied(s);const r=await list(p,'reception',a,a.technician);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.media,[]);
});
test('unattached media and creator identity never establish assigned access',async()=>{
  const p=await parent(a),s=await upload(p);await assigned(p);
  await denied(s);assert.deepEqual((await list(p,'reception',a,a.technician)).body.media,[]);
});
for(const mutation of ['foreign-reception','same-order-wrong-damage','disallowed-purpose','conflicting-binding','missing-binding','failed-session']) test(`full graph: ${mutation} fails closed`,async()=>{
  const {p,s}=await ready(),q=await ready('reception','lead_technician',a.other);
  await corrupt(async sql=>{
    if(mutation==='foreign-reception')await sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${q.p.reception},${s.mediaAssetId},'intake_evidence')`;
    if(mutation==='same-order-wrong-damage')await sql`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${p.damage},${s.mediaAssetId},'damage_evidence')`;
    if(mutation==='disallowed-purpose')await sql`INSERT INTO quote_media(tenant_id,quote_version_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${randomUUID()},${s.mediaAssetId},'test_disallowed')`;
    if(mutation==='conflicting-binding')await sql`UPDATE upload_sessions SET media_asset_id=${s.mediaAssetId} WHERE id=${q.s.uploadSessionId}`;
    if(mutation==='missing-binding')await sql`DELETE FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    if(mutation==='failed-session')await sql`UPDATE upload_sessions SET status='failed' WHERE id=${s.uploadSessionId}`;
  });
  await denied(s);const r=await list(p,'reception',a,a.technician);assert.equal(r.status,200);assert.deepEqual(r.body.media,[]);
});
for(const type of ['reception','damage']) test(`${type}: all upload operations and replay stay denied, with zero R2 calls`,async()=>{
  const {p,s}=await ready(type),before=signedGets,calls=storageCalls;
  const body={mediaType:'photo',mimeType:'image/png',retentionClass:'operational',idempotencyKey:randomUUID(),expectedSizeBytes:f.png.length,
    operationalContext:type==='reception'?{type,receptionId:p.reception}:{type,damageId:p.damage}};
  error(await call('/api/v1/media/upload-sessions',body,'POST',a,a.technician),403,'PERMISSION_DENIED');
  error(await call(`/api/v1/media/upload-sessions/${s.uploadSessionId}/complete`,{},'POST',a,a.technician),403,'PERMISSION_DENIED');
  error(await attach(p,s,type,0,a,a.technician),403,'PERMISSION_DENIED');
  error(await call('/api/v1/media/upload-sessions',body,'POST',a,a.technician),403,'PERMISSION_DENIED');
  assert.equal(signedGets,before);assert.equal(storageCalls,calls);
});
async function until(check) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await check())return;await yieldTurn();}
  throw new Error('PostgreSQL barrier timeout');
}
test('revocation wins assignment lock: a waiting download rechecks released_at and never signs',async()=>{
  const {s,id}=await ready(),holder=await h.admin.reserve();let pending;
  const before=signedGets;
  try {
    await holder`BEGIN`;await holder`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${id}`;
    const [me]=await holder`SELECT pg_backend_pid() pid`;
    pending=download(s);await until(async()=> (await h.admin`SELECT count(*)::int n FROM pg_stat_activity
      WHERE ${me.pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM public.assignments%'`)[0].n>0);
    assert.equal(signedGets,before);await holder`COMMIT`;
  } finally {await holder`ROLLBACK`.catch(()=>{});holder.release();}
  error(await pending,404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before);
});
test('issuance wins assignment lock: revocation waits until the authorized transaction ends; next request denies',async()=>{
  const {s,id}=await ready(),reader=await h.apiPool.reserve(),writer=await h.admin.reserve();let pending;
  try {
    await reader`BEGIN`;await reader`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.user_id',${a.technician.user.id},true),
      set_config('app.membership_id',${a.technician.membershipId},true)`;
    const authz=h.load('authz/resource-authorization.js'),token=authz.createResourceAuthorizationState('media.read',{kind:'resource',scopes:new Set(['assigned'])});
    const ctx={sql:reader,tenant:{tenantId:a.tenantId,userId:a.technician.user.id,membershipId:a.technician.membershipId},resourceAuthorization:token};
    await h.load('media/assigned-authorization.js').authorizeAssignedDownload(ctx,s.mediaAssetId);
    const [me]=await reader`SELECT pg_backend_pid() pid`;
    await writer`BEGIN`;pending=Promise.resolve(writer`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${id}`);
    await until(async()=>(await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE ${me.pid}=ANY(pg_blocking_pids(pid))
      AND query LIKE '%UPDATE assignments%'`)[0].n>0);
    const result=await h.load('media/service.js').getMediaDownloadUrl(reader,f.r2,a.tenantId,s.mediaAssetId);
    assert.ok(result.downloadUrl);authz.assertResourceAuthorizationComplete(token);await reader`COMMIT`;await pending;await writer`COMMIT`;
  } finally {await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();}
  await denied(s);
});
test('upload inspection gap: role revoked to technician prevents finalization and idempotent create replay',async()=>{
  const actor=await h.member('gap');
  await h.admin`INSERT INTO memberships(id,tenant_id,user_id) VALUES(${actor.membershipId=randomUUID()},${a.tenantId},${actor.user.id})`;
  await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
    SELECT ${a.tenantId},${actor.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='service_advisor'`;
  const p=await parent(a),body={mediaType:'photo',mimeType:'image/png',retentionClass:'operational',idempotencyKey:randomUUID(),expectedSizeBytes:f.png.length,
    operationalContext:{type:'reception',receptionId:p.reception}};
  const created=await call('/api/v1/media/upload-sessions',body,'POST',a,actor);assert.equal(created.status,201);
  let enter,release;const entered=new Promise(r=>{enter=r;}),gap=new Promise(r=>{release=r;});
  const objectFetch=f.objectFetch(f.png,'image/png');globalThis.fetch=async(...args)=>{enter();await gap;return objectFetch(...args);};
  const pending=call(`/api/v1/media/upload-sessions/${created.body.uploadSessionId}/complete`,{},'POST',a,actor);
  try {await entered;await h.admin`DELETE FROM membership_roles WHERE membership_id=${actor.membershipId}`;
    await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${actor.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;
  } finally {release();}
  error(await pending,403,'PERMISSION_DENIED');error(await call('/api/v1/media/upload-sessions',body,'POST',a,actor),403,'PERMISSION_DENIED');
  const [asset]=await h.admin`SELECT status FROM media_assets WHERE id=${created.body.mediaAssetId}`;assert.equal(asset.status,'pending_upload');
});
test('missing resource check trips the real API before a successful response',async()=>{
  const {buildApi,getTenantRequestContext}=h.load('api/app.js');
  const probe=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.technician.subject};}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){
      server.get('/api/v1/media/__tripwire',{config:{permission:'media.read',permissionScope:'resource'}},async request=>{
        getTenantRequestContext(request);return {downloadUrl:'must-never-leave'};
      });
    }});
  try {const r=await probe.inject({url:'/api/v1/media/__tripwire',headers:{'x-tenant-id':a.tenantId}});
    assert.equal(r.statusCode,500);assert.equal(r.body.includes('must-never-leave'),false);
  } finally {await probe.close();}
});

for(const [table,column] of [['finding_media','finding_id'],['work_activity_media','work_activity_id'],['quality_check_media','quality_check_id'],['delivery_media','delivery_id'],['quote_media','quote_version_id']]) test(`reserved graph family ${table}: operational appearance cannot authorize disclosure`,async()=>{
  const {p,s}=await ready();
  await corrupt(sql=>sql.unsafe(`INSERT INTO ${table}(tenant_id,${column},media_asset_id,purpose) VALUES($1,$2,$3,'test_disallowed')`,[a.tenantId,randomUUID(),s.mediaAssetId]));
  await denied(s);assert.deepEqual((await list(p,'reception',a,a.technician)).body.media,[]);
});
test('mixed signature reference: full graph overrides apparently operational media metadata',async()=>{
  const {p,s}=await ready();
  await corrupt(sql=>sql`INSERT INTO signatures(id,tenant_id,reception_id,signature_media_id,signed_by_name,document_version,document_hash,signed_at)
    VALUES(${randomUUID()},${a.tenantId},${p.reception},${s.mediaAssetId},'TEST','TEST','TEST',clock_timestamp())`);
  await denied(s);assert.deepEqual((await list(p,'reception',a,a.technician)).body.media,[]);
});
test('two assigned orders with conflicting immutable upload proofs still fail closed',async()=>{
  const own=await ready(),other=await ready();
  await corrupt(async sql=>{
    await sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${other.p.reception},${own.s.mediaAssetId},'intake_evidence')`;
    await sql`UPDATE upload_sessions SET media_asset_id=${own.s.mediaAssetId} WHERE id=${other.s.uploadSessionId}`;
  });
  await denied(own.s);assert.deepEqual((await list(own.p,'reception',a,a.technician)).body.media,[]);
});
for(const change of ['role','membership']) test(`request-start grant stale after ${change} revocation: fresh locked proof denies without signing`,async()=>{
  const {s}=await ready(),holder=await h.admin.reserve();let pending;
  const before=signedGets;
  try {
    await holder`BEGIN`;
    if(change==='role')await holder`DELETE FROM membership_roles WHERE membership_id=${a.technician.membershipId}`;
    else await holder`UPDATE memberships SET status='suspended',suspended_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${a.technician.membershipId}`;
    const [me]=await holder`SELECT pg_backend_pid() pid`;
    pending=download(s);await until(async()=>(await h.admin`SELECT count(*)::int n FROM pg_stat_activity
      WHERE ${me.pid}=ANY(pg_blocking_pids(pid)) AND query LIKE '%app.lock_current_tenant_owner_set%'`)[0].n>0);
    assert.equal(signedGets,before);await holder`COMMIT`;
    error(await pending,404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before);
  } finally {
    await holder`ROLLBACK`.catch(()=>{});holder.release();
    if(change==='role')await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${a.technician.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;
    else await corrupt(sql=>sql`UPDATE memberships SET status='active',suspended_at=NULL,updated_at=clock_timestamp() WHERE id=${a.technician.membershipId}`);
  }
});
