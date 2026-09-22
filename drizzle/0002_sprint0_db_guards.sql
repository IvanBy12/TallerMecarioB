-- Sprint 0 DB gate closure: physical append-only privileges and defensive guards.
-- The guards reject runtime mutations even if a later migration accidentally
-- re-grants a forbidden command. Schema-owner migrations and privileged
-- retention/recovery remain possible through their dedicated roles.
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint

-- These two tables were generated in 0000 as mutable, but their canonical
-- dictionaries classify allocations as runtime-immutable and reconciliation
-- runs as append-only evidence.
DROP POLICY IF EXISTS tenant_update ON public.customer_payment_allocations;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_update ON public.customer_payment_reconciliation_runs;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
	public.customer_payment_allocations,
	public.customer_payment_reconciliation_runs
	FROM tallermecario_api, tallermecario_worker;
--> statement-breakpoint

CREATE FUNCTION app.reject_runtime_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
	IF current_user IN ('tallermecario_api', 'tallermecario_worker') THEN
		RAISE EXCEPTION 'runtime mutation of append-only table %.% is forbidden', TG_TABLE_SCHEMA, TG_TABLE_NAME
			USING ERRCODE = 'insufficient_privilege';
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reject_runtime_append_only_mutation() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER order_status_history_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.order_status_history
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_status_history_append_only_truncate_trg
	BEFORE TRUNCATE ON public.order_status_history
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER quote_authorizations_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.quote_authorizations
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER quote_authorizations_append_only_truncate_trg
	BEFORE TRUNCATE ON public.quote_authorizations
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER quote_authorization_items_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.quote_authorization_items
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER quote_authorization_items_append_only_truncate_trg
	BEFORE TRUNCATE ON public.quote_authorization_items
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER inventory_movements_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.inventory_movements
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_movements_append_only_truncate_trg
	BEFORE TRUNCATE ON public.inventory_movements
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER billing_events_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.billing_events
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER billing_events_append_only_truncate_trg
	BEFORE TRUNCATE ON public.billing_events
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_logs_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.audit_logs
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only_truncate_trg
	BEFORE TRUNCATE ON public.audit_logs
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER webhook_events_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.webhook_events
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER webhook_events_append_only_truncate_trg
	BEFORE TRUNCATE ON public.webhook_events
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER customer_payment_allocations_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.customer_payment_allocations
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER customer_payment_allocations_append_only_truncate_trg
	BEFORE TRUNCATE ON public.customer_payment_allocations
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER customer_payment_reconciliation_runs_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.customer_payment_reconciliation_runs
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER customer_payment_reconciliation_runs_append_only_truncate_trg
	BEFORE TRUNCATE ON public.customer_payment_reconciliation_runs
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

CREATE TRIGGER legal_acceptances_append_only_row_trg
	BEFORE UPDATE OR DELETE ON public.legal_acceptances
	FOR EACH ROW EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER legal_acceptances_append_only_truncate_trg
	BEFORE TRUNCATE ON public.legal_acceptances
	FOR EACH STATEMENT EXECUTE FUNCTION app.reject_runtime_append_only_mutation();
--> statement-breakpoint

RESET ROLE;
