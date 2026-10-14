'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {reconcileMedia}=require('../../dist/media/reconciliation.js');
const {mediaReconciliationExitCode}=require('../../dist/worker/media-reconciliation-run.js');
const {ReconciliationStorageError}=require('../../dist/media/reconciliation-r2.js');
const tenant=randomUUID(),bucket='private-bucket-marker',reportKey='test-only-report-hmac-material-000000';
const opts={tenantIds:[tenant],bucket,reportKey,pageSize:2,maxDatabasePages:10,maxInventoryPages:10};
function row(extra={}){return {id:randomUUID(),bucket,object_key:'private-object-key-'+randomUUID(),storage_provider:'cloudflare_r2',status:'active',deletion_requested_at:null,deleted_at:null,purged_at:null,held:false,pending:false,job_state:null,version:'v1',...extra};}
function fixtures(rows=[],objects=rows.map(r=>r.object_key)){
 rows.sort((a,b)=>a.id.localeCompare(b.id));const heads=[];let pages=0,listPages=0;
 const metadata={async page(_t,after,limit){pages++;return rows.filter(r=>!after||r.id>after).slice(0,limit).map(r=>({...r}));},async asset(_t,id){const r=rows.find(r=>r.id===id);return r?{...r}:undefined;},async exists(_b,keys){return keys.map(k=>rows.some(r=>r.object_key===k));}};
 const storage={async head(key){heads.push(key);return objects.includes(key)?'exists':'missing';},async list(_prefix,limit,token){listPages++;const start=Number(token??0),keys=objects.slice(start,start+limit),truncated=start+limit<objects.length;return {keys,truncated,nextToken:truncated?String(start+limit):undefined};}};
 return {rows,objects,metadata,storage,heads,pages:()=>pages,listPages:()=>listPages};
}
const scan=(f,extra={})=>reconcileMedia(f.metadata,f.storage,{...opts,...extra});
test('active exists and HEAD-confirmed missing are distinct; LIST omission never proves absence',async()=>{
 const exists=row(),missing=row();const f=fixtures([exists,missing],[exists.object_key]);const report=await scan(f);
 assert.equal(report.status,'complete');assert.equal(report.counts.active_exists,1);assert.equal(report.counts.active_missing,1);assert.ok(report.alerts.includes('active_missing'));
 assert.deepEqual(f.heads.sort(),[exists.object_key,missing.object_key].sort());
});
for(const [state,extra,classification] of [
 ['pending',{status:'pending_upload',pending:true},'pending_upload'],['expired',{status:'pending_upload'},'incomplete_upload'],
 ['uploaded',{status:'uploaded'},'uploaded_unverified'],['quarantined',{status:'quarantined'},'quarantined'],
 ['tombstoned',{status:'deleted',deleted_at:new Date()},'deletion_in_progress'],['purged',{status:'deleted',deleted_at:new Date(),purged_at:new Date()},'purged_absent'],
 ['parked',{status:'deleted',job_state:'reconciliation_required'},'reconciliation_required'],
])test(`${state} metadata is never active-missing or orphan`,async()=>{
 const r=row(extra),f=fixtures([r],[]),report=await scan(f);assert.equal(report.counts[classification],1);assert.equal(report.counts.active_missing,undefined);assert.equal(report.counts.orphan_candidate,undefined);
 f.objects.push(r.object_key);const present=await scan(f);assert.equal(present.counts.orphan_candidate,undefined);assert.equal(present.counts[state==='purged'?'purged_object_present':classification],1);
});
test('hold is reported without exposing details; scanner does not alter metadata',async()=>{
 const r=row({held:true}),f=fixtures([r],[]),before=JSON.stringify(f.rows);const report=await scan(f);
 assert.ok(report.alerts.includes('held_missing'));assert.equal(JSON.stringify(f.rows),before);
});
test('orphan candidate requires complete paginated inventory and second metadata probe',async()=>{
 const f=fixtures([row()],['orphan-1','orphan-2','orphan-3']);let probes=0;const exists=f.metadata.exists;f.metadata.exists=async(...args)=>{probes++;return exists(...args);};
 const report=await scan(f);assert.equal(report.counts.orphan_candidate,3);assert.equal(report.inventoryComplete,true);assert.equal(f.listPages(),2);assert.equal(probes,5);
});
test('matched historical and cross-scope metadata are never orphan candidates',async()=>{
 const f=fixtures([],['other-tenant-legacy-key']);f.metadata.exists=async(_b,keys)=>keys.map(()=>true);const r=await scan(f);assert.equal(r.counts.metadata_object,1);assert.equal(r.counts.orphan_candidate,undefined);assert.equal(f.heads.length,0);
});
test('partial database and storage scans suppress orphan promotion',async()=>{
 for(const limits of [{maxDatabasePages:1},{maxInventoryPages:1}]){
  const f=fixtures([row(),row(),row()],['orphan1','orphan2','orphan3']);const r=await scan(f,limits);assert.equal(r.status,'partial');assert.equal(r.counts.orphan_candidate,undefined);assert.equal(r.counts.orphan_observation,limits.maxInventoryPages?2:3);assert.ok(r.alerts.includes('scan_incomplete'));
 }
});
test('failed DB page or global probe cannot masquerade as absence',async()=>{
 for(const method of ['page','exists','asset']){const f=fixtures([row()],['orphan']);f.metadata[method]=async()=>{throw new Error('SQL signed-url password bucket key');};const r=await scan(f);assert.equal(r.status,'partial');assert.equal(r.counts.orphan_candidate,undefined);assert.ok(r.failures.database_failure);assert.ok(!JSON.stringify(r).includes('password'));}
});
test('later failed LIST invalidates provisional candidates',async()=>{
 const f=fixtures([],['orphan1','orphan2','orphan3']);const list=f.storage.list;f.storage.list=async(...args)=>{if(args[2])throw new ReconciliationStorageError('access_denied');return list(...args);};
 const r=await scan(f);assert.equal(r.counts.orphan_candidate,undefined);assert.equal(r.counts.orphan_observation,2);assert.equal(r.inventoryComplete,false);assert.ok(r.alerts.includes('storage_access'));
});
for(const code of ['access_denied','rate_limited','provider_failure','timeout','network_failure'])test(`failed HEAD ${code} never confirms missing`,async()=>{
 const f=fixtures([row()],[]);f.storage.head=async()=>{throw new ReconciliationStorageError(code);};const r=await scan(f);assert.equal(r.status,'partial');assert.equal(r.counts.active_missing,undefined);assert.equal(r.failures[code],1);
});
test('metadata lifecycle changes during HEAD are uncertain',async()=>{
 for(const change of [{status:'quarantined'},{status:'deleted',deleted_at:new Date()},{held:true},{pending:true},{purged_at:new Date()}]){
  const f=fixtures([row()]);f.storage.head=async()=>{Object.assign(f.rows[0],change,{version:'v2'});return 'missing';};const r=await scan(f);assert.equal(r.counts.lifecycle_changed,1);assert.equal(r.counts.active_missing,undefined);
 }
});
test('metadata appearing during orphan HEAD defeats candidate',async()=>{
 const f=fixtures([],['orphan']);f.storage.head=async key=>{f.rows.push(row({object_key:key}));return 'exists';};const r=await scan(f);assert.equal(r.counts.orphan_candidate,undefined);assert.equal(r.counts.metadata_object,1);
});
test('object disappearing during orphan HEAD is inventory change',async()=>{const f=fixtures([],['orphan']);f.storage.head=async()=> 'missing';const r=await scan(f);assert.equal(r.counts.inventory_changed,1);assert.equal(r.counts.orphan_candidate,undefined);});
test('LIST repeated tokens and duplicate keys fail closed',async()=>{
 const f=fixtures([],['orphan']);f.storage.list=async()=>({keys:['orphan'],truncated:true,nextToken:'repeated'});const r=await scan(f);assert.equal(r.counts.orphan_candidate,undefined);assert.ok(r.failures.protocol_failure);
});
test('bounded HEAD concurrency and repeated scans are idempotent',async()=>{
 const f=fixtures(Array.from({length:12},()=>row()));let active=0,max=0;f.storage.head=async()=>{active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return 'exists';};
 const first=await scan(f,{pageSize:12,concurrency:3}),second=await scan(f,{pageSize:12,concurrency:3});assert.equal(max,3);assert.deepEqual(first.counts,second.counts);assert.equal(first.runId===second.runId,false);assert.equal(f.rows.length,12);
});
test('reports and errors cannot leak keys, buckets, tenant IDs or capabilities',async()=>{
 const r=row(),f=fixtures([r],['PII-secret-orphan']);const report=await scan(f),text=JSON.stringify(report);
 for(const forbidden of [r.object_key,r.id,tenant,bucket,'PII-secret-orphan',reportKey,'X-Amz','https://'])assert.equal(text.includes(forbidden),false);
 assert.equal(report.liveEvidence.bucketPrivacy,'pending');assert.equal(report.liveEvidence.credentialPermissions,'pending');
});
test('cancellation during HEAD suppresses candidates, stops new work and permits rerun',async()=>{
 const controller=new AbortController(),f=fixtures([row(),row(),row()]);let calls=0;f.storage.head=async()=>{calls++;controller.abort();throw new ReconciliationStorageError('cancelled');};
 const r=await scan(f,{concurrency:1,signal:controller.signal});assert.equal(r.status,'cancelled');assert.equal(r.counts.orphan_candidate,undefined);assert.equal(calls,1);assert.equal(r.databaseComplete,false);
 f.storage.head=async()=> 'exists';assert.equal((await scan(f)).status,'complete');
});
test('already interrupted scans do no work',async()=>{const c=new AbortController();c.abort();const f=fixtures([row()]);const r=await scan(f,{signal:c.signal});assert.equal(r.status,'cancelled');assert.equal(f.pages(),0);assert.equal(f.listPages(),0);});
test('duration budget stops bounded transport and preserves partial status',async()=>{
 const f=fixtures([row()]),keepAlive=setInterval(()=>{},10);f.storage.head=async(_key,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new ReconciliationStorageError('cancelled')),{once:true}));
 try{const r=await scan(f,{maxDurationMs:20});assert.equal(r.status,'partial');assert.equal(r.reason,'budget');assert.equal(r.counts.active_missing,undefined);}finally{clearInterval(keepAlive);}
});
test('invalid limits, tenant selection and configuration fail before access',async()=>{
 const f=fixtures();for(const extra of [{concurrency:17},{pageSize:0},{maxInventoryPages:101},{maxDurationMs:NaN},{tenantIds:[]},{tenantIds:[tenant,tenant]},{reportKey:'short'}])await assert.rejects(scan(f,extra));assert.equal(f.pages(),0);assert.equal(f.listPages(),0);
});

test('metadata bucket mismatch is an actionable partial configuration failure without HEAD',async()=>{
 const f=fixtures([row({bucket:'wrong-bucket'})],[]);const report=await scan(f);
 assert.equal(report.status,'partial');assert.equal(report.reason,'configuration');assert.equal(report.failures.metadata_configuration,1);assert.equal(f.heads.length,0);assert.equal(report.counts.active_missing,undefined);
});


test('60 ordinary findings cannot displace held-missing or purged-present critical references',async()=>{
 const ordinary=Array.from({length:60},(_,i)=>row({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,status:'deleted',deleted_at:new Date()}));
 const held=row({id:'00000000-0000-4000-8000-000000000061',held:true});
 const purged=row({id:'00000000-0000-4000-8000-000000000062',status:'deleted',deleted_at:new Date(),purged_at:new Date()});
 const f=fixtures([...ordinary,held,purged],[purged.object_key]);
 const report=await scan(f,{pageSize:100});
 assert.deepEqual(report.counts,{deletion_in_progress:60,active_missing:1,purged_object_present:1,metadata_object:1});
 assert.ok(report.alerts.includes('held_missing'));assert.ok(report.alerts.includes('purged_object_present'));
 assert.ok(report.samples.some(s=>s.classification==='active_missing'&&s.held));
 assert.ok(report.samples.some(s=>s.classification==='purged_object_present'));
 assert.equal(report.samples.length,50);assert.equal(report.samplesTruncated,true);
 for(const s of report.samples)assert.match(s.ref,/^[a-f0-9]{64}$/);
 for(const secret of [tenant,bucket,reportKey,...f.rows.flatMap(r=>[r.id,r.object_key])])assert.equal(JSON.stringify(report).includes(secret),false);
});
test('competing critical classes and repeated findings keep deterministic bounded class references',async()=>{
 const rows=Array.from({length:80},(_,i)=>row(i%4===0?{held:true}:i%4===1?{}:i%4===2?{purged_at:new Date(),deleted_at:new Date(),status:'deleted'}:{job_state:'reconciliation_required'}));
 const f=fixtures(rows,rows.filter(r=>r.purged_at).map(r=>r.object_key));
 const head=f.storage.head;
 f.storage.head=async(...args)=>{await new Promise(r=>setImmediate(r));return head(...args);};
 const first=await scan(f,{pageSize:100,concurrency:1}),second=await scan(f,{pageSize:7,maxDatabasePages:20,concurrency:16});
 assert.deepEqual(first.counts,second.counts);assert.deepEqual(first.samples,second.samples);
 assert.equal(first.samples.length,50);assert.equal(first.samplesTruncated,true);
 for(const classification of ['active_missing','purged_object_present','reconciliation_required'])assert.ok(first.samples.some(s=>s.classification===classification));
 assert.ok(first.samples.some(s=>s.classification==='active_missing'&&s.held));assert.ok(first.samples.some(s=>s.classification==='active_missing'&&!s.held));
 assert.deepEqual(first.tenantCoverage,second.tenantCoverage);
});
test('populated scope explicitly reports coverage and clean exit; repeated scans preserve accounting',async()=>{
 const f=fixtures([row()]);const first=await scan(f),second=await scan(f);
 assert.equal(first.scope,'configured_tenants');assert.equal(first.tenantsRequested,1);assert.equal(first.tenantsWithRows,1);
 assert.equal(first.databaseRows,1);assert.deepEqual(first.tenantCoverage,second.tenantCoverage);
 assert.deepEqual(first.tenantCoverage.map(t=>[t.status,t.databaseRows]),[['complete',1]]);
 assert.equal(mediaReconciliationExitCode(first),0);
});
test('empty or nonexistent requested tenant warns instead of producing clean exit',async()=>{
 for(const id of [tenant,randomUUID()]){
  const report=await scan(fixtures(),{tenantIds:[id]});
  assert.equal(report.scope,'configured_tenants');assert.equal(report.databaseRows,0);assert.equal(report.tenantsWithRows,0);
  assert.equal(report.status,'complete');assert.equal(report.databaseComplete,true);
  assert.ok(report.alerts.includes('scope_empty'));assert.equal(mediaReconciliationExitCode(report),2);
  assert.deepEqual(report.tenantCoverage.map(t=>[t.status,t.databaseRows]),[['complete',0]]);
  assert.equal(JSON.stringify(report).includes(id),false);
 }
});
test('mixed tenant list reports populated, empty and nonexistent coverage without identifiers',async()=>{
 const empty=randomUUID(),unknown=randomUUID(),f=fixtures([row()]);const page=f.metadata.page;
 f.metadata.page=(t,...args)=>t===tenant?page(t,...args):Promise.resolve([]);
 const report=await scan(f,{tenantIds:[tenant,empty,unknown]});
 assert.equal(report.tenantsRequested,3);assert.equal(report.tenantsWithRows,1);assert.equal(report.databaseRows,1);
 assert.equal(report.tenantCoverage.length,3);assert.equal(report.tenantCoverage.filter(t=>t.status==='complete'&&t.databaseRows===0).length,2);
 assert.ok(report.alerts.includes('scope_coverage_gap'));assert.equal(report.alerts.includes('scope_empty'),false);
 assert.equal(mediaReconciliationExitCode(report),2);
 for(const id of [tenant,empty,unknown])assert.equal(JSON.stringify(report).includes(id),false);
});
test('partial, failed and unvisited tenant coverage never certifies an empty or clean scope',async()=>{
 const other=randomUUID(),f=fixtures([row(),row(),row()]);
 const partial=await scan(f,{tenantIds:[tenant,other],maxDatabasePages:1});
 assert.equal(partial.databaseRows,2);assert.equal(partial.tenantsWithRows,1);assert.equal(partial.databaseComplete,false);
 assert.deepEqual(partial.tenantCoverage.map(t=>t.status).sort(),['not_started','partial']);
 assert.equal(partial.alerts.includes('scope_empty'),false);assert.equal(mediaReconciliationExitCode(partial),2);
 f.metadata.page=async()=>{throw new Error('test-only-database-failure');};
 const failed=await scan(f,{tenantIds:[tenant,other]});assert.equal(failed.reason,'database_failure');
 assert.deepEqual(failed.tenantCoverage.map(t=>t.status).sort(),['failed','not_started']);assert.equal(failed.alerts.includes('scope_empty'),false);
 assert.equal(mediaReconciliationExitCode(failed),2);
});
test('cancellation counts fetched rows, leaves sweep partial and rerun resets scope',async()=>{
 const f=fixtures([row(),row(),row()]),c=new AbortController();
 f.storage.head=async()=>{c.abort();throw new ReconciliationStorageError('cancelled');};
 const cancelled=await scan(f,{signal:c.signal,concurrency:1});
 assert.equal(cancelled.databaseRows,2);assert.equal(cancelled.tenantCoverage[0].databaseRows,2);
 assert.equal(cancelled.tenantCoverage[0].status,'partial');assert.equal(mediaReconciliationExitCode(cancelled),2);
 f.storage.head=async()=> 'exists';const repeated=await scan(f);assert.equal(repeated.databaseRows,3);assert.equal(repeated.tenantCoverage[0].status,'complete');assert.equal(mediaReconciliationExitCode(repeated),0);
});
test('failed global probe preserves metadata coverage but prevents verified-clean exit',async()=>{
 const f=fixtures([row()]);f.metadata.exists=async()=>{throw new Error('test-only-probe-failure');};
 const report=await scan(f);assert.equal(report.databaseComplete,true);assert.equal(report.tenantCoverage[0].status,'complete');
 assert.equal(report.status,'partial');assert.equal(report.reason,'database_failure');assert.equal(mediaReconciliationExitCode(report),2);
});
