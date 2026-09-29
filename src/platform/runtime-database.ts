import postgres from 'postgres';

type RuntimeKind = 'api' | 'worker';

/**
 * API and worker authenticate with the same NOINHERIT login. PostgreSQL applies
 * this fixed role when each connection opens, before any query (including
 * pre-transaction bootstrap reads). Separate pools never exchange sessions.
 */
export async function runtimeDatabase(kind: RuntimeKind, max: number): Promise<postgres.Sql> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const role = kind === 'api' ? 'tallermecario_api' : 'tallermecario_worker';
  const database = postgres(url, {
    max,
    connection: { role },
  });
  try {
    const [identity] = await database<{
      session_role: string; effective_role: string; login_inherits: boolean;
      login_super: boolean; login_bypass: boolean; role_super: boolean;
      role_bypass: boolean; app_usage: boolean; public_usage: boolean;
    }[]>`
      SELECT session_user AS session_role, current_user AS effective_role,
        login.rolinherit AS login_inherits, login.rolsuper AS login_super,
        login.rolbypassrls AS login_bypass, effective.rolsuper AS role_super,
        effective.rolbypassrls AS role_bypass,
        pg_catalog.has_schema_privilege(session_user, 'app', 'USAGE') AS app_usage,
        pg_catalog.has_schema_privilege(session_user, 'public', 'USAGE') AS public_usage
      FROM pg_catalog.pg_roles login, pg_catalog.pg_roles effective
      WHERE login.rolname = session_user AND effective.rolname = current_user`;
    if (!identity || identity.session_role !== 'tallermecario_runtime'
      || identity.effective_role !== role || identity.login_inherits
      || identity.login_super || identity.login_bypass || identity.role_super
      || identity.role_bypass || identity.app_usage || identity.public_usage) {
      throw new Error('DATABASE_RUNTIME_ROLE_INVALID');
    }
    return database;
  } catch {
    await database.end({ timeout: 5 }).catch(() => undefined);
    throw new Error('DATABASE_RUNTIME_ROLE_INVALID');
  }
}
