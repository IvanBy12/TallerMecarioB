-- Read-only reconciliation. No table/data/lifecycle changes.
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tallermecario_media_reconciler') THEN
 CREATE ROLE tallermecario_media_reconciler; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tallermecario_media_inventory_owner') THEN
 CREATE ROLE tallermecario_media_inventory_owner; END IF;
END $roles$;
--> statement-breakpoint
ALTER ROLE tallermecario_media_reconciler NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_media_inventory_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
DO $isolation$ BEGIN
 -- The B06 function-owner lifecycle: no persistent membership in either direction.
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='tallermecario_media_inventory_owner')
 OR member=(SELECT oid FROM pg_roles WHERE rolname='tallermecario_media_inventory_owner')) THEN
 RAISE EXCEPTION 'media inventory owner isolation invalid'; END IF;
 -- Fail closed if an existing role has broader direct/PUBLIC relation privileges.
 IF EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
 AND c.relnamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)
 AND ((has_column_privilege('tallermecario_media_inventory_owner',c.oid,a.attnum,'SELECT')
 AND NOT(c.oid='public.media_assets'::regclass AND a.attname IN ('storage_provider','bucket','object_key')))
 OR has_column_privilege('tallermecario_media_inventory_owner',c.oid,a.attnum,'INSERT,UPDATE,REFERENCES')
 OR has_table_privilege('tallermecario_media_inventory_owner',c.oid,'DELETE,TRUNCATE,TRIGGER'))) THEN
 RAISE EXCEPTION 'media inventory owner privileges invalid'; END IF;
 EXECUTE format('GRANT tallermecario_media_inventory_owner TO %I WITH INHERIT FALSE, SET TRUE',session_user);
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='tallermecario_media_reconciler'))
 OR pg_has_role('tallermecario_api','tallermecario_media_reconciler','MEMBER')
 OR pg_has_role('tallermecario_worker','tallermecario_media_reconciler','MEMBER')
 OR pg_has_role('tallermecario_media_purger','tallermecario_media_reconciler','MEMBER') THEN
 RAISE EXCEPTION 'media reconciliation role isolation invalid'; END IF;
END $isolation$;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public,app TO tallermecario_media_reconciler;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO tallermecario_media_reconciler;
--> statement-breakpoint
GRANT SELECT(id,tenant_id,storage_provider,bucket,object_key,status,retention_until,legal_hold_until,deletion_requested_at,deleted_at,purged_at)
 ON public.media_assets TO tallermecario_media_reconciler;
--> statement-breakpoint
GRANT SELECT(tenant_id,media_asset_id,status,expires_at,created_at) ON public.upload_sessions TO tallermecario_media_reconciler;
--> statement-breakpoint
GRANT SELECT(tenant_id,media_asset_id,state,storage_outcome) ON public.media_purge_jobs TO tallermecario_media_reconciler;
--> statement-breakpoint
CREATE POLICY media_reconciler_select ON public.media_assets FOR SELECT TO tallermecario_media_reconciler USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY media_reconciler_select ON public.upload_sessions FOR SELECT TO tallermecario_media_reconciler USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY media_reconciler_select ON public.media_purge_jobs FOR SELECT TO tallermecario_media_reconciler USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- FORCE RLS remains enabled. Only this isolated function owner can inspect the
-- three identity columns globally; legacy keys have no tenant-prefix constraint.
GRANT USAGE ON SCHEMA public,app TO tallermecario_media_inventory_owner;
--> statement-breakpoint
GRANT SELECT(storage_provider,bucket,object_key) ON public.media_assets TO tallermecario_media_inventory_owner;
--> statement-breakpoint
CREATE POLICY media_inventory_owner_select ON public.media_assets FOR SELECT TO tallermecario_media_inventory_owner USING(current_user='tallermecario_media_inventory_owner');
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_media_inventory_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_media_inventory_owner;
--> statement-breakpoint
CREATE FUNCTION app.media_storage_metadata_exists(p_bucket text,p_keys text[])
 RETURNS TABLE(object_key text,metadata_exists boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN
 IF p_bucket IS NULL OR length(p_bucket)<1 OR length(p_bucket)>120
 OR p_keys IS NULL OR cardinality(p_keys)<1 OR cardinality(p_keys)>100
 OR array_ndims(p_keys)<>1 OR EXISTS(SELECT 1 FROM unnest(p_keys) k WHERE k IS NULL OR length(k)<1 OR octet_length(k)>1024) THEN
 RAISE EXCEPTION 'MEDIA_RECONCILIATION_INPUT_INVALID'; END IF;
 RETURN QUERY SELECT k.key,EXISTS(SELECT 1 FROM public.media_assets m
 WHERE m.storage_provider='cloudflare_r2' AND m.bucket=p_bucket AND m.object_key=k.key)
 FROM unnest(p_keys) WITH ORDINALITY AS k(key,position) ORDER BY k.position;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_storage_metadata_exists(text,text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_storage_metadata_exists(text,text[]) TO tallermecario_media_reconciler;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_media_inventory_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $memberships$ BEGIN
 EXECUTE format('REVOKE tallermecario_media_inventory_owner FROM %I',session_user);
END $memberships$;
