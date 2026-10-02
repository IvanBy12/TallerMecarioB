# S3-05 — Reception signature / acceptance

## Contract

`POST /api/v1/receptions/:receptionId/signature` requires the permission
`signatures.capture` (owner, admin, service advisor; technician denied).
The JSON body is strict and limited to 2 KiB:

```json
{
  "signatureMediaId": "canonical UUID",
  "signedByName": "name of the person signing",
  "signedByDocument": null,
  "documentVersion": "reception_acceptance_es-CO_v1"
}
```

`signedByDocument` is optional and nullable. The authenticated workshop member
is the audit actor; the named customer is the signer. The client cannot send
text, hash, timestamp, IP address, tenant or reception ID in the body. A
successful request returns `201 { "signature": { "signatureId", "receptionId",
"signatureMediaId", "documentVersion", "signedAt" } }`. The response
excludes the signature image/key, signer document, acceptance text and hash.

## Canonical document

The sole published acceptance is `reception_acceptance_es-CO_v1` in
`src/receptions/acceptance-document.ts`. Its NFC/LF/UTF-8/no-BOM/no-trailing-
newline SHA-256 is
`192829413c90bd0a1a58c9301274fa10c608da30e6c4b4c7f38174deea11125e`.
`CANONICAL_ACCEPTANCE_HASH_PIN` prevents a silent change to v1. The server
owns both text and hash; an unknown client version returns
`409 ACCEPTANCE_DOCUMENT_VERSION_MISMATCH` without fallback.

This acceptance permits inspection and diagnosis to prepare a quotation. It
does not authorize repairs, parts, additional work or charges. It is distinct
from `privacy_consents` and `legal_acceptances`.

## Transaction and concurrency

Within the tenant request transaction, the service locks its reception with
`FOR NO KEY UPDATE`, requires `open`, resolves the document version, locks
the media row with `FOR SHARE`, validates it, inserts a signature and a
minimal `reception.signed` success audit, then commits. The media must belong
to the same tenant, have `media_type=signature`, `status=active`,
`retention_class=authorization_evidence`, and have no deletion or purge marker.
Quarantined, pending, deleted and foreign media are rejected. Missing and foreign
media share a safe 404. Migration 0023 preserves the 0019 reception/media guards
and adds the same reception-specific retention check. Incompatible media returns the existing
`409 SIGNATURE_MEDIA_NOT_ELIGIBLE` (`23514 signatures_media_guard` in PostgreSQL).
The shared upload/signature media type imposes no global retention restriction.
Exactly one signature belongs to a reception; exactly one belongs to a delivery
when that flow is implemented. A signature
media asset can back only one signing act within its tenant, whether reception
or delivery. The 0021 `signatures_one_media_uq` enforces this single use.

The lock order is reception → media, including the 0019 trigger. A concurrent
quarantine update waits on the media lock; after a committed signature, 0022
allows `active → quarantined` while the signed-media trigger continues to
protect the object identity, deletion and purge markers. Migration 0023 also
freezes `retention_class` once media backs any signature. Changing the class
is forbidden, including during quarantine; `quarantined → active` and other
status transitions remain forbidden. Historical signatures and reception detail
summaries survive quarantine. Normal download URL generation rejects quarantined
media. If quarantine commits first, signature
validation fails. A future close must start with the
same reception lock; if close commits first, capture returns
`409 RECEPTION_NOT_EDITABLE`. S3-05 leaves receptions open and does not create
service orders.

`signatures_one_reception_uq` is PostgreSQL's exactly-one backstop. Sequential
and overlapping duplicate requests return `409 RECEPTION_ALREADY_SIGNED`,
with one row and one success audit. The API role cannot update, delete or
truncate signatures; the append-only trigger also rejects updates/deletes.
Composite tenant FKs and FORCE RLS enforce tenant isolation. A failed insert
or audit rolls the whole transaction back.

The 0023 preflight examines reception signatures across all tenants under
exclusive locks and restores FORCE RLS before installing guards. Incompatible
historical classes fail with `23514 reception_signature_retention_preflight`;
no evidence is rewritten. Existing grants and delivery eligibility are preserved.

## Scope

No signature replacement, delete, read endpoint, certified digital signature
claim, reception closure, general reception gallery or privacy-copy publication
is introduced. Productive privacy consent capture remains fail-closed pending
the canonical privacy copy and rights channel.
