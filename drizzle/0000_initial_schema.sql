-- ADR-009 bootstrap. This migration must be run by the local/CI database owner
-- (or another role with CREATEROLE) the first time. It creates no passwords.
DO $roles$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_schema_owner') THEN
		CREATE ROLE tallermecario_schema_owner;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_migrator') THEN
		CREATE ROLE tallermecario_migrator;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_api') THEN
		CREATE ROLE tallermecario_api;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_worker') THEN
		CREATE ROLE tallermecario_worker;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tallermecario_bootstrap_resolver') THEN
		CREATE ROLE tallermecario_bootstrap_resolver;
	END IF;
END
$roles$;
--> statement-breakpoint
ALTER ROLE tallermecario_schema_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_api WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_bootstrap_resolver WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;
--> statement-breakpoint
GRANT tallermecario_schema_owner TO tallermecario_migrator;
--> statement-breakpoint
DO $runtime_role_isolation$
DECLARE
	membership record;
BEGIN
	FOR membership IN
		SELECT granted.rolname AS granted_role, member.rolname AS member_role
		FROM pg_catalog.pg_auth_members AS relation
		JOIN pg_catalog.pg_roles AS granted ON granted.oid = relation.roleid
		JOIN pg_catalog.pg_roles AS member ON member.oid = relation.member
		WHERE granted.rolname IN (
			'tallermecario_schema_owner',
			'tallermecario_migrator',
			'tallermecario_bootstrap_resolver'
		)
			AND member.rolname IN ('tallermecario_api', 'tallermecario_worker')
	LOOP
		EXECUTE pg_catalog.format(
			'REVOKE %I FROM %I',
			membership.granted_role,
			membership.member_role
		);
	END LOOP;

	IF pg_catalog.pg_has_role('tallermecario_api', 'tallermecario_schema_owner', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_api', 'tallermecario_migrator', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_api', 'tallermecario_bootstrap_resolver', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_worker', 'tallermecario_schema_owner', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_worker', 'tallermecario_migrator', 'SET')
		OR pg_catalog.pg_has_role('tallermecario_worker', 'tallermecario_bootstrap_resolver', 'SET') THEN
		RAISE EXCEPTION 'runtime role retains a privileged SET ROLE path';
	END IF;
END
$runtime_role_isolation$;
--> statement-breakpoint

-- A first-run database owner may not already be a member of the two NOLOGIN
-- ownership roles. Membership is borrowed only for this migration and revoked
-- at the end; the migrator's intentional schema-owner membership is preserved.
DO $migration_memberships$
DECLARE
	executor_role name := session_user;
BEGIN
	IF NOT pg_catalog.pg_has_role(executor_role, 'tallermecario_schema_owner', 'MEMBER') THEN
		EXECUTE pg_catalog.format('GRANT tallermecario_schema_owner TO %I', executor_role);
		PERFORM pg_catalog.set_config('tallermecario.migration_revoke_owner', 'true', false);
	ELSE
		PERFORM pg_catalog.set_config('tallermecario.migration_revoke_owner', 'false', false);
	END IF;

	IF NOT pg_catalog.pg_has_role(executor_role, 'tallermecario_bootstrap_resolver', 'MEMBER') THEN
		EXECUTE pg_catalog.format('GRANT tallermecario_bootstrap_resolver TO %I', executor_role);
		PERFORM pg_catalog.set_config('tallermecario.migration_revoke_resolver', 'true', false);
	ELSE
		PERFORM pg_catalog.set_config('tallermecario.migration_revoke_resolver', 'false', false);
	END IF;
END
$migration_memberships$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
ALTER SCHEMA public OWNER TO tallermecario_schema_owner;
--> statement-breakpoint
DO $database_grant$
BEGIN
	EXECUTE pg_catalog.format(
		'GRANT CREATE ON DATABASE %I TO tallermecario_schema_owner',
		pg_catalog.current_database()
	);
END
$database_grant$;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION tallermecario_schema_owner;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public, app FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public, app FROM tallermecario_api, tallermecario_worker, tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app TO tallermecario_api, tallermecario_worker, tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"location_id" uuid,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"source" varchar(24) DEFAULT 'staff' NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_status_check" CHECK ("status" IN ('scheduled', 'confirmed', 'arrived', 'cancelled', 'no_show', 'completed')),
	CONSTRAINT "appointments_source_check" CHECK ("source" IN ('staff', 'customer', 'import', 'other')),
	CONSTRAINT "appointments_window_check" CHECK ("scheduled_end" > "scheduled_start")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"assignment_type" varchar(24) NOT NULL,
	"assigned_by_membership_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "assignments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "assignments_scope_key" UNIQUE("tenant_id","id","order_id","membership_id"),
	CONSTRAINT "assignments_type_check" CHECK ("assignment_type" IN ('lead_technician', 'support_technician', 'quality_control')),
	CONSTRAINT "assignments_released_check" CHECK ("released_at" IS NULL OR "released_at" > "assigned_at")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"actor_type" varchar(16) NOT NULL,
	"actor_user_id" uuid,
	"actor_membership_id" uuid,
	"action" varchar(120) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" uuid,
	"reason_code" varchar(120),
	"before_json" jsonb,
	"after_json" jsonb,
	"metadata_json" jsonb,
	"request_id" varchar(128) NOT NULL,
	"trace_id" varchar(64),
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("actor_type" IN ('user', 'system', 'provider', 'platform')),
	CONSTRAINT "audit_logs_outcome_check" CHECK ("outcome" IN ('success', 'denied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"event_type" varchar(120) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_events_provider_event_key" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_type" varchar(16) NOT NULL,
	"code" varchar(80),
	"barcode" varchar(120),
	"name" varchar(200) NOT NULL,
	"description" text,
	"default_unit_price" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"tax_rate" numeric(7, 4),
	"unit" varchar(40),
	"default_warranty_duration_value" integer,
	"default_warranty_duration_unit" varchar(8),
	"default_warranty_terms" text,
	"track_inventory" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_items_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_items_type_check" CHECK ("item_type" IN ('service', 'labor', 'part', 'other')),
	CONSTRAINT "catalog_items_warranty_unit_check" CHECK ("default_warranty_duration_unit" IN ('day', 'month', 'year')),
	CONSTRAINT "catalog_items_price_check" CHECK ("default_unit_price" >= 0),
	CONSTRAINT "catalog_items_tax_rate_check" CHECK ("tax_rate" BETWEEN 0 AND 100),
	CONSTRAINT "catalog_items_warranty_value_check" CHECK ("default_warranty_duration_value" > 0),
	CONSTRAINT "catalog_items_warranty_pair_check" CHECK (("default_warranty_duration_value" IS NULL) = ("default_warranty_duration_unit" IS NULL)),
	CONSTRAINT "catalog_items_track_inventory_check" CHECK (NOT "track_inventory" OR "item_type" = 'part')
);
--> statement-breakpoint
CREATE TABLE "customer_order_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"access_scope" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"revoke_reason" text,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coat_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "coat_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "coat_access_scope_check" CHECK ("access_scope" IN ('order_tracking', 'delivery_summary')),
	CONSTRAINT "coat_status_check" CHECK ("status" IN ('active', 'revoked')),
	CONSTRAINT "coat_revoked_check" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customer_payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"allocated_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cpa_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cpa_allocated_amount_check" CHECK ("allocated_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_payment_reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"run_source" varchar(16) NOT NULL,
	"initiated_by_membership_id" uuid,
	"status" varchar(16) NOT NULL,
	"confirmed_total" bigint DEFAULT 0 NOT NULL,
	"allocated_total" bigint DEFAULT 0 NOT NULL,
	"unallocated_total" bigint DEFAULT 0 NOT NULL,
	"reversed_total" bigint DEFAULT 0 NOT NULL,
	"discrepancy_count" integer DEFAULT 0 NOT NULL,
	"details_json" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cprr_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "cprr_run_source_check" CHECK ("run_source" IN ('scheduled', 'manual')),
	CONSTRAINT "cprr_status_check" CHECK ("status" IN ('ok', 'issues')),
	CONSTRAINT "cprr_period_check" CHECK ("period_end" > "period_start"),
	CONSTRAINT "cprr_window_check" CHECK ("finished_at" >= "started_at"),
	CONSTRAINT "cprr_totals_check" CHECK ("confirmed_total" >= 0 AND "allocated_total" >= 0 AND "unallocated_total" >= 0 AND "reversed_total" >= 0 AND "discrepancy_count" >= 0),
	CONSTRAINT "cprr_manual_actor_check" CHECK ("run_source" <> 'manual' OR "initiated_by_membership_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_method" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"reference" varchar(160),
	"receipt_number" varchar(80),
	"idempotency_key" uuid,
	"paid_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_membership_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_membership_id" uuid,
	"reversal_reason" text,
	"correction_of_payment_id" uuid,
	"recorded_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_payments_method_check" CHECK ("payment_method" IN ('cash', 'card', 'bank_transfer', 'nequi', 'daviplata', 'other')),
	CONSTRAINT "customer_payments_status_check" CHECK ("status" IN ('pending', 'confirmed', 'reversed')),
	CONSTRAINT "customer_payments_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "customer_payments_currency_check" CHECK ("currency" = 'COP'),
	CONSTRAINT "customer_payments_reversed_check" CHECK ("status" <> 'reversed'
       OR ("reversed_at" IS NOT NULL
           AND "reversed_by_membership_id" IS NOT NULL
           AND "reversal_reason" IS NOT NULL)),
	CONSTRAINT "customer_payments_confirmed_check" CHECK ("status" NOT IN ('confirmed','reversed') OR "confirmed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_type" varchar(24),
	"document_number" varchar(40),
	"first_name" varchar(120) NOT NULL,
	"last_name" varchar(120) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(320),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "damage_media" (
	"tenant_id" uuid NOT NULL,
	"damage_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "damage_media_pk" PRIMARY KEY("tenant_id","damage_id","media_asset_id","purpose"),
	CONSTRAINT "damage_media_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"controller_scope" varchar(16) NOT NULL,
	"tenant_id" uuid,
	"customer_id" uuid,
	"user_id" uuid,
	"subject_reference" varchar(255),
	"request_type" varchar(16) NOT NULL,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"evidence_reference" text,
	"assigned_to_reference" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dsr_controller_scope_check" CHECK ("controller_scope" IN ('tenant', 'ilvox')),
	CONSTRAINT "dsr_request_type_check" CHECK ("request_type" IN ('consult', 'update', 'correct', 'delete', 'revoke')),
	CONSTRAINT "dsr_status_check" CHECK ("status" IN ('received', 'in_review', 'awaiting_information', 'resolved', 'rejected')),
	CONSTRAINT "dsr_scope_check" CHECK (("controller_scope" = 'tenant') = ("tenant_id" IS NOT NULL)),
	CONSTRAINT "dsr_customer_scope_check" CHECK ("customer_id" IS NULL OR "controller_scope" = 'tenant'),
	CONSTRAINT "dsr_subject_identifier_check" CHECK ("customer_id" IS NOT NULL OR "user_id" IS NOT NULL OR "subject_reference" IS NOT NULL),
	CONSTRAINT "dsr_resolution_check" CHECK ((("status" IN ('resolved','rejected')) = ("resolved_at" IS NOT NULL))
       AND ("status" NOT IN ('resolved','rejected') OR "resolution" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"delivered_to_name" varchar(200),
	"delivered_by_membership_id" uuid,
	"final_amount" bigint,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"payment_status" varchar(16) DEFAULT 'unpaid' NOT NULL,
	"outstanding_balance" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "deliveries_order_key" UNIQUE("tenant_id","order_id"),
	CONSTRAINT "deliveries_status_check" CHECK ("status" IN ('pending', 'completed')),
	CONSTRAINT "deliveries_payment_status_check" CHECK ("payment_status" IN ('unpaid', 'partial', 'paid')),
	CONSTRAINT "deliveries_amount_check" CHECK ("final_amount" >= 0 AND "outstanding_balance" >= 0),
	CONSTRAINT "deliveries_completed_check" CHECK (("status" = 'completed') = ("delivered_at" IS NOT NULL)
       AND ("status" <> 'completed'
            OR ("delivered_to_name" IS NOT NULL AND "delivered_by_membership_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "delivery_media" (
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_media_pk" PRIMARY KEY("tenant_id","delivery_id","media_asset_id","purpose"),
	CONSTRAINT "delivery_media_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "diagnostics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"diagnosed_by_membership_id" uuid NOT NULL,
	"summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostics_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "diagnostics_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "diagnostics_status_check" CHECK ("status" IN ('draft', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "diagnostics_terminal_coherence_check" CHECK ((("status" = 'completed') = ("completed_at" IS NOT NULL))
       AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
       AND ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"plan_id" uuid,
	"feature_key" varchar(120) NOT NULL,
	"scope" varchar(16) NOT NULL,
	"enabled" boolean NOT NULL,
	"value_json" jsonb,
	"enabled_from" timestamp with time zone,
	"enabled_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_scope_check" CHECK ("scope" IN ('global', 'plan', 'tenant')),
	CONSTRAINT "feature_flags_scope_semantics_check" CHECK (("scope" = 'global' AND "tenant_id" IS NULL AND "plan_id" IS NULL)
       OR ("scope" = 'plan' AND "tenant_id" IS NULL AND "plan_id" IS NOT NULL)
       OR ("scope" = 'tenant' AND "tenant_id" IS NOT NULL AND "plan_id" IS NULL)),
	CONSTRAINT "feature_flags_window_check" CHECK ("enabled_until" IS NULL OR "enabled_from" IS NULL OR "enabled_until" > "enabled_from")
);
--> statement-breakpoint
CREATE TABLE "finding_media" (
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_media_pk" PRIMARY KEY("tenant_id","finding_id","media_asset_id","purpose"),
	CONSTRAINT "finding_media_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"diagnostic_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"category" varchar(64) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text NOT NULL,
	"severity" varchar(16) DEFAULT 'medium' NOT NULL,
	"requires_action" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "findings_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "findings_severity_check" CHECK ("severity" IN ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity_on_hand" numeric(14, 4) DEFAULT '0' NOT NULL,
	"low_stock_threshold" numeric(14, 4) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ib_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ib_item_location_key" UNIQUE("tenant_id","catalog_item_id","location_id"),
	CONSTRAINT "ib_quantity_check" CHECK ("quantity_on_hand" >= 0 AND "low_stock_threshold" >= 0),
	CONSTRAINT "ib_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"service_order_item_id" uuid,
	"movement_type" varchar(24) NOT NULL,
	"quantity_delta" numeric(14, 4) NOT NULL,
	"transfer_group_id" uuid,
	"reason" text,
	"performed_by_membership_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "im_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "im_movement_type_check" CHECK ("movement_type" IN ('initial', 'receipt', 'consumption', 'return', 'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out')),
	CONSTRAINT "im_quantity_delta_check" CHECK ("quantity_delta" <> 0),
	CONSTRAINT "im_sign_check" CHECK ((
         "movement_type" IN ('initial','receipt','return','adjustment_in','transfer_in')
         AND "quantity_delta" > 0
       ) OR (
         "movement_type" IN ('consumption','adjustment_out','transfer_out')
         AND "quantity_delta" < 0
       )),
	CONSTRAINT "im_transfer_group_check" CHECK (("movement_type" IN ('transfer_in','transfer_out')) = ("transfer_group_id" IS NOT NULL)),
	CONSTRAINT "im_adjustment_reason_check" CHECK ("movement_type" NOT IN ('adjustment_in','adjustment_out')
       OR ("reason" IS NOT NULL AND btrim("reason") <> '')),
	CONSTRAINT "im_order_link_check" CHECK ("movement_type" NOT IN ('consumption','return') OR "service_order_item_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"acceptance_scope" varchar(16) NOT NULL,
	"tenant_id" uuid,
	"accepted_by_user_id" uuid NOT NULL,
	"document_type" varchar(32) NOT NULL,
	"document_version" varchar(40) NOT NULL,
	"document_hash" varchar(128) NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"channel" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_acceptances_scope_check" CHECK ("acceptance_scope" IN ('global_user', 'tenant')),
	CONSTRAINT "legal_acceptances_document_type_check" CHECK ("document_type" IN ('terms', 'privacy_policy', 'dpa', 'commercial_terms', 'other')),
	CONSTRAINT "legal_acceptances_channel_check" CHECK ("channel" IN ('web', 'admin', 'import', 'other')),
	CONSTRAINT "legal_acceptances_scope_tenant_check" CHECK (("acceptance_scope" = 'tenant') = ("tenant_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_provider" varchar(24) DEFAULT 'cloudflare_r2' NOT NULL,
	"bucket" varchar(120) NOT NULL,
	"object_key" varchar(512) NOT NULL,
	"media_type" varchar(24) NOT NULL,
	"mime_type" varchar(160) NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" char(64),
	"status" varchar(24) DEFAULT 'pending_upload' NOT NULL,
	"retention_class" varchar(32) NOT NULL,
	"retention_until" timestamp with time zone,
	"retention_policy_version" varchar(32) NOT NULL,
	"legal_hold_until" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"delete_reason" varchar(160),
	"captured_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "media_assets_object_key" UNIQUE("storage_provider","bucket","object_key"),
	CONSTRAINT "media_assets_media_type_check" CHECK ("media_type" IN ('photo', 'video360', 'video', 'signature', 'quote_pdf', 'document')),
	CONSTRAINT "media_assets_status_check" CHECK ("status" IN ('pending_upload', 'uploaded', 'active', 'quarantined', 'deleted')),
	CONSTRAINT "media_assets_retention_class_check" CHECK ("retention_class" IN ('ephemeral_upload', 'operational', 'warranty_evidence', 'authorization_evidence', 'delivery_evidence', 'document')),
	CONSTRAINT "media_assets_size_check" CHECK ("size_bytes" >= 0),
	CONSTRAINT "media_assets_purge_order_check" CHECK ("purged_at" IS NULL OR ("deleted_at" IS NOT NULL AND "purged_at" >= "deleted_at"))
);
--> statement-breakpoint
CREATE TABLE "membership_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"email_normalized" varchar(320) NOT NULL,
	"target_role_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"accepted_membership_id" uuid,
	"invited_by_membership_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mi_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "mi_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "mi_status_check" CHECK ("status" IN ('pending', 'accepted', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "membership_roles" (
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by_membership_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_roles_pk" PRIMARY KEY("tenant_id","membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "memberships_tenant_user_key" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "memberships_status_check" CHECK ("status" IN ('active', 'suspended', 'revoked')),
	CONSTRAINT "memberships_status_coherence_check" CHECK (("status" <> 'active' OR "revoked_at" IS NULL)
       AND ("status" <> 'suspended' OR "suspended_at" IS NOT NULL)
       AND ("status" <> 'revoked' OR "revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"channel" varchar(16) NOT NULL,
	"external_thread_ref" varchar(255),
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_threads_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "message_threads_channel_check" CHECK ("channel" IN ('whatsapp', 'email', 'sms', 'other')),
	CONSTRAINT "message_threads_status_check" CHECK ("status" IN ('open', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"whatsapp_account_id" uuid,
	"direction" varchar(12) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_message_id" varchar(255),
	"message_type" varchar(20) NOT NULL,
	"body" text,
	"status" varchar(16) NOT NULL,
	"provider_status_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "messages_direction_check" CHECK ("direction" IN ('inbound', 'outbound')),
	CONSTRAINT "messages_provider_check" CHECK ("provider" IN ('meta_whatsapp', 'email', 'sms', 'internal')),
	CONSTRAINT "messages_type_check" CHECK ("message_type" IN ('text', 'template', 'media', 'system')),
	CONSTRAINT "messages_status_check" CHECK ("status" IN ('received', 'queued', 'accepted', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_whatsapp_account_required_check" CHECK ("provider" <> 'meta_whatsapp' OR "whatsapp_account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32) NOT NULL,
	"reason" text,
	"changed_by_membership_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" varchar(128) NOT NULL,
	CONSTRAINT "osh_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "osh_from_status_check" CHECK ("from_status" IN ('reception', 'diagnosis', 'quote_pending', 'approved', 'partially_approved', 'rejected', 'in_progress', 'quality_control', 'ready_for_delivery', 'delivered', 'cancelled')),
	CONSTRAINT "osh_to_status_check" CHECK ("to_status" IN ('reception', 'diagnosis', 'quote_pending', 'approved', 'partially_approved', 'rejected', 'in_progress', 'quality_control', 'ready_for_delivery', 'delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid,
	"event_type" varchar(120) NOT NULL,
	"event_version" smallint DEFAULT 1 NOT NULL,
	"payload_json" jsonb NOT NULL,
	"idempotency_key" uuid,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_check" CHECK ("status" IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
	CONSTRAINT "outbox_events_event_version_check" CHECK ("event_version" > 0),
	CONSTRAINT "outbox_events_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'wompi' NOT NULL,
	"environment" varchar(16) NOT NULL,
	"reference" varchar(160) NOT NULL,
	"provider_transaction_id" varchar(255),
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_reference_key" UNIQUE("reference"),
	CONSTRAINT "payments_environment_check" CHECK ("environment" IN ('test', 'production')),
	CONSTRAINT "payments_status_check" CHECK ("status" IN ('pending', 'approved', 'declined', 'error', 'voided')),
	CONSTRAINT "payments_amount_check" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_code_key" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"billing_period" varchar(16) NOT NULL,
	"price_amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_key" UNIQUE("code"),
	CONSTRAINT "plans_billing_period_check" CHECK ("billing_period" IN ('monthly', 'yearly')),
	CONSTRAINT "plans_price_amount_check" CHECK ("price_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "privacy_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose_code" varchar(80) NOT NULL,
	"privacy_notice_version" varchar(40) NOT NULL,
	"authorization_text_version" varchar(40) NOT NULL,
	"channel" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'granted' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"evidence_hash" varchar(128),
	"evidence_media_id" uuid,
	"ip_address" "inet",
	"user_agent" text,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_consents_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "privacy_consents_channel_check" CHECK ("channel" IN ('web', 'in_person', 'whatsapp', 'email', 'phone', 'import', 'other')),
	CONSTRAINT "privacy_consents_status_check" CHECK ("status" IN ('granted', 'revoked')),
	CONSTRAINT "privacy_consents_revoked_check" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "privacy_security_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"controller_scope" varchar(16) NOT NULL,
	"tenant_id" uuid,
	"detected_at" timestamp with time zone NOT NULL,
	"reported_internally_at" timestamp with time zone NOT NULL,
	"systems_affected" text[] NOT NULL,
	"categories_of_data" text[] NOT NULL,
	"estimated_records" integer,
	"risk_level" varchar(16) NOT NULL,
	"containment_actions" text,
	"sic_report_required" boolean DEFAULT false NOT NULL,
	"sic_reported_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"postmortem_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "psi_controller_scope_check" CHECK ("controller_scope" IN ('tenant', 'ilvox')),
	CONSTRAINT "psi_risk_level_check" CHECK ("risk_level" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "psi_status_check" CHECK ("status" IN ('open', 'investigating', 'contained', 'resolved', 'closed')),
	CONSTRAINT "psi_scope_check" CHECK (("controller_scope" = 'tenant') = ("tenant_id" IS NOT NULL)),
	CONSTRAINT "psi_estimated_records_check" CHECK ("estimated_records" >= 0),
	CONSTRAINT "psi_sic_report_check" CHECK ("sic_reported_at" IS NULL OR "sic_report_required" = true)
);
--> statement-breakpoint
CREATE TABLE "quality_check_media" (
	"tenant_id" uuid NOT NULL,
	"quality_check_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_check_media_pk" PRIMARY KEY("tenant_id","quality_check_id","media_asset_id","purpose"),
	CONSTRAINT "qcm_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"checked_by_membership_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"notes" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qc_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qc_status_check" CHECK ("status" IN ('pending', 'passed', 'failed')),
	CONSTRAINT "qc_checked_at_check" CHECK (("status" IN ('passed','failed')) = ("checked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "quote_authorization_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authorization_token_id" uuid NOT NULL,
	"code_hash" varchar(128),
	"hash_key_version" smallint,
	"status" varchar(20) DEFAULT 'requested' NOT NULL,
	"delivery_channel" varchar(16) DEFAULT 'whatsapp' NOT NULL,
	"destination_masked" varchar(160),
	"delivery_message_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verification_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qac_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qac_token_scope_key" UNIQUE("tenant_id","id","authorization_token_id"),
	CONSTRAINT "qac_status_check" CHECK ("status" IN ('requested', 'active', 'verified', 'consumed', 'expired', 'locked', 'superseded', 'delivery_failed')),
	CONSTRAINT "qac_delivery_channel_check" CHECK ("delivery_channel" IN ('whatsapp', 'email', 'sms')),
	CONSTRAINT "qac_max_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 10),
	CONSTRAINT "qac_attempt_count_check" CHECK ("attempt_count" BETWEEN 0 AND "max_attempts"),
	CONSTRAINT "qac_hash_key_version_check" CHECK ("hash_key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "quote_authorization_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"quote_item_id" uuid NOT NULL,
	"decision" varchar(16) NOT NULL,
	"authorized_quantity" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qai_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qai_item_decision_key" UNIQUE("tenant_id","authorization_id","quote_item_id"),
	CONSTRAINT "qai_decision_check" CHECK ("decision" IN ('approved', 'rejected')),
	CONSTRAINT "qai_authorized_quantity_check" CHECK ("decision" <> 'approved'
       OR ("authorized_quantity" IS NOT NULL AND "authorized_quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "quote_authorization_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by_membership_id" uuid NOT NULL,
	"issued_for_message_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"revoke_reason" text,
	"superseded_at" timestamp with time zone,
	"supersede_reason" varchar(24),
	"superseded_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qat_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qat_version_scope_key" UNIQUE("tenant_id","id","quote_version_id"),
	CONSTRAINT "qat_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "qat_status_check" CHECK ("status" IN ('active', 'consumed', 'expired', 'revoked', 'superseded')),
	CONSTRAINT "qat_supersede_reason_check" CHECK ("supersede_reason" IN ('quote_revised', 'sibling_consumed'))
);
--> statement-breakpoint
CREATE TABLE "quote_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"authorization_token_id" uuid,
	"authorization_challenge_id" uuid,
	"decision" varchar(24) NOT NULL,
	"authorized_amount" bigint,
	"customer_name" varchar(200) NOT NULL,
	"customer_document" varchar(60),
	"channel" varchar(32) NOT NULL,
	"recorded_by_membership_id" uuid,
	"ip_address" "inet",
	"user_agent" text,
	"authorized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qa_version_scope_key" UNIQUE("tenant_id","id","quote_version_id"),
	CONSTRAINT "qa_one_per_version_key" UNIQUE("tenant_id","quote_version_id"),
	CONSTRAINT "qa_decision_check" CHECK ("decision" IN ('approved', 'partially_approved', 'rejected')),
	CONSTRAINT "qa_channel_check" CHECK ("channel" IN ('public_whatsapp_otp', 'manual_in_person', 'manual_phone', 'other_manual')),
	CONSTRAINT "qa_authorized_amount_check" CHECK ("authorized_amount" >= 0
       AND ("decision" = 'rejected' OR "authorized_amount" IS NOT NULL)),
	CONSTRAINT "qa_flow_check" CHECK ((
         "channel" = 'public_whatsapp_otp'
         AND "authorization_token_id" IS NOT NULL
         AND "authorization_challenge_id" IS NOT NULL
         AND "recorded_by_membership_id" IS NULL
       ) OR (
         "channel" <> 'public_whatsapp_otp'
         AND "authorization_token_id" IS NULL
         AND "authorization_challenge_id" IS NULL
         AND "recorded_by_membership_id" IS NOT NULL
       ))
);
--> statement-breakpoint
CREATE TABLE "quote_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"finding_id" uuid,
	"catalog_item_id" uuid,
	"sales_originator_membership_id" uuid NOT NULL,
	"item_type" varchar(16) NOT NULL,
	"code_snapshot" varchar(80),
	"name_snapshot" varchar(200) NOT NULL,
	"description_snapshot" text,
	"unit" varchar(40),
	"quantity" numeric(14, 4) NOT NULL,
	"unit_price" bigint NOT NULL,
	"tax_rate_snapshot" numeric(7, 4),
	"warranty_duration_value_snapshot" integer,
	"warranty_duration_unit_snapshot" varchar(8),
	"warranty_terms_snapshot" text,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"line_total" bigint NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qi_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qi_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "qi_version_scope_key" UNIQUE("tenant_id","id","quote_version_id"),
	CONSTRAINT "qi_item_type_check" CHECK ("item_type" IN ('service', 'labor', 'part', 'other')),
	CONSTRAINT "qi_warranty_unit_check" CHECK ("warranty_duration_unit_snapshot" IN ('day', 'month', 'year')),
	CONSTRAINT "qi_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "qi_amounts_check" CHECK ("unit_price" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0 AND "sort_order" >= 0),
	CONSTRAINT "qi_tax_rate_check" CHECK ("tax_rate_snapshot" BETWEEN 0 AND 100),
	CONSTRAINT "qi_warranty_value_check" CHECK ("warranty_duration_value_snapshot" > 0),
	CONSTRAINT "qi_warranty_pair_check" CHECK (("warranty_duration_value_snapshot" IS NULL) = ("warranty_duration_unit_snapshot" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "quote_media" (
	"tenant_id" uuid NOT NULL,
	"quote_version_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_media_pk" PRIMARY KEY("tenant_id","quote_version_id","media_asset_id","purpose"),
	CONSTRAINT "quote_media_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"subtotal_amount" bigint NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"notes" text,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "qv_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "qv_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "qv_quote_order_scope_key" UNIQUE("tenant_id","id","quote_id","order_id"),
	CONSTRAINT "qv_version_number_key" UNIQUE("tenant_id","quote_id","version_number"),
	CONSTRAINT "qv_version_number_check" CHECK ("version_number" > 0),
	CONSTRAINT "qv_amounts_check" CHECK ("subtotal_amount" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"quote_type" varchar(16) DEFAULT 'initial' NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_by_membership_id" uuid NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_membership_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "quotes_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "quotes_type_check" CHECK ("quote_type" IN ('initial', 'supplemental')),
	CONSTRAINT "quotes_status_check" CHECK ("status" IN ('draft', 'awaiting_authorization', 'approved', 'partially_approved', 'rejected', 'cancelled')),
	CONSTRAINT "quotes_cancelled_coherence_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
       AND ("status" <> 'cancelled'
            OR ("cancelled_by_membership_id" IS NOT NULL AND "cancel_reason" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "reception_check_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(160) NOT NULL,
	"status" varchar(24) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rci_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "rci_reception_code_key" UNIQUE("tenant_id","reception_id","code"),
	CONSTRAINT "rci_status_check" CHECK ("status" IN ('ok', 'issue', 'not_checked', 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "reception_media" (
	"tenant_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reception_media_pk" PRIMARY KEY("tenant_id","reception_id","media_asset_id","purpose"),
	CONSTRAINT "reception_media_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "receptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"appointment_id" uuid,
	"location_id" uuid,
	"received_by_membership_id" uuid NOT NULL,
	"mileage_km" integer NOT NULL,
	"fuel_level_pct" smallint,
	"customer_notes" text,
	"advisor_notes" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receptions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "receptions_lineage_key" UNIQUE("tenant_id","id","vehicle_id","customer_id"),
	CONSTRAINT "receptions_status_check" CHECK ("status" IN ('open', 'closed', 'cancelled')),
	CONSTRAINT "receptions_mileage_check" CHECK ("mileage_km" >= 0),
	CONSTRAINT "receptions_fuel_check" CHECK ("fuel_level_pct" BETWEEN 0 AND 100),
	CONSTRAINT "receptions_closed_at_check" CHECK (("status" = 'open' AND "closed_at" IS NULL)
       OR ("status" IN ('closed','cancelled') AND "closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"description" text NOT NULL,
	"recommended_action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_tenant_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid,
	"customer_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reminders_channel_check" CHECK ("channel" IN ('whatsapp', 'email', 'sms', 'other')),
	CONSTRAINT "reminders_status_check" CHECK ("status" IN ('pending', 'queued', 'sent', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"scope" varchar(16) DEFAULT 'tenant' NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_key" UNIQUE("code"),
	CONSTRAINT "roles_code_check" CHECK ("code" IN ('owner', 'admin', 'service_advisor', 'technician')),
	CONSTRAINT "roles_scope_check" CHECK ("scope" IN ('tenant'))
);
--> statement-breakpoint
CREATE TABLE "service_order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"quote_item_id" uuid,
	"catalog_item_id" uuid,
	"sales_originator_membership_id" uuid NOT NULL,
	"item_type" varchar(16) NOT NULL,
	"code_snapshot" varchar(80),
	"name_snapshot" varchar(200) NOT NULL,
	"description_snapshot" text,
	"unit" varchar(40),
	"quantity_authorized" numeric(14, 4) NOT NULL,
	"quantity_actual" numeric(14, 4),
	"quantity_billed" numeric(14, 4),
	"unit_price" bigint NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"tax_rate_snapshot" numeric(7, 4),
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"line_total" bigint DEFAULT 0 NOT NULL,
	"warranty_duration_value_snapshot" integer,
	"warranty_duration_unit_snapshot" varchar(8),
	"warranty_terms_snapshot" text,
	"warranty_origin" varchar(24) DEFAULT 'none' NOT NULL,
	"warranty_start_at" timestamp with time zone,
	"warranty_expires_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'authorized' NOT NULL,
	"source" varchar(24) NOT NULL,
	"adjustment_reason" text,
	"cancel_reason" text,
	"created_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "soi_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "soi_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "soi_catalog_scope_key" UNIQUE("tenant_id","id","catalog_item_id"),
	CONSTRAINT "soi_item_type_check" CHECK ("item_type" IN ('service', 'labor', 'part', 'other')),
	CONSTRAINT "soi_status_check" CHECK ("status" IN ('authorized', 'in_progress', 'completed', 'cancelled')),
	CONSTRAINT "soi_source_check" CHECK ("source" IN ('quote', 'manual_adjustment', 'warranty', 'other')),
	CONSTRAINT "soi_warranty_origin_check" CHECK ("warranty_origin" IN ('none', 'catalog_default', 'quote_override', 'order_override')),
	CONSTRAINT "soi_warranty_unit_check" CHECK ("warranty_duration_unit_snapshot" IN ('day', 'month', 'year')),
	CONSTRAINT "soi_quantity_authorized_check" CHECK ("quantity_authorized" > 0),
	CONSTRAINT "soi_quantity_actual_check" CHECK ("quantity_actual" >= 0),
	CONSTRAINT "soi_quantity_billed_check" CHECK ("quantity_billed" >= 0 AND "quantity_billed" <= "quantity_authorized"),
	CONSTRAINT "soi_amounts_check" CHECK ("unit_price" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0),
	CONSTRAINT "soi_tax_rate_check" CHECK ("tax_rate_snapshot" BETWEEN 0 AND 100),
	CONSTRAINT "soi_warranty_value_check" CHECK ("warranty_duration_value_snapshot" > 0),
	CONSTRAINT "soi_warranty_window_check" CHECK ("warranty_expires_at" IS NULL OR "warranty_start_at" IS NULL OR "warranty_expires_at" > "warranty_start_at"),
	CONSTRAINT "soi_source_quote_check" CHECK ("source" <> 'quote' OR "quote_item_id" IS NOT NULL),
	CONSTRAINT "soi_completed_check" CHECK ("status" <> 'completed'
       OR ("completed_at" IS NOT NULL AND "quantity_billed" IS NOT NULL)),
	CONSTRAINT "soi_cancelled_check" CHECK ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL),
	CONSTRAINT "soi_adjustment_reason_check" CHECK (("source" <> 'manual_adjustment' AND "warranty_origin" <> 'order_override')
       OR ("adjustment_reason" IS NOT NULL AND btrim("adjustment_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_number" bigint NOT NULL,
	"status" varchar(32) DEFAULT 'reception' NOT NULL,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promised_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by_membership_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_orders_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_orders_lineage_key" UNIQUE("tenant_id","id","vehicle_id","customer_id"),
	CONSTRAINT "service_orders_reception_key" UNIQUE("tenant_id","reception_id"),
	CONSTRAINT "service_orders_number_key" UNIQUE("tenant_id","order_number"),
	CONSTRAINT "service_orders_status_check" CHECK ("status" IN ('reception', 'diagnosis', 'quote_pending', 'approved', 'partially_approved', 'rejected', 'in_progress', 'quality_control', 'ready_for_delivery', 'delivered', 'cancelled')),
	CONSTRAINT "service_orders_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "service_orders_version_check" CHECK ("version" > 0),
	CONSTRAINT "service_orders_closed_at_check" CHECK (("status" IN ('delivered','cancelled')) = ("closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reception_id" uuid,
	"delivery_id" uuid,
	"signed_by_name" varchar(200) NOT NULL,
	"signed_by_document" varchar(60),
	"signature_media_id" uuid NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signatures_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "signatures_parent_xor_check" CHECK (("reception_id" IS NOT NULL AND "delivery_id" IS NULL)
       OR ("reception_id" IS NULL AND "delivery_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'wompi' NOT NULL,
	"provider_ref" varchar(255),
	"provider_payment_source_id" varchar(255),
	"status" varchar(16) NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscriptions_provider_check" CHECK ("provider" IN ('wompi', 'manual')),
	CONSTRAINT "subscriptions_status_check" CHECK ("status" IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled')),
	CONSTRAINT "subscriptions_period_check" CHECK ("current_period_end" > "current_period_start"),
	CONSTRAINT "subscriptions_cancelled_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sync_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"device_id" varchar(160),
	"membership_id" uuid NOT NULL,
	"operation_type" varchar(80) NOT NULL,
	"entity_type" varchar(80) NOT NULL,
	"entity_id" uuid,
	"base_version" integer,
	"status" varchar(24) NOT NULL,
	"result_json" jsonb,
	"client_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "sync_operations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "sync_operations_operation_key" UNIQUE("tenant_id","operation_id"),
	CONSTRAINT "sync_operations_status_check" CHECK ("status" IN ('queued', 'syncing', 'applied', 'conflict', 'retryable_error', 'permanent_error')),
	CONSTRAINT "sync_operations_base_version_check" CHECK ("base_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "technician_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"event_type" varchar(20) NOT NULL,
	"notes" text,
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tl_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "tl_event_type_check" CHECK ("event_type" IN ('started', 'paused', 'resumed', 'note', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tenant_whatsapp_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(32) DEFAULT 'meta_whatsapp' NOT NULL,
	"meta_business_id" varchar(160),
	"waba_id" varchar(160) NOT NULL,
	"phone_number_id" varchar(160) NOT NULL,
	"display_phone_number" varchar(32),
	"verified_name" varchar(200),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"connection_mode" varchar(32) DEFAULT 'embedded_signup' NOT NULL,
	"billing_mode" varchar(24) DEFAULT 'tenant_direct' NOT NULL,
	"credential_secret_ref" varchar(255),
	"connected_by_membership_id" uuid NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twa_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "twa_phone_number_id_key" UNIQUE("phone_number_id"),
	CONSTRAINT "twa_provider_check" CHECK ("provider" IN ('meta_whatsapp')),
	CONSTRAINT "twa_status_check" CHECK ("status" IN ('pending', 'active', 'disconnected', 'error')),
	CONSTRAINT "twa_connection_mode_check" CHECK ("connection_mode" IN ('embedded_signup')),
	CONSTRAINT "twa_billing_mode_check" CHECK ("billing_mode" IN ('tenant_direct'))
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "upload_sessions_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "upload_sessions_status_check" CHECK ("status" IN ('pending', 'completed', 'expired', 'failed')),
	CONSTRAINT "upload_sessions_completed_check" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identity_provider" varchar(32) DEFAULT 'clerk' NOT NULL,
	"external_subject" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"full_name" varchar(200),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_identity_key" UNIQUE("identity_provider","external_subject"),
	CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_damages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reception_id" uuid NOT NULL,
	"zone_code" varchar(64) NOT NULL,
	"damage_type" varchar(64) NOT NULL,
	"severity" varchar(16) DEFAULT 'minor' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_damages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vehicle_damages_severity_check" CHECK ("severity" IN ('minor', 'moderate', 'severe'))
);
--> statement-breakpoint
CREATE TABLE "vehicle_owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"relationship_type" varchar(24) DEFAULT 'owner' NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_owners_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vehicle_owners_relationship_check" CHECK ("relationship_type" IN ('owner', 'authorized_driver', 'company_contact', 'other')),
	CONSTRAINT "vehicle_owners_validity_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plate" varchar(16) NOT NULL,
	"vin" varchar(32),
	"vehicle_type" varchar(24) NOT NULL,
	"brand" varchar(80) NOT NULL,
	"model" varchar(100) NOT NULL,
	"model_year" smallint,
	"color" varchar(60),
	"engine_number" varchar(80),
	"current_mileage_km" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicles_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "vehicles_tenant_plate_key" UNIQUE("tenant_id","plate"),
	CONSTRAINT "vehicles_type_check" CHECK ("vehicle_type" IN ('car', 'motorcycle', 'other')),
	CONSTRAINT "vehicles_model_year_check" CHECK ("model_year" BETWEEN 1886 AND 2200),
	CONSTRAINT "vehicles_mileage_check" CHECK ("current_mileage_km" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"tenant_id" uuid,
	"payload_hash" char(64) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"headers_json" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_key" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_processing_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(24) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"last_error_code" varchar(120),
	"last_error_message" text,
	"worker_id" varchar(160),
	"request_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wpa_event_attempt_key" UNIQUE("webhook_event_id","attempt_number"),
	CONSTRAINT "wpa_status_check" CHECK ("status" IN ('processing', 'succeeded', 'retryable_error', 'permanent_error')),
	CONSTRAINT "wpa_attempt_number_check" CHECK ("attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"service_order_item_id" uuid,
	"title" varchar(200) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"assigned_membership_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "wa_order_scope_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "wa_status_check" CHECK ("status" IN ('pending', 'in_progress', 'paused', 'completed', 'cancelled')),
	CONSTRAINT "wa_cancelled_check" CHECK ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "work_activity_media" (
	"tenant_id" uuid NOT NULL,
	"work_activity_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"purpose" varchar(48) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_activity_media_pk" PRIMARY KEY("tenant_id","work_activity_id","media_asset_id","purpose"),
	CONSTRAINT "wam_sort_order_check" CHECK ("sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workshop_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"address_line" text NOT NULL,
	"city" varchar(120) NOT NULL,
	"department" varchar(120) NOT NULL,
	"country_code" char(2) DEFAULT 'CO' NOT NULL,
	"phone" varchar(32),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshop_locations_tenant_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "workshops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"tax_id" varchar(40),
	"phone" varchar(32),
	"email" varchar(320),
	"timezone" varchar(64) DEFAULT 'America/Bogota' NOT NULL,
	"currency" char(3) DEFAULT 'COP' NOT NULL,
	"status" varchar(16) DEFAULT 'trialing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workshops_slug_key" UNIQUE("slug"),
	CONSTRAINT "workshops_status_check" CHECK ("status" IN ('trialing', 'active', 'suspended', 'cancelled')),
	CONSTRAINT "workshops_currency_check" CHECK ("currency" = upper("currency") AND char_length("currency") = 3)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_vehicle_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."workshop_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigned_by_fk" FOREIGN KEY ("tenant_id","assigned_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_membership_fk" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_access_tokens" ADD CONSTRAINT "customer_order_access_tokens_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_access_tokens" ADD CONSTRAINT "coat_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_access_tokens" ADD CONSTRAINT "coat_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_order_access_tokens" ADD CONSTRAINT "coat_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "customer_payment_allocations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "cpa_payment_fk" FOREIGN KEY ("tenant_id","customer_payment_id") REFERENCES "public"."customer_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "cpa_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_reconciliation_runs" ADD CONSTRAINT "customer_payment_reconciliation_runs_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_reconciliation_runs" ADD CONSTRAINT "cprr_initiated_by_fk" FOREIGN KEY ("tenant_id","initiated_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversed_by_fk" FOREIGN KEY ("tenant_id","reversed_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_correction_fk" FOREIGN KEY ("tenant_id","correction_of_payment_id") REFERENCES "public"."customer_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_media" ADD CONSTRAINT "damage_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_media" ADD CONSTRAINT "damage_media_damage_fk" FOREIGN KEY ("tenant_id","damage_id") REFERENCES "public"."vehicle_damages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "damage_media" ADD CONSTRAINT "damage_media_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "dsr_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_delivered_by_fk" FOREIGN KEY ("tenant_id","delivered_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_media" ADD CONSTRAINT "delivery_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_media" ADD CONSTRAINT "delivery_media_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_media" ADD CONSTRAINT "delivery_media_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostics" ADD CONSTRAINT "diagnostics_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostics" ADD CONSTRAINT "diagnostics_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostics" ADD CONSTRAINT "diagnostics_diagnosed_by_fk" FOREIGN KEY ("tenant_id","diagnosed_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_media" ADD CONSTRAINT "finding_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_media" ADD CONSTRAINT "finding_media_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_media" ADD CONSTRAINT "finding_media_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_diagnostic_fk" FOREIGN KEY ("tenant_id","diagnostic_id","order_id") REFERENCES "public"."diagnostics"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "ib_catalog_item_fk" FOREIGN KEY ("tenant_id","catalog_item_id") REFERENCES "public"."catalog_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "ib_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."workshop_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "im_catalog_item_fk" FOREIGN KEY ("tenant_id","catalog_item_id") REFERENCES "public"."catalog_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "im_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."workshop_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "im_service_order_item_fk" FOREIGN KEY ("tenant_id","service_order_item_id","catalog_item_id") REFERENCES "public"."service_order_items"("tenant_id","id","catalog_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "im_performed_by_fk" FOREIGN KEY ("tenant_id","performed_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_target_role_id_roles_id_fk" FOREIGN KEY ("target_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_invited_by_fk" FOREIGN KEY ("tenant_id","invited_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_accepted_membership_fk" FOREIGN KEY ("tenant_id","accepted_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_invitations" ADD CONSTRAINT "mi_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_assigned_by_fk" FOREIGN KEY ("tenant_id","assigned_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."message_threads"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_whatsapp_account_fk" FOREIGN KEY ("tenant_id","whatsapp_account_id") REFERENCES "public"."tenant_whatsapp_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "osh_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "osh_changed_by_fk" FOREIGN KEY ("tenant_id","changed_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "public"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_evidence_media_fk" FOREIGN KEY ("tenant_id","evidence_media_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_consents" ADD CONSTRAINT "privacy_consents_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_security_incidents" ADD CONSTRAINT "privacy_security_incidents_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_media" ADD CONSTRAINT "quality_check_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_media" ADD CONSTRAINT "qcm_quality_check_fk" FOREIGN KEY ("tenant_id","quality_check_id") REFERENCES "public"."quality_checks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_media" ADD CONSTRAINT "qcm_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "qc_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "qc_checked_by_fk" FOREIGN KEY ("tenant_id","checked_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_challenges" ADD CONSTRAINT "quote_authorization_challenges_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_challenges" ADD CONSTRAINT "qac_token_fk" FOREIGN KEY ("tenant_id","authorization_token_id") REFERENCES "public"."quote_authorization_tokens"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_challenges" ADD CONSTRAINT "qac_delivery_message_fk" FOREIGN KEY ("tenant_id","delivery_message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_items" ADD CONSTRAINT "quote_authorization_items_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_items" ADD CONSTRAINT "qai_authorization_fk" FOREIGN KEY ("tenant_id","authorization_id","quote_version_id") REFERENCES "public"."quote_authorizations"("tenant_id","id","quote_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_items" ADD CONSTRAINT "qai_quote_item_fk" FOREIGN KEY ("tenant_id","quote_item_id","quote_version_id") REFERENCES "public"."quote_items"("tenant_id","id","quote_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "quote_authorization_tokens_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "qat_version_fk" FOREIGN KEY ("tenant_id","quote_version_id") REFERENCES "public"."quote_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "qat_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "qat_revoked_by_fk" FOREIGN KEY ("tenant_id","revoked_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "qat_issued_for_message_fk" FOREIGN KEY ("tenant_id","issued_for_message_id") REFERENCES "public"."messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorization_tokens" ADD CONSTRAINT "qat_superseded_by_fk" FOREIGN KEY ("tenant_id","superseded_by_token_id","quote_version_id") REFERENCES "public"."quote_authorization_tokens"("tenant_id","id","quote_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorizations" ADD CONSTRAINT "quote_authorizations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorizations" ADD CONSTRAINT "qa_version_fk" FOREIGN KEY ("tenant_id","quote_version_id") REFERENCES "public"."quote_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorizations" ADD CONSTRAINT "qa_token_fk" FOREIGN KEY ("tenant_id","authorization_token_id","quote_version_id") REFERENCES "public"."quote_authorization_tokens"("tenant_id","id","quote_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorizations" ADD CONSTRAINT "qa_challenge_fk" FOREIGN KEY ("tenant_id","authorization_challenge_id","authorization_token_id") REFERENCES "public"."quote_authorization_challenges"("tenant_id","id","authorization_token_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_authorizations" ADD CONSTRAINT "qa_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "qi_version_fk" FOREIGN KEY ("tenant_id","quote_version_id","order_id") REFERENCES "public"."quote_versions"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "qi_finding_fk" FOREIGN KEY ("tenant_id","finding_id","order_id") REFERENCES "public"."findings"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "qi_catalog_item_fk" FOREIGN KEY ("tenant_id","catalog_item_id") REFERENCES "public"."catalog_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "qi_sales_originator_fk" FOREIGN KEY ("tenant_id","sales_originator_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_media" ADD CONSTRAINT "quote_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_media" ADD CONSTRAINT "quote_media_version_fk" FOREIGN KEY ("tenant_id","quote_version_id") REFERENCES "public"."quote_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_media" ADD CONSTRAINT "quote_media_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "qv_quote_fk" FOREIGN KEY ("tenant_id","quote_id","order_id") REFERENCES "public"."quotes"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "qv_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_cancelled_by_fk" FOREIGN KEY ("tenant_id","cancelled_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_current_version_fk" FOREIGN KEY ("tenant_id","current_version_id","id","order_id") REFERENCES "public"."quote_versions"("tenant_id","id","quote_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_check_items" ADD CONSTRAINT "reception_check_items_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_check_items" ADD CONSTRAINT "rci_reception_fk" FOREIGN KEY ("tenant_id","reception_id") REFERENCES "public"."receptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_media" ADD CONSTRAINT "reception_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_media" ADD CONSTRAINT "reception_media_reception_fk" FOREIGN KEY ("tenant_id","reception_id") REFERENCES "public"."receptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reception_media" ADD CONSTRAINT "reception_media_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_vehicle_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."workshop_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_received_by_fk" FOREIGN KEY ("tenant_id","received_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_finding_fk" FOREIGN KEY ("tenant_id","finding_id") REFERENCES "public"."findings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "service_order_items_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "soi_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "soi_quote_item_fk" FOREIGN KEY ("tenant_id","quote_item_id","order_id") REFERENCES "public"."quote_items"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "soi_catalog_item_fk" FOREIGN KEY ("tenant_id","catalog_item_id") REFERENCES "public"."catalog_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "soi_sales_originator_fk" FOREIGN KEY ("tenant_id","sales_originator_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_items" ADD CONSTRAINT "soi_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_reception_lineage_fk" FOREIGN KEY ("tenant_id","reception_id","vehicle_id","customer_id") REFERENCES "public"."receptions"("tenant_id","id","vehicle_id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_vehicle_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_reception_fk" FOREIGN KEY ("tenant_id","reception_id") REFERENCES "public"."receptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_media_fk" FOREIGN KEY ("tenant_id","signature_media_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_logs" ADD CONSTRAINT "technician_logs_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_logs" ADD CONSTRAINT "tl_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."work_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_logs" ADD CONSTRAINT "tl_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_whatsapp_accounts" ADD CONSTRAINT "tenant_whatsapp_accounts_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_whatsapp_accounts" ADD CONSTRAINT "twa_connected_by_fk" FOREIGN KEY ("tenant_id","connected_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_damages" ADD CONSTRAINT "vehicle_damages_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_damages" ADD CONSTRAINT "vehicle_damages_reception_fk" FOREIGN KEY ("tenant_id","reception_id") REFERENCES "public"."receptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_owners" ADD CONSTRAINT "vehicle_owners_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_owners" ADD CONSTRAINT "vehicle_owners_vehicle_fk" FOREIGN KEY ("tenant_id","vehicle_id") REFERENCES "public"."vehicles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_owners" ADD CONSTRAINT "vehicle_owners_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_processing_attempts" ADD CONSTRAINT "webhook_processing_attempts_webhook_event_id_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activities" ADD CONSTRAINT "work_activities_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activities" ADD CONSTRAINT "wa_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."service_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activities" ADD CONSTRAINT "wa_service_order_item_fk" FOREIGN KEY ("tenant_id","service_order_item_id","order_id") REFERENCES "public"."service_order_items"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activities" ADD CONSTRAINT "wa_assigned_membership_fk" FOREIGN KEY ("tenant_id","assigned_membership_id") REFERENCES "public"."memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activity_media" ADD CONSTRAINT "work_activity_media_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activity_media" ADD CONSTRAINT "wam_activity_fk" FOREIGN KEY ("tenant_id","work_activity_id") REFERENCES "public"."work_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activity_media" ADD CONSTRAINT "wam_media_fk" FOREIGN KEY ("tenant_id","media_asset_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workshop_locations" ADD CONSTRAINT "workshop_locations_tenant_id_workshops_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_created_by_idx" ON "appointments" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "appointments_tenant_start_idx" ON "appointments" USING btree ("tenant_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "appointments_vehicle_idx" ON "appointments" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "appointments_location_idx" ON "appointments" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "assignments_assigned_by_idx" ON "assignments" USING btree ("tenant_id","assigned_by_membership_id");--> statement-breakpoint
CREATE INDEX "assignments_lookup_idx" ON "assignments" USING btree ("tenant_id","order_id","membership_id","assignment_type");--> statement-breakpoint
CREATE INDEX "assignments_membership_idx" ON "assignments" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_active_uq" ON "assignments" USING btree ("tenant_id","order_id","membership_id","assignment_type") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_membership_idx" ON "audit_logs" USING btree ("tenant_id","actor_membership_id");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_request_idx" ON "audit_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "audit_logs_trace_idx" ON "audit_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "billing_events_subscription_idx" ON "billing_events" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE INDEX "catalog_items_tenant_active_idx" ON "catalog_items" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_code_uq" ON "catalog_items" USING btree ("tenant_id","code") WHERE code IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_barcode_uq" ON "catalog_items" USING btree ("tenant_id","barcode") WHERE barcode IS NOT NULL;--> statement-breakpoint
CREATE INDEX "coat_created_by_idx" ON "customer_order_access_tokens" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "coat_revoked_by_idx" ON "customer_order_access_tokens" USING btree ("tenant_id","revoked_by_membership_id");--> statement-breakpoint
CREATE INDEX "coat_order_idx" ON "customer_order_access_tokens" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "coat_expiry_idx" ON "customer_order_access_tokens" USING btree ("expires_at","status");--> statement-breakpoint
CREATE INDEX "cpa_payment_idx" ON "customer_payment_allocations" USING btree ("tenant_id","customer_payment_id");--> statement-breakpoint
CREATE INDEX "cpa_order_idx" ON "customer_payment_allocations" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "cprr_initiated_by_idx" ON "customer_payment_reconciliation_runs" USING btree ("tenant_id","initiated_by_membership_id");--> statement-breakpoint
CREATE INDEX "cprr_period_idx" ON "customer_payment_reconciliation_runs" USING btree ("tenant_id","period_end" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_payments_confirmed_by_idx" ON "customer_payments" USING btree ("tenant_id","confirmed_by_membership_id");--> statement-breakpoint
CREATE INDEX "customer_payments_reversed_by_idx" ON "customer_payments" USING btree ("tenant_id","reversed_by_membership_id");--> statement-breakpoint
CREATE INDEX "customer_payments_recorded_by_idx" ON "customer_payments" USING btree ("tenant_id","recorded_by_membership_id");--> statement-breakpoint
CREATE INDEX "customer_payments_correction_idx" ON "customer_payments" USING btree ("tenant_id","correction_of_payment_id");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "customer_payments" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_receipt_uq" ON "customer_payments" USING btree ("tenant_id","receipt_number") WHERE receipt_number IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_idempotency_uq" ON "customer_payments" USING btree ("tenant_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_tenant_phone_idx" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "customers_tenant_document_idx" ON "customers" USING btree ("tenant_id","document_number");--> statement-breakpoint
CREATE INDEX "damage_media_media_idx" ON "damage_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "damage_media_sort_idx" ON "damage_media" USING btree ("tenant_id","damage_id","sort_order");--> statement-breakpoint
CREATE INDEX "dsr_scope_status_idx" ON "data_subject_requests" USING btree ("controller_scope","status");--> statement-breakpoint
CREATE INDEX "dsr_tenant_idx" ON "data_subject_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "dsr_customer_idx" ON "data_subject_requests" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "deliveries_delivered_by_idx" ON "deliveries" USING btree ("tenant_id","delivered_by_membership_id");--> statement-breakpoint
CREATE INDEX "delivery_media_media_idx" ON "delivery_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "delivery_media_sort_idx" ON "delivery_media" USING btree ("tenant_id","delivery_id","sort_order");--> statement-breakpoint
CREATE INDEX "diagnostics_diagnosed_by_idx" ON "diagnostics" USING btree ("tenant_id","diagnosed_by_membership_id");--> statement-breakpoint
CREATE INDEX "diagnostics_order_idx" ON "diagnostics" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "diagnostics_one_active_uq" ON "diagnostics" USING btree ("tenant_id","order_id") WHERE status IN ('draft','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_global_uq" ON "feature_flags" USING btree ("feature_key") WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_plan_uq" ON "feature_flags" USING btree ("plan_id","feature_key") WHERE scope = 'plan';--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_tenant_uq" ON "feature_flags" USING btree ("tenant_id","feature_key") WHERE scope = 'tenant';--> statement-breakpoint
CREATE INDEX "finding_media_media_idx" ON "finding_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "finding_media_sort_idx" ON "finding_media" USING btree ("tenant_id","finding_id","sort_order");--> statement-breakpoint
CREATE INDEX "findings_diagnostic_idx" ON "findings" USING btree ("tenant_id","diagnostic_id");--> statement-breakpoint
CREATE INDEX "findings_order_idx" ON "findings" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "ib_location_quantity_idx" ON "inventory_balances" USING btree ("tenant_id","location_id","quantity_on_hand");--> statement-breakpoint
CREATE INDEX "im_performed_by_idx" ON "inventory_movements" USING btree ("tenant_id","performed_by_membership_id");--> statement-breakpoint
CREATE INDEX "im_item_occurred_idx" ON "inventory_movements" USING btree ("tenant_id","catalog_item_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "im_location_occurred_idx" ON "inventory_movements" USING btree ("tenant_id","location_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "im_service_order_item_idx" ON "inventory_movements" USING btree ("tenant_id","service_order_item_id");--> statement-breakpoint
CREATE INDEX "im_transfer_group_idx" ON "inventory_movements" USING btree ("tenant_id","transfer_group_id");--> statement-breakpoint
CREATE INDEX "legal_acceptances_user_idx" ON "legal_acceptances" USING btree ("accepted_by_user_id","document_type");--> statement-breakpoint
CREATE INDEX "legal_acceptances_tenant_idx" ON "legal_acceptances" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_tenant_uq" ON "legal_acceptances" USING btree ("tenant_id","accepted_by_user_id","document_type","document_version") WHERE tenant_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_global_uq" ON "legal_acceptances" USING btree ("accepted_by_user_id","document_type","document_version") WHERE tenant_id IS NULL;--> statement-breakpoint
CREATE INDEX "media_assets_created_by_idx" ON "media_assets" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "media_assets_tenant_created_idx" ON "media_assets" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mi_accepted_membership_idx" ON "membership_invitations" USING btree ("tenant_id","accepted_membership_id");--> statement-breakpoint
CREATE INDEX "mi_revoked_by_idx" ON "membership_invitations" USING btree ("tenant_id","revoked_by_membership_id");--> statement-breakpoint
CREATE INDEX "mi_tenant_status_expires_idx" ON "membership_invitations" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "mi_tenant_email_idx" ON "membership_invitations" USING btree ("tenant_id","email_normalized");--> statement-breakpoint
CREATE INDEX "mi_invited_by_idx" ON "membership_invitations" USING btree ("tenant_id","invited_by_membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mi_one_pending_per_email_uq" ON "membership_invitations" USING btree ("tenant_id","email_normalized") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "membership_roles_assigned_by_idx" ON "membership_roles" USING btree ("tenant_id","assigned_by_membership_id");--> statement-breakpoint
CREATE INDEX "message_threads_customer_idx" ON "message_threads" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "message_threads_order_idx" ON "message_threads" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_threads_external_ref_uq" ON "message_threads" USING btree ("tenant_id","channel","external_thread_ref") WHERE external_thread_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("tenant_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_account_created_idx" ON "messages" USING btree ("tenant_id","whatsapp_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_uq" ON "messages" USING btree ("provider","provider_message_id") WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "osh_changed_by_idx" ON "order_status_history" USING btree ("tenant_id","changed_by_membership_id");--> statement-breakpoint
CREATE INDEX "osh_order_changed_idx" ON "order_status_history" USING btree ("tenant_id","order_id","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outbox_events_worker_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_events_tenant_idx" ON "outbox_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_idempotency_uq" ON "outbox_events" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_subscription_idx" ON "payments" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_tx_uq" ON "payments" USING btree ("provider","environment","provider_transaction_id") WHERE provider_transaction_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "privacy_consents_created_by_idx" ON "privacy_consents" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "privacy_consents_lookup_idx" ON "privacy_consents" USING btree ("tenant_id","customer_id","purpose_code","status");--> statement-breakpoint
CREATE INDEX "privacy_consents_evidence_media_idx" ON "privacy_consents" USING btree ("tenant_id","evidence_media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_consents_one_granted_uq" ON "privacy_consents" USING btree ("tenant_id","customer_id","purpose_code") WHERE status = 'granted';--> statement-breakpoint
CREATE INDEX "psi_scope_status_idx" ON "privacy_security_incidents" USING btree ("controller_scope","status");--> statement-breakpoint
CREATE INDEX "psi_tenant_idx" ON "privacy_security_incidents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "qcm_media_idx" ON "quality_check_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "qcm_sort_idx" ON "quality_check_media" USING btree ("tenant_id","quality_check_id","sort_order");--> statement-breakpoint
CREATE INDEX "qc_order_idx" ON "quality_checks" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "qc_checked_by_idx" ON "quality_checks" USING btree ("tenant_id","checked_by_membership_id");--> statement-breakpoint
CREATE INDEX "qac_token_status_idx" ON "quote_authorization_challenges" USING btree ("tenant_id","authorization_token_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "qac_delivery_message_idx" ON "quote_authorization_challenges" USING btree ("tenant_id","delivery_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qac_one_usable_uq" ON "quote_authorization_challenges" USING btree ("tenant_id","authorization_token_id") WHERE status IN ('requested','active','verified');--> statement-breakpoint
CREATE INDEX "qai_quote_item_idx" ON "quote_authorization_items" USING btree ("tenant_id","quote_item_id");--> statement-breakpoint
CREATE INDEX "qai_authorization_idx" ON "quote_authorization_items" USING btree ("tenant_id","authorization_id");--> statement-breakpoint
CREATE INDEX "qat_revoked_by_idx" ON "quote_authorization_tokens" USING btree ("tenant_id","revoked_by_membership_id");--> statement-breakpoint
CREATE INDEX "qat_superseded_by_idx" ON "quote_authorization_tokens" USING btree ("tenant_id","superseded_by_token_id");--> statement-breakpoint
CREATE INDEX "qat_version_status_idx" ON "quote_authorization_tokens" USING btree ("tenant_id","quote_version_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "qat_issued_for_message_idx" ON "quote_authorization_tokens" USING btree ("tenant_id","issued_for_message_id");--> statement-breakpoint
CREATE INDEX "qat_created_by_idx" ON "quote_authorization_tokens" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "qa_challenge_idx" ON "quote_authorizations" USING btree ("tenant_id","authorization_challenge_id");--> statement-breakpoint
CREATE INDEX "qa_recorded_by_idx" ON "quote_authorizations" USING btree ("tenant_id","recorded_by_membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_one_per_token_uq" ON "quote_authorizations" USING btree ("tenant_id","authorization_token_id") WHERE authorization_token_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "qi_version_idx" ON "quote_items" USING btree ("tenant_id","quote_version_id");--> statement-breakpoint
CREATE INDEX "qi_catalog_item_idx" ON "quote_items" USING btree ("tenant_id","catalog_item_id");--> statement-breakpoint
CREATE INDEX "qi_finding_idx" ON "quote_items" USING btree ("tenant_id","finding_id");--> statement-breakpoint
CREATE INDEX "qi_sales_originator_idx" ON "quote_items" USING btree ("tenant_id","sales_originator_membership_id");--> statement-breakpoint
CREATE INDEX "quote_media_media_idx" ON "quote_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "quote_media_sort_idx" ON "quote_media" USING btree ("tenant_id","quote_version_id","sort_order");--> statement-breakpoint
CREATE INDEX "qv_created_by_idx" ON "quote_versions" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "qv_quote_idx" ON "quote_versions" USING btree ("tenant_id","quote_id");--> statement-breakpoint
CREATE INDEX "quotes_created_by_idx" ON "quotes" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "quotes_cancelled_by_idx" ON "quotes" USING btree ("tenant_id","cancelled_by_membership_id");--> statement-breakpoint
CREATE INDEX "quotes_order_idx" ON "quotes" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "quotes_current_version_idx" ON "quotes" USING btree ("tenant_id","current_version_id");--> statement-breakpoint
CREATE INDEX "reception_media_media_idx" ON "reception_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "reception_media_sort_idx" ON "reception_media" USING btree ("tenant_id","reception_id","sort_order");--> statement-breakpoint
CREATE INDEX "receptions_vehicle_received_idx" ON "receptions" USING btree ("tenant_id","vehicle_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "receptions_customer_idx" ON "receptions" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "receptions_appointment_idx" ON "receptions" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "receptions_location_idx" ON "receptions" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "receptions_received_by_idx" ON "receptions" USING btree ("tenant_id","received_by_membership_id");--> statement-breakpoint
CREATE INDEX "recommendations_finding_idx" ON "recommendations" USING btree ("tenant_id","finding_id");--> statement-breakpoint
CREATE INDEX "reminders_appointment_idx" ON "reminders" USING btree ("tenant_id","appointment_id");--> statement-breakpoint
CREATE INDEX "reminders_customer_idx" ON "reminders" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "soi_created_by_idx" ON "service_order_items" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "soi_order_idx" ON "service_order_items" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "soi_catalog_item_idx" ON "service_order_items" USING btree ("tenant_id","catalog_item_id");--> statement-breakpoint
CREATE INDEX "soi_quote_item_idx" ON "service_order_items" USING btree ("tenant_id","quote_item_id");--> statement-breakpoint
CREATE INDEX "soi_sales_attribution_idx" ON "service_order_items" USING btree ("tenant_id","sales_originator_membership_id","completed_at");--> statement-breakpoint
CREATE INDEX "service_orders_status_opened_idx" ON "service_orders" USING btree ("tenant_id","status","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_orders_vehicle_idx" ON "service_orders" USING btree ("tenant_id","vehicle_id");--> statement-breakpoint
CREATE INDEX "service_orders_customer_idx" ON "service_orders" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "service_orders_created_by_idx" ON "service_orders" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "signatures_reception_idx" ON "signatures" USING btree ("tenant_id","reception_id");--> statement-breakpoint
CREATE INDEX "signatures_delivery_idx" ON "signatures" USING btree ("tenant_id","delivery_id");--> statement-breakpoint
CREATE INDEX "signatures_media_idx" ON "signatures" USING btree ("tenant_id","signature_media_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_status_idx" ON "subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_ref_uq" ON "subscriptions" USING btree ("provider","provider_ref") WHERE provider_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_active_uq" ON "subscriptions" USING btree ("tenant_id") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "sync_operations_membership_idx" ON "sync_operations" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "tl_activity_idx" ON "technician_logs" USING btree ("tenant_id","activity_id");--> statement-breakpoint
CREATE INDEX "tl_membership_idx" ON "technician_logs" USING btree ("tenant_id","membership_id");--> statement-breakpoint
CREATE INDEX "twa_connected_by_idx" ON "tenant_whatsapp_accounts" USING btree ("tenant_id","connected_by_membership_id");--> statement-breakpoint
CREATE INDEX "twa_tenant_status_idx" ON "tenant_whatsapp_accounts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "twa_one_active_uq" ON "tenant_whatsapp_accounts" USING btree ("tenant_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "upload_sessions_created_by_idx" ON "upload_sessions" USING btree ("tenant_id","created_by_membership_id");--> statement-breakpoint
CREATE INDEX "upload_sessions_media_idx" ON "upload_sessions" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "vehicle_damages_reception_idx" ON "vehicle_damages" USING btree ("tenant_id","reception_id");--> statement-breakpoint
CREATE INDEX "vehicle_owners_vehicle_idx" ON "vehicle_owners" USING btree ("tenant_id","vehicle_id","valid_to");--> statement-breakpoint
CREATE INDEX "vehicle_owners_customer_idx" ON "vehicle_owners" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_owners_one_primary_uq" ON "vehicle_owners" USING btree ("tenant_id","vehicle_id") WHERE is_primary = true AND valid_to IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_tenant_idx" ON "webhook_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "wpa_event_idx" ON "webhook_processing_attempts" USING btree ("webhook_event_id");--> statement-breakpoint
CREATE INDEX "wa_order_idx" ON "work_activities" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "wa_service_order_item_idx" ON "work_activities" USING btree ("tenant_id","service_order_item_id");--> statement-breakpoint
CREATE INDEX "wa_assigned_idx" ON "work_activities" USING btree ("tenant_id","assigned_membership_id");--> statement-breakpoint
CREATE INDEX "wam_media_idx" ON "work_activity_media" USING btree ("tenant_id","media_asset_id");--> statement-breakpoint
CREATE INDEX "wam_sort_idx" ON "work_activity_media" USING btree ("tenant_id","work_activity_id","sort_order");--> statement-breakpoint
CREATE INDEX "workshop_locations_tenant_idx" ON "workshop_locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workshop_locations_one_primary_uq" ON "workshop_locations" USING btree ("tenant_id") WHERE is_primary = true;
--> statement-breakpoint

-- No runtime role inherits table access. Grants below are command- and
-- table-specific; mixed-scope/platform tables stay inaccessible directly.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, tallermecario_api, tallermecario_worker, tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
	SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_tenant_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint

-- Explicit ADR-009 allowlist. None of the mixed-scope tables appears here.
DO $tenant_rls$
DECLARE
	table_name name;
	mutable_tenant_tables constant name[] := ARRAY[
		'workshop_locations',
		'memberships',
		'membership_invitations',
		'membership_roles',
		'customers',
		'vehicles',
		'vehicle_owners',
		'appointments',
		'reminders',
		'receptions',
		'reception_check_items',
		'vehicle_damages',
		'signatures',
		'service_orders',
		'service_order_items',
		'assignments',
		'diagnostics',
		'findings',
		'recommendations',
		'catalog_items',
		'inventory_balances',
		'quotes',
		'quote_versions',
		'quote_items',
		'quote_authorization_tokens',
		'quote_authorization_challenges',
		'work_activities',
		'technician_logs',
		'quality_checks',
		'deliveries',
		'media_assets',
		'upload_sessions',
		'reception_media',
		'damage_media',
		'finding_media',
		'work_activity_media',
		'quality_check_media',
		'delivery_media',
		'quote_media',
		'tenant_whatsapp_accounts',
		'message_threads',
		'messages',
		'customer_order_access_tokens',
		'subscriptions',
		'payments',
		'customer_payments',
		'customer_payment_allocations',
		'customer_payment_reconciliation_runs',
		'sync_operations',
		'privacy_consents'
	]::name[];
	append_only_tenant_tables constant name[] := ARRAY[
		'order_status_history',
		'inventory_movements',
		'quote_authorizations',
		'quote_authorization_items',
		'billing_events',
		'audit_logs'
	]::name[];
BEGIN
	FOREACH table_name IN ARRAY mutable_tenant_tables || append_only_tenant_tables LOOP
		EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
		EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
		EXECUTE pg_catalog.format(
			'CREATE POLICY tenant_select ON public.%I FOR SELECT TO tallermecario_api, tallermecario_worker USING (tenant_id = app.current_tenant_id())',
			table_name
		);
		EXECUTE pg_catalog.format(
			'CREATE POLICY tenant_insert ON public.%I FOR INSERT TO tallermecario_api, tallermecario_worker WITH CHECK (tenant_id = app.current_tenant_id())',
			table_name
		);
	END LOOP;

	FOREACH table_name IN ARRAY mutable_tenant_tables LOOP
		EXECUTE pg_catalog.format(
			'CREATE POLICY tenant_update ON public.%I FOR UPDATE TO tallermecario_api, tallermecario_worker USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
			table_name
		);
		EXECUTE pg_catalog.format(
			'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO tallermecario_api, tallermecario_worker',
			table_name
		);
	END LOOP;

	FOREACH table_name IN ARRAY append_only_tenant_tables LOOP
		EXECUTE pg_catalog.format(
			'GRANT SELECT, INSERT ON TABLE public.%I TO tallermecario_api, tallermecario_worker',
			table_name
		);
	END LOOP;
END
$tenant_rls$;
--> statement-breakpoint

ALTER TABLE public.workshops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.workshops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_select ON public.workshops
	FOR SELECT TO tallermecario_api, tallermecario_worker
	USING (id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON public.workshops
	FOR INSERT TO tallermecario_api, tallermecario_worker
	WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_update ON public.workshops
	FOR UPDATE TO tallermecario_api, tallermecario_worker
	USING (id = app.current_tenant_id())
	WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.workshops TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint

-- Global catalogs are read-only to runtime. Users and every mixed-scope table
-- intentionally receive no direct runtime grant.
GRANT SELECT ON TABLE public.roles, public.permissions, public.role_permissions, public.plans
	TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint

-- Least-privilege data access used by the SECURITY DEFINER bootstrap functions.
GRANT SELECT ON TABLE
	public.users,
	public.memberships,
	public.quote_authorization_tokens,
	public.customer_order_access_tokens,
	public.tenant_whatsapp_accounts,
	public.payments
	TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT SELECT (id, tenant_id, status, available_at, attempts),
	UPDATE (status, attempts, updated_at)
	ON TABLE public.outbox_events TO tallermecario_bootstrap_resolver;
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_bootstrap_resolver;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_bootstrap_resolver;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_list_active_memberships(
	p_identity_provider text,
	p_external_subject text
)
RETURNS TABLE (
	user_id uuid,
	membership_id uuid,
	tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT u.id, m.id, m.tenant_id
	FROM public.users AS u
	JOIN public.memberships AS m ON m.user_id = u.id
	WHERE u.identity_provider = p_identity_provider
		AND u.external_subject = p_external_subject
		AND u.status = 'active'
		AND m.status = 'active'
	ORDER BY m.tenant_id, m.id
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_validate_active_membership(
	p_identity_provider text,
	p_external_subject text,
	p_tenant_id uuid
)
RETURNS TABLE (
	user_id uuid,
	membership_id uuid,
	tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT u.id, m.id, m.tenant_id
	FROM public.users AS u
	JOIN public.memberships AS m ON m.user_id = u.id
	WHERE u.identity_provider = p_identity_provider
		AND u.external_subject = p_external_subject
		AND u.status = 'active'
		AND m.status = 'active'
		AND m.tenant_id = p_tenant_id
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_resolve_quote_token(p_token_hash text)
RETURNS TABLE (
	token_id uuid,
	tenant_id uuid,
	quote_version_id uuid,
	token_status varchar(16),
	expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT t.id, t.tenant_id, t.quote_version_id, t.status, t.expires_at
	FROM public.quote_authorization_tokens AS t
	WHERE t.token_hash = p_token_hash
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_resolve_order_access_token(p_token_hash text)
RETURNS TABLE (
	token_id uuid,
	tenant_id uuid,
	order_id uuid,
	access_scope varchar(24),
	token_status varchar(16),
	expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT t.id, t.tenant_id, t.order_id, t.access_scope, t.status, t.expires_at
	FROM public.customer_order_access_tokens AS t
	WHERE t.token_hash = p_token_hash
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_resolve_whatsapp_account(p_phone_number_id text)
RETURNS TABLE (
	tenant_id uuid,
	whatsapp_account_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT a.tenant_id, a.id
	FROM public.tenant_whatsapp_accounts AS a
	WHERE a.phone_number_id = p_phone_number_id
		AND a.status = 'active'
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_resolve_wompi_payment_by_reference(
	p_environment text,
	p_reference text
)
RETURNS TABLE (
	tenant_id uuid,
	payment_id uuid,
	subscription_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT p.tenant_id, p.id, p.subscription_id
	FROM public.payments AS p
	WHERE p.provider = 'wompi'
		AND p.environment = p_environment
		AND p.reference = p_reference
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_resolve_wompi_payment_by_transaction(
	p_environment text,
	p_provider_transaction_id text
)
RETURNS TABLE (
	tenant_id uuid,
	payment_id uuid,
	subscription_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	SELECT p.tenant_id, p.id, p.subscription_id
	FROM public.payments AS p
	WHERE p.provider = 'wompi'
		AND p.environment = p_environment
		AND p.provider_transaction_id = p_provider_transaction_id
$function$;
--> statement-breakpoint

CREATE FUNCTION app.bootstrap_claim_outbox_events(p_batch_size integer)
RETURNS TABLE (
	outbox_event_id uuid,
	tenant_id uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
	WITH claimable AS (
		SELECT o.id
		FROM public.outbox_events AS o
		WHERE o.status = 'pending'
			AND o.available_at <= pg_catalog.clock_timestamp()
		ORDER BY o.available_at, o.id
		FOR UPDATE SKIP LOCKED
		LIMIT CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 0 END
	), claimed AS (
		UPDATE public.outbox_events AS o
		SET status = 'processing',
			attempts = o.attempts + 1,
			updated_at = pg_catalog.clock_timestamp()
		FROM claimable AS c
		WHERE o.id = c.id
		RETURNING o.id, o.tenant_id
	)
	SELECT c.id, c.tenant_id
	FROM claimed AS c
$function$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
	app.bootstrap_list_active_memberships(text, text),
	app.bootstrap_validate_active_membership(text, text, uuid),
	app.bootstrap_resolve_quote_token(text),
	app.bootstrap_resolve_order_access_token(text),
	app.bootstrap_resolve_whatsapp_account(text),
	app.bootstrap_resolve_wompi_payment_by_reference(text, text),
	app.bootstrap_resolve_wompi_payment_by_transaction(text, text),
	app.bootstrap_claim_outbox_events(integer)
	FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.bootstrap_list_active_memberships(text, text),
	app.bootstrap_validate_active_membership(text, text, uuid),
	app.bootstrap_resolve_quote_token(text),
	app.bootstrap_resolve_order_access_token(text)
	TO tallermecario_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	app.bootstrap_resolve_whatsapp_account(text),
	app.bootstrap_resolve_wompi_payment_by_reference(text, text),
	app.bootstrap_resolve_wompi_payment_by_transaction(text, text)
	TO tallermecario_api, tallermecario_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bootstrap_claim_outbox_events(integer)
	TO tallermecario_worker;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_bootstrap_resolver;
--> statement-breakpoint

-- New objects are private by default. Later migrations must SET ROLE to the
-- schema owner and add explicit runtime grants/policies for every new object.
ALTER DEFAULT PRIVILEGES FOR ROLE tallermecario_schema_owner IN SCHEMA public
	REVOKE ALL ON TABLES FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tallermecario_schema_owner IN SCHEMA app
	REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

RESET ROLE;
--> statement-breakpoint
DO $cleanup_memberships$
DECLARE
	executor_role name := session_user;
BEGIN
	IF COALESCE(NULLIF(pg_catalog.current_setting('tallermecario.migration_revoke_resolver', true), '')::boolean, false) THEN
		EXECUTE pg_catalog.format('REVOKE tallermecario_bootstrap_resolver FROM %I', executor_role);
	END IF;
	IF COALESCE(NULLIF(pg_catalog.current_setting('tallermecario.migration_revoke_owner', true), '')::boolean, false) THEN
		EXECUTE pg_catalog.format('REVOKE tallermecario_schema_owner FROM %I', executor_role);
	END IF;
END
$cleanup_memberships$;
