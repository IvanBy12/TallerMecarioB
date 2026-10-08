-- B05: current API completion/quarantine and retention extension only.
-- Worker production code has no media_assets writes. No hold/delete capability.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.media_assets FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT UPDATE (status, size_bytes, checksum_sha256, uploaded_at, quarantined_at,
  integrity_failure_code, updated_at, retention_until)
  ON TABLE public.media_assets TO tallermecario_api;
--> statement-breakpoint
CREATE FUNCTION app.enforce_media_retention_monotonic()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF OLD.retention_until IS NOT NULL AND
    (NEW.retention_until IS NULL OR NEW.retention_until < OLD.retention_until) THEN
    RAISE EXCEPTION 'committed media retention cannot be shortened'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'media_assets_retention_monotonic_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER media_assets_retention_monotonic_trg
BEFORE UPDATE OF retention_until ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION app.enforce_media_retention_monotonic();
--> statement-breakpoint
-- status is needed by B02, but granting it must not open the B06 deleted state.
-- No approved deletion actor exists yet; leave existing historical rows intact.
CREATE FUNCTION app.enforce_media_delete_lifecycle_unavailable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.status = 'deleted' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'media deletion lifecycle is unavailable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'media_assets_delete_lifecycle_unavailable_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER media_assets_delete_lifecycle_unavailable_trg
BEFORE UPDATE OF status ON public.media_assets
FOR EACH ROW EXECUTE FUNCTION app.enforce_media_delete_lifecycle_unavailable();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_media_retention_monotonic() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_media_delete_lifecycle_unavailable() FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
