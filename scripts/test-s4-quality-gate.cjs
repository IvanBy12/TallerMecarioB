'use strict';

const { spawnSync, execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { constants, platform, arch } = require('node:os');
const { resolve } = require('node:path');
const COVERAGE = require('./s4-quality-coverage.json');

const PENDING = Object.freeze([
  'Approved numerical video duration limit and trusted measurement rule (B01/B02)',
  'Order-bound technician upload contract and implementation (B07 Phase B)',
  'Order-specific frontend gallery and integrated acceptance (N7.23; backend S4-GAP-01A alone does not close it)',
  'Reserved quote/document/privacy 36-month retention clocks (B01/B05)',
  'Frontend browser reception + video + photos E2E on matching final SHAs',
  'Live R2 privacy, identities, PUT/HEAD/GET/LIST, expiry and browser CORS',
  'Staging-validated immutable v1 recovery digest and deployment evidence (B02)',
  'B06 production activation, late-hold/recovery policy and safe hold command',
  'B08 deployed canary, credentials, load limits and production alert routing',
]);
// Independent baseline: changing the JSON must never reduce B09 below the
// reviewed 725 tests. Higher observed counts remain configurable in the JSON.
const npm = name => {
  const evidence = COVERAGE[name];
  if (name === 'test:media:api:ci' && (evidence?.kind !== 'tap'
    || evidence.floors?.length !== 1 || !Number.isSafeInteger(evidence.floors[0]) || evidence.floors[0] < 725))
    throw Error('MEDIA_API_COVERAGE_FLOOR_INVALID');
  return { command: 'npm', args: ['run', name], evidence };
};
const node = (...args) => ({ command: process.execPath, args });
function plan(mediaOnly = false) {
  const media = ['r2-network', 'r2-transport', 'reconciliation', 'reconciliation-r2'];
  if (mediaOnly) media.push('r2-presign', 'content', 'r2-integrity', 'idempotency');
  return [
    ...(!mediaOnly ? ['security:secret-scan', 'typecheck', 'lint', 'build', 'test'].map(npm) : []),
    ... (mediaOnly ? [npm('build')] : []),
    { ...node('--test', ...media.map(name => `tests/media/${name}.test.cjs`),
      'tests/media-harness/assignment-mutations.test.cjs', 'tests/media-harness/quality-gate.test.cjs'),
      evidence: { kind: 'tap', floors: [mediaOnly ? 224 : 143, 59] } },
    ...(!mediaOnly ? ['test:db:sprint0:ci', 'test:authz:db:ci', 'test:tenant-context:db:ci',
      'test:api:multitenant:ci', 'test:tenant-context:api:ci', 'test:api:security:ci',
      'test:cross-tenant:final:ci', 'test:reception:db:ci', 'test:reception:upgrade:ci',
      'test:reception:api:ci', 'test:runtime:db:ci', 'test:db:migration-lock:ci'].map(npm) : []),
    npm('test:media:api:ci'), npm('test:media:upgrade:ci'),
    ...(!mediaOnly ? [npm('test:media:assigned:mutations:ci'),
      // The historical npm aggregate ends in an optional .env loader. Invoke
      // the same existing runners directly so this gate stays credential-free.
      ...['reception', 'signature-api', 'close-api', 'reception-queries', 'reception-contract', 'inspection']
        .map(name => ({ ...node(`scripts/test-${name}-mutations.cjs`), evidence: COVERAGE[`mutation:${name}`] }))] : []),
  ];
}
// A whitelist excludes ALL npm configuration, providers, preloads, filters and
// mutation selectors. npm is never used to execute children: project/user/global
// .npmrc and alternate npm scripts therefore cannot influence the plan.
function childEnvironment(source) {
  const result = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT',
    'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'DATABASE_URL']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.NODE_OPTIONS = '--test-reporter=tap';
  return result;
}
function validateEvidence(step, result) {
  const contract = step.evidence;
  if (!contract) throw Error('MISSING_EVIDENCE_CONTRACT');
  if (contract.kind === 'exit') return { kind: 'exit' };
  const output = result.stdout;
  if (typeof output !== 'string') throw Error('MISSING_TEST_OUTPUT');
  if (contract.kind === 'markers') {
    for (const marker of contract.lines) {
      if (output.split(/\r?\n/u).filter(line => line === marker).length !== contract.lines.filter(line => line === marker).length)
        throw Error('INVALID_RUNNER_EVIDENCE');
    }
    return { kind: 'markers', validatedMarkers: contract.lines.length };
  }
  if (contract.kind !== 'tap') throw Error('UNKNOWN_EVIDENCE_CONTRACT');
  // Only top-level Node TAP summaries are accepted. Spec/custom reporters fail
  // closed here; custom migration/mutation runners have separate strict contracts.
  if (/^ℹ (?:tests|pass|fail) /mu.test(output)) throw Error('UNCONTROLLED_REPORTER');
  const fields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summaries = fields.map(field => [...output.matchAll(new RegExp(`^# ${field} (\\d+)\\r?$`, 'gmu'))].map(m => Number(m[1])));
  const blocks = [...output.matchAll(/^# tests \d+\r?\n# suites \d+\r?\n# pass \d+\r?\n# fail \d+\r?\n# cancelled \d+\r?\n# skipped \d+\r?\n# todo \d+\r?$/gmu)];
  if (blocks.length !== contract.floors.length) throw Error('MALFORMED_TEST_SUMMARY');
  if (summaries.some(values => values.length !== contract.floors.length)) throw Error('AMBIGUOUS_TEST_SUMMARY');
  const counts = contract.floors.map((floor, index) => {
    const row = Object.fromEntries(fields.map((field, i) => [field, summaries[i][index]]));
    if (!Object.values(row).every(Number.isSafeInteger) || row.tests < floor || row.pass !== row.tests
      || row.fail || row.cancelled || row.skipped || row.todo) throw Error('INSUFFICIENT_TEST_COVERAGE');
    return { ...row, floor };
  });
  return { kind: 'tap', counts };
}
function assertFreshCluster(snapshot) {
  if (snapshot.version < 180000 || snapshot.version >= 190000) throw Error('POSTGRESQL_18_REQUIRED');
  if (snapshot.database !== 'postgres' || snapshot.user !== 'postgres' || !snapshot.superuser
    || snapshot.roles.some(name => name !== 'postgres' && !name.startsWith('pg_'))
    || snapshot.userObjects !== 0 || snapshot.databases.length !== 3
    || !['postgres', 'template0', 'template1'].every(name => snapshot.databases.includes(name)))
    throw Error('DISPOSABLE_CLUSTER_NOT_FRESH');
  return { version: snapshot.version, databaseCount: snapshot.databases.length, roleCount: snapshot.roles.length };
}
function localDatabaseUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw Error('LOCAL_DATABASE_REQUIRED'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash)
    throw Error('LOCAL_DATABASE_REQUIRED');
  // postgres.js otherwise falls back to ambient PGPORT/PGUSER/PGDATABASE.
  // Preflight and sanitized children must address the SAME explicit endpoint.
  if (!url.port) url.port = '5432';
  if (!url.username) url.username = 'postgres';
  if (!url.pathname || url.pathname === '/') url.pathname = '/postgres';
  return url;
}
async function preflight(sql) {
  const [row] = await sql`SELECT pg_catalog.current_setting('server_version_num')::int AS version,
    pg_catalog.current_database() AS database, current_user AS "user",
    (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS superuser,
    (SELECT array_agg(rolname::text ORDER BY rolname) FROM pg_catalog.pg_roles) AS roles,
    (SELECT array_agg(datname::text ORDER BY datname) FROM pg_catalog.pg_database) AS databases,
    ((SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
     + (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
     + (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
     + (SELECT count(*) FROM pg_catalog.pg_namespace n
      WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('public','information_schema')))::int AS "userObjects"`;
  return assertFreshCluster(row);
}
// This fixed map intentionally does not read scripts from package.json or npmrc.
const ENTRYPOINTS = {
  'security:secret-scan': ['scripts/secret-scan.cjs'],
  typecheck: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  build: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
  lint: ['node_modules/@biomejs/biome/bin/biome', 'lint', 'src', 'tests', 'scripts',
    'drizzle.config.ts', 'tsconfig.json', 'tsconfig.build.json', 'package.json'],
  ...Object.fromEntries(Object.entries({
    'test:db:sprint0:ci': 'cross-row', 'test:authz:db:ci': 'authz-db',
    'test:tenant-context:db:ci': 'tenant-context-db', 'test:api:multitenant:ci': 'api-multitenant',
    'test:tenant-context:api:ci': 'tenant-context-api', 'test:api:security:ci': 'api-security',
    'test:cross-tenant:final:ci': 'cross-tenant-final', 'test:reception:db:ci': 'reception-db',
    'test:reception:upgrade:ci': 'reception-migration-upgrade', 'test:reception:api:ci': 'reception-api',
    'test:runtime:db:ci': 'runtime-database', 'test:db:migration-lock:ci': 'migration-lock',
    'test:media:api:ci': 'media-integrity-api', 'test:media:upgrade:ci': 'media-integrity-upgrade',
    'test:media:assigned:mutations:ci': 'media-assignment-mutations',
  }).map(([name, script]) => [name, [`scripts/test-${script}.cjs`]])),
};
function executeStep(step, env, options = {}) {
  const lists = step.command !== 'npm' ? (step.args.includes('tests/media-harness/quality-gate.test.cjs')
    ? [step.args.filter(a => a !== 'tests/media-harness/quality-gate.test.cjs'), ['--test', 'tests/media-harness/quality-gate.test.cjs']] : [step.args]) : step.args[1] === 'test' ? [
    ['scripts/test-authz.cjs'], ['scripts/test-tenant-context-core.cjs'], ['scripts/test-wompi.cjs'],
    ['--test', 'tests/media/r2-presign.test.cjs'],
    ['--test', 'tests/media/content.test.cjs', 'tests/media/r2-integrity.test.cjs', 'tests/media/idempotency.test.cjs'],
  ] : [ENTRYPOINTS[step.args[1]]];
  let stdout = '', stderr = '';
  for (const args of lists) {
    if (!args) return { status: 1, error: { code: 'UNKNOWN_GATE_ENTRYPOINT' } };
    const result = spawnSync(process.execPath, args, { env, cwd: options.cwd ?? process.cwd(), encoding: 'utf8', stdio: 'pipe',
      timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
    if (!options.quiet) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
    stdout += result.stdout ?? ''; stderr += result.stderr ?? '';
    if (exitStatus(result)) return { ...result, stdout, stderr };
  }
  return { status: 0, stdout, stderr };
}
function exitStatus(result) {
  if (Number.isInteger(result.status) && result.status !== 0) return result.status;
  if (result.signal) return 128 + (constants.signals[result.signal] ?? 0);
  return result.error || result.status !== 0 ? 1 : 0;
}
function runGate(steps, run, metadata = {}) {
  const report = { version: 1, ...metadata, startedAt: new Date().toISOString(),
    scopeAutomatedGate: 'NOT_RUN', backendAutomatedGate: 'NOT_RUN',
    fullSprint4Gate: 'BLOCKED', productionReadiness: 'NOT_READY', pendingEvidence: PENDING,
    results: [], exitCode: 0 };
  for (const step of steps) {
    const start = Date.now();
    let result;
    try { result = run(step); } catch { result = { status: null, error: { code: 'SPAWN_FAILED' } }; }
    let exitCode = exitStatus(result), evidence, evidenceError;
    if (!exitCode) {
      try { evidence = validateEvidence(step, result); }
      catch (error) { exitCode = 1; evidenceError = error.message; }
    }
    report.results.push({ command: [step.command, ...step.args].join(' '), exitCode,
      evidence, evidenceError, signal: result.signal ?? null, spawnError: result.error?.code ?? null, elapsedMs: Date.now() - start });
    if (exitCode !== 0) { report.exitCode = exitCode; break; }
  }
  report.scopeAutomatedGate = report.exitCode ? 'FAIL' : steps.length ? 'PASS' : 'NOT_RUN';
  report.backendAutomatedGate = report.exitCode ? 'FAIL' : metadata.profile === 'full' && JSON.stringify(steps) === JSON.stringify(plan(false)) ? report.scopeAutomatedGate : 'NOT_RUN';
  if (report.exitCode) report.fullSprint4Gate = 'FAIL';
  report.finishedAt = new Date().toISOString();
  return report;
}
async function main(args = process.argv.slice(2)) {
  let mediaOnly = false, reportPath;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--media-only') mediaOnly = true;
    else if (args[i] === '--report' && args[i + 1]) reportPath = resolve(args[++i]);
    else throw new Error('INVALID_GATE_ARGUMENT');
  }
  if (process.env.S4_GATE_DISPOSABLE_DATABASE !== '1') throw new Error('DISPOSABLE_DATABASE_ACK_REQUIRED');
  const url = localDatabaseUrl(process.env.DATABASE_URL);
  const sql = require('postgres')(url.toString(), { max: 1, connect_timeout: 5, onnotice() {} });
  let cluster;
  try { cluster = await preflight(sql); }
  finally { await sql.end({ timeout: 5 }); }
  const version = cluster.version;
  const metadata = { profile: mediaOnly ? 'ci-media' : 'full', sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? 'dirty' : 'clean',
    node: process.version, platform: platform(), arch: arch(), postgresqlVersionNumber: version, storage: 'simulated_only', clusterPreflight: cluster };
  const env = childEnvironment({ ...process.env, DATABASE_URL: url.toString() });
  const report = runGate(plan(mediaOnly), step => {
    process.stdout.write(`S4_B09_RUNNING ${[step.command, ...step.args].join(' ')}\n`);
    return executeStep(step, env);
  }, metadata);
  if (reportPath) {
    try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
    catch {
      process.stderr.write('S4_B09_REPORT_WRITE_FAILED\n');
      process.exitCode = report.exitCode || 1;
      return;
    }
  }
  process.stdout.write(`S4_B09_AUTOMATED_${report.scopeAutomatedGate} profile=${metadata.profile} exit=${report.exitCode}\n`);
  process.stdout.write('S4_B09_FULL_SPRINT_' + report.fullSprint4Gate + '; PRODUCTION_NOT_READY\n');
  for (const item of PENDING) process.stdout.write(`S4_B09_PENDING ${item}\n`);
  process.exitCode = report.exitCode;
}
if (require.main === module) main().catch(error => {
  const safe = ['INVALID_GATE_ARGUMENT', 'DISPOSABLE_DATABASE_ACK_REQUIRED', 'LOCAL_DATABASE_REQUIRED', 'POSTGRESQL_18_REQUIRED', 'DISPOSABLE_CLUSTER_NOT_FRESH'];
  process.stderr.write((safe.includes(error.message) ? error.message : 'S4_B09_STARTUP_FAILED') + '\n');
  process.exitCode = 1;
});
module.exports = { PENDING, plan, childEnvironment, exitStatus, runGate, validateEvidence, assertFreshCluster, preflight, executeStep, localDatabaseUrl };
