# S4-B04 — Operational upload binding and reception/damage associations

Implemented against [B01 §§3–6/12.1](S4-B01-media-contract.md),
[B02](S4-B02-media-integrity.md), [B03](S4-B03-media-idempotency.md), the
[reception contract](api/reception-contract.md), and the user-supplied Phase A
contract. Baseline: `task/s4-b04-media-associations`, clean,
`4a91680a777e745cda5e8d3456017e5718ec3502`. Backend only; no commit or push.

## Wire and initial authorization

`POST /api/v1/media/upload-sessions` requires `operationalContext` for `photo`,
`video`, `video360`, with `retentionClass=operational`:

- `{ "type": "reception", "receptionId": "uuid" }`
- `{ "type": "damage", "damageId": "uuid" }`

It must be absent for `signature`, `quote_pdf`, `document`. Both objects and the
body reject extra properties. No client tenant/customer/order/consent/purpose or
authorization timestamp. Structural errors: `400 REQUEST_VALIDATION_FAILED`.
Damage permits photo, video and video360. The supplied Phase B canonical decision
supersedes the earlier accidental video360 exclusion in Phase A/B01.
Existing MIME, size, write-once PUT and URL lifetime rules are preserved.

The authenticated TenantContext and current tenant-wide `media.upload` permission
precede lookup. Reception and damage are resolved in that tenant; damage resolves
its parent server-side. Missing/foreign targets give indistinguishable
`RECEPTION_NOT_FOUND`/`DAMAGE_NOT_FOUND`; a non-open reception gives
`RECEPTION_NOT_EDITABLE`. The reception's exact consent must belong to its
customer, have `purpose_code=service_provision`, be granted/unrevoked and have a
server creation time no later than authorization. Ineligible initial consent:
`PRIVACY_CONSENT_NOT_ELIGIBLE`. `capturedAt` never authorizes an operation.

## Durable evidence and migration 0026

`media_upload_bindings`: tenant_id, upload_session_id (composite PK), reception_id,
nullable damage_id, privacy_consent_id, authorized_at, created_at. Composite FKs
reference the tenant's session, consent, reception/exact consent, and damage/exact
reception. New UNIQUE lineage keys on receptions and vehicle_damages support these
FKs. All deletion/update actions are NO ACTION; indexes cover parent/consent
lookups. No domain-purpose column or association is invented.

An INSERT-only SECURITY INVOKER trigger repeats initial parent/consent/type
eligibility under reception → damage → consent locks and sets both evidence
clocks from `clock_timestamp()` after authorization. FORCE RLS and tenant
SELECT/INSERT policies apply. API has INSERT/SELECT only: no UPDATE, DELETE or
TRUNCATE. Worker has no binding-table access; no new BYPASSRLS or SECURITY DEFINER.
B06 must review dedicated cleanup privileges rather than remove this evidence
through normal API mutations.

Fresh install, B02 legacy upgrade, current-main 0025→0026 and migration-runner
rerun are covered by `test:media:upgrade:ci`. Existing media_assets, upload_sessions,
receptions, privacy_consents, vehicle_damages and audit_logs are preserved exactly
on the B04 upgrade. No historical binding, consent authorization or clock backfill.

## Replay, completion and coordination

The B03 semantic payload includes context type and target identity. UUID spellings
canonicalize; a changed target/type returns `IDEMPOTENCY_PAYLOAD_MISMATCH` without
retargeting. Equivalent create shares IDs/key/expiry and one creation audit, also
under contention. Audit context contains safe IDs only, without capabilities,
object keys, bucket, customer/vehicle data or raw privacy evidence.

Replay and completion validate the persisted binding, exact reception/consent and
damage lineage, historical initial evidence, current tenant/RBAC and open parent.
**Later consent revocation does not invalidate that same authorized operation.**
A different new operation still needs current granted/unrevoked consent. Reception
closure blocks create replay and completion with `RECEPTION_NOT_EDITABLE`.

Lock ordering:

- New create: advisory idempotency key → reception FOR NO KEY UPDATE → damage
  FOR SHARE if present → consent FOR SHARE → new session/asset/binding.
- Create replay: advisory key → bound reception → damage → session → asset;
  no current-consent-state check.
- Complete Phase A: unlocked tenant reads and binding/lifecycle checks; release
  transaction. Phase B: bounded R2 inspection. Phase C: reauthenticate membership,
  revalidate RBAC/context → reception → damage → session → asset, then commit.

Discovery reads take no child/media locks before the parent. Trigger re-locks are
reentrant. Parent locks serialize close; initial consent FOR SHARE serializes
revocation. Deterministic PostgreSQL barriers test both winners. No R2 network I/O
under DB locks. Closure already visible in Phase A causes zero HEAD/Range calls;
closure during R2 is checked again in Phase C. Binding identity is compared across
phases, including completed replay. B02 integrity and B03 checksum replay/audit
semantics remain unchanged.

## Phase B — implemented

Implemented on `task/s4-b04-phase-b-associations`, base
`03a3af33667d1fe627bc6943b6a6c115a2f90869`, against the user-supplied Phase B
canonical decision (2026-10-08). No direct Notion access. The complete Diccionario
03/ADR-003 exports remain absent locally; the supplied decision resolves only
this MVP catalogue. **PURPOSE_CATALOG_UNRESOLVED is closed for reception_media and
damage_media only**; future link families remain reserved.

| Target | Server-owned purpose | Operational types |
| --- | --- | --- |
| reception_media | `intake_evidence`: general vehicle-condition evidence at intake | photo, video, video360 |
| damage_media | `damage_evidence`: evidence for a recorded damage | photo, video, video360 |

Purpose expresses business semantics, never MIME/file format. **Damage + video360
is valid**, including new binding, completion, attach and direct runtime INSERT.
No aliases/free text/custom purposes or second purpose per target are exposed.

### Attach and list API

| Method | Route | Permission | Response |
| --- | --- | --- | --- |
| POST | `/api/v1/receptions/:receptionId/media` | media.upload, tenant | 201 `{ media: MediaDto }` |
| GET | `/api/v1/receptions/:receptionId/media` | media.read, tenant | 200 `{ media: MediaDto[] }` |
| POST | `/api/v1/receptions/:receptionId/damages/:damageId/media` | media.upload, tenant | 201 `{ media: MediaDto }` |
| GET | `/api/v1/receptions/:receptionId/damages/:damageId/media` | media.read, tenant | 200 `{ media: MediaDto[] }` |

POST requires JSON `{ "mediaAssetId": "uuid", "sortOrder": 0 }`; sortOrder is
optional/default 0, integer 0…2147483647, ties allowed. Additional properties are
rejected: no client purpose, tenant, consent, session, retention or authorization
clock. UUIDs canonicalize to lowercase; malformed route IDs use anti-enumeration
404. No query parameters/pagination. Bodies ≤2 KiB. Business replies use no-store.

MediaDto contains exactly mediaAssetId, mediaType, mimeType, sizeBytes (number or
null), capturedAt, uploadedAt (UTC microsecond strings or null), purpose and
sortOrder. No bucket/key/checksum/URL/hold/retention blockers. The existing signed
`GET /api/v1/media/:id/download-url` remains the download path and checks active,
tenant and all deletion markers.

Owner/admin/service_advisor use current tenant-wide media permissions.
**B07 assigned technician remains deferred/fail-closed**, even when a technician
knows a valid target/media ID. Reads allow historical/closed parents; they do not
require the reception to remain open. Damage routes additionally verify the
route reception is the damage's actual tenant-scoped parent.

### Invariants and replay

Attach requires an open tenant reception, or tenant damage with that exact open
reception; foreign/missing targets are indistinguishable 404. Closed targets give
409 RECEPTION_NOT_EDITABLE. Asset must be tenant-owned, active, operational,
photo/video/video360, with no deletion_requested_at/deleted_at/purged_at. Other
lifecycle/type/class combinations give 409 MEDIA_ASSET_NOT_ELIGIBLE; foreign/missing
assets give 404 MEDIA_ASSET_NOT_FOUND. No implicit reactivation.

All asset sessions are examined in deterministic ID order. Each must be completed
with completed_at and durable valid Phase-A evidence matching exactly the incoming
reception with damage_id NULL, or incoming damage and its actual reception.
Equivalent multiple proofs are valid; missing/unbound/conflicting/pending/failed/
expired evidence gives 409 MEDIA_ASSOCIATION_CONTEXT_MISMATCH. No arbitrary
session selection or retargeting. Initial consent authorization is revalidated
historically; a later revocation does not invalidate the same authorized operation.

Natural link identity remains `(tenant_id,target_id,media_asset_id,purpose)`.
Same identity and sort returns the persisted 201 body without another row, audit
or recalculation. Different sort gives 409 MEDIA_ASSOCIATION_CONFLICT; no UPDATE,
implicit reorder or deletion command. Reads always order exactly by
`sort_order ASC, media_asset_id ASC, purpose ASC`, including ties.

### Locks, retention transition and auditing

First attach uses one verified transaction: validate/discover target →
`lockMediaRetention` with incoming reception/damage → repeat lifecycle/binding
validation → INSERT → `recalculateLockedMediaRetention` → safe audit → commit.
Global sorted lock tiers: reception → damage → service order → every upload
session → media asset. Existing reception orders enter the graph before asset
locks, including when discovered only through a binding. A new order/parent/session
appearing during discovery rolls back and retries the **whole** request transaction
(up to 3 attempts) with fresh identity/membership/RBAC/GUCs; business conflicts do
not retry. No late parent locks. No R2 I/O occurs in attach transactions.

Attach and close serialize on the reception. Close wins: 409/no link or association
audit. Attach wins: link/retention/audit commit together before close proceeds.
An insert, retention or audit failure rolls back all effects.

Completed active binding without a matching final association temporarily retains
UNRESOLVED_PROTECTION while its parent is eligible/open. After matching canonical
association, the binding remains durable authorization history but **stops adding
an independent unresolved blocker**. Pending valid binding still protects; failed/
expired binding does not. The final association becomes the domain source:
no order → CLOCK_NOT_STARTED; nonterminal order → DOMAIN_LINK_NONTERMINAL;
delivered/cancelled → order.closed_at + 12 UTC calendar months. Association,
upload, authorization and reception-close dates never start that clock. Known
floors extend atomically; committed floors, historical policy versions, privacy
protection and legal holds remain preserved.

First successful attach emits exactly one `media.associated`, entity media_asset,
metadata only `{target_type,target_id,purpose,sort_order}`. Replay emits none.
A real retention extension may also emit the existing `media.retention_updated`;
no extension means no retention audit. Storage keys/capabilities and customer/
vehicle/damage/consent content never enter association metadata.

### Migration 0028 and privileges

Existing tables/PKs/tenant FKs/indexes remain; no polymorphic link, new association
table or historical backfill. Purpose CHECKs constrain reception_media to
intake_evidence and damage_media to damage_evidence. Under exclusive table locks,
owner-only temporary SELECT policies let the preflight inspect all tenant history
while **FORCE RLS remains enabled**. They are removed in the same migration
transaction; incompatible purposes abort with 23514 and the corresponding
`*_purpose_preflight` identifier, without coercion/data/ledger changes.

A narrow schema-owner-owned **SECURITY INVOKER**, fixed search_path=pg_catalog
INSERT guard checks parent/lineage, purpose/sort, asset lifecycle/class/type/markers
and all completed matching binding evidence under the global lock order.
Failures use stable 23514 constraint identifiers. 0028 replaces the Phase-A binding
function solely to remove the accidental damage-video360 restriction; 0026 is
unchanged. No SECURITY DEFINER, BYPASSRLS or relaxed tenant predicates.

API has SELECT/INSERT only in both association tables; UPDATE/DELETE/TRUNCATE are
revoked. Worker has no access, including SELECT: current production worker has no
association read/write path. Tenant policies are explicitly API-only SELECT/INSERT,
with no UPDATE policy. Sprint-0's global policy and privilege gate pins this matrix.

### Verification and deferrals

Phase-B HTTP/direct runtime SQL tests, all six type/target combinations, replay,
ties, RBAC, cross-tenant, fail-safe historical evidence, atomic rollback and real
PostgreSQL lock/audit barriers run automatically in `test:media:api:ci`. Upgrade
coverage in `test:media:upgrade:ci` includes fresh install, 0027→0028 preserving
associations/bindings/assets/sessions/audits, framework rerun, and both incompatible
purpose preflight aborts. Existing CI validate already invokes both gates.

B06 delete/purge, legal-hold mutation, R2 DELETE/credentials; B07 assignment;
B08 reconciliation; offline first-upload-after-revocation and numeric duration
policy remain deferred. No finding/work_activity/quality_check/delivery/quote
association APIs. No commit/push.
