SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_consent_lineage_key" UNIQUE("tenant_id","id","privacy_consent_id");
--> statement-breakpoint
ALTER TABLE "vehicle_damages" ADD CONSTRAINT "vehicle_damages_reception_lineage_key" UNIQUE("tenant_id","id","reception_id");
--> statement-breakpoint
CREATE TABLE "media_upload_bindings" (
	"tenant_id" uuid NOT NULL,
	"upload_session_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"damage_id" uuid,
	"privacy_consent_id" uuid NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_upload_bindings_pk" PRIMARY KEY("tenant_id","upload_session_id"),
	CONSTRAINT "media_upload_bindings_authorization_clock_check" CHECK ("authorized_at" = "created_at")
);
--> statement-breakpoint
ALTER TABLE "media_upload_bindings" ADD CONSTRAINT "media_upload_bindings_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_bindings" ADD CONSTRAINT "media_upload_bindings_session_fk" FOREIGN KEY ("tenant_id","upload_session_id") REFERENCES "public"."upload_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_bindings" ADD CONSTRAINT "media_upload_bindings_reception_consent_fk" FOREIGN KEY ("tenant_id","reception_id","privacy_consent_id") REFERENCES "public"."receptions"("tenant_id","id","privacy_consent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_bindings" ADD CONSTRAINT "media_upload_bindings_consent_fk" FOREIGN KEY ("tenant_id","privacy_consent_id") REFERENCES "public"."privacy_consents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_bindings" ADD CONSTRAINT "media_upload_bindings_damage_lineage_fk" FOREIGN KEY ("tenant_id","damage_id","reception_id") REFERENCES "public"."vehicle_damages"("tenant_id","id","reception_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_upload_bindings_reception_idx" ON "media_upload_bindings" USING btree ("tenant_id","reception_id");--> statement-breakpoint
CREATE INDEX "media_upload_bindings_damage_idx" ON "media_upload_bindings" USING btree ("tenant_id","damage_id","reception_id");--> statement-breakpoint
CREATE INDEX "media_upload_bindings_consent_idx" ON "media_upload_bindings" USING btree ("tenant_id","privacy_consent_id");--> statement-breakpoint
ALTER TABLE public.media_upload_bindings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.media_upload_bindings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_select ON public.media_upload_bindings FOR SELECT TO tallermecario_api
  USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON public.media_upload_bindings FOR INSERT TO tallermecario_api
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
REVOKE ALL ON TABLE public.media_upload_bindings FROM PUBLIC, tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.media_upload_bindings TO tallermecario_api;
--> statement-breakpoint
-- Only initial authorization consults current consent state. No UPDATE/DELETE
-- grant or cascade: future B06 cleanup needs a separately reviewed privilege.
CREATE FUNCTION app.authorize_media_upload_binding()
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
    OR v_status <> 'pending' OR v_version <> 'v1' OR (NEW.damage_id IS NOT NULL AND v_type = 'video360') THEN
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
REVOKE ALL ON FUNCTION app.authorize_media_upload_binding() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.authorize_media_upload_binding() TO tallermecario_api;
--> statement-breakpoint
CREATE TRIGGER media_upload_bindings_authorize_trg BEFORE INSERT ON public.media_upload_bindings
  FOR EACH ROW EXECUTE FUNCTION app.authorize_media_upload_binding();
--> statement-breakpoint
RESET ROLE;
