-- Reception signature evidence requires its canonical retention class.
-- The runner owns the transaction; incompatible history aborts without rewriting it.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.signatures, public.media_assets IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- Temporarily lift FORCE only under exclusive locks to inspect every tenant as owner.
ALTER TABLE public.signatures NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.media_assets NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.signatures s
    LEFT JOIN public.media_assets m ON m.tenant_id = s.tenant_id AND m.id = s.signature_media_id
    WHERE s.reception_id IS NOT NULL
      AND m.retention_class IS DISTINCT FROM 'authorization_evidence') THEN
    RAISE EXCEPTION 'historical reception signature media has incompatible retention'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reception_signature_retention_preflight';
  END IF;
END
$preflight$;
--> statement-breakpoint
ALTER TABLE public.media_assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.signatures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_reception_signature()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_status text; v_type text; v_media_status text; v_retention_class text;
  v_deleted_at timestamptz; v_purged_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'signatures are append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_append_only_guard';
  END IF;
  IF NEW.reception_id IS NOT NULL THEN
    SELECT r.status INTO v_status FROM public.receptions r
      WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reception_id FOR NO KEY UPDATE;
    IF v_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'signature requires open reception'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'reception_signature_parent_guard';
    END IF;
  END IF;
  SELECT m.media_type, m.status, m.retention_class, m.deleted_at, m.purged_at
    INTO v_type, v_media_status, v_retention_class, v_deleted_at, v_purged_at FROM public.media_assets m
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.signature_media_id FOR SHARE;
  IF v_type IS DISTINCT FROM 'signature' OR v_media_status IS DISTINCT FROM 'active'
    OR (NEW.reception_id IS NOT NULL AND v_retention_class IS DISTINCT FROM 'authorization_evidence')
    OR v_deleted_at IS NOT NULL OR v_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'signature requires active signature media'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_media_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
-- Preserve the 0022 active -> quarantined exception; retention is evidence identity.
CREATE OR REPLACE FUNCTION app.enforce_signed_media_active()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF (NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
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
DROP TRIGGER media_signed_active_trg ON public.media_assets;
--> statement-breakpoint
CREATE TRIGGER media_signed_active_trg BEFORE UPDATE OF storage_provider, bucket,
  object_key, media_type, mime_type, size_bytes, checksum_sha256, status, retention_class,
  deleted_at, purged_at ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_signed_media_active();
--> statement-breakpoint
RESET ROLE;
