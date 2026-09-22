'use strict';

// Sprint 0: local "staging" deploy drill (no real cloud staging account is
// configured for this project -- see AskUserQuestion answer this task: this
// IS the staging environment for now). Builds the ADR-007 image, brings up
// an isolated docker-compose stack (own Postgres, own network, no shared
// state with the dev DB or any other run), runs migrations through the
// concurrency-safe lock in scripts/migrate.cjs, provisions a real
// NOBYPASSRLS runtime login, deploys the API, smoke-tests it, then
// simulates a bad deploy and proves rollback recovers service. Everything
// is torn down (containers, network, images, temp files) in `finally`.

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

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

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  const report = {
    build: 'FAIL',
    staging_deploy: 'FAIL',
    migrations: 'FAIL',
    health_readiness: 'FAIL',
    smoke: 'FAIL',
    rollback_redeploy: 'FAIL',
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

  try {
    // ---- secrets/variables per environment: generated locally, never
    // committed, never printed ----
    const adminPassword = `adm_${randomUUID()}`;
    const runtimePassword = `rt_${randomUUID()}`;
    const postgresHostPort = await getFreePort();
    const apiHostPort = await getFreePort();

    const envContents = [
      `STAGING_POSTGRES_ADMIN_USER=tallermecario_staging_admin`,
      `STAGING_POSTGRES_ADMIN_PASSWORD=${adminPassword}`,
      `STAGING_POSTGRES_DB=tallermecario_staging`,
      `STAGING_POSTGRES_HOST_PORT=${postgresHostPort}`,
      `STAGING_RUNTIME_DB_PASSWORD=${runtimePassword}`,
      `STAGING_API_IMAGE=${imageGood}`,
      `STAGING_API_HOST_PORT=${apiHostPort}`,
      '',
    ].join('\n');
    fs.writeFileSync(envFile, envContents, { encoding: 'utf8', mode: 0o600 });
    envWritten = true;
    process.stdout.write(`STAGING_ENV_WRITTEN ${envFile} (not committed; gitignored)\n`);

    // ---- build: the ADR-007 image (deps -> build -> runtime) ----
    const build = run('docker', ['build', '-t', imageGood, '.']);
    if (build.status !== 0) throw new Error('DOCKER_BUILD_FAILED');
    imagesBuilt.push(imageGood);
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

    // ---- migraciones: through the same concurrency-locked runner used
    // everywhere else in this repo (scripts/migrate.cjs) ----
    const migrate = compose(project, envFile, ['run', '--rm', 'migrate']);
    if (migrate.status !== 0) throw new Error('STAGING_MIGRATION_FAILED');
    process.stdout.write('MIGRATIONS_PASS\n');
    report.migrations = 'PASS';

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
    const ready = await waitFor(
      async () => {
        const result = await fetchJson(`${baseUrl}/health/ready`);
        return result.status === 200 ? result : null;
      },
      { timeoutMs: 30000, intervalMs: 1000, label: 'API_READY' },
    );
    if (!ready.body?.checks?.database) throw new Error('READY_DID_NOT_REPORT_DATABASE_TRUE');
    process.stdout.write('HEALTH_READINESS_PASS\n');
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
          return result.status === 503 ? result : null;
        },
        { timeoutMs: 20000, intervalMs: 1000, label: 'BAD_DEPLOY_UNREADY' },
      );
      badDeployDetected = true;
    } catch {
      badDeployDetected = false;
    }
    if (!badDeployDetected) throw new Error('BAD_DEPLOY_WAS_NOT_DETECTED_AS_UNREADY');
    process.stdout.write('BAD_DEPLOY_CORRECTLY_DETECTED_AS_NOT_READY\n');

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
    process.stdout.write('ROLLBACK_REDEPLOY_PASS (bad deploy detected and rolled back to known-good)\n');
    report.rollback_redeploy = 'PASS';
  } finally {
    if (stackUp) {
      run('docker', ['compose', '-f', COMPOSE_FILE, '-p', project, '--env-file', envFile, 'down', '-v', '--remove-orphans'], { timeout: 60000 }).status;
    }
    for (const image of imagesBuilt) {
      run('docker', ['image', 'rm', '-f', image], { timeout: 30000 });
    }
    if (envWritten && fs.existsSync(envFile)) fs.rmSync(envFile, { force: true });
    if (badOverrideWritten && fs.existsSync(badOverrideFile)) fs.rmSync(badOverrideFile, { force: true });

    process.stdout.write(`\nSTAGING_DRILL_REPORT ${JSON.stringify(report, null, 2)}\n`);
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
