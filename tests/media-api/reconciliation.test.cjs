'use strict';
const {test,before,after}=require('node:test');
const {randomUUID}=require('node:crypto');
const postgres=require('postgres');
const h=require('../crm-api/helpers.cjs');
const {assert}=h;
const {createReconciliationMetadata,reconcileMedia}=h.load('media/reconciliation.js');
const {assertMediaReconcilerRole,assertMediaReconciliationEnabled,mediaReconciliationExitCode}=h.load('worker/media-reconciliation-run.js');
const {recalculateMediaRetention}=h.load('media/retention.js');
const {removeUnattachedMedia}=h.load('media/deletion.js');
const {purgeMediaAsset}=h.load('media/purger.js');
let a,b,reader,login,readerUrl,metadata,purger,purgeLogin;
const bucket='TEST-ONLY',reportKey='test-only-hmac-material-for-reconciliation';
const signal=()=>AbortSignal.timeout(15000);
before(async()=>{
 ({a,b}=await h.twoTenants());
 async function pool(role){const name='tm_b08_'+randomUUID().replaceAll('-',''),password=randomUUID();await h.admin.unsafe(`CREATE ROLE ${name} LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER PASSWORD '${password}'`);await h.admin.unsafe(`GRANT ${role} TO ${name}`);const url=new URL(process.env.TEST_DATABASE_URL_ADMIN);url.username=name;url.password=password;return [postgres(url.toString(),{max:4,prepare:false,onnotice:()=>{},connection:{role}}),name,url.toString()];}
 [reader,login,readerUrl]=await pool('tallermecario_media_reconciler');[purger,purgeLogin]=await pool('tallermecario_media_purger');metadata=createReconciliationMetadata(reader);
});
after(async()=>{await reader?.end();await purger?.end();if(login)await h.admin.unsafe(`DROP ROLE ${login}`);if(purgeLogin)await h.admin.unsafe(`DROP ROLE ${purgeLogin}`);await h.closeAll();});
async function asset(tenant=a,extra={}){const row={id:randomUUID(),tenant_id:tenant.tenantId,bucket,object_key:randomUUID(),media_type:'document',mime_type:'application/pdf',status:'active',retention_class:'document',retention_policy_version:'v1',uploaded_at:'2020-01-01T00:00:00Z',...extra};await h.admin`INSERT INTO media_assets ${h.admin(row)}`;return row;}
async function session(row,extra={}){await h.admin`INSERT INTO upload_sessions ${h.admin({id:randomUUID(),tenant_id:row.tenant_id,media_asset_id:row.id,idempotency_key:randomUUID(),expected_size_bytes:10,status:'pending',expires_at:new Date(Date.now()+60000),...extra})}`;}
const runtime=fn=>h.asRuntime(h.apiPool,{tenantId:a.tenantId,userId:a.owner.user.id,membershipId:a.owner.membershipId},fn);
function store(objects,head){return {head:head??(async key=>objects.includes(key)?'exists':'missing'),async list(_p,limit,token){const start=Number(token??0),keys=objects.slice(start,start+limit),truncated=start+limit<objects.length;return {keys,truncated,nextToken:truncated?String(start+limit):undefined};}};}
const scan=(storage,extra={})=>reconcileMedia(metadata,storage,{tenantIds:[a.tenantId],bucket,reportKey,pageSize:100,...extra});
test('dedicated login passes startup checks; privileged/API/worker sessions fail',async()=>{
 await assertMediaReconcilerRole(reader);for(const pool of [h.admin,h.apiPool,h.workerPool,purger])await assert.rejects(assertMediaReconcilerRole(pool),/MEDIA_RECONCILER_ROLE_INVALID/);
 assert.throws(()=>assertMediaReconciliationEnabled({}),/DISABLED/);assertMediaReconciliationEnabled({MEDIA_RECONCILIATION_ENABLED:'true'});
});
test('FORCE RLS and zero visibility without tenant; fresh transactions do not leak tenant context',async()=>{
 const own=await asset(),foreign=await asset(b);
 const scoped=await metadata.page(a.tenantId,null,100,signal());assert.ok(scoped.some(r=>r.id===own.id));assert.equal(scoped.some(r=>r.id===foreign.id),false);
 assert.equal(await metadata.asset(a.tenantId,foreign.id,signal()),undefined);assert.equal((await reader`SELECT id FROM media_assets`).length,0);
 assert.equal((await reader`SELECT tenant_id FROM upload_sessions`).length,0);assert.equal((await reader`SELECT tenant_id FROM media_purge_jobs`).length,0);
 const rows=await h.admin`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('media_assets'::regclass,'upload_sessions'::regclass,'media_purge_jobs'::regclass)`;assert.ok(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
});
test('global existence includes foreign tenant with noncanonical key and every lifecycle state',async()=>{
 const foreign=await asset(b,{object_key:`tenants/${a.tenantId}/media/legacy-object`}),pending=await asset(a,{status:'pending_upload'}),quarantine=await asset(a,{status:'quarantined',quarantined_at:new Date()});
 assert.deepEqual(await metadata.exists(bucket,[foreign.object_key,'absent',pending.object_key,quarantine.object_key,foreign.object_key],signal()),[true,false,true,true,true]);
 const r=await scan(store([foreign.object_key]));assert.equal(r.counts.orphan_candidate,undefined);assert.ok(r.counts.metadata_object);
});
test('global helper is bounded and has safe owner/search_path; normal roles cannot execute it or assume reconciler',async()=>{
 const [fn]=await h.admin`SELECT r.rolname owner,p.prosecdef,p.proconfig,has_function_privilege('public',p.oid,'EXECUTE') public FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='app.media_storage_metadata_exists(text,text[])'::regprocedure`;
 const [policy]=await h.admin`SELECT roles,qual FROM pg_policies WHERE tablename='media_assets' AND policyname='media_inventory_owner_select'`;
 assert.deepEqual(policy.roles,['tallermecario_media_inventory_owner']);assert.match(policy.qual,/CURRENT_USER = 'tallermecario_media_inventory_owner'/i);
 assert.equal(fn.owner,'tallermecario_media_inventory_owner');assert.equal(fn.prosecdef,true);assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);assert.equal(fn.public,false);
 for(const pool of [h.apiPool,h.workerPool,purger]){
  await assert.rejects(pool`SELECT * FROM app.media_storage_metadata_exists(${bucket},ARRAY['key'])`,e=>e.code==='42501');
  await assert.rejects(pool`SET ROLE tallermecario_media_reconciler`,e=>e.code==='42501');
 }
 for(const keys of [[],Array(101).fill('key'),[null],[''],['x'.repeat(1025)]])await assert.rejects(metadata.exists(bucket,keys,signal()),/MEDIA_RECONCILIATION_INPUT_INVALID/);
});
test('raw reconciler has no mutations, PII, audit writes, purge entry points or privileged SET ROLE',async()=>{
 for(const query of ['UPDATE media_assets SET status=status','INSERT INTO media_assets(id) VALUES(gen_random_uuid())','DELETE FROM media_assets','TRUNCATE media_assets','UPDATE upload_sessions SET status=status','DELETE FROM media_purge_jobs','SELECT * FROM customers','SELECT * FROM media_assets','SELECT created_by_membership_id FROM media_assets','INSERT INTO audit_logs(action) VALUES(\'TEST\')','SELECT app.queue_retention_media_purge(gen_random_uuid())','SELECT app.claim_media_purge(gen_random_uuid(),gen_random_uuid())','SELECT app.remove_unattached_media(gen_random_uuid())','SET ROLE tallermecario_schema_owner','SET ROLE tallermecario_media_lifecycle','SET ROLE tallermecario_worker','ALTER TABLE media_assets DISABLE ROW LEVEL SECURITY'])await assert.rejects(reader.unsafe(query),e=>e.code==='42501');
});
test('real pending session, quarantine, holds and active existence/missing remain observations without writes',async()=>{
 const pending=await asset(a,{status:'pending_upload'});await session(pending);
 const active=await asset(a,{legal_hold_until:new Date(Date.now()+60000)});
 const before=await h.admin`SELECT row_to_json(m) value FROM media_assets m WHERE tenant_id=${a.tenantId} ORDER BY id`;
 const r=await scan(store([pending.object_key]));assert.ok(r.counts.pending_upload);assert.ok(r.counts.active_missing);assert.ok(r.alerts.includes('held_missing'));assert.equal(r.counts.orphan_candidate,undefined);
 assert.deepEqual(await h.admin`SELECT row_to_json(m) value FROM media_assets m WHERE tenant_id=${a.tenantId} ORDER BY id`,before);
 assert.equal((await metadata.asset(a.tenantId,active.id,signal())).held,true);
});
test('B05 floor committed during HEAD is lifecycle_changed, never confirmed active_missing',async()=>{
 const row=await asset();let changed=false;const r=await scan(store([],async key=>{if(key===row.object_key&&!changed){changed=true;await runtime(sql=>recalculateMediaRetention(sql,a.tenantId,row.id));}return 'missing';}));
 assert.ok(changed);const observations=r.samples.filter(s=>s.classification==='lifecycle_changed');assert.ok(observations.length);assert.equal((await metadata.asset(a.tenantId,row.id,signal())).status,'active');
});
for(const failure of [null,'MEDIA_CONTENT_INVALID'])test(`${failure?'quarantine':'upload completion'} committed during HEAD invalidates the observation`,async()=>{
 const row=await asset(a,{status:'pending_upload',uploaded_at:null});await session(row);
 const service=h.load('media/service.js'),[us]=await h.admin`SELECT id FROM upload_sessions WHERE media_asset_id=${row.id}`;
 const plan=await runtime(sql=>service.prepareUploadCompletion(sql,a.tenantId,us.id));
 const initial=await metadata.asset(a.tenantId,row.id,signal());let changed=false;
 const report=await scan(store([],async key=>{
  if(key===row.object_key&&!changed){changed=true;const result=await runtime(sql=>service.completeUploadSession(sql,a.tenantId,us.id,plan,
    {plan,sizeBytes:10,contentType:'application/pdf',etag:'test-etag',failure}));assert.equal(result.kind,failure?'durable-error':'completed');}
  return 'missing';
 }));
 const current=await metadata.asset(a.tenantId,row.id,signal());assert.ok(changed);assert.ok(report.counts.lifecycle_changed);
 assert.notEqual(initial.version,current.version);assert.equal(current.pending,false);assert.equal(current.status,failure?'quarantined':'active');
});
test('legal hold committed during HEAD is observed as lifecycle change',async()=>{
 const row=await asset();let changed=false;const report=await scan(store([],async key=>{
  if(key===row.object_key&&!changed){changed=true;await h.admin`UPDATE media_assets SET legal_hold_until=clock_timestamp()+interval '1 day' WHERE id=${row.id}`;}return 'missing';
 }));assert.ok(changed);assert.ok(report.counts.lifecycle_changed);assert.equal((await metadata.asset(a.tenantId,row.id,signal())).held,true);
});
test('B06 tombstone and purge are historical matches; scan never invokes storage DELETE or alters jobs',async()=>{
 const row=await asset();await runtime(sql=>removeUnattachedMedia(sql,row.id));
 const tombstone=await metadata.asset(a.tenantId,row.id,signal());assert.equal(tombstone.status,'deleted');
 let r=await scan(store([row.object_key]));assert.ok(r.counts.deletion_in_progress);assert.equal(r.counts.orphan_candidate,undefined);
 const fake=require('../media/fixtures.cjs').r2;assert.equal(await purgeMediaAsset(purger,{...fake,bucket},a.tenantId,row.id,async()=> 'deleted'),'completed');
 const before=(await h.admin`SELECT row_to_json(j) value FROM media_purge_jobs j WHERE media_asset_id=${row.id}`)[0];
 r=await scan(store([row.object_key]));assert.ok(r.counts.purged_object_present);assert.equal(r.counts.orphan_candidate,undefined);
 r=await scan(store([]));assert.ok(r.counts.purged_absent);assert.deepEqual((await h.admin`SELECT row_to_json(j) value FROM media_purge_jobs j WHERE media_asset_id=${row.id}`)[0],before);
});
test('B06 deletion committed during HEAD invalidates the active observation',async()=>{
 const row=await asset();let changed=false;const r=await scan(store([],async key=>{if(key===row.object_key&&!changed){changed=true;await runtime(sql=>removeUnattachedMedia(sql,row.id));}return 'missing';}));assert.ok(changed);assert.ok(r.counts.lifecycle_changed);assert.equal((await metadata.asset(a.tenantId,row.id,signal())).status,'deleted');
});
test('real DB pagination and cancellation are bounded and tenant safe',async()=>{
 const first=await metadata.page(a.tenantId,null,2,signal()),second=await metadata.page(a.tenantId,first.at(-1).id,2,signal());assert.equal(first.length,2);assert.ok(second.every(r=>r.id>first.at(-1).id));
 const c=new AbortController();c.abort();await assert.rejects(metadata.page(a.tenantId,null,2,c.signal),/CANCELLED/);assert.equal((await reader`SELECT id FROM media_assets`).length,0);
});

test('startup rejects added SELECT, mutation and inherited privileges',async()=>{
 for(const [grant,revoke] of [
  ['GRANT SELECT(created_by_membership_id) ON media_assets TO tallermecario_media_reconciler','REVOKE SELECT(created_by_membership_id) ON media_assets FROM tallermecario_media_reconciler'],
  ['GRANT UPDATE(status) ON media_assets TO tallermecario_media_reconciler','REVOKE UPDATE(status) ON media_assets FROM tallermecario_media_reconciler'],
  ['GRANT pg_read_all_data TO tallermecario_media_reconciler','REVOKE pg_read_all_data FROM tallermecario_media_reconciler']]){
  await h.admin.unsafe(grant);try{await assert.rejects(assertMediaReconcilerRole(reader),/ROLE_INVALID/);}finally{await h.admin.unsafe(revoke);}
 }
 await assertMediaReconcilerRole(reader);
});

test('cancelled pool reservation releases the late connection and cannot leak tenant context',async()=>{
 const held=await Promise.all(Array.from({length:4},()=>reader.reserve()));const c=new AbortController();
 try {const pending=metadata.page(a.tenantId,null,2,c.signal);c.abort();await assert.rejects(pending,/CANCELLED/);}finally{held.forEach(sql=>sql.release());}
 assert.equal((await reader`SELECT id FROM media_assets`).length,0);await assertMediaReconcilerRole(reader);
});
test('real DB plus simulated S3 transport emits only redacted observations and HEAD/LIST, with no mutations',async()=>{
 const {createReconciliationStorage}=h.load('media/reconciliation-r2.js');
 const config={...require('../media/fixtures.cjs').r2,bucket};const objects=[(await asset()).object_key,'test-only-unmatched-object'];
 const calls=[],original=globalThis.fetch;
 const snapshot=()=>h.admin`SELECT row_to_json(m) value FROM media_assets m WHERE tenant_id=${a.tenantId} ORDER BY id`;
 const before=await snapshot();let report;
 try {
  globalThis.fetch=async(url,init)=>{
   const parsed=new URL(url);assert.equal(parsed.hostname,'r2.invalid');calls.push(init.method);
   if(init.method==='HEAD')return new Response(null,{status:objects.includes(decodeURIComponent(parsed.pathname.slice(bucket.length+2)))?200:404});
   assert.equal(init.method,'GET');assert.equal(parsed.searchParams.get('list-type'),'2');
   return new Response(`<ListBucketResult><Name>${bucket}</Name><Prefix></Prefix><EncodingType>url</EncodingType><MaxKeys>100</MaxKeys><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>${objects.map(key=>`<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join('')}</ListBucketResult>`);
  };
  const logs=await h.captureOutput(async()=>{report=await scan(createReconciliationStorage(config));});
  assert.equal(logs,'');assert.equal(report.status,'complete');assert.equal(report.counts.orphan_candidate,1);
  assert.ok(calls.includes('GET'));assert.ok(calls.includes('HEAD'));assert.equal(calls.some(m=>m==='DELETE'||m==='PUT'),false);
  for(const sensitive of [bucket,...objects,config.accessKeyId,config.secretAccessKey,a.tenantId,reportKey])assert.equal(JSON.stringify(report).includes(sensitive),false);
 } finally {globalThis.fetch=original;}
 assert.deepEqual(await snapshot(),before);
});


test('schema owner has no global media visibility; isolated probe owner has exactly three read columns',async()=>{
 await asset();await asset(b);
 async function asRole(role,fn){return h.admin.begin(async sql=>{await sql.unsafe(`SET LOCAL ROLE ${role}`);return fn(sql);});}
 assert.equal((await asRole('tallermecario_schema_owner',sql=>sql`SELECT id FROM media_assets`)).length,0);
 await asRole('tallermecario_media_inventory_owner',async sql=>{
  assert.ok((await sql`SELECT storage_provider,bucket,object_key FROM media_assets`).length>=2);
 });
 for(const query of ['SELECT id FROM media_assets','SELECT tenant_id FROM media_assets','SELECT * FROM media_assets','SELECT * FROM customers','SELECT * FROM audit_logs','SELECT * FROM workshops','SELECT tenant_id FROM upload_sessions','SELECT tenant_id FROM media_purge_jobs','UPDATE media_assets SET object_key=object_key'])
  await assert.rejects(asRole('tallermecario_media_inventory_owner',sql=>sql.unsafe(query)),e=>e.code==='42501');
 const columns=await h.admin`SELECT a.attname FROM pg_attribute a WHERE a.attrelid='media_assets'::regclass AND a.attnum>0 AND NOT a.attisdropped
  AND has_column_privilege('tallermecario_media_inventory_owner',a.attrelid,a.attnum,'SELECT') ORDER BY a.attname`;
 assert.deepEqual(columns.map(c=>c.attname),['bucket','object_key','storage_provider']);
 const [role]=await h.admin`SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='tallermecario_media_inventory_owner'`;
 assert.ok(Object.values(role).every(v=>v===false));
 assert.equal((await h.admin`SELECT * FROM pg_auth_members WHERE roleid='tallermecario_media_inventory_owner'::regrole OR member='tallermecario_media_inventory_owner'::regrole`).length,0);
 const [privileges]=await h.admin`SELECT has_schema_privilege('tallermecario_media_inventory_owner','app','CREATE') ddl,
  has_table_privilege('tallermecario_media_inventory_owner','media_assets','SELECT') broad`;
 assert.equal(privileges.ddl,false);assert.equal(privileges.broad,false);
 for(const role of ['tallermecario_api','tallermecario_worker','tallermecario_media_purger','tallermecario_migrator','tallermecario_schema_owner','tallermecario_bootstrap_resolver','tallermecario_identity_sync','tallermecario_media_lifecycle']){
  await assert.rejects(asRole(role,sql=>sql`SELECT * FROM app.media_storage_metadata_exists(${bucket},ARRAY['key'])`),e=>e.code==='42501');
  await assert.rejects(reader.unsafe(`SET ROLE ${role}`),e=>e.code==='42501');
  const [member]=await h.admin`SELECT pg_has_role(${role},'tallermecario_media_inventory_owner','MEMBER') member`;
  assert.equal(member.member,false);
 }
 for(const pool of [reader,h.apiPool,h.workerPool,purger])await assert.rejects(pool`SET ROLE tallermecario_media_inventory_owner`,e=>e.code==='42501');
 const acl=await h.admin`SELECT acl.grantee::regrole::text role FROM pg_proc p,
  aclexplode(p.proacl) acl WHERE p.oid='app.media_storage_metadata_exists(text,text[])'::regprocedure AND acl.privilege_type='EXECUTE' ORDER BY role`;
 assert.deepEqual(acl.map(a=>a.role),['tallermecario_media_inventory_owner','tallermecario_media_reconciler']);
 process.stdout.write(`B08_PROBE_CATALOG_EVIDENCE ${JSON.stringify({owner:'tallermecario_media_inventory_owner',columns:columns.map(c=>c.attname),attributes:role,memberships:0,privileges,execute:acl.map(a=>a.role),schemaOwnerVisibleRows:0})}
`);
});
test('probe validation keeps null, multidimensional and bucket boundaries unchanged',async()=>{
 for(const query of ["SELECT * FROM app.media_storage_metadata_exists(NULL,ARRAY['key'])","SELECT * FROM app.media_storage_metadata_exists('',ARRAY['key'])","SELECT * FROM app.media_storage_metadata_exists(repeat('x',121),ARRAY['key'])","SELECT * FROM app.media_storage_metadata_exists('test',NULL)","SELECT * FROM app.media_storage_metadata_exists('test',ARRAY[['a','b'],['c','d']])"])
  await assert.rejects(reader.unsafe(query),/MEDIA_RECONCILIATION_INPUT_INVALID/);
});
test('probe owner membership and unexpected execute grant fail startup closed',async()=>{
 for(const [grant,revoke] of [
  ['GRANT tallermecario_media_inventory_owner TO tallermecario_worker','REVOKE tallermecario_media_inventory_owner FROM tallermecario_worker'],
  ['GRANT SELECT ON public.customers TO tallermecario_media_inventory_owner','REVOKE SELECT ON public.customers FROM tallermecario_media_inventory_owner'],
  ['GRANT EXECUTE ON FUNCTION app.media_storage_metadata_exists(text,text[]) TO PUBLIC','REVOKE EXECUTE ON FUNCTION app.media_storage_metadata_exists(text,text[]) FROM PUBLIC']]){
  await h.admin.unsafe(grant);try{await assert.rejects(assertMediaReconcilerRole(reader),/ROLE_INVALID/);}finally{await h.admin.unsafe(revoke);}
 }await assertMediaReconcilerRole(reader);
});
test('actual valid empty, nonexistent and mixed tenant scopes expose safe coverage and exit 2',async()=>{
 const {a:emptyTenant}=await h.twoTenants();const tenantId=emptyTenant.tenantId;const missing=randomUUID();
 for(const id of [tenantId,missing]){
  const report=await scan(store([]),{tenantIds:[id]});assert.equal(report.scope,'configured_tenants');assert.equal(report.databaseRows,0);
  assert.equal(report.databaseComplete,true);assert.equal(report.tenantCoverage[0].status,'complete');assert.ok(report.alerts.includes('scope_empty'));assert.equal(mediaReconciliationExitCode(report),2);
 }
 const populated=await asset();
 const first=await scan(store([populated.object_key]),{tenantIds:[a.tenantId,tenantId,missing]});
 const repeated=await scan(store([populated.object_key]),{tenantIds:[a.tenantId,tenantId,missing]});
 assert.equal(first.tenantsRequested,3);assert.equal(first.tenantsWithRows,1);assert.ok(first.databaseRows>0);
 assert.equal(first.tenantCoverage.filter(t=>t.status==='complete'&&t.databaseRows===0).length,2);
 assert.ok(first.alerts.includes('scope_coverage_gap'));assert.equal(mediaReconciliationExitCode(first),2);assert.deepEqual(first.tenantCoverage,repeated.tenantCoverage);
 for(const id of [a.tenantId,tenantId,missing])assert.equal(JSON.stringify(first).includes(id),false);
});


test('actual unprivileged PUBLIC-only identity cannot execute the probe',async()=>{
 const name='tm_b08_public_'+randomUUID().replaceAll('-','');
 await h.admin.unsafe(`CREATE ROLE ${name} NOLOGIN NOINHERIT NOBYPASSRLS`);
 await h.admin.unsafe(`GRANT USAGE ON SCHEMA app TO ${name}`);
 try{
  await assert.rejects(h.admin.begin(async sql=>{await sql.unsafe(`SET LOCAL ROLE ${name}`);return sql`SELECT * FROM app.media_storage_metadata_exists(${bucket},ARRAY['key'])`;}),e=>e.code==='42501');
 }finally{await h.admin.unsafe(`REVOKE USAGE ON SCHEMA app FROM ${name}`);await h.admin.unsafe(`DROP ROLE ${name}`);}
});
test('one-shot process exits 0 only for populated clean scope; empty, unknown and mixed scopes exit 2',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os'),{spawn}=require('node:child_process');
 const {a:populated,b:empty}=await h.twoTenants();await asset(populated);
 const unknown=randomUUID(),directory=mkdtempSync(join(tmpdir(),'tm-b08-cli-')),preload=join(directory,'storage.cjs');
 writeFileSync(preload,`globalThis.fetch=async(url,init)=>{
  if(new URL(url).hostname!=='r2.invalid')throw new Error('TEST_NETWORK_FORBIDDEN');
  if(init.method==='HEAD')return new Response(null,{status:200});
  if(init.method!=='GET')throw new Error('TEST_MUTATION_FORBIDDEN');
  return new Response('<ListBucketResult><Name>'+process.env.R2_BUCKET+'</Name><Prefix></Prefix><EncodingType>url</EncodingType><MaxKeys>100</MaxKeys><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');
 };`);
 try{
  for(const [tenants,code,alert] of [[[populated.tenantId],0,null],[[empty.tenantId],2,'scope_empty'],[[unknown],2,'scope_empty'],[[populated.tenantId,empty.tenantId,unknown],2,'scope_coverage_gap']]){
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--require',preload,join(process.env.TEST_MODULE_ROOT,'worker/media-reconciliation-run.js')],{env:{...process.env,
     MEDIA_RECONCILIATION_ENABLED:'true',MEDIA_RECONCILIATION_DATABASE_URL:readerUrl,MEDIA_RECONCILIATION_REPORT_KEY:reportKey,MEDIA_RECONCILIATION_TENANT_IDS:tenants.join(','),MEDIA_RECONCILIATION_PAGE_SIZE:'100',
     R2_ENDPOINT:'https://r2.invalid',R2_REGION:'auto',R2_BUCKET:bucket,R2_ACCESS_KEY_ID:'synthetic',R2_SECRET_ACCESS_KEY:'synthetic'}});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',exit=>resolve({exit,stdout,stderr}));
   });
   assert.equal(result.exit,code,result.stderr);assert.equal(result.stderr,'');const report=JSON.parse(result.stdout);
   assert.equal(report.scope,'configured_tenants');assert.equal(report.tenantsRequested,tenants.length);assert.equal(report.status,'complete');
   if(alert)assert.ok(report.alerts.includes(alert));else {assert.deepEqual(report.alerts,[]);assert.equal(report.databaseRows,1);}
   for(const sensitive of [...tenants,readerUrl,bucket,reportKey,'synthetic','r2.invalid'])assert.equal(result.stdout.includes(sensitive),false);
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
