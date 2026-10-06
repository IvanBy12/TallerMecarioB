-- Product decision approved by the user on 2026-10-05: reception close no longer requires a digital signature.
-- Historical signatures, media retention, tenant isolation and exactly-once order/history guards are preserved.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_reception_lifecycle()
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
RESET ROLE;
