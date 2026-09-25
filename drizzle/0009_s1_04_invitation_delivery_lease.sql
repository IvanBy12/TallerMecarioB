-- S1-04 audit fix S104-03: coordinate the invitation email delivery with the
-- terminal transitions of membership_invitations (accept / revoke / expire).
--
-- Problem: the worker checked "still pending" in one short transaction, then
-- called Resend with no transaction open (correct: no lock across the
-- network). A revoke/accept committing in between still let the email go out
-- AFTER the terminal transition.
--
-- Mechanism (no SQL lock is ever held across the provider call):
--
--   * membership_invitation_deliveries: one row per invitation holding the
--     delivery LEASE (owner = lease_id + claimed outbox job + attempt,
--     lease_acquired_at, lease_expires_at) and the recorded provider result
--     (sent_at, provider_message_id).
--   * Serialization point: a transaction-scoped advisory lock keyed on the
--     invitation id, taken by (a) the lease functions below and (b) the
--     lifecycle trigger on every pending -> terminal transition. An advisory
--     lock needs no table privilege, so the worker never needs UPDATE on
--     membership_invitations (a row lock would: FOR UPDATE/SHARE require it).
--   * worker PHASE B: app.worker_acquire_invitation_email_lease (one short
--     autocommit statement): lock -> invitation still pending and valid for
--     the whole lease -> no other active lease -> lease written -> COMMIT.
--     The Resend call happens after that commit, strictly inside the lease
--     window (the worker checks its own monotonic deadline, derived from a
--     clock reading taken BEFORE the acquire call, before starting it).
--   * worker PHASE C: app.worker_complete_invitation_email_delivery records
--     the provider acceptance and releases the lease in the same transaction
--     as the email_sent audit row and the outbox `processed` transition.
--   * accept / revoke / expire: the lifecycle trigger takes the same lock and
--     refuses (55006, constraint mi_delivery_in_progress -> API 409
--     INVITATION_IN_PROGRESS) while an unexpired lease exists. It never waits
--     for the network: at most for the worker's short acquire statement.
--   * Recovery: a lease is time-bounded; a dead worker's lease simply expires
--     (no zombie state), after which a terminal transition succeeds or a new
--     attempt of the job can acquire a fresh lease. An ACTIVE lease is never
--     taken over, not even by a later attempt of the same job.
--   * A lease never outlives the invitation (acquire requires
--     expires_at > lease_expires_at), so expiry never races a send.
--
-- Privileges: the table is tenant-owned (RLS ENABLE + FORCE). Runtime API may
-- only SELECT it under the tenant policy (the invoker trigger reads it). The
-- worker has NO grant on it; all writes go through the three allowlisted
-- SECURITY DEFINER functions (owner tallermecario_bootstrap_resolver, like
-- every other worker_* outbox function), with column-level grants only.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE TABLE "membership_invitation_deliveries" (
	"tenant_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"lease_id" uuid,
	"lease_outbox_event_id" uuid,
	"lease_attempt" integer,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"lease_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_message_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mid_pk" PRIMARY KEY("tenant_id","invitation_id"),
	CONSTRAINT "mid_lease_coherence_check" CHECK (num_nulls("lease_id", "lease_outbox_event_id", "lease_attempt", "lease_acquired_at", "lease_expires_at") IN (0, 5)),
	CONSTRAINT "mid_lease_window_check" CHECK ("lease_expires_at" IS NULL OR "lease_expires_at" > "lease_acquired_at"),
	CONSTRAINT "mid_lease_attempt_check" CHECK ("lease_attempt" IS NULL OR "lease_attempt" > 0),
	CONSTRAINT "mid_lease_count_check" CHECK ("lease_count" >= 0),
	CONSTRAINT "mid_sent_coherence_check" CHECK (("sent_at" IS NULL) = ("provider_message_id" IS NULL)),
	CONSTRAINT "mid_provider_message_id_check" CHECK ("provider_message_id" IS NULL OR length("provider_message_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "membership_invitation_deliveries" ADD CONSTRAINT "membership_invitation_deliveries_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitation_deliveries" ADD CONSTRAINT "mid_invitation_fk" FOREIGN KEY ("tenant_id","invitation_id") REFERENCES "public"."membership_invitations"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE public.membership_invitation_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.membership_invitation_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE public.membership_invitation_deliveries
	FROM PUBLIC, tallermecario_api, tallermecario_worker, tallermecario_bootstrap_resolver;
--> statement-breakpoint
-- The generic ADR-009 tenant policies (Sprint 0 gate: every tenant table is
-- tenant-scoped for both runtime roles), deliberately WITHOUT tenant_update.
-- Policies grant nothing by themselves: the only table privilege is SELECT for
-- the API (the invoker lifecycle trigger must see the lease of the tenant it
-- is updating). The worker has no privilege at all; INSERT/UPDATE by runtime
-- roles is impossible (no grant, and no UPDATE policy under FORCE RLS).
CREATE POLICY tenant_select ON public.membership_invitation_deliveries
	FOR SELECT TO tallermecario_api, tallermecario_worker
	USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON public.membership_invitation_deliveries
	FOR INSERT TO tallermecario_api, tallermecario_worker
	WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON TABLE public.membership_invitation_deliveries TO tallermecario_api;
--> statement-breakpoint

-- Definer-owner privileges: column-level only, exactly what the three
-- functions below read/write. The resolver is BYPASSRLS (ADR-009 §7); each
-- function derives the tenant from the claimed outbox job, never a parameter.
GRANT SELECT (
		tenant_id, invitation_id, lease_id, lease_outbox_event_id, lease_attempt,
		lease_acquired_at, lease_expires_at, lease_count, sent_at, provider_message_id
	),
	INSERT (
		tenant_id, invitation_id, lease_id, lease_outbox_event_id, lease_attempt,
		lease_acquired_at, lease_expires_at, lease_count
	),
	UPDATE (
		lease_id, lease_outbox_event_id, lease_attempt, lease_acquired_at, lease_expires_at,
		lease_count, sent_at, provider_message_id, updated_at
	)
	ON TABLE public.membership_invitation_deliveries TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
-- Read-only: the lease functions check status/validity. Never UPDATE here.
GRANT SELECT (status, expires_at)
	ON TABLE public.membership_invitations TO tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- Same body as 0008 plus the delivery-lease guard on pending -> terminal.
-- Still SECURITY INVOKER (see 0008 for why).
CREATE OR REPLACE FUNCTION app.enforce_membership_invitation_lifecycle()
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

	-- S104-03: no terminal transition while an email delivery holds a valid
	-- lease. The advisory lock serializes with the worker's lease functions;
	-- each statement below then reads committed state (READ COMMITTED).
	IF NEW.status <> 'pending' THEN
		PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
			'tallermecario.membership_invitation.delivery/' || OLD.id::text, 0));
		IF EXISTS (
			SELECT 1 FROM public.membership_invitation_deliveries AS d
			WHERE d.tenant_id = OLD.tenant_id
				AND d.invitation_id = OLD.id
				AND d.lease_expires_at > pg_catalog.clock_timestamp()
		) THEN
			RAISE EXCEPTION 'membership invitation email delivery in progress'
				USING ERRCODE = 'object_in_use', CONSTRAINT = 'mi_delivery_in_progress';
		END IF;
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
REVOKE ALL ON FUNCTION app.enforce_membership_invitation_lifecycle() FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- PHASE B, before any network call. Outcomes:
--   acquired            lease written; send allowed until lease_until
--   skip_accepted|skip_revoked|skip_expired
--                       terminal, or would expire before the lease ends
--   already_sent        the provider acceptance is already recorded
--   busy                another unexpired lease exists (never taken over)
--   not_claimed         the job is not currently claimed ('processing')
--   not_found           no such invitation for the job's tenant
-- prior_attempt_unconfirmed: an earlier lease ended without a recorded
-- provider result (crash / ambiguous failure / lost completion).
CREATE FUNCTION app.worker_acquire_invitation_email_lease(
	p_outbox_event_id uuid,
	p_lease_id uuid,
	p_lease_seconds integer
)
RETURNS TABLE (
	lease_outcome text,
	lease_until timestamptz,
	prior_attempt_unconfirmed boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_tenant_id uuid;
	v_invitation_id uuid;
	v_attempt integer;
	v_status text;
	v_expires_at timestamptz;
	v_exists boolean;
	v_current_lease uuid;
	v_current_until timestamptz;
	v_sent_at timestamptz;
	v_now timestamptz;
	v_until timestamptz;
BEGIN
	IF p_lease_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds < 2 OR p_lease_seconds > 120 THEN
		RAISE EXCEPTION 'invalid invitation email lease request'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;

	-- The owner is a job claimed right now; tenant and invitation come from it.
	SELECT o.tenant_id, o.aggregate_id, o.attempts
	INTO v_tenant_id, v_invitation_id, v_attempt
	FROM public.outbox_events AS o
	WHERE o.id = p_outbox_event_id
		AND o.status = 'processing'
		AND o.event_type = 'membership.invitation_email_requested'
		AND o.aggregate_type = 'membership_invitation'
		AND o.tenant_id IS NOT NULL
		AND o.aggregate_id IS NOT NULL;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'not_claimed'::text, NULL::timestamptz, false;
		RETURN;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'tallermecario.membership_invitation.delivery/' || v_invitation_id::text, 0));

	SELECT i.status, i.expires_at INTO v_status, v_expires_at
	FROM public.membership_invitations AS i
	WHERE i.tenant_id = v_tenant_id AND i.id = v_invitation_id;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'not_found'::text, NULL::timestamptz, false;
		RETURN;
	END IF;

	SELECT d.lease_id, d.lease_expires_at, d.sent_at
	INTO v_current_lease, v_current_until, v_sent_at
	FROM public.membership_invitation_deliveries AS d
	WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id
	FOR UPDATE;
	v_exists := FOUND;

	IF v_exists AND v_sent_at IS NOT NULL THEN
		RETURN QUERY SELECT 'already_sent'::text, NULL::timestamptz, false;
		RETURN;
	END IF;

	v_now := pg_catalog.clock_timestamp();
	IF v_status <> 'pending' THEN
		RETURN QUERY SELECT ('skip_' || v_status)::text, NULL::timestamptz, (v_exists AND v_current_lease IS NOT NULL);
		RETURN;
	END IF;
	IF v_exists AND v_current_lease IS NOT NULL AND v_current_until > v_now THEN
		RETURN QUERY SELECT 'busy'::text, NULL::timestamptz, false;
		RETURN;
	END IF;
	v_until := v_now + pg_catalog.make_interval(secs => p_lease_seconds);
	IF v_expires_at <= v_until THEN
		RETURN QUERY SELECT 'skip_expired'::text, NULL::timestamptz, (v_exists AND v_current_lease IS NOT NULL);
		RETURN;
	END IF;

	IF v_exists THEN
		UPDATE public.membership_invitation_deliveries AS d
		SET lease_id = p_lease_id,
			lease_outbox_event_id = p_outbox_event_id,
			lease_attempt = v_attempt,
			lease_acquired_at = v_now,
			lease_expires_at = v_until,
			lease_count = d.lease_count + 1,
			updated_at = v_now
		WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id;
	ELSE
		INSERT INTO public.membership_invitation_deliveries (
			tenant_id, invitation_id, lease_id, lease_outbox_event_id, lease_attempt,
			lease_acquired_at, lease_expires_at, lease_count
		) VALUES (
			v_tenant_id, v_invitation_id, p_lease_id, p_outbox_event_id, v_attempt,
			v_now, v_until, 1
		);
	END IF;

	RETURN QUERY SELECT 'acquired'::text, v_until, (v_exists AND v_current_lease IS NOT NULL);
END
$function$;
--> statement-breakpoint

-- PHASE C, inside the worker's completion transaction (same commit as the
-- audit row and the outbox `processed` transition). Records the provider
-- acceptance exactly once and releases this attempt's lease.
--   recorded            first recording; delivery_lease_state says whether
--                       this attempt still held a valid lease ('held'), let
--                       it lapse ('expired') or was superseded after lapse
--   already_recorded    idempotent no-op (the lease is released if ours)
CREATE FUNCTION app.worker_complete_invitation_email_delivery(
	p_outbox_event_id uuid,
	p_lease_id uuid,
	p_provider_message_id text
)
RETURNS TABLE (
	delivery_outcome text,
	delivery_lease_state text,
	delivery_invitation_status text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_tenant_id uuid;
	v_invitation_id uuid;
	v_current_lease uuid;
	v_current_until timestamptz;
	v_sent_at timestamptz;
	v_status text;
	v_state text;
	v_now timestamptz;
BEGIN
	IF p_lease_id IS NULL OR p_provider_message_id IS NULL
		OR pg_catalog.length(p_provider_message_id) NOT BETWEEN 1 AND 128 THEN
		RAISE EXCEPTION 'invalid invitation email delivery result'
			USING ERRCODE = 'invalid_parameter_value';
	END IF;

	SELECT o.tenant_id, o.aggregate_id INTO v_tenant_id, v_invitation_id
	FROM public.outbox_events AS o
	WHERE o.id = p_outbox_event_id
		AND o.status = 'processing'
		AND o.event_type = 'membership.invitation_email_requested'
		AND o.aggregate_type = 'membership_invitation'
		AND o.tenant_id IS NOT NULL
		AND o.aggregate_id IS NOT NULL;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'invitation email job is not claimed'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
		'tallermecario.membership_invitation.delivery/' || v_invitation_id::text, 0));

	SELECT d.lease_id, d.lease_expires_at, d.sent_at
	INTO v_current_lease, v_current_until, v_sent_at
	FROM public.membership_invitation_deliveries AS d
	WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'invitation email delivery lease missing'
			USING ERRCODE = 'object_not_in_prerequisite_state';
	END IF;

	SELECT i.status INTO v_status
	FROM public.membership_invitations AS i
	WHERE i.tenant_id = v_tenant_id AND i.id = v_invitation_id;

	v_now := pg_catalog.clock_timestamp();
	IF v_sent_at IS NOT NULL THEN
		UPDATE public.membership_invitation_deliveries AS d
		SET lease_id = NULL, lease_outbox_event_id = NULL, lease_attempt = NULL,
			lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = v_now
		WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id
			AND d.lease_id = p_lease_id;
		RETURN QUERY SELECT 'already_recorded'::text, NULL::text, v_status;
		RETURN;
	END IF;

	v_state := CASE
		WHEN v_current_lease IS DISTINCT FROM p_lease_id THEN 'superseded'
		WHEN v_current_until > v_now THEN 'held'
		ELSE 'expired'
	END;

	IF v_current_lease = p_lease_id THEN
		UPDATE public.membership_invitation_deliveries AS d
		SET sent_at = v_now, provider_message_id = p_provider_message_id,
			lease_id = NULL, lease_outbox_event_id = NULL, lease_attempt = NULL,
			lease_acquired_at = NULL, lease_expires_at = NULL, updated_at = v_now
		WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id;
	ELSE
		UPDATE public.membership_invitation_deliveries AS d
		SET sent_at = v_now, provider_message_id = p_provider_message_id, updated_at = v_now
		WHERE d.tenant_id = v_tenant_id AND d.invitation_id = v_invitation_id;
	END IF;

	RETURN QUERY SELECT 'recorded'::text, v_state, v_status;
END
$function$;
--> statement-breakpoint

-- Early release when no provider request is in flight for this attempt (no
-- request made, or the provider answered and definitively did not accept).
-- Never used after an ambiguous failure: that lease runs to expiry.
CREATE FUNCTION app.worker_release_invitation_email_lease(
	p_outbox_event_id uuid,
	p_lease_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_updated integer;
BEGIN
	UPDATE public.membership_invitation_deliveries AS d
	SET lease_id = NULL, lease_outbox_event_id = NULL, lease_attempt = NULL,
		lease_acquired_at = NULL, lease_expires_at = NULL,
		updated_at = pg_catalog.clock_timestamp()
	FROM public.outbox_events AS o
	WHERE o.id = p_outbox_event_id
		AND o.status = 'processing'
		AND o.event_type = 'membership.invitation_email_requested'
		AND o.aggregate_type = 'membership_invitation'
		AND d.tenant_id = o.tenant_id
		AND d.invitation_id = o.aggregate_id
		AND d.lease_id = p_lease_id
		AND d.lease_outbox_event_id = p_outbox_event_id
		AND d.sent_at IS NULL;
	GET DIAGNOSTICS v_updated = ROW_COUNT;
	RETURN v_updated > 0;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	app.worker_acquire_invitation_email_lease(uuid, uuid, integer),
	app.worker_complete_invitation_email_delivery(uuid, uuid, text),
	app.worker_release_invitation_email_lease(uuid, uuid)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.worker_acquire_invitation_email_lease(uuid, uuid, integer),
	app.worker_complete_invitation_email_delivery(uuid, uuid, text),
	app.worker_release_invitation_email_lease(uuid, uuid)
	TO tallermecario_worker;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
