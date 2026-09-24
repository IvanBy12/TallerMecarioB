-- S1-04 membership invitations (ERD §membership_invitations, Dic. 01 §5,
-- RBAC §4 "Invitaciones internas", ADR-009 §7/§8).
--
-- membership_invitations itself (columns, composite FKs, UNIQUE(token_hash),
-- the partial unique "one pending per (tenant_id, email_normalized)", RLS
-- ENABLE+FORCE and the tenant policies/grants) already exists since 0000.
-- This migration only hardens it and adds the one pre-tenant read path the
-- acceptance flow needs:
--
--   1. CHECKs (drizzle-generated): accepted/revoked column coherence,
--      token_hash is a SHA-256 hex digest (a raw token can never be stored),
--      expires_at after created_at.
--   2. app.enforce_membership_invitation_lifecycle (SECURITY INVOKER trigger):
--      created pending and unexpired; identity/token/expiry columns immutable;
--      accepted/expired/revoked are terminal (no transition back to pending);
--      pending -> expired only once expires_at has passed; pending -> accepted
--      only before expires_at and only onto a membership of the same user in
--      the same tenant that already holds the invitation's target role (no
--      "accepted + incomplete roles" state can commit).
--   3. app.bootstrap_resolve_membership_invitation (SECURITY DEFINER, owner
--      tallermecario_bootstrap_resolver): exact token_hash -> (invitation id,
--      tenant id). Column-level SELECT only; EXECUTE for tallermecario_api
--      only. Everything after the resolution runs under TenantContext + RLS.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_accepted_coherence_check" CHECK (("status" = 'accepted' AND "accepted_at" IS NOT NULL AND "accepted_by_user_id" IS NOT NULL AND "accepted_membership_id" IS NOT NULL)
       OR ("status" <> 'accepted' AND "accepted_at" IS NULL AND "accepted_by_user_id" IS NULL AND "accepted_membership_id" IS NULL));--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_revoked_coherence_check" CHECK (("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by_membership_id" IS NOT NULL)
       OR ("status" <> 'revoked' AND "revoked_at" IS NULL AND "revoked_by_membership_id" IS NULL));--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_token_hash_format_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_expiry_after_creation_check" CHECK ("expires_at" > "created_at");
--> statement-breakpoint

-- SECURITY INVOKER on purpose (same reasoning as 0001): the runtime role sees
-- the tenant's memberships/membership_roles through RLS in the same
-- transaction that inserted them; a definer owned by the schema owner would
-- see zero rows under FORCE RLS.
CREATE FUNCTION app.enforce_membership_invitation_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'pending' THEN
			RAISE EXCEPTION 'membership invitation must be created pending'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_created_pending';
		END IF;
		IF NEW.expires_at <= pg_catalog.clock_timestamp() THEN
			RAISE EXCEPTION 'membership invitation must be created unexpired'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_created_pending';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.email IS DISTINCT FROM OLD.email
		OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
		OR NEW.target_role_id IS DISTINCT FROM OLD.target_role_id
		OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
		OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
		OR NEW.invited_by_membership_id IS DISTINCT FROM OLD.invited_by_membership_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'membership invitation identity columns are immutable'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_immutable_columns';
	END IF;

	IF OLD.status <> 'pending' THEN
		RAISE EXCEPTION 'membership invitation in a terminal state cannot change'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_terminal_state';
	END IF;

	IF NEW.status = 'expired' AND OLD.expires_at > pg_catalog.clock_timestamp() THEN
		RAISE EXCEPTION 'membership invitation cannot expire before expires_at'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_expire_before_deadline';
	END IF;

	IF NEW.status = 'accepted' THEN
		IF OLD.expires_at <= pg_catalog.clock_timestamp() THEN
			RAISE EXCEPTION 'expired membership invitation cannot be accepted'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_accept_after_deadline';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM public.memberships AS m
			WHERE m.tenant_id = NEW.tenant_id
				AND m.id = NEW.accepted_membership_id
				AND m.user_id = NEW.accepted_by_user_id
		) THEN
			RAISE EXCEPTION 'accepted membership must belong to the accepting user in the same tenant'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_accepted_membership_mismatch';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM public.membership_roles AS r
			WHERE r.tenant_id = NEW.tenant_id
				AND r.membership_id = NEW.accepted_membership_id
				AND r.role_id = NEW.target_role_id
		) THEN
			RAISE EXCEPTION 'accepted membership must hold the invitation target role'
				USING ERRCODE = 'check_violation', CONSTRAINT = 'mi_accepted_role_missing';
		END IF;
	END IF;

	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER membership_invitations_lifecycle_trg
	BEFORE INSERT OR UPDATE ON public.membership_invitations
	FOR EACH ROW EXECUTE FUNCTION app.enforce_membership_invitation_lifecycle();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_membership_invitation_lifecycle() FROM PUBLIC;
--> statement-breakpoint

-- Only the columns the resolver reads; no table-level grant.
GRANT SELECT (id, tenant_id, token_hash)
	ON TABLE public.membership_invitations TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- ADR-009 §7: exact-hash lookup only (never a scan by prefix/email/tenant).
-- A malformed or unknown hash returns zero rows; the result carries no status,
-- email or role, so it reveals nothing beyond "this exact token exists".
CREATE FUNCTION app.bootstrap_resolve_membership_invitation(p_token_hash text)
RETURNS TABLE (
	invitation_id uuid,
	tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT i.id, i.tenant_id
	FROM public.membership_invitations AS i
	WHERE p_token_hash ~ '^[0-9a-f]{64}$'
		AND i.token_hash = p_token_hash
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bootstrap_resolve_membership_invitation(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bootstrap_resolve_membership_invitation(text) TO tallermecario_api;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
