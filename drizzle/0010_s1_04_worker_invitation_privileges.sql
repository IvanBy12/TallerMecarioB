-- S1-04 audit fix S104-04: least privilege for tallermecario_worker on
-- membership_invitations.
--
-- 0000's generic tenant loop granted SELECT, INSERT, UPDATE on every mutable
-- tenant table to both runtime roles. The worker's only use of this table is
-- the invitation-email job, which READS (under tenant RLS) the immutable
-- recipient + token_hash of the job's invitation; every write the delivery
-- needs goes through the 0009 SECURITY DEFINER lease functions, which never
-- write membership_invitations at all. Invitation state is changed only by
-- API domain commands (create / revoke / accept).
--
--   * REVOKE every write-ish table privilege from the worker, keep SELECT.
--   * tenant_update policy narrowed to the API (defense in depth: even a
--     future accidental UPDATE grant to the worker finds no UPDATE policy
--     under FORCE RLS). tenant_select / tenant_insert keep both runtime roles
--     (Sprint 0 gate: every tenant table has tenant-scoped SELECT + INSERT
--     policies for api and worker; a policy grants nothing without a
--     privilege).
--   * Fails the migration if the worker still holds any of them through any
--     path (direct grant, PUBLIC, role membership).
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
	ON TABLE public.membership_invitations FROM tallermecario_worker;
--> statement-breakpoint
ALTER POLICY tenant_update ON public.membership_invitations TO tallermecario_api;
--> statement-breakpoint
DO $worker_invitation_privileges$
BEGIN
	IF pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'INSERT')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'UPDATE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'DELETE')
		OR pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'TRUNCATE')
		OR pg_catalog.has_any_column_privilege('tallermecario_worker', 'public.membership_invitations', 'INSERT')
		OR pg_catalog.has_any_column_privilege('tallermecario_worker', 'public.membership_invitations', 'UPDATE') THEN
		RAISE EXCEPTION 'tallermecario_worker still holds a write privilege on membership_invitations';
	END IF;
	IF NOT pg_catalog.has_table_privilege('tallermecario_worker', 'public.membership_invitations', 'SELECT') THEN
		RAISE EXCEPTION 'tallermecario_worker lost SELECT on membership_invitations (email delivery needs it)';
	END IF;
END
$worker_invitation_privileges$;
--> statement-breakpoint
RESET ROLE;
