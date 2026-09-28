'use strict';

// Sprint 0 / S2-08: local staging deploy drill. Builds the ADR-007 image, brings up
// an isolated docker-compose stack (own Postgres, own network, no shared
// state with the dev DB or any other run), runs migrations through the
// concurrency-safe lock in scripts/migrate.cjs, provisions a real
// NOBYPASSRLS runtime login, deploys the API, smoke-tests it, then
// simulates a bad deploy and proves rollback recovers service. Everything
// is torn down (containers, network, images, temp files) in `finally`.

const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const postgres = require('postgres');
const { migrationState, seedTwoTenants, runCrmE2e, readDataSnapshot,
  assertLogPrivacy, completionEvents, assertExactCrmAudit } = require('./staging-crm-e2e.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker-compose.staging.yml');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function compose(project, envFile, args, options) {
  return run('docker', ['compose', '-f', COMPOSE_FILE, '-p', project, '--env-file', envFile, ...args], options);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`TIMED_OUT_WAITING_FOR_${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), ...options });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  const report = {
    build: 'FAIL',
    staging_deploy: 'FAIL',
    migration: 'FAIL',
    migrations: 'FAIL',
    migration_ledger: 'FAIL',
    migration_idempotency: 'FAIL',
    health_live: 'FAIL',
    health_ready: 'FAIL',
    health_readiness: 'FAIL',
    smoke: 'FAIL',
    crm_e2e: 'FAIL',
    tenant_isolation: 'FAIL',
    ownership_history: 'FAIL',
    audit: 'FAIL',
    log_privacy: 'FAIL',
    bad_config: 'FAIL',
    rollback_recovery: 'FAIL',
    rollback_data_preserved: 'FAIL',
    rollback_redeploy: 'FAIL',
    cleanup: 'FAIL',
  };

  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const project = `tm-staging-${suffix}`;
  const imageGood = `tallermecario-api:${suffix}-good`;
  const imageBad = `tallermecario-api:${suffix}-bad`;
  const envFile = path.join(REPO_ROOT, 'staging.env');
  const badOverrideFile = path.join(os.tmpdir(), `tallermecario-staging-bad-${suffix}.yml`);

  let stackUp = false;
  let envWritten = false;
  let badOverrideWritten = false;
  let imagesBuilt = [];
  let admin;

  try {
    // ---- secrets/variables per environment: generated locally, never
    // committed, never printed ----
    const adminPassword = `adm_${randomUUID()}`;
    const runtimePassword = `rt_${randomUUID()}`;
    const postgresHostPort = await getFreePort();
    const apiHostPort = await getFreePort();
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const frontendHost = 'tallermecario-stage.clerk.accounts.dev';
    const identity = {
      privateKey, issuer: `https://${frontendHost}`,
      authorizedParty: 'http://localhost:5173',
      publishableKey: `pk_test_${Buffer.from(`${frontendHost}$`).toString('base64')}`,
      secretKey: `sk_test_${randomBytes(24).toString('hex')}`,
      webhookSecret: `whsec_${randomBytes(32).toString('base64')}`,
    };
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
      .trim().replace(/\r?\n/gu, '\\n');

    const envContents = [
      `STAGING_POSTGRES_ADMIN_USER=tallermecario_staging_admin`,
      `STAGING_POSTGRES_ADMIN_PASSWORD=${adminPassword}`,
      `STAGING_POSTGRES_DB=tallermecario_staging`,
      `STAGING_POSTGRES_HOST_PORT=${postgresHostPort}`,
      `STAGING_RUNTIME_DB_PASSWORD=${runtimePassword}`,
      `STAGING_API_IMAGE=${imageGood}`,
      `STAGING_API_HOST_PORT=${apiHostPort}`,
      `STAGING_CLERK_JWT_KEY=${publicPem}`,
      `STAGING_CLERK_ISSUER_URL=${identity.issuer}`,
      `STAGING_CLERK_SECRET_KEY=${identity.secretKey}`,
      `STAGING_CLERK_PUBLISHABLE_KEY=${identity.publishableKey}`,
      `STAGING_CLERK_WEBHOOK_SIGNING_SECRET=${identity.webhookSecret}`,
      `STAGING_CLERK_AUTHORIZED_PARTIES=${identity.authorizedParty}`,
      '',
    ].join('\n');
    if (fs.existsSync(envFile)) throw new Error('STAGING_ENV_ALREADY_EXISTS');
    fs.writeFileSync(envFile, envContents, { encoding: 'utf8', mode: 0o600 });
    envWritten = true;
    process.stdout.write(`STAGING_ENV_WRITTEN ${envFile} (not committed; gitignored)\n`);

    // ---- build: the ADR-007 image (deps -> build -> runtime) ----
    imagesBuilt.push(imageGood);
    const build = run('docker', ['build', '-t', imageGood, '.']);
    if (build.status !== 0) throw new Error('DOCKER_BUILD_FAILED');
    process.stdout.write(`BUILD_PASS ${imageGood}\n`);
    report.build = 'PASS';

    // ---- staging deploy: postgres up, migrate, provision, api/worker up ----
    const pgUp = compose(project, envFile, ['up', '-d', 'postgres']);
    if (pgUp.status !== 0) throw new Error('COMPOSE_POSTGRES_UP_FAILED');
    stackUp = true;

    await waitFor(
      async () => {
        const ps = compose(project, envFile, ['ps', '--format', 'json', 'postgres'], { capture: true });
        return ps.stdout.includes('"Health":"healthy"') || ps.stdout.includes('healthy');
      },
      { timeoutMs: 60000, intervalMs: 2000, label: 'POSTGRES_HEALTHY' },
    );
    process.stdout.write('POSTGRES_HEALTHY\n');
    const adminUrl = new URL(`postgresql://127.0.0.1:${postgresHostPort}/tallermecario_staging`);
    adminUrl.username = 'tallermecario_staging_admin';
    adminUrl.password = adminPassword;
    admin = postgres(adminUrl.toString(), { max: 2, prepare: false, onnotice: () => {} });

    // ---- migraciones: through the same concurrency-locked runner used
    // everywhere else in this repo (scripts/migrate.cjs) ----
    const migrate = compose(project, envFile, ['run', '--rm', 'migrate']);
    if (migrate.status !== 0) throw new Error('STAGING_MIGRATION_FAILED');
    process.stdout.write('MIGRATIONS_PASS\n');
    report.migrations = 'PASS';
    report.migration = 'PASS';
    const initialMigrationState = await migrationState(admin);
    report.migration_ledger = 'PASS';
    process.stdout.write('MIGRATION_LEDGER_PASS 19/19; latest 0018; plate check valid; history guard enabled\n');
    const rerun = compose(project, envFile, ['run', '--rm', 'migrate']);
    if (rerun.status !== 0) throw new Error('SECOND_STAGING_MIGRATION_FAILED');
    assert.equal(await migrationState(admin), initialMigrationState,
      'second migration must leave ledger and schema unchanged');
    report.migration_idempotency = 'PASS';
    process.stdout.write('MIGRATION_IDEMPOTENCY_PASS 19/19; schema unchanged\n');

    const provision = compose(project, envFile, ['run', '--rm', 'provision-runtime-login']);
    if (provision.status !== 0) throw new Error('RUNTIME_LOGIN_PROVISION_FAILED');
    process.stdout.write('RUNTIME_LOGIN_PROVISION_PASS\n');

    const apiUp = compose(project, envFile, ['up', '-d', 'api', 'worker']);
    if (apiUp.status !== 0) throw new Error('COMPOSE_API_UP_FAILED');
    report.staging_deploy = 'PASS';

    const baseUrl = `http://127.0.0.1:${apiHostPort}`;
    await waitFor(
      async () => {
        const { status } = await fetchJson(`${baseUrl}/health/live`);
        return status === 200;
      },
      { timeoutMs: 30000, intervalMs: 1000, label: 'API_LIVE' },
    );
    report.health_live = 'PASS';
    const ready = await waitFor(
      async () => {
        const result = await fetchJson(`${baseUrl}/health/ready`);
        return result.status === 200 ? result : null;
      },
      { timeoutMs: 30000, intervalMs: 1000, label: 'API_READY' },
    );
    if (!ready.body?.checks?.database) throw new Error('READY_DID_NOT_REPORT_DATABASE_TRUE');
    process.stdout.write('HEALTH_READINESS_PASS\n');
    report.health_ready = 'PASS';
    report.health_readiness = 'PASS';

    // ---- smoke test post-deploy ----
    const live = await fetchJson(`${baseUrl}/health/live`);
    if (live.status !== 200 || live.body?.status !== 'live') throw new Error('SMOKE_HEALTH_LIVE_FAILED');
    const whoami = await fetchJson(`${baseUrl}/api/v1/__whoami`);
    if (whoami.status !== 401 || whoami.body?.error?.code !== 'AUTHENTICATION_REQUIRED') {
      throw new Error('SMOKE_PROTECTED_ROUTE_DID_NOT_401');
    }
    const nosniff = whoami.headers.get('x-content-type-options');
    if (nosniff !== 'nosniff') throw new Error('SMOKE_SECURITY_HEADERS_MISSING');
    process.stdout.write('SMOKE_PASS (live, protected route 401s, security headers present)\n');
    report.smoke = 'PASS';

    // Real Clerk verification uses the public key inside the API container.
    // The private key and signed sessions remain in this drill process.
    const tenants = await seedTwoTenants(admin);
    // The HTTP response may arrive before Fastify flushes its onResponse log.
    // Use the smoke request ID as a barrier before counting E2E completions.
    const baselineLogs = await waitFor(async () => {
      const logs = compose(project, envFile,
        ['logs', '--no-color', '--no-log-prefix', 'api'], { capture: true });
      if (logs.status !== 0) throw new Error('STAGING_LOG_CAPTURE_FAILED');
      return completionEvents(logs.stdout).some((line) =>
        line.request_id === whoami.body.error.request_id) ? logs : null;
    }, { timeoutMs: 10000, intervalMs: 250, label: 'SMOKE_COMPLETION_LOG' });
    const baselineCompletions = assertLogPrivacy(baselineLogs.stdout, [], 0);
    const e2e = await runCrmE2e(admin, baseUrl, identity, tenants, fetch,
      { auditMutant: process.env.S208_STAGING_AUDIT_MUTANT });
    report.crm_e2e = 'PASS';
    report.tenant_isolation = 'PASS';
    report.ownership_history = 'PASS';
    process.stdout.write(`CRM_E2E_PASS ${e2e.requestCount} deployed HTTP requests; two tenants; ownership microseconds and vehicle row unchanged\n`);
    const apiLogs = compose(project, envFile,
      ['logs', '--no-color', '--no-log-prefix', 'api'], { capture: true });
    if (apiLogs.status !== 0) throw new Error('STAGING_LOG_CAPTURE_FAILED');
    const completionCount = assertLogPrivacy(apiLogs.stdout, e2e.sentinels,
      baselineCompletions + e2e.requestCount, e2e.errors);
    assert.equal(completionCount - baselineCompletions, e2e.requestCount,
      'exactly one completion per E2E HTTP request');
    const auditTotals = await assertExactCrmAudit(admin, tenants, e2e,
      completionEvents(apiLogs.stdout).slice(baselineCompletions));
    report.audit = 'PASS';
    process.stdout.write(`AUDIT_EXACT_PASS A=${auditTotals.tenantA} B=${auditTotals.tenantB} total=${auditTotals.total}\n`);
    report.log_privacy = 'PASS';
    process.stdout.write(`STAGING_LOG_PRIVACY_PASS ${e2e.requestCount} completion events; closed field contract\n`);

    // ---- rollback/redeploy: deploy a broken config, prove it's detected
    // and rolled back to the known-good one ----
    const badOverride = [
      'services:',
      '  api:',
      `    image: ${imageBad}`,
      '    environment:',
      "      DATABASE_URL: postgresql://tallermecario_staging_runtime:wrong-password@postgres:5432/tallermecario_staging",
      '',
    ].join('\n');
    fs.writeFileSync(badOverrideFile, badOverride, 'utf8');
    badOverrideWritten = true;
    const tagBad = run('docker', ['tag', imageGood, imageBad]);
    if (tagBad.status !== 0) throw new Error('DOCKER_TAG_BAD_FAILED');
    imagesBuilt.push(imageBad);

    const badDeploy = run('docker', [
      'compose', '-f', COMPOSE_FILE, '-f', badOverrideFile, '-p', project, '--env-file', envFile,
      'up', '-d', 'api',
    ]);
    if (badDeploy.status !== 0) throw new Error('BAD_DEPLOY_COMMAND_FAILED');

    let badDeployDetected = false;
    try {
      await waitFor(
        async () => {
          const result = await fetchJson(`${baseUrl}/health/ready`).catch(() => ({ status: 0 }));
          return result.status === 503 && result.body?.checks?.database === false
            && result.body?.status === 'not_ready' ? result : null;
        },
        { timeoutMs: 20000, intervalMs: 1000, label: 'BAD_DEPLOY_UNREADY' },
      );
      badDeployDetected = true;
    } catch {
      badDeployDetected = false;
    }
    if (!badDeployDetected) throw new Error('BAD_DEPLOY_WAS_NOT_DETECTED_AS_UNREADY');
    const badLive = await fetchJson(`${baseUrl}/health/live`);
    if (badLive.status !== 200 || badLive.body?.status !== 'live')
      throw new Error('BAD_DEPLOY_LIVENESS_FAILED');
    process.stdout.write('BAD_DEPLOY_CORRECTLY_DETECTED_AS_NOT_READY (database=false; live=200)\n');
    report.bad_config = 'PASS';

    const rollback = compose(project, envFile, ['up', '-d', 'api']);
    if (rollback.status !== 0) throw new Error('ROLLBACK_REDEPLOY_COMMAND_FAILED');
    const recovered = await waitFor(
      async () => {
        const result = await fetchJson(`${baseUrl}/health/ready`);
        return result.status === 200 ? result : null;
      },
      { timeoutMs: 30000, intervalMs: 1000, label: 'ROLLBACK_RECOVERY' },
    );
    if (!recovered.body?.checks?.database) throw new Error('ROLLBACK_DID_NOT_RESTORE_READY_STATE');
    report.rollback_recovery = 'PASS';
    const restoredHistory = await fetchJson(`${baseUrl}${e2e.ownerRoute}`, {
      headers: { authorization: `Bearer ${e2e.recoveryToken}`,
        'x-tenant-id': tenants.a.tenantId },
    });
    assert.equal(restoredHistory.status, 200, 'history available after recovery');
    assert.deepEqual(restoredHistory.body?.owners, e2e.history,
      'ownership history unchanged after bad config and recovery');
    assert.equal(await readDataSnapshot(admin, e2e.vehicleId,
      tenants.a.tenantId, tenants.b.tenantId), e2e.snapshot,
    'CRM ownership, tenant counts and audit rows unchanged');
    assert.equal(await migrationState(admin), initialMigrationState,
      'migration ledger and schema unchanged after recovery');
    report.rollback_data_preserved = 'PASS';
    process.stdout.write('ROLLBACK_REDEPLOY_PASS (bad deploy detected and rolled back to known-good)\n');
    report.rollback_redeploy = 'PASS';
  } finally {
    let cleanupOk = true;
    if (admin) {
      try { await admin.end({ timeout: 5 }); } catch { cleanupOk = false; }
    }
    if (stackUp) {
      try {
        const down = run('docker', ['compose', '-f', COMPOSE_FILE, '-p', project,
          '--env-file', envFile, 'down', '-v', '--remove-orphans'],
        { timeout: 60000, capture: true });
        if (down.status !== 0) cleanupOk = false;
      } catch { cleanupOk = false; }
    }
    for (const image of imagesBuilt) {
      try {
        const inspect = run('docker', ['image', 'inspect', image], { capture: true });
        if (inspect.status === 0 && run('docker', ['image', 'rm', '-f', image],
          { timeout: 30000, capture: true }).status !== 0) cleanupOk = false;
        if (run('docker', ['image', 'inspect', image], { capture: true }).status === 0)
          cleanupOk = false;
      } catch { cleanupOk = false; }
    }
    if (envWritten && fs.existsSync(envFile)) fs.rmSync(envFile, { force: true });
    if (badOverrideWritten && fs.existsSync(badOverrideFile)) fs.rmSync(badOverrideFile, { force: true });
    if (envWritten && fs.existsSync(envFile)) cleanupOk = false;
    if (badOverrideWritten && fs.existsSync(badOverrideFile)) cleanupOk = false;
    if (stackUp) {
      try {
        for (const args of [
          ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
          ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
          ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
        ]) {
          const residue = run('docker', args, { capture: true });
          if (residue.status !== 0 || residue.stdout.trim() !== '') cleanupOk = false;
        }
      } catch { cleanupOk = false; }
    }
    if (cleanupOk) report.cleanup = 'PASS';

    process.stdout.write(`\nSTAGING_DRILL_REPORT ${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = Object.entries(report).map(([key, value]) => `| ${key} | ${value} |`).join('\n');
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `\n## S2-08 staging deploy drill\n\n| Gate | Result |\n| --- | --- |\n${rows}\n`, 'utf8');
    }
  }

  const allPass = Object.values(report).every((value) => value === 'PASS');
  if (!allPass) throw new Error('STAGING_DEPLOY_DRILL_FAILED');
  process.stdout.write('STAGING_DEPLOY_DRILL_PASS\n');
}

main().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
