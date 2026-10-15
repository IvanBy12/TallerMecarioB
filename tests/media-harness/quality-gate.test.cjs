'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PENDING, plan, childEnvironment, exitStatus, runGate, validateEvidence, preflight, assertFreshCluster, executeStep, localDatabaseUrl } = require('../../scripts/test-s4-quality-gate.cjs');
function success(step) {
  const e = step.evidence;
  return { status: 0, stdout: e.kind === 'markers' ? e.lines.join('\n') + '\n'
    : e.kind === 'tap' ? e.floors.map(n => summary(n)).join('') : '' };
}
function summary(n, extra = {}) {
  return Object.entries({ tests: n, suites: 0, pass: n, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...extra }).map(([k,v]) => `# ${k} ${v}\n`).join('');
}
const steps = [{ command: 'fixture', args: ['one'], evidence: { kind: 'exit' } }, { command: 'fixture', args: ['two'], evidence: { kind: 'exit' } }];
for (const status of [1, 2, 7, 42]) test(`gate preserves child exit ${status} and stops before later suites`, () => {
  let calls = 0;
  const report = runGate(steps, () => { calls++; return { status }; }, { profile: 'full' });
  assert.equal(report.exitCode, status); assert.equal(calls, 1);
  assert.equal(report.backendAutomatedGate, 'FAIL'); assert.equal(report.fullSprint4Gate, 'FAIL');
});
test('successful local gate retains every external blocker', () => {
  const report = runGate(plan(), success, { profile: 'full' });
  assert.equal(report.backendAutomatedGate, 'PASS'); assert.equal(report.results.length, 27);
  assert.equal(report.fullSprint4Gate, 'BLOCKED'); assert.equal(report.productionReadiness, 'NOT_READY');
  assert.deepEqual(report.pendingEvidence, PENDING); assert.ok(PENDING.length >= 7);
});
test('CI subset and empty plan cannot certify complete backend execution', () => {
  assert.equal(runGate(steps, () => ({ status: 0 }), { profile: 'ci-media' }).backendAutomatedGate, 'NOT_RUN');
  assert.equal(runGate([], () => { throw Error(); }, { profile: 'full' }).backendAutomatedGate, 'NOT_RUN');
});
for (const result of [{ status: null, signal: 'SIGTERM' }, { status: null, error: { code: 'ETIMEDOUT' } },
  { status: null }, { status: 0, error: { code: 'EIO' } }]) test(`signal/spawn failure cannot pass: ${JSON.stringify(result)}`, () => {
  const report = runGate(steps, () => result, { profile: 'full' });
  assert.notEqual(report.exitCode, 0); assert.equal(report.results.length, 1);
  assert.equal(report.backendAutomatedGate, 'FAIL');
});
test('signal exit follows conventional shell status', () => assert.equal(exitStatus({ status: null, signal: 'SIGTERM' }), 143));
test('thrown spawn errors fail closed without exposing their messages', () => {
  const report = runGate(steps, () => { throw Error('sensitive provider diagnostic'); }, { profile: 'full' });
  assert.equal(report.exitCode, 1); assert.equal(JSON.stringify(report).includes('sensitive provider'), false);
});
test('ambient credentials, mutations, filters and preloads cannot redirect or narrow the gate', () => {
  const source = { PATH: '/fixture', DATABASE_URL: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture',
    MEDIA_PURGE_ENABLED: 'true', R2_EXTERNAL_GATE: '1', CLERK_SECRET_KEY: 'fixture',
    WOMPI_SANDBOX: '1', MIGRATIONS_FOLDER: '/fixture', TEST_FILE_FILTER: 'nothing',
    TEST_NAME_PATTERN: 'nothing', TEST_SUITE_DIR: 'other', S4B07_MUTATION: 'accept_released',
    NODE_OPTIONS: '--require /fixture' };
  assert.deepEqual(childEnvironment(source), { PATH: '/fixture', DATABASE_URL: 'fixture', NODE_OPTIONS: '--test-reporter=tap' });
  assert.equal(source.R2_EXTERNAL_GATE, '1');
});
test('plans exclude live flow and redundant focused DB wrappers; CI includes all hermetic media suites', () => {
  for (const subset of [false, true]) {
    const text = JSON.stringify(plan(subset));
    for (const forbidden of ['test:media:r2', 'upload-flow.test', 'worker:media', 'test:media:purge:ci', 'test:media:reconciliation:ci', 'test:reception:mutations:ci'])
      assert.equal(text.includes(forbidden), false, forbidden);
    assert.ok(text.includes('test:media:api:ci')); assert.ok(text.includes('test:media:upgrade:ci'));
  }
  assert.ok(JSON.stringify(plan(false)).includes('scripts/test-inspection-mutations.cjs'));
  for (const file of ['content', 'idempotency', 'r2-presign', 'r2-integrity', 'reconciliation', 'r2-network', 'r2-transport'])
    assert.ok(JSON.stringify(plan(true)).includes(`tests/media/${file}.test.cjs`));
});

const api = plan().find(s => s.args[1] === 'test:media:api:ci');
for (const [name, stdout] of [
  ['34/621 exit-zero partial API', summary(34)], ['zero tests', summary(0)],
  ['absent summary', ''], ['missing field', summary(621).replace('# cancelled 0\n','')],
  ['inconsistent pass', summary(621,{pass:620})], ['failures', summary(621,{fail:1})],
  ['skipped critical test', summary(621,{skipped:1})], ['cancelled critical test', summary(621,{cancelled:1})],
  ['todo critical test', summary(621,{todo:1})], ['duplicate summary', summary(621)+summary(621)],
  ['custom/spec reporter', summary(621).replaceAll('#','ℹ')],
  ['malformed integer', summary(621).replace('tests 621','tests 621x')],
  ['unordered summary', summary(621).replace('# tests 621\n','')+'# tests 621\n'],
]) test(`coverage fails closed: ${name}`, () => {
  const report = runGate([api], () => ({status:0,stdout}), {profile:'full'});
  assert.equal(report.scopeAutomatedGate,'FAIL'); assert.equal(report.backendAutomatedGate,'FAIL');
  assert.equal(report.exitCode,1); assert.ok(report.results[0].evidenceError);
});
for (const count of [621,622,800]) test(`coverage floor allows ${count} successful API tests`, () => {
  assert.equal(validateEvidence(api,{stdout:summary(count)}).counts[0].tests,count);
});
test('CRLF TAP accepted explicitly', () => assert.equal(validateEvidence(api,{stdout:summary(621).replaceAll('\n','\r\n')}).counts[0].pass,621));
test('custom runners require their strict evidence, never synthetic TAP', () => {
  for (const s of plan().filter(s=>s.evidence.kind==='markers')) {
    assert.throws(()=>validateEvidence(s,{stdout:summary(621)}));
    assert.doesNotThrow(()=>validateEvidence(s,success(s)));
    assert.throws(()=>validateEvidence(s,{stdout:success(s).stdout+success(s).stdout}));
  }
});
test('unknown suite or exit-only subset cannot certify backend', () => {
  assert.equal(runGate(steps,()=>({status:0}),{profile:'full'}).backendAutomatedGate,'NOT_RUN');
  assert.equal(runGate([{command:'fixture',args:[]}],()=>({status:0}),{profile:'full'}).scopeAutomatedGate,'FAIL');
});
const injection = '--test-name-pattern=two.orders|strict.empty.body|B09.photo/missing|equivalent.sequential.create|CREATE.persists.v1|technician.remains.denied|dedicated.login.passes|pending.cleanup.is.created_at|strict.body.rejects';
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
for (const [name, extra] of Object.entries({
  normal: {}, npm_config_node_options:{npm_config_node_options:injection},
  NPM_CONFIG_NODE_OPTIONS:{NPM_CONFIG_NODE_OPTIONS:injection},
  no_match:{NODE_OPTIONS:'--test-name-pattern=does-not-exist',TEST_NAME_PATTERN:'does-not-exist',TEST_FILE_FILTER:'none'},
  custom_reporter:{NODE_OPTIONS:'--test-reporter=spec --require=does-not-exist',NODE_PATH:'/untrusted'},
  npmrc:{npm_config_userconfig:'/untrusted',NPM_CONFIG_GLOBALCONFIG:'/untrusted',npm_config_script_shell:'/untrusted'},
})) test(`real child executes full coverage despite ${name}`, () => {
  const folder=mkdtempSync(join(tmpdir(),'s4-gate-env-'));
  try {
    const file=join(folder,'suite.test.cjs');
    writeFileSync(file,"const {test}=require('node:test');test('alpha',()=>{});test('beta',()=>{});\n");
    writeFileSync(join(folder,'.npmrc'),'node-options=--test-name-pattern=alpha\n');
    const env=childEnvironment({...process.env,...extra,HOME:folder});
    assert.equal(Object.keys(env).some(k=>/^npm_config_/iu.test(k)),false);
    const s={command:process.execPath,args:['--test',file],evidence:{kind:'tap',floors:[2]}};
    const result=executeStep(s,env,{cwd:folder,quiet:true});
    assert.equal(result.status,0); assert.equal(validateEvidence(s,result).counts[0].tests,2);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
test('actual child assertion failure never passes', () => {
  const folder=mkdtempSync(join(tmpdir(),'s4-gate-fail-'));
  try {
    const file=join(folder,'suite.test.cjs');
    writeFileSync(file,"require('node:test').test('failure',()=>require('node:assert/strict').fail('expected'));\n");
    const s={command:process.execPath,args:['--test',file],evidence:{kind:'tap',floors:[1]}};
    assert.equal(runGate([s],step=>executeStep(step,childEnvironment(process.env),{quiet:true}),{profile:'full'}).exitCode,1);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
const fresh={version:180006,database:'postgres',user:'postgres',superuser:true,userObjects:0,
  roles:['postgres','pg_database_owner'],databases:['postgres','template0','template1']};
test('fresh PostgreSQL 18 cluster is accepted',()=>assert.equal(assertFreshCluster(fresh).version,180006));
for (const [name,extra] of Object.entries({canonical_role:{roles:[...fresh.roles,'tallermecario_api']},
  fixture_role:{roles:[...fresh.roles,'tm_test_leaked']},unexpected_role:{roles:[...fresh.roles,'ordinary_user']},
  populated_database:{databases:[...fresh.databases,'ordinary_db']},objects:{userObjects:1},
  wrong_version:{version:170006},non_admin:{superuser:false},wrong_database:{database:'ordinary_db'},
})) test(`preflight rejects ${name}`,()=>assert.throws(()=>assertFreshCluster({...fresh,...extra})));
// Runtime negatives use only a caller-supplied cluster that first passed the full
// freshness preflight. Never inspect or modify an ordinary developer database.
test('real disposable PostgreSQL positive and negatives preserve foreign state',async()=>{
  if (!process.env.DATABASE_URL) return; // Unit-only invocation; runtime evidence requires DATABASE_URL.
  const url=new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  const sql=require('postgres')(url.toString(),{max:1,onnotice(){}});
  try {
    assert.equal((await preflight(sql)).version,180006);
    for (const role of ['tallermecario_api','tm_s4_gate_leaked_fixture','s4_gate_shared_user']) {
      await sql.unsafe(`CREATE ROLE ${role}`);
      try {
        await assert.rejects(preflight(sql),{message:'DISPOSABLE_CLUSTER_NOT_FRESH'});
        assert.equal((await sql`SELECT rolname FROM pg_roles WHERE rolname=${role}`).length,1);
      } finally { await sql.unsafe(`DROP ROLE ${role}`); }
    }
    await sql.unsafe('CREATE DATABASE s4_gate_shared_database');
    try {
      await assert.rejects(preflight(sql),{message:'DISPOSABLE_CLUSTER_NOT_FRESH'});
      assert.equal((await sql`SELECT datname FROM pg_database WHERE datname='s4_gate_shared_database'`).length,1);
    } finally {await sql.unsafe('DROP DATABASE s4_gate_shared_database');}
    await sql.unsafe('CREATE TABLE public.s4_gate_existing_object(id int)');
    try {await assert.rejects(preflight(sql),{message:'DISPOSABLE_CLUSTER_NOT_FRESH'});}
    finally {await sql.unsafe('DROP TABLE public.s4_gate_existing_object');}
    for (const [create,drop] of [
      ["CREATE FUNCTION public.s4_gate_existing_function() RETURNS int LANGUAGE sql AS 'SELECT 1'",'DROP FUNCTION public.s4_gate_existing_function()'],
      ['CREATE SCHEMA s4_gate_existing_schema','DROP SCHEMA s4_gate_existing_schema'],
      ["CREATE TYPE public.s4_gate_existing_type AS ENUM ('existing')",'DROP TYPE public.s4_gate_existing_type'],
    ]) {
      await sql.unsafe(create);
      try {await assert.rejects(preflight(sql),{message:'DISPOSABLE_CLUSTER_NOT_FRESH'});}
      finally {await sql.unsafe(drop);}
    }
    assert.equal((await preflight(sql)).databaseCount,3);
  } finally {await sql.end({timeout:5});}
});

for (const [name,args] of [
  ['signal',['-e',"process.kill(process.pid,'SIGTERM')"]],
  ['unexpected exit',['-e','process.exit(7)']],
  ['exit zero without summary',['-e',"console.log('no summary')"]],
]) test(`real child ${name} fails the gate`,()=>{
  const s={command:process.execPath,args,evidence:{kind:'tap',floors:[1]}};
  const report=runGate([s],step=>executeStep(step,childEnvironment(process.env),{quiet:true}),{profile:'full'});
  assert.notEqual(report.exitCode,0);assert.equal(report.scopeAutomatedGate,'FAIL');
});

test('explicit database URL defaults prevent ambient PG endpoint drift',async()=>{
  const url=localDatabaseUrl('postgresql://localhost');
  assert.equal(url.port,'5432');assert.equal(url.username,'postgres');assert.equal(url.pathname,'/postgres');
  const env={...process.env,PGPORT:'55499',PGUSER:'other',PGDATABASE:'shared'};
  const child=childEnvironment({...env,DATABASE_URL:url.toString()});
  assert.equal(child.PGPORT,undefined);assert.equal(child.PGUSER,undefined);assert.equal(child.PGDATABASE,undefined);
  assert.equal(child.DATABASE_URL,url.toString());
  const original=process.env.PGPORT;process.env.PGPORT='55499';
  let sql;
  try {sql=require('postgres')(url.toString());assert.deepEqual(sql.options.port,[5432]);}
  finally {if(original===undefined)delete process.env.PGPORT;else process.env.PGPORT=original;await sql?.end();}
});
test('URL query overrides, remote hosts and invalid protocols fail before connection',()=>{
  for(const url of ['postgresql://localhost/postgres?host=remote','postgresql://remote/postgres',
    'https://localhost/postgres','postgresql://localhost/postgres#override','invalid'])
    assert.throws(()=>localDatabaseUrl(url),{message:'LOCAL_DATABASE_REQUIRED'});
  assert.equal(localDatabaseUrl('postgresql://postgres@127.0.0.1:55439/postgres').port,'55439');
});
