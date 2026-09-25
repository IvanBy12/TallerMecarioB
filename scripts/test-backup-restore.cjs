'use strict';

// Sprint 0: real PostgreSQL 18 backup/restore drill (Operación, Retención,
// Recuperación y Observabilidad v1 §3). Uses the pg_dump/pg_restore binaries
// installed alongside the server configured in .env -- never staging/prod
// (asserted local-only, same guard as every other scripts/test-*.cjs).
//
// Flow: create a throwaway SOURCE database -> migrate it -> write controlled
// fixture data -> pg_dump it to %TEMP%\tallermecario-backups -> create a
// throwaway TARGET database -> pg_restore into it -> validate schema,
// row-level data, FKs, RLS, append-only grants and cross-tenant isolation
// against the RESTORED database -> delete both databases, the throwaway
// login and the dump file/directory, regardless of outcome.
//
// This exercises pg_dump/pg_restore as documented at
// https://www.postgresql.org/docs/18/backup.html. It does NOT stand up
// continuous WAL archiving/PITR (that is server/infra provisioning, not an
// application-repo script) -- see the RPO/RTO note in the final report.

const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const postgres = require('postgres');
const { expectedMigrationCount } = require('./migration-count.cjs');

const CANONICAL_ROLES = [
  'tallermecario_schema_owner',
  'tallermecario_migrator',
  'tallermecario_api',
  'tallermecario_worker',
  'tallermecario_bootstrap_resolver',
];

const APPEND_ONLY_TABLES = [
  'order_status_history',
  'quote_authorizations',
  'quote_authorization_items',
  'inventory_movements',
  'billing_events',
  'audit_logs',
];

function databaseUrlFromEnvironment() {
  if (process.env.DATABASE_URL) return new URL(process.env.DATABASE_URL);

  const candidates = [
    ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'],
    ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'],
    ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'],
  ];
  for (const [hostKey, portKey, databaseKey, userKey, passwordKey] of candidates) {
    if (process.env[hostKey] && process.env[databaseKey] && process.env[userKey]) {
      const url = new URL('postgresql://localhost');
      url.hostname = process.env[hostKey];
      url.port = process.env[portKey] || '5432';
      url.pathname = `/${encodeURIComponent(process.env[databaseKey])}`;
      url.username = process.env[userKey];
      url.password = process.env[passwordKey] || '';
      return url;
    }
  }
  throw new Error('DATABASE_CONFIGURATION_REQUIRED');
}

function assertLocal(url) {
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('REFUSING_NON_LOCAL_DATABASE');
  }
}

function runChild(command, args, env) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: 'pipe', timeout: 60000 });
  if (result.error) throw result.error;
  return result;
}

function resolvePgBinary(name) {
  const override = process.env[`PG_${name.toUpperCase()}_PATH`];
  if (override) return override;

  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const probe = spawnSync(exe, ['--version'], { stdio: 'pipe' });
  if (!probe.error) return exe;

  const candidateDirs = [
    'O:\\postgresql\\bin',
    'C:\\Program Files\\PostgreSQL\\18\\bin',
    'C:\\Program Files\\PostgreSQL\\17\\bin',
    '/usr/lib/postgresql/18/bin',
    '/usr/bin',
  ];
  for (const dir of candidateDirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`PG_BINARY_NOT_FOUND_${name}`);
}

function toPgUrl(url) {
  return url.toString();
}

async function main() {
  const report = {
    backup: 'FAIL',
    restore: 'FAIL',
    integrity: 'FAIL',
    rls: 'FAIL',
    cleanup: 'FAIL',
    timings: {},
  };

  const sourceUrl = databaseUrlFromEnvironment();
  assertLocal(sourceUrl);

  const pgDump = resolvePgBinary('pg_dump');
  const pgRestore = resolvePgBinary('pg_restore');

  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const sourceDbName = `tallermecario_backup_src_${suffix}`;
  const targetDbName = `tallermecario_backup_restore_${suffix}`;
  const loginRole = `tm_backup_e2e_${suffix}`;
  const loginPassword = `rt_${randomUUID()}`;

  const backupDir = path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), 'tallermecario-backups');
  const dumpFile = path.join(backupDir, `tallermecario-drill-${suffix}.dump`);

  const maintenance = postgres(sourceUrl.toString(), { max: 1, prepare: false, onnotice: () => {} });
  let sourceAdmin;
  let targetAdmin;
  let sourceCreated = false;
  let targetCreated = false;
  let loginCreated = false;
  let dumpWritten = false;
  let backupDirCreated = false;
  let originalRoles = new Set();

  const fixture = {
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    locationA: randomUUID(),
    locationB: randomUUID(),
    userA: randomUUID(),
    userB: randomUUID(),
    membershipA: randomUUID(),
    membershipB: randomUUID(),
    subjectA: `subject-a-${randomUUID()}`,
    subjectB: `subject-b-${randomUUID()}`,
    customerA: randomUUID(),
    customerB: randomUUID(),
    vehicleA: randomUUID(),
    receptionA: randomUUID(),
    orderA: randomUUID(),
    paymentA: randomUUID(),
    outboxA: randomUUID(),
    auditA: randomUUID(),
  };

  const sourceCounts = {};
  const sourceStats = {};

  try {
    const [server] = await maintenance`SELECT pg_catalog.current_database() AS database`;
    if (!server) throw new Error('DATABASE_CONNECTION_FAILED');
    process.stdout.write('DB_ENV_CONNECTED\n');
    const [serverVersionRow] = await maintenance`SHOW server_version`;
    process.stdout.write(`SERVER_VERSION ${serverVersionRow.server_version}\n`);

    const existingRoles = await maintenance`
      SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY(${CANONICAL_ROLES})
    `;
    originalRoles = new Set(existingRoles.map((row) => row.rolname));

    // ---- 1. SOURCE: fresh db, migrated, with controlled fixture data ----
    const sourceUrlForDb = new URL(sourceUrl.toString());
    sourceUrlForDb.pathname = `/${sourceDbName}`;
    await maintenance.unsafe(`CREATE DATABASE ${sourceDbName}`);
    sourceCreated = true;
    sourceAdmin = postgres(sourceUrlForDb.toString(), { max: 2, prepare: false, onnotice: () => {} });

    const migrateResult = runChild(process.execPath, ['scripts/migrate.cjs'], {
      ...process.env,
      DATABASE_URL: sourceUrlForDb.toString(),
    });
    if (migrateResult.status !== 0) {
      process.stderr.write(migrateResult.stdout?.toString() ?? '');
      process.stderr.write(migrateResult.stderr?.toString() ?? '');
      throw new Error('SOURCE_MIGRATION_FAILED');
    }
    const [migrationState] = await sourceAdmin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    if (migrationState.count !== expectedMigrationCount()) throw new Error('CLEAN_MIGRATION_INVALID');
    process.stdout.write('CLEAN_MIGRATION_PASS\n');

    let lastWriteAt;
    await sourceAdmin.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO workshops ${tx([
        { id: fixture.tenantA, slug: `a-${fixture.tenantA}`, legal_name: 'Backup Drill Tenant A', display_name: 'Tenant A' },
        { id: fixture.tenantB, slug: `b-${fixture.tenantB}`, legal_name: 'Backup Drill Tenant B', display_name: 'Tenant B' },
      ])}`;
      await tx`INSERT INTO workshop_locations ${tx([
        { id: fixture.locationA, tenant_id: fixture.tenantA, name: 'HQ A', address_line: 'Cra 1', city: 'Bogota', department: 'Bogota', is_primary: true },
        { id: fixture.locationB, tenant_id: fixture.tenantB, name: 'HQ B', address_line: 'Cra 2', city: 'Bogota', department: 'Bogota', is_primary: true },
      ])}`;
      await tx`INSERT INTO users ${tx([
        { id: fixture.userA, external_subject: fixture.subjectA, email: `${fixture.userA}@backup-drill.invalid` },
        { id: fixture.userB, external_subject: fixture.subjectB, email: `${fixture.userB}@backup-drill.invalid` },
      ])}`;
      await tx`INSERT INTO memberships ${tx([
        { id: fixture.membershipA, tenant_id: fixture.tenantA, user_id: fixture.userA },
        { id: fixture.membershipB, tenant_id: fixture.tenantB, user_id: fixture.userB },
      ])}`;
      await tx`INSERT INTO customers ${tx([
        { id: fixture.customerA, tenant_id: fixture.tenantA, first_name: 'Carlos', last_name: 'Tenant-A', phone: '3000000001' },
        { id: fixture.customerB, tenant_id: fixture.tenantB, first_name: 'Beatriz', last_name: 'Tenant-B', phone: '3000000002' },
      ])}`;
      await tx`INSERT INTO vehicles ${tx({ id: fixture.vehicleA, tenant_id: fixture.tenantA, plate: `BKP${fixture.vehicleA.slice(0, 5).toUpperCase()}`, vehicle_type: 'car', brand: 'Mazda', model: '3' })}`;
      await tx`INSERT INTO receptions ${tx({ id: fixture.receptionA, tenant_id: fixture.tenantA, vehicle_id: fixture.vehicleA, customer_id: fixture.customerA, received_by_membership_id: fixture.membershipA, mileage_km: 42000 })}`;
      await tx`INSERT INTO service_orders ${tx({ id: fixture.orderA, tenant_id: fixture.tenantA, reception_id: fixture.receptionA, vehicle_id: fixture.vehicleA, customer_id: fixture.customerA, order_number: 900001, created_by_membership_id: fixture.membershipA })}`;
      await tx`
        INSERT INTO customer_payments (
          id, tenant_id, customer_id, payment_method, status, amount, currency,
          confirmed_at, confirmed_by_membership_id, recorded_by_membership_id
        ) VALUES (
          ${fixture.paymentA}, ${fixture.tenantA}, ${fixture.customerA}, 'cash', 'confirmed', 250000, 'COP',
          now(), ${fixture.membershipA}, ${fixture.membershipA}
        )
      `;
      await tx`
        INSERT INTO outbox_events (
          id, tenant_id, aggregate_type, aggregate_id, event_type, event_version,
          payload_json, status, attempts, available_at, processed_at
        ) VALUES (
          ${fixture.outboxA}, ${fixture.tenantA}, 'service_order', ${fixture.orderA}, 'order.created', 1,
          ${tx.json({ orderNumber: 900001, drill: 'backup-restore' })}, 'processed', 1, now(), now()
        )
      `;
      await tx`
        INSERT INTO audit_logs (
          id, tenant_id, actor_type, action, outcome, entity_type, entity_id, request_id
        ) VALUES (
          ${fixture.auditA}, ${fixture.tenantA}, 'system', 'backup_restore_drill.fixture_created', 'success',
          'service_order', ${fixture.orderA}, ${`backup-drill-${suffix}`}
        )
      `;
      const [row] = await tx`SELECT now() AS at`;
      lastWriteAt = row.at;
    });
    process.stdout.write(`FIXTURE_COMMITTED ${lastWriteAt.toISOString()}\n`);
    report.timings.last_write_at = lastWriteAt.toISOString();

    for (const table of [
      'workshops', 'workshop_locations', 'users', 'memberships', 'customers', 'vehicles',
      'receptions', 'service_orders', 'customer_payments', 'outbox_events', 'audit_logs',
    ]) {
      const [row] = await sourceAdmin.unsafe(`SELECT count(*)::int AS count FROM public.${table}`);
      sourceCounts[table] = row.count;
    }
    const [fkRow] = await sourceAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `;
    const [policyRow] = await sourceAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_policies WHERE schemaname = 'public'
    `;
    const [rlsRow] = await sourceAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity
    `;
    sourceStats.fkCount = fkRow.count;
    sourceStats.policyCount = policyRow.count;
    sourceStats.rlsEnabledForcedCount = rlsRow.count;
    process.stdout.write(`SOURCE_STATS ${JSON.stringify({ counts: sourceCounts, ...sourceStats })}\n`);

    // ---- 2. BACKUP: pg_dump the source db to %TEMP%\tallermecario-backups ----
    fs.mkdirSync(backupDir, { recursive: true });
    backupDirCreated = true;
    const dumpStartedAt = new Date();
    const dumpArgs = [
      '--format=custom',
      '--file', dumpFile,
      '--host', sourceUrlForDb.hostname,
      '--port', sourceUrlForDb.port || '5432',
      '--username', sourceUrlForDb.username,
      '--dbname', sourceDbName,
      '--no-password',
    ];
    const dumpResult = runChild(pgDump, dumpArgs, { ...process.env, PGPASSWORD: sourceUrlForDb.password });
    const dumpFinishedAt = new Date();
    report.timings.dump_started_at = dumpStartedAt.toISOString();
    report.timings.dump_finished_at = dumpFinishedAt.toISOString();
    report.timings.recovery_point = dumpFinishedAt.toISOString();
    report.timings.observed_rpo_seconds = (dumpFinishedAt.getTime() - new Date(lastWriteAt).getTime()) / 1000;

    if (dumpResult.status !== 0 || !fs.existsSync(dumpFile) || fs.statSync(dumpFile).size === 0) {
      process.stderr.write(dumpResult.stdout?.toString() ?? '');
      process.stderr.write(dumpResult.stderr?.toString() ?? '');
      throw new Error('PG_DUMP_FAILED');
    }
    dumpWritten = true;
    report.timings.dump_size_bytes = fs.statSync(dumpFile).size;
    process.stdout.write(`PG_DUMP_PASS ${dumpFile} (${report.timings.dump_size_bytes} bytes)\n`);
    report.backup = 'PASS';

    // ---- 3. RESTORE: fresh empty target db, pg_restore into it ----
    const targetUrlForDb = new URL(sourceUrl.toString());
    targetUrlForDb.pathname = `/${targetDbName}`;
    await maintenance.unsafe(`CREATE DATABASE ${targetDbName}`);
    targetCreated = true;

    const recoveryStartedAt = new Date();
    const restoreArgs = [
      '--format=custom',
      '--host', targetUrlForDb.hostname,
      '--port', targetUrlForDb.port || '5432',
      '--username', targetUrlForDb.username,
      '--dbname', targetDbName,
      '--no-password',
      '--exit-on-error',
      dumpFile,
    ];
    const restoreResult = runChild(pgRestore, restoreArgs, { ...process.env, PGPASSWORD: targetUrlForDb.password });
    if (restoreResult.status !== 0) {
      process.stderr.write(restoreResult.stdout?.toString() ?? '');
      process.stderr.write(restoreResult.stderr?.toString() ?? '');
      throw new Error('PG_RESTORE_FAILED');
    }
    process.stdout.write('PG_RESTORE_PASS\n');
    report.restore = 'PASS';

    targetAdmin = postgres(targetUrlForDb.toString(), { max: 2, prepare: false, onnotice: () => {} });

    // ---- 4. Validate: schema/migrations, row counts, FKs, values ----
    const [restoredMigrationState] = await targetAdmin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    if (restoredMigrationState.count !== migrationState.count) throw new Error('RESTORED_MIGRATION_STATE_MISMATCH');

    const restoredCounts = {};
    for (const table of Object.keys(sourceCounts)) {
      const [row] = await targetAdmin.unsafe(`SELECT count(*)::int AS count FROM public.${table}`);
      restoredCounts[table] = row.count;
      if (row.count !== sourceCounts[table]) {
        throw new Error(`ROW_COUNT_MISMATCH_${table}_source_${sourceCounts[table]}_restored_${row.count}`);
      }
    }
    process.stdout.write(`RESTORED_COUNTS_MATCH ${JSON.stringify(restoredCounts)}\n`);

    const [restoredOrder] = await targetAdmin`
      SELECT order_number::text AS order_number FROM service_orders WHERE id = ${fixture.orderA}
    `;
    const [restoredPayment] = await targetAdmin`
      SELECT amount::text AS amount, status FROM customer_payments WHERE id = ${fixture.paymentA}
    `;
    if (!restoredOrder || restoredOrder.order_number !== '900001') throw new Error('ORDER_SMOKE_VALUE_MISMATCH');
    if (!restoredPayment || restoredPayment.amount !== '250000' || restoredPayment.status !== 'confirmed') {
      throw new Error('PAYMENT_SMOKE_VALUE_MISMATCH');
    }
    process.stdout.write('ORDER_PAYMENT_SMOKE_PASS\n');

    const [restoredFk] = await targetAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `;
    const [restoredPolicy] = await targetAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_policies WHERE schemaname = 'public'
    `;
    const [restoredRls] = await targetAdmin`
      SELECT count(*)::int AS count FROM pg_catalog.pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity
    `;
    if (restoredFk.count !== sourceStats.fkCount) throw new Error('FK_COUNT_MISMATCH_AFTER_RESTORE');
    if (restoredPolicy.count !== sourceStats.policyCount) throw new Error('POLICY_COUNT_MISMATCH_AFTER_RESTORE');
    if (restoredRls.count !== sourceStats.rlsEnabledForcedCount) throw new Error('RLS_ENABLE_FORCE_MISMATCH_AFTER_RESTORE');
    process.stdout.write(`SCHEMA_INTEGRITY_PASS fk=${restoredFk.count} policies=${restoredPolicy.count} rls=${restoredRls.count}\n`);
    report.integrity = 'PASS';

    // Outbox: the fixture event is already 'processed' -- restore must not
    // make it claimable again (Operación v1 §3.4: no redespachar efectos externos).
    const [claimable] = await targetAdmin`
      SELECT count(*)::int AS count FROM public.outbox_events
      WHERE id = ${fixture.outboxA} AND status = 'pending'
    `;
    if (claimable.count !== 0) throw new Error('OUTBOX_EVENT_APPEARS_REDISPATCHABLE');
    const claimed = await targetAdmin`SELECT * FROM app.bootstrap_claim_outbox_events(50)`;
    if (claimed.some((row) => row.outbox_event_id === fixture.outboxA)) {
      throw new Error('OUTBOX_EVENT_WAS_RECLAIMED_AFTER_RESTORE');
    }
    process.stdout.write('OUTBOX_NO_REDISPATCH_PASS\n');

    // ---- 5. RLS + append-only, exercised for real against the restored db ----
    await targetAdmin.unsafe(
      `CREATE ROLE ${loginRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`,
    );
    loginCreated = true;
    await targetAdmin.unsafe(`GRANT tallermecario_api TO ${loginRole}`);

    const runtimeUrl = new URL(targetUrlForDb.toString());
    runtimeUrl.username = loginRole;
    runtimeUrl.password = loginPassword;
    const runtime = postgres(runtimeUrl.toString(), { max: 2, onnotice: () => {}, connection: { role: 'tallermecario_api' } });

    try {
      // Cross-tenant isolation smoke, for real, on the restored database.
      const asTenantA = await runtime.reserve();
      try {
        await asTenantA.unsafe('BEGIN');
        await asTenantA`SELECT set_config('app.tenant_id', ${fixture.tenantA}, true)`;
        const visible = await asTenantA`SELECT id FROM public.customers`;
        const ids = visible.map((row) => row.id);
        if (!ids.includes(fixture.customerA)) throw new Error('RESTORED_TENANT_A_CANNOT_SEE_OWN_ROW');
        if (ids.includes(fixture.customerB)) throw new Error('RESTORED_CROSS_TENANT_LEAK_A_SEES_B');
        await asTenantA.unsafe('COMMIT');
      } finally {
        asTenantA.release();
      }

      const asTenantB = await runtime.reserve();
      try {
        await asTenantB.unsafe('BEGIN');
        await asTenantB`SELECT set_config('app.tenant_id', ${fixture.tenantB}, true)`;
        const visible = await asTenantB`SELECT id FROM public.customers`;
        const ids = visible.map((row) => row.id);
        if (ids.includes(fixture.customerA)) throw new Error('RESTORED_CROSS_TENANT_LEAK_B_SEES_A');
        await asTenantB.unsafe('COMMIT');
      } finally {
        asTenantB.release();
      }
      process.stdout.write('RLS_CROSS_TENANT_ISOLATION_PASS\n');

      // Append-only protection must have survived the restore too.
      let appendOnlyDenied = 0;
      for (const table of APPEND_ONLY_TABLES) {
        try {
          // `id = id` needs no column beyond the universal PK, so this is a
          // pure table-level UPDATE-privilege probe (append-only tables are
          // granted SELECT+INSERT only -- no UPDATE grant at all) rather
          // than a column-existence check.
          await runtime.unsafe(`UPDATE public.${table} SET id = id WHERE false`);
          throw new Error(`APPEND_ONLY_UPDATE_NOT_REJECTED_${table}`);
        } catch (error) {
          if (error.code !== '42501') throw error;
          appendOnlyDenied += 1;
        }
      }
      if (appendOnlyDenied !== APPEND_ONLY_TABLES.length) throw new Error('APPEND_ONLY_CHECK_INCOMPLETE');
      process.stdout.write(`APPEND_ONLY_PROTECTION_PASS (${appendOnlyDenied}/${APPEND_ONLY_TABLES.length} tables)\n`);
    } finally {
      await runtime.end({ timeout: 5 }).catch(() => undefined);
    }
    report.rls = 'PASS';

    const restoredAt = new Date();
    report.timings.recovery_started_at = recoveryStartedAt.toISOString();
    report.timings.restored_at = restoredAt.toISOString();
    report.timings.observed_rto_seconds = (restoredAt.getTime() - recoveryStartedAt.getTime()) / 1000;
  } finally {
    if (targetAdmin) await targetAdmin.end({ timeout: 5 }).catch(() => undefined);
    if (sourceAdmin) await sourceAdmin.end({ timeout: 5 }).catch(() => undefined);

    if (loginCreated) {
      await maintenance.unsafe(`DROP ROLE IF EXISTS ${loginRole}`).catch(() => undefined);
    }
    for (const [created, name] of [[sourceCreated, sourceDbName], [targetCreated, targetDbName]]) {
      if (!created) continue;
      await maintenance`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE datname = ${name} AND pid <> pg_catalog.pg_backend_pid()
      `.catch(() => undefined);
      await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    }

    for (const role of [...CANONICAL_ROLES].reverse()) {
      if (!originalRoles.has(role)) {
        await maintenance.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }

    if (dumpWritten && fs.existsSync(dumpFile)) fs.rmSync(dumpFile, { force: true });
    if (backupDirCreated && fs.existsSync(backupDir)) {
      const remainingEntries = fs.readdirSync(backupDir);
      if (remainingEntries.length === 0) fs.rmdirSync(backupDir);
    }

    const [remaining] = await maintenance`
      SELECT
        EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${sourceDbName}) AS source_present,
        EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = ${targetDbName}) AS target_present,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${loginRole}) AS login_present
    `;
    report.cleanup =
      !remaining.source_present && !remaining.target_present && !remaining.login_present && !fs.existsSync(dumpFile)
        ? 'PASS'
        : 'FAIL';

    await maintenance.end({ timeout: 5 });

    process.stdout.write(`\nBACKUP_RESTORE_REPORT ${JSON.stringify(report, null, 2)}\n`);
  }

  if (report.backup !== 'PASS' || report.restore !== 'PASS' || report.integrity !== 'PASS' || report.rls !== 'PASS') {
    throw new Error('BACKUP_RESTORE_DRILL_FAILED');
  }
  if (report.cleanup !== 'PASS') {
    throw new Error('BACKUP_RESTORE_CLEANUP_FAILED');
  }
  process.stdout.write('BACKUP_RESTORE_DRILL_PASS\n');
}

main().catch((error) => {
  const safeMessages = new Set([
    'DATABASE_CONFIGURATION_REQUIRED',
    'REFUSING_NON_LOCAL_DATABASE',
    'DATABASE_CONNECTION_FAILED',
    'BACKUP_RESTORE_DRILL_FAILED',
    'BACKUP_RESTORE_CLEANUP_FAILED',
  ]);
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${safeMessages.has(message) ? message : message}\n`);
  process.exitCode = 1;
});
