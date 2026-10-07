-- Preserve historical expectations as unknown; only future inserts default to v1.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "integrity_failure_code" varchar(48);--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "integrity_version" varchar(8) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "expected_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_integrity_failure_check" CHECK ("integrity_failure_code" IS NULL OR
      ("status" IN ('quarantined', 'deleted') AND "quarantined_at" IS NOT NULL AND "integrity_failure_code" IN
        ('MEDIA_SIZE_INVALID', 'MEDIA_METADATA_MISMATCH', 'MEDIA_CONTENT_INVALID', 'MEDIA_FORMAT_UNSUPPORTED', 'MEDIA_INSPECTION_LIMIT_EXCEEDED')));--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_integrity_expectation_check" CHECK (("integrity_version" = 'legacy' AND
      "expected_size_bytes" IS NULL) OR ("integrity_version" = 'v1' AND "expected_size_bytes" IS NOT NULL
      AND "expected_size_bytes" > 0 AND "expected_size_bytes" <= 786432000));
--> statement-breakpoint
ALTER TABLE public.upload_sessions ALTER COLUMN integrity_version SET DEFAULT 'v1';
--> statement-breakpoint
-- Runtime cannot fabricate a legacy session or mutate its original expectation.
CREATE FUNCTION app.enforce_upload_integrity_expectation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_type text; v_max bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.integrity_version IS DISTINCT FROM OLD.integrity_version
    OR NEW.expected_size_bytes IS DISTINCT FROM OLD.expected_size_bytes
    OR NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id) THEN
    RAISE EXCEPTION 'upload expectation is immutable' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'upload_sessions_expectation_immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.integrity_version = 'legacy'
    AND (pg_catalog.pg_has_role(current_user, 'tallermecario_api', 'USAGE')
      OR pg_catalog.pg_has_role(current_user, 'tallermecario_worker', 'USAGE'))
    AND NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'new runtime sessions require v1 expectation' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'upload_sessions_integrity_expectation_check';
  END IF;
  IF NEW.integrity_version = 'v1' THEN
    SELECT media_type INTO v_type FROM public.media_assets
      WHERE tenant_id = NEW.tenant_id AND id = NEW.media_asset_id;
    v_max := CASE v_type WHEN 'signature' THEN 2097152 WHEN 'video' THEN 524288000
      WHEN 'video360' THEN 786432000 WHEN 'photo' THEN 20971520
      WHEN 'quote_pdf' THEN 20971520 WHEN 'document' THEN 20971520 ELSE NULL END;
    IF v_max IS NULL OR NEW.expected_size_bytes IS NULL OR NEW.expected_size_bytes <= 0
      OR NEW.expected_size_bytes > v_max THEN
      RAISE EXCEPTION 'invalid expected media size' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'upload_sessions_integrity_expectation_check';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER upload_sessions_integrity_expectation_trg BEFORE INSERT OR UPDATE ON public.upload_sessions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_upload_integrity_expectation();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_upload_integrity_expectation() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enforce_upload_integrity_expectation() TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
RESET ROLE;
