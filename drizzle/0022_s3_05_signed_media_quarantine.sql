-- Signed evidence remains immutable, but security quarantine must remain possible.
-- The existing media_signed_active_trg from 0019 calls this replacement function.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_signed_media_active()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF (NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.purged_at IS DISTINCT FROM OLD.purged_at
    OR (NEW.status IS DISTINCT FROM OLD.status
      AND NOT (OLD.status = 'active' AND NEW.status = 'quarantined')))
    AND EXISTS (SELECT 1 FROM public.signatures s WHERE s.tenant_id = NEW.tenant_id
      AND s.signature_media_id = NEW.id) THEN
    RAISE EXCEPTION 'signed media evidence is immutable except for quarantine'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_media_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
RESET ROLE;
