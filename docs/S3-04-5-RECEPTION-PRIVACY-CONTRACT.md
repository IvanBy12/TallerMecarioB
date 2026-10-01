# S3-04.5 — Reception Privacy Contract

## Scope and decisions

This hardening sits between closed S3-04 and paused S3-05. It changes the
S3-03 create contract without implementing signature, reception close, PWA,
offline synchronization, or the full ADR-005. The decisions in the S3-04.5
handoff take precedence over older local exports.

- **D-PRIV-01 / RECEPTION-CONSENT-01:** a reception records the exact
  `service_provision` consent that covered its INSERT. Consent must belong to
  the same tenant and customer, be granted and unrevoked, and have
  `privacy_consents.created_at <= receptions.created_at`. Device-declared
  `captured_at` is evidence, not the ordering authority.
- **D-PRIV-02:** consent retains a server-computed hash of the exact versioned
  notice, authorization, and controller snapshot. Evidence is immutable after
  INSERT; revocation is the terminal `granted -> revoked` transition.
- **D-PRIV-03:** `receptions.customer_id` must be the current primary owner
  (`vehicle_owners.is_primary = true AND valid_to IS NULL`) at INSERT. A later
  transfer does not reinterpret an existing reception.
- **D-PRIV-04:** capture requires an explicit `adultAttestationConfirmed: true`.
  The declaration belongs to versioned authorization text; no DOB or persisted
  boolean is added.
- **D-PRIV-05:** the backend has authenticated bundle encode/verify primitives
  and retains the bundle's historical controller snapshot for offline evidence.
  No product sync endpoint, default expiry/grace policy, or production key is
  introduced before ADR-005 defines those contracts.

## Schema and migration

`drizzle/0020_s3_04_5_reception_privacy_contract.sql` and the matching Drizzle
schema/snapshot add `privacy_consents.authorization_text_hash char(64) NOT NULL`
with lowercase SHA-256 CHECK, and `controller_notice_snapshot jsonb NOT NULL`
with a five-field shape CHECK. `receptions.privacy_consent_id uuid NOT NULL` has
a tenant-composite FK to `privacy_consents(tenant_id,id)` and a matching index.
The existing partial unique index permits only one granted consent per
`(tenant_id,customer_id,purpose_code)`; `receptions_one_open_vehicle_uq` remains
the final authority for one open reception per vehicle.

The migration holds exclusive locks while preflighting all tenants. Since the
0019 schema stored neither a reception's consent reference nor a consent's
exact text and controller snapshot, **any** legacy reception or privacy
consent aborts the migration with an explicit preflight constraint. No current
notice, invented hash/snapshot, sentinel UUID, or temporary NULL backfill is
used. The migration runner's transaction rolls back the entire change and
keeps the 0019 ledger, data, RLS state, columns, functions, triggers, and
grants intact. A clean 0019 database upgrades to 0020; rerunning is a no-op.
The upgrade suite tests clean, each legacy category, both together, rollback,
and rerun.

PostgreSQL evidence guards prohibit UPDATE of historical consent fields,
DELETE, TRUNCATE, and reactivation of revoked rows. Runtime privileges permit
only the revoke columns (`status`, `revoked_at`, `updated_at`), while the trigger
enforces the transition even against privileged SQL. The reception's consent
reference is immutable after INSERT and absent from PATCH's editable fields.

## API and error contract

`POST /api/v1/receptions` now requires canonical UUID `privacyConsentId` in
addition to the S3-03 fields. There is no implicit or latest-consent lookup.
The public ReceptionDto stays unchanged. The command first locks the vehicle,
checks scoped references and owner, locks the specified consent, INSERTs, and
writes `reception.created` audit in the same TenantContext transaction. Audit
metadata adds only `privacy_consent_id`, not text, hash, snapshot, bundle, or
request body. A failed audit rolls back the reception.

`POST /api/v1/customers/:customerId/privacy-consents` is the minimal online
capture route, gated by the existing `privacy_consents.capture` permission
(owner, admin, and service advisor; no role-name checks in the handler). Its
strict JSON body is:

```json
{
  "purposeCode": "service_provision",
  "privacyNoticeVersion": "<published version>",
  "authorizationTextVersion": "<published version>",
  "channel": "in_person",
  "capturedAt": null,
  "adultAttestationConfirmed": true
}
```

`capturedAt` is optional declared evidence; if supplied it must be a valid
RFC 3339 instant with an explicit offset. The path supplies `customerId`.
Texts, hash, controller snapshot, tenant, status, and server timestamps are
rejected as unknown body fields. Capture resolves exact server-owned versions,
builds the snapshot from `workshops` and its primary `workshop_locations`,
computes the hash, INSERTs the consent, and writes minimal
`privacy_consent.captured` audit atomically. It does not expose evidence text,
hash, or snapshot in the DTO. No public revoke route was needed for S3-04.5;
the database transition and both race orders are tested directly.

Missing/malformed `privacyConsentId` returns 400
`REQUEST_VALIDATION_FAILED`. Foreign and nonexistent consent IDs are
indistinguishable: 404 `PRIVACY_CONSENT_NOT_FOUND`. Same-tenant wrong customer,
purpose, revoked status, or invalid creation order returns 409
`PRIVACY_CONSENT_NOT_ELIGIBLE`. A customer who is not the current owner returns
409 `VEHICLE_OWNERSHIP_CONFLICT`, reusing the CRM code without revealing the
owner. Missing/foreign vehicle and customer references retain their scoped
404 contract. Unknown SQL errors remain sanitized 500s; only named
constraints/triggers are mapped.

## Locks, concurrency, and tenant boundary

The CREATE lock graph is `vehicle FOR NO KEY UPDATE -> current primary owner
-> privacy consent FOR SHARE -> INSERT reception -> audit`. The BEFORE INSERT
trigger names sort so PostgreSQL repeats vehicle/owner validation before
consent validation, then runs the existing 0019 lifecycle guard. Direct SQL
cannot bypass either rule. `FOR SHARE` is required because a FK's `KEY SHARE`
does not conflict with the revoke UPDATE. Both locks are reentrant inside the
application transaction.

`transferOwner` starts with the same vehicle lock. If transfer wins, CREATE
sees the new owner and rejects the old customer; if CREATE wins, the historical
reception remains valid after transfer. If revoke wins, CREATE sees revoked
consent and rejects; if CREATE wins, revoke waits until the reception commits.
Two CREATEs for one vehicle serialize on its row, then the partial unique
index yields one 201 and one 409 `RECEPTION_ALREADY_OPEN`. Tests observe
blocking with `pg_blocking_pids`/controlled barriers, not just concurrent
promises. PATCH retains `reception -> vehicle`; future close must retain
`reception -> vehicle -> advisory(order_number)`. Revoke takes only consent,
so no `consent -> vehicle` inversion is introduced.

Production SQL scopes tenant IDs, runs under TenantContext/RLS, and uses
composite FKs. API tests compare foreign and absent references; DB tests check
RLS and direct SQL guards. No tenant or actor is accepted from request JSON.

## Canonical hash and controller snapshot

`src/privacy/canonical-text.ts` builds a deterministic preimage: UTF-8,
well-formed Unicode, NFC, LF line endings, no leading BOM; domain
`tallermecario.privacy_consent.text.v1`, NUL-separated purpose and versions,
then `u64be(length) || bytes` for notice and authorization. Snapshot fields
follow in fixed order: `legalName`, `address`, `phone`, `email`,
`rightsChannel`. For each field, NULL is byte `0x00`; a string is `0x01 ||
u64be(UTF-8 length) || UTF-8 bytes`, so NULL differs from empty string. The
server stores SHA-256 lowercase hex of those bytes. Tests pin an exact digest
for a clearly TEST-ONLY fixture and exercise each component, non-ASCII, NFC,
LF, BOM, and nullable encoding.

The snapshot is server-owned and frozen at capture. Legal name, phone, and
email come from `workshops`; address and optional location phone come from the
primary workshop location. The five-field JSON is retained verbatim even if
the workshop later changes. The model has no canonical source for
`rightsChannel`, so production currently supplies none and fails closed with
`PRIVACY_NOTICE_NOT_CONFIGURED` instead of inventing a persisted field.

## Bundle boundary and semantic verification

`privacy_notice_bundle` is `base64url(payload_bytes) + '.' +
base64url(HMAC-SHA256(key[keyVersion], payload_bytes))`. Payload bytes are the
exact UTF-8 bytes emitted by the backend. Verification decodes canonical
base64url, authenticates the received bytes with a dedicated versioned key
ring, compares the fixed-size MAC using `timingSafeEqual`, and only then parses
JSON. It checks format, tenant, key version, payload shape, and an explicitly
supplied validity policy. Finally it compares notice and every purpose's
authorization text with the exact server catalog versions. A valid MAC on a
version/text mismatch is still rejected. Offline capture uses the authenticated
historical snapshot, not current workshop data. Bundle, MAC, and secrets are
absent from errors and audit. Tests use TEST-ONLY keys; no product key or
expiry/grace default exists.

## Tests, gates, and remaining decisions

The existing CI runners discover the new privacy unit/API/DB tests and the
0019→0020 upgrade tests. The reception mutation runner now also checks owner,
vehicle lock, consent customer/purpose/state, consent share lock, and temporal
ordering by mutating migration 0020 in disposable OS-temp copies. A mutant is
`KILLED` only when the migration succeeds, behavioral tests fail, and the
disposable database and logins are cleaned up; `fail=N` in that mutant's test
output is expected and is distinct from a normal-suite failure.

## Production Privacy v1 publication (2026-09-30)

The user-approved canonical UTF-8/NFC/LF copy is now published in the
server catalog, with exactly one notice (`privacy_notice_es-CO_v1`) and one
`service_provision` authorization (`service_provision_es-CO_v1`). The literal
texts have no trailing newline. Wording or whitespace changes require new
versions; there is no latest/current fallback. No marketing, image use,
reminders or WhatsApp authorization is published. TEST-ONLY fixtures retain
their test-* versions and remain separate.

For production online capture, the workshop is the controller and
`workshops.email`, validated through the existing canonical email schema,
is the rights-channel source: `Correo electrónico: <canonical email>`.
Legal name, complete primary location/address, workshop or location phone,
and valid email are required. Missing/blank/invalid email, missing phone,
missing primary location or incomplete identity/address returns
`PRIVACY_NOTICE_NOT_CONFIGURED`. Unpublished or wrong exact versions return
`PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE`. Adult attestation must be true;
client text/hash/snapshot/rights-channel/tenant/status fields remain rejected.
The generic historical/offline snapshot still allows a single contact field.

Production tests explicitly use `PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES`: capture
and stored versions/hash/snapshot, all fail-closed cases, purpose separation,
phone fallback and reception creation referencing that exact consent. The E2E
changes controller data after capture, creates the reception, reconstructs the
hash from retained evidence, and verifies that PostgreSQL rejects evidence
mutation. The hash algorithm, tenant predicates, RLS, audit writes, concurrency
and all database guards remain unchanged; no migration or schema change.

Independent SHA-256 pins (literal document UTF-8 bytes):

- Notice: `fd459b0980dd784c2db78c43c45ee752ac65b0ef4a8bb13f30695df87f474385`.
- Authorization: `61b3686e8d36f918feb011e501fee8776e736c6c30ab13d71a302d5a78d361f6`.

Regression gate results for this publication are recorded in
SPRINT-3-BACKEND-FINAL-QUALITY-GATE.md. ADR-005 still owns bundle validity/grace
policy and the offline sync contract; no production offline route is registered.
