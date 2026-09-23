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
-- It receives only the columns required for JIT identity reconciliation and
-- the single append-only audit insert performed by the allowlisted function.
GRANT INSERT (id, identity_provider, external_subject, email, full_name, status),
	UPDATE (email, full_name, updated_at)
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
	created boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
	v_user_id uuid;
	v_user_status text;
	v_created boolean;
BEGIN
	IF p_identity_provider IS NULL OR p_identity_provider = '' OR pg_catalog.length(p_identity_provider) > 32
		OR p_external_subject IS NULL OR p_external_subject = '' OR pg_catalog.length(p_external_subject) > 255
		OR p_proposed_user_id IS NULL
		OR p_email IS NULL OR p_email = '' OR pg_catalog.length(p_email) > 320
		OR pg_catalog.strpos(p_email, '@') = 0
		OR (p_full_name IS NOT NULL AND pg_catalog.length(p_full_name) > 200)
		OR p_request_id IS NULL OR p_request_id = '' OR pg_catalog.length(p_request_id) > 128 THEN
		RAISE EXCEPTION 'BOOTSTRAP_USER_ARGUMENT_INVALID' USING ERRCODE = '22023';
	END IF;

	INSERT INTO public.users AS existing_user (
		id, identity_provider, external_subject, email, full_name, status
	) VALUES (
		p_proposed_user_id, p_identity_provider, p_external_subject,
		p_email, p_full_name, 'active'
	)
	ON CONFLICT (identity_provider, external_subject) DO UPDATE SET
		email = EXCLUDED.email,
		full_name = COALESCE(EXCLUDED.full_name, existing_user.full_name),
		updated_at = pg_catalog.clock_timestamp()
	RETURNING existing_user.id, existing_user.status, (existing_user.xmax = 0)
	INTO v_user_id, v_user_status, v_created;

	IF v_created THEN
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

	RETURN QUERY SELECT v_user_id, v_user_status, v_created;
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
