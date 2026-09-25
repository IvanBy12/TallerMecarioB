-- S1-07 audit subsystem closure: PostgreSQL enforces the audit_logs contract
-- that, until now, only the application code upheld (Operación §5.1,
-- ADR-009 §3/§10/§11, Diccionario 04 §9, RBAC §16.8).
--
-- Before (0000 generic append-only loop + 0002 guards):
--   * tallermecario_api and tallermecario_worker held TABLE-level INSERT, i.e.
--     every column: a runtime statement could persist user_agent (S1-04
--     hardening: a free-form client header is never persisted) and backdate
--     created_at (the audit clock must be PostgreSQL's);
--   * the tenant_insert policy binds tenant_id only: a runtime statement could
--     attribute a row to ANY user of the platform (actor_user_id FK is
--     global), to any membership of its tenant, to actor_type
--     provider/platform, and the worker could write actor_type = 'user' rows
--     for a user that never acted;
--   * request_id of API rows was free text: the correlation with the request
--     that produced the row could be forged.
--
-- After:
--   * column-level INSERT only. API: every column except user_agent and
--     created_at. Worker: the same minus ip_address (a job has no client).
--     SELECT, RLS ENABLE/FORCE, the tenant_select / tenant_insert policies,
--     the 0002 append-only triggers and the resolver's 0005 column grants are
--     unchanged. No UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER for any runtime,
--     nothing for PUBLIC.
--   * BEFORE INSERT trigger audit_logs_actor_guard_trg for RUNTIME sessions
--     (current_user is, or inherits, tallermecario_api / tallermecario_worker
--     and is not a superuser). The actor is the TenantContext (ADR-009 §3:
--     app.user_id / app.membership_id / app.request_id "se usan para
--     auditoría"):
--       API    'user'   -> actor_user_id = app.user_id (required),
--                          actor_membership_id IS NOT DISTINCT FROM app.membership_id
--              'system' -> no actor ids (e.g. on-access invitation expiry)
--              request_id = app.request_id (required); provider/platform refused
--       worker 'system' | 'provider' only, no actor ids (a job never acts as a
--              user; its request_id is the outbox correlation)
--     Refusal: SQLSTATE 42501, constraint name audit_logs_actor_guard.
--   * SECURITY DEFINER bootstrap functions (JIT, identity lifecycle) run as
--     their NOLOGIN owner: they keep their own allowlisted contract and are
--     not runtime sessions for this guard.
--
-- Existing rows are neither read nor rewritten (append-only history, including
-- pre-S1-04 rows that carry a user_agent). No function is SECURITY DEFINER,
-- no role gains BYPASSRLS, no policy changes.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
-- Revoking the table privilege also revokes any column privilege on it.
REVOKE INSERT ON TABLE public.audit_logs FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT INSERT (
	id, tenant_id, actor_type, actor_user_id, actor_membership_id,
	action, outcome, entity_type, entity_id, reason_code,
	before_json, after_json, metadata_json, request_id, trace_id, ip_address
) ON TABLE public.audit_logs TO tallermecario_api;
--> statement-breakpoint
GRANT INSERT (
	id, tenant_id, actor_type, actor_user_id, actor_membership_id,
	action, outcome, entity_type, entity_id, reason_code,
	before_json, after_json, metadata_json, request_id, trace_id
) ON TABLE public.audit_logs TO tallermecario_worker;
--> statement-breakpoint

CREATE FUNCTION app.enforce_audit_log_actor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_superuser boolean;
	v_api boolean;
	v_worker boolean;
	v_user_id uuid;
	v_membership_id uuid;
	v_request_id text;
BEGIN
	SELECT r.rolsuper INTO v_superuser FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user;
	IF v_superuser IS NOT FALSE THEN
		RETURN NEW;
	END IF;
	v_api := pg_catalog.pg_has_role(current_user, 'tallermecario_api', 'USAGE');
	v_worker := pg_catalog.pg_has_role(current_user, 'tallermecario_worker', 'USAGE');
	IF NOT v_api AND NOT v_worker THEN
		-- Schema owner / migrator / allowlisted SECURITY DEFINER owners.
		RETURN NEW;
	END IF;
	IF v_api AND v_worker THEN
		RAISE EXCEPTION 'audit_logs: a session cannot act as both runtimes'
			USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
	END IF;

	IF v_worker THEN
		IF NEW.actor_type NOT IN ('system', 'provider')
			OR NEW.actor_user_id IS NOT NULL OR NEW.actor_membership_id IS NOT NULL THEN
			RAISE EXCEPTION 'audit_logs: worker rows are system/provider rows without a user actor'
				USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
		END IF;
		RETURN NEW;
	END IF;

	v_user_id := NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid;
	v_membership_id := NULLIF(pg_catalog.current_setting('app.membership_id', true), '')::uuid;
	v_request_id := NULLIF(pg_catalog.current_setting('app.request_id', true), '');

	IF v_request_id IS NULL OR NEW.request_id IS DISTINCT FROM v_request_id THEN
		RAISE EXCEPTION 'audit_logs: request_id must be the bound request context'
			USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
	END IF;

	IF NEW.actor_type = 'user' THEN
		IF v_user_id IS NULL OR NEW.actor_user_id IS DISTINCT FROM v_user_id
			OR NEW.actor_membership_id IS DISTINCT FROM v_membership_id THEN
			RAISE EXCEPTION 'audit_logs: the user actor must be the bound TenantContext'
				USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
		END IF;
	ELSIF NEW.actor_type = 'system' THEN
		IF NEW.actor_user_id IS NOT NULL OR NEW.actor_membership_id IS NOT NULL THEN
			RAISE EXCEPTION 'audit_logs: system rows carry no user actor'
				USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
		END IF;
	ELSE
		RAISE EXCEPTION 'audit_logs: the API writes only user/system rows'
			USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'audit_logs_actor_guard';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_audit_log_actor() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER audit_logs_actor_guard_trg
	BEFORE INSERT ON public.audit_logs
	FOR EACH ROW EXECUTE FUNCTION app.enforce_audit_log_actor();
--> statement-breakpoint

DO $audit_log_privileges$
DECLARE
	v_role text;
	v_column text;
	v_allowed text[];
	v_common constant text[] := ARRAY[
		'id', 'tenant_id', 'actor_type', 'actor_user_id', 'actor_membership_id',
		'action', 'outcome', 'entity_type', 'entity_id', 'reason_code',
		'before_json', 'after_json', 'metadata_json', 'request_id', 'trace_id'
	];
BEGIN
	FOREACH v_role IN ARRAY ARRAY['tallermecario_api', 'tallermecario_worker'] LOOP
		v_allowed := CASE WHEN v_role = 'tallermecario_api' THEN v_common || 'ip_address'::text ELSE v_common END;
		IF pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'INSERT')
			OR pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'UPDATE')
			OR pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'DELETE')
			OR pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'TRUNCATE')
			OR pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'REFERENCES')
			OR pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'TRIGGER')
			OR NOT pg_catalog.has_table_privilege(v_role, 'public.audit_logs', 'SELECT') THEN
			RAISE EXCEPTION 'audit_logs: unexpected table privileges for %', v_role;
		END IF;
		FOR v_column IN
			SELECT a.attname::text FROM pg_catalog.pg_attribute AS a
			WHERE a.attrelid = 'public.audit_logs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
		LOOP
			IF pg_catalog.has_column_privilege(v_role, 'public.audit_logs', v_column, 'INSERT')
				IS DISTINCT FROM (v_column = ANY(v_allowed)) THEN
				RAISE EXCEPTION 'audit_logs.%: unexpected INSERT privilege for %', v_column, v_role;
			END IF;
			IF pg_catalog.has_column_privilege(v_role, 'public.audit_logs', v_column, 'UPDATE') THEN
				RAISE EXCEPTION 'audit_logs.%: unexpected UPDATE privilege for %', v_column, v_role;
			END IF;
		END LOOP;
	END LOOP;
	IF pg_catalog.has_any_column_privilege('public', 'public.audit_logs', 'SELECT')
		OR pg_catalog.has_any_column_privilege('public', 'public.audit_logs', 'INSERT')
		OR pg_catalog.has_any_column_privilege('public', 'public.audit_logs', 'UPDATE') THEN
		RAISE EXCEPTION 'audit_logs: PUBLIC must hold no privilege';
	END IF;
	IF pg_catalog.has_column_privilege('tallermecario_bootstrap_resolver', 'public.audit_logs', 'user_agent', 'INSERT')
		OR pg_catalog.has_column_privilege('tallermecario_bootstrap_resolver', 'public.audit_logs', 'created_at', 'INSERT')
		OR pg_catalog.has_any_column_privilege('tallermecario_identity_sync', 'public.audit_logs', 'INSERT') THEN
		RAISE EXCEPTION 'audit_logs: unexpected bootstrap/identity_sync INSERT privilege';
	END IF;
END
$audit_log_privileges$;
--> statement-breakpoint
RESET ROLE;
