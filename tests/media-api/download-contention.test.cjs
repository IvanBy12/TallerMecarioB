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
const { registerCustomerRoutes } = h.load('customers/routes.js');
const { registerReceptionRoutes } = h.load('receptions/routes.js');
const { createOrderMediaCursor } = h.load('media/order-query-cursor.js');
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
      try {registerMediaRoutes(server,f.r2);registerReceptionRoutes(server);registerCustomerRoutes(server);} finally {server.post=post;}
    },
  });
  await app.listen({host:'127.0.0.1',port:0});port=app.server.address().port;
});
after(async()=>{globalThis.fetch=originalFetch;signer.presignR2Url=originalSign;await h.closeAll(app);});
function call(path, payload, method='GET', t=a, actor=t.owner,targetPort=port){
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?undefined:JSON.stringify(payload);
    const req=http.request({host:'127.0.0.1',port:targetPort,path,method,agent:false,headers:{
      ...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)}),
      ...(actor?{authorization:`Bearer ${actor.subject}`} : {}),'x-tenant-id':t.tenantId,
    }},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):undefined,headers:res.headers}));});
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
// No cursor configured: download availability limits are independent of gallery registration.
async function noDownloadTransactions() {
  return (await h.admin`SELECT count(*)::int n FROM pg_stat_activity
    WHERE datname=current_database() AND usename<>current_user AND xact_start IS NOT NULL`)[0].n===0;
}
async function holder(t=a, table='workshops', id=t.tenantId) {
  const sql=await h.admin.reserve();await sql`BEGIN`;
  const [{pid}]=await sql`SELECT pg_backend_pid() pid`;
  await sql.unsafe(`SELECT id FROM public.${table} WHERE id=$1 FOR ${table==='media_assets'?'UPDATE':'NO KEY UPDATE'}`,[id]);
  return {sql,pid};
}
for(const table of ['workshops','receptions','media_assets'])test(`E1 ${table}: tenant download lock timeout rolls back, never signs, recovers without cursor configuration`,async()=>{
  const {s,p}=await ready(),hold=await holder(a,table,table==='workshops'?a.tenantId:table==='receptions'?p.reception:s.mediaAssetId),before=signedGets;
  let release;const safety=setTimeout(()=>{release=hold.sql`ROLLBACK`.execute();},5000);
  const started=performance.now();let result;
  try {
    const pending=download(s.mediaAssetId);await until(()=>blockedBy(hold.pid));
    result=await pending;
  }finally{clearTimeout(safety);await (release??hold.sql`ROLLBACK`);hold.sql.release();}
  const elapsed=performance.now()-started;
  console.log('E1 metrics '+JSON.stringify({table,elapsedMs:Math.round(elapsed),signatures:signedGets-before}));
  error(result,503,'MEDIA_QUERY_RETRY');assert.ok(elapsed>=1800&&elapsed<3500,'2s lock budget plus <=1.5s scheduling margin');
  assert.equal(signedGets,before);await until(noDownloadTransactions);
  assert.equal((await download(s.mediaAssetId)).status,200);assert.equal(signedGets,before+1);
});
for(const method of ['GET','HEAD'])test(`E2 ${method}: twelve tenant A downloads cannot occupy all ten real API pool connections or starve tenant B`,async()=>{
  assert.equal(h.apiPool.options.max,10);
  const {s}=await ready(),{order:bOrder}=await ready('reception','lead_technician',b);
  const gallery=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(request){const subject=request.headers.authorization?.slice(7);return subject?{identityProvider:'clerk',externalSubject:subject}:null;}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2,codec);}});
  await gallery.listen({host:'127.0.0.1',port:0});const galleryPort=gallery.server.address().port;
  const hold=await holder(),before=signedGets,started=performance.now();
  let release;const safety=setTimeout(()=>{release=hold.sql`ROLLBACK`.execute();},10000);
  let results,other,bMs,bGalleryMs,bGallery,waiters,settled=0,queuePeak=0,activePeak=0,samplingDone=false;const timings=[];
  const sampling=(async()=>{while(!samplingDone){const state=snapshot();queuePeak=Math.max(queuePeak,state.waiting);activePeak=Math.max(activePeak,state.active);await yieldTurn();}})();
  // Observe native acquisitions/releases; every operation still uses the real
  // postgres.js pool and real NOBYPASSRLS API connections, without a mock pool.
  const reservations=[],nativeReserve=h.apiPool.reserve;
  h.apiPool.reserve=async()=>{const start=performance.now(),sql=await nativeReserve();
    const acquired=performance.now(),record={acquireMs:Math.round(acquired-start)},nativeRelease=sql.release;reservations.push(record);
    sql.release=()=>{record.holdMs=Math.round(performance.now()-acquired);nativeRelease();};return sql;};
  const pending=Array.from({length:12},()=>{const start=performance.now();return call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,method).then(r=>{
    settled++;timings.push(Math.round(performance.now()-start));return r;});});
  try {
    await until(async()=>{waiters=(await h.admin`SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
      AND query LIKE '%lock_current_tenant_owner_set%'`)[0].n;return waiters>=9;});
    const bStart=performance.now();
    [other,bGallery]=await Promise.all([
      call('/api/v1/customers',undefined,'GET',b).then(result=>{bMs=performance.now()-bStart;return result;}),
      call(url(bOrder),undefined,'GET',b,b.owner,galleryPort).then(result=>{bGalleryMs=performance.now()-bStart;return result;}),
    ]);
    results=await Promise.all(pending);
  }finally{clearTimeout(safety);await (release??hold.sql`ROLLBACK`);hold.sql.release();await Promise.all(pending);h.apiPool.reserve=nativeReserve;samplingDone=true;await sampling;await gallery.close();}
  const recovery=performance.now()-started;
  console.log('E2 metrics '+JSON.stringify({method,poolMax:10,requests:12,waiters,settled,tenantBMs:Math.round(bMs),tenantBGalleryMs:Math.round(bGalleryMs),queuePeak,activePeak,recoveryMs:Math.round(recovery),downloadMs:timings,reservations}));
  assert.equal(other.status,200);assert.equal(bGallery.status,200);assert.ok(bMs<1000&&bGalleryMs<1000,'one pool slot stays available; unrelated B customers/gallery complete within 1s');
  assert.ok(queuePeak>0&&queuePeak<=admission.MEDIA_DOWNLOAD_MAX_WAITERS);assert.equal(activePeak,9);
  for(const result of results){if(method==='HEAD'){assert.equal(result.status,503);assert.equal(result.headers['cache-control'],'no-store');}
    else error(result,503,'MEDIA_QUERY_RETRY');}
  assert.ok(recovery<9500,'8s statement budget plus 1.5s scheduling margin; lock_timeout restarts for each lock');assert.equal(signedGets,before);
  await until(noDownloadTransactions);assert.equal((await download(s.mediaAssetId)).status,200);
  assert.equal((await call('/api/v1/customers',undefined,'GET',b)).status,200);
});
test('real exhausted pool: 2s acquisition bound retains admission until late release, without opening transactions',async()=>{
  const {s}=await ready(),held=await Promise.all(Array.from({length:10},()=>h.apiPool.reserve()));
  const before=signedGets,started=performance.now();let results;
  try {
    results=await Promise.all(Array.from({length:12},()=>download(s.mediaAssetId)));
    const elapsed=performance.now()-started;
    for(const r of results)error(r,503,'MEDIA_QUERY_RETRY');
    assert.ok(elapsed>=1800&&elapsed<3500);assert.equal(signedGets,before);
    const again=performance.now();
    for(const r of await Promise.all(Array.from({length:12},()=>download(s.mediaAssetId))))error(r,503,'MEDIA_QUERY_RETRY');
    assert.ok(performance.now()-again>=450&&performance.now()-again<1000,'late native reservations retain admission; new callers expire in the bounded admission queue');
    console.log('acquisition metrics '+JSON.stringify({requests:24,firstBurstMs:Math.round(elapsed),rejectedRetryBurstMs:Math.round(performance.now()-again)}));
  }finally{for(const sql of held)sql.release();}
  // Native postgres.js reservations drain on real pool release. None begins a
  // transaction after its response has already failed.
  await until(async()=>{const r=await download(s.mediaAssetId);return r.status===200;});
  assert.equal(signedGets,before+1);await until(noDownloadTransactions);
});
test('download SQL: real 57014 is retryable, 22012 is preserved, SET LOCAL never leaks after rollback',async()=>{
  const {mediaDownloadSql}=h.load('media/download-limits.js'),reader=await h.apiPool.reserve();
  try {
    await reader`BEGIN`;const sql=await mediaDownloadSql(reader);
    assert.equal((await sql`SHOW lock_timeout`)[0].lock_timeout,'2s');
    assert.equal((await sql`SHOW statement_timeout`)[0].statement_timeout,'8s');
    const started=performance.now();await assert.rejects(sql`SELECT pg_sleep(10)`,e=>e.statusCode===503&&e.code==='MEDIA_QUERY_RETRY');
    assert.ok(performance.now()-started>=7500&&performance.now()-started<10000);
    await assert.rejects(reader`SELECT 1`,e=>e.code==='25P02','canceled statement leaves aborted tx until cleanup rolls back');
    await reader`ROLLBACK`;
    assert.equal((await reader`SHOW lock_timeout`)[0].lock_timeout,'0');
    assert.equal((await reader`SHOW statement_timeout`)[0].statement_timeout,'0');
    await reader`BEGIN`;const next=await mediaDownloadSql(reader);
    await assert.rejects(next`SELECT 1/0`,e=>e.code==='22012');
    await reader`ROLLBACK`;assert.equal((await reader`SELECT 1 AS n`)[0].n,1);
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();}
});
for(const route of ['download','gallery'])test(`real 40P01 ${route} victim returns safe 503 without signing or automatic retries`,async()=>{
  const {p,s,order}=await ready(),writer=await h.admin.reserve();let pending,writerWait,gallery;
  const before=signedGets,deadlocks=(await h.admin`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks;
  // Deliberately inverted TEST-ONLY writer: existing lifecycle primitives take
  // receptions before orders. No supported terminal-order mutation route exists.
  // The reader detects the cycle at its normal 1s deadlock_timeout, before its
  // 2s lock_timeout. The fixture writer detects later and is not the victim.
  try {
    await writer`BEGIN`;await writer`SET LOCAL deadlock_timeout='5s'`;
    const [{pid}]=await writer`SELECT pg_backend_pid() pid`;
    await writer`SELECT id FROM service_orders WHERE id=${order} FOR NO KEY UPDATE`;
    if(route==='gallery') {
      gallery=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.owner.subject};}},
        logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2,codec);}});
      pending=gallery.inject({url:url(order),headers:{'x-tenant-id':a.tenantId}}).then(r=>({status:r.statusCode,body:r.json(),headers:r.headers}));
    } else pending=download(s.mediaAssetId);
    await until(()=>blockedBy(pid,'%service_orders%'));
    writerWait=writer`SELECT id FROM receptions WHERE id=${p.reception} FOR NO KEY UPDATE`.execute();
    const result=await pending;await writerWait;
    error(result,503,'MEDIA_QUERY_RETRY');assert.equal(signedGets,before);
    await writer`ROLLBACK`;
    await until(async()=>Number((await h.admin`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks)>Number(deadlocks));
    assert.equal(Number((await h.admin`SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()`)[0].deadlocks),Number(deadlocks)+1,'one detected deadlock, no implicit retry');
    await until(noDownloadTransactions);assert.equal((await download(s.mediaAssetId)).status,200);
  }finally{await writer`ROLLBACK`.catch(()=>{});writer.release();if(writerWait)await writerWait.catch(()=>{});if(pending)await pending;await gallery?.close();}
});
for(const wins of ['writer','reader'])test(`B05 ordered lifecycle primitive: ${wins} wins without deadlock or reordered parent locks`,async()=>{
  const {p,s,order}=await ready(),writer=await h.apiPool.reserve(),reader=await h.apiPool.reserve();let pending;
  try {
    await writer`BEGIN`;await writer`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.user_id',${a.owner.user.id},true),
      set_config('app.membership_id',${a.owner.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
    await reader`BEGIN`;await reader`SELECT set_config('app.tenant_id',${a.tenantId},true),set_config('app.user_id',${a.owner.user.id},true),
      set_config('app.membership_id',${a.owner.membershipId},true),set_config('app.request_id',${randomUUID()},true)`;
    const [{pid}]=await (wins==='writer'?writer:reader)`SELECT pg_backend_pid() pid`;
    if(wins==='writer') {
      const scope=await retention.lockOrderMediaRetention(writer,a.tenantId,order);assert.deepEqual(scope.assetIds,[s.mediaAssetId]);
      pending=h.load('media/download-authorization.js').authorizeTenantDownload({sql:reader,
        tenant:{tenantId:a.tenantId,userId:a.owner.user.id,membershipId:a.owner.membershipId},
        resourceAuthorization:h.load('authz/resource-authorization.js').createResourceAuthorizationState('media.read',{kind:'tenant'})},s.mediaAssetId);
      await until(()=>blockedBy(pid,'%receptions%'));await writer`ROLLBACK`;await pending;
    }else{
      await reader`SELECT id FROM receptions WHERE tenant_id=${a.tenantId} AND id=${p.reception} FOR NO KEY UPDATE`;
      pending=retention.lockOrderMediaRetention(writer,a.tenantId,order);
      await until(()=>blockedBy(pid,'%receptions%'));await reader`ROLLBACK`;assert.deepEqual((await pending).assetIds,[s.mediaAssetId]);
    }
  }finally{await reader`ROLLBACK`.catch(()=>{});reader.release();await writer`ROLLBACK`.catch(()=>{});writer.release();if(pending)await pending;}
});


test('N1 healthy bursts: repeated GET/HEAD fan-out, including forty downloads, never fails admission',async()=>{
  const own=await ready(),other=await ready('reception','lead_technician',b),limits=h.load('media/download-limits.js'),rows=[];
  const shapes=[...['GET','HEAD'].flatMap(method=>[10,12,20,40].map(count=>({method,count}))),{method:'mixed',count:40},{method:'two-tenants',count:20}];
  for(let repetition=1;repetition<=3;repetition++)for(const shape of shapes){
    let inUse=0,maxInUse=0,activePeak=0,queuePeak=0,finished=false;const nativeReserve=h.apiPool.reserve;
    h.apiPool.reserve=async()=>{const sql=await nativeReserve(),release=sql.release;inUse++;maxInUse=Math.max(maxInUse,inUse);
      sql.release=()=>{inUse--;release();};return sql;};
    const sample=async()=>{while(!finished){const state=limits.mediaDownloadAdmissionSnapshot?.(h.apiPool);
      if(state){activePeak=Math.max(activePeak,state.active);queuePeak=Math.max(queuePeak,state.waiting);}await yieldTurn();}};
    const sampling=sample(),started=performance.now(),latencies=[];let responses;
    try{responses=await Promise.all(Array.from({length:shape.count},(_,i)=>{
      const tenant=shape.method==='two-tenants'&&i>=10?b:a,asset=tenant===a?own.s.mediaAssetId:other.s.mediaAssetId;
      const method=shape.method==='HEAD'?'HEAD':shape.method==='mixed'&&i%2?'HEAD':'GET',start=performance.now();
      return call(`/api/v1/media/${asset}/download-url`,undefined,method,tenant).then(result=>{latencies.push(performance.now()-start);return result;});
    }));}finally{finished=true;await sampling;h.apiPool.reserve=nativeReserve;}
    latencies.sort((x,y)=>x-y);const statuses={};for(const result of responses)statuses[result.status]=(statuses[result.status]??0)+1;
    const row={...shape,repetition,statuses,elapsedMs:Math.round(performance.now()-started),p50Ms:Math.round(latencies[Math.floor(latencies.length/2)]),maxMs:Math.round(latencies.at(-1)),activePeak:activePeak||maxInUse,queuePeak,poolPeak:maxInUse};
    rows.push(row);console.log('N1_BURST '+JSON.stringify(row));assert.equal(inUse,0);assert.ok(maxInUse<=9);
  }
  assert.ok(rows.every(row=>row.statuses[200]===row.count&&Object.keys(row.statuses).length===1),'every healthy burst must complete without arbitrary admission 503');
  await until(noDownloadTransactions);
});

const admission=h.load('media/download-limits.js');
const snapshot=()=>admission.mediaDownloadAdmissionSnapshot(h.apiPool);
async function holdAdmissions(){return Promise.all(Array.from({length:9},()=>admission.reserveMediaDownload(h.apiPool)));}
function releaseLease(value){value.sql.release();value.releaseAdmission();}
function startDownload(asset,method='GET'){
  let request;
  const response=new Promise((resolve,reject)=>{
    request=http.request({host:'127.0.0.1',port,path:`/api/v1/media/${asset}/download-url`,method,agent:false,
      headers:{authorization:`Bearer ${a.owner.subject}`,'x-tenant-id':a.tenantId}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):undefined}));
    });
    request.on('error',error=>{if(error.code==='ECONNRESET')resolve({cancelled:true});else reject(error);});request.end();
  });
  return {request,response};
}
test('N1 FIFO: waiting callers borrow no connection; later arrivals cannot bypass them; release is idempotent',async()=>{
  const {getEventListeners}=require('node:events'),held=await holdAdmissions(),nativeReserve=h.apiPool.reserve;let calls=0;const acquired=[],order=[];
  h.apiPool.reserve=(...args)=>{calls++;return nativeReserve(...args);};
  const controller=new AbortController();let first,second,later;
  try{
    first=admission.reserveMediaDownload(h.apiPool,controller.signal).then(value=>{acquired.push(value);order.push('first');return value;});
    second=admission.reserveMediaDownload(h.apiPool).then(value=>{acquired.push(value);order.push('second');return value;});
    assert.deepEqual(snapshot(),{active:9,waiting:2});assert.equal(calls,0);
    releaseLease(held.shift());const one=await first;one.releaseAdmission();one.releaseAdmission();one.sql.release();
    later=admission.reserveMediaDownload(h.apiPool).then(value=>{acquired.push(value);order.push('later');return value;});
    const two=await second;releaseLease(two);const three=await later;releaseLease(three);
    assert.deepEqual(order,['first','second','later']);assert.equal(getEventListeners(controller.signal,'abort').length,0);
    assert.equal(snapshot().active,8);assert.equal(snapshot().waiting,0);assert.equal(calls,3);
  }finally{h.apiPool.reserve=nativeReserve;for(const value of held)releaseLease(value);for(const promise of [first,second,later])if(promise)await promise;}
  assert.deepEqual(snapshot(),{active:0,waiting:0});
});
test('N1 queued timeout: expires within the admission budget, without allocating SQL or retaining abort listeners',async()=>{
  const {getEventListeners}=require('node:events'),held=await holdAdmissions(),nativeReserve=h.apiPool.reserve,controller=new AbortController();let calls=0;
  h.apiPool.reserve=(...args)=>{calls++;return nativeReserve(...args);};
  try{
    const start=performance.now();await assert.rejects(admission.reserveMediaDownload(h.apiPool,controller.signal),e=>e.code==='MEDIA_QUERY_RETRY');
    const elapsed=performance.now()-start;assert.ok(elapsed>=450&&elapsed<1000);assert.equal(calls,0);
    assert.deepEqual(snapshot(),{active:9,waiting:0});assert.equal(getEventListeners(controller.signal,'abort').length,0);
    console.log('N1_TIMEOUT '+JSON.stringify({elapsedMs:Math.round(elapsed),nativeReservations:calls,...snapshot()}));
  }finally{h.apiPool.reserve=nativeReserve;for(const value of held)releaseLease(value);}
  assert.deepEqual(snapshot(),{active:0,waiting:0});
});
test('N1 queue full: a finite HTTP waiting queue rejects overflow, expires cleanly, and never grows the native reserve queue',async()=>{
  const {s}=await ready(),held=await holdAdmissions(),nativeReserve=h.apiPool.reserve,signs=signedGets;let calls=0,peak=0,finished=false;
  h.apiPool.reserve=(...args)=>{calls++;return nativeReserve(...args);};
  const sampling=(async()=>{while(!finished){peak=Math.max(peak,snapshot().waiting);await yieldTurn();}})();
  let responses;const times=[];
  try{
    responses=await Promise.all(Array.from({length:admission.MEDIA_DOWNLOAD_MAX_WAITERS+1},(_,i)=>{
      const start=performance.now();return call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,i%2?'HEAD':'GET').then(result=>{times.push(performance.now()-start);return result;});
    }));
    assert.equal(peak,admission.MEDIA_DOWNLOAD_MAX_WAITERS);assert.equal(calls,0);assert.equal(signedGets,signs);
    assert.ok(responses.every(r=>r.status===503));assert.ok(Math.min(...times)<300,'a genuinely full queue rejects overflow before its wait budget');
    assert.ok(Math.max(...times)>=450&&Math.max(...times)<1100);assert.deepEqual(snapshot(),{active:9,waiting:0});
    console.log('N1_FULL '+JSON.stringify({requests:responses.length,queuePeak:peak,nativeReservations:calls,fastestMs:Math.round(Math.min(...times)),slowestMs:Math.round(Math.max(...times)),statuses:{503:responses.length}}));
  }finally{finished=true;await sampling;h.apiPool.reserve=nativeReserve;for(const value of held)releaseLease(value);}
  assert.equal((await download(s.mediaAssetId)).status,200);await until(noDownloadTransactions);assert.deepEqual(snapshot(),{active:0,waiting:0});
});
for(const method of ['GET','HEAD'])test(`N1 ${method} queued disconnect: removes the waiter before expiry and cannot later borrow or sign`,async()=>{
  const {s}=await ready(),held=await holdAdmissions(),nativeReserve=h.apiPool.reserve,signs=signedGets;let calls=0,client;
  h.apiPool.reserve=(...args)=>{calls++;return nativeReserve(...args);};
  try{
    client=startDownload(s.mediaAssetId,method);await until(()=>snapshot().waiting===1);
    const start=performance.now();client.request.destroy();assert.equal((await client.response).cancelled,true);
    await until(()=>snapshot().waiting===0);assert.ok(performance.now()-start<300);assert.equal(calls,0);assert.equal(signedGets,signs);
    console.log('N1_CANCEL '+JSON.stringify({method,cleanupMs:Math.round(performance.now()-start),nativeReservations:calls,...snapshot()}));
  }finally{h.apiPool.reserve=nativeReserve;for(const value of held)releaseLease(value);if(client)await client.response;}
  assert.equal((await download(s.mediaAssetId)).status,200);await until(noDownloadTransactions);assert.deepEqual(snapshot(),{active:0,waiting:0});
});
test('N1 reservation cancellation: a late native connection is released without BEGIN and its admission lease is returned once',async()=>{
  const {getEventListeners}=require('node:events'),held=await Promise.all(Array.from({length:10},()=>h.apiPool.reserve())),controller=new AbortController();
  let pending;
  try{
    pending=admission.reserveMediaDownload(h.apiPool,controller.signal).then(value=>({value}),error=>({error}));
    await until(()=>snapshot().active===1);controller.abort();const result=await pending;
    assert.equal(result.error?.code,'MEDIA_QUERY_RETRY');assert.equal(getEventListeners(controller.signal,'abort').length,0);
    assert.deepEqual(snapshot(),{active:1,waiting:0},'native acquisition still owns its slot until late disposal');
    held.shift().release();await until(()=>snapshot().active===0);await until(noDownloadTransactions);
  }finally{for(const sql of held)sql.release();if(pending)await pending;}
  assert.deepEqual(snapshot(),{active:0,waiting:0});
});
test('N1 active disconnect: retains SQL locks until query completion, rolls back, and never signs after peer cancellation',async()=>{
  const {s}=await ready(),hold=await holder(),signs=signedGets;let client;
  const closed=new Promise(resolve=>app.server.once('request',(_req,res)=>res.once('close',resolve)));
  try{
    client=startDownload(s.mediaAssetId);await until(()=>blockedBy(hold.pid,'%lock_current_tenant_owner_set%'));
    client.request.destroy();await client.response;await closed;assert.equal(snapshot().active,1,'no premature release while SQL remains blocked');
    await hold.sql`ROLLBACK`;await until(()=>snapshot().active===0);await until(noDownloadTransactions);assert.equal(signedGets,signs);
  }finally{await hold.sql`ROLLBACK`.catch(()=>{});hold.sql.release();if(client)await client.response;}
  assert.equal((await download(s.mediaAssetId)).status,200);
});
for(const kind of ['malformed','non-member'])test(`F3N1 ${kind}: openTenantRequest failure rolls back before release with no timeout or transaction leakage`,async()=>{
  const {s}=await ready(),badTenant=kind==='malformed'?{...a,tenantId:'invalid-tenant'}:b;
  const response=await call(`/api/v1/media/${s.mediaAssetId}/download-url`,undefined,'GET',badTenant,a.owner);
  error(response,kind==='malformed'?400:403,kind==='malformed'?'TENANT_SELECTION_INVALID':'TENANT_ACCESS_DENIED');
  const connections=await Promise.all(Array.from({length:10},()=>h.apiPool.reserve()));let settings,idle;
  try{
    settings=await Promise.all(connections.map(sql=>sql`SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout`));
    idle=(await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename<>current_user AND xact_start IS NOT NULL`)[0].n;
  }finally{for(const sql of connections){await sql`ROLLBACK`.catch(()=>{});sql.release();}}
  assert.equal(idle,0,'failed bootstrap must not return an open transaction to the pool');
  assert.ok(settings.every(([row])=>row.lock_timeout==='0'&&row.statement_timeout==='0'),'transaction-local timeouts must be gone at release');
  assert.deepEqual(snapshot(),{active:0,waiting:0});assert.equal((await download(s.mediaAssetId)).status,200);
});

test('N1 handoff cancellation: abort after FIFO grant returns the slot once without starting native acquisition',async()=>{
  const held=await holdAdmissions(),nativeReserve=h.apiPool.reserve,controller=new AbortController();let calls=0,pending;
  h.apiPool.reserve=(...args)=>{calls++;return nativeReserve(...args);};
  try{
    pending=admission.reserveMediaDownload(h.apiPool,controller.signal).then(value=>({value}),error=>({error}));
    assert.deepEqual(snapshot(),{active:9,waiting:1});releaseLease(held.shift());controller.abort();
    const result=await pending;assert.equal(result.error?.code,'MEDIA_QUERY_RETRY');assert.equal(calls,0);
    assert.deepEqual(snapshot(),{active:8,waiting:0});assert.equal(require('node:events').getEventListeners(controller.signal,'abort').length,0);
  }finally{h.apiPool.reserve=nativeReserve;for(const value of held)releaseLease(value);if(pending)await pending;}
  assert.deepEqual(snapshot(),{active:0,waiting:0});
});

test('N1 bootstrap disconnect: cancellation during openTenantRequest rolls back before returning its connection',async()=>{
  const {s}=await ready(),sql=await h.admin.reserve(),signs=signedGets;let client;
  await sql`BEGIN`;const [{pid}]=await sql`SELECT pg_backend_pid() pid`;
  await sql`LOCK TABLE public.memberships IN ACCESS EXCLUSIVE MODE`;
  const closed=new Promise(resolve=>app.server.once('request',(_req,res)=>res.once('close',resolve)));
  try{
    client=startDownload(s.mediaAssetId);await until(()=>blockedBy(pid));client.request.destroy();await client.response;await closed;
    assert.equal(snapshot().active,1);await sql`ROLLBACK`;await until(()=>snapshot().active===0);await until(noDownloadTransactions);
    assert.equal(signedGets,signs);assert.deepEqual(snapshot(),{active:0,waiting:0});
  }finally{await sql`ROLLBACK`.catch(()=>{});sql.release();if(client)await client.response;}
  assert.equal((await download(s.mediaAssetId)).status,200);
});
