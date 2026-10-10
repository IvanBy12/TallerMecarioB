-- B06: no history rewrite, no migration-time deletion. Narrow tenant lifecycle.
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tallermecario_media_purger') THEN CREATE ROLE tallermecario_media_purger; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tallermecario_media_lifecycle') THEN CREATE ROLE tallermecario_media_lifecycle; END IF;
END $roles$;
--> statement-breakpoint
ALTER ROLE tallermecario_media_purger NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE tallermecario_media_lifecycle NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
DO $isolation$ BEGIN
 -- No persistent lifecycle membership in either direction is authorized. This
 -- also excludes every indirect SET/inheritance path through an intermediate role.
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.roleid,m.member)
   WHERE r.rolname='tallermecario_media_lifecycle') THEN
 RAISE EXCEPTION 'media lifecycle role isolation invalid'; END IF;
 IF pg_has_role('tallermecario_api','tallermecario_media_purger','MEMBER')
 OR pg_has_role('tallermecario_worker','tallermecario_media_purger','MEMBER')
 OR pg_has_role('tallermecario_api','tallermecario_media_lifecycle','MEMBER')
 OR pg_has_role('tallermecario_worker','tallermecario_media_lifecycle','MEMBER')
 OR pg_has_role('tallermecario_media_purger','tallermecario_schema_owner','MEMBER')
 OR pg_has_role('tallermecario_media_purger','tallermecario_media_lifecycle','MEMBER') THEN
 RAISE EXCEPTION 'media lifecycle role isolation invalid'; END IF;
 PERFORM set_config('tallermecario.b06_revoke_lifecycle',
 CASE WHEN pg_has_role(session_user,'tallermecario_media_lifecycle','MEMBER') THEN 'false' ELSE 'true' END,true);
 IF current_setting('tallermecario.b06_revoke_lifecycle')='true' THEN
 EXECUTE format('GRANT tallermecario_media_lifecycle TO %I',session_user); END IF;
END $isolation$;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
SET LOCAL lock_timeout='5s';
--> statement-breakpoint
CREATE TABLE public.media_purge_jobs (
 tenant_id uuid NOT NULL REFERENCES public.workshops(id),
 media_asset_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 prior_status varchar(24) NOT NULL CHECK(prior_status IN ('pending_upload','uploaded','active','quarantined')),
 reason varchar(32) NOT NULL CHECK(reason IN ('manual_unattached','retention_expired')),
 state varchar(32) NOT NULL DEFAULT 'queued' CHECK(state IN
 ('queued','claimed','retryable_storage_failure','storage_deleted','storage_absent','db_confirmation_retry','suspended','reconciliation_required','completed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 claim_id uuid, claim_backend integer, claimed_at timestamptz, claim_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claim_storage_outcome varchar(16) NOT NULL DEFAULT 'not_attempted' CHECK(claim_storage_outcome IN ('not_attempted','unknown','deleted','absent','failed')),
 storage_outcome varchar(16) NOT NULL DEFAULT 'not_attempted' CHECK(storage_outcome IN ('not_attempted','unknown','deleted','absent','failed')),
 last_result varchar(32) CHECK(last_result IN ('deleted','absent','storage_unavailable','confirmation_unavailable','eligibility_blocked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 PRIMARY KEY(tenant_id,media_asset_id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,media_asset_id) REFERENCES public.media_assets(tenant_id,id) ON DELETE NO ACTION,
 CHECK((claim_id IS NULL)=(claim_backend IS NULL)),
 CHECK((state='completed')=(completed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX media_purge_jobs_due_idx ON public.media_purge_jobs(tenant_id,next_attempt_at,media_asset_id) WHERE state NOT IN ('completed','reconciliation_required');
--> statement-breakpoint
CREATE INDEX media_assets_purge_scan_idx ON public.media_assets(tenant_id,id) WHERE purged_at IS NULL AND status<>'deleted' AND deletion_requested_at IS NULL AND deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.media_purge_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.media_purge_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.media_purge_jobs FROM PUBLIC,tallermecario_api,tallermecario_worker,tallermecario_media_purger;
--> statement-breakpoint
CREATE POLICY tenant_select ON public.media_purge_jobs FOR SELECT TO tallermecario_api,tallermecario_worker USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY tenant_insert ON public.media_purge_jobs FOR INSERT TO tallermecario_api,tallermecario_worker WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.media_purge_jobs TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT INSERT(tenant_id,media_asset_id,prior_status,reason) ON public.media_purge_jobs TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT UPDATE(state,attempts,claim_id,claim_backend,claimed_at,claim_until,next_attempt_at,last_result,storage_outcome,claim_storage_outcome,completed_at)
 ON public.media_purge_jobs TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT SELECT(tenant_id,media_asset_id,claim_until) ON public.media_purge_jobs TO tallermecario_api;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app,public TO tallermecario_media_lifecycle,tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO tallermecario_media_lifecycle,tallermecario_media_purger;
--> statement-breakpoint
GRANT SELECT ON public.media_assets TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.media_assets FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.upload_sessions TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.upload_sessions FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.media_upload_bindings TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.media_upload_bindings FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.receptions TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.receptions FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.vehicle_damages TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.vehicle_damages FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.service_orders TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.service_orders FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.service_order_items TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.service_order_items FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.reception_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.reception_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.damage_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.damage_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.finding_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.finding_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.findings TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.findings FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.work_activity_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.work_activity_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.work_activities TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.work_activities FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.quality_check_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.quality_check_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.quality_checks TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.quality_checks FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.delivery_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.delivery_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.deliveries TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.deliveries FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.quote_media TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.quote_media FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.quote_versions TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.quote_versions FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.signatures TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.signatures FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.privacy_consents TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.privacy_consents FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.memberships TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.memberships FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.membership_roles TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.membership_roles FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.roles TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT SELECT ON public.role_permissions TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT SELECT ON public.permissions TO tallermecario_media_lifecycle;
--> statement-breakpoint
GRANT SELECT ON public.audit_logs TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.audit_logs FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT SELECT ON public.media_purge_jobs TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_select ON public.media_purge_jobs FOR SELECT TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(id) ON public.media_assets TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.media_assets FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(id) ON public.upload_sessions TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.upload_sessions FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(id) ON public.receptions TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.receptions FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(id) ON public.vehicle_damages TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.vehicle_damages FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(id) ON public.service_orders TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.service_orders FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT UPDATE(status,deletion_requested_at,deleted_at,purged_at,delete_reason,updated_at) ON public.media_assets TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_insert ON public.media_purge_jobs FOR INSERT TO tallermecario_media_lifecycle WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY media_lifecycle_update ON public.media_purge_jobs FOR UPDATE TO tallermecario_media_lifecycle USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT INSERT(id,tenant_id,actor_type,actor_user_id,actor_membership_id,action,outcome,
 entity_type,entity_id,metadata_json,request_id) ON public.audit_logs TO tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE POLICY media_lifecycle_insert ON public.audit_logs FOR INSERT TO tallermecario_media_lifecycle WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint
GRANT CREATE ON SCHEMA app TO tallermecario_media_lifecycle;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE FUNCTION app.media_retention_links(p_ids uuid[]) RETURNS TABLE(kind text,id uuid,reception_id uuid,damage_id uuid,order_id uuid,item_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$


    SELECT 'reception_media' kind, rm.reception_id id, r.id reception_id, NULL::uuid damage_id,
      o.id order_id, NULL::uuid item_id FROM public.reception_media rm
      JOIN public.receptions r ON r.tenant_id=rm.tenant_id AND r.id=rm.reception_id
      LEFT JOIN public.service_orders o ON o.tenant_id=r.tenant_id AND o.reception_id=r.id
      WHERE rm.tenant_id=app.current_tenant_id() AND rm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'damage_media', dm.damage_id, r.id, d.id, o.id, NULL::uuid FROM public.damage_media dm
      JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
      JOIN public.receptions r ON r.tenant_id=d.tenant_id AND r.id=d.reception_id
      LEFT JOIN public.service_orders o ON o.tenant_id=r.tenant_id AND o.reception_id=r.id
      WHERE dm.tenant_id=app.current_tenant_id() AND dm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'finding_media', f.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.finding_media fm
      JOIN public.findings f ON f.tenant_id=fm.tenant_id AND f.id=fm.finding_id
      JOIN public.service_orders o ON o.tenant_id=f.tenant_id AND o.id=f.order_id
      WHERE fm.tenant_id=app.current_tenant_id() AND fm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'work_activity_media', w.id, o.reception_id, NULL::uuid, o.id, w.service_order_item_id
      FROM public.work_activity_media wm
      JOIN public.work_activities w ON w.tenant_id=wm.tenant_id AND w.id=wm.work_activity_id
      JOIN public.service_orders o ON o.tenant_id=w.tenant_id AND o.id=w.order_id
      WHERE wm.tenant_id=app.current_tenant_id() AND wm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'quality_check_media', q.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.quality_check_media qm
      JOIN public.quality_checks q ON q.tenant_id=qm.tenant_id AND q.id=qm.quality_check_id
      JOIN public.service_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id
      WHERE qm.tenant_id=app.current_tenant_id() AND qm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'delivery_media', d.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.delivery_media dm
      JOIN public.deliveries d ON d.tenant_id=dm.tenant_id AND d.id=dm.delivery_id
      JOIN public.service_orders o ON o.tenant_id=d.tenant_id AND o.id=d.order_id
      WHERE dm.tenant_id=app.current_tenant_id() AND dm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'quote_media', q.id, o.reception_id, NULL::uuid, o.id, NULL::uuid FROM public.quote_media qm
      JOIN public.quote_versions q ON q.tenant_id=qm.tenant_id AND q.id=qm.quote_version_id
      JOIN public.service_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id
      WHERE qm.tenant_id=app.current_tenant_id() AND qm.media_asset_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'signature', s.id, COALESCE(s.reception_id,o.reception_id), NULL::uuid, o.id, NULL::uuid
      FROM public.signatures s LEFT JOIN public.deliveries d ON d.tenant_id=s.tenant_id AND d.id=s.delivery_id
      LEFT JOIN public.service_orders o ON o.tenant_id=d.tenant_id AND o.id=d.order_id
      WHERE s.tenant_id=app.current_tenant_id() AND s.signature_media_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'privacy_evidence', c.id, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid FROM public.privacy_consents c
      WHERE c.tenant_id=app.current_tenant_id() AND c.evidence_media_id=ANY(p_ids::uuid[])
    UNION
    SELECT 'upload_binding', b.upload_session_id, b.reception_id, b.damage_id, NULL::uuid, NULL::uuid
      FROM public.media_upload_bindings b JOIN public.upload_sessions us
        ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
      WHERE b.tenant_id=app.current_tenant_id() AND us.media_asset_id=ANY(p_ids::uuid[])

$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_retention_links(uuid[]) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.lock_media_purge(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE rs uuid[]; ds uuid[]; os uuid[]; ss uuid[];
BEGIN
 SELECT coalesce(array_agg(DISTINCT reception_id) FILTER(WHERE reception_id IS NOT NULL),'{}'),
 coalesce(array_agg(DISTINCT damage_id) FILTER(WHERE damage_id IS NOT NULL),'{}'),
 coalesce(array_agg(DISTINCT order_id) FILTER(WHERE order_id IS NOT NULL),'{}') INTO rs,ds,os
 FROM app.media_retention_links(ARRAY[p_id]);
 SELECT coalesce(array_agg(DISTINCT id),'{}') || os INTO os FROM public.service_orders
 WHERE tenant_id=app.current_tenant_id() AND reception_id=ANY(rs);
 PERFORM id FROM public.receptions WHERE tenant_id=app.current_tenant_id() AND id=ANY(rs) ORDER BY id FOR NO KEY UPDATE;
 PERFORM id FROM public.vehicle_damages WHERE tenant_id=app.current_tenant_id() AND id=ANY(ds) ORDER BY id FOR SHARE;
 PERFORM id FROM public.service_orders WHERE tenant_id=app.current_tenant_id() AND id=ANY(os) ORDER BY id FOR NO KEY UPDATE;
 SELECT coalesce(array_agg(id),'{}') INTO ss FROM (SELECT id FROM public.upload_sessions
 WHERE tenant_id=app.current_tenant_id() AND media_asset_id=p_id ORDER BY id FOR UPDATE) locked;
 PERFORM id FROM public.media_assets WHERE tenant_id=app.current_tenant_id() AND id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ASSET_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM app.media_retention_links(ARRAY[p_id]) l WHERE
 (l.reception_id IS NOT NULL AND NOT l.reception_id=ANY(rs)) OR
 (l.damage_id IS NOT NULL AND NOT l.damage_id=ANY(ds)) OR
 (l.order_id IS NOT NULL AND NOT l.order_id=ANY(os))) OR EXISTS(
 SELECT 1 FROM public.service_orders WHERE tenant_id=app.current_tenant_id() AND reception_id=ANY(rs) AND NOT id=ANY(os)) OR EXISTS(
 SELECT 1 FROM public.upload_sessions WHERE tenant_id=app.current_tenant_id() AND media_asset_id=p_id AND NOT id=ANY(ss)) THEN
 RAISE EXCEPTION 'MEDIA_LINEAGE_CHANGED' USING ERRCODE='serialization_failure'; END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lock_media_purge(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.media_purge_fence_key(p_id uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$

SELECT hashtextextended('tallermecario.media.purge/' || app.current_tenant_id()::text || '/' || p_id::text,0)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_purge_fence_key(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.media_purge_fence_owned(p_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$

SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
 AND granted AND mode='ExclusiveLock' AND objsubid=1
 AND classid=((app.media_purge_fence_key(p_id)>>32)&4294967295)::oid
 AND objid=(app.media_purge_fence_key(p_id)&4294967295)::oid)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_purge_fence_owned(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.media_retention_decision(p_id uuid, p_resume boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE m public.media_assets%ROWTYPE; l record; s record; until_at timestamptz; effective_status text; domain_status text; protected boolean; warranty boolean; session_count integer; sources jsonb:='[]'; blockers jsonb; known text; blocker text; eligibility text;
BEGIN
 SELECT * INTO m FROM public.media_assets WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF m.id IS NULL THEN RAISE EXCEPTION 'MEDIA_ASSET_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 effective_status:=m.status;
 IF p_resume AND m.status='deleted' AND m.deletion_requested_at IS NOT NULL AND m.deleted_at IS NOT NULL AND m.purged_at IS NULL THEN
 SELECT prior_status INTO effective_status FROM public.media_purge_jobs WHERE tenant_id=m.tenant_id AND media_asset_id=m.id;
 END IF;
 FOR l IN SELECT * FROM app.media_retention_links(ARRAY[p_id]) LOOP
  until_at:=NULL; blocker:=NULL;
  IF l.kind='upload_binding' THEN
   SELECT (r.status='open' AND r.privacy_consent_id=b.privacy_consent_id AND c.customer_id=r.customer_id
    AND c.purpose_code='service_provision' AND c.created_at<=b.authorized_at AND b.created_at=b.authorized_at
    AND b.authorized_at<=clock_timestamp() AND ((us.status='pending' AND us.expires_at>clock_timestamp() AND us.integrity_version='v1')
    OR (us.status='completed' AND effective_status='active' AND NOT (
     (b.damage_id IS NULL AND EXISTS(SELECT 1 FROM public.reception_media rm WHERE rm.tenant_id=b.tenant_id
      AND rm.reception_id=b.reception_id AND rm.media_asset_id=us.media_asset_id AND rm.purpose='intake_evidence')) OR
     (b.damage_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.damage_media dm JOIN public.vehicle_damages d
      ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id WHERE dm.tenant_id=b.tenant_id AND dm.damage_id=b.damage_id
      AND d.reception_id=b.reception_id AND dm.media_asset_id=us.media_asset_id AND dm.purpose='damage_evidence')))))) INTO protected
    FROM public.media_upload_bindings b JOIN public.upload_sessions us ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
    JOIN public.receptions r ON r.tenant_id=b.tenant_id AND r.id=b.reception_id
    JOIN public.privacy_consents c ON c.tenant_id=b.tenant_id AND c.id=b.privacy_consent_id
    WHERE b.tenant_id=m.tenant_id AND b.upload_session_id=l.id;
   IF NOT coalesce(protected,false) THEN CONTINUE; END IF;
   blocker:='UNRESOLVED_PROTECTION';
  ELSIF l.kind IN ('privacy_evidence','quote_media') THEN blocker:='UNRESOLVED_PROTECTION';
  ELSIF l.kind='signature' THEN
   SELECT ((signed_at AT TIME ZONE 'UTC')+interval '36 months') AT TIME ZONE 'UTC' INTO until_at
    FROM public.signatures WHERE tenant_id=m.tenant_id AND id=l.id;
   IF until_at IS NULL THEN blocker:='UNRESOLVED_PROTECTION'; END IF;
  ELSIF l.kind='delivery_media' THEN
   SELECT status,((delivered_at AT TIME ZONE 'UTC')+interval '36 months') AT TIME ZONE 'UTC' INTO domain_status,until_at
    FROM public.deliveries WHERE tenant_id=m.tenant_id AND id=l.id;
   IF domain_status='pending' THEN until_at:=NULL; blocker:='CLOCK_NOT_STARTED';
   ELSIF domain_status IS DISTINCT FROM 'completed' OR until_at IS NULL THEN until_at:=NULL; blocker:='UNRESOLVED_PROTECTION'; END IF;
  ELSIF m.media_type NOT IN ('photo','video','video360') THEN blocker:='UNRESOLVED_PROTECTION';
  ELSIF l.order_id IS NULL THEN blocker:='CLOCK_NOT_STARTED';
  ELSE
   SELECT status,((closed_at AT TIME ZONE 'UTC')+interval '12 months') AT TIME ZONE 'UTC' INTO domain_status,until_at
    FROM public.service_orders WHERE tenant_id=m.tenant_id AND id=l.order_id;
   IF domain_status NOT IN ('delivered','cancelled') OR domain_status IS NULL THEN until_at:=NULL; blocker:='DOMAIN_LINK_NONTERMINAL';
   ELSIF until_at IS NULL THEN blocker:='UNRESOLVED_PROTECTION'; END IF;
  END IF;
  sources:=sources||jsonb_build_array(jsonb_build_object('kind',l.kind,'id',l.id,'knownRetentionUntil',
   to_char(until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'blocker',blocker));
  IF l.item_id IS NOT NULL AND m.media_type IN ('photo','video','video360') AND l.order_id IS NOT NULL THEN
   SELECT warranty_origin<>'none',((warranty_expires_at AT TIME ZONE 'UTC')+interval '90 days') AT TIME ZONE 'UTC' INTO warranty,until_at
    FROM public.service_order_items WHERE tenant_id=m.tenant_id AND id=l.item_id AND order_id=l.order_id;
   IF warranty THEN sources:=sources||jsonb_build_array(jsonb_build_object('kind','warranty_item','id',l.item_id,
    'knownRetentionUntil',to_char(until_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'blocker',CASE WHEN until_at IS NULL THEN 'UNRESOLVED_PROTECTION' END)); END IF;
  END IF;
 END LOOP;
 session_count:=0;
 FOR s IN SELECT id,created_at,status,expires_at FROM public.upload_sessions WHERE tenant_id=m.tenant_id AND media_asset_id=p_id AND status<>'completed' LOOP
  session_count:=session_count+1;
  IF effective_status IN ('pending_upload','uploaded') THEN
   sources:=sources||jsonb_build_array(jsonb_build_object('kind','incomplete_upload','id',s.id,
    'knownRetentionUntil',to_char((s.created_at+interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'blocker',CASE WHEN s.status='pending' AND s.expires_at>clock_timestamp() THEN 'ACTIVE_UPLOAD' END));
  ELSIF s.status='pending' AND s.expires_at>clock_timestamp() THEN
   sources:=sources||jsonb_build_array(jsonb_build_object('kind','live_upload','id',s.id,'knownRetentionUntil',NULL,'blocker','ACTIVE_UPLOAD'));
  END IF;
 END LOOP;
 IF effective_status IN ('pending_upload','uploaded') AND session_count=0 THEN
  sources:=sources||jsonb_build_array(jsonb_build_object('kind','incomplete_clock_unresolved','id',p_id,'knownRetentionUntil',NULL,'blocker','UNRESOLVED_PROTECTION'));
 ELSIF effective_status='quarantined' THEN
  sources:=sources||jsonb_build_array(jsonb_build_object('kind','quarantine','id',p_id,
   'knownRetentionUntil',to_char(((m.quarantined_at AT TIME ZONE 'UTC')+interval '7 days'),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'blocker',CASE WHEN m.quarantined_at IS NULL THEN 'UNRESOLVED_PROTECTION' END));
 ELSIF effective_status='active' AND jsonb_array_length(sources)=0 THEN
  sources:=sources||jsonb_build_array(jsonb_build_object('kind','active_unlinked','id',p_id,
   'knownRetentionUntil',to_char(((m.uploaded_at AT TIME ZONE 'UTC')+interval '30 days'),'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'blocker',CASE WHEN m.uploaded_at IS NULL THEN 'UNRESOLVED_PROTECTION' END));
 END IF;
 IF m.retention_until IS NOT NULL THEN sources:=sources||jsonb_build_array(jsonb_build_object('kind','committed_floor','id',p_id,
  'knownRetentionUntil',to_char(m.retention_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'blocker',NULL)); END IF;
 IF m.legal_hold_until>clock_timestamp() THEN sources:=sources||jsonb_build_array(jsonb_build_object('kind','legal_hold','id',p_id,'knownRetentionUntil',NULL,'blocker','LEGAL_HOLD')); END IF;
 IF effective_status IS NULL OR effective_status='deleted' OR m.purged_at IS NOT NULL
 OR (NOT p_resume AND (m.deletion_requested_at IS NOT NULL OR m.deleted_at IS NOT NULL)) THEN
  sources:=sources||jsonb_build_array(jsonb_build_object('kind','lifecycle','id',p_id,'knownRetentionUntil',NULL,'blocker','LIFECYCLE_UNAVAILABLE')); END IF;
 SELECT max(v->>'knownRetentionUntil') INTO known FROM jsonb_array_elements(sources) v;
 SELECT coalesce(jsonb_agg(b ORDER BY first_seen),'[]') INTO blockers FROM (SELECT v->>'blocker' b,min(n) first_seen FROM jsonb_array_elements(sources) WITH ORDINALITY e(v,n) WHERE v->>'blocker' IS NOT NULL GROUP BY v->>'blocker') ordered;
 IF known IS NULL AND jsonb_array_length(blockers)=0 THEN blockers:='["UNRESOLVED_PROTECTION"]'; END IF;
 FOREACH blocker IN ARRAY ARRAY['LIFECYCLE_UNAVAILABLE','LEGAL_HOLD','ACTIVE_UPLOAD','DOMAIN_LINK_NONTERMINAL','CLOCK_NOT_STARTED','UNRESOLVED_PROTECTION'] LOOP
  IF blockers ? blocker THEN eligibility:='NOT_ELIGIBLE_'||blocker; EXIT; END IF;
 END LOOP;
 IF eligibility IS NULL THEN eligibility:=CASE WHEN known::timestamptz<=clock_timestamp() THEN 'ELIGIBLE_AFTER_DATE' ELSE 'NOT_ELIGIBLE_RETENTION_NOT_EXPIRED' END; END IF;
 RETURN jsonb_build_object('knownRetentionUntil',known,'blocksAutomaticPurge',eligibility<>'ELIGIBLE_AFTER_DATE',
 'blockers',blockers,'sources',sources,'policyVersion','v1','eligibility',eligibility);
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_retention_decision(uuid,boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.request_media_deletion(p_id uuid, p_manual boolean) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE m public.media_assets%ROWTYPE;
BEGIN
 IF app.current_tenant_id() IS NULL THEN RAISE EXCEPTION 'MEDIA_ASSET_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_manual THEN
  IF NOT EXISTS(SELECT 1 FROM public.memberships mem JOIN public.membership_roles mr ON mr.tenant_id=mem.tenant_id AND mr.membership_id=mem.id
   JOIN public.roles r ON r.id=mr.role_id JOIN public.role_permissions rp ON rp.role_id=r.id JOIN public.permissions p ON p.id=rp.permission_id
   WHERE mem.tenant_id=app.current_tenant_id() AND mem.id=NULLIF(current_setting('app.membership_id',true),'')::uuid
   AND mem.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid AND mem.status='active'
   AND r.code IN ('owner','admin') AND p.code='media.remove_unattached' AND rp.resource_scope='tenant') THEN
   RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE='insufficient_privilege'; END IF;
 ELSE
  IF NOT pg_has_role(session_user,'tallermecario_media_purger','MEMBER') THEN RAISE EXCEPTION 'PERMISSION_DENIED' USING ERRCODE='insufficient_privilege'; END IF;
 END IF;
 PERFORM app.lock_media_purge(p_id);
 SELECT * INTO m FROM public.media_assets WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF m.status='deleted' AND m.deletion_requested_at IS NOT NULL AND m.deleted_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM public.media_purge_jobs WHERE tenant_id=m.tenant_id AND media_asset_id=m.id AND (NOT p_manual OR reason='manual_unattached')) THEN
 RETURN CASE WHEN m.purged_at IS NULL THEN 'deleted' ELSE 'purged' END; END IF;
 IF p_manual AND m.status='deleted' THEN RAISE EXCEPTION 'MEDIA_DELETE_NOT_ELIGIBLE' USING ERRCODE='check_violation'; END IF;
 IF m.legal_hold_until>clock_timestamp() THEN RAISE EXCEPTION 'MEDIA_LEGAL_HOLD' USING ERRCODE='check_violation'; END IF;
 IF p_manual AND EXISTS(SELECT 1 FROM app.media_retention_links(ARRAY[p_id]) WHERE kind<>'upload_binding') THEN
 RAISE EXCEPTION 'MEDIA_DELETE_NOT_ELIGIBLE' USING ERRCODE='check_violation'; END IF;
 IF (app.media_retention_decision(p_id,false)->>'eligibility')<>'ELIGIBLE_AFTER_DATE' THEN
 RAISE EXCEPTION 'MEDIA_DELETE_NOT_ELIGIBLE' USING ERRCODE='check_violation'; END IF;
 IF NOT pg_try_advisory_xact_lock(app.media_purge_fence_key(p_id)) THEN RAISE EXCEPTION 'MEDIA_PURGE_BUSY' USING ERRCODE='object_in_use'; END IF;
 INSERT INTO public.media_purge_jobs(tenant_id,media_asset_id,prior_status,reason)
 VALUES(m.tenant_id,m.id,m.status,CASE WHEN p_manual THEN 'manual_unattached' ELSE 'retention_expired' END);
 UPDATE public.media_assets SET status='deleted',deletion_requested_at=clock_timestamp(),deleted_at=clock_timestamp(),
 delete_reason=CASE WHEN p_manual THEN 'manual_unattached' ELSE 'retention_expired' END,updated_at=clock_timestamp()
 WHERE tenant_id=m.tenant_id AND id=m.id;
 INSERT INTO public.audit_logs(id,tenant_id,actor_type,actor_user_id,actor_membership_id,action,outcome,entity_type,entity_id,metadata_json,request_id)
 VALUES(gen_random_uuid(),m.tenant_id,CASE WHEN p_manual THEN 'user' ELSE 'system' END,
 CASE WHEN p_manual THEN NULLIF(current_setting('app.user_id',true),'')::uuid END,
 CASE WHEN p_manual THEN NULLIF(current_setting('app.membership_id',true),'')::uuid END,
 'media.deletion_requested','success','media_asset',m.id,
 jsonb_build_object('reason',CASE WHEN p_manual THEN 'manual_unattached' ELSE 'retention_expired' END,'retention_policy_version',m.retention_policy_version),
 coalesce(NULLIF(current_setting('app.request_id',true),''),m.id::text));
 RETURN 'deleted';
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.request_media_deletion(uuid,boolean) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.remove_unattached_media(p_id uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$

SELECT app.request_media_deletion(p_id,true)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.remove_unattached_media(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.queue_retention_media_purge(p_id uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$

SELECT app.request_media_deletion(p_id,false)
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.queue_retention_media_purge(uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.media_purge_candidates(p_after uuid, p_limit integer) RETURNS TABLE(media_asset_id uuid,candidate boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$

BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'invalid batch limit'; END IF;
 -- Bound the index page BEFORE evaluating cheap protection filters. Even a
 -- tenant with millions of future floors advances by only 100 rows per cycle.
 RETURN QUERY WITH page AS MATERIALIZED (
  SELECT m.id,m.retention_until,m.legal_hold_until FROM public.media_assets m
  WHERE m.tenant_id=app.current_tenant_id() AND m.purged_at IS NULL
   AND m.status<>'deleted' AND m.deletion_requested_at IS NULL AND m.deleted_at IS NULL
   AND (p_after IS NULL OR m.id>p_after) ORDER BY m.id LIMIT p_limit
 ) SELECT page.id,(page.retention_until IS NULL OR page.retention_until<=clock_timestamp())
  AND (page.legal_hold_until IS NULL OR page.legal_hold_until<=clock_timestamp())
  FROM page ORDER BY page.id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_purge_candidates(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.media_purge_due(p_limit integer) RETURNS TABLE(media_asset_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$

BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'invalid batch limit'; END IF;
 RETURN QUERY SELECT j.media_asset_id FROM public.media_purge_jobs j WHERE j.tenant_id=app.current_tenant_id()
 AND j.state NOT IN ('completed','reconciliation_required') AND j.next_attempt_at<=clock_timestamp() ORDER BY j.next_attempt_at,j.media_asset_id LIMIT p_limit;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_purge_due(integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.claim_media_purge(p_id uuid, p_claim uuid) RETURNS TABLE(object_key text,bucket text,attempt integer) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE m public.media_assets%ROWTYPE; j public.media_purge_jobs%ROWTYPE;
BEGIN
 IF p_claim IS NULL OR NOT app.media_purge_fence_owned(p_id) THEN RAISE EXCEPTION 'MEDIA_PURGE_FENCE_REQUIRED'; END IF;
 PERFORM app.lock_media_purge(p_id);
 SELECT * INTO m FROM public.media_assets WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 SELECT * INTO j FROM public.media_purge_jobs WHERE tenant_id=m.tenant_id AND media_asset_id=m.id FOR UPDATE;
 IF j.id IS NULL OR j.state IN ('completed','reconciliation_required') OR m.purged_at IS NOT NULL OR j.claim_until>clock_timestamp() THEN RETURN; END IF;
 IF m.storage_provider<>'cloudflare_r2' THEN RAISE EXCEPTION 'MEDIA_PURGE_STORAGE_UNSUPPORTED'; END IF;
 IF m.status<>'deleted' OR m.deleted_at IS NULL OR m.deletion_requested_at IS NULL THEN RAISE EXCEPTION 'MEDIA_PURGE_STATE_INVALID'; END IF;
 IF (app.media_retention_decision(p_id,true)->>'eligibility')<>'ELIGIBLE_AFTER_DATE' THEN
  IF j.storage_outcome IN ('unknown','deleted','absent') THEN
   INSERT INTO public.audit_logs(id,tenant_id,actor_type,action,outcome,entity_type,entity_id,metadata_json,request_id)
   VALUES(gen_random_uuid(),j.tenant_id,'system','media.purge_reconciliation_required','success','media_asset',p_id,
    jsonb_build_object('job_id',j.id,'reason',j.reason,'storage_outcome',j.storage_outcome,'attempts',j.attempts),j.id::text);
   UPDATE public.media_purge_jobs SET state='reconciliation_required',claim_id=NULL,claim_backend=NULL,claim_until=NULL
    WHERE tenant_id=m.tenant_id AND media_asset_id=p_id;
  ELSE
   UPDATE public.media_purge_jobs SET state='suspended',last_result=CASE WHEN attempts>0 THEN last_result ELSE 'eligibility_blocked' END,claim_id=NULL,claim_backend=NULL,claim_until=NULL,
    next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE tenant_id=m.tenant_id AND media_asset_id=p_id;
  END IF;
  RETURN;
 END IF;
 UPDATE public.media_purge_jobs SET state='claimed',claim_id=p_claim,claim_backend=pg_backend_pid(),claimed_at=clock_timestamp(),claim_until=clock_timestamp()+interval '120 seconds',
  last_result=CASE WHEN last_result IN ('deleted','absent') THEN last_result ELSE 'storage_unavailable' END,
  claim_storage_outcome=storage_outcome,
  storage_outcome=CASE WHEN storage_outcome IN ('deleted','absent') THEN storage_outcome ELSE 'unknown' END,
  attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE tenant_id=m.tenant_id AND media_asset_id=p_id RETURNING attempts INTO j.attempts;
 RETURN QUERY SELECT m.object_key::text,m.bucket::text,j.attempts;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_media_purge(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.record_media_purge_result(p_id uuid, p_claim uuid, p_result text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$

BEGIN
 IF p_result NOT IN ('deleted','absent','storage_unavailable','confirmation_unavailable','storage_rejected','storage_not_attempted') OR p_result IS NULL
 OR NOT app.media_purge_fence_owned(p_id) THEN RAISE EXCEPTION 'MEDIA_PURGE_RESULT_INVALID'; END IF;
 UPDATE public.media_purge_jobs SET last_result=CASE WHEN p_result='confirmation_unavailable' THEN last_result WHEN p_result IN ('storage_rejected','storage_not_attempted') THEN 'storage_unavailable' ELSE p_result END,
 storage_outcome=CASE WHEN p_result IN ('deleted','absent') THEN p_result
 WHEN claim_storage_outcome IN ('not_attempted','failed') AND p_result='storage_rejected' THEN 'failed'
 WHEN claim_storage_outcome IN ('not_attempted','failed') AND p_result='storage_not_attempted' THEN 'not_attempted' ELSE storage_outcome END,
 state=CASE p_result WHEN 'deleted' THEN 'storage_deleted'
 WHEN 'absent' THEN 'storage_absent' WHEN 'storage_unavailable' THEN 'retryable_storage_failure'
 WHEN 'storage_rejected' THEN 'retryable_storage_failure' WHEN 'storage_not_attempted' THEN 'retryable_storage_failure' ELSE 'db_confirmation_retry' END,
 next_attempt_at=clock_timestamp()+make_interval(secs=>least(900,30*power(2,least(attempts,5))::integer))
 WHERE tenant_id=app.current_tenant_id() AND media_asset_id=p_id AND claim_id=p_claim AND claim_backend=pg_backend_pid() AND claim_until>clock_timestamp() AND state IN ('claimed','storage_deleted','storage_absent','db_confirmation_retry');
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_PURGE_CLAIM_INVALID'; END IF;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.record_media_purge_result(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.confirm_media_purge(p_id uuid, p_claim uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE j public.media_purge_jobs%ROWTYPE;
BEGIN
 IF NOT app.media_purge_fence_owned(p_id) THEN RAISE EXCEPTION 'MEDIA_PURGE_FENCE_REQUIRED'; END IF;
 PERFORM app.lock_media_purge(p_id);
 SELECT * INTO j FROM public.media_purge_jobs WHERE tenant_id=app.current_tenant_id() AND media_asset_id=p_id FOR UPDATE;
 IF j.state='completed' THEN RETURN; END IF;
 IF j.id IS NULL OR j.claim_id IS DISTINCT FROM p_claim OR j.claim_backend IS DISTINCT FROM pg_backend_pid()
 OR j.claim_until IS NULL OR j.claim_until<=clock_timestamp()
 OR j.state NOT IN ('storage_deleted','storage_absent','db_confirmation_retry') OR j.last_result NOT IN ('deleted','absent') THEN
 RAISE EXCEPTION 'MEDIA_PURGE_CLAIM_INVALID'; END IF;
 IF (app.media_retention_decision(p_id,true)->>'eligibility')<>'ELIGIBLE_AFTER_DATE' THEN RAISE EXCEPTION 'MEDIA_DELETE_NOT_ELIGIBLE'; END IF;
 UPDATE public.media_assets SET purged_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE tenant_id=j.tenant_id AND id=p_id AND status='deleted' AND deleted_at IS NOT NULL AND purged_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_PURGE_STATE_INVALID'; END IF;
 INSERT INTO public.audit_logs(id,tenant_id,actor_type,action,outcome,entity_type,entity_id,metadata_json,request_id)
 VALUES(gen_random_uuid(),j.tenant_id,'system','media.purged','success','media_asset',p_id,
 jsonb_build_object('reason',j.reason,'job_id',j.id,'result',j.last_result),j.id::text);
 UPDATE public.media_purge_jobs SET state='completed',completed_at=clock_timestamp(),claim_id=NULL,claim_backend=NULL,claim_until=NULL
 WHERE tenant_id=j.tenant_id AND media_asset_id=p_id;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.confirm_media_purge(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- Structural protocol/identity checks. Lifecycle SQL and its function code are
-- trusted; diagnostic PG_CONTEXT/function names are not an authorization boundary.
CREATE FUNCTION app.guard_media_purge_job() RETURNS trigger LANGUAGE plpgsql
SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','attempts','claim_id','claim_backend','claimed_at','claim_until','next_attempt_at','last_result','storage_outcome','claim_storage_outcome','completed_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempts','claim_id','claim_backend','claimed_at','claim_until','next_attempt_at','last_result','storage_outcome','claim_storage_outcome','completed_at']) THEN
  RAISE EXCEPTION 'immutable purge job history' USING ERRCODE='23514',CONSTRAINT='media_purge_job_immutable_guard';
 END IF;
 IF current_user<>'tallermecario_media_lifecycle' OR NOT app.media_purge_fence_owned(OLD.media_asset_id) THEN
  RAISE EXCEPTION 'purge job protocol required' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard';
 END IF;
 IF OLD.state IN ('completed','reconciliation_required') THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal purge job' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.state<>'claimed' AND NEW.claim_storage_outcome IS DISTINCT FROM OLD.claim_storage_outcome THEN
  RAISE EXCEPTION 'immutable claim storage history' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard';
 END IF;
 IF NEW.state='claimed' THEN
  IF OLD.claim_until>clock_timestamp() OR NEW.claim_id IS NULL OR NEW.claim_backend IS DISTINCT FROM pg_backend_pid()
   OR NEW.claim_storage_outcome IS DISTINCT FROM OLD.storage_outcome
   OR NEW.claim_id IS NOT DISTINCT FROM OLD.claim_id
   OR NEW.claimed_at IS NULL OR NEW.claim_until IS NULL OR NEW.claim_until<=clock_timestamp() OR NEW.attempts<>OLD.attempts+1
   OR NEW.completed_at IS NOT NULL THEN
   RAISE EXCEPTION 'invalid purge claim' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
 ELSIF NEW.state='reconciliation_required' THEN
  IF OLD.claim_until>clock_timestamp() OR NEW.claim_id IS NOT NULL OR NEW.claim_backend IS NOT NULL OR NEW.claim_until IS NOT NULL
   OR NEW.attempts<>OLD.attempts OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
   OR NEW.last_result IS DISTINCT FROM OLD.last_result OR NEW.storage_outcome IS DISTINCT FROM OLD.storage_outcome
   OR OLD.storage_outcome NOT IN ('unknown','deleted','absent') OR NEW.completed_at IS NOT NULL
   OR (app.media_retention_decision(OLD.media_asset_id,true)->>'eligibility')='ELIGIBLE_AFTER_DATE'
   OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE tenant_id=OLD.tenant_id AND entity_id=OLD.media_asset_id
     AND action='media.purge_reconciliation_required' AND request_id=OLD.id::text) THEN
   RAISE EXCEPTION 'invalid purge reconciliation' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
 ELSIF NEW.state='suspended' THEN
  IF OLD.claim_until>clock_timestamp() OR NEW.claim_id IS NOT NULL OR NEW.claim_backend IS NOT NULL OR NEW.claim_until IS NOT NULL
   OR OLD.storage_outcome IN ('unknown','deleted','absent') OR NEW.storage_outcome IS DISTINCT FROM OLD.storage_outcome
   OR NEW.attempts<>OLD.attempts OR (OLD.attempts>0 AND NEW.last_result IS DISTINCT FROM OLD.last_result) THEN
   RAISE EXCEPTION 'invalid purge suspension' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
 ELSE
  IF OLD.claim_until IS NULL OR OLD.claim_until<=clock_timestamp() OR OLD.claim_backend IS DISTINCT FROM pg_backend_pid()
   OR OLD.claim_id IS NULL OR NEW.attempts<>OLD.attempts OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
   RAISE EXCEPTION 'invalid purge lease' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
  IF NEW.state='completed' THEN
   IF OLD.state NOT IN ('storage_deleted','storage_absent','db_confirmation_retry') OR OLD.last_result NOT IN ('deleted','absent')
    OR NEW.storage_outcome IS DISTINCT FROM OLD.storage_outcome OR NEW.last_result IS DISTINCT FROM OLD.last_result OR NEW.claim_id IS NOT NULL OR NEW.claim_backend IS NOT NULL OR NEW.claim_until IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.media_assets WHERE tenant_id=OLD.tenant_id AND id=OLD.media_asset_id AND purged_at IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE tenant_id=OLD.tenant_id AND entity_id=OLD.media_asset_id AND action='media.purged' AND request_id=OLD.id::text) THEN
    RAISE EXCEPTION 'unconfirmed purge completion' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
  ELSE
   IF NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.claim_backend IS DISTINCT FROM OLD.claim_backend OR NEW.claim_until IS DISTINCT FROM OLD.claim_until
    OR NOT ((OLD.state='claimed' AND ((NEW.state='storage_deleted' AND NEW.last_result='deleted')
      OR (NEW.state='storage_absent' AND NEW.last_result='absent')
      OR (NEW.state='retryable_storage_failure' AND NEW.last_result='storage_unavailable')
      OR (NEW.state='db_confirmation_retry' AND NEW.last_result IS NOT DISTINCT FROM OLD.last_result)))
     OR (OLD.state IN ('storage_deleted','storage_absent','db_confirmation_retry') AND NEW.state='db_confirmation_retry' AND NEW.last_result IS NOT DISTINCT FROM OLD.last_result)) THEN
    RAISE EXCEPTION 'invalid purge result transition' USING ERRCODE='23514',CONSTRAINT='media_purge_job_transition_guard'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_media_purge_job() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.guard_media_purge_job() TO tallermecario_schema_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE TRIGGER media_purge_job_guard_trg BEFORE UPDATE ON public.media_purge_jobs
 FOR EACH ROW EXECUTE FUNCTION app.guard_media_purge_job();
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_media_lifecycle;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.guard_media_purge_job() FROM tallermecario_schema_owner;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.remove_unattached_media(uuid) TO tallermecario_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_retention_decision(uuid,boolean) TO tallermecario_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.queue_retention_media_purge(uuid) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_purge_candidates(uuid,integer) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_purge_due(integer) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.claim_media_purge(uuid,uuid) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.record_media_purge_result(uuid,uuid,text) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.confirm_media_purge(uuid,uuid) TO tallermecario_media_purger;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.media_purge_fence_key(uuid) TO tallermecario_media_purger;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
DROP TRIGGER media_assets_delete_lifecycle_unavailable_trg ON public.media_assets;
--> statement-breakpoint
CREATE FUNCTION app.guard_media_destructive_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
DECLARE j public.media_purge_jobs%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status='deleted' OR NEW.deletion_requested_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.purged_at IS NOT NULL OR NEW.delete_reason IS NOT NULL THEN
   RAISE EXCEPTION 'invalid initial lifecycle' USING ERRCODE='check_violation',CONSTRAINT='media_destructive_lifecycle_guard'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='deleted' AND (to_jsonb(NEW)-ARRAY['legal_hold_until','retention_until','updated_at','purged_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['legal_hold_until','retention_until','updated_at','purged_at']) THEN
 RAISE EXCEPTION 'media tombstone history is immutable' USING ERRCODE='check_violation',CONSTRAINT='media_destructive_lifecycle_guard'; END IF;
 IF OLD.status='deleted' AND NEW.status IS DISTINCT FROM OLD.status
 OR OLD.deletion_requested_at IS NOT NULL AND NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
 OR OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
 OR OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
 RAISE EXCEPTION 'media tombstone is immutable' USING ERRCODE='check_violation',CONSTRAINT='media_destructive_lifecycle_guard'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status='deleted'
 OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
 OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.purged_at IS DISTINCT FROM OLD.purged_at
 OR NEW.delete_reason IS DISTINCT FROM OLD.delete_reason THEN
  IF current_user<>'tallermecario_media_lifecycle' THEN
  RAISE EXCEPTION 'media lifecycle requires reviewed entrypoint' USING ERRCODE='check_violation',CONSTRAINT='media_destructive_lifecycle_guard'; END IF;
  SELECT * INTO j FROM public.media_purge_jobs WHERE tenant_id=NEW.tenant_id AND media_asset_id=NEW.id;
  IF j.id IS NULL OR NEW.status<>'deleted' OR NEW.deletion_requested_at IS NULL OR NEW.deleted_at IS NULL
  OR NEW.delete_reason IS DISTINCT FROM j.reason
  OR (OLD.status<>'deleted' AND (j.state<>'queued' OR j.prior_status<>OLD.status OR NEW.purged_at IS NOT NULL))
  OR (NEW.purged_at IS DISTINCT FROM OLD.purged_at AND (j.state NOT IN ('storage_deleted','storage_absent','db_confirmation_retry')
    OR j.last_result NOT IN ('deleted','absent') OR j.claim_backend IS DISTINCT FROM pg_backend_pid()
    OR j.claim_until IS NULL OR j.claim_until<=clock_timestamp() OR NOT app.media_purge_fence_owned(NEW.id)))
  OR (app.media_retention_decision(NEW.id,OLD.status='deleted')->>'eligibility')<>'ELIGIBLE_AFTER_DATE' THEN
  RAISE EXCEPTION 'media lifecycle eligibility required' USING ERRCODE='check_violation',CONSTRAINT='media_destructive_lifecycle_guard'; END IF;
 END IF;
 -- Privileged future hold/floor writers MUST contend with the physical phase.
 -- Fail fast instead of waiting with a row lock and deadlocking confirmation.
 IF NEW.legal_hold_until IS DISTINCT FROM OLD.legal_hold_until OR NEW.retention_until IS DISTINCT FROM OLD.retention_until THEN
  IF EXISTS(SELECT 1 FROM public.media_purge_jobs WHERE tenant_id=NEW.tenant_id AND media_asset_id=NEW.id AND claim_until>clock_timestamp()) THEN
  RAISE EXCEPTION 'media purge in progress' USING ERRCODE='object_in_use',CONSTRAINT='media_purge_fence_guard'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('tallermecario.media.purge/'||NEW.tenant_id::text||'/'||NEW.id::text,0)) THEN
  RAISE EXCEPTION 'media purge in progress' USING ERRCODE='object_in_use',CONSTRAINT='media_purge_fence_guard'; END IF;
 END IF;
 RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_media_destructive_lifecycle() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER media_destructive_lifecycle_trg BEFORE INSERT OR UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION app.guard_media_destructive_lifecycle();
--> statement-breakpoint
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
    OR ((NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.purged_at IS DISTINCT FROM OLD.purged_at
      OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status='active' AND NEW.status='quarantined')))
      AND NOT (current_user='tallermecario_media_lifecycle' AND NEW.status='deleted'
        AND NEW.deletion_requested_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)))
    AND EXISTS (SELECT 1 FROM public.signatures s WHERE s.tenant_id = NEW.tenant_id
      AND s.signature_media_id = NEW.id) THEN
    RAISE EXCEPTION 'signed media evidence is immutable except for quarantine'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'signatures_media_guard';
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE FUNCTION app.guard_media_reference_tombstone() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
DECLARE p_id uuid; old_id uuid; unavailable boolean;
BEGIN
 p_id:=CASE TG_TABLE_NAME WHEN 'signatures' THEN (to_jsonb(NEW)->>'signature_media_id')::uuid
 WHEN 'privacy_consents' THEN (to_jsonb(NEW)->>'evidence_media_id')::uuid ELSE (to_jsonb(NEW)->>'media_asset_id')::uuid END;
 IF p_id IS NULL THEN RETURN NEW; END IF;
 -- Updates retaining the same historical reference remain valid after purge.
 IF TG_OP='UPDATE' THEN
  old_id:=CASE TG_TABLE_NAME WHEN 'signatures' THEN (to_jsonb(OLD)->>'signature_media_id')::uuid
  WHEN 'privacy_consents' THEN (to_jsonb(OLD)->>'evidence_media_id')::uuid ELSE (to_jsonb(OLD)->>'media_asset_id')::uuid END;
  IF p_id=old_id AND NEW.tenant_id=OLD.tenant_id AND
  ((TG_TABLE_NAME IN ('privacy_consents','signatures') OR (TG_TABLE_NAME='upload_sessions'
   AND (to_jsonb(NEW)->>'status') IN ('expired','failed')
   AND (to_jsonb(NEW)->>'expires_at')::timestamptz<=(to_jsonb(OLD)->>'expires_at')::timestamptz)) OR
   (TG_TABLE_NAME<>'upload_sessions' AND (to_jsonb(NEW)-ARRAY['sort_order','created_at'])=(to_jsonb(OLD)-ARRAY['sort_order','created_at']))) THEN RETURN NEW; END IF;
 END IF;
 SELECT status='deleted' OR deletion_requested_at IS NOT NULL OR deleted_at IS NOT NULL OR purged_at IS NOT NULL INTO unavailable
 FROM public.media_assets WHERE tenant_id=NEW.tenant_id AND id=p_id FOR SHARE;
 IF unavailable IS DISTINCT FROM false THEN RAISE EXCEPTION 'media reference unavailable'
 USING ERRCODE='check_violation',CONSTRAINT='media_reference_tombstone_guard'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('tallermecario.media.purge/'||NEW.tenant_id::text||'/'||p_id::text,0)) THEN
 RAISE EXCEPTION 'media purge in progress' USING ERRCODE='object_in_use',CONSTRAINT='media_purge_fence_guard'; END IF;
 RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_media_reference_tombstone() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.reception_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.damage_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.finding_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.work_activity_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.quality_check_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.delivery_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.quote_media FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.signatures FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.privacy_consents FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
CREATE TRIGGER z_media_reference_tombstone_trg BEFORE INSERT OR UPDATE ON public.upload_sessions FOR EACH ROW EXECUTE FUNCTION app.guard_media_reference_tombstone();
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_media_lifecycle;
--> statement-breakpoint
CREATE FUNCTION app.media_purge_order_assets(p_order uuid) RETURNS TABLE(id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
SELECT media_asset_id AS id FROM (
    SELECT rm.media_asset_id FROM public.reception_media rm JOIN public.service_orders o
      ON o.tenant_id=rm.tenant_id AND o.reception_id=rm.reception_id WHERE o.tenant_id=app.current_tenant_id() AND o.id=p_order
    UNION SELECT dm.media_asset_id FROM public.damage_media dm JOIN public.vehicle_damages d
      ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id JOIN public.service_orders o
      ON o.tenant_id=d.tenant_id AND o.reception_id=d.reception_id WHERE o.tenant_id=app.current_tenant_id() AND o.id=p_order
    UNION SELECT fm.media_asset_id FROM public.finding_media fm JOIN public.findings f
      ON f.tenant_id=fm.tenant_id AND f.id=fm.finding_id WHERE f.tenant_id=app.current_tenant_id() AND f.order_id=p_order
    UNION SELECT wm.media_asset_id FROM public.work_activity_media wm JOIN public.work_activities w
      ON w.tenant_id=wm.tenant_id AND w.id=wm.work_activity_id WHERE w.tenant_id=app.current_tenant_id() AND w.order_id=p_order
    UNION SELECT qm.media_asset_id FROM public.quality_check_media qm JOIN public.quality_checks q
      ON q.tenant_id=qm.tenant_id AND q.id=qm.quality_check_id WHERE q.tenant_id=app.current_tenant_id() AND q.order_id=p_order
    UNION SELECT dm.media_asset_id FROM public.delivery_media dm JOIN public.deliveries d
      ON d.tenant_id=dm.tenant_id AND d.id=dm.delivery_id WHERE d.tenant_id=app.current_tenant_id() AND d.order_id=p_order
    UNION SELECT qm.media_asset_id FROM public.quote_media qm JOIN public.quote_versions q
      ON q.tenant_id=qm.tenant_id AND q.id=qm.quote_version_id WHERE q.tenant_id=app.current_tenant_id() AND q.order_id=p_order
    UNION SELECT s.signature_media_id FROM public.signatures s JOIN public.service_orders o
      ON o.tenant_id=s.tenant_id AND o.reception_id=s.reception_id WHERE o.tenant_id=app.current_tenant_id() AND o.id=p_order
    UNION SELECT s.signature_media_id FROM public.signatures s JOIN public.deliveries d
      ON d.tenant_id=s.tenant_id AND d.id=s.delivery_id WHERE d.tenant_id=app.current_tenant_id() AND d.order_id=p_order
    UNION SELECT us.media_asset_id FROM public.media_upload_bindings b JOIN public.upload_sessions us
      ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id JOIN public.service_orders o
      ON o.tenant_id=b.tenant_id AND o.reception_id=b.reception_id WHERE o.tenant_id=app.current_tenant_id() AND o.id=p_order
  ) sources ORDER BY media_asset_id
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.media_purge_order_assets(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Retention source changes must share the physical fence, even via direct SQL.
CREATE FUNCTION app.guard_media_retention_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE saved_tenant text; parent_order uuid; parent_reception uuid; media_id uuid; ids uuid[];
BEGIN
 saved_tenant:=current_setting('app.tenant_id',true);
 PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
 IF TG_TABLE_NAME='service_orders' THEN parent_order:=OLD.id;
 ELSIF TG_TABLE_NAME='receptions' THEN parent_reception:=OLD.id;
 ELSIF TG_TABLE_NAME='vehicle_damages' THEN parent_reception:=OLD.reception_id;
 ELSE parent_order:=(to_jsonb(OLD)->>'order_id')::uuid; END IF;
 IF parent_order IS NOT NULL THEN SELECT array_agg(id ORDER BY id) INTO ids FROM app.media_purge_order_assets(parent_order);
 ELSE
  SELECT array_agg(DISTINCT id ORDER BY id) INTO ids FROM (
   SELECT media_asset_id id FROM public.reception_media WHERE tenant_id=NEW.tenant_id AND reception_id=parent_reception
   UNION SELECT dm.media_asset_id FROM public.damage_media dm JOIN public.vehicle_damages d ON d.tenant_id=dm.tenant_id AND d.id=dm.damage_id
    WHERE dm.tenant_id=NEW.tenant_id AND d.reception_id=parent_reception
   UNION SELECT s.signature_media_id FROM public.signatures s WHERE s.tenant_id=NEW.tenant_id AND s.reception_id=parent_reception
   UNION SELECT us.media_asset_id FROM public.media_upload_bindings b JOIN public.upload_sessions us ON us.tenant_id=b.tenant_id AND us.id=b.upload_session_id
    WHERE b.tenant_id=NEW.tenant_id AND b.reception_id=parent_reception
  ) evidence;
 END IF;
 FOREACH media_id IN ARRAY coalesce(ids,'{}'::uuid[]) LOOP
  IF NOT pg_try_advisory_xact_lock(app.media_purge_fence_key(media_id)) OR EXISTS(
   SELECT 1 FROM public.media_purge_jobs WHERE tenant_id=NEW.tenant_id AND media_asset_id=media_id AND claim_until>clock_timestamp()) THEN
   RAISE EXCEPTION 'media purge in progress' USING ERRCODE='object_in_use',CONSTRAINT='media_purge_fence_guard'; END IF;
 END LOOP;
 PERFORM set_config('app.tenant_id',coalesce(saved_tenant,''),true);
 RETURN NEW;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_media_retention_source() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.guard_media_retention_source() TO tallermecario_schema_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF status,closed_at ON public.service_orders
FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF warranty_origin,warranty_expires_at ON public.service_order_items
FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF status,delivered_at ON public.deliveries
FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF status ON public.receptions
FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF service_order_item_id,order_id ON public.work_activities FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF order_id ON public.findings FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF order_id ON public.quality_checks FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF order_id ON public.quote_versions FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
CREATE TRIGGER media_retention_source_fence_trg BEFORE UPDATE OF reception_id ON public.vehicle_damages FOR EACH ROW EXECUTE FUNCTION app.guard_media_retention_source();
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_media_lifecycle;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.guard_media_retention_source() FROM tallermecario_schema_owner;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
SET ROLE tallermecario_schema_owner;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA app FROM tallermecario_media_lifecycle;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
DO $memberships$ BEGIN IF current_setting('tallermecario.b06_revoke_lifecycle')='true' THEN
 EXECUTE format('REVOKE tallermecario_media_lifecycle FROM %I',session_user); END IF; END $memberships$;
