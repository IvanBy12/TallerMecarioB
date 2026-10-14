import postgres from 'postgres';
import { loadR2ConfigFromEnv } from '../media/r2.js';
import { createReconciliationStorage } from '../media/reconciliation-r2.js';
import { createReconciliationMetadata, reconcileMedia, type ReconciliationReport } from '../media/reconciliation.js';

/** Reject elevated logins even when the effective role appears restricted. */
export async function assertMediaReconcilerRole(sql: postgres.Sql): Promise<void> {
  const [r] = await sql`SELECT current_user='tallermecario_media_reconciler' AS correct_role,
    EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
      JOIN pg_roles parent ON parent.oid=m.roleid WHERE r.rolname IN (session_user,current_user)
      AND parent.rolname<>'tallermecario_media_reconciler') AS extra_memberships,
    EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped
      AND (has_column_privilege(session_user,c.oid,a.attnum,'SELECT') OR has_column_privilege(current_user,c.oid,a.attnum,'SELECT'))
      AND NOT ((c.relname='media_assets' AND a.attname=ANY(ARRAY['id','tenant_id','storage_provider','bucket','object_key','status','retention_until','legal_hold_until','deletion_requested_at','deleted_at','purged_at']))
        OR (c.relname='upload_sessions' AND a.attname=ANY(ARRAY['tenant_id','media_asset_id','status','expires_at','created_at']))
        OR (c.relname='media_purge_jobs' AND a.attname=ANY(ARRAY['tenant_id','media_asset_id','state','storage_outcome'])))) AS extra_reads,
    EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN (session_user,current_user)
      AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit)) AS elevated,
    EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind IN ('r','p','v','m','S','f')
      AND (pg_has_role(session_user,c.relowner,'MEMBER') OR pg_has_role(current_user,c.relowner,'MEMBER'))) AS owns_relation,
    EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('tallermecario_schema_owner','tallermecario_migrator',
      'tallermecario_api','tallermecario_worker','tallermecario_media_purger','tallermecario_media_lifecycle','tallermecario_media_inventory_owner','tallermecario_bootstrap_resolver','tallermecario_identity_sync')
      AND (pg_has_role(session_user,r.oid,'MEMBER') OR pg_has_role(current_user,r.oid,'MEMBER'))) AS forbidden,
    EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND (has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE') OR has_table_privilege(session_user,c.oid,'DELETE,TRUNCATE,TRIGGER')
        OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,TRIGGER'))) AS mutations,
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND p.prosecdef
      AND p.oid<>'app.media_storage_metadata_exists(text,text[])'::regprocedure
      AND (has_function_privilege(session_user,p.oid,'EXECUTE') OR has_function_privilege(current_user,p.oid,'EXECUTE'))) AS privileged_functions,
    EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE p.oid='app.media_storage_metadata_exists(text,text[])'::regprocedure
      AND owner.rolname='tallermecario_media_inventory_owner' AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
      AND NOT(owner.rolcanlogin OR owner.rolsuper OR owner.rolbypassrls OR owner.rolinherit OR owner.rolcreatedb OR owner.rolcreaterole OR owner.rolreplication)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=owner.oid OR member=owner.oid)
      AND NOT has_schema_privilege(owner.oid,'app','CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        AND c.relnamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)
        AND ((has_column_privilege(owner.oid,c.oid,a.attnum,'SELECT')
          AND NOT(c.oid='public.media_assets'::regclass AND a.attname IN ('storage_provider','bucket','object_key')))
          OR has_column_privilege(owner.oid,c.oid,a.attnum,'INSERT,UPDATE,REFERENCES')
          OR has_table_privilege(owner.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')))
      AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.privilege_type='EXECUTE' AND acl.grantee NOT IN (owner.oid,'tallermecario_media_reconciler'::regrole))) AS probe_owner_valid,
    NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN ('public.media_assets'::regclass,'public.upload_sessions'::regclass,'public.media_purge_jobs'::regclass)
      AND NOT(c.relrowsecurity AND c.relforcerowsecurity)) AS rls`;
  if (!r?.correct_role || r.extra_memberships || r.extra_reads || r.elevated || r.owns_relation || r.forbidden || r.mutations || r.privileged_functions || !r.probe_owner_valid || !r.rls) throw new Error('MEDIA_RECONCILER_ROLE_INVALID');
}
export function assertMediaReconciliationEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MEDIA_RECONCILIATION_ENABLED !== 'true') throw new Error('MEDIA_RECONCILIATION_DISABLED');
}
export function mediaReconciliationExitCode(report: ReconciliationReport): 0 | 2 {
  return report.status !== 'complete' || !report.databaseComplete || !report.inventoryComplete
    || report.databaseRows === 0 || report.tenantsWithRows !== report.tenantsRequested
    || report.alerts.length ? 2 : 0;
}
async function main(): Promise<void> {
  assertMediaReconciliationEnabled();
  const url = process.env.MEDIA_RECONCILIATION_DATABASE_URL, reportKey = process.env.MEDIA_RECONCILIATION_REPORT_KEY;
  if (!url || !reportKey) throw new Error('MEDIA_RECONCILIATION_CONFIGURATION_INVALID');
  const config = loadR2ConfigFromEnv(), storage = createReconciliationStorage(config);
  const database = postgres(url, { max: 2, connect_timeout: 2, connection: { role: 'tallermecario_media_reconciler', default_transaction_read_only: true, statement_timeout: 2000 }, onnotice: () => {} });
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    await assertMediaReconcilerRole(database);
    const setting = (name: string) => process.env[name] === undefined ? undefined : Number(process.env[name]);
    const report = await reconcileMedia(createReconciliationMetadata(database), storage, {
      pageSize: setting('MEDIA_RECONCILIATION_PAGE_SIZE'), maxDatabasePages: setting('MEDIA_RECONCILIATION_MAX_DATABASE_PAGES'),
      maxInventoryPages: setting('MEDIA_RECONCILIATION_MAX_INVENTORY_PAGES'), concurrency: setting('MEDIA_RECONCILIATION_CONCURRENCY'),
      maxDurationMs: setting('MEDIA_RECONCILIATION_MAX_DURATION_MS'),
      tenantIds: (process.env.MEDIA_RECONCILIATION_TENANT_IDS ?? '').split(','), bucket: config.bucket, reportKey, signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = mediaReconciliationExitCode(report);
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await database.end({ timeout: 3 });
  }
}
if (require.main === module) main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const categories: Record<string, string> = {
    MEDIA_RECONCILIATION_DISABLED: 'disabled', MEDIA_RECONCILIATION_CONFIGURATION_INVALID: 'configuration',
    R2_CONFIGURATION_MISSING: 'storage_configuration', MEDIA_RECONCILIATION_STORAGE_FAILED: 'storage_configuration',
    MEDIA_RECONCILER_ROLE_INVALID: 'database_role', MEDIA_RECONCILIATION_SAMPLES_UNACTIONABLE: 'sampling_capacity',
  };
  process.stderr.write(`${JSON.stringify({ event: 'media_reconciliation_startup_failed', failure: categories[message] ?? 'database_access' })}\n`);
  process.exitCode = 1;
});
