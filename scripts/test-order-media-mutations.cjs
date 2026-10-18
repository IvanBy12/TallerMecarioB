'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {CASES}=require('./order-media-mutations.cjs');
const {summary}=require('./test-media-assignment-mutations.cjs');
const {childEnvironment}=require('./test-s4-quality-gate.cjs');
function validate(result,name){
  assert.ifError(result.error);assert.equal(result.signal,null);
  assert.match(result.stdout,/^CLEAN_MIGRATION_PASS$/mu);assert.match(result.stdout,/^CRM_API_FIXTURE_CLEANUP_PASS$/mu);
  const counts=summary(result.stdout);
  if(!name){assert.equal(result.status,0);assert.equal(result.stderr.trim(),'');assert.equal(counts.fail,0);return counts;}
  const change=CASES[name];assert.ok(change);assert.match(result.stdout,new RegExp(`^S4GAP_MUTATION_APPLIED ${name}$`,'mu'));
  assert.equal(result.status,1);assert.equal(result.stderr.trim(),'CRM_API_TEST_RUN_FAILED');
  const failures=[...result.stdout.matchAll(/^not ok \d+ - ([^\r\n]+)\r?\n  ---\r?\n([\s\S]*?)^  \.\.\.\r?$/gmu)];
  assert.equal(failures.length,1);assert.equal(counts.fail,1);assert.equal(counts.pass,0);
  assert.match(failures[0][1],new RegExp(change.pattern,'u'));
  assert.match(failures[0][2],/^  failureType: 'testCodeFailure'$/mu);
  assert.match(failures[0][2],/^  code: 'ERR_ASSERTION'$/mu);
  assert.ok(failures[0][2].includes(change.testFile));return counts;
}
function main(){
  const environment=childEnvironment(process.env);
  function run(extra){
    const result=spawnSync(process.execPath,['scripts/test-media-integrity-api.cjs'],{env:{...environment,...extra},encoding:'utf8',timeout:120000,maxBuffer:10000000});
    try{return validate(result,extra.S4GAP_MUTATION);}catch(error){process.stderr.write((result.stdout??'').slice(-4000)+(result.stderr??'').slice(-1000));throw error;}
  }
  run({TEST_FILE_FILTER:'order-query.test.cjs',TEST_NAME_PATTERN:'^M(03|15|16|20|27|34)'});
  run({TEST_FILE_FILTER:'order-query-deadline.test.cjs',TEST_NAME_PATTERN:'^M29:'});
  run({TEST_FILE_FILTER:'download-contention.test.cjs',TEST_NAME_PATTERN:'^F3N1'});
  run({TEST_FILE_FILTER:'download-contention.test.cjs',TEST_NAME_PATTERN:'^N1 (healthy|deadline boundary)'});
  process.stdout.write('S4GAP_NORMAL_BASELINE_PASS\n');
  for(const [name,c] of Object.entries(CASES)){run({S4GAP_MUTATION:name,TEST_FILE_FILTER:c.testFile,TEST_NAME_PATTERN:c.pattern});process.stdout.write(`S4GAP_MUTANT_KILLED ${name}\n`);}
  process.stdout.write(`S4GAP_MUTATION_COUNTS killed=${Object.keys(CASES).length} survived=0 invalid=0\n`);
}
if(require.main===module)main();
module.exports={validate,main};
