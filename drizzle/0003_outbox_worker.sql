-- Sprint 0: outbox + worker end-to-end (ADR-004, ADR-009 §6/§7, Dic. 04 §7).
--
-- outbox_events is mixed-scope (tenant_id nullable) and is deliberately left
-- out of the generic tenant-RLS loop in 0000 — per Dic. 04 §11 it "requiere
-- policy/resolver por mixed/global scope; no una policy tenant genérica".
-- This migration gives it two narrow, purpose-built access paths instead:
--
--   1. Enqueue (business code, under TenantContext): a normal tenant-scoped
--      RLS INSERT policy + column-restricted GRANT. The caller already knows
--      its own tenant_id; this only covers tenant-owned events. A NULL
--      tenant_id ("evento global explícito") has no runtime writer yet and
--      stays out of scope for this PoC.
--   2. Claim / read / complete (worker): SECURITY DEFINER functions owned by
--      tallermecario_bootstrap_resolver, the same allowlisted-function
--      pattern 0000 already uses for every other flow that runs before/
--      without a resolved TenantContext. `bootstrap_claim_outbox_events`
--      already exists (0000); this migration adds the read-payload,
--      complete-job and stall-recovery counterparts.
--
-- Runtime never gets SELECT/UPDATE/DELETE on the raw table: every lifecycle
-- transition goes through worker_complete_outbox_event, so `status`,
-- `attempts`, `available_at`, `processed_at` and `last_error` cannot be
-- forged directly by API or worker SQL.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.outbox_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_insert ON public.outbox_events
	FOR INSERT TO tallermecario_api, tallermecario_worker
	WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
-- Lets the publisher look up its own idempotency_key -> id mapping (e.g. to
-- report "already enqueued") without exposing payload/lifecycle columns.
CREATE POLICY tenant_select ON public.outbox_events
	FOR SELECT TO tallermecario_api, tallermecario_worker
	USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
GRANT INSERT (
		id, tenant_id, aggregate_type, aggregate_id, event_type, event_version,
		payload_json, idempotency_key
	)
	ON TABLE public.outbox_events TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT SELECT (
		id, tenant_id, aggregate_type, aggregate_id, event_type, event_version,
		idempotency_key, status, attempts, created_at
	)
	ON TABLE public.outbox_events TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint

-- 0000 granted bootstrap_resolver only the columns its original functions
-- needed (id, tenant_id, status, available_at, attempts). The new functions
-- below read/write more of the row; extend the same column-level grants
-- rather than widening to the whole table. SELECT is required even on the
-- write-only-looking columns because worker_complete_outbox_event's CASE
-- expressions read the old value back (`ELSE o.processed_at END`, etc.) to
-- leave it untouched on outcomes that don't set it.
GRANT SELECT (
		aggregate_type, aggregate_id, event_type, event_version, payload_json,
		idempotency_key, updated_at, processed_at, available_at, last_error
	)
	ON TABLE public.outbox_events TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT UPDATE (processed_at, available_at, last_error)
	ON TABLE public.outbox_events TO tallermecario_bootstrap_resolver;
--> statement-breakpoint

GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- Worker reads a claimed job's full payload. Only a row this/any worker
-- currently owns (status='processing') is visible: pending/processed/failed/
-- dead_letter rows cannot be peeked outside the claim -> get -> complete
-- sequence, so the queue's contents stay opaque to everything else.
CREATE FUNCTION app.worker_get_outbox_event(p_id uuid)
RETURNS TABLE (
	id uuid,
	tenant_id uuid,
	aggregate_type varchar(80),
	aggregate_id uuid,
	event_type varchar(120),
	event_version smallint,
	payload_json jsonb,
	idempotency_key uuid,
	attempts integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT o.id, o.tenant_id, o.aggregate_type, o.aggregate_id, o.event_type,
		o.event_version, o.payload_json, o.idempotency_key, o.attempts
	FROM public.outbox_events AS o
	WHERE o.id = p_id AND o.status = 'processing'
$function$;
--> statement-breakpoint

-- Terminal/retry transition for a claimed job. Only a row still 'processing'
-- is transitioned (returns false otherwise), so a duplicate/late call -- e.g.
-- a crashed worker's completion racing a stall-requeue -- is a safe no-op
-- rather than a double effect.
CREATE FUNCTION app.worker_complete_outbox_event(
	p_id uuid,
	p_outcome text,
	p_error text DEFAULT NULL,
	p_retry_delay_seconds integer DEFAULT 0
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_updated integer;
BEGIN
	IF p_outcome NOT IN ('processed', 'retry', 'failed', 'dead_letter') THEN
		RAISE EXCEPTION 'invalid outbox outcome %', p_outcome
			USING ERRCODE = 'invalid_parameter_value';
	END IF;

	UPDATE public.outbox_events AS o
	SET status = CASE WHEN p_outcome = 'retry' THEN 'pending' ELSE p_outcome END,
		processed_at = CASE WHEN p_outcome = 'processed' THEN pg_catalog.clock_timestamp() ELSE o.processed_at END,
		available_at = CASE WHEN p_outcome = 'retry'
			THEN pg_catalog.clock_timestamp()
				+ pg_catalog.make_interval(secs => GREATEST(COALESCE(p_retry_delay_seconds, 0), 0))
			ELSE o.available_at END,
		last_error = CASE WHEN p_outcome = 'processed' THEN NULL ELSE p_error END,
		updated_at = pg_catalog.clock_timestamp()
	WHERE o.id = p_id AND o.status = 'processing';
	GET DIAGNOSTICS v_updated = ROW_COUNT;
	RETURN v_updated > 0;
END
$function$;
--> statement-breakpoint

-- Worker-restart recovery ("worker restart es recuperable", ADR-004 Quality
-- Gate): a job left in 'processing' past the visibility timeout (crash,
-- kill -9, lost connection) returns to 'pending' without touching `attempts`
-- -- the crash was infrastructure's fault, not the job's -- so it gets
-- reclaimed and reprocessed by any worker.
CREATE FUNCTION app.worker_requeue_stalled_outbox_events(
	p_stall_seconds integer DEFAULT 300,
	p_batch_size integer DEFAULT 100
)
RETURNS TABLE (
	outbox_event_id uuid,
	tenant_id uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	WITH stalled AS (
		SELECT o.id
		FROM public.outbox_events AS o
		WHERE o.status = 'processing'
			AND o.updated_at < pg_catalog.clock_timestamp()
				- pg_catalog.make_interval(secs => GREATEST(COALESCE(p_stall_seconds, 0), 0))
		ORDER BY o.updated_at
		FOR UPDATE SKIP LOCKED
		LIMIT CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 0 END
	), requeued AS (
		UPDATE public.outbox_events AS o
		SET status = 'pending',
			last_error = COALESCE(o.last_error, 'requeued after worker stall'),
			updated_at = pg_catalog.clock_timestamp()
		FROM stalled AS s
		WHERE o.id = s.id
		RETURNING o.id, o.tenant_id
	)
	SELECT r.id, r.tenant_id FROM requeued AS r
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.worker_get_outbox_event(uuid),
	app.worker_complete_outbox_event(uuid, text, text, integer),
	app.worker_requeue_stalled_outbox_events(integer, integer)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.worker_get_outbox_event(uuid),
	app.worker_complete_outbox_event(uuid, text, text, integer),
	app.worker_requeue_stalled_outbox_events(integer, integer)
	TO tallermecario_worker;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
