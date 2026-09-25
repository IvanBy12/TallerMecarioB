-- S2-03 CRM PostgreSQL hardening. The runner controls the transaction.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.vehicles IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE public.vehicle_owners IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE public.vehicles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $crm_plate_preflight$
BEGIN
	IF EXISTS (SELECT 1 FROM public.vehicles
		WHERE plate <> pg_catalog.btrim(plate) OR plate <> pg_catalog.upper(plate COLLATE "C"))
		OR EXISTS (SELECT 1 FROM public.vehicles
			GROUP BY tenant_id, pg_catalog.upper(pg_catalog.btrim(plate) COLLATE "C")
			HAVING count(*) > 1) THEN
		RAISE EXCEPTION 'vehicles: legacy plate requires explicit remediation'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'vehicles_plate_normalized_check';
	END IF;
END
$crm_plate_preflight$;
--> statement-breakpoint
ALTER TABLE public.vehicles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_normalized_check
	CHECK (plate = pg_catalog.btrim(plate) AND plate = pg_catalog.upper(plate COLLATE "C"));
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.customers, public.vehicles, public.vehicle_owners FROM tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (document_type, document_number, first_name, last_name, phone, email, notes, updated_at)
	ON TABLE public.customers TO tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (plate, vin, vehicle_type, brand, model, model_year, color, engine_number, current_mileage_km, updated_at)
	ON TABLE public.vehicles TO tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (valid_to) ON TABLE public.vehicle_owners TO tallermecario_api;
--> statement-breakpoint
REVOKE ALL ON TABLE public.customers, public.vehicles, public.vehicle_owners FROM tallermecario_worker;
--> statement-breakpoint
REVOKE ALL ON TABLE public.customers, public.vehicles, public.vehicle_owners FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.enforce_vehicle_owner_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
	IF OLD.valid_to IS NOT NULL
		OR NEW.id IS DISTINCT FROM OLD.id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
		OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
		OR NEW.relationship_type IS DISTINCT FROM OLD.relationship_type
		OR NEW.is_primary IS DISTINCT FROM OLD.is_primary
		OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'vehicle_owners: historical fields are immutable'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'vehicle_owners_history_guard';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_vehicle_owner_history() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER vehicle_owners_history_guard_trg
	BEFORE UPDATE ON public.vehicle_owners
	FOR EACH ROW EXECUTE FUNCTION app.enforce_vehicle_owner_history();
--> statement-breakpoint
DO $crm_hardening_checks$
DECLARE
	v_table text;
	v_column text;
	v_privilege text;
	v_allowed text[];
BEGIN
	FOREACH v_table IN ARRAY ARRAY['customers', 'vehicles', 'vehicle_owners'] LOOP
		v_allowed := CASE v_table
			WHEN 'customers' THEN ARRAY['document_type','document_number','first_name','last_name','phone','email','notes','updated_at']
			WHEN 'vehicles' THEN ARRAY['plate','vin','vehicle_type','brand','model','model_year','color','engine_number','current_mileage_km','updated_at']
			ELSE ARRAY['valid_to'] END;
		IF NOT pg_catalog.has_table_privilege('tallermecario_api', 'public.' || v_table, 'SELECT')
			OR NOT pg_catalog.has_table_privilege('tallermecario_api', 'public.' || v_table, 'INSERT')
			OR pg_catalog.has_table_privilege('tallermecario_api', 'public.' || v_table, 'UPDATE') THEN
			RAISE EXCEPTION 'CRM API table privileges invalid: %', v_table;
		END IF;
		FOREACH v_privilege IN ARRAY ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
			IF pg_catalog.has_table_privilege('tallermecario_api', 'public.' || v_table, v_privilege) THEN
				RAISE EXCEPTION 'CRM API excess privilege: %', v_table;
			END IF;
		END LOOP;
		FOR v_column IN SELECT a.attname::text FROM pg_catalog.pg_attribute a
			WHERE a.attrelid = ('public.' || v_table)::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP
			IF pg_catalog.has_column_privilege('tallermecario_api', 'public.' || v_table, v_column, 'UPDATE')
				IS DISTINCT FROM (v_column = ANY(v_allowed)) THEN
				RAISE EXCEPTION 'CRM API column privilege invalid: %.%', v_table, v_column;
			END IF;
			FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
				IF pg_catalog.has_column_privilege('tallermecario_worker', 'public.' || v_table, v_column, v_privilege)
					OR pg_catalog.has_column_privilege('public', 'public.' || v_table, v_column, v_privilege) THEN
					RAISE EXCEPTION 'CRM worker/PUBLIC column privilege invalid: %.%', v_table, v_column;
				END IF;
			END LOOP;
		END LOOP;
		FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
			IF pg_catalog.has_table_privilege('tallermecario_worker', 'public.' || v_table, v_privilege)
				OR pg_catalog.has_table_privilege('public', 'public.' || v_table, v_privilege) THEN
				RAISE EXCEPTION 'CRM worker/PUBLIC table privilege invalid: %', v_table;
			END IF;
		END LOOP;
		IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
			WHERE c.oid = ('public.' || v_table)::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
			RAISE EXCEPTION 'CRM RLS flags invalid: %', v_table;
		END IF;
		IF (SELECT count(*) FROM pg_catalog.pg_policies p
			WHERE p.schemaname = 'public' AND p.tablename = v_table) <> 3
			OR (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = v_table
				AND p.permissive = 'PERMISSIVE'
				AND p.roles = ARRAY['tallermecario_api','tallermecario_worker']::name[]
				AND ((p.policyname = 'tenant_select' AND p.cmd = 'SELECT'
					AND p.qual = '(tenant_id = app.current_tenant_id())' AND p.with_check IS NULL)
					OR (p.policyname = 'tenant_insert' AND p.cmd = 'INSERT'
					AND p.qual IS NULL AND p.with_check = '(tenant_id = app.current_tenant_id())')
					OR (p.policyname = 'tenant_update' AND p.cmd = 'UPDATE'
					AND p.qual = '(tenant_id = app.current_tenant_id())'
					AND p.with_check = '(tenant_id = app.current_tenant_id())'))) <> 3 THEN
			RAISE EXCEPTION 'CRM policies invalid: %', v_table;
		END IF;
	END LOOP;
	IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
		WHERE r.rolname IN ('tallermecario_api','tallermecario_worker') AND r.rolbypassrls) THEN
		RAISE EXCEPTION 'CRM runtime BYPASSRLS forbidden';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
		WHERE p.oid = 'app.enforce_vehicle_owner_history()'::regprocedure
		AND NOT p.prosecdef AND p.proowner = 'tallermecario_schema_owner'::regrole
		AND p.proconfig = ARRAY['search_path=pg_catalog']
		AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')) THEN
		RAISE EXCEPTION 'CRM history function invalid';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
		WHERE t.tgrelid = 'public.vehicle_owners'::regclass
		AND t.tgname = 'vehicle_owners_history_guard_trg' AND t.tgenabled = 'O'
		AND t.tgtype = 19 AND t.tgattr = ''::int2vector
		AND t.tgfoid = 'app.enforce_vehicle_owner_history()'::regprocedure) THEN
		RAISE EXCEPTION 'CRM history trigger invalid';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
		WHERE c.conrelid = 'public.vehicles'::regclass AND c.conname = 'vehicles_plate_normalized_check'
		AND c.contype = 'c' AND c.convalidated)
		OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
		WHERE c.conrelid = 'public.vehicles'::regclass AND c.conname = 'vehicles_tenant_plate_key' AND c.contype = 'u')
		OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
		WHERE c.conrelid = 'public.vehicle_owners'::regclass AND c.conname = 'vehicle_owners_validity_check'
		AND c.contype = 'c' AND c.convalidated)
		OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class c ON c.oid = x.indexrelid
		WHERE x.indrelid = 'public.vehicle_owners'::regclass AND c.relname = 'vehicle_owners_one_primary_uq'
		AND x.indisunique AND x.indisvalid) THEN
		RAISE EXCEPTION 'CRM constraints/index invalid';
	END IF;
END
$crm_hardening_checks$;
--> statement-breakpoint
RESET ROLE;
