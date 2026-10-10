import postgres from 'postgres';
import { discoverMediaPurges, dueMediaPurges, purgeMediaAsset } from '../media/purger.js';
import { loadR2ConfigFromEnv, type R2Config } from '../media/r2.js';
import { parseCanonicalUuid } from '../tenancy/tenant-selection.js';

export async function assertMediaPurgerRole(database: postgres.Sql): Promise<void> {
    const [r] = await database`SELECT current_user AS role,session_user AS login,
      l.rolsuper AS login_super,l.rolbypassrls AS login_bypass,l.rolinherit AS login_inherits,
      e.rolsuper AS role_super,e.rolbypassrls AS role_bypass,
      EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
        WHERE r.rolname='tallermecario_media_lifecycle') AS lifecycle_memberships,
      NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='tallermecario_media_lifecycle'
        AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)) AS lifecycle_flags_invalid,
      EXISTS(SELECT 1 FROM pg_class c WHERE c.relkind IN ('r','p','v','m','S','f')
        AND (c.relowner=l.oid OR c.relowner=e.oid OR pg_has_role(session_user,c.relowner,'MEMBER'))) AS owns_relation,
      EXISTS(SELECT 1 FROM pg_roles forbidden WHERE forbidden.rolname IN
        ('tallermecario_api','tallermecario_worker','tallermecario_media_lifecycle','tallermecario_schema_owner')
        AND (pg_has_role(current_user,forbidden.oid,'MEMBER') OR pg_has_role(session_user,forbidden.oid,'USAGE'))) AS effective_forbidden,
      EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN ('public.media_assets'::regclass,'public.media_purge_jobs'::regclass)
        AND (has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE')
          OR has_table_privilege(session_user,c.oid,'DELETE,TRUNCATE')
          OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')
          OR has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE'))) AS destructive_grants,
      pg_has_role(session_user,'tallermecario_api','MEMBER') AS api,
      pg_has_role(session_user,'tallermecario_worker','MEMBER') AS worker,
      pg_has_role(session_user,'tallermecario_media_lifecycle','MEMBER') AS lifecycle,
      pg_has_role(session_user,'tallermecario_schema_owner','MEMBER') AS owner
      FROM pg_roles l,pg_roles e WHERE l.rolname=session_user AND e.rolname=current_user`;
    if (!r || r.role !== 'tallermecario_media_purger' || r.login_super || r.login_bypass || r.login_inherits || r.lifecycle_memberships || r.lifecycle_flags_invalid
      || r.role_super || r.role_bypass || r.owns_relation || r.destructive_grants || r.effective_forbidden || r.api || r.worker || r.lifecycle || r.owner) throw new Error('MEDIA_PURGER_ROLE_INVALID');
}

/** Discovery and due work have independent failure boundaries. */
export async function processMediaPurgeTenant(database: postgres.Sql, config: R2Config, tenant: string,
  cursor: string | null, transport?: typeof import('../media/r2.js').deleteR2Object, shouldContinue: () => boolean = () => true): Promise<string | null> {
  let next = cursor;
  try { next = await discoverMediaPurges(database, tenant, cursor); }
  catch { process.stderr.write('media purger: discovery failed\n'); }
  for (const id of await dueMediaPurges(database, tenant)) {
    if (!shouldContinue()) break;
    const result = await purgeMediaAsset(database, config, tenant, id, transport);
    if (result === 'retry') process.stderr.write('media purger: retry scheduled\n');
  }
  return next;
}
export function assertMediaPurgerEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MEDIA_PURGE_ENABLED !== 'true') throw new Error('MEDIA_PURGER_DISABLED');
}

async function main(): Promise<void> {
  assertMediaPurgerEnabled();
  const url = process.env.MEDIA_PURGER_DATABASE_URL;
  const tenants = (process.env.MEDIA_PURGE_TENANT_IDS ?? '').split(',').map(parseCanonicalUuid);
  if (!url || tenants.length === 0 || tenants.some(id => !id)) throw new Error('MEDIA_PURGER_CONFIGURATION_MISSING');
  const config = loadR2ConfigFromEnv();
  const database = postgres(url, { max: 2, connection: { role: 'tallermecario_media_purger' } });
  try {
    await assertMediaPurgerRole(database);
    let running = true;
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { running = false; });
    const cursors = new Map<string, string | null>();
    while (running) {
      for (const tenant of tenants as string[]) {
        if (!running) break;
        try {
          cursors.set(tenant, await processMediaPurgeTenant(database, config, tenant, cursors.get(tenant) ?? null, undefined, () => running));
        } catch (error) {
          if ((error as Error).message === 'MEDIA_PURGER_FENCE_RELEASE_FAILED') throw error;
          process.stderr.write('media purger: cycle failed\n');
        }
      }
      if (running) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { await database.end({ timeout: 5 }); }
}
if (require.main === module) main().catch(() => { process.stderr.write('MEDIA_PURGER_STARTUP_FAILED\n'); process.exitCode = 1; });
