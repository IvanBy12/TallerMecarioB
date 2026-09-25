-- S1-06 membership lifecycle: least-privilege UPDATE on public.memberships
-- (ADR-009 §10: "UPDATE solo en tablas mutables", DML explícito por tabla).
--
-- Before: the 0000 generic tenant loop gave tallermecario_api and
-- tallermecario_worker TABLE-level UPDATE on memberships, so a runtime could
-- rewrite user_id, joined_at or created_at of any membership of its tenant (and
-- attempt id/tenant_id, only stopped by RLS WITH CHECK / FKs). No runtime path
-- writes those columns. The only runtime writers are:
--   * API    — S1-06 suspend/revoke commands: status, suspended_at, revoked_at, updated_at
--   * worker — S1-03 identity.membership_revocation_requested: status, revoked_at, updated_at
-- Both runtimes get the same four lifecycle columns: identity columns (id,
-- tenant_id, user_id, joined_at, created_at) become immutable for runtime.
-- The worker keeps suspended_at because the S1-05 database suites exercise it
-- as a generic runtime status writer; narrowing it to (status, revoked_at,
-- updated_at) is a recorded follow-up (docs/S1-06-DOC-CHANGES.md), not done here.
-- Row locks keep working: SELECT ... FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE
-- need UPDATE on at least one column of the table (S1-04 invitation accept,
-- S1-05/S1-06 commands, S1-03 handler, 0011-0014 triggers).
--
-- The status machine itself stays in the application commands: runtime
-- reactivation (-> active) is deliberately NOT blocked here, because it is an
-- open decision (Diccionario 01 §4: "reactivar no está restringido por este guard").
--
-- Unchanged: RLS ENABLE/FORCE and the tenant_select / tenant_insert /
-- tenant_update policies (Sprint 0 gate), SELECT/INSERT grants, the 0012-0014
-- triggers and the owner-set lock hierarchy (gate -> workshop row -> rows), no
-- DELETE/TRUNCATE for any runtime. No function, no SECURITY DEFINER, no BYPASSRLS.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
-- Revoking the table privilege also revokes any column privilege on it.
REVOKE UPDATE ON TABLE public.memberships FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT UPDATE (status, suspended_at, revoked_at, updated_at) ON TABLE public.memberships
	TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
DO $membership_lifecycle_privileges$
DECLARE
	v_role text;
	v_column text;
	v_allowed constant text[] := ARRAY['status', 'suspended_at', 'revoked_at', 'updated_at'];
BEGIN
	FOREACH v_role IN ARRAY ARRAY['tallermecario_api', 'tallermecario_worker'] LOOP
		IF pg_catalog.has_table_privilege(v_role, 'public.memberships', 'UPDATE')
			OR pg_catalog.has_table_privilege(v_role, 'public.memberships', 'DELETE')
			OR pg_catalog.has_table_privilege(v_role, 'public.memberships', 'TRUNCATE')
			OR pg_catalog.has_table_privilege(v_role, 'public.memberships', 'REFERENCES')
			OR pg_catalog.has_table_privilege(v_role, 'public.memberships', 'TRIGGER')
			OR NOT pg_catalog.has_table_privilege(v_role, 'public.memberships', 'SELECT')
			OR NOT pg_catalog.has_table_privilege(v_role, 'public.memberships', 'INSERT') THEN
			RAISE EXCEPTION 'memberships: unexpected table privileges for %', v_role;
		END IF;
		FOR v_column IN
			SELECT a.attname::text FROM pg_catalog.pg_attribute AS a
			WHERE a.attrelid = 'public.memberships'::regclass AND a.attnum > 0 AND NOT a.attisdropped
		LOOP
			IF pg_catalog.has_column_privilege(v_role, 'public.memberships', v_column, 'UPDATE')
				IS DISTINCT FROM (v_column = ANY(v_allowed)) THEN
				RAISE EXCEPTION 'memberships.%: unexpected UPDATE privilege for %', v_column, v_role;
			END IF;
		END LOOP;
	END LOOP;
	IF pg_catalog.has_any_column_privilege('public', 'public.memberships', 'SELECT')
		OR pg_catalog.has_any_column_privilege('public', 'public.memberships', 'INSERT')
		OR pg_catalog.has_any_column_privilege('public', 'public.memberships', 'UPDATE') THEN
		RAISE EXCEPTION 'memberships: PUBLIC must hold no privilege';
	END IF;
END
$membership_lifecycle_privileges$;
--> statement-breakpoint
RESET ROLE;
