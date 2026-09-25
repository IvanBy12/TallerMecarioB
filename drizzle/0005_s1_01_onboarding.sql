SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

-- Global system-role seed. Onboarding resolves owner by semantic code and
-- never relies on these identifiers at runtime.
INSERT INTO public.roles (id, code, name, scope, is_system) VALUES
	('01a0cc04-6b02-7ead-b516-a981efc70e70', 'owner', 'Owner', 'tenant', true),
	('01a0cc04-6b06-73b0-88df-fcda19da2297', 'admin', 'Administrador', 'tenant', true),
	('01a0cc04-6b07-7d1c-8c03-5403b9c07928', 'service_advisor', 'Asesor de servicio', 'tenant', true),
	('01a0cc04-6b08-73c2-a014-93758eab0d92', 'technician', 'Técnico', 'tenant', true)
ON CONFLICT (code) DO UPDATE SET
	name = EXCLUDED.name,
	scope = EXCLUDED.scope,
	is_system = EXCLUDED.is_system;
--> statement-breakpoint

-- The existing ADR-009 bootstrap owner is NOLOGIN and explicitly BYPASSRLS.
-- It receives only the columns required for JIT identity provisioning and
-- the single append-only audit insert performed by the allowlisted function.
-- `status` is deliberately absent: the column default ('active') is always
-- sufficient at insert time, so granting INSERT on it would be an
-- unnecessary write privilege (public.users already grants this role full
-- SELECT, including status, since migration 0000).
GRANT INSERT (id, identity_provider, external_subject, email, full_name)
	ON TABLE public.users TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT INSERT (
	id, tenant_id, actor_type, actor_user_id, action, outcome,
	entity_type, entity_id, metadata_json, request_id
)
	ON TABLE public.audit_logs TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_provision_user(
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

	-- `status` is intentionally omitted: the column default ('active') is
	-- always correct at JIT-provisioning time, and this role holds no
	-- INSERT privilege on it (see the GRANT above).
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
	app.bootstrap_provision_user(text, text, uuid, text, text, text)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.bootstrap_provision_user(text, text, uuid, text, text, text)
	TO tallermecario_api;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint
RESET ROLE;
