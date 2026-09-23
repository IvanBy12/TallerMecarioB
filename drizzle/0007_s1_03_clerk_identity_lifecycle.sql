-- S1-03 Clerk identity lifecycle (ADR-006 §7/§14, ADR-009 §2/§7/§8, Dic. 04 §5-§7).
--
--   * identity_sync_states: global technical state per (identity_provider,
--     external_subject): last applied provider event position (monotonic
--     ordering), derived local lifecycle (active | blocked | deleted) and the
--     tombstone. No profile, no provider payload. No runtime grant at all.
--   * tallermecario_identity_sync: NEW NOLOGIN, NOBYPASSRLS, NOINHERIT owner of
--     the identity-sync SECURITY DEFINER functions. Webhook sync must UPDATE
--     users.email/full_name/status; the S1-01 audit pinned the BYPASSRLS
--     bootstrap resolver to never hold those privileges, so they live in a
--     separate least-privilege role instead of widening the resolver.
--   * Cross-tenant/pre-tenant READS stay with tallermecario_bootstrap_resolver
--     (ADR-009 §7): listing a user's memberships for revocation fan-out and
--     writing tenant-less identity audit rows through allowlisted functions.
--   * Per-tenant membership revocation is NOT done here: it is fanned out as
--     one outbox job per tenant and processed by the worker under that
--     tenant's TenantContext + RLS (ADR-009 §9).
--
-- Like 0000, creating a role requires a CREATEROLE-capable migration runner
-- (local/CI database owner); runtime roles never become members of it.

DO $identity_sync_role$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_identity_sync') THEN
		CREATE ROLE tallermecario_identity_sync;
	END IF;
END
$identity_sync_role$;
--> statement-breakpoint
ALTER ROLE tallermecario_identity_sync WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
DO $identity_sync_isolation$
DECLARE
	membership record;
BEGIN
	FOR membership IN
		SELECT member.rolname AS member_role
		FROM pg_catalog.pg_auth_members AS relation
		JOIN pg_catalog.pg_roles AS granted ON granted.oid = relation.roleid
		JOIN pg_catalog.pg_roles AS member ON member.oid = relation.member
		WHERE granted.rolname = 'tallermecario_identity_sync'
			AND member.rolname IN ('tallermecario_api', 'tallermecario_worker', 'tallermecario_bootstrap_resolver')
	LOOP
		EXECUTE pg_catalog.format('REVOKE tallermecario_identity_sync FROM %I', membership.member_role);
	END LOOP;

	IF pg_catalog.pg_has_role('tallermecario_api', 'tallermecario_identity_sync', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_worker', 'tallermecario_identity_sync', 'SET') THEN
		RAISE EXCEPTION 'runtime role retains a SET ROLE path to tallermecario_identity_sync';
	END IF;
END
$identity_sync_isolation$;
--> statement-breakpoint

SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

CREATE TABLE "identity_sync_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identity_provider" varchar(32) NOT NULL,
	"external_subject" varchar(255) NOT NULL,
	"user_id" uuid,
	"lifecycle_state" varchar(16) DEFAULT 'active' NOT NULL,
	"last_event_id" varchar(128) NOT NULL,
	"last_event_type" varchar(64) NOT NULL,
	"last_event_occurred_at" timestamp with time zone NOT NULL,
	"last_event_rank" smallint NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_sync_states_identity_key" UNIQUE("identity_provider","external_subject"),
	CONSTRAINT "identity_sync_states_provider_check" CHECK ("identity_provider" IN ('clerk')),
	CONSTRAINT "identity_sync_states_lifecycle_check" CHECK ("lifecycle_state" IN ('active', 'blocked', 'deleted')),
	CONSTRAINT "identity_sync_states_rank_check" CHECK (last_event_rank IN (0, 1)),
	CONSTRAINT "identity_sync_states_tombstone_check" CHECK ((lifecycle_state = 'deleted') = (deleted_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "identity_sync_states" ADD CONSTRAINT "identity_sync_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_sync_states_user_idx" ON "identity_sync_states" USING btree ("user_id");
--> statement-breakpoint

-- Global identity-sync internals: never navigable by API/worker directly.
REVOKE ALL ON TABLE public.identity_sync_states
	FROM PUBLIC, tallermecario_api, tallermecario_worker, tallermecario_bootstrap_resolver;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public, app TO tallermecario_identity_sync;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.identity_sync_states TO tallermecario_identity_sync;
--> statement-breakpoint
-- users is global and has no RLS (ADR-009 §6.3); column-scoped writes only.
-- Deliberately no DELETE: a provider deletion is a local disable + tombstone.
GRANT SELECT (id, identity_provider, external_subject, email, full_name, status),
	INSERT (id, identity_provider, external_subject, email, full_name, status),
	UPDATE (email, full_name, status, updated_at)
	ON TABLE public.users TO tallermecario_identity_sync;
--> statement-breakpoint
GRANT SELECT (id, provider, provider_event_id, payload_hash),
	INSERT (id, provider, provider_event_id, tenant_id, payload_hash, payload_json, headers_json)
	ON TABLE public.webhook_events TO tallermecario_identity_sync;
--> statement-breakpoint
-- SELECT on the two arbiter columns is required by ON CONFLICT (...) DO NOTHING.
GRANT SELECT (webhook_event_id, attempt_number),
	INSERT (
		id, webhook_event_id, attempt_number, status, started_at, finished_at,
		last_error_code, last_error_message, worker_id, request_id
	)
	ON TABLE public.webhook_processing_attempts TO tallermecario_identity_sync;
--> statement-breakpoint
GRANT INSERT (
	id, tenant_id, aggregate_type, aggregate_id, event_type,
	event_version, payload_json, idempotency_key
)
	ON TABLE public.outbox_events TO tallermecario_identity_sync;
--> statement-breakpoint
-- Exactly the two outbox shapes identity sync may enqueue: the tenant-less
-- lifecycle job (ingest) and the per-tenant membership revocation fan-out.
CREATE POLICY identity_sync_insert ON public.outbox_events
	FOR INSERT TO tallermecario_identity_sync
	WITH CHECK (
		(
			tenant_id IS NULL
			AND aggregate_type = 'identity_subject'
			AND aggregate_id IS NULL
			AND event_type = 'identity.provider_user_lifecycle_received'
			AND idempotency_key IS NOT NULL
			AND payload_json ->> 'provider' = 'clerk'
		)
		OR (
			tenant_id IS NOT NULL
			AND aggregate_type = 'membership'
			AND aggregate_id IS NOT NULL
			AND event_type = 'identity.membership_revocation_requested'
			AND payload_json ->> 'reason' = 'identity_provider_user_deleted'
		)
	);
--> statement-breakpoint

-- The JIT function (resolver-owned) must see the tombstone/block state.
GRANT SELECT (identity_provider, external_subject, lifecycle_state)
	ON TABLE public.identity_sync_states TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver, tallermecario_identity_sync;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- Fan-out source for user.deleted: the deleted user's non-revoked
-- memberships across tenants (ids only). Only identity sync may call it.
CREATE FUNCTION app.bootstrap_list_user_memberships_for_revocation(p_user_id uuid)
RETURNS TABLE (
	membership_id uuid,
	tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT m.id, m.tenant_id
	FROM public.memberships AS m
	WHERE m.user_id = p_user_id
		AND m.status IN ('active', 'suspended')
	ORDER BY m.tenant_id, m.id
$function$;
--> statement-breakpoint

-- Tenant-less identity audit rows (actor = provider). Reuses exactly the
-- audit_logs column privileges the resolver already holds since 0005; the
-- action/entity allowlist keeps it from becoming a generic audit writer.
CREATE FUNCTION app.bootstrap_append_identity_audit(
	p_action text,
	p_outcome text,
	p_entity_type text,
	p_entity_id uuid,
	p_metadata jsonb,
	p_request_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
	IF p_action NOT IN (
			'identity.user_provisioned_webhook',
			'identity.user_profile_synced',
			'identity.user_disabled',
			'identity.user_deleted',
			'identity.webhook_event_conflict'
		)
		OR p_outcome NOT IN ('success', 'denied', 'failed')
		OR p_entity_type NOT IN ('user', 'webhook_event')
		OR p_entity_id IS NULL
		OR p_request_id IS NULL OR p_request_id = '' OR pg_catalog.length(p_request_id) > 128 THEN
		RAISE EXCEPTION 'IDENTITY_AUDIT_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	INSERT INTO public.audit_logs (
		id, tenant_id, actor_type, actor_user_id, action, outcome,
		entity_type, entity_id, metadata_json, request_id
	) VALUES (
		pg_catalog.uuidv7(), NULL, 'provider', NULL, p_action, p_outcome,
		p_entity_type, p_entity_id, p_metadata, p_request_id
	);
END
$function$;
--> statement-breakpoint

-- JIT (S1-01) gains two guards; signature, owner, search_path, column
-- privileges and audit contract are unchanged:
--   1. the per-identity advisory lock shared with app.identity_sync_apply, so
--      JIT and webhook reconciliation of the same subject are serialized;
--   2. a blocked/deleted identity (ban or tombstone already applied) is never
--      (re)provisioned: no row is created and 'disabled' is reported, so a
--      stale session or a late JIT cannot resurrect it.
CREATE OR REPLACE FUNCTION app.bootstrap_provision_user(
	p_identity_provider text,
	p_external_subject text,
	p_proposed_user_id uuid,
	p_email text,
	p_full_name text,
	p_request_id text
)
RETURNS TABLE (
	user_id uuid,
	user_status text,
	provisioned boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_user_id uuid;
	v_user_status text;
	v_provisioned boolean := false;
	v_lifecycle text;
BEGIN
	IF p_identity_provider IS NULL OR p_identity_provider <> 'clerk'
		OR p_external_subject IS NULL OR p_external_subject = '' OR pg_catalog.length(p_external_subject) > 255
		OR p_proposed_user_id IS NULL
		OR p_email IS NULL OR p_email = '' OR pg_catalog.length(p_email) > 320
		OR pg_catalog.strpos(p_email, '@') = 0
		OR (p_full_name IS NOT NULL AND pg_catalog.length(p_full_name) > 200)
		OR p_request_id IS NULL OR p_request_id = '' OR pg_catalog.length(p_request_id) > 128 THEN
		RAISE EXCEPTION 'BOOTSTRAP_USER_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('tallermecario:identity:' || p_identity_provider || ':' || p_external_subject, 0)
	);

	SELECT s.lifecycle_state
	INTO v_lifecycle
	FROM public.identity_sync_states AS s
	WHERE s.identity_provider = p_identity_provider
		AND s.external_subject = p_external_subject;

	IF v_lifecycle IN ('blocked', 'deleted') THEN
		SELECT u.id, u.status
		INTO v_user_id, v_user_status
		FROM public.users AS u
		WHERE u.identity_provider = p_identity_provider
			AND u.external_subject = p_external_subject;
		RETURN QUERY SELECT v_user_id, 'disabled'::text, false;
		RETURN;
	END IF;

	-- `status` is intentionally omitted: the column default ('active') is
	-- always correct at JIT-provisioning time, and this role holds no
	-- INSERT privilege on it (see 0005).
	INSERT INTO public.users (
		id, identity_provider, external_subject, email, full_name
	) VALUES (
		p_proposed_user_id, p_identity_provider, p_external_subject,
		p_email, p_full_name
	)
	ON CONFLICT ON CONSTRAINT users_identity_key DO NOTHING
	RETURNING id, status, true
	INTO v_user_id, v_user_status, v_provisioned;

	IF v_user_id IS NULL THEN
		SELECT id, status
		INTO v_user_id, v_user_status
		FROM public.users
		WHERE identity_provider = p_identity_provider
			AND external_subject = p_external_subject;
		v_provisioned := false;

		IF v_user_id IS NULL THEN
			RAISE EXCEPTION 'BOOTSTRAP_USER_RESULT_MISSING' USING ERRCODE = 'P0001';
		END IF;
	END IF;

	IF v_provisioned THEN
		INSERT INTO public.audit_logs (
			id, tenant_id, actor_type, actor_user_id, action, outcome,
			entity_type, entity_id, metadata_json, request_id
		) VALUES (
			p_proposed_user_id, NULL, 'user', v_user_id,
			'identity.user_provisioned_jit', 'success', 'user', v_user_id,
			pg_catalog.jsonb_build_object('identity_provider', p_identity_provider),
			p_request_id
		);
	END IF;

	RETURN QUERY SELECT v_user_id, v_user_status, v_provisioned;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.bootstrap_list_user_memberships_for_revocation(uuid),
	app.bootstrap_append_identity_audit(text, text, text, uuid, jsonb, text)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.bootstrap_list_user_memberships_for_revocation(uuid),
	app.bootstrap_append_identity_audit(text, text, text, uuid, jsonb, text)
	TO tallermecario_identity_sync;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_identity_sync;
--> statement-breakpoint

-- Thin webhook ingest (API, after Svix signature verification): durable
-- minimal projection in webhook_events + the lifecycle outbox job, in ONE
-- transaction. svix-id is the transport identity (provider_event_id), never
-- the Clerk user id. Same svix-id + same raw-body hash = idempotent
-- duplicate; same svix-id + different hash = conflict (fail closed, audited,
-- nothing enqueued).
CREATE FUNCTION app.ingest_verified_clerk_webhook(
	p_webhook_event_id uuid,
	p_outbox_event_id uuid,
	p_provider_event_id text,
	p_payload_hash text,
	p_provider_event_type text,
	p_external_subject text,
	p_occurred_at timestamptz,
	p_headers_json jsonb,
	p_request_id text
)
RETURNS TABLE (
	result text,
	webhook_event_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_stored_id uuid;
	v_stored_hash text;
BEGIN
	IF p_webhook_event_id IS NULL OR p_outbox_event_id IS NULL
		OR p_provider_event_id IS NULL OR p_provider_event_id = '' OR pg_catalog.length(p_provider_event_id) > 128
		OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
		OR p_provider_event_type IS NULL OR p_provider_event_type NOT IN (
			'user.created', 'user.updated', 'user.deleted',
			'user.banned', 'user.unbanned', 'user.locked', 'user.unlocked'
		)
		OR p_external_subject IS NULL OR p_external_subject = '' OR pg_catalog.length(p_external_subject) > 255
		OR p_occurred_at IS NULL
		OR p_request_id IS NULL OR p_request_id = '' OR pg_catalog.length(p_request_id) > 128 THEN
		RAISE EXCEPTION 'CLERK_INGEST_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	INSERT INTO public.webhook_events (
		id, provider, provider_event_id, tenant_id, payload_hash, payload_json, headers_json
	) VALUES (
		p_webhook_event_id, 'clerk', p_provider_event_id, NULL, p_payload_hash,
		pg_catalog.jsonb_build_object(
			'object', 'event',
			'type', p_provider_event_type,
			'data', pg_catalog.jsonb_build_object('id', p_external_subject),
			'occurred_at', p_occurred_at
		),
		p_headers_json
	)
	ON CONFLICT ON CONSTRAINT webhook_events_provider_event_key DO NOTHING
	RETURNING id INTO v_stored_id;

	IF v_stored_id IS NOT NULL THEN
		INSERT INTO public.outbox_events (
			id, tenant_id, aggregate_type, aggregate_id, event_type,
			event_version, payload_json, idempotency_key
		) VALUES (
			p_outbox_event_id, NULL, 'identity_subject', NULL,
			'identity.provider_user_lifecycle_received', 1,
			pg_catalog.jsonb_build_object(
				'type', 'identity.provider_user_lifecycle_received',
				'version', 1,
				'provider', 'clerk',
				'external_subject', p_external_subject,
				'provider_event_type', p_provider_event_type,
				'provider_event_id', p_provider_event_id,
				'occurred_at', p_occurred_at,
				'webhook_event_id', p_webhook_event_id
			),
			p_webhook_event_id
		);
		RETURN QUERY SELECT 'accepted'::text, v_stored_id;
		RETURN;
	END IF;

	SELECT w.id, w.payload_hash
	INTO v_stored_id, v_stored_hash
	FROM public.webhook_events AS w
	WHERE w.provider = 'clerk' AND w.provider_event_id = p_provider_event_id;
	IF v_stored_id IS NULL THEN
		RAISE EXCEPTION 'CLERK_INGEST_CONFLICT_WITHOUT_ROW' USING ERRCODE = 'P0001';
	END IF;

	IF v_stored_hash = p_payload_hash THEN
		RETURN QUERY SELECT 'duplicate'::text, v_stored_id;
		RETURN;
	END IF;

	PERFORM app.bootstrap_append_identity_audit(
		'identity.webhook_event_conflict', 'denied', 'webhook_event', v_stored_id,
		pg_catalog.jsonb_build_object('identity_provider', 'clerk', 'reason', 'payload_hash_mismatch'),
		p_request_id
	);
	RETURN QUERY SELECT 'conflict'::text, v_stored_id;
END
$function$;
--> statement-breakpoint

-- Cheap pre-network ordering check for the worker (autocommit statement; the
-- authoritative check is repeated under lock inside app.identity_sync_apply).
-- Ordering key: (occurred_at, rank, provider_event_id COLLATE "C") where
-- rank(user.deleted) = 1 > rank(any other) = 0, so at equal timestamps a
-- deletion dominates and the tie-break is deterministic.
CREATE FUNCTION app.identity_sync_classify(
	p_identity_provider text,
	p_external_subject text,
	p_provider_event_id text,
	p_provider_event_type text,
	p_occurred_at timestamptz
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
	SELECT CASE
		WHEN s.id IS NULL THEN 'fresh'
		WHEN s.last_event_id = p_provider_event_id THEN 'duplicate'
		WHEN (p_occurred_at,
				CASE WHEN p_provider_event_type = 'user.deleted' THEN 1 ELSE 0 END,
				p_provider_event_id COLLATE "C")
			<= (s.last_event_occurred_at, s.last_event_rank::integer, s.last_event_id COLLATE "C")
			THEN 'stale'
		WHEN s.lifecycle_state = 'deleted' THEN 'tombstoned'
		ELSE 'fresh'
	END
	FROM (SELECT 1) AS one
	LEFT JOIN public.identity_sync_states AS s
		ON s.identity_provider = p_identity_provider
		AND s.external_subject = p_external_subject
$function$;
--> statement-breakpoint

-- PHASE C of the lifecycle job: runs in a NEW short transaction AFTER the
-- provider fetch (never across it). Serializes on the per-identity advisory
-- lock (shared with JIT), locks + re-reads the sync state, discards stale or
-- duplicate work, then applies the provider snapshot:
--   snapshot   -> reconcile/provision users (verified primary email +
--                 sanitized full_name only); banned => disabled + 'blocked';
--                 unbanned/locked/unlocked never (re)activate anything.
--   not_found  -> provider says the subject no longer exists => tombstone.
--   deleted    -> tombstone.
-- Tombstone = users.status 'disabled' (never DELETE) + one per-tenant
-- membership revocation job + lifecycle 'deleted' (terminal).
CREATE FUNCTION app.identity_sync_apply(
	p_identity_provider text,
	p_external_subject text,
	p_provider_event_id text,
	p_provider_event_type text,
	p_occurred_at timestamptz,
	p_webhook_event_id uuid,
	p_observation text,
	p_email text,
	p_full_name text,
	p_banned boolean,
	p_proposed_user_id uuid,
	p_proposed_state_id uuid,
	p_request_id text
)
RETURNS TABLE (
	result text,
	user_id uuid,
	lifecycle_state text,
	revocations_enqueued integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_rank integer;
	v_state_id uuid;
	v_state_lifecycle text;
	v_state_event_id text;
	v_state_occurred_at timestamptz;
	v_state_rank integer;
	v_state_user_id uuid;
	v_user_id uuid;
	v_user_status text;
	v_user_email text;
	v_user_full_name text;
	v_lifecycle text;
	v_result text;
	v_changed text[] := ARRAY[]::text[];
	v_new_status text;
	v_revocations integer := 0;
	v_membership record;
BEGIN
	IF p_identity_provider IS NULL OR p_identity_provider <> 'clerk'
		OR p_external_subject IS NULL OR p_external_subject = '' OR pg_catalog.length(p_external_subject) > 255
		OR p_provider_event_id IS NULL OR p_provider_event_id = '' OR pg_catalog.length(p_provider_event_id) > 128
		OR p_provider_event_type IS NULL OR p_provider_event_type NOT IN (
			'user.created', 'user.updated', 'user.deleted',
			'user.banned', 'user.unbanned', 'user.locked', 'user.unlocked'
		)
		OR p_occurred_at IS NULL OR p_webhook_event_id IS NULL
		OR p_observation IS NULL OR p_observation NOT IN ('snapshot', 'not_found', 'deleted')
		OR (p_observation = 'deleted') <> (p_provider_event_type = 'user.deleted')
		OR (p_observation = 'snapshot' AND p_banned IS NULL)
		OR (p_email IS NOT NULL AND (p_email = '' OR pg_catalog.length(p_email) > 320 OR pg_catalog.strpos(p_email, '@') = 0))
		OR (p_full_name IS NOT NULL AND pg_catalog.length(p_full_name) > 200)
		OR p_proposed_user_id IS NULL OR p_proposed_state_id IS NULL
		OR p_request_id IS NULL OR p_request_id = '' OR pg_catalog.length(p_request_id) > 128 THEN
		RAISE EXCEPTION 'IDENTITY_SYNC_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	v_rank := CASE WHEN p_provider_event_type = 'user.deleted' THEN 1 ELSE 0 END;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended('tallermecario:identity:' || p_identity_provider || ':' || p_external_subject, 0)
	);

	SELECT s.id, s.lifecycle_state, s.last_event_id, s.last_event_occurred_at, s.last_event_rank, s.user_id
	INTO v_state_id, v_state_lifecycle, v_state_event_id, v_state_occurred_at, v_state_rank, v_state_user_id
	FROM public.identity_sync_states AS s
	WHERE s.identity_provider = p_identity_provider
		AND s.external_subject = p_external_subject
	FOR UPDATE;

	IF v_state_id IS NOT NULL THEN
		IF v_state_event_id = p_provider_event_id THEN
			RETURN QUERY SELECT 'duplicate'::text, v_state_user_id, v_state_lifecycle, 0;
			RETURN;
		END IF;
		IF (p_occurred_at, v_rank, p_provider_event_id COLLATE "C")
			<= (v_state_occurred_at, v_state_rank, v_state_event_id COLLATE "C") THEN
			RETURN QUERY SELECT 'stale'::text, v_state_user_id, v_state_lifecycle, 0;
			RETURN;
		END IF;
		IF v_state_lifecycle = 'deleted' THEN
			RETURN QUERY SELECT 'tombstoned'::text, v_state_user_id, v_state_lifecycle, 0;
			RETURN;
		END IF;
	END IF;

	v_lifecycle := COALESCE(v_state_lifecycle, 'active');

	SELECT u.id, u.status, u.email, u.full_name
	INTO v_user_id, v_user_status, v_user_email, v_user_full_name
	FROM public.users AS u
	WHERE u.identity_provider = p_identity_provider
		AND u.external_subject = p_external_subject
	FOR UPDATE;

	IF p_observation IN ('not_found', 'deleted') THEN
		IF v_user_id IS NOT NULL THEN
			IF v_user_status <> 'disabled' THEN
				UPDATE public.users
				SET status = 'disabled', updated_at = pg_catalog.clock_timestamp()
				WHERE id = v_user_id;
			END IF;

			FOR v_membership IN
				SELECT r.membership_id, r.tenant_id
				FROM app.bootstrap_list_user_memberships_for_revocation(v_user_id) AS r
			LOOP
				INSERT INTO public.outbox_events (
					id, tenant_id, aggregate_type, aggregate_id, event_type,
					event_version, payload_json, idempotency_key
				) VALUES (
					pg_catalog.uuidv7(), v_membership.tenant_id, 'membership', v_membership.membership_id,
					'identity.membership_revocation_requested', 1,
					pg_catalog.jsonb_build_object(
						'type', 'identity.membership_revocation_requested',
						'version', 1,
						'reason', 'identity_provider_user_deleted',
						'user_id', v_user_id,
						'membership_id', v_membership.membership_id,
						'webhook_event_id', p_webhook_event_id
					),
					NULL
				);
				v_revocations := v_revocations + 1;
			END LOOP;

			PERFORM app.bootstrap_append_identity_audit(
				'identity.user_deleted', 'success', 'user', v_user_id,
				pg_catalog.jsonb_build_object(
					'identity_provider', p_identity_provider,
					'provider_event_type', p_provider_event_type,
					'observation', p_observation,
					'previous_status', v_user_status,
					'membership_revocations_enqueued', v_revocations
				),
				p_request_id
			);
		END IF;
		v_lifecycle := 'deleted';
		v_result := 'tombstoned_applied';
	ELSE
		IF v_user_id IS NULL THEN
			IF p_email IS NULL THEN
				v_result := 'skipped_unverified_email';
			ELSE
				v_new_status := CASE WHEN p_banned OR v_lifecycle = 'blocked' THEN 'disabled' ELSE 'active' END;
				INSERT INTO public.users (
					id, identity_provider, external_subject, email, full_name, status
				) VALUES (
					p_proposed_user_id, p_identity_provider, p_external_subject,
					p_email, p_full_name, v_new_status
				)
				RETURNING id, status INTO v_user_id, v_user_status;

				PERFORM app.bootstrap_append_identity_audit(
					'identity.user_provisioned_webhook', 'success', 'user', v_user_id,
					pg_catalog.jsonb_build_object(
						'identity_provider', p_identity_provider,
						'provider_event_type', p_provider_event_type,
						'status', v_user_status
					),
					p_request_id
				);
				v_result := 'provisioned';
			END IF;
		ELSE
			IF p_email IS NOT NULL AND p_email IS DISTINCT FROM v_user_email THEN
				v_changed := v_changed || 'email'::text;
			END IF;
			IF p_full_name IS DISTINCT FROM v_user_full_name THEN
				v_changed := v_changed || 'full_name'::text;
			END IF;
			v_new_status := CASE WHEN p_banned THEN 'disabled' ELSE v_user_status END;

			IF pg_catalog.cardinality(v_changed) > 0 OR v_new_status <> v_user_status THEN
				UPDATE public.users
				SET email = CASE WHEN 'email' = ANY(v_changed) THEN p_email ELSE email END,
					full_name = CASE WHEN 'full_name' = ANY(v_changed) THEN p_full_name ELSE full_name END,
					status = v_new_status,
					updated_at = pg_catalog.clock_timestamp()
				WHERE id = v_user_id;
			END IF;

			IF pg_catalog.cardinality(v_changed) > 0 THEN
				PERFORM app.bootstrap_append_identity_audit(
					'identity.user_profile_synced', 'success', 'user', v_user_id,
					pg_catalog.jsonb_build_object(
						'identity_provider', p_identity_provider,
						'provider_event_type', p_provider_event_type,
						'changed_fields', pg_catalog.to_jsonb(v_changed)
					),
					p_request_id
				);
			END IF;
			IF v_new_status <> v_user_status THEN
				PERFORM app.bootstrap_append_identity_audit(
					'identity.user_disabled', 'success', 'user', v_user_id,
					pg_catalog.jsonb_build_object(
						'identity_provider', p_identity_provider,
						'provider_event_type', p_provider_event_type,
						'reason', 'provider_banned'
					),
					p_request_id
				);
			END IF;
			v_user_status := v_new_status;
			v_result := 'applied';
		END IF;

		-- A ban is durable locally; unban/lock/unlock never lift it here.
		IF p_banned THEN
			v_lifecycle := 'blocked';
		END IF;
	END IF;

	INSERT INTO public.identity_sync_states AS s (
		id, identity_provider, external_subject, user_id, lifecycle_state,
		last_event_id, last_event_type, last_event_occurred_at, last_event_rank, deleted_at
	) VALUES (
		p_proposed_state_id, p_identity_provider, p_external_subject, v_user_id, v_lifecycle,
		p_provider_event_id, p_provider_event_type, p_occurred_at, v_rank,
		CASE WHEN v_lifecycle = 'deleted' THEN p_occurred_at ELSE NULL END
	)
	ON CONFLICT ON CONSTRAINT identity_sync_states_identity_key DO UPDATE
	SET user_id = COALESCE(EXCLUDED.user_id, s.user_id),
		lifecycle_state = EXCLUDED.lifecycle_state,
		last_event_id = EXCLUDED.last_event_id,
		last_event_type = EXCLUDED.last_event_type,
		last_event_occurred_at = EXCLUDED.last_event_occurred_at,
		last_event_rank = EXCLUDED.last_event_rank,
		deleted_at = EXCLUDED.deleted_at,
		updated_at = pg_catalog.clock_timestamp();

	RETURN QUERY SELECT v_result, COALESCE(v_user_id, v_state_user_id), v_lifecycle, v_revocations;
END
$function$;
--> statement-breakpoint

-- webhook_processing_attempts for Clerk events (retries never modify the
-- append-only webhook_events row). attempt_number = outbox claim attempts; a
-- stall-requeue reuses the number, so a repeat is a no-op, not an error.
CREATE FUNCTION app.identity_sync_record_attempt(
	p_webhook_event_id uuid,
	p_attempt_number integer,
	p_status text,
	p_started_at timestamptz,
	p_error_code text,
	p_worker_id text,
	p_request_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
	IF p_webhook_event_id IS NULL
		OR p_attempt_number IS NULL OR p_attempt_number <= 0
		OR p_status NOT IN ('succeeded', 'retryable_error', 'permanent_error')
		OR p_started_at IS NULL
		OR (p_error_code IS NOT NULL AND (p_error_code !~ '^[A-Z0-9_]{1,120}$'))
		OR (p_worker_id IS NOT NULL AND pg_catalog.length(p_worker_id) > 160)
		OR (p_request_id IS NOT NULL AND pg_catalog.length(p_request_id) > 128) THEN
		RAISE EXCEPTION 'IDENTITY_ATTEMPT_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM public.webhook_events AS w
		WHERE w.id = p_webhook_event_id AND w.provider = 'clerk'
	) THEN
		RAISE EXCEPTION 'IDENTITY_ATTEMPT_WEBHOOK_EVENT_UNKNOWN' USING ERRCODE = '22023';
	END IF;

	INSERT INTO public.webhook_processing_attempts (
		id, webhook_event_id, attempt_number, status, started_at, finished_at,
		last_error_code, last_error_message, worker_id, request_id
	) VALUES (
		pg_catalog.uuidv7(), p_webhook_event_id, p_attempt_number, p_status,
		p_started_at, pg_catalog.clock_timestamp(), p_error_code, NULL, p_worker_id, p_request_id
	)
	ON CONFLICT ON CONSTRAINT wpa_event_attempt_key DO NOTHING;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.ingest_verified_clerk_webhook(uuid, uuid, text, text, text, text, timestamptz, jsonb, text),
	app.identity_sync_classify(text, text, text, text, timestamptz),
	app.identity_sync_apply(text, text, text, text, timestamptz, uuid, text, text, text, boolean, uuid, uuid, text),
	app.identity_sync_record_attempt(uuid, integer, text, timestamptz, text, text, text)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.ingest_verified_clerk_webhook(uuid, uuid, text, text, text, text, timestamptz, jsonb, text)
	TO tallermecario_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.identity_sync_classify(text, text, text, text, timestamptz),
	app.identity_sync_apply(text, text, text, text, timestamptz, uuid, text, text, text, boolean, uuid, uuid, text),
	app.identity_sync_record_attempt(uuid, integer, text, timestamptz, text, text, text)
	TO tallermecario_worker;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver, tallermecario_identity_sync;
--> statement-breakpoint
RESET ROLE;
