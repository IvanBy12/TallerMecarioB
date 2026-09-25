-- S1-05 member role management: role assignment / removal on existing
-- memberships (Diccionario 01 §9, RBAC §16, ERD "todo taller conserva al
-- menos un owner activo").
--
-- membership_roles is changed ONLY by inserting or deleting rows through
-- authorized domain commands (Diccionario 01 §9: "No UPDATE directo de rol").
--
--   1. Privileges. 0000's generic tenant loop granted SELECT, INSERT, UPDATE
--      to both runtime roles and no DELETE.
--        * REVOKE UPDATE from api and worker; drop the (now inert) tenant_update
--          policy. A role change is a DELETE + INSERT, never an UPDATE.
--        * GRANT DELETE to tallermecario_api only (role removal command) with
--          a tenant-scoped tenant_delete policy under FORCE RLS. The worker
--          never removes roles and gets no DELETE.
--   2. app.enforce_membership_role_invariants (SECURITY INVOKER trigger; runs
--      with the caller's privileges and RLS, owns nothing):
--        * INSERT: the target membership must be `active` (FOR SHARE: a
--          concurrent status change serializes with the assignment). Role
--          assignment never reactivates a suspended/revoked membership.
--        * DELETE (and UPDATE, if a privileged session ever issues one) of an
--          `owner` row: takes the per-tenant owner-set advisory lock, then
--          requires at least one remaining `owner` row on an `active`
--          membership. Concurrent owner removals serialize on the lock; the
--          re-check after the lock takes a fresh READ COMMITTED snapshot, so
--          the second removal sees the first one's commit. Under REPEATABLE
--          READ / SERIALIZABLE the re-check could use a stale snapshot, so an
--          owner removal there fails closed instead.
--      The API command (src/memberships/roles-service.ts) takes the same
--      advisory lock FIRST (re-entrant here) and performs the same check to
--      return a stable error; this trigger is the database backstop.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.membership_roles FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint
DROP POLICY tenant_update ON public.membership_roles;
--> statement-breakpoint
GRANT DELETE ON TABLE public.membership_roles TO tallermecario_api;
--> statement-breakpoint
CREATE POLICY tenant_delete ON public.membership_roles
	FOR DELETE TO tallermecario_api
	USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION app.enforce_membership_role_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_owner_role_id uuid;
	v_status text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		SELECT m.status INTO v_status
		FROM public.memberships AS m
		WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.membership_id
		FOR SHARE OF m;
		IF v_status IS DISTINCT FROM 'active' THEN
			RAISE EXCEPTION 'roles can only be assigned to an active membership'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mr_membership_not_active';
		END IF;
		RETURN NEW;
	END IF;

	SELECT r.id INTO v_owner_role_id
	FROM public.roles AS r
	WHERE r.code = 'owner' AND r.scope = 'tenant' AND r.is_system;
	IF v_owner_role_id IS NULL THEN
		RAISE EXCEPTION 'owner role is not configured'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'mr_last_active_owner';
	END IF;

	IF OLD.role_id = v_owner_role_id AND (
		TG_OP = 'DELETE'
		OR NEW.role_id IS DISTINCT FROM OLD.role_id
		OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
	) THEN
		IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
			RAISE EXCEPTION 'owner removal requires READ COMMITTED'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mr_last_active_owner';
		END IF;
		PERFORM pg_catalog.pg_advisory_xact_lock(
			pg_catalog.hashtextextended('tallermecario.membership_roles.owner_set/' || OLD.tenant_id::text, 0)
		);
		IF NOT EXISTS (
			SELECT 1
			FROM public.membership_roles AS mr
			JOIN public.memberships AS m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
			WHERE mr.tenant_id = OLD.tenant_id
				AND mr.role_id = v_owner_role_id
				AND m.status = 'active'
		) THEN
			RAISE EXCEPTION 'a workshop must keep at least one active owner'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mr_last_active_owner';
		END IF;
	END IF;

	RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_membership_role_invariants() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER membership_roles_invariants_trg
	AFTER INSERT OR UPDATE OR DELETE ON public.membership_roles
	FOR EACH ROW EXECUTE FUNCTION app.enforce_membership_role_invariants();
--> statement-breakpoint
DO $membership_roles_privileges$
BEGIN
	IF pg_catalog.has_table_privilege('tallermecario_api', 'public.membership_roles', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_roles', 'UPDATE')
		OR pg_catalog.has_any_column_privilege('tallermecario_api', 'public.membership_roles', 'UPDATE')
		OR pg_catalog.has_any_column_privilege('tallermecario_worker', 'public.membership_roles', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_roles', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_api', 'public.membership_roles', 'TRUNCATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_roles', 'TRUNCATE') THEN
		RAISE EXCEPTION 'runtime roles hold an unexpected privilege on membership_roles';
	END IF;
	IF NOT pg_catalog.has_table_privilege('tallermecario_api', 'public.membership_roles', 'DELETE') THEN
		RAISE EXCEPTION 'tallermecario_api lacks DELETE on membership_roles';
	END IF;
END
$membership_roles_privileges$;
--> statement-breakpoint
RESET ROLE;
