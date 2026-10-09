-- B04 Phase B: canonical MVP associations. No history coercion/backfill.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Preflight while blocking new writers: abort atomically with a stable identifier.
LOCK TABLE public.reception_media, public.damage_media IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- Owner-only SELECT policies are transaction-local migration scaffolding.
-- Exclusive locks prevent concurrent use; FORCE RLS stays enabled throughout.
CREATE POLICY b04_owner_preflight ON public.reception_media FOR SELECT TO tallermecario_schema_owner USING(true);
--> statement-breakpoint
CREATE POLICY b04_owner_preflight ON public.damage_media FOR SELECT TO tallermecario_schema_owner USING(true);
--> statement-breakpoint
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reception_media WHERE purpose <> 'intake_evidence') THEN
    RAISE EXCEPTION 'incompatible historical reception media purpose' USING ERRCODE='check_violation',
      CONSTRAINT='reception_media_purpose_preflight';
  END IF;
  IF EXISTS (SELECT 1 FROM public.damage_media WHERE purpose <> 'damage_evidence') THEN
    RAISE EXCEPTION 'incompatible historical damage media purpose' USING ERRCODE='check_violation',
      CONSTRAINT='damage_media_purpose_preflight';
  END IF;
END
$preflight$;
--> statement-breakpoint
DROP POLICY b04_owner_preflight ON public.reception_media;
--> statement-breakpoint
DROP POLICY b04_owner_preflight ON public.damage_media;
--> statement-breakpoint
ALTER TABLE public.reception_media ADD CONSTRAINT reception_media_purpose_check CHECK(purpose='intake_evidence');
--> statement-breakpoint
ALTER TABLE public.damage_media ADD CONSTRAINT damage_media_purpose_check CHECK(purpose='damage_evidence');
--> statement-breakpoint
REVOKE ALL ON TABLE public.reception_media,public.damage_media FROM PUBLIC,tallermecario_api,tallermecario_worker;
--> statement-breakpoint
GRANT SELECT,INSERT ON TABLE public.reception_media,public.damage_media TO tallermecario_api;
--> statement-breakpoint
ALTER POLICY tenant_select ON public.reception_media TO tallermecario_api;
--> statement-breakpoint
ALTER POLICY tenant_insert ON public.reception_media TO tallermecario_api;
--> statement-breakpoint
DROP POLICY tenant_update ON public.reception_media;
--> statement-breakpoint
ALTER POLICY tenant_select ON public.damage_media TO tallermecario_api;
--> statement-breakpoint
ALTER POLICY tenant_insert ON public.damage_media TO tallermecario_api;
--> statement-breakpoint
DROP POLICY tenant_update ON public.damage_media;
--> statement-breakpoint
CREATE FUNCTION app.guard_operational_media_association()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
DECLARE parent_id uuid; v_damage_id uuid; actual_parent uuid;
  r public.receptions%ROWTYPE; m public.media_assets%ROWTYPE;
  session_count bigint; valid_evidence boolean;
BEGIN
  IF TG_TABLE_NAME='reception_media' THEN
    parent_id := NEW.reception_id;
    IF NEW.purpose IS DISTINCT FROM 'intake_evidence' THEN
      RAISE EXCEPTION 'invalid reception purpose' USING ERRCODE='check_violation',CONSTRAINT='reception_media_purpose_check';
    END IF;
  ELSE
    v_damage_id := NEW.damage_id;
    SELECT reception_id INTO parent_id FROM public.vehicle_damages WHERE tenant_id=NEW.tenant_id AND id=v_damage_id;
    IF NEW.purpose IS DISTINCT FROM 'damage_evidence' THEN
      RAISE EXCEPTION 'invalid damage purpose' USING ERRCODE='check_violation',CONSTRAINT='damage_media_purpose_check';
    END IF;
  END IF;
  IF NEW.sort_order IS NULL OR NEW.sort_order<0 THEN
    RAISE EXCEPTION 'invalid media sort order' USING ERRCODE='check_violation',CONSTRAINT='media_association_sort_order_guard';
  END IF;
  -- Parent -> damage -> orders -> ALL sessions -> asset. Same graph as B05.
  SELECT * INTO r FROM public.receptions WHERE tenant_id=NEW.tenant_id AND id=parent_id FOR NO KEY UPDATE;
  IF r.id IS NULL OR r.status<>'open' THEN
    RAISE EXCEPTION 'reception is not editable' USING ERRCODE='check_violation',CONSTRAINT='media_association_parent_guard';
  END IF;
  IF v_damage_id IS NOT NULL THEN
    SELECT reception_id INTO actual_parent FROM public.vehicle_damages
      WHERE tenant_id=NEW.tenant_id AND id=v_damage_id FOR SHARE;
    IF actual_parent IS DISTINCT FROM parent_id THEN
      RAISE EXCEPTION 'invalid damage lineage' USING ERRCODE='check_violation',CONSTRAINT='media_association_context_guard';
    END IF;
  END IF;
  PERFORM id FROM public.service_orders WHERE tenant_id=NEW.tenant_id AND reception_id=parent_id ORDER BY id FOR NO KEY UPDATE;
  PERFORM id FROM public.upload_sessions WHERE tenant_id=NEW.tenant_id AND media_asset_id=NEW.media_asset_id ORDER BY id FOR UPDATE;
  SELECT * INTO m FROM public.media_assets WHERE tenant_id=NEW.tenant_id AND id=NEW.media_asset_id FOR UPDATE;
  IF m.id IS NULL OR m.status<>'active' OR m.media_type NOT IN ('photo','video','video360')
    OR m.retention_class<>'operational' OR m.deletion_requested_at IS NOT NULL OR m.deleted_at IS NOT NULL OR m.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'media is not eligible' USING ERRCODE='check_violation',CONSTRAINT='media_association_asset_guard';
  END IF;
  -- Every session must prove the exact same context. No LIMIT 1 or retargeting.
  -- Initial consent evidence is historical; later revocation does not erase it.
  SELECT count(*),bool_and(us.status='completed' AND us.completed_at IS NOT NULL
    AND b.reception_id IS NOT DISTINCT FROM parent_id AND b.damage_id IS NOT DISTINCT FROM v_damage_id
    AND b.privacy_consent_id=r.privacy_consent_id AND c.customer_id=r.customer_id
    AND c.purpose_code='service_provision' AND c.created_at<=b.authorized_at
    AND b.authorized_at=b.created_at AND b.authorized_at<=clock_timestamp()
    AND b.upload_session_id IS NOT NULL AND c.id IS NOT NULL)
    INTO session_count,valid_evidence FROM public.upload_sessions us
    LEFT JOIN public.media_upload_bindings b ON b.tenant_id=us.tenant_id AND b.upload_session_id=us.id
    LEFT JOIN public.privacy_consents c ON c.tenant_id=b.tenant_id AND c.id=b.privacy_consent_id
    WHERE us.tenant_id=NEW.tenant_id AND us.media_asset_id=NEW.media_asset_id;
  IF session_count=0 OR valid_evidence IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'completed binding context does not match' USING ERRCODE='check_violation',CONSTRAINT='media_association_context_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_operational_media_association() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.guard_operational_media_association() TO tallermecario_api;
--> statement-breakpoint
CREATE TRIGGER reception_media_insert_guard_trg BEFORE INSERT ON public.reception_media
  FOR EACH ROW EXECUTE FUNCTION app.guard_operational_media_association();
--> statement-breakpoint
CREATE TRIGGER damage_media_insert_guard_trg BEFORE INSERT ON public.damage_media
  FOR EACH ROW EXECUTE FUNCTION app.guard_operational_media_association();
--> statement-breakpoint
-- Replace the Phase A function, preserving all consent/lifecycle protections.
-- damage+video360 has the same operational semantics as photo/video.
CREATE OR REPLACE FUNCTION app.authorize_media_upload_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE r public.receptions%ROWTYPE; c public.privacy_consents%ROWTYPE;
  d uuid; v_type text; v_retention text; v_status text; v_version text;
BEGIN
  SELECT * INTO r FROM public.receptions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.reception_id FOR NO KEY UPDATE;
  IF r.id IS NULL OR r.status <> 'open' OR r.privacy_consent_id <> NEW.privacy_consent_id THEN
    RAISE EXCEPTION 'invalid operational parent' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'media_upload_bindings_initial_authorization_guard';
  END IF;
  IF NEW.damage_id IS NOT NULL THEN
    SELECT id INTO d FROM public.vehicle_damages
      WHERE tenant_id = NEW.tenant_id AND id = NEW.damage_id AND reception_id = NEW.reception_id FOR SHARE;
    IF d IS NULL THEN
      RAISE EXCEPTION 'invalid damage lineage' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'media_upload_bindings_initial_authorization_guard';
    END IF;
  END IF;
  SELECT * INTO c FROM public.privacy_consents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.privacy_consent_id FOR SHARE;
  IF c.id IS NULL OR c.customer_id <> r.customer_id OR c.purpose_code <> 'service_provision'
    OR c.status <> 'granted' OR c.revoked_at IS NOT NULL OR c.created_at > pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'invalid initial consent authorization' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'media_upload_bindings_initial_authorization_guard';
  END IF;
  SELECT ma.media_type, ma.retention_class, us.status, us.integrity_version
    INTO v_type, v_retention, v_status, v_version
    FROM public.upload_sessions us JOIN public.media_assets ma
      ON ma.tenant_id = us.tenant_id AND ma.id = us.media_asset_id
    WHERE us.tenant_id = NEW.tenant_id AND us.id = NEW.upload_session_id AND ma.status = 'pending_upload';
  IF v_type IS NULL OR v_type NOT IN ('photo', 'video', 'video360') OR v_retention <> 'operational'
    OR v_status <> 'pending' OR v_version <> 'v1' THEN
    RAISE EXCEPTION 'invalid operational session' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'media_upload_bindings_initial_authorization_guard';
  END IF;
  -- Server clock after all authorization locks; supplied timestamp is never evidence.
  NEW.authorized_at := pg_catalog.clock_timestamp();
  NEW.created_at := NEW.authorized_at;
  RETURN NEW;
END
$function$;

--> statement-breakpoint
RESET ROLE;
