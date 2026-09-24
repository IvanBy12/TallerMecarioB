-- S1-05 audit fix (HIGH): the "every workshop keeps at least one ACTIVE owner"
-- invariant (ERD; RBAC §16.1/§16.3) must hold for EVERY write that can shrink
-- the set {membership.status = 'active' AND holds role 'owner'}, not only for
-- membership_roles removals (0011).
--
-- Writers of that set (audited for this migration):
--   * membership_roles DELETE/UPDATE of an owner row   (0011 trigger; runtime: api DELETE only)
--   * memberships UPDATE leaving 'active' (active -> suspended/revoked, or an
--     id/tenant_id rewrite) of an owner membership     (runtime: api + worker hold table
--     UPDATE from 0000; the S1-03 worker revocation handler is the only code path today)
--   * memberships DELETE                                (no runtime grant; privileged sessions only)
-- No SECURITY DEFINER function writes memberships or membership_roles.
--
-- One mechanism, one lock:
--   * app.lock_tenant_owner_set(tenant) is the ONLY definition of the per-tenant
--     owner-set lock: transaction-scoped advisory lock
--     hashtextextended('tallermecario.membership_roles.owner_set/' || tenant, 0),
--     the same key 0011 and the S1-05 role commands already use (compatible,
--     re-entrant; no second lock).
--   * app.assert_tenant_keeps_active_owner(tenant, constraint) takes that lock
--     FIRST and only then evaluates the invariant. Both functions are VOLATILE
--     PL/pgSQL/SQL: under READ COMMITTED every statement after the lock wait
--     takes a NEW snapshot, so the check sees every reducer that committed
--     while we waited (never a snapshot from before the wait). Reducers are
--     totally ordered by the lock (held until COMMIT/ROLLBACK), so the last
--     one to commit always sees all the others. Outside READ COMMITTED the
--     check could run on an older transaction snapshot, so a reduction there
--     fails closed.
--   * 0011's membership_roles trigger function is redefined to use the helper;
--     a new AFTER UPDATE OR DELETE trigger on memberships covers status changes.
--     Additions (new owner rows, reactivation) never need the lock.
--   * BEFORE STATEMENT triggers on both tables take the lock of the session's
--     tenant before any row lock, so every writer uses the same order
--     (owner-set lock -> row locks) and cannot deadlock the role commands.
--
-- Unchanged: RLS ENABLE/FORCE, NOBYPASSRLS runtimes, grants on memberships
-- (api keeps table UPDATE: S1-04/S1-05 take FOR UPDATE / FOR SHARE row locks,
-- which require it; worker keeps UPDATE for the S1-03 revocation handler).
-- Both helpers are SECURITY INVOKER, fixed search_path, no PUBLIC EXECUTE.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE FUNCTION app.lock_tenant_owner_set(p_tenant_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $function$
	SELECT pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('tallermecario.membership_roles.owner_set/' || p_tenant_id::text, 0)
	)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_tenant_owner_set(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_tenant_owner_set(uuid) TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
CREATE FUNCTION app.assert_tenant_keeps_active_owner(p_tenant_id uuid, p_constraint text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
BEGIN
	IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
		RAISE EXCEPTION 'owner-set reductions require READ COMMITTED'
			USING ERRCODE = 'check_violation', CONSTRAINT = p_constraint;
	END IF;

	PERFORM app.lock_tenant_owner_set(p_tenant_id);

	-- New statement => new READ COMMITTED snapshot, taken after the lock.
	IF NOT EXISTS (
		SELECT 1
		FROM public.membership_roles AS mr
		JOIN public.roles AS r
			ON r.id = mr.role_id AND r.code = 'owner' AND r.scope = 'tenant' AND r.is_system
		JOIN public.memberships AS m
			ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
		WHERE mr.tenant_id = p_tenant_id
			AND m.status = 'active'
	) THEN
		RAISE EXCEPTION 'a workshop must keep at least one active owner'
			USING ERRCODE = 'check_violation', CONSTRAINT = p_constraint;
	END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assert_tenant_keeps_active_owner(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assert_tenant_keeps_active_owner(uuid, text) TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_membership_role_invariants()
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
		PERFORM app.assert_tenant_keeps_active_owner(OLD.tenant_id, 'mr_last_active_owner');
	END IF;

	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION app.enforce_membership_owner_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
	-- Only an ACTIVE membership can be counted; staying active (same id/tenant) removes nothing.
	IF OLD.status <> 'active' THEN
		RETURN NULL;
	END IF;
	IF TG_OP = 'UPDATE'
		AND NEW.status = 'active'
		AND NEW.id = OLD.id
		AND NEW.tenant_id = OLD.tenant_id THEN
		RETURN NULL;
	END IF;

	-- Lock first; decide "was it an owner?" on a snapshot taken after the wait.
	PERFORM app.lock_tenant_owner_set(OLD.tenant_id);
	IF EXISTS (
		SELECT 1
		FROM public.membership_roles AS mr
		JOIN public.roles AS r
			ON r.id = mr.role_id AND r.code = 'owner' AND r.scope = 'tenant' AND r.is_system
		WHERE mr.tenant_id = OLD.tenant_id AND mr.membership_id = OLD.id
	) THEN
		PERFORM app.assert_tenant_keeps_active_owner(OLD.tenant_id, 'm_last_active_owner');
	END IF;

	RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_membership_owner_invariant() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER memberships_owner_invariant_trg
	AFTER UPDATE OR DELETE ON public.memberships
	FOR EACH ROW EXECUTE FUNCTION app.enforce_membership_owner_invariant();
--> statement-breakpoint
-- Lock ORDER: owner-set lock before any row lock. Row triggers fire after the
-- statement has row-locked its targets; a runtime statement would then wait
-- for the tenant lock while holding row locks, the inverse of the S1-05 role
-- commands / S1-03 handler order (lock, then rows) => deadlock. A BEFORE
-- STATEMENT trigger takes the lock of the session's tenant (runtime: RLS
-- confines the statement to exactly that tenant) before any row is touched.
-- Sessions without a tenant context (privileged/maintenance) still get the
-- per-row lock + check of the AFTER ROW triggers.
CREATE FUNCTION app.lock_current_tenant_owner_set()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_tenant_id uuid := app.current_tenant_id();
BEGIN
	IF v_tenant_id IS NOT NULL THEN
		PERFORM app.lock_tenant_owner_set(v_tenant_id);
	END IF;
	RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_current_tenant_owner_set() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER memberships_owner_set_lock_trg
	BEFORE UPDATE OR DELETE ON public.memberships
	FOR EACH STATEMENT EXECUTE FUNCTION app.lock_current_tenant_owner_set();
--> statement-breakpoint
CREATE TRIGGER membership_roles_owner_set_lock_trg
	BEFORE UPDATE OR DELETE ON public.membership_roles
	FOR EACH STATEMENT EXECUTE FUNCTION app.lock_current_tenant_owner_set();
--> statement-breakpoint
DO $owner_invariant_privileges$
BEGIN
	IF pg_catalog.has_table_privilege('tallermecario_api', 'public.memberships', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.memberships', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_api', 'public.memberships', 'TRUNCATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.memberships', 'TRUNCATE') THEN
		RAISE EXCEPTION 'runtime roles must not DELETE/TRUNCATE memberships';
	END IF;
	IF pg_catalog.has_function_privilege('public', 'app.lock_tenant_owner_set(uuid)', 'EXECUTE')
		OR pg_catalog.has_function_privilege('public', 'app.assert_tenant_keeps_active_owner(uuid, text)', 'EXECUTE')
		OR pg_catalog.has_function_privilege('public', 'app.enforce_membership_owner_invariant()', 'EXECUTE')
		OR pg_catalog.has_function_privilege('public', 'app.lock_current_tenant_owner_set()', 'EXECUTE') THEN
		RAISE EXCEPTION 'owner invariant functions must not be executable by PUBLIC';
	END IF;
END
$owner_invariant_privileges$;
--> statement-breakpoint
RESET ROLE;
