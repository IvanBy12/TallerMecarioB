-- S1-05 audit fix round 2: owner-set locking that (1) no runtime can aim at
-- another tenant and (2) has ONE global order, including privileged sessions
-- without TenantContext.
--
-- Findings closed:
--   * 0012 exposed app.lock_tenant_owner_set(uuid) / app.assert_tenant_keeps_
--     active_owner(uuid, text) to api/worker: a tenant-A runtime could lock
--     tenant B's owner set. Worse, the lock was a transaction advisory lock on
--     a public, deterministic key, so even without those functions any session
--     could take it with the PUBLIC built-in pg_advisory_xact_lock.
--   * 0012 order was "tenant lock -> row locks" for runtime statements but
--     "row locks -> tenant lock" for privileged statements without a tenant
--     context (their row trigger took the lock after the UPDATE locked the
--     rows) => 40P01 against a runtime role command.
--
-- New mechanism (replaces the 0012 advisory lock; its helpers are dropped):
--   * Tenant owner-set lock = row lock FOR NO KEY UPDATE on the tenant's
--     public.workshops row. Runtime roles take it under RLS (tenant_update
--     policy: id = app.current_tenant_id()), so a runtime can only lock the
--     tenant of its own TenantContext; the lock boundary IS the data boundary.
--     (FK child inserts take FOR KEY SHARE, which does not conflict.)
--   * Global gate = app.owner_mutation_gate, a lock-only relation (no columns,
--     no rows). Runtime roles hold SELECT only, so the ONLY mode they can take
--     is ACCESS SHARE; ACCESS EXCLUSIVE needs UPDATE/DELETE/TRUNCATE, which only
--     the owner / superusers have.
--   * Hierarchy (every supported writer, same order):
--       gate  ->  tenant workshop row  ->  memberships / membership_roles rows
--     - tenant-scoped (runtime with TenantContext): gate ACCESS SHARE, then its
--       tenant's workshop row, then rows;
--     - privileged or unscoped (superuser / BYPASSRLS): gate ACCESS EXCLUSIVE
--       BEFORE any row is touched; it waits for every tenant-scoped holder and
--       then takes each tenant's workshop row lock in its row triggers, when no
--       tenant-scoped transaction can hold one.
--   * Runtime interface: app.lock_current_tenant_owner_set() - no arguments,
--     tenant derived from the TenantContext GUC. There is no runtime-callable
--     function that accepts a tenant id.
--   * BEFORE STATEMENT triggers on memberships / membership_roles take the gate
--     (and, for runtime, the tenant row) before the statement locks any row;
--     AFTER ROW triggers re-take the tenant row (re-entrant), and only then
--     evaluate the invariant in a new statement (fresh READ COMMITTED snapshot
--     taken after any wait).
--
-- Unchanged: the invariant itself and its constraint names
-- (mr_membership_not_active, mr_last_active_owner, m_last_active_owner), RLS
-- ENABLE/FORCE, NOBYPASSRLS runtimes, grants on memberships/membership_roles,
-- trigger names. All functions: SECURITY INVOKER, fixed search_path, no
-- PUBLIC EXECUTE. No SECURITY DEFINER, no new BYPASSRLS.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
-- The 0012 statement triggers and their trigger function (whose name the
-- runtime interface below reuses) go first.
DROP TRIGGER memberships_owner_set_lock_trg ON public.memberships;
--> statement-breakpoint
DROP TRIGGER membership_roles_owner_set_lock_trg ON public.membership_roles;
--> statement-breakpoint
DROP FUNCTION app.lock_current_tenant_owner_set();
--> statement-breakpoint
CREATE TABLE app.owner_mutation_gate ();
--> statement-breakpoint
ALTER TABLE app.owner_mutation_gate ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.owner_mutation_gate FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE app.owner_mutation_gate FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON TABLE app.owner_mutation_gate TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
CREATE FUNCTION app.lock_current_tenant_owner_set()
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
	PERFORM 1 FROM public.workshops AS w WHERE w.id = v_tenant_id FOR NO KEY UPDATE OF w;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'workshop of the tenant context is not visible'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_current_tenant_owner_set() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lock_current_tenant_owner_set() TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
-- Statement-level entry point of the hierarchy (replaces the 0012 trigger function).
CREATE FUNCTION app.enforce_owner_set_lock_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_privileged boolean;
BEGIN
	SELECT r.rolsuper OR r.rolbypassrls INTO v_privileged
	FROM pg_catalog.pg_roles AS r
	WHERE r.rolname = current_user;

	IF COALESCE(v_privileged, false) THEN
		-- Not confined by RLS: may touch any tenant. Exclusive gate first.
		LOCK TABLE app.owner_mutation_gate IN ACCESS EXCLUSIVE MODE;
	ELSIF app.current_tenant_id() IS NOT NULL THEN
		-- Same locks as app.lock_current_tenant_owner_set(), without its
		-- fail-closed error: if the context's workshop is not visible, then (FK
		-- memberships -> workshops, same RLS predicate) no row of the statement
		-- is visible either, so there is nothing to order and the statement
		-- keeps matching zero rows exactly as before.
		LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE;
		PERFORM 1 FROM public.workshops AS w WHERE w.id = app.current_tenant_id() FOR NO KEY UPDATE OF w;
	END IF;
	-- A non-privileged session without tenant context sees (and so can change)
	-- no row under FORCE RLS: nothing to order.
	RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_owner_set_lock_order() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER memberships_owner_set_lock_trg
	BEFORE UPDATE OR DELETE ON public.memberships
	FOR EACH STATEMENT EXECUTE FUNCTION app.enforce_owner_set_lock_order();
--> statement-breakpoint
CREATE TRIGGER membership_roles_owner_set_lock_trg
	BEFORE UPDATE OR DELETE ON public.membership_roles
	FOR EACH STATEMENT EXECUTE FUNCTION app.enforce_owner_set_lock_order();
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
		IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
			RAISE EXCEPTION 'owner-set reductions require READ COMMITTED'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mr_last_active_owner';
		END IF;
		-- Tenant lock (re-entrant; already held via the statement trigger).
		PERFORM 1 FROM public.workshops AS w WHERE w.id = OLD.tenant_id FOR NO KEY UPDATE OF w;
		-- New statement => fresh READ COMMITTED snapshot, after any wait.
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
CREATE OR REPLACE FUNCTION app.enforce_membership_owner_invariant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_owner_role_id uuid;
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

	SELECT r.id INTO v_owner_role_id
	FROM public.roles AS r
	WHERE r.code = 'owner' AND r.scope = 'tenant' AND r.is_system;
	IF v_owner_role_id IS NULL THEN
		RAISE EXCEPTION 'owner role is not configured'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'm_last_active_owner';
	END IF;

	-- Tenant lock first (re-entrant); decide "was it an owner?" after the wait.
	PERFORM 1 FROM public.workshops AS w WHERE w.id = OLD.tenant_id FOR NO KEY UPDATE OF w;
	IF EXISTS (
		SELECT 1 FROM public.membership_roles AS mr
		WHERE mr.tenant_id = OLD.tenant_id AND mr.membership_id = OLD.id AND mr.role_id = v_owner_role_id
	) THEN
		IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
			RAISE EXCEPTION 'owner-set reductions require READ COMMITTED'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'm_last_active_owner';
		END IF;
		IF NOT EXISTS (
			SELECT 1
			FROM public.membership_roles AS mr
			JOIN public.memberships AS m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
			WHERE mr.tenant_id = OLD.tenant_id
				AND mr.role_id = v_owner_role_id
				AND m.status = 'active'
		) THEN
			RAISE EXCEPTION 'a workshop must keep at least one active owner'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'm_last_active_owner';
		END IF;
	END IF;

	RETURN NULL;
END
$function$;
--> statement-breakpoint
-- The 0012 tenant-uuid helpers are no longer referenced by any trigger or code.
DROP FUNCTION app.assert_tenant_keeps_active_owner(uuid, text);
--> statement-breakpoint
DROP FUNCTION app.lock_tenant_owner_set(uuid);
--> statement-breakpoint
DO $owner_lock_hierarchy_privileges$
DECLARE
	v_bad text;
BEGIN
	-- No app function taking a tenant/uuid argument may be executable by a runtime role.
	SELECT pg_catalog.string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
	FROM pg_catalog.pg_proc AS p
	JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
	WHERE n.nspname = 'app'
		AND p.proname IN ('lock_tenant_owner_set', 'assert_tenant_keeps_active_owner');
	IF v_bad IS NOT NULL THEN
		RAISE EXCEPTION 'tenant-uuid owner-set helpers still exist: %', v_bad;
	END IF;
	IF pg_catalog.has_function_privilege('public', 'app.lock_current_tenant_owner_set()', 'EXECUTE')
		OR pg_catalog.has_function_privilege('public', 'app.enforce_owner_set_lock_order()', 'EXECUTE') THEN
		RAISE EXCEPTION 'owner-set functions must not be executable by PUBLIC';
	END IF;
	IF pg_catalog.has_table_privilege('tallermecario_api', 'app.owner_mutation_gate', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_api', 'app.owner_mutation_gate', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_api', 'app.owner_mutation_gate', 'TRUNCATE')
		OR pg_catalog.has_table_privilege('tallermecario_api', 'app.owner_mutation_gate', 'INSERT')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'app.owner_mutation_gate', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'app.owner_mutation_gate', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'app.owner_mutation_gate', 'TRUNCATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'app.owner_mutation_gate', 'INSERT')
		OR pg_catalog.has_table_privilege('public', 'app.owner_mutation_gate', 'SELECT') THEN
		RAISE EXCEPTION 'owner_mutation_gate: runtime may only take ACCESS SHARE (SELECT), PUBLIC nothing';
	END IF;
END
$owner_lock_hierarchy_privileges$;
--> statement-breakpoint
RESET ROLE;
