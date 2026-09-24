-- S1-05 final fix round 3: app.lock_current_tenant_owner_set() must not turn a
-- zero-row operation into a locking error.
--
-- 0013 raised 55000 when the TenantContext's workshop was not visible. The
-- S1-03 revocation handler calls this lock first, so a job whose tenant no
-- longer exists failed with 55000 instead of reaching its domain outcome
-- (`not_found`, zero rows touched) as before 0013.
--
-- Contract (only this function changes; grants, owner, SECURITY INVOKER and
-- search_path are preserved by CREATE OR REPLACE):
--   * no tenant context (GUC unset)    -> 55000, fail closed (unchanged);
--   * malformed tenant context         -> 22P02 from app.current_tenant_id() (unchanged);
--   * valid context, workshop visible  -> owner_mutation_gate ACCESS SHARE, then the
--                                         workshop row FOR NO KEY UPDATE (unchanged);
--   * valid context, workshop NOT visible -> gate ACCESS SHARE, no row lock, return.
--     Safe: under RLS no memberships/membership_roles row of that tenant is
--     visible either (FK -> workshops, same tenant predicate), so there is
--     nothing to order or to protect, and the caller's statements match zero
--     rows exactly as before 0013. Runtime roles only ever see their bound
--     tenant, so "not visible" means "does not exist": there is no distinct
--     foreign-tenant outcome (no oracle).
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lock_current_tenant_owner_set()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_tenant_id uuid := app.current_tenant_id();
BEGIN
	IF v_tenant_id IS NULL THEN
		RAISE EXCEPTION 'owner-set lock requires a tenant context'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
	LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE;
	-- Zero rows when the workshop does not exist / is not visible: nothing of
	-- that tenant can be written, so there is nothing to lock (no error).
	PERFORM 1 FROM public.workshops AS w WHERE w.id = v_tenant_id FOR NO KEY UPDATE OF w;
END
$function$;
--> statement-breakpoint
RESET ROLE;
