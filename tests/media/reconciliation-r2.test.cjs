'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {createReconciliationStorage,parseInventory}=require('../../dist/media/reconciliation-r2.js');
const {presignR2ListUrl}=require('../../dist/media/r2.js');
const {r2}=require('./fixtures.cjs');
const original=globalThis.fetch;
after(()=>{globalThis.fetch=original;});
const xml=(keys=[],extra={})=>`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${r2.bucket}</Name><Prefix></Prefix><EncodingType>url</EncodingType><MaxKeys>2</MaxKeys><KeyCount>${keys.length}</KeyCount><IsTruncated>${extra.truncated??false}</IsTruncated>${extra.token?`<NextContinuationToken>${extra.token}</NextContinuationToken>`:''}${extra.previous?`<ContinuationToken>${extra.previous}</ContinuationToken>`:''}${keys.map(k=>`<Contents><Key>${encodeURIComponent(k)}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
const signal=()=>AbortSignal.timeout(20000);
function mock(responses){let calls=0;const methods=[];globalThis.fetch=async(_url,init)=>{methods.push(init.method);const response=responses[Math.min(calls++,responses.length-1)];if(response instanceof Error)throw response;return typeof response==='function'?response(init):new Response(init.method==='HEAD'?null:response.body??xml(),{status:response.status??200});};return {count:()=>calls,methods};}
test('LIST signs the bucket root and all pagination parameters',()=>{
 const url=new URL(presignR2ListUrl(r2,'prefix with /',2,'opaque+/=&'));
 assert.equal(url.pathname,`/${r2.bucket}`);assert.equal(url.searchParams.get('list-type'),'2');
 assert.equal(url.searchParams.get('prefix'),'prefix with /');assert.equal(url.searchParams.get('continuation-token'),'opaque+/=&');assert.equal(url.searchParams.get('encoding-type'),'url');assert.ok(url.searchParams.get('X-Amz-Signature'));
});
test('LIST parses URL encoded keys, ampersands and continuation token',()=>{
 const page=parseInventory(xml(['key & +','á/filename'],{truncated:true,token:'opaque&amp;token'}),r2.bucket,'',2);
 assert.deepEqual(page,{keys:['key & +','á/filename'],truncated:true,nextToken:'opaque&token'});
 assert.equal(parseInventory(xml([]),r2.bucket,'',2).keys.length,0);
});
for(const [name,body] of Object.entries({
 error:'<Error><Code>Denied</Code></Error>', dtd:'<!DOCTYPE x><ListBucketResult/>',
 malformed:xml(['key']).replace('</Contents>',''), duplicate:xml(['key','key']),
 incomplete:xml(['key'],{truncated:true}), repeatedToken:xml(['key'],{truncated:true,token:'x',previous:'x'}),
 wrongBucket:xml([]).replace(r2.bucket,'other'), empty: '',wrongCount:xml(['key']).replace('<KeyCount>1','<KeyCount>0'),
 unknownEntity:xml([]).replace('<Prefix></Prefix>','<Prefix>&unknown;</Prefix>'),
 prefix:xml(['key']).replace('<Prefix></Prefix>','<Prefix>wrong</Prefix>'),
 }))test(`LIST rejects ${name} instead of accepting empty inventory`,()=>assert.throws(()=>parseInventory(body,r2.bucket,'',2,name==='repeatedToken'?'x':undefined),e=>e.code==='protocol_failure'));
for(const [status,code,attempts] of [[403,'access_denied',1],[401,'access_denied',1],[429,'rate_limited',3],[500,'provider_failure',3],[503,'provider_failure',3]]){
 for(const method of ['head','list'])test(`${method}: ${status} is ${code}, ${attempts} bounded attempts`,async()=>{
  const m=mock([{status}]),store=createReconciliationStorage(r2);
  await assert.rejects(method==='head'?store.head('private-key',signal()):store.list('',2,undefined,signal()),e=>e.code===code&&!e.message.includes('private-key'));
  assert.equal(m.count(),attempts);assert.ok(m.methods.every(v=>v==='HEAD'||v==='GET'));
 });
}
test('HEAD alone treats 404 as missing; LIST 404 is access/configuration uncertainty',async()=>{
 const m=mock([{status:404}]),store=createReconciliationStorage(r2);assert.equal(await store.head('key',signal()),'missing');
 await assert.rejects(store.list('',2,undefined,signal()),e=>e.code==='not_found');assert.equal(m.count(),2);
});
test('HEAD existence does not read content or require content length',async()=>{mock([{status:200}]);assert.equal(await createReconciliationStorage(r2).head('key',signal()),'exists');});
test('retryable response then success and network retry',async()=>{
 let m=mock([{status:429},{status:200}]);assert.equal(await createReconciliationStorage(r2).head('key',signal()),'exists');assert.equal(m.count(),2);
 m=mock([new Error('secret upstream URL'),{status:200}]);assert.equal(await createReconciliationStorage(r2).head('key',signal()),'exists');assert.equal(m.count(),2);
});
test('network failure remains opaque after three attempts',async()=>{const m=mock([new Error('credential-and-signed-url')]);await assert.rejects(createReconciliationStorage(r2).head('key',signal()),e=>e.code==='network_failure'&&!e.message.includes('credential'));assert.equal(m.count(),3);});
test('timeout retries three times without becoming missing',async()=>{
 const keepAlive=setInterval(()=>{},100);
 const m=mock([init=>new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}))]);
 try{await assert.rejects(createReconciliationStorage(r2).head('key',signal()),e=>e.code==='timeout');assert.equal(m.count(),3);}finally{clearInterval(keepAlive);}
});
test('cancellation interrupts a blocked LIST body without retry',async()=>{
 const controller=new AbortController();let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(new Error('opaque')),{once:true});controller.abort();}}));};
 await assert.rejects(createReconciliationStorage(r2).list('',2,undefined,controller.signal),e=>e.code==='cancelled');assert.equal(calls,1);
});
test('cancelled operation performs no requests',async()=>{const m=mock([{status:200}]);const c=new AbortController();c.abort();await assert.rejects(createReconciliationStorage(r2).head('key',c.signal),e=>e.code==='cancelled');assert.equal(m.count(),0);});
test('oversized LIST body is bounded and rejected',async()=>{mock([{body:'x'.repeat(512*1024+1)}]);await assert.rejects(createReconciliationStorage(r2).list('',2,undefined,signal()),e=>e.code==='protocol_failure');});
test('redirect and malformed URL configuration cannot expose credentials',async()=>{
 mock([{status:302}]);await assert.rejects(createReconciliationStorage(r2).head('key',signal()),e=>e.code==='protocol_failure');
 for(const endpoint of ['http://localhost','https://example.test/path','https://user:pw@example.test','https://example.test?redirect=x'])assert.throws(()=>createReconciliationStorage({...r2,endpoint}));
});

test('cancellation during backoff prevents a second request',async()=>{
 const c=new AbortController();let calls=0;globalThis.fetch=async()=>{calls++;setImmediate(()=>c.abort());return new Response(null,{status:429});};
 await assert.rejects(createReconciliationStorage(r2).head('key',c.signal),e=>e.code==='cancelled');assert.equal(calls,1);
});
test('LIST body timeout is retried and never an empty inventory',async()=>{
 const keepAlive=setInterval(()=>{},100);let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(new Error('timeout')),{once:true});}}));};
 try{await assert.rejects(createReconciliationStorage(r2).list('',2,undefined,signal()),e=>e.code==='timeout');assert.equal(calls,3);}finally{clearInterval(keepAlive);}
});
test('disabled entry point exits before DB/R2 access with redacted classification',()=>{
 const {spawnSync}=require('node:child_process'),{resolve}=require('node:path');
 const r=spawnSync(process.execPath,[resolve('dist/worker/media-reconciliation-run.js')],{env:{PATH:process.env.PATH,MEDIA_RECONCILIATION_ENABLED:'false'},encoding:'utf8'});
 assert.equal(r.status,1);assert.equal(r.stdout,'');assert.deepEqual(JSON.parse(r.stderr),{event:'media_reconciliation_startup_failed',failure:'disabled'});
});
