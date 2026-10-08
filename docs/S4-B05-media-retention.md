# S4-B05 — Media retention and legal hold semantics

Backend infrastructure implementing [B01 §10/11](S4-B01-media-contract.md),
[B04 Phase A](S4-B04-media-associations.md), the exported operations/ERD/privacy
baseline and the supplied B05 contract. No new HTTP route, permission, association
purpose, order-transition command or deletion operation. No commit/push.

## Product clocks

These are product defaults, not universal legal requirements. Calculations use
PostgreSQL UTC calendar arithmetic, month-end clamping and full microsecond
precision; session timezone and client capturedAt never determine retention.

| Proven source | Known floor |
| --- | --- |
| Incomplete pending/uploaded asset | Each noncompleted session.created_at + **24 hours**, independent of retention_class; live pending capabilities additionally block cleanup. No change to expires_at or signed PUT lifetime. |
| Active genuinely unlinked asset, including unsigned signature/document/PDF | uploaded_at + **30 calendar days** |
| Quarantine | quarantined_at + **7 calendar days**, combined with stronger known commitments/protections; missing historical timestamp remains unresolved. |
| Operational photo/video/video360 | Exact linked service_order.closed_at + **12 calendar months**, only when status is delivered/cancelled. The schema CHECK binds closed_at to those terminal states; neither reception close nor history/upload/binding/link creation supplies this clock. |
| Exact warranty item evidence | max(operational floor, service_order_items.warranty_expires_at + **90 calendar days**). work_activity_media → work_activities.service_order_item_id/order_id is the provable composite-FK lineage. An unrelated warranty item, same vehicle/customer/reception or a retention-class label does not prove it. Warranty origin with no expiry remains protective. |
| Signature evidence | signatures.signed_at + **36 calendar months**, for its exact signing event |
| Delivery evidence | Completed delivery.delivered_at + **36 calendar months**; pending delivery is CLOCK_NOT_STARTED. |
| Privacy-consent evidence | **36-month baseline; exact clock RESERVED/UNRESOLVED**. No captured_at/created_at/revoked_at/uploaded_at surrogate. |
| quote_media or generic linked document | Protective/unresolved; authorization/version timestamps do not establish the reserved event clock. |

Operational lineage resolves reception_media/reception/service_order,
damage_media/damage/reception/service_order, finding_media/finding/order,
work_activity_media/activity/order and quality_check_media/check/order. All joins
include tenant identity, and all nine B01 references plus media_upload_bindings
are inventoried. Future schema references must extend this inventory before use.
No order yet is CLOCK_NOT_STARTED; an existing nonterminal order has the distinct
DOMAIN_LINK_NONTERMINAL blocker. Its TTL has not started even if another obligation
already has a known floor. A class/type alone never proves a business link.

## Decision and persistence

`src/media/retention.ts` returns knownRetentionUntil, blocksAutomaticPurge,
blockers, sources, policyVersion and eligibility. NULL never means eligible.
CLOCK_NOT_STARTED means a defined canonical event has not occurred: operational
reception/damage media without an order, or pending delivery. DOMAIN_LINK_NONTERMINAL
means an existing order has not reached delivered/cancelled. UNRESOLVED_PROTECTION
means the exact policy clock is reserved (privacy/quote/document), a mandatory
historical timestamp is corrupt/missing, or expected incomplete-upload evidence
is unexpectedly absent. These categories remain protective independently.
A known floor may coexist with any of these blockers or a legal hold. Eligibility
requires every protection cleared and the longest known date reached; results are
internal and expose no public blocker/incident details.

Known obligations take MAX, including existing committed retention_until.
Recalculation writes only a known extension through GREATEST under the asset lock;
it never clears/shortens a date. UTC strings preserve PostgreSQL microseconds.
New media uses canonical **v1**. Recalculation never writes retention_policy_version;
actual extensions and no-ops both preserve historical versions. Extension audits
record the row's real version, including historical-v0. No date backfill occurs.
Migration **0027** revokes broad UPDATE for API/worker, grants the API only status,
size_bytes, checksum_sha256, uploaded_at, quarantined_at, integrity_failure_code,
updated_at (completion/quarantine in service.ts) and retention_until (retention.ts).
Production worker code has no media writes and receives no column UPDATE grants.
The schema-owner-owned SECURITY INVOKER monotonic trigger rejects date → NULL or
earlier date with 23514/media_assets_retention_monotonic_guard. NULL → date,
same date and date → later remain allowed. RLS ENABLE/FORCE and the existing
media_signed_active_trg are preserved. No table layout/data/history rewrite occurs.

Completion/quarantine persist their applicable floors atomically with session/
asset state and include only before/after retention facts in the existing
media.upload_completed/media.quarantined audit. Replay emits no second event.
Reception signature capture commits its floor and media.retention_updated audit
with the signature and reception.signed event. Standalone domain recalculation
emits media.retention_updated only for a persisted date change; an audit failure
rolls back the change. No buckets, keys, URLs, notes, bodies or PII are included.

## Locks and integration protocol

Use an open READ COMMITTED transaction bound to the verified TenantContext. The
caller owns COMMIT/ROLLBACK and prior business authorization. The current
recalculation audit uses the API's verified actor/request GUCs; B06's dedicated
worker needs its separately approved audit/privilege path.

Before taking session/media locks, call `lockMediaRetention` for the complete
asset set and any server-authorized incoming reception/damage/order IDs. Sorted tiers:
receptions FOR NO KEY UPDATE → damages FOR SHARE → service orders FOR NO KEY UPDATE
→ upload sessions FOR UPDATE → media assets FOR UPDATE. B04's initial consent
lock stays before sessions/assets. Ordinary completion and signatures share this
protocol. The returned opaque proof is connection/transaction-bound.

After locks, lineage/session inventory is reread. A new parent/session outside the
locked set returns MEDIA_ASSOCIATION_CONFLICT: rollback and retry the **whole**
transaction, never acquire reception after asset. Future association, warranty,
hold and B06 commands must share these locks and preserve lineage under them.
Privileged writers bypassing this protocol cannot be made safe by one snapshot.

`evaluateMediaRetention` performs a locked decision; `recalculateMediaRetention`
adds persistence/audit. For B04 Phase B: lock authorized parent graph, attach, then
`recalculateLockedMediaRetention` before committing. PURPOSE_CATALOG_UNRESOLVED
remains; no attach/gallery/reorder route is enabled.

For a future terminal command, call `lockOrderMediaRetention` **before** changing
order state, then mutate status/closed_at and recalculate its returned asset IDs
under the same proof. This discovers the complete order graph, locks sorted
parents/assets and detects newly introduced assets before proceeding.
`recalculateOrderMediaRetention` supports an already-terminal order in a fresh
transaction. There is no current delivered/cancelled runtime command to wire.

## Binding, holds and B06

A B04 binding starts no 12/36-month clock. Pending v1 binding with an unexpired
session/open eligible reception, or completed active binding with its still-open
eligible reception, is protective in-progress authorization evidence. Historical
consent lineage is checked; later revocation alone does not invalidate it. Failed/
expired capabilities and closed receptions cannot finish this operation and their
binding alone is not a perpetual hold. Quarantined failed uploads use the 7-day
floor, unless another real source/hold/committed floor protects them.

**B04_BINDING_RELEASE_PENDING_PHASE_B**: a completed active asset with an eligible
open reception and no final association remains protected temporarily, potentially indefinitely
while the reception stays open. Pending valid sessions protect; failed/expired
sessions stop independent binding protection, and closed/ineligible receptions
stop in-progress protection under current evaluator rules. Phase B must create
canonical reception_media/damage_media and recalculate retention atomically;
the canonical final link must then become authoritative and binding must no longer
serve as an indefinite substitute. B05 deliberately retains its fail-safe evaluator;
this release and Phase B associations are not implemented. PURPOSE_CATALOG_UNRESOLVED
still blocks public attach/gallery/reorder; no purpose is fabricated.

legal_hold_until > current PostgreSQL clock blocks automatic purge, including
when retention is expired. Expiry requires all ordinary rules to be reevaluated;
it never clears a committed floor or deletes an object.
**LEGAL_HOLD_MUTATION_COMMAND_UNRESOLVED**: no canonical permission/command found;
no setter/clearer endpoint or implicit owner/admin hold authority.
**EXTERNAL_HOLD_LINKAGE_UNRESOLVED**: DSR/incidents lack a media-specific FK. No
blanket tenant incident/DSR hold and no inference from text/customer identity;
only explicit media-level legal hold and real protective references are evaluated.

Normal API/worker cannot UPDATE legal_hold_until, deletion_requested_at, deleted_at,
purged_at, delete_reason, retention_policy_version or media identity columns.
The API's necessary status grant cannot introduce status=deleted: the separate
0027 SECURITY INVOKER guard rejects that transition with
23514/media_assets_delete_lifecycle_unavailable_guard, including unsigned assets.
A future approved B06 actor requires a reviewed migration; none is introduced.

B06 must reevaluate under this protocol immediately before its destructive
transition, and design durable coordination across PostgreSQL/R2 as required by
B01 §11. A decision returned after COMMIT is not a delete capability. B05 writes
none of deletion_requested_at/deleted_at/purged_at and performs no R2 DELETE,
credential/lifecycle mutation or physical cleanup. Existing deletion markers
produce NOT_ELIGIBLE_LIFECYCLE_UNAVAILABLE for automatic eligibility.

## Verification

`tests/media-api/retention.test.cjs` runs automatically through the existing
`npm run test:media:api:ci` in normal CI validate. Real PostgreSQL runtime logins
exercise product clocks, inventory, warranty proof, unresolved blockers, expired/
future holds, cross-tenant FKs/RLS, exact raw API/worker column privileges, DB
monotonic rejection/audit rollback, historical version preservation, sorted locks,
deterministic PostgreSQL overlap barriers for quarantine/signature/recalculation
and both longer-floor orderings, changing lineage and transaction proof expiry.
Existing media/reception suites verify completion, checksum, quarantine, replay,
binding and signature compatibility. Migration coverage now includes fresh through
0027, 0026→0027 with historical-v0/later floor/future hold and signature/session/
binding/audit preservation, and framework rerun. Ledger: **28 entries**.

All review-fix validation is recorded in the final S4-B05 Review Fix Report.
Nothing is committed or pushed. Temporary DBs/logins and test infrastructure are
cleaned up after validation. This local staging drill is implementation evidence,
not real staging certification.
