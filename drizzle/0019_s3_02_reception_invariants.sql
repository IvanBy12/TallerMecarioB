-- S3-02 reception invariants. The migration runner owns the transaction.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.receptions, public.reception_check_items, public.vehicle_damages,
  public.signatures, public.service_orders, public.order_status_history,
  public.vehicles, public.media_assets IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- The schema owner has no tenant policy under FORCE RLS. Temporarily remove
-- FORCE while holding exclusive locks so the upgrade audit sees every tenant.
-- Any failure rolls back both this change and the whole migration.
ALTER TABLE public.receptions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.signatures NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.service_orders NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.order_status_history NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.vehicles NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Historical signatures cannot be assigned an invented acceptance document.
-- Stop the upgrade for explicit remediation instead of backfilling false evidence.
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.signatures) THEN
    RAISE EXCEPTION 'existing signatures need document_version and document_hash remediation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_acceptance_evidence_check';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions WHERE status = 'cancelled') THEN
    RAISE EXCEPTION 'legacy cancelled reception is incompatible with S3-02'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_cancelled_preflight';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions WHERE status = 'open'
      GROUP BY tenant_id, vehicle_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'legacy duplicate open receptions are incompatible with S3-02'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'receptions_one_open_vehicle_uq';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions r WHERE r.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM public.service_orders o
        WHERE o.tenant_id = r.tenant_id AND o.reception_id = r.id)) THEN
    RAISE EXCEPTION 'legacy closed reception lacks service order'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_order_required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_orders o JOIN public.receptions r
      ON r.tenant_id = o.tenant_id AND r.id = o.reception_id WHERE r.status <> 'closed') THEN
    RAISE EXCEPTION 'legacy order references open reception'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_reception_guard';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_orders o WHERE NOT EXISTS (
      SELECT 1 FROM public.order_status_history h WHERE h.tenant_id = o.tenant_id
        AND h.order_id = o.id AND h.from_status IS NULL AND h.to_status = 'reception')) THEN
    RAISE EXCEPTION 'legacy order lacks initial reception history'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_initial_history_guard';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions r WHERE r.status = 'closed'
      AND NOT EXISTS (SELECT 1 FROM public.signatures s
        WHERE s.tenant_id = r.tenant_id AND s.reception_id = r.id)) THEN
    RAISE EXCEPTION 'legacy closed reception lacks signature'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_signature_required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.receptions r JOIN public.vehicles v
      ON v.tenant_id = r.tenant_id AND v.id = r.vehicle_id
      WHERE r.status = 'open' AND r.mileage_km < v.current_mileage_km) THEN
    RAISE EXCEPTION 'legacy reception mileage below vehicle mileage'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_vehicle_mileage_guard';
  END IF;
END
$preflight$;
--> statement-breakpoint
ALTER TABLE public.vehicles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.order_status_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.service_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.signatures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX receptions_one_open_vehicle_uq
  ON public.receptions (tenant_id, vehicle_id) WHERE status = 'open';
--> statement-breakpoint
ALTER TABLE public.signatures ADD COLUMN document_version varchar(40);
--> statement-breakpoint
ALTER TABLE public.signatures ADD COLUMN document_hash varchar(128);
--> statement-breakpoint
ALTER TABLE public.signatures ALTER COLUMN document_version SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.signatures ALTER COLUMN document_hash SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.signatures ADD CONSTRAINT signatures_acceptance_evidence_check
  CHECK (pg_catalog.length(pg_catalog.btrim(document_version)) > 0
    AND pg_catalog.length(pg_catalog.btrim(document_hash)) > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX signatures_one_reception_uq
  ON public.signatures (tenant_id, reception_id) WHERE reception_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX osh_one_initial_reception_uq
  ON public.order_status_history (tenant_id, order_id)
  WHERE from_status IS NULL AND to_status = 'reception';
--> statement-breakpoint

-- Child writes and close take the same reception row lock. A child that wins
-- commits before close; a child that waits sees closed and fails.
CREATE FUNCTION app.enforce_reception_child_open()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.reception_id) IS DISTINCT FROM
      (OLD.tenant_id, OLD.reception_id) THEN
    RAISE EXCEPTION 'reception child ownership is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reception_child_parent_guard';
  END IF;
  SELECT r.status INTO v_status FROM public.receptions r
    WHERE r.tenant_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END
      AND r.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.reception_id ELSE NEW.reception_id END
    FOR NO KEY UPDATE;
  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'reception child requires open parent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'reception_child_parent_guard';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_reception_child_open() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER reception_check_items_parent_open_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.reception_check_items
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_child_open();
--> statement-breakpoint
CREATE TRIGGER vehicle_damages_parent_open_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.vehicle_damages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_child_open();
--> statement-breakpoint

CREATE FUNCTION app.enforce_reception_signature()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_status text; v_type text; v_media_status text;
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
  SELECT m.media_type, m.status, m.deleted_at, m.purged_at
    INTO v_type, v_media_status, v_deleted_at, v_purged_at FROM public.media_assets m
    WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.signature_media_id FOR SHARE;
  IF v_type IS DISTINCT FROM 'signature' OR v_media_status IS DISTINCT FROM 'active'
    OR v_deleted_at IS NOT NULL OR v_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'signature requires active signature media'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_media_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_reception_signature() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER signatures_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.signatures
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_signature();
--> statement-breakpoint

-- Freeze the signed object's location and byte identity, its type, and the
-- deletion/status markers. Retention scheduling metadata remains mutable;
-- any future quarantine/erasure policy must explicitly address signed evidence.
CREATE FUNCTION app.enforce_signed_media_active()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF (NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.bucket IS DISTINCT FROM OLD.bucket
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.media_type IS DISTINCT FROM OLD.media_type
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.purged_at IS DISTINCT FROM OLD.purged_at)
    AND EXISTS (SELECT 1 FROM public.signatures s WHERE s.tenant_id = NEW.tenant_id
      AND s.signature_media_id = NEW.id) THEN
    RAISE EXCEPTION 'signed media evidence is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_media_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_signed_media_active() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER media_signed_active_trg BEFORE UPDATE OF storage_provider, bucket,
  object_key, media_type, mime_type, size_bytes, checksum_sha256, status,
  deleted_at, purged_at ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_signed_media_active();
--> statement-breakpoint

CREATE FUNCTION app.enforce_reception_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_mileage integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receptions cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_lifecycle_guard';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'open' THEN
    RAISE EXCEPTION 'reception must start open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_lifecycle_guard';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'open' OR NEW.status NOT IN ('open', 'closed')
      OR (NEW.status = 'closed' AND OLD.status <> 'open') THEN
      RAISE EXCEPTION 'reception transition is forbidden'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_lifecycle_guard';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
      OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
      OR NEW.received_by_membership_id IS DISTINCT FROM OLD.received_by_membership_id
      OR NEW.received_at IS DISTINCT FROM OLD.received_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'reception identity is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_lifecycle_guard';
    END IF;
    IF NEW.status = 'closed' AND NOT EXISTS (SELECT 1 FROM public.signatures s
      WHERE s.tenant_id = NEW.tenant_id AND s.reception_id = NEW.id) THEN
      RAISE EXCEPTION 'reception signature required for close'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_signature_required';
    END IF;
  END IF;
  -- Existing-reception writers lock reception before vehicle. Do not pre-lock
  -- vehicle for create/duplicate checks; the partial UNIQUE resolves that race.
  -- S3-06 must take order_number advisory lock after reception and vehicle.
  -- NULL current_mileage_km means no historical lower bound yet.
  -- Leave negative values to the existing row CHECK for its canonical error.
  IF NEW.mileage_km < 0 THEN RETURN NEW; END IF;
  SELECT v.current_mileage_km INTO v_mileage FROM public.vehicles v
    WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.vehicle_id FOR NO KEY UPDATE;
  IF v_mileage IS NOT NULL AND NEW.mileage_km < v_mileage THEN
    RAISE EXCEPTION 'reception mileage below vehicle mileage'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_vehicle_mileage_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_reception_lifecycle() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER receptions_lifecycle_trg BEFORE INSERT OR UPDATE OR DELETE ON public.receptions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_lifecycle();
--> statement-breakpoint
CREATE FUNCTION app.enforce_vehicle_open_reception_mileage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.current_mileage_km IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.receptions r WHERE r.tenant_id = NEW.tenant_id
      AND r.vehicle_id = NEW.id AND r.status = 'open'
      AND r.mileage_km < NEW.current_mileage_km) THEN
    RAISE EXCEPTION 'vehicle mileage exceeds open reception mileage'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_vehicle_mileage_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_vehicle_open_reception_mileage() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER vehicles_open_reception_mileage_trg
  BEFORE UPDATE OF current_mileage_km ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_vehicle_open_reception_mileage();
--> statement-breakpoint

-- A close may insert its order later in the same transaction. Deferred checks
-- guarantee that no committed closed reception lacks an order and initial event.
CREATE FUNCTION app.enforce_closed_reception_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF NEW.status = 'closed' AND NOT EXISTS (SELECT 1 FROM public.service_orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.reception_id = NEW.id) THEN
    RAISE EXCEPTION 'closed reception requires service order'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_order_required';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_closed_reception_order() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receptions_order_required_ct AFTER INSERT OR UPDATE OF status
  ON public.receptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.enforce_closed_reception_order();
--> statement-breakpoint
CREATE FUNCTION app.enforce_order_reception_lineage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.status IS DISTINCT FROM 'reception'
    OR NEW.version IS DISTINCT FROM 1 OR NEW.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'service order must start in reception at version 1 without closed_at'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_initial_state_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.reception_id, NEW.vehicle_id, NEW.customer_id)
      IS DISTINCT FROM (OLD.tenant_id, OLD.reception_id, OLD.vehicle_id, OLD.customer_id) THEN
    RAISE EXCEPTION 'service order lineage is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_reception_guard';
  END IF;
  SELECT r.status INTO v_status FROM public.receptions r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.reception_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'service order requires closed reception'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_reception_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_order_reception_lineage() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER service_orders_reception_guard_trg BEFORE INSERT OR UPDATE ON public.service_orders
  FOR EACH ROW EXECUTE FUNCTION app.enforce_order_reception_lineage();
--> statement-breakpoint
CREATE FUNCTION app.enforce_order_initial_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_status_history h
    WHERE h.tenant_id = NEW.tenant_id AND h.order_id = NEW.id
      AND h.from_status IS NULL AND h.to_status = 'reception') THEN
    RAISE EXCEPTION 'service order requires initial status history'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'service_orders_initial_history_guard';
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_order_initial_history() FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER service_orders_initial_history_ct AFTER INSERT ON public.service_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.enforce_order_initial_history();
--> statement-breakpoint

-- Runtime grants: no worker writer for reception or order creation; only the
-- API columns needed for drafts, close, and later order lifecycle commands.
REVOKE ALL ON TABLE public.receptions, public.reception_check_items, public.vehicle_damages,
  public.signatures, public.service_orders, public.order_status_history FROM tallermecario_worker;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.receptions, public.reception_check_items,
  public.vehicle_damages, public.signatures, public.service_orders FROM tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (appointment_id, location_id, mileage_km, fuel_level_pct,
  customer_notes, advisor_notes, status, closed_at, updated_at)
  ON TABLE public.receptions TO tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (label, status, notes) ON TABLE public.reception_check_items TO tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (zone_code, damage_type, severity, description)
  ON TABLE public.vehicle_damages TO tallermecario_api;
--> statement-breakpoint
GRANT UPDATE (status, priority, promised_at, closed_at, version, updated_at)
  ON TABLE public.service_orders TO tallermecario_api;
--> statement-breakpoint
REVOKE UPDATE ON TABLE public.order_status_history FROM tallermecario_api;
--> statement-breakpoint
REVOKE ALL ON TABLE public.receptions, public.reception_check_items, public.vehicle_damages,
  public.signatures, public.service_orders, public.order_status_history FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
