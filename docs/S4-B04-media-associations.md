# S4-B04 — Operational media binding, Phase A

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
Damage permits photo/video only; video360 gives `409 MEDIA_ASSOCIATION_CONFLICT`.
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

## Boundaries and remaining blocker

**PURPOSE_CATALOG_UNRESOLVED**. Diccionario 03 defines varchar(48), NOT NULL and
partial PK semantics but provides no canonical purpose strings. B01 records this
reservation; the supplied Phase A contract confirms it. No Notion access occurred.

No public reception_media/damage_media attach route was enabled because no
canonical purpose strings exist in the approved sources.

No reception_media/damage_media INSERT, gallery, reorder or quantity limit.
Existing sort_order is integer 0…2147483647, default 0, ties allowed; future stable
read order remains sort_order, media_asset_id, purpose.

Owner/admin/service_advisor remain tenant-wide. Technician remains fail-closed
pending B07; binding is not a general download/read capability. B05 retention
remains pending: binding is protective in-progress evidence, not the final domain
association or a terminal-order event. No retention_until or 12-month clock starts
from authorization/upload/session/reception-close. Future cleanup must account for
binding protection. B06/B08, offline exceptions and duration policy remain outside
Phase A. S4-B04 is not fully closed while the purpose catalogue is unresolved.

Behavioral tests run through the existing media API gate; migration coverage runs
through the media upgrade gate. Both are included in the normal CI validate job.
