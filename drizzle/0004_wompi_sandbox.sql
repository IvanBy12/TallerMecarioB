SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

GRANT SELECT (id, tenant_id, provider, provider_event_id),
	INSERT (id, provider, provider_event_id, tenant_id, payload_hash, payload_json, headers_json)
	ON TABLE public.webhook_events TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT INSERT (
	id, tenant_id, aggregate_type, aggregate_id, event_type,
	event_version, payload_json, idempotency_key
)
	ON TABLE public.outbox_events TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
CREATE POLICY wompi_verified_insert ON public.outbox_events
	FOR INSERT TO tallermecario_bootstrap_resolver
	WITH CHECK (
		tenant_id IS NOT NULL
		AND aggregate_type = 'billing_payment'
		AND event_type = 'billing.provider_transaction_status_changed'
		AND idempotency_key IS NOT NULL
		AND payload_json ->> 'provider' = 'wompi'
	);
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE FUNCTION app.ingest_verified_wompi_webhook(
	p_webhook_event_id uuid,
	p_outbox_event_id uuid,
	p_provider_event_id text,
	p_payload_hash text,
	p_payload_json jsonb,
	p_headers_json jsonb,
	p_environment text,
	p_reference text,
	p_provider_transaction_id text,
	p_provider_status text,
	p_occurred_at timestamptz
)
RETURNS TABLE (
	webhook_event_id uuid,
	inserted boolean,
	tenant_id uuid
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_ref_tenant uuid;
	v_ref_payment uuid;
	v_ref_subscription uuid;
	v_tx_tenant uuid;
	v_tx_payment uuid;
	v_tx_subscription uuid;
	v_tenant uuid;
	v_payment uuid;
	v_subscription uuid;
	v_stored_id uuid;
	v_inserted boolean := false;
BEGIN
	IF p_environment NOT IN ('test', 'production')
		OR p_provider_status NOT IN ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED')
		OR p_payload_hash !~ '^[0-9a-f]{64}$'
		OR p_provider_event_id !~ '^[0-9a-f]{64}$' THEN
		RAISE EXCEPTION 'WOMPI_INGEST_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	SELECT r.tenant_id, r.payment_id, r.subscription_id
	INTO v_ref_tenant, v_ref_payment, v_ref_subscription
	FROM app.bootstrap_resolve_wompi_payment_by_reference(p_environment, p_reference) AS r;

	SELECT r.tenant_id, r.payment_id, r.subscription_id
	INTO v_tx_tenant, v_tx_payment, v_tx_subscription
	FROM app.bootstrap_resolve_wompi_payment_by_transaction(p_environment, p_provider_transaction_id) AS r;

	IF v_ref_payment IS NOT NULL AND v_tx_payment IS NOT NULL AND v_ref_payment <> v_tx_payment THEN
		RAISE EXCEPTION 'WOMPI_CORRELATION_CONFLICT' USING ERRCODE = '23514';
	END IF;
	v_tenant := COALESCE(v_tx_tenant, v_ref_tenant);
	v_payment := COALESCE(v_tx_payment, v_ref_payment);
	v_subscription := COALESCE(v_tx_subscription, v_ref_subscription);

	INSERT INTO public.webhook_events (
		id, provider, provider_event_id, tenant_id, payload_hash, payload_json, headers_json
	) VALUES (
		p_webhook_event_id, 'wompi', p_provider_event_id, v_tenant,
		p_payload_hash, p_payload_json, p_headers_json
	)
	ON CONFLICT (provider, provider_event_id) DO NOTHING
	RETURNING id INTO v_stored_id;

	IF v_stored_id IS NOT NULL THEN
		v_inserted := true;
		IF v_payment IS NOT NULL THEN
			INSERT INTO public.outbox_events (
			id, tenant_id, aggregate_type, aggregate_id, event_type,
			event_version, payload_json, idempotency_key
		) VALUES (
			p_outbox_event_id, v_tenant, 'billing_payment', v_payment,
			'billing.provider_transaction_status_changed', 1,
			pg_catalog.jsonb_build_object(
				'type', 'billing.provider_transaction_status_changed',
				'version', 1,
				'provider', 'wompi',
				'provider_transaction_id', p_provider_transaction_id,
				'reference', p_reference,
				'status', p_provider_status,
				'amount_minor', (p_payload_json #>> '{data,transaction,amount_in_cents}')::bigint,
				'currency', p_payload_json #>> '{data,transaction,currency}',
				'occurred_at', p_occurred_at,
				'webhook_event_id', p_webhook_event_id
			),
			p_webhook_event_id
			);
		END IF;
	ELSE
		SELECT w.id, w.tenant_id INTO v_stored_id, v_tenant
		FROM public.webhook_events AS w
		WHERE w.provider = 'wompi' AND w.provider_event_id = p_provider_event_id;
	END IF;

	RETURN QUERY SELECT v_stored_id, v_inserted, v_tenant;
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.ingest_verified_wompi_webhook(uuid, uuid, text, text, jsonb, jsonb, text, text, text, text, timestamptz)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.ingest_verified_wompi_webhook(uuid, uuid, text, text, jsonb, jsonb, text, text, text, text, timestamptz)
	TO tallermecario_api;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE FUNCTION app.apply_wompi_payment_status(
	p_billing_event_id uuid,
	p_webhook_event_id uuid,
	p_business_event_id text,
	p_provider_transaction_id text,
	p_reference text,
	p_provider_status text,
	p_amount_minor bigint,
	p_currency text,
	p_occurred_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_payment_id uuid;
	v_tenant_id uuid;
	v_subscription_id uuid;
	v_payment_status text;
	v_subscription_status text;
	v_local_status text;
	v_inserted uuid;
BEGIN
	IF p_provider_status NOT IN ('PENDING', 'APPROVED', 'DECLINED', 'ERROR', 'VOIDED')
		OR p_amount_minor <= 0
		OR p_currency <> 'COP'
		OR p_business_event_id !~ '^[0-9a-f]{64}$' THEN
		RAISE EXCEPTION 'WOMPI_STATUS_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	SELECT p.id, p.tenant_id, p.subscription_id, p.status
	INTO v_payment_id, v_tenant_id, v_subscription_id, v_payment_status
	FROM public.payments AS p
	WHERE p.reference = p_reference
		AND p.provider = 'wompi'
		AND p.amount = p_amount_minor
		AND p.currency = p_currency
		AND (p.provider_transaction_id IS NULL OR p.provider_transaction_id = p_provider_transaction_id)
	FOR UPDATE;
	IF v_payment_id IS NULL THEN
		RAISE EXCEPTION 'WOMPI_TRANSACTION_CORRELATION_MISMATCH' USING ERRCODE = '23514';
	END IF;

	INSERT INTO public.billing_events (
		id, tenant_id, subscription_id, provider, provider_event_id,
		event_type, payload_json, occurred_at
	) VALUES (
		p_billing_event_id, v_tenant_id, v_subscription_id, 'wompi', p_business_event_id,
		'billing.provider_transaction_status_changed',
		pg_catalog.jsonb_build_object(
			'provider', 'wompi',
			'provider_transaction_id', p_provider_transaction_id,
			'reference', p_reference,
			'status', p_provider_status,
			'amount_minor', p_amount_minor,
			'currency', p_currency,
			'webhook_event_id', p_webhook_event_id
		),
		p_occurred_at
	)
	ON CONFLICT (provider, provider_event_id) DO NOTHING
	RETURNING id INTO v_inserted;
	IF v_inserted IS NULL THEN
		RETURN 'duplicate';
	END IF;

	v_local_status := pg_catalog.lower(p_provider_status);
	IF NOT (v_local_status = 'pending' AND v_payment_status IN ('approved', 'declined', 'error', 'voided')) THEN
		UPDATE public.payments
		SET provider_transaction_id = p_provider_transaction_id,
			status = v_local_status,
			paid_at = CASE WHEN v_local_status = 'approved'
				THEN COALESCE(paid_at, p_occurred_at) ELSE paid_at END,
			updated_at = pg_catalog.now()
		WHERE id = v_payment_id AND tenant_id = v_tenant_id;
	END IF;

	SELECT s.status INTO v_subscription_status
	FROM public.subscriptions AS s
	WHERE s.id = v_subscription_id AND s.tenant_id = v_tenant_id
	FOR UPDATE;
	IF p_provider_status = 'APPROVED'
		AND v_subscription_status IN ('trialing', 'past_due', 'suspended') THEN
		UPDATE public.subscriptions
		SET status = 'active', updated_at = pg_catalog.now()
		WHERE id = v_subscription_id AND tenant_id = v_tenant_id;
	ELSIF p_provider_status = 'DECLINED' AND v_subscription_status = 'active' THEN
		UPDATE public.subscriptions
		SET status = 'past_due', updated_at = pg_catalog.now()
		WHERE id = v_subscription_id AND tenant_id = v_tenant_id;
	END IF;

	RETURN 'applied';
END
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.apply_wompi_payment_status(uuid, uuid, text, text, text, text, bigint, text, timestamptz)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.apply_wompi_payment_status(uuid, uuid, text, text, text, text, bigint, text, timestamptz)
	TO tallermecario_worker;
--> statement-breakpoint

CREATE FUNCTION app.append_wompi_webhook_attempt(
	p_id uuid,
	p_webhook_event_id uuid,
	p_attempt_number integer,
	p_status text,
	p_started_at timestamptz,
	p_finished_at timestamptz,
	p_error_code text,
	p_error_message text,
	p_worker_id text,
	p_request_id text
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	INSERT INTO public.webhook_processing_attempts (
		id, webhook_event_id, attempt_number, status, started_at, finished_at,
		last_error_code, last_error_message, worker_id, request_id
	) VALUES (
		p_id, p_webhook_event_id, p_attempt_number, p_status, p_started_at, p_finished_at,
		p_error_code, p_error_message, p_worker_id, p_request_id
	)
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.append_wompi_webhook_attempt(uuid, uuid, integer, text, timestamptz, timestamptz, text, text, text, text)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.append_wompi_webhook_attempt(uuid, uuid, integer, text, timestamptz, timestamptz, text, text, text, text)
	TO tallermecario_worker;
--> statement-breakpoint

RESET ROLE;
