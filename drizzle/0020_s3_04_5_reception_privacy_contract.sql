-- S3-04.5 reception privacy contract (D-PRIV-01..05, RECEPTION-CONSENT-01).
-- The migration runner owns the transaction: any failure rolls back every
-- statement below and leaves the ledger at 0019.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.privacy_consents, public.receptions IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- The schema owner has no tenant policy under FORCE RLS. Temporarily remove
-- FORCE while holding exclusive locks so the upgrade audit sees every tenant.
ALTER TABLE public.receptions NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.privacy_consents NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Fail closed. No consent, hash, snapshot, sentinel or default is invented:
-- - a legacy reception has no privacy_consent_id, so no consent can be proven
--   to have covered it;
-- - a legacy consent stored no controller snapshot, and no privacy copy was
--   ever published in the server catalog, so its exact presented text cannot
--   be reconstructed.
-- Pre-pilot policy (Diccionario 04 §1.1): abort for explicit remediation.
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.receptions) THEN
    RAISE EXCEPTION 'legacy receptions lack a verifiable service_provision privacy consent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_privacy_consent_preflight';
  END IF;
  IF EXISTS (SELECT 1 FROM public.privacy_consents) THEN
    RAISE EXCEPTION 'legacy privacy consents lack reconstructible authorization text and controller snapshot'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_consents_evidence_preflight';
  END IF;
END
$preflight$;
--> statement-breakpoint
ALTER TABLE public.privacy_consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.receptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- D-PRIV-02: exact evidence of the presented text and controller identity.
ALTER TABLE public.privacy_consents ADD COLUMN authorization_text_hash char(64) NOT NULL;
--> statement-breakpoint
ALTER TABLE public.privacy_consents ADD COLUMN controller_notice_snapshot jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE public.privacy_consents ADD CONSTRAINT privacy_consents_authorization_text_hash_check
  CHECK (authorization_text_hash COLLATE "C" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE public.privacy_consents ADD CONSTRAINT privacy_consents_controller_snapshot_check
  CHECK (jsonb_typeof(controller_notice_snapshot) = 'object'
    AND controller_notice_snapshot ?& ARRAY['legalName','address','phone','email','rightsChannel']
    AND (controller_notice_snapshot - ARRAY['legalName','address','phone','email','rightsChannel']) = '{}'::jsonb
    AND jsonb_typeof(controller_notice_snapshot->'legalName') = 'string'
    AND jsonb_typeof(controller_notice_snapshot->'address') = 'string'
    AND jsonb_typeof(controller_notice_snapshot->'rightsChannel') = 'string'
    AND jsonb_typeof(controller_notice_snapshot->'phone') IN ('string','null')
    AND jsonb_typeof(controller_notice_snapshot->'email') IN ('string','null')
    AND (jsonb_typeof(controller_notice_snapshot->'phone') = 'string'
      OR jsonb_typeof(controller_notice_snapshot->'email') = 'string')
    AND length(btrim(controller_notice_snapshot->>'legalName')) > 0
    AND length(btrim(controller_notice_snapshot->>'address')) > 0
    AND length(btrim(controller_notice_snapshot->>'rightsChannel')) > 0);
--> statement-breakpoint

-- D-PRIV-01: every reception points at the consent that covered it.
ALTER TABLE public.receptions ADD COLUMN privacy_consent_id uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE public.receptions ADD CONSTRAINT receptions_privacy_consent_fk
  FOREIGN KEY (tenant_id, privacy_consent_id)
  REFERENCES public.privacy_consents (tenant_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX receptions_privacy_consent_idx
  ON public.receptions USING btree (tenant_id, privacy_consent_id);
--> statement-breakpoint

-- Consent evidence is historical after INSERT. The only lifecycle is
-- granted -> revoked (revoked_at, updated_at). Re-authorizing inserts a new
-- row; a revoked row is terminal. Applies to every role, like the S3-02
-- signature guard: purging evidence needs a future explicit migration.
CREATE FUNCTION app.enforce_privacy_consent_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'privacy consent evidence cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_consents_evidence_guard';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'granted' OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'privacy consent must start granted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_consents_evidence_guard';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM 'granted' OR NEW.status IS DISTINCT FROM 'revoked'
    OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'privacy consent transition is forbidden'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_consents_evidence_guard';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.customer_id, NEW.purpose_code, NEW.privacy_notice_version,
      NEW.authorization_text_version, NEW.authorization_text_hash, NEW.controller_notice_snapshot,
      NEW.channel, NEW.captured_at, NEW.evidence_hash, NEW.evidence_media_id, NEW.ip_address,
      NEW.user_agent, NEW.created_by_membership_id, NEW.created_at)
    IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.customer_id, OLD.purpose_code, OLD.privacy_notice_version,
      OLD.authorization_text_version, OLD.authorization_text_hash, OLD.controller_notice_snapshot,
      OLD.channel, OLD.captured_at, OLD.evidence_hash, OLD.evidence_media_id, OLD.ip_address,
      OLD.user_agent, OLD.created_by_membership_id, OLD.created_at) THEN
    RAISE EXCEPTION 'privacy consent evidence is immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'privacy_consents_evidence_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_privacy_consent_evidence() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER privacy_consents_evidence_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.privacy_consents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_privacy_consent_evidence();
--> statement-breakpoint
CREATE TRIGGER privacy_consents_evidence_truncate_trg
  BEFORE TRUNCATE ON public.privacy_consents
  FOR EACH STATEMENT EXECUTE FUNCTION app.enforce_privacy_consent_evidence();
--> statement-breakpoint

-- D-PRIV-03 backstop. Never trust that the application already locked: take
-- the transferOwner gate (vehicles FOR NO KEY UPDATE) first, then resolve the
-- current primary owner. Re-locking inside the same transaction is reentrant.
-- This supersedes the S3-02 note that create should not pre-lock the vehicle:
-- two creates now serialize on the vehicle row and the partial UNIQUE still
-- decides RECEPTION_ALREADY_OPEN. Only INSERT is checked: history is not
-- re-evaluated after a later owner change.
CREATE FUNCTION app.enforce_reception_current_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_vehicle uuid; v_owner uuid;
BEGIN
  SELECT v.id INTO v_vehicle FROM public.vehicles v
    WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.vehicle_id FOR NO KEY UPDATE;
  -- Absent or foreign vehicle: receptions_vehicle_fk is the authority.
  IF v_vehicle IS NULL THEN RETURN NEW; END IF;
  SELECT o.customer_id INTO v_owner FROM public.vehicle_owners o
    WHERE o.tenant_id = NEW.tenant_id AND o.vehicle_id = NEW.vehicle_id
      AND o.is_primary = true AND o.valid_to IS NULL;
  IF v_owner IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'reception customer is not the current primary vehicle owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_current_owner_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_reception_current_owner() FROM PUBLIC;
--> statement-breakpoint

-- RECEPTION-CONSENT-01. The composite FK only takes FOR KEY SHARE, which does
-- not conflict with the revoke UPDATE (FOR NO KEY UPDATE); FOR SHARE does.
-- Revocation first: this waits, then sees revoked and fails. Reception first:
-- revocation waits until the historically valid reception commits.
-- created_at (server-owned) is the ordering authority; captured_at is only
-- declared evidence. now() also bounds a forged receptions.created_at.
CREATE FUNCTION app.enforce_reception_privacy_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE v_id uuid; v_customer uuid; v_purpose text; v_status text;
  v_revoked_at timestamptz; v_created_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.privacy_consent_id IS DISTINCT FROM OLD.privacy_consent_id THEN
      RAISE EXCEPTION 'reception privacy consent is immutable'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_privacy_consent_guard';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.id, c.customer_id, c.purpose_code, c.status, c.revoked_at, c.created_at
    INTO v_id, v_customer, v_purpose, v_status, v_revoked_at, v_created_at
    FROM public.privacy_consents c
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.privacy_consent_id FOR SHARE;
  -- Absent or foreign consent: receptions_privacy_consent_fk is the authority.
  IF v_id IS NULL THEN RETURN NEW; END IF;
  IF v_customer IS DISTINCT FROM NEW.customer_id
    OR v_purpose IS DISTINCT FROM 'service_provision'
    OR v_status IS DISTINCT FROM 'granted'
    OR v_revoked_at IS NOT NULL
    OR v_created_at > NEW.created_at
    OR v_created_at > pg_catalog.now() THEN
    RAISE EXCEPTION 'reception privacy consent is not eligible'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receptions_privacy_consent_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_reception_privacy_consent() FROM PUBLIC;
--> statement-breakpoint
-- BEFORE triggers fire in name order: vehicle/owner (10), then consent (20),
-- then the S3-02 lifecycle trigger, whose vehicle lock is then reentrant.
CREATE TRIGGER receptions_guard_10_current_owner_trg
  BEFORE INSERT ON public.receptions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_current_owner();
--> statement-breakpoint
CREATE TRIGGER receptions_guard_20_privacy_consent_trg
  BEFORE INSERT OR UPDATE ON public.receptions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_reception_privacy_consent();
--> statement-breakpoint

-- Runtime may only perform the revoke transition. FOR SHARE in the reception
-- guard needs UPDATE on some column; the evidence columns stay unwritable.
-- receptions.privacy_consent_id is absent from the 0019 API UPDATE allowlist.
REVOKE UPDATE ON TABLE public.privacy_consents FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT UPDATE (status, revoked_at, updated_at) ON TABLE public.privacy_consents
  TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE public.privacy_consents FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint

DO $privacy_contract_checks$
BEGIN
  IF (SELECT pg_catalog.array_agg(t.tgname::text ORDER BY t.tgname)
      FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.receptions'::regclass AND NOT t.tgisinternal
        AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4)
    IS DISTINCT FROM ARRAY['receptions_guard_10_current_owner_trg',
      'receptions_guard_20_privacy_consent_trg', 'receptions_lifecycle_trg'] THEN
    RAISE EXCEPTION 'reception BEFORE INSERT trigger order invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid IN ('app.enforce_privacy_consent_evidence()'::regprocedure,
        'app.enforce_reception_current_owner()'::regprocedure,
        'app.enforce_reception_privacy_consent()'::regprocedure)
      AND (p.prosecdef OR p.proowner <> 'tallermecario_schema_owner'::regrole
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']
        OR pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'privacy contract guard function invalid';
  END IF;
  IF pg_catalog.has_column_privilege('tallermecario_api', 'public.privacy_consents',
      'authorization_text_hash', 'UPDATE')
    OR pg_catalog.has_column_privilege('tallermecario_api', 'public.receptions',
      'privacy_consent_id', 'UPDATE') THEN
    RAISE EXCEPTION 'privacy contract evidence column is runtime-writable';
  END IF;
END
$privacy_contract_checks$;
--> statement-breakpoint
RESET ROLE;
