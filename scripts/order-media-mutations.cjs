'use strict';
const {readFileSync,writeFileSync}=require('node:fs');
const {resolve,relative,isAbsolute,basename}=require('node:path');
const {tmpdir}=require('node:os');
const CASES=Object.freeze({
  N1CI:{file:'media/download-limits.js',anchor:'exports.MEDIA_DOWNLOAD_ADMISSION_WAIT_MS = 1000;',value:'exports.MEDIA_DOWNLOAD_ADMISSION_WAIT_MS = 500;',pattern:'^N1 deadline boundary:',testFile:'download-contention.test.cjs'},
  N1:{file:'media/download-limits.js',anchor:'if (state.waiters.length >= exports.MEDIA_DOWNLOAD_MAX_WAITERS)',value:'if (state.active >= state.capacity)',pattern:'^N1 healthy',testFile:'download-contention.test.cjs'},
  F3N1:{file:'api/tenant-request.js',within:'async function openTenantRequest(',anchor:"await raw.unsafe('ROLLBACK').catch(() => undefined);",value:'void raw;',pattern:'^F3N1 malformed:',testFile:'download-contention.test.cjs'},
  M03:{file:'media/assigned-authorization.js',anchor:'if (!grant)',value:'if (false && !grant)',pattern:'^M03 gallery:',testFile:'order-query.test.cjs'},
  M15:{file:'media/order-query.js',anchor:'if (JSON.stringify(current.slice(0, limit).map(tuple)) !== JSON.stringify(window.map(tuple)))',value:'if (false)',pattern:'^M15:',testFile:'order-query.test.cjs'},
  M16:{file:'media/order-query.js',anchor:'{ receptionIds: [receptionId], orderIds: [orderId] }',value:'{}',pattern:'^M16 empty:',testFile:'order-query.test.cjs'},
  M20:{file:'media/order-query-limits.js',anchor:'Math.min(8000, assertOrderMediaDeadline(deadline))',value:'8000',pattern:'^M20:',testFile:'order-query.test.cjs'},
  M27:{file:'api/server.js',anchor:'(server, r2, orderMediaCursor)',value:'(server, r2)',pattern:'^M27:',testFile:'order-query.test.cjs'},
  M29:{file:'api/tenant-request.js',within:'async function finalizeTenantTransaction(',anchor:'if (deadline !== undefined)',value:'if (false)',pattern:'^M29:',testFile:'order-query-deadline.test.cjs'},
  M34b:{file:'media/retention.js',anchor:'if (sessions.some((s) => !locked.sessions.has(s.id)))',value:'if (false)',pattern:'^M34b:',testFile:'order-query.test.cjs'},
  M34c:{file:'media/retention.js',anchor:'if (orders.length)',value:'if (false)',pattern:'^M34c:',testFile:'order-query.test.cjs'},
});
function applyOrderMediaMutation(compiledRoot){
  const name=process.env.S4GAP_MUTATION;if(!name)return;
  const change=CASES[name];if(!change)throw Error(`UNKNOWN_MUTATION ${name}`);
  // Existing harness compiles into OS temp and deletes it in finally. Refuse
  // any mutation targeting the checkout or a non-temporary source tree.
  const root=resolve(compiledRoot),rel=relative(resolve(tmpdir()),root);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||!basename(root).startsWith('tallermecario-crm-api-test-'))throw Error('MUTATION_ROOT_NOT_TEMPORARY');
  const path=resolve(root,change.file),source=readFileSync(path,'utf8'),start=change.within?source.indexOf(change.within):0;
  if(start<0)throw Error(`MUTATION_ANCHOR_NOT_FOUND ${name}`);
  const prefix=source.slice(0,start),body=source.slice(start);
  if(!body.includes(change.anchor))throw Error(`MUTATION_ANCHOR_NOT_FOUND ${name}`);
  writeFileSync(path,prefix+body.replace(change.anchor,change.value));
  process.stdout.write(`S4GAP_MUTATION_APPLIED ${name}\n`);
}
module.exports={CASES,applyOrderMediaMutation};
