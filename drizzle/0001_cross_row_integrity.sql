-- Sprint 0: cross-row integrity rules that CHECK / FK / UNIQUE cannot express.
--
-- Already covered elsewhere (deliberately NOT re-implemented here):
--   * "at most one primary location"  -> workshop_locations_one_primary_uq (partial UNIQUE)
--   * "stock never negative"          -> ib_quantity_check CHECK (quantity_on_hand >= 0)
--   * "one final decision per quote version" -> qa_one_per_version_key UNIQUE
--
-- Trigger functions are SECURITY INVOKER on purpose: the tenant tables use
-- FORCE ROW LEVEL SECURITY with policies only for the runtime roles, so a
-- definer function owned by the schema owner would see zero rows.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. Exactly one primary workshop_location per workshop (ADR-010 §2.2, Dic. 01).
--    Upper bound: partial UNIQUE. Lower bound: DEFERRABLE INITIALLY DEFERRED
--    constraint trigger, because workshop and its primary location are created
--    (and the primary is swapped: demote old, promote new) in one transaction.
--    Workshop UPDATEs cannot affect the invariant, so only INSERT is watched.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_workshop_primary_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_tenant_ids uuid[];
	v_tenant_id uuid;
BEGIN
	IF TG_TABLE_NAME = 'workshops' THEN
		v_tenant_ids := ARRAY[NEW.id];
	ELSIF TG_OP = 'INSERT' THEN
		v_tenant_ids := ARRAY[NEW.tenant_id];
	ELSIF TG_OP = 'DELETE' THEN
		v_tenant_ids := ARRAY[OLD.tenant_id];
	ELSE
		v_tenant_ids := ARRAY[OLD.tenant_id, NEW.tenant_id];
	END IF;

	FOREACH v_tenant_id IN ARRAY v_tenant_ids LOOP
		-- Workshop gone (or not visible): nothing left to protect.
		CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.workshops AS w WHERE w.id = v_tenant_id);
		IF NOT EXISTS (
			SELECT 1 FROM public.workshop_locations AS l
			WHERE l.tenant_id = v_tenant_id AND l.is_primary
		) THEN
			RAISE EXCEPTION 'workshop % must have exactly one primary workshop_location', v_tenant_id
				USING ERRCODE = 'check_violation',
					CONSTRAINT = 'workshop_primary_location_required';
		END IF;
	END LOOP;
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workshops_primary_location_ct
	AFTER INSERT ON public.workshops
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION app.enforce_workshop_primary_location();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workshop_locations_primary_ct
	AFTER INSERT OR DELETE OR UPDATE OF is_primary, tenant_id ON public.workshop_locations
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION app.enforce_workshop_primary_location();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. QC vs executing technician separation (ERD assignments, Dic. 02 §3/§18,
--    RBAC §Q). The same membership may not hold an active technical assignment
--    (lead/support) and an active quality_control assignment on one order, and
--    may not perform the QC of an order it actively works on. Performing QC
--    also requires an active quality_control assignment for that order.
--    Exception ("taller unipersonal"): no OTHER active membership exists in the
--    tenant. The audit of that exception is an application concern (audit_logs);
--    no column models it in the canonical dictionary.
--    Immediate (not deferred): each statement is checkable on its own.
--    An advisory xact lock on (order, membership) serialises concurrent writers
--    (READ COMMITTED: the loser re-reads after the winner commits).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_assignment_qc_separation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_conflict boolean;
BEGIN
	IF NEW.released_at IS NOT NULL THEN
		RETURN NEW;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'tallermecario:qc-separation:' || NEW.tenant_id::text || ':' || NEW.order_id::text || ':' || NEW.membership_id::text, 0)
	);

	SELECT EXISTS (
		SELECT 1 FROM public.assignments AS a
		WHERE a.tenant_id = NEW.tenant_id
			AND a.order_id = NEW.order_id
			AND a.membership_id = NEW.membership_id
			AND a.released_at IS NULL
			AND a.id <> NEW.id
			AND (a.assignment_type = 'quality_control') <> (NEW.assignment_type = 'quality_control')
	) INTO v_conflict;

	IF v_conflict AND EXISTS (
		SELECT 1 FROM public.memberships AS m
		WHERE m.tenant_id = NEW.tenant_id
			AND m.status = 'active'
			AND m.id <> NEW.membership_id
	) THEN
		RAISE EXCEPTION 'membership cannot hold technician and quality_control assignments on the same order'
			USING ERRCODE = 'check_violation',
				CONSTRAINT = 'assignments_qc_separation';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER assignments_qc_separation_trg
	BEFORE INSERT OR UPDATE OF membership_id, order_id, assignment_type, released_at ON public.assignments
	FOR EACH ROW EXECUTE FUNCTION app.enforce_assignment_qc_separation();
--> statement-breakpoint

CREATE FUNCTION app.enforce_quality_check_separation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'tallermecario:qc-separation:' || NEW.tenant_id::text || ':' || NEW.order_id::text || ':' || NEW.checked_by_membership_id::text, 0)
	);

	IF EXISTS (
		SELECT 1 FROM public.assignments AS a
		WHERE a.tenant_id = NEW.tenant_id
			AND a.order_id = NEW.order_id
			AND a.membership_id = NEW.checked_by_membership_id
			AND a.released_at IS NULL
			AND a.assignment_type IN ('lead_technician', 'support_technician')
	) AND EXISTS (
		SELECT 1 FROM public.memberships AS m
		WHERE m.tenant_id = NEW.tenant_id
			AND m.status = 'active'
			AND m.id <> NEW.checked_by_membership_id
	) THEN
		RAISE EXCEPTION 'executing technician cannot be the quality check owner of the same order'
			USING ERRCODE = 'check_violation',
				CONSTRAINT = 'quality_checks_separation_of_duties';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM public.assignments AS a
		WHERE a.tenant_id = NEW.tenant_id
			AND a.order_id = NEW.order_id
			AND a.membership_id = NEW.checked_by_membership_id
			AND a.released_at IS NULL
			AND a.assignment_type = 'quality_control'
	) THEN
		RAISE EXCEPTION 'quality check owner needs an active quality_control assignment for the order'
			USING ERRCODE = 'check_violation',
				CONSTRAINT = 'quality_checks_active_assignment_required';
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER quality_checks_separation_trg
	BEFORE INSERT OR UPDATE OF checked_by_membership_id, order_id ON public.quality_checks
	FOR EACH ROW EXECUTE FUNCTION app.enforce_quality_check_separation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. SUM(customer_payment_allocations.allocated_amount) <= customer_payments.amount
--    (Dic. 03 §13). Not expressible as CHECK. Immediate is enough: allocations
--    only grow within a statement sequence, so every intermediate state is also
--    checked. The parent payment row is locked (FOR NO KEY UPDATE, compatible
--    with FK KEY SHARE) to serialise concurrent allocators; the loser re-sums
--    after the winner commits (READ COMMITTED).
--    Also fires when a payment amount is lowered below what is already allocated.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_customer_payment_allocation_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_payment_id uuid;
	v_amount bigint;
	v_allocated numeric;
BEGIN
	IF TG_TABLE_NAME = 'customer_payments' THEN
		-- The UPDATE already owns the parent-row lock. Re-locking that same tuple
		-- from its AFTER trigger raises "tuple already modified by this command".
		v_payment_id := NEW.id;
		v_amount := NEW.amount;
	ELSE
		v_payment_id := NEW.customer_payment_id;
		SELECT p.amount INTO v_amount
		FROM public.customer_payments AS p
		WHERE p.tenant_id = NEW.tenant_id AND p.id = v_payment_id
		FOR NO KEY UPDATE;
	END IF;

	SELECT COALESCE(SUM(a.allocated_amount), 0) INTO v_allocated
	FROM public.customer_payment_allocations AS a
	WHERE a.tenant_id = NEW.tenant_id AND a.customer_payment_id = v_payment_id;

	IF v_allocated > v_amount THEN
		RAISE EXCEPTION 'allocations (%) exceed customer payment amount (%)', v_allocated, v_amount
			USING ERRCODE = 'check_violation',
				CONSTRAINT = 'customer_payment_allocations_cap';
	END IF;
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE TRIGGER customer_payment_allocations_cap_trg
	AFTER INSERT OR UPDATE OF allocated_amount, customer_payment_id ON public.customer_payment_allocations
	FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_payment_allocation_cap();
--> statement-breakpoint
CREATE TRIGGER customer_payments_allocation_cap_trg
	AFTER UPDATE OF amount ON public.customer_payments
	FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_payment_allocation_cap();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. partially_approved needs >=1 approved line AND >=1 rejected-or-reduced line
--    (Dic. 02 §15, ERD quote_authorization_items). The authorization row must
--    exist before its items (FK), so this is DEFERRABLE INITIALLY DEFERRED and
--    checked at COMMIT. Authorizations/items are append-only, so watching the
--    authorization INSERT is sufficient: later item inserts can only add lines.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.enforce_partial_authorization_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
	v_approved integer;
	v_not_full integer;
BEGIN
	IF NEW.decision <> 'partially_approved' THEN
		RETURN NULL;
	END IF;

	SELECT COUNT(*) FILTER (WHERE i.decision = 'approved'),
		COUNT(*) FILTER (WHERE i.decision = 'rejected'
			OR (i.decision = 'approved' AND i.authorized_quantity < qi.quantity))
	INTO v_approved, v_not_full
	FROM public.quote_authorization_items AS i
	JOIN public.quote_items AS qi
		ON qi.tenant_id = i.tenant_id AND qi.id = i.quote_item_id
	WHERE i.tenant_id = NEW.tenant_id AND i.authorization_id = NEW.id;

	IF v_approved = 0 OR v_not_full = 0 THEN
		RAISE EXCEPTION 'partially_approved authorization % needs an approved line and a rejected or reduced line', NEW.id
			USING ERRCODE = 'check_violation',
				CONSTRAINT = 'quote_authorizations_partial_lines';
	END IF;
	RETURN NULL;
END
$function$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER quote_authorizations_partial_lines_ct
	AFTER INSERT ON public.quote_authorizations
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION app.enforce_partial_authorization_lines();
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.enforce_workshop_primary_location(),
	app.enforce_assignment_qc_separation(),
	app.enforce_quality_check_separation(),
	app.enforce_customer_payment_allocation_cap(),
	app.enforce_partial_authorization_lines()
	FROM PUBLIC;
--> statement-breakpoint
RESET ROLE;
