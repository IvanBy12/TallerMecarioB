'use strict';
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Writable } = require('node:stream');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const http = require('node:http');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { parent } = require('./operational-helpers.cjs');
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { createOrderMediaCursor, loadOrderMediaCursor } = h.load('media/order-query-cursor.js');
const { listOrderMedia } = h.load('media/order-query.js');
const { withOrderMediaLimits } = h.load('media/order-query-limits.js');
const authz = h.load('authz/resource-authorization.js');
const retention = h.load('media/retention.js');
const f = require('../media/fixtures.cjs');
const originalFetch = globalThis.fetch;
const signer = h.load('media/r2.js'), originalSign = signer.presignR2Url;
let a, b, app, port, signedGets = 0, storageCalls = 0;
const logs = [];
const key = randomBytes(32), codec = createOrderMediaCursor('current', new Map([['current', key]]));
signer.presignR2Url = (config, options) => { if(options.method==='GET') signedGets++; return originalSign(config, options); };
before(async () => {
  ({ a, b } = await h.twoTenants([{label:'other',roles:['technician']} ]));
  app = await buildApi({ database:h.apiPool,
    identityProvider:{async verifyRequest(request){ const subject=request.headers.authorization?.slice(7);
      return subject?{identityProvider:'clerk',externalSubject:subject}:null; }},
    rateLimit:{max:100000,timeWindow:'1 minute'},
    logStream:new Writable({write(chunk,_e,done){logs.push(chunk.toString());done();}}),
    registerRoutes(server){
      const post=server.post;
      server.post=function(url,options,handler){options.config.rateLimit={max:100000,timeWindow:'1 minute'};return post.call(this,url,options,handler);};
      try {registerMediaRoutes(server,f.r2,codec);registerReceptionRoutes(server);} finally {server.post=post;}
    },
  });
  await app.listen({host:'127.0.0.1',port:0});port=app.server.address().port;
});
after(async()=>{globalThis.fetch=originalFetch;signer.presignR2Url=originalSign;await h.closeAll(app);});
function call(path, payload, method='GET', t=a, actor=t.owner){
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?undefined:JSON.stringify(payload);
    const req=http.request({host:'127.0.0.1',port,path,method,agent:false,headers:{
      ...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)}),
      ...(actor?{authorization:`Bearer ${actor.subject}`} : {}),'x-tenant-id':t.tenantId,
    }},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});
    req.on('error',reject);req.end(body);
  });
}
const url=(order,query='')=>`/api/v1/orders/${order}/media${query?'?'+query:''}`;
const list=(order,query='',t=a,actor=t.owner)=>call(url(order,query),undefined,'GET',t,actor);
const download=(asset,t=a,actor=t.owner)=>call(`/api/v1/media/${asset}/download-url`,undefined,'GET',t,actor);
function error(result,status,code,noStore=true){assert.equal(result.status,status,JSON.stringify(result.body));assert.equal(result.body.error.code,code);
  if(noStore)assert.equal(result.headers['cache-control'],'no-store');}
async function corrupt(fn){await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await fn(tx);});}
async function upload(p,type='reception',mediaType='photo',sortOrder=0,t=a){
  const bytes=mediaType==='photo'?f.png:readFileSync(join(__dirname,'../media/fixtures/clip.mp4'));
  const mime=mediaType==='photo'?'image/png':'video/mp4';
  const created=await call('/api/v1/media/upload-sessions',{mediaType,mimeType:mime,retentionClass:'operational',
    idempotencyKey:randomUUID(),expectedSizeBytes:bytes.length,operationalContext:type==='reception'?{type,receptionId:p.reception}:{type,damageId:p.damage}},'POST',t);
  assert.equal(created.status,201,JSON.stringify(created.body));
  const objectFetch=f.objectFetch(bytes,mime);globalThis.fetch=async(...args)=>{storageCalls++;return objectFetch(...args);};
  const completed=await call(`/api/v1/media/upload-sessions/${created.body.uploadSessionId}/complete`,{},'POST',t);
  assert.equal(completed.status,200,JSON.stringify(completed.body));
  const attached=await call(`/api/v1/receptions/${p.reception}${type==='damage'?'/damages/'+p.damage:''}/media`,
    {mediaAssetId:created.body.mediaAssetId,sortOrder},'POST',t);
  assert.equal(attached.status,201,JSON.stringify(attached.body));
  return {...created.body,dto:attached.body.media};
}
async function close(p,kind='lead_technician',t=a,actor=t.technician){
  const result=await call(`/api/v1/receptions/${p.reception}/close`,undefined,'POST',t);
  assert.equal(result.status,200,JSON.stringify(result.body));
  const order=result.body.serviceOrder.id,id=randomUUID();
  if(kind!=='none')await h.admin`INSERT INTO assignments(id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
    VALUES(${id},${t.tenantId},${order},${actor.membershipId},${kind},${t.owner.membershipId})`;
  return {order,assignment:kind==='none'?null:id};
}
async function ready(type='reception',kind='lead_technician',t=a){
  const p=await parent(t),s=await upload(p,type,'photo',0,t);return {p,s,...await close(p,kind,t)};
}
async function until(check){const deadline=performance.now()+10000;
  while(performance.now()<deadline){if(await check())return;await yieldTurn();}throw Error('PostgreSQL barrier timeout');}
async function blockedBy(pid,pattern='%'){
  return (await h.admin`SELECT count(*)::int n FROM pg_stat_activity
    WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND query LIKE ${pattern}`)[0].n>0;
}
async function context(reader,actor=a.owner,t=a){
  await reader`BEGIN`;
  await reader`SELECT set_config('app.tenant_id',${t.tenantId},true),set_config('app.user_id',${actor.user.id},true),
    set_config('app.membership_id',${actor.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
  return {sql:reader,tenant:{tenantId:t.tenantId,userId:actor.user.id,membershipId:actor.membershipId},
    resourceAuthorization:authz.createResourceAuthorizationState('media.read',actor===t.technician?
      {kind:'resource',scopes:new Set(['assigned'])}:{kind:'tenant'})};
}

for(const actor of ['owner','admin','advisor'])test(`order query ${actor}: aggregates reception and damages without assignment or side effects`,async()=>{
  const p=await parent(a),r=await upload(p),d=await upload(p,'damage','video360'),{order}=await close(p,'none');
  const before=await h.tenantAuditCount(a.tenantId),calls=storageCalls,signs=signedGets;
  const rows=await h.admin`SELECT id,xmin::text AS version FROM media_assets WHERE id=ANY(${[r.mediaAssetId,d.mediaAssetId]}::uuid[]) ORDER BY id`;
  const response=await list(order,'',a,a[actor]);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.body.nextCursor,null);
  assert.deepEqual(response.body.media,[{...r.dto,source:{type:'reception',receptionId:p.reception}},
    {...d.dto,source:{type:'damage',receptionId:p.reception,damageId:p.damage}}]);
  assert.equal(await h.tenantAuditCount(a.tenantId),before);assert.equal(storageCalls,calls);assert.equal(signedGets,signs);
  assert.deepEqual(await h.admin`SELECT id,xmin::text AS version FROM media_assets WHERE id=ANY(${[r.mediaAssetId,d.mediaAssetId]}::uuid[]) ORDER BY id`,rows);
  for(const value of [r.objectKey,r.uploadUrl,d.objectKey,d.uploadUrl,f.r2.bucket])assert.equal(JSON.stringify(response.body).includes(value),false);
});
for(const type of ['reception','damage'])for(const mediaType of ['photo','video','video360'])test(`order source ${type}/${mediaType}: assigned list and existing download agree`,async()=>{
  const p=await parent(a),s=await upload(p,type,mediaType),{order}=await close(p,'support_technician');
  const response=await list(order,'',a,a.technician);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.media.length,1);assert.equal(response.body.media[0].mediaAssetId,s.mediaAssetId);
  assert.equal(response.body.media[0].mediaType,mediaType);assert.equal(response.body.media[0].source.type,type);
  assert.equal((await download(s.mediaAssetId,a,a.technician)).status,200);
});
for(const state of h.load('db/schema.js').SERVICE_ORDER_STATUSES)test(`order state ${state}: tenant and assigned read; uploads remain closed`,async()=>{
  const {p,s,order}=await ready();
  await h.admin`UPDATE service_orders SET status=${state},closed_at=${['delivered','cancelled'].includes(state)?new Date():null} WHERE id=${order}`;
  for(const actor of [a.owner,a.technician]){const result=await list(order,'',a,actor);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.media[0].mediaAssetId,s.mediaAssetId);}
  error(await call('/api/v1/media/upload-sessions',{mediaType:'photo',mimeType:'image/png',retentionClass:'operational',
    expectedSizeBytes:f.png.length,idempotencyKey:randomUUID(),operationalContext:{type:'reception',receptionId:p.reception}},'POST',a,a.technician),403,'PERMISSION_DENIED',false);
});
for(const kind of ['none','quality_control','released'])test(`order ${kind}: non-disclosing 404 before cursor validation`,async()=>{
  const {order,assignment}=await ready('reception',kind==='released'?'lead_technician':kind);
  if(kind==='released')await h.admin`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${assignment}`;
  const response=await list(order,'cursor=bad',a,a.technician);error(response,404,'SERVICE_ORDER_NOT_FOUND');assert.deepEqual(Object.keys(response.body),['error']);
});
test('order missing/foreign/malformed have the same error; no permission and no identity remain explicit',async()=>{
  const foreign=await ready('reception','lead_technician',b),{order}=await ready();
  const shapes=[];
  for(const id of [foreign.order,randomUUID(),'invalid']){const r=await list(id);error(r,404,'SERVICE_ORDER_NOT_FOUND');shapes.push({...r.body.error,request_id:null});}
  assert.deepEqual(shapes[0],shapes[1]);assert.deepEqual(shapes[1],shapes[2]);
  error(await list(order,'',a,null),401,'AUTHENTICATION_REQUIRED');
  const role=await h.admin`DELETE FROM membership_roles WHERE membership_id=${a.other.membershipId} RETURNING role_id`;
  try {error(await list('invalid','cursor=bad',a,a.other),403,'PERMISSION_DENIED');}
  finally{for(const row of role)await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
    VALUES(${a.tenantId},${a.other.membershipId},${row.role_id},${a.owner.membershipId})`;}
});
test('empty order still checks assignment and returns a real empty page',async()=>{
  const p=await parent(a),{order,assignment}=await close(p);
  assert.deepEqual((await list(order,'',a,a.technician)).body,{media:[],nextCursor:null});
  await h.admin`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${assignment}`;
  error(await list(order,'',a,a.technician),404,'SERVICE_ORDER_NOT_FOUND');
});
for(const query of ['limit=0','limit=101','limit=1.5','limit=01','limit=-1','limit=1&limit=2','cursor=','cursor=x&cursor=y','offset=1','tenantId=x'])test(`strict order query rejects ${query}`,async()=>{
  const {order}=await ready();error(await list(order,query),400,'REQUEST_VALIDATION_FAILED');
});
test('cursor keyring validates configuration and rotates without exposing keys or context',()=>{
  assert.equal(loadOrderMediaCursor({}),undefined);
  for(const value of ['', '{}','null',JSON.stringify({activeKeyId:'missing',keys:{}}),JSON.stringify({activeKeyId:'a',keys:{a:'bad'}})])
    assert.throws(()=>loadOrderMediaCursor({MEDIA_ORDER_CURSOR_KEY:value}),/MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID/);
  const cfg={activeKeyId:'old',keys:{old:key.toString('base64url')}};
  assert.ok(loadOrderMediaCursor({MEDIA_ORDER_CURSOR_KEY:JSON.stringify(cfg)}));
  let now=1000000;const old=createOrderMediaCursor('old',new Map([['old',key]]),()=>now);
  const ctx={tenantId:randomUUID(),orderId:randomUUID(),userId:randomUUID(),membershipId:randomUUID(),limit:20};
  const position=[0,randomUUID(),0,randomUUID(),'intake_evidence'];
  const token=old.encode(ctx,position),rotated=createOrderMediaCursor('new',new Map([['old',key],['new',randomBytes(32)]]),()=>now);
  assert.deepEqual(rotated.decode(token,ctx),position);assert.notEqual(old.encode(ctx,position),token);
  for(const id of [...Object.values(ctx),...position])if(typeof id==='string')assert.equal(token.includes(id),false);
  const retired=createOrderMediaCursor('new',new Map([['new',randomBytes(32)]]),()=>now);
  assert.throws(()=>retired.decode(token,ctx));now+=900000;assert.throws(()=>old.decode(token,ctx));
});
for(const field of ['tenantId','orderId','userId','membershipId','limit'])test(`cursor rejects changed verified ${field}`,()=>{
  const ctx={tenantId:randomUUID(),orderId:randomUUID(),userId:randomUUID(),membershipId:randomUUID(),limit:20};
  const token=codec.encode(ctx,[0,randomUUID(),0,randomUUID(),'intake_evidence']);
  assert.throws(()=>codec.decode(token,{...ctx,[field]:field==='limit'?21:randomUUID()}),e=>e.code==='REQUEST_VALIDATION_FAILED');
});
test('cursor tamper/version/oversize/noncanonical input all fail with one safe error',()=>{
  const ctx={tenantId:randomUUID(),orderId:randomUUID(),userId:randomUUID(),membershipId:randomUUID(),limit:20};
  const token=codec.encode(ctx,[1,randomUUID(),2147483647,randomUUID(),'damage_evidence']);
  for(const value of ['',token+'.x',token.replace('v1.','v2.'),'x'.repeat(2049),token.slice(0,-4)+'AAAA',token+'='])
    assert.throws(()=>codec.decode(value,ctx),e=>e.statusCode===400&&e.message==='The request query is invalid.');
});
test('keyset pages preserve source order/ties; windows can be empty with continuation and no leaked cursor IDs',async()=>{
  const p=await parent(a),ss=[];
  for(let i=0;i<4;i++)ss.push(await upload(p));
  const damage=await upload(p,'damage'),{order}=await close(p);
  const sorted=ss.map(s=>s.mediaAssetId).sort();
  await corrupt(tx=>tx`UPDATE media_assets SET status='quarantined',quarantined_at=clock_timestamp() WHERE id=${sorted[0]}`);
  const first=await list(order,'limit=1',a,a.technician);assert.equal(first.status,200,JSON.stringify(first.body));assert.deepEqual(first.body.media,[]);assert.ok(first.body.nextCursor);
  assert.equal(first.body.nextCursor.includes(sorted[0]),false);
  let cursor=first.body.nextCursor;const ids=[];
  while(cursor){const response=await list(order,'limit=1&cursor='+encodeURIComponent(cursor),a,a.technician);
    assert.equal(response.status,200,JSON.stringify(response.body));ids.push(...response.body.media.map(m=>m.mediaAssetId));cursor=response.body.nextCursor;}
  assert.deepEqual(ids,[...sorted.slice(1),damage.mediaAssetId]);assert.equal(new Set(ids).size,ids.length);
  error(await list(order,'limit=2&cursor='+encodeURIComponent(first.body.nextCursor),a,a.technician),400,'REQUEST_VALIDATION_FAILED');
  const other=await ready();error(await list(other.order,'limit=1&cursor='+encodeURIComponent(first.body.nextCursor),a,a.technician),400,'REQUEST_VALIDATION_FAILED');
  error(await list(order,'limit=1&cursor='+encodeURIComponent(first.body.nextCursor),a,a.owner),400,'REQUEST_VALIDATION_FAILED');
  const output=logs.join('');assert.equal(output.includes(first.body.nextCursor),false);assert.equal(output.includes(sorted[0]),false);
});
for(const flag of ['quarantined','deleted','pending_upload','uploaded','deletion_requested_at','deleted_at','purged_at','quarantined_at','integrity_failure_code','signature','document'])test(`order omits unavailable ${flag} for tenant and assigned`,async()=>{
  const {s,order}=await ready();
  await corrupt(tx=>['quarantined','deleted','pending_upload','uploaded'].includes(flag)?tx`UPDATE media_assets SET status=${flag} WHERE id=${s.mediaAssetId}`:
    ['signature','document'].includes(flag)?tx`UPDATE media_assets SET media_type=${flag},retention_class=${flag==='signature'?'authorization_evidence':'document'} WHERE id=${s.mediaAssetId}`:
    flag==='integrity_failure_code'?tx`UPDATE media_assets SET status='quarantined',integrity_failure_code='MEDIA_CONTENT_INVALID',quarantined_at=clock_timestamp() WHERE id=${s.mediaAssetId}`:
    tx.unsafe(`UPDATE media_assets SET ${flag}=clock_timestamp()${flag==='purged_at'?',deleted_at=clock_timestamp()':''} WHERE id=$1`,[s.mediaAssetId]));
  for(const actor of [a.owner,a.technician]){const r=await list(order,'',a,actor);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{media:[],nextCursor:null});}
});
for(const [table,column] of [['finding_media','finding_id'],['work_activity_media','work_activity_id'],['quality_check_media','quality_check_id'],['delivery_media','delivery_id'],['quote_media','quote_version_id'],['signatures','signature_media_id'],['privacy_consents','evidence_media_id']])test(`order denies mixed sensitive/reserved ${table}, including tenant-wide`,async()=>{
  const {p,s,order}=await ready();
  await corrupt(async tx=>{
    if(table==='privacy_consents')await tx`UPDATE privacy_consents SET evidence_media_id=${s.mediaAssetId} WHERE id=${p.consent}`;
    else if(table==='signatures')await tx`INSERT INTO signatures(id,tenant_id,reception_id,signature_media_id,signed_by_name,document_version,document_hash,signed_at)
      VALUES(${randomUUID()},${a.tenantId},${p.reception},${s.mediaAssetId},'TEST','TEST','TEST',clock_timestamp())`;
    else await tx.unsafe(`INSERT INTO ${table}(tenant_id,${column},media_asset_id,purpose) VALUES($1,$2,$3,'test_reserved')`,[a.tenantId,randomUUID(),s.mediaAssetId]);
  });
  for(const actor of [a.owner,a.technician])assert.deepEqual((await list(order,'',a,actor)).body,{media:[],nextCursor:null});
});
for(const legacy of ['no-binding','no-sessions','mixed-proof','incomplete','contradictory','multi-origin'])test(`order legacy ${legacy}: strict tenant exception never weakens assigned`,async()=>{
  const {p,s,order}=await ready();
  if(legacy==='contradictory'||legacy==='mixed-proof'){
    const other=await ready();
    await corrupt(async tx=>{await tx`UPDATE upload_sessions SET media_asset_id=${s.mediaAssetId} WHERE id=${other.s.uploadSessionId}`;
      if(legacy==='mixed-proof')await tx`DELETE FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;});
  }else await corrupt(async tx=>{
    await tx`DELETE FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    if(legacy==='no-sessions')await tx`DELETE FROM upload_sessions WHERE id=${s.uploadSessionId}`;
    if(legacy==='incomplete')await tx`UPDATE upload_sessions SET status='failed',completed_at=NULL WHERE id=${s.uploadSessionId}`;
    if(legacy==='multi-origin')await tx`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${p.damage},${s.mediaAssetId},'damage_evidence')`;
    await tx`UPDATE media_assets SET size_bytes=NULL,captured_at=NULL,uploaded_at=NULL WHERE id=${s.mediaAssetId}`;
  });
  const tenant=await list(order),assigned=await list(order,'',a,a.technician);
  assert.equal(tenant.status,200,JSON.stringify(tenant.body));assert.equal(assigned.status,200,JSON.stringify(assigned.body));
  assert.deepEqual(assigned.body.media,[]);
  assert.equal(tenant.body.media.length,['no-binding','no-sessions'].includes(legacy)?1:0);
  if(tenant.body.media.length){assert.equal(tenant.body.media[0].sizeBytes,null);assert.equal(tenant.body.media[0].uploadedAt,null);}
});
test('later consent revocation and retention/hold dates do not revoke authorized historical reads',async()=>{
  const {p,s,order}=await ready();
  await h.admin`UPDATE privacy_consents SET status='revoked',revoked_at=clock_timestamp() WHERE id=${p.consent}`;
  await h.admin`UPDATE media_assets SET legal_hold_until=clock_timestamp()+interval '1 day' WHERE id=${s.mediaAssetId}`;
  for(const actor of [a.owner,a.technician]){const r=await list(order,'',a,actor);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.media[0].mediaAssetId,s.mediaAssetId);}
});
test('equivalent completed sessions yield one asset, binding without a final link yields none',async()=>{
  const {p,s,order}=await ready();
  await corrupt(async tx=>{
    const id=randomUUID();
    await tx`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,status,expected_size_bytes,completed_at,expires_at)
      SELECT ${id},tenant_id,media_asset_id,${randomUUID()},status,expected_size_bytes,completed_at,expires_at FROM upload_sessions WHERE id=${s.uploadSessionId}`;
    await tx`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,damage_id,privacy_consent_id,authorized_at,created_at)
      SELECT tenant_id,${id},reception_id,damage_id,privacy_consent_id,authorized_at,created_at FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
  });
  assert.equal((await list(order,'',a,a.technician)).body.media.length,1);
  await corrupt(tx=>tx`DELETE FROM reception_media WHERE reception_id=${p.reception}`);
  assert.deepEqual((await list(order)).body,{media:[],nextCursor:null});
});
test('complete reference inventory is bounded before graph materialization; no truncation authorizes',async()=>{
  const {s,order}=await ready();
  await corrupt(tx=>tx`INSERT INTO quote_media(tenant_id,quote_version_id,media_asset_id,purpose)
    SELECT ${a.tenantId},gen_random_uuid(),${s.mediaAssetId},'test_reserved' FROM generate_series(1,1001)`);
  for(const actor of [a.owner,a.technician])error(await list(order,'',a,actor),503,'MEDIA_QUERY_LIMIT_EXCEEDED');
});
for(const change of ['assignment','role','membership'])test(`order ${change} revocation wins: no stale grant disclosure`,async()=>{
  const {order,assignment}=await ready(),writer=await h.admin.reserve();let pending;
  try{
    await writer`BEGIN`;
    if(change==='assignment')await writer`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${assignment}`;
    else if(change==='role')await writer`DELETE FROM membership_roles WHERE membership_id=${a.technician.membershipId}`;
    else await writer`UPDATE memberships SET status='suspended',suspended_at=clock_timestamp() WHERE id=${a.technician.membershipId}`;
    const [{pid}]=await writer`SELECT pg_backend_pid() pid`;
    pending=list(order,'',a,a.technician);await until(()=>blockedBy(pid));await writer`COMMIT`;
    error(await pending,404,'SERVICE_ORDER_NOT_FOUND');
  }finally{
    await writer`ROLLBACK`.catch(()=>{});writer.release();
    if(change==='role')await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${a.technician.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;
    if(change==='membership')await corrupt(tx=>tx`UPDATE memberships SET status='active',suspended_at=NULL WHERE id=${a.technician.membershipId}`);
  }
});
for(const change of ['assignment','role','membership'])test(`order reader wins: ${change} revocation waits through transaction`,async()=>{
  const {order,assignment}=await ready(),reader=await h.apiPool.reserve(),writer=await h.admin.reserve();let pending;
  try{
    const ctx=await context(reader,a.technician);const response=await listOrderMedia(ctx,order,{},undefined,codec);
    assert.equal(response.media.length,1);authz.assertResourceAuthorizationComplete(ctx.resourceAuthorization);
    const [{pid}]=await reader`SELECT pg_backend_pid() pid`;await writer`BEGIN`;
    pending=Promise.resolve(change==='assignment'?writer`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${assignment}`:
      change==='role'?writer`DELETE FROM membership_roles WHERE membership_id=${a.technician.membershipId}`:
        writer`UPDATE memberships SET status='suspended',suspended_at=clock_timestamp() WHERE id=${a.technician.membershipId}`);
    await until(()=>blockedBy(pid));await reader`COMMIT`;await pending;await writer`COMMIT`;
    const denied=await list(order,'',a,a.technician);assert.ok([403,404].includes(denied.status));
  }finally{
    await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();
    if(change==='role')await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${a.technician.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;
    if(change==='membership')await corrupt(tx=>tx`UPDATE memberships SET status='active',suspended_at=NULL WHERE id=${a.technician.membershipId}`);
  }
});
for(const wins of ['reader','quarantine'])test(`order ${wins} wins lifecycle race: shared locks and fresh availability`,async()=>{
  const {s,order}=await ready(),reader=await h.apiPool.reserve(),writer=await h.admin.reserve();let pending;
  try{
    if(wins==='reader'){
      const ctx=await context(reader);await listOrderMedia(ctx,order,{},undefined,codec);
      const [{pid}]=await reader`SELECT pg_backend_pid() pid`;await writer`BEGIN`;
      pending=Promise.resolve(writer`UPDATE media_assets SET status='quarantined',quarantined_at=clock_timestamp() WHERE id=${s.mediaAssetId}`);
      await until(()=>blockedBy(pid));await reader`COMMIT`;await pending;await writer`COMMIT`;
      assert.deepEqual((await list(order)).body.media,[]);
    }else{
      await writer`BEGIN`;await writer`UPDATE media_assets SET status='quarantined',quarantined_at=clock_timestamp() WHERE id=${s.mediaAssetId}`;
      const [{pid}]=await writer`SELECT pg_backend_pid() pid`;pending=list(order);await until(()=>blockedBy(pid));await writer`COMMIT`;
      const response=await pending;assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body.media,[]);
    }
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();}
});
test('real 2-second lock timeout returns safe retry without partial data',async()=>{
  const {s,order}=await ready(),writer=await h.admin.reserve();
  try{await writer`BEGIN`;await writer`SELECT id FROM media_assets WHERE id=${s.mediaAssetId} FOR UPDATE`;
    const start=performance.now();error(await list(order),503,'MEDIA_QUERY_RETRY');assert.ok(performance.now()-start>=1800);assert.ok(performance.now()-start<6000);
  }finally{await writer`ROLLBACK`;writer.release();}
});
test('real 8-second statement timeout cancels SQL before releasing the transaction',async()=>{
  const reader=await h.apiPool.reserve();
  try{await context(reader);const start=performance.now();
    await assert.rejects(withOrderMediaLimits(reader,sql=>sql`SELECT pg_sleep(10)`),e=>e.code==='MEDIA_QUERY_RETRY');
    assert.ok(performance.now()-start>=7500);assert.ok(performance.now()-start<12000);
    await reader`ROLLBACK`;assert.equal((await reader`SELECT 1 AS n`)[0].n,1);
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();}
});
test('15-second operation deadline spans multiple valid SQL statements and awaits cancellation',async()=>{
  const reader=await h.apiPool.reserve();
  try{await context(reader);const start=performance.now();
    await assert.rejects(withOrderMediaLimits(reader,async sql=>{for(let i=0;i<4;i++)await sql`SELECT pg_sleep(5)`;}),e=>e.code==='MEDIA_QUERY_RETRY');
    assert.ok(performance.now()-start>=14500);assert.ok(performance.now()-start<19000);
    await reader`ROLLBACK`;assert.equal((await reader`SELECT 1 AS n`)[0].n,1);
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();}
});

// Compatibility regression: this test is run against the uncorrected tenant
// download path first. The tombstone has not committed when GET starts.
test('tenant download: deletion wins and no stale presigned URL can escape',async()=>{
  const asset=randomUUID();
  await h.admin`INSERT INTO media_assets(id,tenant_id,media_type,mime_type,status,retention_class,retention_policy_version,bucket,object_key,uploaded_at)
    VALUES(${asset},${a.tenantId},'photo','image/png','active','operational','v1',${f.r2.bucket},${randomUUID()},'2020-01-01')`;
  const writer=await h.apiPool.reserve();let pending,outcome;
  const before=signedGets;
  try{
    await context(writer);await h.load('media/deletion.js').removeUnattachedMedia(writer,asset);
    const [{pid}]=await writer`SELECT pg_backend_pid() pid`;
    pending=download(asset).then(result=>{outcome=result;return result;});
    await until(async()=>outcome!==undefined||await blockedBy(pid));
    assert.equal(outcome,undefined,'tenant-wide GET must wait behind the tombstone, not sign the stale active snapshot');
    assert.equal(signedGets,before);await writer`COMMIT`;
    error(await pending,404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before);
  }finally{await writer`ROLLBACK`.catch(()=>{});writer.release();if(pending)await pending;}
});

async function cloneEvidence(p, s, count, type='reception') {
  const ids=[];
  await corrupt(async tx=>{
    const [asset]=await tx`SELECT * FROM media_assets WHERE id=${s.mediaAssetId}`;
    const [session]=await tx`SELECT * FROM upload_sessions WHERE id=${s.uploadSessionId}`;
    const [binding]=await tx`SELECT * FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    for(let i=0;i<count;i++){
      const id=randomUUID(),sessionId=randomUUID();ids.push(id);
      await tx`INSERT INTO media_assets ${tx({...asset,id,object_key:randomUUID()})}`;
      await tx`INSERT INTO upload_sessions ${tx({...session,id:sessionId,media_asset_id:id,idempotency_key:randomUUID()})}`;
      await tx`INSERT INTO media_upload_bindings ${tx({...binding,upload_session_id:sessionId})}`;
      if(type==='reception')await tx`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose,sort_order)
        VALUES(${a.tenantId},${p.reception},${id},'intake_evidence',0)`;
      else await tx`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose,sort_order)
        VALUES(${a.tenantId},${p.damage},${id},'damage_evidence',0)`;
    }
  });
  return ids;
}
test('bounded large gallery: default 20, maximum 100, all evidence across pages with deterministic ties',async()=>{
  const {p,s,order}=await ready(),ids=[s.mediaAssetId,...await cloneEvidence(p,s,104)].sort();
  const first=await list(order,'',a,a.technician);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.media.length,20);
  const times=[],all=[];
  for(let run=0;run<3;run++){
    let cursor;const found=[];let pages=0;
    do{
      const started=performance.now();const result=await list(order,'limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),a,a.technician);
      times.push(performance.now()-started);assert.equal(result.status,200,JSON.stringify(result.body));
      found.push(...result.body.media.map(m=>m.mediaAssetId));cursor=result.body.nextCursor;pages++;
    }while(cursor);
    assert.equal(pages,2);assert.deepEqual(found,ids);all.push(...found);
  }
  assert.ok(Math.max(...times)<15000);assert.equal(all.length,315);
  console.log('ORDER_MEDIA_LOAD_PASS assets=105 repetitions=3 page_size=100 pages=6 max_ms='+Math.ceil(Math.max(...times)));
});
test('graph budget boundary: exactly 1000 reference/session/parent rows succeeds, growth fails closed',async()=>{
  const {p,s,order}=await ready('damage');
  await corrupt(async tx=>{
    const [session]=await tx`SELECT * FROM upload_sessions WHERE id=${s.uploadSessionId}`;
    const [binding]=await tx`SELECT * FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    for(let i=0;i<497;i++){
      const id=randomUUID();await tx`INSERT INTO upload_sessions ${tx({...session,id,idempotency_key:randomUUID()})}`;
      await tx`INSERT INTO media_upload_bindings ${tx({...binding,upload_session_id:id})}`;
    }
  });
  const result=await list(order,'',a,a.technician);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.media.length,1);
  await corrupt(async tx=>{
    const [session]=await tx`SELECT * FROM upload_sessions WHERE id=${s.uploadSessionId}`;
    const [binding]=await tx`SELECT * FROM media_upload_bindings WHERE upload_session_id=${s.uploadSessionId}`;
    const id=randomUUID();await tx`INSERT INTO upload_sessions ${tx({...session,id,idempotency_key:randomUUID()})}`;
    await tx`INSERT INTO media_upload_bindings ${tx({...binding,upload_session_id:id})}`;
  });
  error(await list(order,'',a,a.technician),503,'MEDIA_QUERY_LIMIT_EXCEEDED');
});
test('growth during discovery exceeds the same budget after locks and cannot authorize a partial graph',async()=>{
  const {s,order}=await ready(),holder=await h.admin.reserve();let pending;
  try{
    await holder`BEGIN`;await holder`SELECT id FROM media_assets WHERE id=${s.mediaAssetId} FOR UPDATE`;
    const [{pid}]=await holder`SELECT pg_backend_pid() pid`;pending=list(order);
    await until(()=>blockedBy(pid,'%FROM public.media_assets%'));
    // Privileged fixture corruption is committed by the lock holder while the
    // normal reader waits. The runtime reader keeps every guard/RLS enabled.
    await holder`SET LOCAL session_replication_role=replica`;
    await holder`INSERT INTO quote_media(tenant_id,quote_version_id,media_asset_id,purpose)
      SELECT ${a.tenantId},gen_random_uuid(),${s.mediaAssetId},'test_reserved' FROM generate_series(1,1001)`;
    await holder`COMMIT`;error(await pending,503,'MEDIA_QUERY_LIMIT_EXCEEDED');
  }finally{await holder`ROLLBACK`.catch(()=>{});holder.release();if(pending)await pending;}
});
test('new parent during discovery fails with lineage conflict rather than locking a parent late',async()=>{
  const first=await ready(),other=await ready(),holder=await h.admin.reserve();let pending;
  try{
    await holder`BEGIN`;await holder`SELECT id FROM media_assets WHERE id=${first.s.mediaAssetId} FOR UPDATE`;
    const [{pid}]=await holder`SELECT pg_backend_pid() pid`;pending=list(first.order);
    await until(()=>blockedBy(pid,'%FROM public.media_assets%'));await holder`SET LOCAL session_replication_role=replica`;
    await holder`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
      VALUES(${a.tenantId},${other.p.reception},${first.s.mediaAssetId},'intake_evidence')`;
    await holder`COMMIT`;error(await pending,409,'MEDIA_ASSOCIATION_CONFLICT');
  }finally{await holder`ROLLBACK`.catch(()=>{});holder.release();if(pending)await pending;}
});
test('cross-order references hidden outside a page still deny the entire asset',async()=>{
  const first=await ready(),other=await ready();
  await corrupt(tx=>tx`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
    VALUES(${a.tenantId},${other.p.reception},${first.s.mediaAssetId},'intake_evidence')`);
  for(const actor of [a.owner,a.technician]){assert.deepEqual((await list(first.order,'limit=1',a,actor)).body.media,[]);
    const result=await list(other.order,'limit=1',a,actor);assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.media.some(m=>m.mediaAssetId===first.s.mediaAssetId),false);}
});
test('cursor does not preserve access after assignment release between pages',async()=>{
  const p=await parent(a),ss=[await upload(p),await upload(p)],{order,assignment}=await close(p);
  const first=await list(order,'limit=1',a,a.technician);assert.equal(first.status,200);assert.ok(first.body.nextCursor);
  await h.admin`UPDATE assignments SET released_at=clock_timestamp() WHERE id=${assignment}`;
  error(await list(order,'limit=1&cursor='+encodeURIComponent(first.body.nextCursor),a,a.technician),404,'SERVICE_ORDER_NOT_FOUND');
  assert.equal((await download(ss[0].mediaAssetId,a,a.technician)).status,404);
});
test('asset becomes unavailable after listing: subsequent download cannot issue a new URL',async()=>{
  const {s,order}=await ready();assert.equal((await list(order,'',a,a.technician)).body.media[0].mediaAssetId,s.mediaAssetId);
  await h.admin`UPDATE media_assets SET status='quarantined',quarantined_at=clock_timestamp() WHERE id=${s.mediaAssetId}`;
  const before=signedGets;assert.equal((await download(s.mediaAssetId,a,a.technician)).status,404);assert.equal(signedGets,before);
});
for(const field of ['role','membership'])test(`tenant-wide stale ${field} grant never signs or lists`,async()=>{
  const actor=await h.member('tenant-stale');actor.membershipId=randomUUID();
  await h.admin`INSERT INTO memberships(id,tenant_id,user_id) VALUES(${actor.membershipId},${a.tenantId},${actor.user.id})`;
  await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
    SELECT ${a.tenantId},${actor.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='service_advisor'`;
  const {s,order}=await ready(),writer=await h.admin.reserve();let listPending,downloadPending;
  try{
    await writer`BEGIN`;
    if(field==='role')await writer`DELETE FROM membership_roles WHERE membership_id=${actor.membershipId}`;
    else await writer`UPDATE memberships SET status='suspended',suspended_at=clock_timestamp() WHERE id=${actor.membershipId}`;
    const [{pid}]=await writer`SELECT pg_backend_pid() pid`;const before=signedGets;
    listPending=list(order,'',a,actor);downloadPending=download(s.mediaAssetId,a,actor);
    await until(async()=> (await h.admin`SELECT count(*)::int n FROM pg_stat_activity
      WHERE ${pid}=ANY(pg_blocking_pids(pid))`)[0].n>=2);
    await writer`COMMIT`;error(await listPending,404,'SERVICE_ORDER_NOT_FOUND');
    error(await downloadPending,404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before);
  }finally{await writer`ROLLBACK`.catch(()=>{});writer.release();if(listPending)await listPending;if(downloadPending)await downloadPending;}
});
test('tenant download reader wins: deletion waits until signed issuance commits, then future issuance denies',async()=>{
  const asset=randomUUID();await h.admin`INSERT INTO media_assets(id,tenant_id,media_type,mime_type,status,retention_class,retention_policy_version,bucket,object_key,uploaded_at)
    VALUES(${asset},${a.tenantId},'photo','image/png','active','operational','v1',${f.r2.bucket},${randomUUID()},'2020-01-01')`;
  const reader=await h.apiPool.reserve(),writer=await h.apiPool.reserve();let pending;
  try{
    const ctx=await context(reader);await h.load('media/download-authorization.js').authorizeTenantDownload(ctx,asset);
    const [{pid}]=await reader`SELECT pg_backend_pid() pid`;await context(writer);
    pending=Promise.resolve(h.load('media/deletion.js').removeUnattachedMedia(writer,asset));
    await until(()=>blockedBy(pid));
    const result=await h.load('media/service.js').getMediaDownloadUrl(reader,f.r2,a.tenantId,asset);assert.ok(result.downloadUrl);
    await reader`COMMIT`;await pending;await writer`COMMIT`;
    error(await download(asset),404,'MEDIA_ASSET_NOT_FOUND');
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();}
});
for(const type of ['signature','document','quote_pdf'])test(`tenant download compatibility preserves historical ${type} outside gallery`,async()=>{
  const id=randomUUID();await h.admin`INSERT INTO media_assets(id,tenant_id,media_type,mime_type,status,retention_class,retention_policy_version,bucket,object_key,uploaded_at)
    VALUES(${id},${a.tenantId},${type},${type==='signature'?'image/png':'application/pdf'},'active',${type==='signature'?'authorization_evidence':'document'},'historical-v0',${f.r2.bucket},${randomUUID()},'2020-01-01')`;
  const result=await download(id);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.mediaAssetId,id);
});
test('missing cursor configuration leaves order route disabled; malformed config fails before production DB setup',async()=>{
  const server=h.load('api/server.js');assert.equal(server.loadProductionApiConfig({R2_ENDPOINT:f.r2.endpoint,R2_REGION:f.r2.region,
    R2_BUCKET:f.r2.bucket,R2_ACCESS_KEY_ID:f.r2.accessKeyId,R2_SECRET_ACCESS_KEY:f.r2.secretAccessKey}).orderMediaCursor,undefined);
  assert.throws(()=>server.loadProductionApiConfig({R2_ENDPOINT:f.r2.endpoint,R2_REGION:f.r2.region,
    R2_BUCKET:f.r2.bucket,R2_ACCESS_KEY_ID:f.r2.accessKeyId,R2_SECRET_ACCESS_KEY:f.r2.secretAccessKey,MEDIA_ORDER_CURSOR_KEY:'invalid'}),/MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID/);
  const disabled=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.owner.subject};}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2);}});
  try{const r=await disabled.inject({url:url(randomUUID()),headers:{'x-tenant-id':a.tenantId}});assert.equal(r.statusCode,404);}
  finally{await disabled.close();}
});
test('global rate limit denial on order route is no-store even before authentication',async()=>{
  const limited=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(){return null;}},rateLimit:{max:1,timeWindow:'1 minute'},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2,codec);}});
  try{for(let i=0;i<2;i++){const r=await limited.inject({url:url(randomUUID())});assert.equal(r.statusCode,i?429:401);assert.equal(r.headers['cache-control'],'no-store');}}
  finally{await limited.close();}
});
test('SQL plan uses existing tenant/source indexes on a large canonical gallery; no new index or grant',async()=>{
  const {p,s}=await ready();await cloneEvidence(p,s,150);
  const plan=await h.admin`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT rm.media_asset_id FROM reception_media rm
    JOIN media_assets m ON m.tenant_id=rm.tenant_id AND m.id=rm.media_asset_id
    WHERE rm.tenant_id=${a.tenantId} AND rm.reception_id=${p.reception}
    ORDER BY rm.sort_order,rm.media_asset_id,rm.purpose LIMIT 101`;
  const value=JSON.stringify(plan);assert.ok(value.includes('Limit'));assert.ok(value.includes('Index'));
  const [rows]=await h.admin`SELECT count(*)::int n FROM reception_media WHERE tenant_id=${a.tenantId} AND reception_id=${p.reception}`;
  assert.equal(rows.n,151);console.log('ORDER_MEDIA_PLAN_PASS assets=151 existing_indexes=true');
});

test('GET with a body is rejected after resource authorization instead of being silently ignored',async()=>{
  const {order}=await ready();error(await call(url(order),{},'GET'),400,'REQUEST_VALIDATION_FAILED');
});
test('concurrent mixed-source reads finish without deadlocks or duplicate assets',async()=>{
  const p=await parent(a),r=await upload(p),d=await upload(p,'damage'),{order}=await close(p);
  const responses=await Promise.all(Array.from({length:8},(_,i)=>list(order,'',a,i%2?a.owner:a.technician)));
  for(const response of responses){assert.equal(response.status,200,JSON.stringify(response.body));
    assert.deepEqual(response.body.media.map(m=>m.mediaAssetId),[r.mediaAssetId,d.mediaAssetId]);}
});
for(const wins of ['reader','deletion'])test(`order ${wins} wins against actual B06 retention tombstone; no storage deletion`,async()=>{
  const {s,order}=await ready();
  await corrupt(async tx=>{
    await tx`UPDATE service_orders SET status='delivered',closed_at='2020-01-01' WHERE id=${order}`;
    await tx`UPDATE media_assets SET retention_until='2021-01-01' WHERE id=${s.mediaAssetId}`;
  });
  const login='tm_order_purge_'+randomUUID().replaceAll('-',''),password=randomUUID();
  await h.admin.unsafe(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await h.admin.unsafe(`GRANT tallermecario_media_purger TO ${login}`);
  const target=new URL(process.env.TEST_DATABASE_URL_ADMIN);target.username=login;target.password=password;
  const pool=require('postgres')(target.toString(),{max:1,prepare:false,onnotice(){},connection:{role:'tallermecario_media_purger'}});
  const reader=await h.apiPool.reserve(),writer=await pool.reserve();let pending;
  const calls=storageCalls;
  try{
    if(wins==='reader'){
      const ctx=await context(reader);assert.equal((await listOrderMedia(ctx,order,{},undefined,codec)).media.length,1);
      const [{pid}]=await reader`SELECT pg_backend_pid() pid`;await writer`BEGIN`;
      await writer`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
      pending=Promise.resolve(writer`SELECT app.queue_retention_media_purge(${s.mediaAssetId}::uuid) AS state`);
      await until(()=>blockedBy(pid));await reader`COMMIT`;assert.equal((await pending)[0].state,'deleted');await writer`COMMIT`;
      assert.deepEqual((await list(order)).body.media,[]);
    }else{
      await writer`BEGIN`;await writer`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
      assert.equal((await writer`SELECT app.queue_retention_media_purge(${s.mediaAssetId}::uuid) AS state`)[0].state,'deleted');
      const [{pid}]=await writer`SELECT pg_backend_pid() pid`;pending=list(order);
      await until(()=>blockedBy(pid));await writer`COMMIT`;
      const response=await pending;assert.equal(response.status,200,JSON.stringify(response.body));assert.deepEqual(response.body.media,[]);
    }
    assert.equal(storageCalls,calls);const before=signedGets;error(await download(s.mediaAssetId),404,'MEDIA_ASSET_NOT_FOUND');assert.equal(signedGets,before);
  }finally{
    await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();
    if(pending)await pending;await pool.end();await h.admin.unsafe(`DROP ROLE ${login}`);
  }
});

// Targeted adversarial regressions: each is paired with a removal mutant in
// scripts/order-media-mutations.cjs. DB barriers expose a changed observation,
// rather than hoping a concurrent writer happens to win a race.
for(const route of ['gallery','download'])test(`M03 ${route}: tenant grant downgraded to assigned while waiting cannot use stale tenant authority`,async()=>{
  const p=await parent(a),s=await upload(p),{order}=await close(p,'lead_technician',a,a.advisor),writer=await h.apiPool.reserve();let pending;
  try{
    await context(writer);await writer`SELECT app.lock_current_tenant_owner_set()`;await writer`SELECT id FROM workshops WHERE id=${a.tenantId} FOR NO KEY UPDATE`;
    const [{pid}]=await writer`SELECT pg_backend_pid() pid`;
    pending=route==='gallery'?list(order,'',a,a.advisor):download(s.mediaAssetId,a,a.advisor);
    await until(()=>blockedBy(pid,'%lock_current_tenant_owner_set%'));
    await writer`DELETE FROM membership_roles WHERE tenant_id=${a.tenantId} AND membership_id=${a.advisor.membershipId}`;
    await writer`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${a.advisor.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='technician'`;
    await writer`COMMIT`;
    error(await pending,404,route==='gallery'?'SERVICE_ORDER_NOT_FOUND':'MEDIA_ASSET_NOT_FOUND');
    assert.equal((await list(order,'',a,a.advisor)).status,200,'a fresh request may use the new assigned grant');
  }finally{
    await writer`ROLLBACK`.catch(()=>{});writer.release();if(pending)await pending;
    await h.admin`DELETE FROM membership_roles WHERE tenant_id=${a.tenantId} AND membership_id=${a.advisor.membershipId}`;
    await h.admin`INSERT INTO membership_roles(tenant_id,membership_id,role_id,assigned_by_membership_id)
      SELECT ${a.tenantId},${a.advisor.membershipId},id,${a.owner.membershipId} FROM roles WHERE code='service_advisor'`;
  }
});
test('M15: a shifted candidate window fails closed rather than reading the replacement without its locks',async()=>{
  const p=await parent(a),first=await upload(p),second=await upload(p,'reception','photo',10),{order}=await close(p),holder=await h.admin.reserve();let pending;
  try{
    await holder`BEGIN`;await holder`SELECT id FROM media_assets WHERE id=${first.mediaAssetId} FOR UPDATE`;
    const [{pid}]=await holder`SELECT pg_backend_pid() pid`;pending=list(order,'limit=1');
    await until(()=>blockedBy(pid,'%FROM public.media_assets%'));
    await holder`SET LOCAL session_replication_role=replica`;
    await holder`UPDATE reception_media SET sort_order=20 WHERE tenant_id=${a.tenantId} AND media_asset_id=${first.mediaAssetId}`;
    await holder`COMMIT`;error(await pending,409,'MEDIA_ASSOCIATION_CONFLICT');
    const fresh=await list(order,'limit=1');assert.equal(fresh.status,200);assert.equal(fresh.body.media[0].mediaAssetId,second.mediaAssetId);
  }finally{await holder`ROLLBACK`.catch(()=>{});holder.release();if(pending)await pending;}
});
for(const kind of ['empty','filtered'])test(`M16 ${kind}: requested reception and order remain locked when the page contains no visible media`,async()=>{
  const p=await parent(a);if(kind==='filtered'){const s=await upload(p);await h.admin`UPDATE media_assets SET status='quarantined',quarantined_at=clock_timestamp() WHERE id=${s.mediaAssetId}`;}
  const {order}=await close(p),reader=await h.apiPool.reserve(),writer=await h.admin.reserve();
  try{
    const response=await listOrderMedia(await context(reader),order,{},undefined,codec);assert.deepEqual(response.media,[]);
    for(const [table,id] of [['receptions',p.reception],['service_orders',order]]){
      await writer`BEGIN`;
      try{await assert.rejects(writer.unsafe(`SELECT id FROM public.${table} WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT`,[a.tenantId,id]),e=>e.code==='55P03');}
      finally{await writer`ROLLBACK`;}
    }
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();writer.release();}
});
test('M20: the effective PostgreSQL statement timeout is clamped to the remaining operation deadline',async()=>{
  const reader=await h.apiPool.reserve();
  try{
    await context(reader);const deadline=performance.now()+1800;
    const [setting]=await withOrderMediaLimits(reader,sql=>sql`SELECT setting::int AS ms FROM pg_settings WHERE name='statement_timeout'`,deadline);
    assert.ok(setting.ms>0&&setting.ms<=1800,'SQL must see the remaining budget, not an unconditional 8s timeout');
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();}
});
function productionConfig(extra={}){return h.load('api/server.js').loadProductionApiConfig({R2_ENDPOINT:f.r2.endpoint,R2_REGION:f.r2.region,
  R2_BUCKET:f.r2.bucket,R2_ACCESS_KEY_ID:f.r2.accessKeyId,R2_SECRET_ACCESS_KEY:f.r2.secretAccessKey,...extra});}
test('M27: production API registers the configured cursor route and emits only a fixed missing-key startup notice',async()=>{
  const {order,s}=await ready(),server=h.load('api/server.js'),output=[],cursorKey=randomBytes(32).toString('base64url');
  const keyConfig=JSON.stringify({activeKeyId:'deploy',keys:{deploy:cursorKey}});
  const options={database:h.apiPool,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.owner.subject};}},
    logStream:new Writable({write(chunk,_e,done){output.push(chunk.toString());done();}})};
  const enabled=await server.buildProductionApi(options,productionConfig({MEDIA_ORDER_CURSOR_KEY:keyConfig}));
  try{const r=await enabled.inject({url:url(order),headers:{'x-tenant-id':a.tenantId}});assert.equal(r.statusCode,200);assert.equal(r.json().media.length,1);}
  finally{await enabled.close();}
  assert.equal(output.join('').includes('cursor_key_missing'),false);output.length=0;
  const disabled=await server.buildProductionApi(options,productionConfig());
  try{const r=await disabled.inject({url:url(order),headers:{'x-tenant-id':a.tenantId}});assert.equal(r.statusCode,404);
    for(const method of ['GET','HEAD']){const response=await disabled.inject({method,url:`/api/v1/media/${s.mediaAssetId}/download-url`,headers:{'x-tenant-id':a.tenantId}});assert.equal(response.statusCode,200);}
  }
  finally{await disabled.close();}
  const text=output.join('');assert.equal(text.split('order_media_route_disabled').length-1,1);
  const notices=text.trim().split('\n').map(line=>JSON.parse(line)).filter(line=>line.event==='order_media_route_disabled');
  assert.deepEqual(notices,[{level:30,event:'order_media_route_disabled',reason:'cursor_key_missing'}]);
  require('../../scripts/staging-crm-e2e.cjs').assertLogPrivacy(text,[cursorKey,keyConfig],3);
  assert.ok(text.includes('cursor_key_missing'));for(const secret of [cursorKey,keyConfig])assert.equal(text.includes(secret),false);
});
test('F4: malformed configured cursor fails the actual startup before any usable DB configuration is needed',()=>{
  const {spawnSync}=require('node:child_process');
  const env={PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,HOME:process.env.HOME,DATABASE_URL:'not-a-database-url',MEDIA_ORDER_CURSOR_KEY:'malformed-test-only',
    R2_ENDPOINT:f.r2.endpoint,R2_REGION:f.r2.region,R2_BUCKET:f.r2.bucket,R2_ACCESS_KEY_ID:f.r2.accessKeyId,R2_SECRET_ACCESS_KEY:f.r2.secretAccessKey};
  const result=spawnSync(process.execPath,[join(process.env.TEST_MODULE_ROOT,'api/server.js')],{env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(result.signal,null);assert.equal(result.stderr.trim(),'MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID');
  assert.equal(result.stdout,'');assert.equal(result.stderr.includes(env.MEDIA_ORDER_CURSOR_KEY),false);
});
test('F5: positive 1ms clock skew fails closed and the exact fifteen-minute expiry never expands',()=>{
  const key=randomBytes(32),keys=new Map([['clock',key]]),ctx={tenantId:a.tenantId,orderId:randomUUID(),userId:a.owner.user.id,membershipId:a.owner.membershipId,limit:20};
  const position=[0,randomUUID(),0,randomUUID(),'intake_evidence'],issued=1000001,token=createOrderMediaCursor('clock',keys,()=>issued).encode(ctx,position);
  assert.throws(()=>createOrderMediaCursor('clock',keys,()=>issued-1).decode(token,ctx),e=>e.code==='REQUEST_VALIDATION_FAILED');
  for(const time of [issued,issued+899999])assert.deepEqual(createOrderMediaCursor('clock',keys,()=>time).decode(token,ctx),position);
  for(const time of [issued+900000,issued+900001])assert.throws(()=>createOrderMediaCursor('clock',keys,()=>time).decode(token,ctx),e=>e.code==='REQUEST_VALIDATION_FAILED');
});
test('F5: duplicate JSON key IDs, escaped duplicates and repeated encryption material are rejected without disclosure',()=>{
  const key=randomBytes(32),aKey=key.toString('base64url'),bKey=randomBytes(32).toString('base64url');
  for(const raw of [
    `{"activeKeyId":"a","keys":{"a":"${aKey}","a":"${bKey}"}}`,
    `{"activeKeyId":"a","keys":{"a":"${aKey}","\\u0061":"${bKey}"}}`,
    `{"activeKeyId":"a","activeKeyId":"b","keys":{"a":"${aKey}","b":"${bKey}"}}`,
    JSON.stringify({activeKeyId:'a',keys:{a:aKey,b:aKey}}),
  ])assert.throws(()=>loadOrderMediaCursor({MEDIA_ORDER_CURSOR_KEY:raw}),e=>e.message==='MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID');
  assert.throws(()=>createOrderMediaCursor('a',new Map([['a',key],['b',Buffer.from(key)]])),/MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID/);
  assert.ok(loadOrderMediaCursor({MEDIA_ORDER_CURSOR_KEY:JSON.stringify({activeKeyId:'a',keys:{a:aKey,b:bKey}})}));
});
test('M34b: a late equivalent session is not authorized after the session lock tier has passed',async()=>{
  const {s,order}=await ready(),holder=await h.admin.reserve();let pending;
  try{
    await holder`BEGIN`;await holder`SELECT id FROM media_assets WHERE id=${s.mediaAssetId} FOR UPDATE`;
    const [{pid}]=await holder`SELECT pg_backend_pid() pid`;pending=list(order);
    await until(()=>blockedBy(pid,'%FROM public.media_assets%'));await holder`SET LOCAL session_replication_role=replica`;
    const session=randomUUID(),binding=randomUUID();
    await holder`INSERT INTO upload_sessions SELECT (jsonb_populate_record(NULL::upload_sessions,to_jsonb(us)||jsonb_build_object('id',${session}::text,'binding_id',${binding}::text,'idempotency_key',${randomUUID()}::text))).*
      FROM upload_sessions us WHERE id=${s.uploadSessionId}`;
    await holder`INSERT INTO media_upload_bindings SELECT (jsonb_populate_record(NULL::media_upload_bindings,to_jsonb(b)||jsonb_build_object('id',${binding}::text,'upload_session_id',${session}::text))).*
      FROM media_upload_bindings b WHERE upload_session_id=${s.uploadSessionId}`;
    await holder`COMMIT`;error(await pending,409,'MEDIA_ASSOCIATION_CONFLICT');
    assert.equal((await list(order)).status,200,'a new request discovers and locks both equivalent sessions');
  }finally{await holder`ROLLBACK`.catch(()=>{});holder.release();if(pending)await pending;}
});
test('M34c: an order discovered after the parent lock tier fails safely instead of locking it late',async()=>{
  const p=await parent(a),reader=await h.apiPool.reserve();let reached,continueRead;
  const stage=new Promise(resolve=>{reached=resolve;}),resume=new Promise(resolve=>{continueRead=resolve;});
  let pending;
  try{
    await context(reader);
    // Pause only after a real SQL statement; no query/result is mocked. Empty
    // assets plus an explicit reception isolate the late-order guard from the
    // separate linked-parent guard. Replica-mode fixture insertion is confined
    // to this adversarial test; production readers remain NOBYPASSRLS.
    const observed=new Proxy(reader,{apply(target,self,args){const query=Reflect.apply(target,self,args);
      if(Array.isArray(args[0])&&args[0].join('').includes('FROM public.media_assets'))return Promise.resolve(query).then(async result=>{reached();await resume;return result;});
      return query;}});
    pending=retention.lockMediaRetention(observed,a.tenantId,[],{receptionIds:[p.reception]},1000).then(value=>({value}),error=>({error}));
    await stage;
    await corrupt(tx=>tx`INSERT INTO service_orders(id,tenant_id,reception_id,vehicle_id,customer_id,order_number,created_by_membership_id)
      VALUES(${randomUUID()},${a.tenantId},${p.reception},${p.vehicle},${p.customer},9000000000000,${a.owner.membershipId})`);
    continueRead();const result=await pending;assert.equal(result.error?.code,'MEDIA_ASSOCIATION_CONFLICT');
  }finally{continueRead?.();if(pending)await pending;await reader`ROLLBACK`.catch(()=>{});reader.release();}
});
