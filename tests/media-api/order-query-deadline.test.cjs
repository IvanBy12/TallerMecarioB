'use strict';
const { test, before, after } = require('node:test');
const { randomUUID, randomBytes } = require('node:crypto');
const { Writable } = require('node:stream');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const h = require('../crm-api/helpers.cjs');
const { assert } = h;
const { buildApi } = h.load('api/app.js');
const { registerMediaRoutes } = h.load('media/routes.js');
const { createOrderMediaCursor } = h.load('media/order-query-cursor.js');
const f = require('../media/fixtures.cjs');
const codec = createOrderMediaCursor('test', new Map([['test', randomBytes(32)]]));
let a;
before(async () => { ({ a } = await h.twoTenants()); });
after(async () => { await h.closeAll(); });
const url = id => `/api/v1/orders/${id}/media`;
async function until(check) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) { if (await check()) return; await yieldTurn(); }
  throw Error('Late reservation cleanup timeout');
}
// Separate file keeps the existing 60-second per-file runner budget intact.

test('front-door deadline covers delayed identity: late verification cannot open a DB transaction',async()=>{
  let verify,reservations=0;
  const database=new Proxy(h.apiPool,{get(target,key,receiver){
    if(key==='reserve')return (...args)=>{reservations++;return target.reserve(...args);};
    return Reflect.get(target,key,receiver);
  }});
  const slow=await buildApi({database,identityProvider:{verifyRequest(){return new Promise(resolve=>{verify=resolve;});}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2,codec);}});
  try{
    const started=performance.now();const response=await slow.inject({url:url(randomUUID()),headers:{'x-tenant-id':a.tenantId}});
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'MEDIA_QUERY_RETRY');
    assert.equal(response.headers['cache-control'],'no-store');assert.ok(performance.now()-started>=14500);assert.ok(performance.now()-started<19000);
    verify({identityProvider:'clerk',externalSubject:a.owner.subject});await yieldTurn();await yieldTurn();assert.equal(reservations,0);
  }finally{await slow.close();}
});
test('front-door pool deadline releases a late reservation without BEGIN or tenant queries',async()=>{
  let grant,released=0,lateQueries=0;
  const database=new Proxy(h.apiPool,{get(target,key,receiver){
    if(key==='reserve')return ()=>new Promise(resolve=>{grant=async()=>{
      const raw=await target.reserve();resolve(new Proxy(raw,{apply(fn,self,args){lateQueries++;return Reflect.apply(fn,self,args);},
        get(fn,property,owner){if(property==='release')return ()=>{released++;raw.release();};return Reflect.get(fn,property,owner);}}));
    };});
    return Reflect.get(target,key,receiver);
  }});
  const slow=await buildApi({database,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.owner.subject};}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(server){registerMediaRoutes(server,f.r2,codec);}});
  try{
    const started=performance.now();const response=await slow.inject({url:url(randomUUID()),headers:{'x-tenant-id':a.tenantId}});
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'MEDIA_QUERY_RETRY');assert.equal(response.headers['cache-control'],'no-store');
    assert.ok(performance.now()-started>=14500);assert.ok(performance.now()-started<19000);
    await grant();await until(()=>released===1);assert.equal(lateQueries,0);
  }finally{await slow.close();}
});

test('M29: an expired deadline is rechecked after onSend and before commit',async()=>{
  const {getTenantRequestContext}=h.load('api/app.js'),{orderMediaDeadline}=h.load('media/order-query-limits.js');let handlerFinished=false;
  const server=await buildApi({database:h.apiPool,identityProvider:{async verifyRequest(){return {identityProvider:'clerk',externalSubject:a.owner.subject};}},
    logStream:new Writable({write(_c,_e,done){done();}}),registerRoutes(app){
      app.get('/api/v1/orders/:orderId/media',{config:{permission:'media.read',permissionScope:'resource'},
        onSend:async(request,_reply,payload)=>{await new Promise(resolve=>setTimeout(resolve,Math.max(1,orderMediaDeadline(request)-performance.now()+50)));return payload;},
      },async request=>{await getTenantRequestContext(request).sql`SELECT 1`;handlerFinished=true;return {media:[],nextCursor:null};});
    }});
  try{
    const result=await server.inject({url:url(randomUUID()),headers:{'x-tenant-id':a.tenantId}});
    assert.equal(handlerFinished,true);assert.equal(result.statusCode,503);assert.equal(result.json().error.code,'MEDIA_QUERY_RETRY');
    assert.equal((await h.admin`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename<>current_user AND xact_start IS NOT NULL`)[0].n,0);
  }finally{await server.close();}
});
