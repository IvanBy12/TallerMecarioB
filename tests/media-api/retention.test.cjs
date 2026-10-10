'use strict';
const { test, before, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const h = require('../crm-api/helpers.cjs');
const { parent } = require('./operational-helpers.cjs');
const { assert } = h;
const retention = h.load('media/retention.js');
let a, b;
before(async () => { ({ a, b } = await h.twoTenants()); });
after(async () => h.closeAll());
const run = (tenant, fn) => h.asRuntime(h.apiPool, { tenantId: tenant.tenantId,
  userId: tenant.owner.user.id, membershipId: tenant.owner.membershipId }, fn);
const evaluate = (id, tenant = a) => run(tenant, (sql) => retention.evaluateMediaRetention(sql, tenant.tenantId, id));
const recalculate = (id, tenant = a) => run(tenant, (sql) => retention.recalculateMediaRetention(sql, tenant.tenantId, id));
async function asset(extra = {}, tenant = a) {
  const row = { id: randomUUID(), tenant_id: tenant.tenantId, bucket: 'TEST-ONLY', object_key: randomUUID(),
    media_type: 'photo', mime_type: 'image/png', status: 'active', retention_class: 'operational',
    retention_policy_version: 'v1', uploaded_at: '2024-01-31T10:15:30.123456Z', ...extra };
  await h.admin`INSERT INTO media_assets ${h.admin(row)}`;
  for (const field of ['uploaded_at','quarantined_at','retention_until','legal_hold_until']) {
    if (typeof row[field] === 'string') await h.admin.unsafe(
      `UPDATE media_assets SET ${field}=$1::text::timestamptz WHERE id=$2`,[row[field],row.id]);
  }
  return row.id;
}
async function session(id, extra = {}, tenant = a) {
  const row = { id: randomUUID(), tenant_id: tenant.tenantId, media_asset_id: id,
    idempotency_key: randomUUID(), status: 'pending', expected_size_bytes: 68,
    created_at: '2024-01-31T10:15:30.123456Z', expires_at: '2024-01-31T10:30:30.123456Z', ...extra };
  await h.admin`INSERT INTO upload_sessions ${h.admin(row)}`;
  if (typeof row.created_at === 'string') await h.admin`UPDATE upload_sessions
    SET created_at=${row.created_at}::text::timestamptz WHERE id=${row.id}`;
  return row;
}
async function order(status = 'delivered', closedAt = '2024-02-29T10:15:30.123456Z', tenant = a) {
  const p = await parent(tenant), id = randomUUID();
  // TEST-ONLY future terminal parent state; B05 creates no transition command.
  // Constraints/FKs remain enabled for every media source and runtime operation.
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role=replica`;
    await tx`UPDATE receptions SET status='closed',closed_at='2020-01-01T00:00:00Z' WHERE id=${p.reception}`;
    await tx`INSERT INTO service_orders(id,tenant_id,reception_id,vehicle_id,customer_id,order_number,
      created_by_membership_id,status,closed_at) VALUES (${id},${tenant.tenantId},${p.reception},${p.vehicle},${p.customer},
        ${BigInt('0x'+id.replaceAll('-','').slice(0,12))},${tenant.owner.membershipId},${status},
        ${['delivered','cancelled'].includes(status) ? closedAt : null}::text::timestamptz)`;
    await tx`INSERT INTO order_status_history(id,tenant_id,order_id,to_status,request_id)
      VALUES (${randomUUID()},${tenant.tenantId},${id},'reception',${randomUUID()})`;
  });
  return { ...p, id };
}
async function link(id, o, kind = 'reception_media', tenant = a) {
  const tx = h.admin, linked = randomUUID();
  // Historical/future retention inventory fixtures deliberately bypass INSERT
  // lifecycle guards as superuser only. Canonical purpose CHECKs remain on; runtime FK coverage is separate.
  // Phase-B runtime guard behavior has its own nonprivileged suite.
  if (kind === 'reception_media' || kind === 'damage_media') await h.admin.begin(async fixture => {
    await fixture`SET LOCAL session_replication_role=replica`;
    if (kind === 'reception_media') await fixture`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${o.reception},${id},'intake_evidence')`;
    else await fixture`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${o.damage},${id},'damage_evidence')`;
  });
  if (kind === 'finding_media') {
    const diagnostic = randomUUID();
    await tx`INSERT INTO diagnostics(id,tenant_id,order_id,diagnosed_by_membership_id)
      VALUES (${diagnostic},${tenant.tenantId},${o.id},${tenant.owner.membershipId})`;
    await tx`INSERT INTO findings(id,tenant_id,diagnostic_id,order_id,category,title,description)
      VALUES (${linked},${tenant.tenantId},${diagnostic},${o.id},'TEST','TEST','TEST')`;
    await tx`INSERT INTO finding_media(tenant_id,finding_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'work_activity_media') {
    await tx`INSERT INTO work_activities(id,tenant_id,order_id,service_order_item_id,title)
      VALUES (${linked},${tenant.tenantId},${o.id},${o.item ?? null},'TEST')`;
    await tx`INSERT INTO work_activity_media(tenant_id,work_activity_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'quality_check_media') {
    await tx`INSERT INTO assignments(id,tenant_id,order_id,membership_id,assignment_type,assigned_by_membership_id)
      VALUES (${randomUUID()},${tenant.tenantId},${o.id},${tenant.owner.membershipId},'quality_control',${tenant.owner.membershipId})`;
    await tx`INSERT INTO quality_checks(id,tenant_id,order_id,checked_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${o.id},${tenant.owner.membershipId})`;
    await tx`INSERT INTO quality_check_media(tenant_id,quality_check_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'delivery_media') {
    await tx`INSERT INTO deliveries(id,tenant_id,order_id,status,delivered_at,delivered_to_name,delivered_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${o.id},${o.pending ? 'pending' : 'completed'},
        ${o.pending ? null : '2024-02-29T10:15:30.123456Z'}::text::timestamptz,
        ${o.pending ? null : 'TEST'},${o.pending ? null : tenant.owner.membershipId})`;
    await tx`INSERT INTO delivery_media(tenant_id,delivery_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  if (kind === 'quote_media') {
    const quote = randomUUID();
    await tx`INSERT INTO quotes(id,tenant_id,order_id,quote_type,created_by_membership_id)
      VALUES (${quote},${tenant.tenantId},${o.id},'initial',${tenant.owner.membershipId})`;
    await tx`INSERT INTO quote_versions(id,tenant_id,quote_id,order_id,version_number,subtotal_amount,total_amount,created_by_membership_id)
      VALUES (${linked},${tenant.tenantId},${quote},${o.id},1,0,0,${tenant.owner.membershipId})`;
    await tx`INSERT INTO quote_media(tenant_id,quote_version_id,media_asset_id,purpose)
      VALUES (${tenant.tenantId},${linked},${id},'TEST-ONLY')`;
  }
  return linked;
}
async function warranty(o, expires = '2026-01-31T10:15:30.123456Z', tenant = a) {
  const id = randomUUID();
  await h.admin`INSERT INTO service_order_items(id,tenant_id,order_id,sales_originator_membership_id,
    item_type,name_snapshot,quantity_authorized,unit_price,source,created_by_membership_id,warranty_origin,warranty_expires_at)
    VALUES (${id},${tenant.tenantId},${o.id},${tenant.owner.membershipId},'labor','TEST',1,0,'other',
      ${tenant.owner.membershipId},'catalog_default',${expires}::text::timestamptz)`;
  return id;
}
async function privacy(id, tenant = a) {
  const customer = await h.seedCustomer(tenant.tenantId), consent = randomUUID();
  await h.admin`INSERT INTO privacy_consents(id,tenant_id,customer_id,purpose_code,privacy_notice_version,
    authorization_text_version,authorization_text_hash,controller_notice_snapshot,channel,captured_at,evidence_media_id)
    VALUES (${consent},${tenant.tenantId},${customer.id},'service_provision','TEST','TEST',${'f'.repeat(64)},
      ${h.admin.json({legalName:'TEST',address:'TEST',phone:'+5700000000',email:null,rightsChannel:'TEST'})},
      'in_person','2020-01-01T00:00:00Z',${id})`;
  return consent;
}
const row = async (id) => (await h.admin`SELECT * FROM media_assets WHERE id=${id}`)[0];
const audits = (id) => h.admin`SELECT * FROM audit_logs WHERE entity_id=${id} AND action='media.retention_updated'`;

test('pending cleanup is created_at + 24h, independent of class and 15-minute expiry', async () => {
  const id = await asset({ status:'pending_upload', uploaded_at:null });
  const s = await session(id);
  const d = await recalculate(id);
  assert.equal(d.knownRetentionUntil,'2024-02-01T10:15:30.123456Z');
  assert.equal(d.eligibility,'ELIGIBLE_AFTER_DATE');
  const [stored] = await h.admin`SELECT expires_at FROM upload_sessions WHERE id=${s.id}`;
  assert.equal(stored.expires_at.toISOString(),'2024-01-31T10:30:30.123Z');
});
test('live pending upload blocks cleanup without extending capability', async () => {
  const id = await asset({status:'pending_upload',uploaded_at:null});
  await session(id,{created_at:new Date(),expires_at:new Date(Date.now()+900000)});
  const d = await evaluate(id); assert.ok(d.blockers.includes('ACTIVE_UPLOAD'));
  assert.equal(d.eligibility,'NOT_ELIGIBLE_ACTIVE_UPLOAD');
});
test('active unlinked uses uploaded_at + 30 UTC calendar days with microseconds', async () => {
  const id = await asset();
  const d = await recalculate(id); assert.equal(d.knownRetentionUntil,'2024-03-01T10:15:30.123456Z');
  assert.equal(d.eligibility,'ELIGIBLE_AFTER_DATE'); assert.equal(d.blocksAutomaticPurge,false);
});
test('unlinked signature and document use 30 days, not the client retention class', async () => {
  for (const media_type of ['signature','document','quote_pdf']) {
    const id=await asset({media_type,retention_class:media_type==='signature'?'authorization_evidence':'document'});
    assert.equal((await evaluate(id)).knownRetentionUntil,'2024-03-01T10:15:30.123456Z');
  }
});
test('active asset without authoritative uploaded_at remains unresolved', async () => {
  const id=await asset({uploaded_at:null}); const d=await recalculate(id);
  assert.equal(d.knownRetentionUntil,null); assert.equal(d.blocksAutomaticPurge,true); assert.deepEqual(d.blockers,['UNRESOLVED_PROTECTION']); assert.equal((await row(id)).retention_until,null);
});
test('completed binding remains protective while reception is open and starts no TTL', async () => {
  const p=await parent(a),id=await asset({status:'pending_upload'}); const s=await session(id);
  await h.admin`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,privacy_consent_id)
    VALUES (${a.tenantId},${s.id},${p.reception},${p.consent})`;
  await h.admin`UPDATE upload_sessions SET status='completed',completed_at=now() WHERE id=${s.id}`;
  await h.admin`UPDATE media_assets SET status='active' WHERE id=${id}`;
  const d=await recalculate(id); assert.equal(d.knownRetentionUntil,null); assert.ok(d.blockers.includes('UNRESOLVED_PROTECTION'));
  assert.equal((await row(id)).retention_until,null);
});
test('expired/failed binding does not override incomplete cleanup clock', async () => {
  const p=await parent(a),id=await asset({status:'pending_upload',uploaded_at:null}),s=await session(id);
  await h.admin`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,privacy_consent_id)
    VALUES (${a.tenantId},${s.id},${p.reception},${p.consent})`;
  const d=await evaluate(id); assert.equal(d.eligibility,'ELIGIBLE_AFTER_DATE');
  assert.equal(d.sources.some((s)=>s.kind==='upload_binding'),false);
});
test('quarantine uses its actual clock + 7 days', async () => {
  const id=await asset({status:'quarantined',quarantined_at:'2024-03-01T10:15:30.123456Z'});
  assert.equal((await recalculate(id)).knownRetentionUntil,'2024-03-08T10:15:30.123456Z');
});
test('historical quarantine without a timestamp is protected; no fabricated date', async () => {
  const id=await asset({status:'quarantined'}),d=await recalculate(id);
  assert.equal(d.knownRetentionUntil,null); assert.equal(d.blocksAutomaticPurge,true);
});
test('quarantine cannot shorten committed retention and active legal hold blocks', async () => {
  const id=await asset({status:'quarantined',quarantined_at:'2020-01-01T00:00:00Z',retention_until:'2035-01-01T00:00:00Z',legal_hold_until:'2036-01-01T00:00:00Z'});
  const d=await recalculate(id); assert.equal(d.knownRetentionUntil,'2035-01-01T00:00:00.000000Z');
  assert.equal(d.eligibility,'NOT_ELIGIBLE_LEGAL_HOLD'); assert.equal((await audits(id)).length,0);
});
for (const status of ['reception','in_progress','ready_for_delivery']) test(`nonterminal ${status}: no operational TTL`, async()=>{
  const id=await asset(),o=await order(status); await link(id,o);
  const d=await recalculate(id); assert.equal(d.knownRetentionUntil,null); assert.equal(d.eligibility,'NOT_ELIGIBLE_DOMAIN_LINK_NONTERMINAL');
});
for (const status of ['delivered','cancelled']) test(`terminal ${status} uses order closed_at + 12 calendar months`,async()=>{
  const id=await asset(),o=await order(status); await link(id,o);
  const d=await recalculate(id); assert.equal(d.knownRetentionUntil,'2025-02-28T10:15:30.123456Z');
});
for (const kind of ['damage_media','finding_media','work_activity_media','quality_check_media']) test(`${kind} resolves exact tenant order`,async()=>{
  const id=await asset(),o=await order(); await link(id,o,kind);
  assert.equal((await recalculate(id)).knownRetentionUntil,'2025-02-28T10:15:30.123456Z');
});
test('warranty exact work-activity item extends floor by 90 days; longest wins',async()=>{
  const id=await asset(),o=await order(); o.item=await warranty(o); await link(id,o,'work_activity_media');
  const d=await recalculate(id); assert.equal(d.knownRetentionUntil,'2026-05-01T10:15:30.123456Z');
  assert.ok(d.sources.some((s)=>s.kind==='warranty_item'&&s.id===o.item));
});
test('warranty shorter than operational floor loses',async()=>{
  const id=await asset(),o=await order(); o.item=await warranty(o,'2024-01-01T00:00:00Z'); await link(id,o,'work_activity_media');
  assert.equal((await recalculate(id)).knownRetentionUntil,'2025-02-28T10:15:30.123456Z');
});
test('warranty without expiry is protective; nonterminal order still blocks with known warranty',async()=>{
  for (const expires of [null,'2032-01-01T00:00:00Z']) {
    const id=await asset(),o=await order('in_progress');o.item=await warranty(o,expires);await link(id,o,'work_activity_media');
    const d=await recalculate(id); assert.ok(d.blockers.includes('DOMAIN_LINK_NONTERMINAL'));
    if(expires===null) assert.ok(d.blockers.includes('UNRESOLVED_PROTECTION'));
  }
});
test('warranty is not inferred from another item/order sharing a reception lineage',async()=>{
  const id=await asset(),o=await order(); await warranty(o,'2038-01-01T00:00:00Z');await link(id,o);
  const d=await recalculate(id);assert.equal(d.knownRetentionUntil,'2025-02-28T10:15:30.123456Z');
  assert.equal(d.sources.some((s)=>s.kind==='warranty_item'),false);
});
test('multiple known links choose later terminal date; existing later floor never shortens',async()=>{
  const id=await asset({retention_until:'2035-01-01T00:00:00Z'}),one=await order(),two=await order('cancelled','2030-01-31T00:00:00Z');
  await link(id,one);await link(id,two,'damage_media');
  const d=await recalculate(id);assert.equal(d.knownRetentionUntil,'2035-01-01T00:00:00.000000Z');
  assert.equal((await audits(id)).length,0);
});
test('multiple links without committed floor choose later, with nonterminal link still protective',async()=>{
  const id=await asset(),one=await order(),two=await order('cancelled','2030-01-31T00:00:00Z'),three=await order('in_progress');
  await link(id,one);await link(id,two,'damage_media');await link(id,three);
  const d=await recalculate(id);assert.equal(d.knownRetentionUntil,'2031-01-31T00:00:00.000000Z');
  assert.ok(d.blockers.includes('DOMAIN_LINK_NONTERMINAL'));
});
test('privacy evidence is protective with unresolved 36-month clock, no uploaded/captured surrogate',async()=>{
  const id=await asset();await privacy(id); const d=await recalculate(id);
  assert.equal(d.knownRetentionUntil,null);assert.equal(d.eligibility,'NOT_ELIGIBLE_UNRESOLVED_PROTECTION');
  assert.equal((await row(id)).retention_until,null);
});
test('signature signed_at is the 36-month clock, even while quarantined',async()=>{
  const p=await parent(a),id=await asset({media_type:'signature',retention_class:'authorization_evidence'});
  await h.admin`INSERT INTO signatures(id,tenant_id,reception_id,signature_media_id,signed_by_name,document_version,document_hash,signed_at)
    VALUES (${randomUUID()},${a.tenantId},${p.reception},${id},'TEST','TEST','TEST','2024-02-29T10:15:30.123456Z')`;
  await h.admin`UPDATE media_assets SET status='quarantined',quarantined_at='2024-03-01T00:00:00Z' WHERE id=${id}`;
  assert.equal((await recalculate(id)).knownRetentionUntil,'2027-02-28T10:15:30.123456Z');
});
test('delivery evidence uses completed delivered_at + 36 months; pending delivery clock not started',async()=>{
  for(const pending of [false,true]) {
    const id=await asset(),o=await order();o.pending=pending;await link(id,o,'delivery_media');
    const d=await recalculate(id);assert.equal(d.knownRetentionUntil,pending?null:'2027-02-28T10:15:30.123456Z');
    if(pending) { assert.deepEqual(d.blockers,['CLOCK_NOT_STARTED']);assert.equal(d.eligibility,'NOT_ELIGIBLE_CLOCK_NOT_STARTED'); }
  }
});
test('generic linked document and quote evidence clocks stay unresolved',async()=>{
  for(const kind of ['reception_media','quote_media']) {
    const id=await asset({media_type:'document',retention_class:'document'}),o=await order();await link(id,o,kind);
    const d=await recalculate(id);assert.equal(d.knownRetentionUntil,null);assert.ok(d.blockers.includes('UNRESOLVED_PROTECTION'));
  }
});
for(const future of [true,false]) test(`${future?'future':'expired'} legal hold reevaluates normal retention without lifecycle writes`,async()=>{
  const id=await asset({legal_hold_until:future?'2040-01-01T00:00:00Z':'2020-01-01T00:00:00Z'}),before=await row(id),d=await recalculate(id);
  assert.equal(d.eligibility,future?'NOT_ELIGIBLE_LEGAL_HOLD':'ELIGIBLE_AFTER_DATE');
  const after=await row(id);
  for(const field of ['status','deletion_requested_at','deleted_at','purged_at','legal_hold_until'])assert.deepEqual(after[field],before[field]);
});
test('hold plus unresolved privacy and expired known floor stays blocked',async()=>{
  const id=await asset({retention_until:'2020-01-01T00:00:00Z',legal_hold_until:'2040-01-01T00:00:00Z'});await privacy(id);
  const d=await recalculate(id);assert.ok(d.blockers.includes('LEGAL_HOLD'));assert.ok(d.blockers.includes('UNRESOLVED_PROTECTION'));
});
test('cross-tenant decisions, recalculation, order scope and direct FK influence are denied',async()=>{
  const id=await asset({},b),o=await order('delivered',undefined,b);await link(id,o,'reception_media',b);
  const before=await row(id);
  for(const fn of [retention.evaluateMediaRetention,retention.recalculateMediaRetention])
    await assert.rejects(run(a,(sql)=>fn(sql,a.tenantId,id)),(e)=>e.code==='MEDIA_ASSET_NOT_FOUND');
  await assert.rejects(run(a,(sql)=>retention.recalculateOrderMediaRetention(sql,a.tenantId,o.id)),(e)=>e.code==='SERVICE_ORDER_NOT_FOUND');
  const local=await asset();
  await assert.rejects(run(a,(sql)=>sql`INSERT INTO reception_media(tenant_id,reception_id,media_asset_id,purpose)
    VALUES (${a.tenantId},${o.reception},${local},'intake_evidence')`),(e)=>e.code==='23514'&&e.constraint_name==='media_association_parent_guard');
  assert.deepEqual(await row(id),before);assert.equal((await audits(id)).length,0);
});
const API_MEDIA_UPDATE_COLUMNS = ['status','size_bytes','checksum_sha256','uploaded_at',
  'quarantined_at','integrity_failure_code','updated_at','retention_until'];
for (const [role,pool] of [['tallermecario_api',h.apiPool],['tallermecario_worker',h.workerPool]]) {
  test(`${role}: exact column UPDATE matrix and forbidden raw mutations`,async()=>{
    const id=await asset({legal_hold_until:'2040-01-01T00:00:00Z',retention_policy_version:'historical-v0'}),before=await row(id);
    const columns=Object.keys(before);
    await h.asRuntime(pool,{tenantId:a.tenantId},async(sql)=>{
      const [identity]=await sql`SELECT current_user role,has_table_privilege(current_user,'public.media_assets','UPDATE') broad`;
      assert.equal(identity.role,role);assert.equal(identity.broad,false);
      for(const column of columns) {
        const [grant]=await sql`SELECT has_column_privilege(current_user,'public.media_assets',${column},'UPDATE') allowed`;
        assert.equal(grant.allowed,role==='tallermecario_api'&&API_MEDIA_UPDATE_COLUMNS.includes(column),column);
      }
    });
    for(const column of columns.filter(c=>role==='tallermecario_worker'||!API_MEDIA_UPDATE_COLUMNS.includes(c))) {
      await assert.rejects(h.asRuntime(pool,{tenantId:a.tenantId},sql=>sql.unsafe(
        `UPDATE public.media_assets SET ${column}=${column} WHERE tenant_id=$1 AND id=$2`,[a.tenantId,id])),e=>e.code==='42501');
    }
    assert.deepEqual(await row(id),before);assert.equal((await audits(id)).length,0);
  });
}
test('API retention monotonicity is DB enforced, including rejected transaction audit rollback',async()=>{
  const id=await asset();
  for(const date of ['2030-01-01','2040-01-01','2040-01-01']) {
    await run(a,sql=>sql`UPDATE media_assets SET retention_until=${date===null?null:date+"T00:00:00Z"}::text::timestamptz WHERE tenant_id=${a.tenantId} AND id=${id}`);
    assert.equal((await row(id)).retention_until.toISOString(),date+'T00:00:00.000Z');
  }
  const snapshot=await row(id);
  for(const date of ['2030-01-01',null]) {
    await assert.rejects(run(a,async(sql)=>{
      // If the subsequent forbidden decrease aborts, even an earlier audit rolls back.
      await sql`INSERT INTO audit_logs(id,tenant_id,actor_type,actor_user_id,actor_membership_id,
        action,outcome,entity_type,entity_id,request_id) VALUES(${randomUUID()},${a.tenantId},'user',
        ${a.owner.user.id},${a.owner.membershipId},'media.retention_updated','success','media_asset',${id},current_setting('app.request_id')::uuid)`;
      await sql`UPDATE media_assets SET retention_until=${date===null?null:date+"T00:00:00Z"}::text::timestamptz WHERE tenant_id=${a.tenantId} AND id=${id}`;
    }),e=>e.code==='23514'&&e.constraint_name==='media_assets_retention_monotonic_guard');
    assert.deepEqual(await row(id),snapshot);assert.equal((await audits(id)).length,0);
  }
});
test('API status grant cannot enter deleted lifecycle on unsigned media',async()=>{
  const id=await asset(),before=await row(id);
  await assert.rejects(run(a,sql=>sql`UPDATE media_assets SET status='deleted' WHERE tenant_id=${a.tenantId} AND id=${id}`),
    e=>e.code==='23514'&&e.constraint_name==='media_destructive_lifecycle_guard');
  assert.deepEqual(await row(id),before);
});
test('historical-v0 survives actual extension and no-op, including truthful audit version',async()=>{
  const id=await asset({retention_policy_version:'historical-v0'});
  await recalculate(id);const extended=await row(id);
  assert.equal(extended.retention_policy_version,'historical-v0');
  assert.equal(extended.retention_until.toISOString(),'2024-03-01T10:15:30.123Z');
  assert.equal((await audits(id))[0].after_json.retention_policy_version,'historical-v0');
  await recalculate(id);assert.deepEqual(await row(id),extended);assert.equal((await audits(id)).length,1);
});
test('recalculation writes one safe audit only on extension; preserves historical policy on no-op',async()=>{
  const id=await asset();await recalculate(id);const snapshot=await row(id);await recalculate(id);
  assert.deepEqual(await row(id),snapshot);const events=await audits(id);assert.equal(events.length,1);
  assert.deepEqual(events[0].after_json,{retention_until:'2024-03-01T10:15:30.123456Z',retention_policy_version:'v1'});
  assert.equal(JSON.stringify(events).includes(snapshot.object_key),false);
  const historical=await asset({retention_until:'2040-01-01T00:00:00Z',retention_policy_version:'historical'});
  await recalculate(historical);assert.equal((await row(historical)).retention_policy_version,'historical');
});
test('audit failure rolls back extension, with no partial retention commit',async()=>{
  const id=await asset(),snapshot=await row(id);
  await assert.rejects(h.asRuntime(h.apiPool,{tenantId:a.tenantId},(sql)=>retention.recalculateMediaRetention(sql,a.tenantId,id)));
  assert.deepEqual(await row(id),snapshot);assert.equal((await audits(id)).length,0);
});
async function blocked(pid) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const [r]=await h.admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))) waiting`;
    if(r.waiting)return;
    await new Promise((resolve)=>setTimeout(resolve,10));
  }
  assert.fail('expected PostgreSQL lock waiter');
}
test('real concurrent recalculations serialize; committed later extension wins over stale shorter source',async()=>{
  const id=await asset(),o=await order();await link(id,o);
  let release,locked;
  const gate=new Promise((resolve)=>{release=resolve;}),ready=new Promise((resolve)=>{locked=resolve;});
  const first=run(a,async(sql)=>{
    const token=await retention.lockMediaRetention(sql,a.tenantId,[id]);
    await sql`UPDATE service_orders SET closed_at='2035-01-31T00:00:00Z' WHERE tenant_id=${a.tenantId} AND id=${o.id}`;
    await retention.recalculateLockedMediaRetention(token,id);
    const [p]=await sql`SELECT pg_backend_pid() pid`;locked(p.pid);await gate;
  });
  const pid=await ready;
  const second=recalculate(id);
  try{await blocked(pid);}finally{release();}
  await Promise.all([first,second]);
  assert.equal((await evaluate(id)).knownRetentionUntil,'2036-01-31T00:00:00.000000Z');
  await h.admin`UPDATE service_orders SET closed_at='2024-01-31T00:00:00Z' WHERE id=${o.id}`;
  assert.equal((await recalculate(id)).knownRetentionUntil,'2036-01-31T00:00:00.000000Z');
  assert.equal((await audits(id)).length,1);
});
// First transaction holds its real row locks until pg_blocking_pids proves overlap.
async function overlap(firstOperation, secondOperation) {
  let release, ready, failed;
  const gate=new Promise(resolve=>{release=resolve;}),held=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
  const first=run(a,async(sql)=>{
    const result=await firstOperation(sql);
    const [p]=await sql`SELECT pg_backend_pid() pid`;ready(p.pid);await gate;return result;
  });
  first.catch(failed);
  const pid=await held;
  const second=run(a,secondOperation);second.catch(()=>undefined);
  try{await blocked(pid);}finally{release();}
  return Promise.allSettled([first,second]);
}
for(const longerFirst of [false,true]) test(`shorter/longer overlap: longer first=${longerFirst}`,async()=>{
  const id=await asset(),o=await order();await link(id,o);
  const extend=date=>async(sql)=>{
    const token=await retention.lockMediaRetention(sql,a.tenantId,[id]);
    await sql`UPDATE service_orders SET closed_at=${date}::text::timestamptz WHERE tenant_id=${a.tenantId} AND id=${o.id}`;
    return retention.recalculateLockedMediaRetention(token,id);
  };
  const results=await overlap(extend(longerFirst?'2035-01-31T00:00:00Z':'2030-01-31T00:00:00Z'),extend(longerFirst?'2030-01-31T00:00:00Z':'2035-01-31T00:00:00Z'));
  assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));
  assert.equal((await evaluate(id)).knownRetentionUntil,'2036-01-31T00:00:00.000000Z');
  assert.equal((await audits(id)).length,longerFirst?1:2);
});
const mediaService=h.load('media/service.js');
for(const quarantineFirst of [false,true]) test(`production quarantine/recalculation overlap: quarantine first=${quarantineFirst}`,async()=>{
  const id=await asset({media_type:'signature',retention_class:'authorization_evidence',status:'pending_upload',
    uploaded_at:null,retention_until:'2040-01-01T00:00:00Z'});
  const s=await session(id,{created_at:new Date(),expires_at:new Date(Date.now()+900000)});
  const plan=await run(a,sql=>mediaService.prepareUploadCompletion(sql,a.tenantId,s.id));
  const quarantine=sql=>mediaService.completeUploadSession(sql,a.tenantId,s.id,plan,
    {plan,sizeBytes:68,failure:'MEDIA_CONTENT_INVALID'},'a'.repeat(64));
  const recalc=sql=>retention.recalculateMediaRetention(sql,a.tenantId,id);
  const results=await overlap(quarantineFirst?quarantine:recalc,quarantineFirst?recalc:quarantine);
  assert.ok(results.every(r=>r.status==='fulfilled'),JSON.stringify(results));
  const stored=await row(id);assert.equal(stored.status,'quarantined');assert.equal(Number(stored.size_bytes),68);
  assert.equal(stored.checksum_sha256,'a'.repeat(64));assert.ok(stored.uploaded_at);assert.ok(stored.quarantined_at);
  assert.equal(stored.integrity_failure_code,'MEDIA_CONTENT_INVALID');assert.ok(stored.updated_at);
  assert.equal(stored.retention_until.toISOString(),'2040-01-01T00:00:00.000Z');
  assert.equal((await audits(id)).length,0);
  const [audit]=await h.admin`SELECT count(*)::int n FROM audit_logs WHERE entity_id=${id} AND action='media.quarantined'`;
  assert.equal(audit.n,1);
});
const {captureReceptionSignature}=h.load('receptions/signature.js');
const {RECEPTION_ACCEPTANCE_VERSION}=h.load('receptions/acceptance-document.js');
for(const signatureFirst of [false,true]) test(`production signature/recalculation overlap: signature first=${signatureFirst}`,async()=>{
  const id=await asset({media_type:'signature',retention_class:'authorization_evidence'}),p=await parent(a);
  const sign=async(sql)=>{
    const [meta]=await sql`SELECT current_setting('app.request_id') request_id`;
    return captureReceptionSignature({sql,tenant:{tenantId:a.tenantId,userId:a.owner.user.id,membershipId:a.owner.membershipId}},
      p.reception,{signatureMediaId:id,signedByName:'TEST',signedByDocument:null,documentVersion:RECEPTION_ACCEPTANCE_VERSION},
      {requestId:meta.request_id,ipAddress:'192.0.2.1'});
  };
  const recalc=sql=>retention.recalculateMediaRetention(sql,a.tenantId,id);
  const results=await overlap(signatureFirst?sign:recalc,signatureFirst?recalc:sign);
  assert.equal(results[0].status,'fulfilled');
  if(results[1].status==='rejected') {
    assert.equal(signatureFirst,true);assert.equal(results[1].reason.code,'MEDIA_ASSOCIATION_CONFLICT');
    await recalculate(id); // Whole transaction retry rereads the committed signature parent.
  }
  const [stored]=await h.admin`SELECT m.retention_until=((s.signed_at AT TIME ZONE 'UTC')+interval '36 months') AT TIME ZONE 'UTC' exact
    FROM media_assets m JOIN signatures s ON s.signature_media_id=m.id AND s.tenant_id=m.tenant_id WHERE m.id=${id}`;
  assert.equal(stored.exact,true);
  assert.ok((await evaluate(id)).sources.some(s=>s.kind==='signature'));
  const [audit]=await h.admin`SELECT count(*)::int n FROM audit_logs WHERE entity_id=${p.reception} AND action='reception.signed'`;
  assert.equal(audit.n,1);
  await assert.rejects(run(a,sql=>sql`UPDATE media_assets SET checksum_sha256='blocked' WHERE tenant_id=${a.tenantId} AND id=${id}`),
    e=>e.code==='23514'&&e.constraint_name==='signatures_media_guard');
});
test('order-terminal primitive computes full graph in the same transaction and no reception-close clock',async()=>{
  const o=await order('in_progress'),ids=[await asset(),await asset()];
  await link(ids[0],o);await link(ids[1],o,'damage_media');
  await run(a,async(sql)=>{
    const scope=await retention.lockOrderMediaRetention(sql,a.tenantId,o.id);
    assert.deepEqual(scope.assetIds,[...ids].sort());
    await sql`UPDATE service_orders SET status='cancelled',closed_at='2025-03-31T00:00:00Z' WHERE tenant_id=${a.tenantId} AND id=${o.id}`;
    for(const id of scope.assetIds)assert.equal((await retention.recalculateLockedMediaRetention(scope.lock,id)).knownRetentionUntil,'2026-03-31T00:00:00.000000Z');
  });
  const results=await run(a,(sql)=>retention.recalculateOrderMediaRetention(sql,a.tenantId,o.id));assert.equal(results.length,2);
});
test('lock proof cannot be fabricated or reused after commit',async()=>{
  const id=await asset();
  await assert.rejects(retention.evaluateLockedMediaRetention({},id),/MEDIA_RETENTION_LOCK_REQUIRED/);
  const conn=await h.apiPool.reserve();
  try {
    await conn`BEGIN`;
    await conn`SELECT set_config('app.tenant_id',${a.tenantId},true)`;
    const token=await retention.lockMediaRetention(conn,a.tenantId,[id]);
    await conn`COMMIT`;
    await conn`BEGIN`;
    await assert.rejects(retention.evaluateLockedMediaRetention(token,id),/MEDIA_RETENTION_TRANSACTION_MISMATCH/);
    await conn`ROLLBACK`;
  }finally{conn.release();}
});
test('new parent committed during discovery causes retry, never an asset-to-parent lock',async()=>{
  const id=await asset(),one=await order(),two=await order();await link(id,one);
  const holder=await h.admin.reserve();let pending;
  try {
    await holder`BEGIN`;
    await holder`SELECT id FROM receptions WHERE id=${one.reception} FOR NO KEY UPDATE`;
    const [p]=await holder`SELECT pg_backend_pid() pid`;
    pending=recalculate(id);pending.catch(()=>undefined);
    await blocked(p.pid);
    await link(id,two,'damage_media');
    await holder`COMMIT`;
    await assert.rejects(pending,(e)=>e.code==='MEDIA_ASSOCIATION_CONFLICT');
    assert.equal((await row(id)).retention_until,null);assert.equal((await audits(id)).length,0);
  }finally{await holder`ROLLBACK`.catch(()=>undefined);holder.release();}
  assert.equal((await recalculate(id)).knownRetentionUntil,'2025-02-28T10:15:30.123456Z');
});
test('UTC calendar decisions do not depend on session timezone or daylight-saving rules',async()=>{
  const id=await asset({uploaded_at:'2024-03-01T12:00:00.999999Z'});
  const decisions=[];
  for(const zone of ['UTC','America/New_York','America/Bogota'])decisions.push(await run(a,async(sql)=>{
    await sql`SELECT set_config('TimeZone',${zone},true)`;
    return retention.evaluateMediaRetention(sql,a.tenantId,id);
  }));
  for(const d of decisions)assert.equal(d.knownRetentionUntil,'2024-03-31T12:00:00.999999Z');
});
test('future retention is not eligible; expired hold cannot bypass a future committed floor',async()=>{
  const id=await asset({retention_until:'2040-01-01T00:00:00Z',legal_hold_until:'2020-01-01T00:00:00Z'}),d=await evaluate(id);
  assert.equal(d.eligibility,'NOT_ELIGIBLE_RETENTION_NOT_EXPIRED');assert.equal(d.blocksAutomaticPurge,true);
});
test('quarantine with a nonterminal domain or unresolved evidence never becomes age-only eligible',async()=>{
  const id=await asset({status:'quarantined',quarantined_at:'2020-01-01T00:00:00Z'}),o=await order('in_progress');await link(id,o);
  const d=await evaluate(id);assert.equal(d.knownRetentionUntil,'2020-01-08T00:00:00.000000Z');
  assert.ok(d.blockers.includes('DOMAIN_LINK_NONTERMINAL'));assert.equal(d.blocksAutomaticPurge,true);
});
test('deleted lifecycle is never an automatic eligibility authorization',async()=>{
  const id=await asset({retention_until:'2020-01-01T00:00:00Z'});
  await h.admin.begin(async tx=>{await tx`SET LOCAL session_replication_role=replica`;await tx`UPDATE media_assets SET status='deleted' WHERE id=${id}`;});
  const before=await row(id),d=await evaluate(id);
  assert.equal(d.eligibility,'NOT_ELIGIBLE_LIFECYCLE_UNAVAILABLE');assert.deepEqual(await row(id),before);
});
test('foreign warranty item cannot enter a local activity retention lineage',async()=>{
  const local=await order(),foreign=await order('delivered',undefined,b),item=await warranty(foreign,'2040-01-01T00:00:00Z',b);
  await assert.rejects(run(a,(sql)=>sql`INSERT INTO work_activities(id,tenant_id,order_id,service_order_item_id,title)
    VALUES (${randomUUID()},${a.tenantId},${local.id},${item},'TEST')`),(e)=>e.code==='23503');
});
test('future damage attach can reserve its server-resolved parent before association and recalculate atomically',async()=>{
  const id=await asset({status:'pending_upload'}),p=await parent(a),us=await session(id,{expires_at:'2040-01-01T00:00:00Z'});
  await h.admin`INSERT INTO media_upload_bindings(tenant_id,upload_session_id,reception_id,damage_id,privacy_consent_id)
    VALUES(${a.tenantId},${us.id},${p.reception},${p.damage},${p.consent})`;
  await h.admin`UPDATE upload_sessions SET status='completed',completed_at=now() WHERE id=${us.id}`;
  await h.admin`UPDATE media_assets SET status='active' WHERE id=${id}`;
  await run(a,async(sql)=>{
    const token=await retention.lockMediaRetention(sql,a.tenantId,[id],{damageIds:[p.damage]});
    await sql`INSERT INTO damage_media(tenant_id,damage_id,media_asset_id,purpose)
      VALUES (${a.tenantId},${p.damage},${id},'damage_evidence')`;
    const d=await retention.recalculateLockedMediaRetention(token,id);
    assert.equal(d.knownRetentionUntil,null);assert.ok(d.blockers.includes('CLOCK_NOT_STARTED'));
  });
  assert.equal((await row(id)).retention_until,null);
});

for(const kind of ['reception_media','damage_media']) test(`${kind} without an order waits for canonical clock`,async()=>{
  const id=await asset(),p=await parent(a);await link(id,p,kind);
  const d=await recalculate(id);assert.equal(d.knownRetentionUntil,null);
  assert.deepEqual(d.blockers,['CLOCK_NOT_STARTED']);assert.equal(d.eligibility,'NOT_ELIGIBLE_CLOCK_NOT_STARTED');
});

test('missing incomplete session remains unresolved, rather than a clock waiting to start',async()=>{
  const id=await asset({status:'pending_upload',uploaded_at:null}),d=await evaluate(id);
  assert.deepEqual(d.blockers,['UNRESOLVED_PROTECTION']);assert.equal(d.eligibility,'NOT_ELIGIBLE_UNRESOLVED_PROTECTION');
});
