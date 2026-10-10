'use strict';
const { test, before, after } = require('node:test');
const { Writable } = require('node:stream');
const postgres = require('postgres');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const h = require('../crm-api/helpers.cjs');
const { parent } = require('./operational-helpers.cjs');
const { assert } = h;
const retention = h.load('media/retention.js');
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { removeUnattachedMedia } = h.load('media/deletion.js');
const { purgeMediaAsset, discoverMediaPurges, dueMediaPurges } = h.load('media/purger.js');
const mediaService = h.load('media/service.js');
const associations = h.load('media/associations.js');
const { deleteR2Object } = h.load('media/r2.js');
const r2 = {...require('../media/fixtures.cjs').r2,bucket:'TEST-ONLY'};
const originalFetch = globalThis.fetch;
let a, b, app, purger, purgerLogin;
before(async () => {
 ({a,b}=await h.twoTenants());
 purgerLogin='tm_b06_'+randomUUID().replaceAll('-','');
 const password=randomUUID();
 await h.admin.unsafe(`CREATE ROLE ${purgerLogin} LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER PASSWORD '${password}'`);
 await h.admin.unsafe(`GRANT tallermecario_media_purger TO ${purgerLogin}`);
 const url=new URL(process.env.TEST_DATABASE_URL_ADMIN);url.username=purgerLogin;url.password=password;
 purger=postgres(url.toString(),{max:10,prepare:false,onnotice:()=>{},connection:{role:'tallermecario_media_purger'}});
 app=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(request){
  const subject=request.headers.authorization?.slice(7);return subject?{identityProvider:'clerk',externalSubject:subject}:null;
 }},rateLimit:{max:100000,timeWindow:'1 minute'},logStream:new Writable({write(_c,_e,done){done();}}),
 registerRoutes(server){registerMediaRoutes(server,r2);}});
});
after(async()=>{globalThis.fetch=originalFetch;await purger?.end();
 await h.admin.unsafe(`DROP ROLE ${purgerLogin}`);await h.closeAll(app);});
const run = (tenant, fn) => h.asRuntime(h.apiPool, { tenantId: tenant.tenantId,
  userId: tenant.owner.user.id, membershipId: tenant.owner.membershipId }, fn);
const evaluate = (id, tenant = a) => run(tenant, (sql) => retention.evaluateMediaRetention(sql, tenant.tenantId, id));
const recalculate = (id, tenant = a) => run(tenant, (sql) => retention.recalculateMediaRetention(sql, tenant.tenantId, id));
async function asset(extra = {}, tenant = a) {
  const row = { id: randomUUID(), tenant_id: tenant.tenantId, bucket: 'TEST-ONLY', object_key: randomUUID(),
    media_type: 'photo', mime_type: 'image/png', status: 'active', retention_class: 'operational',
    retention_policy_version: 'v1', uploaded_at: '2024-01-31T10:15:30.123456Z', ...extra };
  await h.admin`INSERT INTO media_assets ${h.admin(row)}`;
  for (const field of ['uploaded_at','quarantined_at','retention_until','legal_hold_until']) {
    if (typeof row[field] === 'string') await h.admin.unsafe(
      `UPDATE media_assets SET ${field}=$1::text::timestamptz WHERE id=$2`,[row[field],row.id]);
  }
  return row.id;
}
async function session(id, extra = {}, tenant = a) {
  const row = { id: randomUUID(), tenant_id: tenant.tenantId, media_asset_id: id,
    idempotency_key: randomUUID(), status: 'pending', expected_size_bytes: 68,
    created_at: '2024-01-31T10:15:30.123456Z', expires_at: '2024-01-31T10:30:30.123456Z', ...extra };
  await h.admin`INSERT INTO upload_sessions ${h.admin(row)}`;
  if (typeof row.created_at === 'string') await h.admin`UPDATE upload_sessions
    SET created_at=${row.created_at}::text::timestamptz WHERE id=${row.id}`;
  return row;
}
async function order(status = 'delivered', closedAt = '2020-02-29T10:15:30.123456Z', tenant = a) {
  const p = await parent(tenant), id = randomUUID();
  // TEST-ONLY future terminal parent state; B05 creates no transition command.
  // Constraints/FKs remain enabled for every media source and runtime operation.
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role=replica`;
    await tx`UPDATE receptions SET status='closed',closed_at='2020-01-01T00:00:00Z' WHERE id=${p.reception}`;
    await tx`INSERT INTO service_orders(id,tenant_id,reception_id,vehicle_id,customer_id,order_number,
      created_by_membership_id,status,closed_at) VALUES (${id},${tenant.tenantId},${p.reception},${p.vehicle},${p.customer},
        ${BigInt('0x'+id.replaceAll('-','').slice(0,12))},${tenant.owner.membershipId},${status},
        ${['delivered','cancelled'].includes(status) ? closedAt : null}::text::timestamptz)`;
    await tx`INSERT INTO order_status_history(id,tenant_id,order_id,to_status,request_id)
      VALUES (${randomUUID()},${tenant.tenantId},${id},'reception',${randomUUID()})`;
  });
  return { ...p, id };
}
async function link(id, o, kind = 'reception_media', tenant = a) {
  const tx = h.admin, linked = randomUUID();
  // Historical/future retention inventory fixtures deliberately bypass INSERT
  // lifecycle guards as superuser only. Canonical purpose CHECKs remain on; runtime FK coverage is separate.
  // Phase-B runtime guard behavior has its own nonprivileged suite.
  if (kind === 'reception_media' || kind === 'damage_media') await h.admin.begin(async fixture => {
    await fixture`SET LOCAL session_replication_role=replica`;
    if (kind === 'reception_media') await fixture`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${o.reception},${id},'intake_evidence')`;
    else await fixture`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${o.damage},${id},'damage_evidence')`;
  });
  if (kind === 'finding_media') {
    const diagnostic = randomUUID();
    await tx`INSERT INTO diagnostics(id,tenant_id,order_id,diagnosed_by_membership_id)
      VALUES (${diagnostic},${tenant.tenantId},${o.id},${tenant.owner.membershipId})`;
    await tx`INSERT INTO findings(id,tenant_id,diagnostic_id,order_id,category,title,description)
      VALUES (${linked},${tenant.tenantId},${diagnostic},${o.id},'TEST','TEST','TEST')`;
    await tx`INSERT INTO finding_media(tenant_id,finding_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'work_activity_media') {
    await tx`INSERT INTO work_activities(id,tenant_id,order_id,service_order_item_id,title)
      VALUES (${linked},${tenant.tenantId},${o.id},${o.item ?? null},'TEST')`;
    await tx`INSERT INTO work_activity_media(tenant_id,work_activity_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'quality_check_media') {
    await tx`INSERT INTO assignments(id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
      VALUES (${randomUUID()},${tenant.tenantId},${o.id},${tenant.owner.membershipId},'quality_control',${tenant.owner.membershipId})`;
    await tx`INSERT INTO quality_checks(id,tenant_id,order_id,checked_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${o.id},${tenant.owner.membershipId})`;
    await tx`INSERT INTO quality_check_media(tenant_id,quality_check_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'delivery_media') {
    await tx`INSERT INTO deliveries(id,tenant_id,order_id,status,delivered_at,delivered_to_name,delivered_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${o.id},${o.pending ? 'pending' : 'completed'},
        ${o.pending ? null : '2020-02-29T10:15:30.123456Z'}::text::timestamptz,
        ${o.pending ? null : 'TEST'},${o.pending ? null : tenant.owner.membershipId})`;
    await tx`INSERT INTO delivery_media(tenant_id,delivery_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'quote_media') {
    const quote = randomUUID();
    await tx`INSERT INTO quotes(id,tenant_id,order_id,quote_type,created_by_membership_id)
      VALUES (${quote},${tenant.tenantId},${o.id},'initial',${tenant.owner.membershipId})`;
    await tx`INSERT INTO quote_versions(id,tenant_id,quote_id,order_id,version_number,subtotal_amount,total_amount,created_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${quote},${o.id},1,0,0,${tenant.owner.membershipId})`;
    await tx`INSERT INTO quote_media(tenant_id,quote_version_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  return linked;
}
async function warranty(o, expires = '2026-01-31T10:15:30.123456Z', tenant = a) {
  const id = randomUUID();
  await h.admin`INSERT INTO service_order_items(id,tenant_id,order_id,sales_originator_membership_id,
    item_type,name_snapshot,quantity_authorized,unit_price,source,created_by_membership_id,warranty_origin,warranty_expires_at)
    VALUES (${id},${tenant.tenantId},${o.id},${tenant.owner.membershipId},'labor','TEST',1,0,'other',
      ${tenant.owner.membershipId},'catalog_default',${expires}::text::timestamptz)`;
  return id;
}
async function privacy(id, tenant = a) {
  const customer = await h.seedCustomer(tenant.tenantId), consent = randomUUID();
  await h.admin`INSERT INTO privacy_consents(id,tenant_id,customer_id,purpose_code,privacy_notice_version,
    authorization_text_version,authorization_text_hash,controller_notice_snapshot,channel,captured_at,evidence_media_id)
    VALUES (${consent},${tenant.tenantId},${customer.id},'service_provision','TEST','TEST',${'f'.repeat(64)},
      ${h.admin.json({legalName:'TEST',address:'TEST',phone:'+5700000000',email:null,rightsChannel:'TEST'})},
      'in_person','2020-01-01T00:00:00Z',${id})`;
  return consent;
}
const row = async (id) => (await h.admin`SELECT * FROM media_assets WHERE id=${id}`)[0];
const audits = (id) => h.admin`SELECT * FROM audit_logs WHERE entity_id=${id} AND action='media.retention_updated'`;


const job=async id=>(await h.admin`SELECT * FROM media_purge_jobs WHERE media_asset_id=${id}`)[0];
const lifecycleAudits=id=>h.admin`SELECT * FROM audit_logs WHERE entity_id=${id} AND action IN ('media.deletion_requested','media.purged') ORDER BY created_at,id`;
const remove=id=>run(a,sql=>removeUnattachedMedia(sql,id));
const purge=(id,transport=async()=> 'deleted',tenant=a)=>purgeMediaAsset(purger,r2,tenant.tenantId,id,transport);
const purgeTx=(fn,tenant=a)=>h.asRuntime(purger,{tenantId:tenant.tenantId},fn);
const queue=id=>purgeTx(sql=>sql`SELECT app.queue_retention_media_purge(${id}::uuid)`);
async function call(id,actor=a.owner,tenant=a,body) {
 const response=await app.inject({method:'POST',url:`/api/v1/media/${id}/remove-unattached`,
 headers:{authorization:`Bearer ${actor.subject}`,'x-tenant-id':tenant.tenantId},...(body===undefined?{}:{payload:JSON.stringify(body),headers:{authorization:`Bearer ${actor.subject}`,'x-tenant-id':tenant.tenantId,'content-type':'application/json'}})});
 return {status:response.statusCode,body:response.json(),headers:response.headers};
}
function error(response,status,code){assert.equal(response.status,status,JSON.stringify(response.body));assert.equal(response.body.error.code,code);}
async function expireClaim(id){await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx`UPDATE media_purge_jobs SET claim_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE media_asset_id=${id}`;});}
async function blocked(pid){for(let i=0;i<1000;i++){
 const [r]=await h.admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) blocked`;
 if(r.blocked)return;await yieldTurn();}throw new Error('real PostgreSQL overlap not established');}
async function overlap(firstOp,secondOp){
 let release,ready,failed;const gate=new Promise(r=>release=r),held=new Promise((r,j)=>{ready=r;failed=j;});
 const first=run(a,async sql=>{const result=await firstOp(sql);const [p]=await sql`SELECT pg_backend_pid() pid`;ready(p.pid);await gate;return result;});first.catch(failed);
 const pid=await held,second=run(a,secondOp);second.catch(()=>{});
 try{await blocked(pid);}finally{release();}return Promise.allSettled([first,second]);
}

for(const actor of ['owner','admin'])test(`${actor}: accepted command, immediate tombstone, safe 202, replay, completed replay`,async()=>{
 const id=await asset(),r=await call(id,a[actor]);assert.equal(r.status,202,JSON.stringify(r.body));
 assert.deepEqual(r.body,{mediaAssetId:id,deletionState:'deleted'});assert.equal(r.headers['cache-control'],'no-store');
 const stored=await row(id);assert.equal(stored.status,'deleted');assert.ok(stored.deleted_at);assert.ok(stored.deletion_requested_at);assert.equal(stored.purged_at,null);
 assert.equal(stored.delete_reason,'manual_unattached');assert.ok(await job(id));
 assert.deepEqual((await call(id,a[actor],a,{})).body,r.body);assert.equal((await lifecycleAudits(id)).length,1);
 assert.equal(await purge(id),'completed');assert.equal((await row(id)).status,'deleted');assert.ok((await row(id)).purged_at);
 assert.deepEqual((await call(id)).body,{mediaAssetId:id,deletionState:'purged'});assert.equal((await lifecycleAudits(id)).length,2);
 const [n]=await h.admin`SELECT count(*)::int n FROM media_purge_jobs WHERE media_asset_id=${id}`;assert.equal(n.n,1);
});
for(const actor of ['advisor','technician'])test(`${actor}: permission denial before valid, foreign or malformed resource lookup`,async()=>{
 for(const id of [await asset(),randomUUID(),'not-a-uuid',await asset({},b)])error(await call(id,a[actor]),403,'PERMISSION_DENIED');
});
test('strict empty body, foreign/missing 404 and no confidential references in errors',async()=>{
 const id=await asset();for(const body of [{reason:'secret'},{tenantId:b.tenantId},{retentionUntil:'2000-01-01'},null,[]])
 error(await call(id,a.owner,a,body),400,'REQUEST_VALIDATION_FAILED');
 for(const foreign of [await asset({},b),randomUUID(),'invalid'])error(await call(foreign),404,'MEDIA_ASSET_NOT_FOUND');
 assert.equal(await job(id),undefined);
});
for(const kind of ['reception_media','damage_media','finding_media','work_activity_media','quality_check_media','delivery_media','quote_media'])
test(`complete manual inventory: ${kind} rejects even expired evidence`,async()=>{
 const id=await asset(),o=await order();await link(id,o,kind);error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');
 assert.equal((await row(id)).status,'active');assert.equal(await job(id),undefined);
});
async function signed(id){const p=await parent(a),sid=randomUUID();await h.admin`INSERT INTO signatures(id,tenant_id,reception_id,signature_media_id,
 signed_by_name,document_version,document_hash,signed_at) VALUES(${sid},${a.tenantId},${p.reception},${id},'TEST','TEST','TEST','2020-01-31T10:15:30.123456Z')`;return sid;}
test('signature manual reject; expired dedicated purge preserves every signed identity and historical reference',async()=>{
 const id=await asset({media_type:'signature',retention_class:'authorization_evidence',checksum_sha256:'a'.repeat(64),retention_policy_version:'historical-v0'}),sid=await signed(id);
 error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');const before=await row(id);
 const [sig]=await h.admin`SELECT row_to_json(s) value FROM signatures s WHERE id=${sid}`;
 await queue(id);assert.equal(await purge(id),'completed');const after=await row(id);
 for(const key of ['id','tenant_id','object_key','bucket','storage_provider','checksum_sha256','media_type','mime_type','size_bytes','retention_policy_version','retention_class','retention_until'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual((await h.admin`SELECT row_to_json(s) value FROM signatures s WHERE id=${sid}`)[0].value,sig.value);
 assert.ok(after.purged_at>=after.deleted_at);
 await assert.rejects(run(a,sql=>sql`UPDATE media_assets SET status='active' WHERE id=${id}`),e=>e.code==='23514');
});
test('privacy evidence manual and automatic remain protective without an invented clock',async()=>{
 const id=await asset({media_type:'signature',retention_class:'authorization_evidence'});await privacy(id);
 error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');await assert.rejects(queue(id),e=>e.message==='MEDIA_DELETE_NOT_ELIGIBLE');assert.equal(await job(id),undefined);
});
for(const [name,extra,code] of [
 ['hold',{legal_hold_until:'2040-01-01'},'MEDIA_LEGAL_HOLD'],['future floor',{retention_until:'2040-01-01'},'MEDIA_DELETE_NOT_ELIGIBLE'],
 ['missing clock',{uploaded_at:null},'MEDIA_DELETE_NOT_ELIGIBLE'],['quarantine missing clock',{status:'quarantined'},'MEDIA_DELETE_NOT_ELIGIBLE']])
test(`${name}: server decision rejects`,async()=>{error(await call(await asset(extra)),409,code);});
test('active upload remains blocked even on old asset; expired incomplete capability can be removed',async()=>{
 const id=await asset({status:'pending_upload',uploaded_at:null});await session(id,{created_at:'2020-01-01',expires_at:'2040-01-01'});
 error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');const old=await asset({status:'pending_upload',uploaded_at:null});const s=await session(old);
 assert.equal((await call(old)).status,202);assert.equal(await purge(old),'completed');assert.ok(await h.admin`SELECT id FROM upload_sessions WHERE id=${s.id}`);
});
test('duplicate request concurrency has one logical job and request audit',async()=>{
 const id=await asset();const results=await Promise.all(Array.from({length:5},()=>call(id)));assert.ok(results.every(r=>r.status===202),JSON.stringify(results));
 assert.equal((await lifecycleAudits(id)).length,1);assert.equal((await job(id)).attempts,0);
});
test('download after tombstone is 404 and deleted historical associations disappear from both lists',async()=>{
 const id=await asset(),o=await order();await link(id,o);await link(id,o,'damage_media');await queue(id);
 const r=await app.inject({url:`/api/v1/media/${id}/download-url`,headers:{authorization:`Bearer ${a.owner.subject}`,'x-tenant-id':a.tenantId}});
 assert.equal(r.statusCode,404);assert.equal(r.json().error.code,'MEDIA_ASSET_NOT_FOUND');
 for(const type of ['reception','damage'])assert.equal((await run(a,sql=>associations.listAssociatedMedia(sql,a.tenantId,
  type==='reception'?{type,receptionId:o.reception}:{type,receptionId:o.reception,damageId:o.damage}))).length,0);
});
for(const kind of ['reception_media','damage_media','finding_media','work_activity_media','quality_check_media','delivery_media'])
test(`automatic ${kind} expired evidence purges binary and keeps link`,async()=>{
 const id=await asset(),o=await order();await link(id,o,kind);await queue(id);assert.equal((await job(id)).reason,'retention_expired');
 assert.equal(await purge(id),'completed');const [n]=await h.admin.unsafe(`SELECT count(*)::int n FROM ${kind} WHERE media_asset_id=$1`,[id]);assert.equal(n.n,1);
});
test('bounded deterministic discovery, full evaluator, quarantine cleanup and missing floor fail closed',async()=>{
 const id=await asset({status:'quarantined',quarantined_at:'2020-01-01'}),protectedId=await asset({uploaded_at:null});
 let cursor=null;for(let i=0;i<10;i++){cursor=await discoverMediaPurges(purger,a.tenantId,cursor,100);if(!cursor)break;}
 assert.ok(await job(id));assert.equal(await job(protectedId),undefined);assert.equal(await purge(id),'completed');
 assert.ok((await dueMediaPurges(purger,a.tenantId,100)).length<=100);
 await assert.rejects(discoverMediaPurges(purger,a.tenantId,null,101));
});
for(const result of ['deleted','absent'])test(`R2 ${result}: idempotent confirmed final audit`,async()=>{
 const id=await asset();await remove(id);assert.equal(await purge(id,async()=>result),'completed');assert.equal((await job(id)).last_result,result);
 assert.equal(await purge(id,async()=>{throw new Error('must not call');}),'deferred');assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
});
for(const failure of ['timeout','5xx','404','wrong_endpoint','wrong_bucket_account'])test(`R2 ${failure}: no false purged_at, normalized durable attempt`,async()=>{
 const id=await asset();await remove(id);globalThis.fetch=async(_url,options)=>{
  assert.equal(options.method,'DELETE');assert.ok(options.signal);
  if(failure==='timeout')throw new Error('TEST SECRET RAW STORAGE ERROR');return new Response('TEST SECRET',{status:failure==='5xx'?503:404});
 };assert.equal(await purge(id,deleteR2Object),'retry');assert.equal((await row(id)).purged_at,null);
 const j=await job(id);assert.equal(j.state,'retryable_storage_failure');assert.equal(j.last_result,'storage_unavailable');assert.equal(JSON.stringify(j).includes('TEST SECRET'),false);
 globalThis.fetch=originalFetch;
});
test('provider DELETE failure contract: abort/403/500 unknown never counts as deletion',async()=>{
 for(const status of [403,500,202]){globalThis.fetch=async()=>new Response(null,{status});await assert.rejects(deleteR2Object(r2,'opaque'),/MEDIA_STORAGE_UNAVAILABLE/);}
 globalThis.fetch=async()=>new Response(null,{status:204});assert.equal(await deleteR2Object(r2,'opaque'),'deleted');
 globalThis.fetch=async()=>new Response(null,{status:404});await assert.rejects(deleteR2Object(r2,'opaque'),/MEDIA_STORAGE_UNAVAILABLE/);
 const c=new AbortController();c.abort();await assert.rejects(deleteR2Object(r2,'opaque',c.signal));globalThis.fetch=originalFetch;
});
async function injectFailure(table,condition,work){
 await h.admin.unsafe(`CREATE FUNCTION public.b06_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'TEST FAILURE'; END IF; RETURN NEW; END $$`);
 await h.admin.unsafe(`CREATE TRIGGER b06_fail_trg BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.b06_fail()`);
 try{return await work();}finally{await h.admin.unsafe(`DROP TRIGGER b06_fail_trg ON public.${table}`);await h.admin.unsafe('DROP FUNCTION public.b06_fail()');}
}
for(const table of ['audit_logs','media_purge_jobs'])test(`${table} request failure rolls back tombstone/job/audit atomically`,async()=>{
 const id=await asset();await injectFailure(table,table==='audit_logs'?"NEW.action='media.deletion_requested'":'true',async()=>{assert.equal((await call(id)).status,500);});
 assert.equal((await row(id)).status,'active');assert.equal(await job(id),undefined);assert.equal((await lifecycleAudits(id)).length,0);
});
test('R2 success + DB confirmation audit failure records uncertainty; retry confirms absence once',async()=>{
 const id=await asset();await remove(id);let exists=true;
 const storage=async()=>{if(exists){exists=false;return 'deleted';}return 'absent';};
 await injectFailure('audit_logs',"NEW.action='media.purged'",async()=>{assert.equal(await purge(id,storage),'retry');});
 assert.equal(exists,false);assert.equal((await row(id)).purged_at,null);assert.equal((await job(id)).state,'db_confirmation_retry');
 assert.equal((await job(id)).last_result,'deleted');await expireClaim(id);assert.equal(await purge(id,storage),'completed');
 assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
});
test('crash after R2 success before recording: abandoned claim retries absence with a new attempt',async()=>{
 const id=await asset();await remove(id);const c=await purger.reserve(),claim=randomUUID();
 try{await c`BEGIN`;await c`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
  const [f]=await c`SELECT app.media_purge_fence_key(${id}::uuid)::text key,pg_advisory_lock(app.media_purge_fence_key(${id}::uuid))`;
  await c`SELECT * FROM app.claim_media_purge(${id}::uuid,${claim}::uuid)`;await c`COMMIT`;
  // Simulated successful storage DELETE, then process crash before result/confirm.
  await c`SELECT pg_advisory_unlock(${f.key}::bigint)`;
 }finally{c.release();}
 assert.equal(await purge(id),'deferred','durable lease survives a lost session');assert.equal((await row(id)).purged_at,null);
 await expireClaim(id);assert.equal(await purge(id,async()=> 'absent'),'completed');assert.equal((await job(id)).attempts,2);
});
test('concurrent purgers: single claimant, no transaction over storage, exactly one final audit',async()=>{
 const id=await asset();await remove(id);let calls=0,release,ready;
 const gate=new Promise(r=>release=r),held=new Promise(r=>ready=r);
 const first=purge(id,async()=>{calls++;const [n]=await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE usename=${purgerLogin} AND state='idle in transaction'`;
 assert.equal(n.n,0);ready();await gate;return 'deleted';});await held;
 try{assert.equal(await purge(id),'deferred');}finally{release();}
 assert.equal(await first,'completed');assert.equal(calls,1);assert.equal((await job(id)).attempts,1);
 assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
});
test('hold after tombstone but before final storage decision suspends, never reactivates',async()=>{
 const id=await asset();await remove(id);await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 assert.equal(await purge(id,async()=>{throw new Error('must not DELETE');}),'deferred');assert.equal((await job(id)).state,'suspended');
 assert.equal((await row(id)).status,'deleted');assert.equal((await row(id)).purged_at,null);
});
test('hold/floor during physical phase fails fast on fence; future hold command must retry',async()=>{
 const id=await asset();await remove(id);
 assert.equal(await purge(id,async()=>{
  await assert.rejects(h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`,e=>e.constraint_name==='media_purge_fence_guard');
  await assert.rejects(h.admin`UPDATE media_assets SET retention_until='2040-01-01' WHERE id=${id}`,e=>e.constraint_name==='media_purge_fence_guard');
  return 'deleted';}),'completed');
});
test('new privileged protective reference after tombstone is re-inventoried and stops storage',async()=>{
 const id=await asset({media_type:'signature',retention_class:'authorization_evidence'});await remove(id);
 // Test-only legacy writer injection, guards remain enabled for production.
 const customer=await h.seedCustomer(a.tenantId);
 await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;
 await tx`INSERT INTO privacy_consents(id,tenant_id,customer_id,purpose_code,privacy_notice_version,authorization_text_version,
 authorization_text_hash,controller_notice_snapshot,channel,captured_at,evidence_media_id)
 VALUES(${randomUUID()},${a.tenantId},${customer.id},'service_provision','TEST','TEST',${'f'.repeat(64)},
 ${tx.json({legalName:'TEST',address:'TEST',phone:'+5700000000',email:null,rightsChannel:'TEST'})},'in_person',now(),${id})`;});
 assert.equal(await purge(id,async()=>{throw new Error('must not call');}),'deferred');assert.equal((await row(id)).purged_at,null);
});
for(const poolName of ['apiPool','workerPool'])test(`${poolName}: direct destructive column/status SQL denied and private entrypoints unreachable`,async()=>{
 const id=await asset();for(const column of ['deletion_requested_at','deleted_at','purged_at','delete_reason'])
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql.unsafe(`UPDATE media_assets SET ${column}=NULL WHERE id=$1`,[id])),e=>e.code==='42501');
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql`UPDATE media_assets SET status='deleted' WHERE id=${id}`),e=>['23514','42501'].includes(e.code));
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql`SELECT app.queue_retention_media_purge(${id}::uuid)`),e=>e.code==='42501');
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql`SELECT app.confirm_media_purge(${id}::uuid,${randomUUID()}::uuid)`),e=>e.code==='42501');
});
test('purger alone has no direct mutation/owner privilege, cannot bypass floor, claim or cross-tenant context',async()=>{
 const id=await asset({retention_until:'2040-01-01'}),foreign=await asset({},b);
 for(const target of [id,foreign])await assert.rejects(queue(target),e=>['MEDIA_DELETE_NOT_ELIGIBLE','MEDIA_ASSET_NOT_FOUND'].includes(e.message));
 await assert.rejects(purgeTx(sql=>sql`UPDATE media_assets SET status='deleted' WHERE id=${id}`),e=>e.code==='42501');
 await assert.rejects(purgeTx(sql=>sql`SELECT app.claim_media_purge(${id}::uuid,${randomUUID()}::uuid)`),/MEDIA_PURGE_FENCE_REQUIRED/);
 for(const role of ['tallermecario_api','tallermecario_worker','tallermecario_media_lifecycle','tallermecario_schema_owner'])
 await assert.rejects(purger.unsafe(`SET ROLE ${role}`),e=>e.code==='42501');
 const [flags]=await purger`SELECT r.rolbypassrls,r.rolsuper,(SELECT count(*)::int FROM pg_class WHERE relowner=r.oid) owned FROM pg_roles r WHERE rolname=current_user`;
 assert.equal(flags.rolbypassrls,false);assert.equal(flags.rolsuper,false);assert.equal(flags.owned,0);
 assert.equal(await purge(foreign),'retry');assert.equal((await row(foreign)).status,'active');
});
for(const deletionFirst of [false,true])test(`completion/delete real row barrier, deletion first=${deletionFirst}`,async()=>{
 const id=await asset({media_type:'signature',retention_class:'authorization_evidence',status:'pending_upload',uploaded_at:null});
 const s=await session(id,{expires_at:'2040-01-01'}),plan=await run(a,sql=>mediaService.prepareUploadCompletion(sql,a.tenantId,s.id));
 if(deletionFirst){await h.admin`UPDATE upload_sessions SET expires_at='2020-01-01' WHERE id=${s.id}`;}
 const complete=sql=>mediaService.completeUploadSession(sql,a.tenantId,s.id,plan,{plan,sizeBytes:68,failure:null},null);
 const del=sql=>removeUnattachedMedia(sql,id);
 const results=await overlap(deletionFirst?del:complete,deletionFirst?complete:del);
 assert.equal(results[0].status,'fulfilled',results[0].reason?.message);
 if(!deletionFirst){assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'MEDIA_DELETE_NOT_ELIGIBLE');assert.equal((await row(id)).status,'active');}
 else{assert.equal(results[1].status,'fulfilled');assert.equal(results[1].value.kind,'durable-error');assert.equal(results[1].value.error.code,'UPLOAD_SESSION_EXPIRED');assert.equal((await row(id)).status,'deleted');}
});
for(const deletionFirst of [false,true])test(`attach/delete real row barrier, deletion first=${deletionFirst}`,async()=>{
 const p=await parent(a),id=await asset({status:'pending_upload'}),s=await session(id);
 await h.admin`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,privacy_consent_id) VALUES(${a.tenantId},${s.id},${p.reception},${p.consent})`;
 await h.admin`UPDATE upload_sessions SET status='completed',completed_at=now() WHERE id=${s.id}`;await h.admin`UPDATE media_assets SET status='active' WHERE id=${id}`;
 // Completed open binding protects manual remove. For the DELETE winner use
 // legitimate quarantine cleanup; association must reject its tombstone.
 if(deletionFirst)await h.admin`UPDATE media_assets SET status='quarantined',quarantined_at='2020-01-01' WHERE id=${id}`;
 const attach=sql=>associations.attachMedia(sql,a.tenantId,{type:'reception',receptionId:p.reception},{mediaAssetId:id});
 const del=sql=>removeUnattachedMedia(sql,id);
 const results=await overlap(deletionFirst?del:attach,deletionFirst?attach:del);
 assert.equal(results[0].status,'fulfilled',results[0].reason?.message);assert.equal(results[1].status,'rejected');
 assert.equal(results[1].reason.code,deletionFirst?'MEDIA_ASSET_NOT_ELIGIBLE':'MEDIA_DELETE_NOT_ELIGIBLE');
 const [n]=await h.admin`SELECT count(*)::int n FROM reception_media WHERE media_asset_id=${id}`;assert.equal(n.n,deletionFirst?0:1);
 assert.equal((await row(id)).status,deletionFirst?'deleted':'active');
});
test('all reference and session guards reject deletion-marked assets through raw runtime writes',async()=>{
 const id=await asset(),p=await parent(a);await remove(id);
 await assert.rejects(run(a,sql=>sql`INSERT INTO upload_sessions(id,tenant_id,media_asset_id,idempotency_key,expires_at,expected_size_bytes)
 VALUES(${randomUUID()},${a.tenantId},${id},${randomUUID()},now()+interval '1 hour',68)`),e=>e.constraint_name==='media_reference_tombstone_guard');
 for(const type of ['reception','damage'])await assert.rejects(run(a,sql=>sql.unsafe(type==='reception'
 ?"INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose) VALUES($1,$2,$3,'intake_evidence')"
 :"INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose) VALUES($1,$2,$3,'damage_evidence')",
 [a.tenantId,type==='reception'?p.reception:p.damage,id])),e=>e.code==='23514');
 for(const table of ['reception_media','damage_media','finding_media','work_activity_media','quality_check_media','delivery_media','quote_media','signatures','privacy_consents','upload_sessions']){
 const [r]=await h.admin`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=${'public.'+table}::regclass AND tgname='z_media_reference_tombstone_trg' AND tgenabled='O'`;assert.equal(r.n,1,table);}
});

for(const kind of ['reception_media','work_activity_media','delivery_media'])test(`physical fence rejects a new protective ${kind} source clock`,async()=>{
 const id=await asset(),o=await order();
 if(kind==='work_activity_media')o.item=await warranty(o,'2020-01-01');
 const target=await link(id,o,kind);await queue(id);
 assert.equal(await purge(id,async()=>{
  if(kind==='reception_media')await assert.rejects(h.admin`UPDATE service_orders SET closed_at='2040-01-01' WHERE id=${o.id}`,
   e=>e.constraint_name==='media_purge_fence_guard');
  if(kind==='work_activity_media')await assert.rejects(h.admin`UPDATE service_order_items SET warranty_expires_at='2040-01-01' WHERE id=${o.item}`,
   e=>e.constraint_name==='media_purge_fence_guard');
  if(kind==='delivery_media')await assert.rejects(h.admin`UPDATE deliveries SET delivered_at='2040-01-01' WHERE id=${target}`,
   e=>e.constraint_name==='media_purge_fence_guard');
  return 'deleted';
 }),'completed');
});
test('tombstone cannot regain a live upload capability through session UPDATE',async()=>{
 const id=await asset({status:'pending_upload',uploaded_at:null}),s=await session(id);await remove(id);
 await assert.rejects(run(a,sql=>sql`UPDATE upload_sessions SET expires_at='2040-01-01' WHERE id=${s.id}`),
  e=>e.constraint_name==='media_reference_tombstone_guard');
 assert.equal((await row(id)).status,'deleted');
});
test('all B06 definer entrypoints use the non-owner forced-RLS lifecycle role with no public execute',async()=>{
 const functions=await h.admin`SELECT p.proname,p.prosecdef,p.proconfig,r.rolname owner,r.rolbypassrls,
  EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
  FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='app'::regnamespace AND r.rolname='tallermecario_media_lifecycle' AND p.prosecdef`;
 assert.ok(functions.length>=12);for(const f of functions){assert.equal(f.prosecdef,true,f.proname);assert.equal(f.rolbypassrls,false);
 assert.equal(f.public_execute,false,f.proname);assert.ok(f.proconfig.includes('search_path=pg_catalog'));}
 const [r]=await h.admin`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.media_purge_jobs'::regclass`;
 assert.equal(r.relrowsecurity,true);assert.equal(r.relforcerowsecurity,true);
});


const b05 = require('./b05-retention-oracle.cjs');
for(const mediaType of ['photo','video','video360','signature','document','quote_pdf'])
for(const warrantyState of ['none','expired','future','unresolved'])
test(`R1 original B05 differential: ${mediaType}/${warrantyState}`,async()=>{
 const id=await asset({media_type:mediaType,retention_class:['signature','document','quote_pdf'].includes(mediaType)?'authorization_evidence':'operational'}),o=await order();
 o.item=await warranty(o,warrantyState==='future'?'2040-01-01':warrantyState==='unresolved'?null:'2020-01-01');
 if(warrantyState==='none')await h.admin`UPDATE service_order_items SET warranty_origin='none',warranty_expires_at=NULL WHERE id=${o.item}`;
 await link(id,o,'work_activity_media');
 const old=await run(a,sql=>b05.evaluateMediaRetention(sql,a.tenantId,id)),fresh=await evaluate(id);
 assert.deepEqual(fresh,old);
 // Roll back original persistence/audit, then execute SQL-backed persistence on
 // the very same asset: equality includes source IDs and microsecond floors.
 let expectedFloor,expectedAudit;
 const rollback=new Error('TEST_ORACLE_ROLLBACK');
 await assert.rejects(run(a,async sql=>{
  assert.deepEqual(await b05.recalculateMediaRetention(sql,a.tenantId,id),old);
  expectedFloor=(await sql`SELECT retention_until::text value FROM media_assets WHERE id=${id}`)[0].value;
  expectedAudit=await sql`SELECT action,before_json,after_json FROM audit_logs WHERE entity_id=${id} AND action='media.retention_updated'`;
  throw rollback;
 }),e=>e===rollback);
 assert.deepEqual(await recalculate(id),old);
 assert.equal((await h.admin`SELECT retention_until::text value FROM media_assets WHERE id=${id}`)[0].value,expectedFloor);
 assert.deepEqual(await h.admin`SELECT action,before_json,after_json FROM audit_logs WHERE entity_id=${id} AND action='media.retention_updated'`,expectedAudit);
 if(['signature','document','quote_pdf'].includes(mediaType)){
  assert.equal(fresh.knownRetentionUntil,null);assert.equal(fresh.blocksAutomaticPurge,true);
  assert.deepEqual(fresh.blockers,['UNRESOLVED_PROTECTION']);assert.equal(fresh.sources.length,1);
  assert.equal(fresh.eligibility,'NOT_ELIGIBLE_UNRESOLVED_PROTECTION');assert.equal((await row(id)).retention_until,null);assert.equal((await audits(id)).length,0);
 }
});
for(const kind of ['unlinked','reception_media','damage_media','signed'])test(`R2 automatic tombstone is never manual replay: ${kind}`,async()=>{
 const id=await asset(kind==='signed'?{media_type:'signature',retention_class:'authorization_evidence'}:{});
 if(kind==='signed')await signed(id);else if(kind!=='unlinked')await link(id,await order(),kind);
 await queue(id);const before=await job(id);
 error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');assert.equal((await lifecycleAudits(id)).length,1);
 assert.equal((await job(id)).id,before.id);assert.equal((await job(id)).reason,'retention_expired');
 assert.equal(await purge(id),'completed');error(await call(id),409,'MEDIA_DELETE_NOT_ELIGIBLE');
 assert.equal((await lifecycleAudits(id)).length,2);
});
test('R3 lifecycle raw SQL immutable fields and illegal transitions enforced by trigger',async()=>{
 const id=await asset();await remove(id);
 const immutable=['tenant_id','media_asset_id','id','reason','prior_status','created_at'];
 // Disposable admin grants prove the trigger, independently of column ACLs.
 await h.admin.unsafe(`GRANT UPDATE(${immutable.join(',')}) ON media_purge_jobs TO tallermecario_media_lifecycle`);
 try{
  for(const column of immutable)await assert.rejects(h.admin.begin(async tx=>{
   await tx`SET LOCAL ROLE tallermecario_media_lifecycle`;await tx`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
   const value=column==='reason'?"'retention_expired'":column==='prior_status'?"'uploaded'":column==='created_at'?"created_at+interval '1 second'":"gen_random_uuid()";
   await tx.unsafe(`UPDATE media_purge_jobs SET ${column}=${value} WHERE media_asset_id=$1`,[id]);
  }),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_immutable_guard',column);
 }finally{await h.admin.unsafe(`REVOKE UPDATE(${immutable.join(',')}) ON media_purge_jobs FROM tallermecario_media_lifecycle`);}
 for(const state of ['completed','storage_deleted','storage_absent','db_confirmation_retry','reconciliation_required','claimed'])
 await assert.rejects(h.admin.begin(async tx=>{
  await tx`SET LOCAL ROLE tallermecario_media_lifecycle`;await tx`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
  await tx`SELECT pg_advisory_xact_lock(app.media_purge_fence_key(${id}::uuid))`;
  await tx`UPDATE media_purge_jobs SET state=${state},completed_at=${state==='completed'?new Date():null} WHERE media_asset_id=${id}`;
 }),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_transition_guard',state);
 for(const role of ['tallermecario_api','tallermecario_worker','tallermecario_media_purger']){
  const [r]=await h.admin`SELECT has_table_privilege(${role},'media_purge_jobs','UPDATE') allowed`;assert.equal(r.allowed,false);
 }
 assert.equal(await purge(id),'completed');
});
for(const status of [200,204])test(`R4 successful idempotent DELETE ${status} confirms missing object`,async()=>{
 const id=await asset();await remove(id);globalThis.fetch=async()=>new Response(null,{status});
 try{assert.equal(await purge(id,deleteR2Object),'completed');assert.ok((await row(id)).purged_at);}
 finally{globalThis.fetch=originalFetch;}
});
async function workerClaim(id){
 const sql=await purger.reserve(),claim=randomUUID();let key;
 const tx=async work=>{await sql`BEGIN`;try{await sql`SELECT set_config('app.tenant_id',${a.tenantId},true)`;const r=await work();await sql`COMMIT`;return r;}catch(e){await sql`ROLLBACK`;throw e;}};
 await tx(async()=>{const [f]=await sql`SELECT app.media_purge_fence_key(${id}::uuid)::text key,pg_try_advisory_lock(app.media_purge_fence_key(${id}::uuid)) acquired`;assert.equal(f.acquired,true);key=f.key;await sql`SELECT * FROM app.claim_media_purge(${id}::uuid,${claim}::uuid)`;});
 return {sql,claim,tx,key,async unlock(){await sql`SELECT pg_advisory_unlock(${key}::bigint)`;},async close(){await sql`SELECT pg_advisory_unlock_all()`;sql.release();}};
}
for(const deletedBeforeTakeover of [false,true])test(`R5 ABA/stale A with physical delete=${deletedBeforeTakeover}`,async()=>{
 const id=await asset();await remove(id);let exists=true;
 const A=await workerClaim(id);if(deletedBeforeTakeover)exists=false;
 // Session fence loss is necessary before B can take over. Keep A's backend
 // alive to reproduce a stale continuation, without relying on sleeps.
 await A.unlock();await expireClaim(id);const B=await workerClaim(id),bJob=await job(id);
 try{
  for(const op of [()=>A.sql`SELECT app.record_media_purge_result(${id}::uuid,${A.claim}::uuid,'deleted')`,
   ()=>A.sql`SELECT app.confirm_media_purge(${id}::uuid,${A.claim}::uuid)`,
   ()=>A.sql`SELECT * FROM app.claim_media_purge(${id}::uuid,${A.claim}::uuid)`])await assert.rejects(A.tx(op),/MEDIA_PURGE_(RESULT_INVALID|FENCE_REQUIRED)/);
  assert.equal((await job(id)).claim_id,B.claim);assert.deepEqual((await job(id)).claim_until,bJob.claim_until);
  assert.equal((await row(id)).purged_at,null);assert.equal((await lifecycleAudits(id)).length,1);
  const [released]=await A.sql`SELECT pg_advisory_unlock(${B.key}::bigint) released`;assert.equal(released.released,false);
  // B holds its fence; A cannot reacquire it or overwrite B's claim.
  const [f]=await A.tx(()=>A.sql`SELECT pg_try_advisory_lock(app.media_purge_fence_key(${id}::uuid)) acquired`);assert.equal(f.acquired,false);
  const result=exists?'deleted':'absent';exists=false;
  await B.tx(()=>B.sql`SELECT app.record_media_purge_result(${id}::uuid,${B.claim}::uuid,${result})`);
  await B.tx(()=>B.sql`SELECT app.confirm_media_purge(${id}::uuid,${B.claim}::uuid)`);
  assert.equal((await job(id)).state,'completed');assert.ok((await row(id)).purged_at);
  assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
 }finally{await A.close();await B.close();}
});
for(const manualWins of [true,false])test(`R5 manual/automatic real barrier manual wins=${manualWins}`,async()=>{
 const id=await asset();let release,ready;const gate=new Promise(r=>release=r),held=new Promise(r=>ready=r);
 const manual=sql=>removeUnattachedMedia(sql,id),automatic=sql=>sql`SELECT app.queue_retention_media_purge(${id}::uuid)`;
 const first=(manualWins?run(a,async sql=>{const r=await manual(sql);ready((await sql`SELECT pg_backend_pid() pid`)[0].pid);await gate;return r;}):purgeTx(async sql=>{const r=await automatic(sql);ready((await sql`SELECT pg_backend_pid() pid`)[0].pid);await gate;return r;}));
 first.catch(()=>{});const pid=await held;
 const second=manualWins?purgeTx(automatic):run(a,manual);second.catch(()=>{});
 try{await blocked(pid);}finally{release();}
 const results=await Promise.allSettled([first,second]);assert.equal(results[0].status,'fulfilled');
 assert.equal(results[1].status,manualWins?'fulfilled':'rejected');if(!manualWins)assert.equal(results[1].reason.code,'MEDIA_DELETE_NOT_ELIGIBLE');
 assert.equal((await job(id)).reason,manualWins?'manual_unattached':'retention_expired');assert.equal((await lifecycleAudits(id)).length,1);
 let calls=0;assert.equal(await purge(id,async()=>{calls++;return 'deleted';}),'completed');assert.equal(await purge(id),'deferred');assert.equal(calls,1);
});
test('R6 real effective guard ACL excludes PUBLIC/schema owner/runtime',async()=>{
 for(const role of ['tallermecario_schema_owner','tallermecario_api','tallermecario_worker','tallermecario_media_purger']){
 const [r]=await h.admin`SELECT has_function_privilege(${role},'app.guard_media_retention_source()','EXECUTE') allowed`;assert.equal(r.allowed,false,role);}
 const [r]=await h.admin`SELECT r.rolname owner,r.rolbypassrls,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app.guard_media_retention_source()'::regprocedure`;
 assert.equal(r.owner,'tallermecario_media_lifecycle');assert.equal(r.rolbypassrls,false);assert.equal(r.public,false);
 const [schema]=await h.admin`SELECT has_schema_privilege('tallermecario_media_lifecycle','app','CREATE') allowed`;assert.equal(schema.allowed,false);
});
test('R7 physical deletion then expired lease then committed hold preserves reconciliation evidence',async()=>{
 const id=await asset();await remove(id);const A=await workerClaim(id);let exists=true;
 exists=false;await A.close();await expireClaim(id);
 await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 let calls=0;assert.equal(await purge(id,async()=>{calls++;return 'absent';}),'deferred');
 assert.equal(exists,false);assert.equal(calls,0);assert.equal((await row(id)).purged_at,null);
 assert.equal((await job(id)).state,'reconciliation_required');assert.equal((await job(id)).attempts,1);assert.equal((await job(id)).last_result,'storage_unavailable');
 assert.ok((await job(id)).claimed_at);assert.ok((await row(id)).legal_hold_until);assert.equal((await lifecycleAudits(id)).length,1);
 assert.equal(await purge(id),'deferred');assert.equal((await job(id)).last_result,'storage_unavailable');assert.ok((await row(id)).legal_hold_until);
});
test('R8 known advisory fence yields bounded retryable API error',async()=>{
 const id=await asset(),c=await purger.reserve();
 try{await c`BEGIN`;await c`SELECT set_config('app.tenant_id',${a.tenantId},true)`;const [f]=await c`SELECT app.media_purge_fence_key(${id}::uuid)::text key`;await c`COMMIT`;await c`SELECT pg_advisory_lock(${f.key}::bigint)`;
  error(await call(id),503,'MEDIA_DELETE_RETRY');assert.equal(await job(id),undefined);assert.equal((await row(id)).status,'active');
 }finally{await c`SELECT pg_advisory_unlock_all()`;c.release();}
});

test('R8 actual startup role validation rejects relation ownership and effective forbidden roles',async()=>{
 const {assertMediaPurgerRole}=h.load('worker/media-purger-run.js');
 await assertMediaPurgerRole(purger);
 const name='tm_b06_owner_'+randomUUID().replaceAll('-','');
 try{
  await h.admin.unsafe(`CREATE TABLE public.${name}(id integer)`);
  await h.admin.unsafe(`ALTER TABLE public.${name} OWNER TO ${purgerLogin}`);
  await assert.rejects(assertMediaPurgerRole(purger),/MEDIA_PURGER_ROLE_INVALID/);
 }finally{await h.admin.unsafe(`DROP TABLE IF EXISTS public.${name}`);}
 await h.admin.unsafe(`GRANT UPDATE(state) ON media_purge_jobs TO ${purgerLogin}`);
 try{await assert.rejects(assertMediaPurgerRole(purger),/MEDIA_PURGER_ROLE_INVALID/);}
 finally{await h.admin.unsafe(`REVOKE UPDATE(state) ON media_purge_jobs FROM ${purgerLogin}`);}
 for(const role of ['tallermecario_api','tallermecario_worker','tallermecario_media_lifecycle','tallermecario_schema_owner']){
  await h.admin.unsafe(`GRANT ${role} TO ${purgerLogin}`);
  try{await assert.rejects(assertMediaPurgerRole(purger),/MEDIA_PURGER_ROLE_INVALID/);}
  finally{await h.admin.unsafe(`REVOKE ${role} FROM ${purgerLogin}`);}
 }
 await assertMediaPurgerRole(purger);
});
for(const failure of ['throw','false','timeout'])test(`R8 advisory unlock ${failure} terminates instead of retry loop`,async()=>{
 const id=await asset();await remove(id);const c=await purger.reserve();let ended=0,released=0;
 const sql=new Proxy(c,{apply(target,thisArg,args){
  const statement=args[0].join?.('')??'';
  if(statement.includes('pg_advisory_unlock('))return failure==='timeout'?new Promise(()=>{}):failure==='throw'?Promise.reject(new Error('private driver error')):Promise.resolve([{unlocked:false}]);
  return Reflect.apply(target,thisArg,args);
 },get(target,key){if(key==='release')return ()=>{released++;};return Reflect.get(target,key);}});
 try{
  await assert.rejects(purgeMediaAsset({reserve:async()=>sql,end:async()=>{ended++;}},r2,a.tenantId,id,async()=> 'deleted'),/MEDIA_PURGER_FENCE_RELEASE_FAILED/);
  assert.equal(ended,1);assert.equal(released,1);
 }finally{await c`SELECT pg_advisory_unlock_all()`;c.release();}
});
test('R8 claim and discovery use bounded SQL timeouts; held asset cannot hang purger',async()=>{
 const id=await asset();await remove(id);const locker=await h.admin.reserve();
 try{
  await locker`BEGIN`;await locker`SELECT id FROM media_assets WHERE id=${id} FOR UPDATE`;
  assert.equal(await purge(id,async()=>{throw new Error('storage must not run');}),'retry');
  assert.equal((await row(id)).purged_at,null);assert.equal((await job(id)).attempts,0);
 }finally{await locker`ROLLBACK`;locker.release();}
 const id2=await asset();await remove(id2);
 assert.equal(await purge(id2,async()=>{
  return 'deleted';
 }),'completed');
});
test('R8 bootstrap provisions an independently authenticated SCRAM login without plaintext SQL/logs',async()=>{
 const {spawn}=require('node:child_process');const password=randomUUID()+"'";
 const logs=[];
 const child=spawn(process.execPath,['scripts/provision-media-purger-login.cjs'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL_ADMIN,MEDIA_PURGER_DB_PASSWORD:password},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>logs.push(b.toString()));child.stderr.on('data',b=>logs.push(b.toString()));
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 try{
  assert.equal(exit,0,logs.join(''));assert.equal(logs.join('').includes(password),false);assert.equal(logs.join('').includes('SCRAM-SHA-256$'),false);
  const [role]=await h.admin`SELECT rolpassword,rolinherit,rolbypassrls FROM pg_authid WHERE rolname='tallermecario_media_purge_runtime'`;
  assert.ok(role.rolpassword.startsWith('SCRAM-SHA-256$'));assert.equal(role.rolinherit,false);assert.equal(role.rolbypassrls,false);
  const url=new URL(process.env.TEST_DATABASE_URL_ADMIN);url.username='tallermecario_media_purge_runtime';url.password=password;
  const login=postgres(url.toString(),{max:1,prepare:false,connection:{role:'tallermecario_media_purger'}});
  try{await h.load('worker/media-purger-run.js').assertMediaPurgerRole(login);}finally{await login.end();}
 }finally{await h.admin`DROP ROLE IF EXISTS tallermecario_media_purge_runtime`;}
});

test('R5 expired claim cannot record/confirm even while A still owns its fence',async()=>{
 const id=await asset();await remove(id);const A=await workerClaim(id);
 try{
  await expireClaim(id);
  await assert.rejects(A.tx(()=>A.sql`SELECT app.record_media_purge_result(${id}::uuid,${A.claim}::uuid,'deleted')`),/MEDIA_PURGE_CLAIM_INVALID/);
  await assert.rejects(A.tx(()=>A.sql`SELECT app.confirm_media_purge(${id}::uuid,${A.claim}::uuid)`),/MEDIA_PURGE_CLAIM_INVALID/);
  assert.equal((await job(id)).claim_id,A.claim);assert.equal((await row(id)).purged_at,null);assert.equal((await lifecycleAudits(id)).length,1);
 }finally{await A.close();}
 assert.equal(await purge(id),'completed');
});

test('F1 trusted lifecycle still enforces structural lease/terminal transitions',async()=>{
 const id=await asset();await remove(id);const sql=await h.admin.reserve(),claim=randomUUID();
 const tx=async work=>{await sql`BEGIN`;try{await sql`SET LOCAL ROLE tallermecario_media_lifecycle`;await sql`SELECT set_config('app.tenant_id',${a.tenantId},true)`;const r=await work();await sql`COMMIT`;return r;}catch(e){await sql`ROLLBACK`;throw e;}};
 try{
  await tx(async()=>{await sql`SELECT pg_advisory_lock(app.media_purge_fence_key(${id}::uuid))`;await sql`SELECT * FROM app.claim_media_purge(${id}::uuid,${claim}::uuid)`;});
  for(const state of ['completed','queued'])await assert.rejects(tx(()=>sql`UPDATE media_purge_jobs SET state=${state},last_result='deleted',completed_at=${state==='completed'?new Date():null} WHERE media_asset_id=${id}`),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_transition_guard');
  await tx(()=>sql`SELECT app.record_media_purge_result(${id}::uuid,${claim}::uuid,'storage_unavailable')`);
  await assert.rejects(tx(()=>sql`UPDATE media_purge_jobs SET state='completed',completed_at=clock_timestamp() WHERE media_asset_id=${id}`),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_transition_guard');
 }finally{await sql`SELECT pg_advisory_unlock_all()`;sql.release();}
 await expireClaim(id);assert.equal(await purge(id),'completed');
 await assert.rejects(h.admin.begin(async sql=>{await sql`SET LOCAL ROLE tallermecario_media_lifecycle`;await sql`SELECT set_config('app.tenant_id',${a.tenantId},true)`;await sql`SELECT pg_advisory_xact_lock(app.media_purge_fence_key(${id}::uuid))`;await sql`UPDATE media_purge_jobs SET state='claimed' WHERE media_asset_id=${id}`;}),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_transition_guard');
 assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
});
for(const wrong of ['endpoint','account','bucket'])test(`R4 actual wrong ${wrong} configuration never marks purged`,async()=>{
 const id=await asset();await remove(id);let calls=0;
 const config={...r2,...(wrong==='bucket'?{bucket:'MISSING-BUCKET'}:{endpoint:`https://wrong-${wrong}.example.invalid`})};
 globalThis.fetch=async(url)=>{calls++;assert.equal(new URL(url).hostname,`wrong-${wrong}.example.invalid`);return new Response(null,{status:404});};
 try{assert.equal(await purgeMediaAsset(purger,config,a.tenantId,id,deleteR2Object),'retry');assert.equal((await row(id)).purged_at,null);assert.equal((await job(id)).last_result,'storage_unavailable');assert.equal(calls,wrong==='bucket'?0:1);}
 finally{globalThis.fetch=originalFetch;}
});
test('R7 confirmed storage outcome survives hold suspension after lease expiry',async()=>{
 const id=await asset();await remove(id);const A=await workerClaim(id);
 await A.tx(()=>A.sql`SELECT app.record_media_purge_result(${id}::uuid,${A.claim}::uuid,'deleted')`);await A.close();await expireClaim(id);
 await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 assert.equal(await purge(id),'deferred');assert.equal((await job(id)).state,'reconciliation_required');assert.equal((await job(id)).last_result,'deleted');assert.equal((await row(id)).purged_at,null);assert.equal((await lifecycleAudits(id)).length,1);
 await assert.rejects(h.admin.begin(async tx=>{await tx`SET LOCAL ROLE tallermecario_media_lifecycle`;await tx`SELECT set_config('app.tenant_id',${a.tenantId},true)`;await tx`SELECT pg_advisory_xact_lock(app.media_purge_fence_key(${id}::uuid))`;await tx`UPDATE media_purge_jobs SET state='completed',completed_at=clock_timestamp() WHERE media_asset_id=${id}`;}),e=>e.code==='23514'&&e.constraint_name==='media_purge_job_transition_guard');
});

test('R8 bounded discovery pages advance across protected assets without queueing them',async()=>{
 const {a:tenant}=await h.twoTenants(),ids=[];
 for(let i=1;i<=105;i++)ids.push(await asset({id:`eeeeeeee-eeee-eeee-eeee-${i.toString(16).padStart(12,'0')}`,retention_until:'2040-01-01'},tenant));
 const target=await asset({id:'ffffffff-ffff-ffff-ffff-ffffffffffff'},tenant);
 const cursor=await discoverMediaPurges(purger,tenant.tenantId,null,100);assert.equal(cursor,ids[99]);assert.equal(await job(target),undefined);
 assert.equal(await discoverMediaPurges(purger,tenant.tenantId,cursor,100),null);assert.ok(await job(target));
 for(const id of ids)assert.equal(await job(id),undefined);
 assert.equal(await purge(target,async()=> 'deleted',tenant),'completed');
});

const reconciliationAudits=id=>h.admin`SELECT * FROM audit_logs WHERE entity_id=${id} AND action='media.purge_reconciliation_required'`;
for(const poolName of ['apiPool','workerPool'])test(`F1 ${poolName} cannot become lifecycle or forge completion`,async()=>{
 const id=await asset();await remove(id);
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql`SET LOCAL ROLE tallermecario_media_lifecycle`),e=>e.code==='42501');
 await assert.rejects(h.asRuntime(h[poolName],{tenantId:a.tenantId},sql=>sql`UPDATE media_purge_jobs SET state='completed',completed_at=now() WHERE media_asset_id=${id}`),e=>e.code==='42501');
 assert.equal((await job(id)).state,'queued');assert.equal((await row(id)).purged_at,null);
});
test('F1 bootstrap rejects unexpected indirect lifecycle SET/inheritance paths atomically',async()=>{
 const {spawnSync}=require('node:child_process');
 const intermediate='tm_b06_untrusted_'+randomUUID().replaceAll('-','');
 await h.admin.unsafe(`CREATE ROLE ${intermediate} NOLOGIN NOINHERIT`);
 try{
  await h.admin.unsafe(`GRANT tallermecario_media_lifecycle TO ${intermediate} WITH INHERIT TRUE, SET TRUE`);
  await h.admin.unsafe(`GRANT ${intermediate} TO ${purgerLogin} WITH INHERIT FALSE, SET TRUE`);
  const result=spawnSync(process.execPath,['scripts/provision-media-purger-login.cjs'],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL_ADMIN,MEDIA_PURGER_DB_PASSWORD:randomUUID()},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);assert.match(result.stderr,/MEDIA_PURGER_LOGIN_PROVISION_FAILED/);
  assert.equal((await h.admin`SELECT count(*)::int n FROM pg_roles WHERE rolname='tallermecario_media_purge_runtime'`)[0].n,0);
  await assert.rejects(h.load('worker/media-purger-run.js').assertMediaPurgerRole(purger),/MEDIA_PURGER_ROLE_INVALID/);
 }finally{await h.admin.unsafe(`DROP ROLE ${intermediate}`);}
});
test('F2 real parent contention skips A, queues B, processes due C and revisits A',async()=>{
 const {a:tenant}=await h.twoTenants();
 const A=await asset({id:'11111111-1111-1111-1111-111111111111'},tenant);
 const B=await asset({id:'22222222-2222-2222-2222-222222222222'},tenant);
 const C=await asset({id:'33333333-3333-3333-3333-333333333333'},tenant);
 const o=await order('delivered','2020-01-01',tenant);await link(A,o,'reception_media',tenant);
 await h.asRuntime(purger,{tenantId:tenant.tenantId},sql=>sql`SELECT app.queue_retention_media_purge(${C}::uuid)`);
 const lock=await h.admin.reserve();await lock`BEGIN`;await lock`SELECT id FROM receptions WHERE id=${o.reception} FOR NO KEY UPDATE`;
 let calls=0;const {processMediaPurgeTenant}=h.load('worker/media-purger-run.js');
 const started=Date.now();
 try{
  const cycle=processMediaPurgeTenant(purger,r2,tenant.tenantId,null,async()=>{calls++;return 'deleted';});
  await blocked((await lock`SELECT pg_backend_pid() pid`)[0].pid);
  assert.equal(await cycle,null);assert.equal(await job(A),undefined);
  assert.ok(await job(B));assert.equal((await job(C)).state,'completed');assert.equal(calls,2);
  assert.ok(Date.now()-started<12000,'bounded contention, no whole-page retries');
 }finally{await lock`ROLLBACK`;lock.release();}
 assert.equal(await discoverMediaPurges(purger,tenant.tenantId,null,100),null);
 assert.ok(await job(A));assert.equal(await purge(A,async()=> 'deleted',tenant),'completed');
 const [n]=await h.admin`SELECT count(*)::int n FROM media_purge_jobs WHERE tenant_id=${tenant.tenantId}`;assert.equal(n.n,3);
 assert.ok((await row(A)).purged_at);assert.ok((await row(B)).purged_at);assert.ok((await row(C)).purged_at);
});
test('F2 unexpected discovery failure stays visible while due C still processes',async()=>{
 const {a:tenant}=await h.twoTenants(),A=await asset({},tenant),C=await asset({},tenant);
 await h.asRuntime(purger,{tenantId:tenant.tenantId},sql=>sql`SELECT app.queue_retention_media_purge(${C}::uuid)`);
 await injectFailure('media_purge_jobs','true',async()=>{
  await assert.rejects(discoverMediaPurges(purger,tenant.tenantId,null),e=>e.message==='MEDIA_PURGE_DISCOVERY_FAILED'&&e.cause.message==='TEST FAILURE');
  assert.equal(await h.load('worker/media-purger-run.js').processMediaPurgeTenant(purger,r2,tenant.tenantId,null,async()=> 'deleted'),null);
 });
 assert.equal(await job(A),undefined);assert.equal((await job(C)).state,'completed');
});
for(const result of ['confirmed','unknown'])test(`F3 ${result} DELETE then hold parks once, remains parked after expiry`,async()=>{
 const id=await asset();await remove(id);let calls=0;
 if(result==='confirmed'){
  await injectFailure('audit_logs',"NEW.action='media.purged'",async()=>{assert.equal(await purge(id,async()=>{calls++;return 'deleted';}),'retry');});
 }else assert.equal(await purge(id,async()=>{calls++;throw new Error('timeout after possible DELETE');}),'retry');
 assert.equal((await job(id)).storage_outcome,result==='confirmed'?'deleted':'unknown');
 await expireClaim(id);await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 const outcomes=await Promise.all([purge(id,async()=>{calls++;return 'deleted';}),purge(id,async()=>{calls++;return 'deleted';})]);
 assert.deepEqual(outcomes,['deferred','deferred']);assert.equal(calls,1);
 const parked=await job(id),audits=await reconciliationAudits(id);
 assert.equal(parked.state,'reconciliation_required');assert.equal(parked.claim_id,null);assert.equal(audits.length,1);
 assert.equal(audits[0].metadata_json.storage_outcome,result==='confirmed'?'deleted':'unknown');
 assert.deepEqual(Object.keys(audits[0].metadata_json).sort(),['attempts','job_id','reason','storage_outcome']);
 assert.equal((await row(id)).purged_at,null);assert.ok((await row(id)).legal_hold_until);
 // Time passage fixture only: never expose a runtime hold clearer.
 await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx`UPDATE media_assets SET legal_hold_until='2020-01-01' WHERE id=${id}`;});
 assert.equal(await purge(id,async()=>{calls++;return 'deleted';}),'deferred');
 assert.equal((await job(id)).state,'reconciliation_required');assert.equal((await job(id)).attempts,parked.attempts);assert.equal(calls,1);
 assert.equal((await reconciliationAudits(id)).length,1);assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,0);
 assert.equal((await dueMediaPurges(purger,a.tenantId,100)).includes(id),false);
 for(const pool of [h.apiPool,h.workerPool,purger])await assert.rejects(h.asRuntime(pool,{tenantId:a.tenantId},sql=>sql`UPDATE media_purge_jobs SET state='queued' WHERE media_asset_id=${id}`),e=>e.code==='42501');
 await assert.rejects(h.admin.begin(async tx=>{await tx`SET LOCAL ROLE tallermecario_media_lifecycle`;await tx`SELECT set_config('app.tenant_id',${a.tenantId},true)`;await tx`SELECT pg_advisory_xact_lock(app.media_purge_fence_key(${id}::uuid))`;await tx`UPDATE media_purge_jobs SET state='queued' WHERE media_asset_id=${id}`;}),e=>e.constraint_name==='media_purge_job_transition_guard');
});
test('F3 unknown transient failure without protection retries to verified completion',async()=>{
 const id=await asset();await remove(id);
 assert.equal(await purge(id,async()=>{throw new Error('transient');}),'retry');assert.equal((await job(id)).storage_outcome,'unknown');
 await expireClaim(id);assert.equal(await purge(id),'completed');assert.equal((await job(id)).storage_outcome,'deleted');
 assert.equal((await reconciliationAudits(id)).length,0);assert.equal((await lifecycleAudits(id)).filter(r=>r.action==='media.purged').length,1);
});
test('F3 known rejected first DELETE and pre-transport failure do not claim possible loss',async()=>{
 const {R2DeleteRejectedError}=h.load('media/r2.js');
 for(const outcome of ['failed','not_attempted']){
  const id=await asset();await remove(id);
  const config=outcome==='not_attempted'?{...r2,bucket:'wrong'}:r2;
  assert.equal(await purgeMediaAsset(purger,config,a.tenantId,id,async()=>{throw new R2DeleteRejectedError();}),'retry');
  assert.equal((await job(id)).storage_outcome,outcome);await expireClaim(id);
  await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
  assert.equal(await purge(id),'deferred');assert.equal((await job(id)).state,'suspended');assert.equal((await reconciliationAudits(id)).length,0);
 }
});
test('Production guard defaults disabled and requires exact explicit enable',()=>{
 const {assertMediaPurgerEnabled}=h.load('worker/media-purger-run.js');
 for(const value of [undefined,'','false','TRUE','1'])assert.throws(()=>assertMediaPurgerEnabled({MEDIA_PURGE_ENABLED:value}),/MEDIA_PURGER_DISABLED/);
 assert.doesNotThrow(()=>assertMediaPurgerEnabled({MEDIA_PURGE_ENABLED:'true'}));
});

for(const [code,message,tries] of [['40001','serialization retry',3],['57014','canceling statement due to statement timeout',1]])test(`F2 ${code} exhausts bounded candidate handling then progresses`,async()=>{
 const {a:tenant}=await h.twoTenants(),ids=[randomUUID(),randomUUID()].sort();
 const A=await asset({id:ids[0]},tenant),B=await asset({id:ids[1]},tenant);
 await h.admin`CREATE SEQUENCE public.b06_discovery_attempts`;
 await h.admin`GRANT USAGE ON SEQUENCE public.b06_discovery_attempts TO tallermecario_media_lifecycle`;
 await h.admin.unsafe(`CREATE FUNCTION public.b06_discovery_contention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.media_asset_id='${A}'::uuid THEN PERFORM nextval('public.b06_discovery_attempts'); RAISE EXCEPTION '${message}' USING ERRCODE='${code}'; END IF; RETURN NEW; END $$`);
 await h.admin`CREATE TRIGGER b06_discovery_contention_trg BEFORE INSERT ON media_purge_jobs FOR EACH ROW EXECUTE FUNCTION public.b06_discovery_contention()`;
 try{
  const cursor=await discoverMediaPurges(purger,tenant.tenantId,null,1);assert.equal(cursor,A);assert.equal(await job(A),undefined);
  assert.equal((await h.admin`SELECT last_value::int n FROM b06_discovery_attempts`)[0].n,tries);
  assert.equal(await discoverMediaPurges(purger,tenant.tenantId,cursor,1),B);assert.ok(await job(B));
  assert.equal(await discoverMediaPurges(purger,tenant.tenantId,B,1),null);
 }finally{await h.admin`DROP TRIGGER b06_discovery_contention_trg ON media_purge_jobs`;await h.admin`DROP FUNCTION public.b06_discovery_contention()`;await h.admin`DROP SEQUENCE public.b06_discovery_attempts`;}
 assert.equal(await discoverMediaPurges(purger,tenant.tenantId,null,100),null);assert.ok(await job(A));
 assert.equal((await job(A)).attempts,0);assert.equal((await job(B)).attempts,0);assert.equal((await row(A)).purged_at,null);
});
test('F3 reconciliation audit failure rolls back parking, then recovery records one event',async()=>{
 const id=await asset();await remove(id);assert.equal(await purge(id,async()=>{throw new Error('unknown');}),'retry');await expireClaim(id);
 await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 await injectFailure('audit_logs',"NEW.action='media.purge_reconciliation_required'",async()=>{
  assert.equal(await purge(id),'retry');assert.equal((await job(id)).state,'retryable_storage_failure');assert.equal((await reconciliationAudits(id)).length,0);
 });
 assert.equal(await purge(id),'deferred');assert.equal((await job(id)).state,'reconciliation_required');assert.equal((await reconciliationAudits(id)).length,1);
 assert.equal((await row(id)).purged_at,null);assert.ok((await row(id)).legal_hold_until);
});
for(const status of [401,403])test(`F3 R2 DELETE authorization rejection ${status} records known failure`,async()=>{
 const id=await asset();await remove(id);globalThis.fetch=async()=>new Response(null,{status});
 try{assert.equal(await purge(id,deleteR2Object),'retry');assert.equal((await job(id)).storage_outcome,'failed');assert.equal((await row(id)).purged_at,null);}
 finally{globalThis.fetch=originalFetch;}
});

for(const priorUnknown of [false,true])test(`F3 repeated known rejection preserves prior destructive ambiguity=${priorUnknown}`,async()=>{
 const {R2DeleteRejectedError}=h.load('media/r2.js');const id=await asset();await remove(id);
 assert.equal(await purge(id,async()=>{if(priorUnknown)throw new Error('unknown outcome');throw new R2DeleteRejectedError();}),'retry');
 await expireClaim(id);assert.equal(await purge(id,async()=>{throw new R2DeleteRejectedError();}),'retry');
 assert.equal((await job(id)).storage_outcome,priorUnknown?'unknown':'failed');
 await expireClaim(id);await h.admin`UPDATE media_assets SET legal_hold_until='2040-01-01' WHERE id=${id}`;
 assert.equal(await purge(id),'deferred');assert.equal((await job(id)).state,priorUnknown?'reconciliation_required':'suspended');
 assert.equal((await reconciliationAudits(id)).length,priorUnknown?1:0);assert.equal((await row(id)).purged_at,null);
});
