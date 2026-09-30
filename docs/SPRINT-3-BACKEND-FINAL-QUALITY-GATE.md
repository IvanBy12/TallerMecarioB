# Sprint 3 — Backend Final Quality Gate

Evidence date: 2026-09-30 (America/Bogota). Scope: Track A backend only.
This document does not close Sprint 3 as a whole or claim frontend completion.

## 1. Base / branch / commits

- Branch: `task/s3-backend-final-quality-gate`.
- Base SHA: `7e1708c4c2e569a31d4805392cfaf7ca09580d67`, the current local
  `integration/sprint-3` HEAD at task start.
- Phase 0: HEAD equaled `git merge-base HEAD integration/sprint-3`.
- Initial default Node was v26.4.0. All accepted gates ran with **v22.23.3**.
  `.nvmrc` and all three CI jobs now select that exact version.
- An existing untracked `.claude/settings.local.json` was temporarily preserved
  outside the repository for the clean baseline, then restored and locally
  excluded through `.git/info/exclude`. It is neither deleted nor committed.
- Final implementation SHA and remote run references: recorded in the final
  evidence update after the implementation commit exists. The evidence-only
  commit is identified by `git log -1 --format=%H -- docs/SPRINT-3-BACKEND-FINAL-QUALITY-GATE.md`.

## 2. Scope

Changes are tests, mutation harnesses, CI, staging evidence, Node version
configuration and this document. `src/`, schema, migrations and snapshots are
unchanged. No reception, privacy, signature, close or RBAC semantics changed.
No Sprint 4 work, frontend, cancellation or reopen implementation.

Two infrastructure defects were reproduced and corrected:

1. Backup fixture INSERT omitted the mandatory `privacy_consent_id`, causing a
   PostgreSQL NOT NULL failure before pg_dump. It now uses the existing explicit
   TEST-ONLY privacy fixture and includes privacy_consents in restore counts.
2. The secret scanner exempted the deliberate bad-config password by line 305.
   Added staging evidence moved that line, causing `SECRET_SCAN_FAIL`. The
   exemption now matches only the complete reviewed fixture line in its exact
   file; new real credentials remain subject to scanning.

## 3. S3-01 to S3-07 status

| Item | Backend status / evidence |
| --- | --- |
| S3-01 | Existing implemented/audited contract inherited from the supplied baseline; no new feature work. |
| S3-02 | PostgreSQL invariants, runtime role boundary, upgrade and DB mutations PASS. |
| S3-03 | Authenticated reception create, owner/customer/vehicle/consent lineage and audit PASS. |
| S3-04 | Open reception PATCH, OCC, transaction and audit PASS. |
| S3-04.5 | Consent evidence, production fail-closed catalog and notice configuration PASS. |
| S3-05 | Signature capture, canonical acceptance, media eligibility/single use and audit PASS. |
| S3-06 | Transactional close, one order, initial history, mileage and idempotent retry PASS. |
| S3-07 | List/detail DTOs, pagination, assigned resolver, RBAC, tenant predicates and mutations PASS. |

## 4. CI mutation gap closure

Both `test:reception:mutations` and `test:reception:mutations:ci` execute DB/domain,
signature, close and `scripts/test-reception-queries-mutations.cjs` sequentially.
The specific query alias remains, with a new `:ci` counterpart. The CI `mutations`
job calls the aggregate once; query mutations are not duplicated. The final gate
branch, integration/sprint-3 pushes and pull requests select the mutation job.

## 5. S3-07 LOW closures

**F-01 closed:** real API assertions require 400 `REQUEST_VALIDATION_FAILED`
for valid base64url inputs with wrong numeric/string version, non-UUID/non-string
ID, extra keys, missing fields, uppercase/whitespace UUID, non-object shape and
noncanonical base64url trailing bits. A valid control cursor still returns 200.
Five mutants remove cursor rejection, canonical encoding, exact keys, version
or canonical UUID validation. Every mutant is killed. The query runner first
requires a green unmutated control suite.

**F-02 strengthened/closed:** strict compiled SQL assertions and individual
mutants cover list/detail reception tenant predicates, the assigned resolver's
service_order tenant filter, assignment tenant filter and composite tenant join,
reception_check_items and vehicle_damages. RLS remains enabled. The gate catches
explicit predicate removal even when RLS masks its behavioral effect.

## 6. Migration evidence

No SQL or Drizzle schema changes. Current journal has **23 migrations, 0000–0022**.
Staging validates every file's ledger hash/timestamp and reports dynamically:

`MIGRATION_LEDGER_PASS 23/23; latest 0022_s3_05_signed_media_quarantine`.

Rerun leaves ledger/schema unchanged. Current S3 migration chain:

| Migration | Existing purpose |
| --- | --- |
| 0019_s3_02_reception_invariants | Reception, signature, order/history integrity. |
| 0020_s3_04_5_reception_privacy_contract | Exact immutable consent evidence and owner lineage. |
| 0021_s3_05_signature_media_single_use | Signature media cannot be reused. |
| 0022_s3_05_signed_media_quarantine | Signed evidence retains allowed quarantine protection. |

Reception upgrade exercises 14 PASS scenarios through 0022 and leaves zero
disposable databases. CRM upgrade retains its historical 0000–0018 contract;
its historical ledger count is not the current staging migration count.

## 7. Staging reception E2E

`staging:deploy-drill` builds and deploys the production API entrypoint in a
disposable Docker Desktop stack. It provisions the NOBYPASSRLS runtime login,
checks neutral/API/worker role boundaries and verifies real Clerk RSA sessions.
Existing CRM E2E performs 23 HTTP requests. The new reception helper performs
16 additional HTTP requests and uses the same tenants/advisor/technician auth.

The current owner/customer and vehicle come from the deployed CRM flow. Only
privacy_consent and active signature media_asset are seeded as clearly named
TEST-ONLY DB fixtures with guards enabled. No signature is inserted directly.
No R2 dependency is added to hermetic staging. The production privacy catalog
and rights channel configuration stay unchanged.

POST reception → PATCH with advancing microsecond OCC token → stale PATCH
409 → signature 201 → close 200 → detail/list 200 → retry close 200. Database
evidence checks the exact consent ID, advisor membership, mileage and fuel.

## 8. Staging tenant/RBAC evidence

Tenant B cannot create using A's vehicle/consent, PATCH or read A's reception
(404), and its list omits A. Advisor permissions are real DB-backed grants.
Technician GET list returns 403 `PERMISSION_DENIED`. Local final cross-tenant,
runtime boundary, reception RBAC and assigned lead/support resolver suites PASS.

## 9. Exactly-once close evidence

Deployed DB final state: one reception closed, **one signature, one service_order,
one initial order_status_history (NULL → reception), one reception.closed success
audit**, and vehicle current_mileage_km = 2345. Four reception mutation audits
have the correct tenant/advisor actor and correlate to deployed completion logs.
Second close returns identical order and timestamps. Full row snapshots of
reception/signature/order/history/audit/vehicle are byte-for-byte unchanged.

## 10. Log privacy

Closed completion-log allowlist remains enforced. Sentinels include customer
and advisor notes, signer/document, privacy fixture text/hash/snapshot/rights
channel, authorization tokens and the raw query route. Exact list/detail DTO
keys exclude signature, consent evidence, order and embedded CRM fields.
After bad deploy and recovery the reception/CRM snapshots and DTO remain equal;
recovered request logs are checked again. No side effects are redispatched.
Generated staging environment files now live in the OS temp directory and are
removed with the disposable stack/images/network/volumes.

## 11. Backup/restore

`test:db:backup-restore` PASS: backup, restore, integrity, RLS and cleanup.
Restored migration count matches the current 23-migration source; schema FK,
policy and FORCE RLS counts agree; source/target fixture counts agree, including
privacy, reception, signature, service order and initial history. Runtime tenant
isolation and append-only grants survive restore. Processed outbox events are
not claimable or redispatched. This is the existing logical backup drill, not a
claim of continuous WAL/PITR infrastructure.

## 12. Real R2 evidence

Separate external gate using configured test credentials; no credentials or
signed URLs are included here. Initial run: 6/6 PASS and FIXTURE_CLEANUP_PASS.
Next run: 5/6, `CROSS_TENANT_INITIAL_PUT` had `UND_ERR_CONNECT_TIMEOUT (attempt 1/1)`.
This was a transport failure, not a demonstrated domain or isolation defect.
The runner cleaned its fixtures in finally; that failed run did not emit the
overall success marker and is not counted as PASS. A new manual sequence with
fresh fixtures is recorded in the final evidence update. PUT retries remain
disabled; cleanup is restricted to keys created by each run.

## 13. Local gates

All accepted runs use Node v22.23.3 and PostgreSQL 18.4. DB commands load `.env`;
CRM DB/upgrade/mutations and outbox now explicitly load it when present while CI
retains environment-provided configuration. No secret values are recorded.

| Gate | Result / count |
| --- | --- |
| security / secret scan | PASS |
| npm audit --omit=dev | PASS, zero vulnerabilities |
| build / typecheck / lint | PASS; lint checks 231 files |
| npm test | PASS: authz 26, TenantContext core 70, Wompi 20, presign 2 |
| test:runtime:db | PASS |
| test:reception | PASS: API/privacy 85; DB 23; no skips/todos |
| test:reception:upgrade | PASS, 14 scenarios |
| test:reception:mutations | PASS, 58 killed |
| test:reception:harness | PASS, 174 LF/CRLF/absent-anchor assertions |
| test:crm:api / db / upgrade | PASS: 75 / 21 / 7 scenarios |
| test:outbox:ci | PASS, 19 |
| test:cross-tenant:final | PASS, 25 |
| test:db:cross-row | PASS, 62 |
| test:api:security | PASS, 12 |
| test:db:backup-restore | PASS |
| staging:deploy-drill | PASS, all 24 report fields |

## 14. Mutation counts

| Reception runner | Real killed / total |
| --- | ---: |
| PostgreSQL/domain/privacy/media integrity | 19/19 |
| Signature | 6/6 |
| Close | 11/11 |
| Queries/RBAC/cursors/tenant predicates | 22/22 |
| **Total** | **58/58** |

Baseline was 48 (19 + 6 + 11 + 12), not 46. This gate adds ten S3-07 mutants.
Survivors = 0; normal suite failures = 0; invalid/apply failures = 0. Absent
anchors throw; LF/CRLF portability is tested for all 58 targets. Harness source
is shared with the runners, and temporary mutation copies stay in OS temp.

## 15. Remote CI readiness

Remote `validate`, `mutations` and `staging` must succeed on the final reviewed
implementation SHA. CI includes the complete S3 query mutation gate and real
deployed reception E2E. URLs/run IDs and actual job conclusions will be recorded
in the evidence-only update; local PASS is not a remote PASS claim. No merge to
main or integration has been performed by this task.

## 16. DOC_CONFLICTS

**DOC_CONFLICT-01 — INFO, accepted/pre-existing:** dictionary enumerates
`cancelled`; S3 operational lifecycle remains `open → closed`. No cancel/reopen.

## 17. Privacy release dependency

**RELEASE / INTEGRATION DEPENDENCY, not a Track A backend bug:** production new
reception flow remains fail-closed until canonical privacy notice, service_provision
authorization text and canonical rights channel are published/configured.
PRODUCTION_PRIVACY_CONSENT_DEPENDENCIES rejects unpublished versions with
`PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE`; notice/rights-channel absence is also
covered by existing `PRIVACY_NOTICE_NOT_CONFIGURED` tests. Track B and the later
Sprint 3 full E2E must account for this dependency. No legal text was invented or
published; existing TEST-ONLY fixtures do not enable production privacy capture.

## 18. Accepted risks

RLS can mask removal of explicit tenant filters behaviorally; strict compiled
SQL assertions and structural mutants provide additional evidence. External R2
transport can be transient and remains separate from hermetic staging. Existing
backup RPO/RTO infrastructure limitations are unchanged. Privacy publication is
a visible release dependency. No technical domain blocker was reproduced.

## 19. git diff --stat

Final baseline-to-implementation statistics are recorded with the final evidence
update. The diff must contain no source/schema/migration changes.

## 20. git status --short

Final delivery requires an empty working tree. `.env`, staging env files, logs,
coverage, temporary directories, R2 files and private keys are not committed.

## 21. Commit SHA / decision

Implementation and evidence commit SHAs are supplied in the final handoff.
Decision is pending final external evidence and remote CI. Only **TRACK A —
BACKEND CLOSED** can be declared; this document never closes all of Sprint 3.
