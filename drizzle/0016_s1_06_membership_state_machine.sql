-- S1-06 audit fix: PostgreSQL enforces the CURRENT membership lifecycle
-- contract, not only the API commands.
--
-- Finding closed: tallermecario_api / tallermecario_worker hold UPDATE on
-- memberships(status, suspended_at, revoked_at, updated_at) (0015), so direct
-- SQL could bypass the API state machine (suspended/revoked -> active,
-- revoked -> suspended, same-state status writes) and write inconsistent
-- timestamps.
--
-- Contract (the ONLY status transitions):
--   active    -> suspended   (sets suspended_at)
--   active    -> revoked     (sets revoked_at)
--   suspended -> revoked     (sets revoked_at, keeps suspended_at)
-- Reactivation (-> active) is NOT allowed: it is an open decision; a future
-- migration must relax this guard explicitly if it is ever approved.
--
-- Timestamp invariant per state (CHECK, validated against existing rows —
-- the migration fails atomically if legacy rows violate it):
--   active    : suspended_at IS NULL     AND revoked_at IS NULL
--   suspended : suspended_at IS NOT NULL AND revoked_at IS NULL
--   revoked   : revoked_at IS NOT NULL   (suspended_at NULL if revoked directly,
--                                         kept if it came from suspended)
--
-- Mechanism:
--   * CHECK memberships_lifecycle_state_check (every writer; not skipped by
--     session_replication_role).
--   * BEFORE UPDATE OF status row trigger (m_status_transition): fires whenever
--     `status` is in the SET list, so a same-state `SET status = <same>` is
--     rejected too; only the three transitions above pass.
--   * BEFORE UPDATE row trigger (m_lifecycle_history; named so it fires AFTER
--     the transition trigger — same-kind triggers fire in name order):
--     suspended_at / revoked_at
--     never change except the timestamp of the state being entered (no
--     rewriting, no clearing of history). An UPDATE of updated_at alone passes.
-- Both apply to every session that runs triggers (runtime AND privileged, like
-- the 0012-0014 owner invariant); only superuser setup with
-- session_replication_role = replica skips triggers (boundary of ADR-009 §10.1).
--
-- Unchanged: 0015 grants (runtime UPDATE only on status, suspended_at,
-- revoked_at, updated_at), RLS ENABLE/FORCE and policies, the owner invariant
-- and the owner-set lock hierarchy (these triggers read no table and take no
-- lock). Functions: SECURITY INVOKER, fixed search_path, no EXECUTE for anyone.
-- No SECURITY DEFINER, no BYPASSRLS, no grant.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
ALTER TABLE public.memberships ADD CONSTRAINT memberships_lifecycle_state_check CHECK (
	(status = 'active' AND suspended_at IS NULL AND revoked_at IS NULL)
	OR (status = 'suspended' AND suspended_at IS NOT NULL AND revoked_at IS NULL)
	OR (status = 'revoked' AND revoked_at IS NOT NULL)
);
--> statement-breakpoint
CREATE FUNCTION app.enforce_membership_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
	IF (OLD.status, NEW.status) IN (('active', 'suspended'), ('active', 'revoked'), ('suspended', 'revoked')) THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'membership status transition % -> % is not allowed', OLD.status, NEW.status
		USING ERRCODE = 'check_violation', CONSTRAINT = 'm_status_transition';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_membership_status_transition() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.enforce_membership_lifecycle_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
	-- Only the timestamp of the state being entered may change.
	IF NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
		AND NOT (NEW.status = 'suspended' AND OLD.status <> 'suspended') THEN
		RAISE EXCEPTION 'suspended_at can only be set when entering suspended'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'm_lifecycle_history';
	END IF;
	IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
		AND NOT (NEW.status = 'revoked' AND OLD.status <> 'revoked') THEN
		RAISE EXCEPTION 'revoked_at can only be set when entering revoked'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'm_lifecycle_history';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_membership_lifecycle_history() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER memberships_status_transition_trg
	BEFORE UPDATE OF status ON public.memberships
	FOR EACH ROW EXECUTE FUNCTION app.enforce_membership_status_transition();
--> statement-breakpoint
CREATE TRIGGER memberships_timestamp_history_trg
	BEFORE UPDATE ON public.memberships
	FOR EACH ROW EXECUTE FUNCTION app.enforce_membership_lifecycle_history();
--> statement-breakpoint
DO $membership_state_machine_checks$
DECLARE
	v_bad text;
BEGIN
	SELECT pg_catalog.string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
	FROM pg_catalog.pg_proc AS p
	JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
	WHERE n.nspname = 'app'
		AND p.proname IN ('enforce_membership_status_transition', 'enforce_membership_lifecycle_history')
		AND (p.prosecdef
			OR p.proowner <> 'tallermecario_schema_owner'::regrole
			OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
			OR pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
			OR pg_catalog.has_function_privilege('tallermecario_api', p.oid, 'EXECUTE')
			OR pg_catalog.has_function_privilege('tallermecario_worker', p.oid, 'EXECUTE'));
	IF v_bad IS NOT NULL THEN
		RAISE EXCEPTION 'membership state-machine functions have unexpected attributes: %', v_bad;
	END IF;
	IF (SELECT count(*) FROM pg_catalog.pg_trigger AS t
		WHERE t.tgrelid = 'public.memberships'::regclass
			AND t.tgname IN ('memberships_status_transition_trg', 'memberships_timestamp_history_trg')
			AND t.tgenabled = 'O') <> 2 THEN
		RAISE EXCEPTION 'membership state-machine triggers missing or not enabled';
	END IF;
	-- 0015 grants preserved.
	IF pg_catalog.has_table_privilege('tallermecario_api', 'public.memberships', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.memberships', 'UPDATE')
		OR pg_catalog.has_column_privilege('tallermecario_api', 'public.memberships', 'user_id', 'UPDATE')
		OR pg_catalog.has_column_privilege('tallermecario_worker', 'public.memberships', 'user_id', 'UPDATE') THEN
		RAISE EXCEPTION 'memberships: 0015 column grants changed';
	END IF;
END
$membership_state_machine_checks$;
--> statement-breakpoint
RESET ROLE;
