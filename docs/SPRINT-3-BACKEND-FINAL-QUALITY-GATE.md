# Sprint 3 — Backend Final Quality Gate

Evidence date: 2026-09-30 (America/Bogota). Scope: Track A backend only.
This document does not close Sprint 3 as a whole or claim frontend completion.

Current authoritative closure policy (project owner): **Track A remains OPEN**
until BOTH the R2 External Gate has its required stable external evidence AND
Production Privacy v1 is approved and merged. This policy supersedes the earlier
review that treated R2 transport instability as non-blocking for Track A.
Earlier decisions and gate results below are historical evidence, not current
closure authorization. Sections 12, 21 and 22 record the current pending gates.

## 1. Historical base / branch / commits

- Branch: `task/s3-backend-final-quality-gate`.
- Base SHA: `7e1708c4c2e569a31d4805392cfaf7ca09580d67`, the current local
  `integration/sprint-3` HEAD at task start.
- Phase 0: HEAD equaled `git merge-base HEAD integration/sprint-3`.
- Initial default Node was v26.4.0. All accepted gates ran with **v22.23.3**.
  `.nvmrc` and all three CI jobs now select that exact version.
- An existing untracked `.claude/settings.local.json` was temporarily preserved
  outside the repository for the clean baseline, then restored and locally
  excluded through `.git/info/exclude`. It is neither deleted nor committed.
- Final implementation SHA: `df40b2d223f4fa0a426eb5b8d67008c0064452e7`.
- Previous evidence SHA / HEAD before documentary closure:
  `09e07ba63f4e73df3672ce9c0e285e572b53c410`.
- The new final closure evidence commit changes only this document. Its SHA
  is supplied verbatim in the handoff after creation; it is not embedded in
  its own content. Resolve it with
  `git log -1 --format=%H -- docs/SPRINT-3-BACKEND-FINAL-QUALITY-GATE.md`.

## 2. Scope

Historical gate changes are tests, mutation harnesses, CI, staging evidence, Node version
configuration and this document. `src/`, schema, migrations and snapshots are
unchanged. No reception, privacy, signature, close or RBAC semantics changed.
No Sprint 4 work, frontend, cancellation or reopen implementation.
Base and implementation have identical Git trees: `src` =
`a8094775be861f5a6f908612a5635aa1239ce831`; `drizzle` =
`445e9dc949cd18786098babc4e7a5eb58cea2ed2`.

This final closure task changes only this document: no productive code, tests,
CI, staging, migrations/schema, frontend or Sprint 4 changes.

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

### Historical local/manual external evidence

Earlier separate external tests used configured test credentials; no credentials
or signed URLs are included here. Historical manual run 1: 6/6 PASS and
FIXTURE_CLEANUP_PASS. Historical manual run 2: 5/6 FAIL,
`CROSS_TENANT_INITIAL_PUT` had `UND_ERR_CONNECT_TIMEOUT (attempt 1/1)` during PUT.
This was a transport failure, not a demonstrated domain or isolation defect.
The runner cleaned its fixtures in finally; that failed run did not emit the
overall success marker and is not counted as PASS. A third manual run with
fresh fixtures (historical manual run 3) also returned 5/6 FAIL: `SIGNATURE_REPLAY_SAME_PUT` encountered
`UND_ERR_CONNECT_TIMEOUT (attempt 1/1)` during PUT. No green sequence of three was obtained.
Independent residue check confirmed media disposable databases = 0 and media
logins = 0. Both resolved IPv4 TCP paths were reachable during later diagnostics,
which does not erase the real request failures. The two failed runs are NOT PASS.

An earlier review accepted these failures as a non-blocking external transport
risk for Track A. The project owner later strengthened the closure requirement;
the current policy supersedes that earlier classification. Historically, no
SigV4 defect, cross-tenant leak, media state defect or cleanup defect was
demonstrated. There was no automatic PUT retry and no broad cleanup; cleanup was
restricted to keys created by each run. Residual disposable DBs/logins = 0/0.

### Current external workflow evidence

The external workflow exists at `.github/workflows/r2-external.yml` and runs via
`workflow_dispatch`. Current dispatch results supplied by the project owner:

| External workflow run | Result |
| --- | --- |
| Run #1 | FAIL |
| Run #2 | PASS |

These dispatch runs are distinct from the historical manual runs above.
The required evidence is **three independent consecutive workflow_dispatch
runs PASS**. Run #2 is green, but the supplied sequence contains only one
consecutive PASS after Run #1 failed. Three consecutive green dispatches are
not established; R2 is **NOT formally closed**.

Current classification: **R2_EXTERNAL_GATE_CLOSURE_BLOCKER**;
**R2_EXTERNAL_EVIDENCE_PENDING**. Track A remains open until this evidence
requirement and Production Privacy v1 approval and merge are both satisfied.
Failed historical or current runs do not count as PASS.

## 13. Historical local gates

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

## 14. Historical mutation counts

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

Final global CI mutation result: **180/180 killed** (including reception 58/58).
Global survivors = 0; normal failures = 0; invalid/apply failures = 0.

## 15. Historical remote CI final state

Draft [PR #2](https://github.com/IvanBy12/TallerMecarioB/pull/2) targets main from
the required task branch. [CI run #41 / 36750508963](https://github.com/IvanBy12/TallerMecarioB/actions/runs/36750508963)
corresponds to previous evidence SHA `09e07ba63f4e73df3672ce9c0e285e572b53c410`.
All three jobs completed successfully:

| Job | Job ID | Final conclusion |
| --- | --- | --- |
| validate | 110007614699 | success |
| mutations | 110009015603 | success |
| staging | 110009015628 | success |

Mutation logs confirm 180/180 killed, including reception 58/58 and queries 22/22.
Staging includes 23/23 migrations through 0022, all 24 report fields, 16 deployed
reception requests, exactly-once close, production privacy fail-closed and
rollback/log privacy. These CI results apply to the stated previous evidence
commit; the new documentary closure commit does not claim a separate CI run.
CI calls the S3 aggregate once. No merge or push to integration/sprint-3 or main
was performed; integration-push evidence requires later integration of this
reviewed task branch and must not be inferred from the PR run.

## 16. DOC_CONFLICTS

**DOC_CONFLICT-01 — INFO, accepted/pre-existing:** dictionary enumerates
`cancelled`; S3 operational lifecycle remains `open → closed`. No cancel/reopen.

## 17. Privacy release dependency

The former publication/configuration dependency is addressed on
`fix/s3-production-privacy-v1`: exactly `privacy_notice_es-CO_v1` and
`service_provision_es-CO_v1` are published with the user-approved literal copy.
The workshop email is the canonical rights channel. Production capture requires
legal name, complete primary address, phone and valid canonical email and
continues to fail closed when those are incomplete or exact versions are
unavailable. The generic retained snapshot contract remains backward-compatible.
See S3-04-5-RECEPTION-PRIVACY-CONTRACT.md for exact-copy hashes and conditions.

The new production-dependency API E2E captures consent and creates a reception
referencing it, then verifies retained evidence and database immutability. No
frontend, Sprint 4, migration, offline policy, RLS or hash algorithm changes.
The historical gate results below apply to their recorded commits; publication
regression results are recorded separately in section 22. This publication does
not itself declare all Sprint 3 Track A or full frontend/backend E2E closed.
Implementation completion does not satisfy the owner's privacy closure
condition until Production Privacy v1 receives final approval and is merged.

## 18. Accepted risks

RLS can mask removal of explicit tenant filters behaviorally; strict compiled
SQL assertions and structural mutants provide additional evidence. Current R2
classification is R2_EXTERNAL_GATE_CLOSURE_BLOCKER: stable external evidence
is mandatory for Track A closure, full E2E and production release. Existing
backup RPO/RTO infrastructure limitations are unchanged. Production Privacy v1
implementation is complete, but final approval and merge remain required for
Track A closure. The earlier tests reproduced no technical domain defect;
that historical result does not waive either current closure requirement.

## 19. Historical git diff --stat

Implementation commit `df40b2d223f4fa0a426eb5b8d67008c0064452e7` versus base:
**20 files, 794 insertions(+), 82 deletions(-)**.
Previous evidence commit `09e07ba63f4e73df3672ce9c0e285e572b53c410` versus base:
**20 files, 816 insertions(+), 82 deletions(-)**.
The new final closure evidence commit changes only this document; its diff
against the previous evidence commit is reported in the final handoff. The
historical counts above are not the new final commit's counts.
`git diff BASE HEAD --name-only -- src drizzle` is empty; no
source/schema/migration changes.

## 20. git status --short

Before the closure commit, only this document may be modified and
`git diff --check` must pass. After the commit, `git status --short` must be
empty; the verified result is supplied in the final handoff.
`.env`, staging env files, logs,
coverage, temporary directories, R2 files and private keys are not committed.

## 21. Commit SHA / decision

Implementation SHA: `df40b2d223f4fa0a426eb5b8d67008c0064452e7`.
Previous evidence SHA: `09e07ba63f4e73df3672ce9c0e285e572b53c410`.
New final closure evidence SHA is supplied in the handoff after creation.

Historical decision: an earlier Claude review reported 0 BLOCKER, 0 HIGH and
0 MEDIUM and approved Track A closure while accepting R2 as a non-blocking
external transport risk. That earlier decision is preserved as history and
is superseded by the project owner's current closure policy.

**TRACK A — BACKEND CLOSURE PENDING**. Production Privacy v1 implementation,
local regression gates and remote CI #50 PASS; adversarial code/security review
is clean, with final adversarial approval pending the M-1 documentary correction.
Privacy approval and merge are required. R2 still needs three independent
consecutive green external workflow_dispatch runs; Run #1 FAIL and Run #2 PASS
do not satisfy that requirement. **Track A remains OPEN until BOTH gates are
satisfied**, regardless of the earlier green backend CI and mutation evidence.
Production still requires complete workshop controller configuration.
**Sprint 3 as a whole is NOT closed: Track B Frontend/PWA remains pending**,
along with Full Frontend + Backend E2E. No merge or main/integration change
is part of this documentary closure.

SPRINT 3 TRACK A BACKEND CLOSURE PENDING: YES

## 22. Production Privacy v1 regression evidence (2026-09-30)

Branch: `fix/s3-production-privacy-v1`. Node: **22.23.3**.
Implementation SHA: `92c3320402c3618228b4d3e7a8d73f85240d2a5d`.

Current Production Privacy v1 status, supplied by the project owner:

- Implementation: **PASS**.
- Local regression gates: **PASS** (recorded below).
- Remote CI #50: **PASS**.
- Adversarial code/security review: **PASS**, clean.
- Final adversarial approval: **PENDING only documentary correction M-1**;
  this documentation fix is submitted for that final approval.
- Approval and merge remain required under the current Track A closure policy.

These results do not close Track A. R2 external closure evidence is still
pending (section 12), and both requirements must be satisfied.

The supplied approved text is published in the exact two v1 versions.
Rights channel = canonical workshop email; complete identity/address, phone
and email remain mandatory for production online capture. Independent copy
and SHA-256 tests pin the exact bytes; the evidence hash algorithm is unchanged.

| Gate | Publication result |
| --- | --- |
| security:secret-scan | PASS |
| npm audit --omit=dev | PASS, zero vulnerabilities (registry-access retry) |
| typecheck / lint / build | PASS |
| npm test | PASS |
| privacy unit suites | PASS, 17/17; no skips/todos |
| test:reception:api:ci | PASS, 90/90; no skips/todos; fixture cleanup PASS |
| test:reception:db:ci | PASS, 23/23; teardown dbs=0/logins=0 |
| test:reception:upgrade:ci | PASS; teardown dbs=0 |
| test:reception:mutations:ci | PASS, 58 killed / 0 survived: DB 19, signature 6, close 11, queries 22; no invalid applications |
| test:cross-tenant:final:ci | PASS, 25/25; fixture cleanup PASS |
| test:api:security:ci | PASS, 12/12; fixture cleanup PASS |
| test:runtime:db:ci | PASS, login provisioning and runtime database role boundary |

Production capture cases A-J pass with the production dependencies: stored
purpose/versions, lowercase 64-character server hash, canonical controller
snapshot and rights channel; missing/invalid email, missing phone/location,
wrong versions, absent adult attestation and client evidence are rejected.
No optional purpose is implicitly granted. Primary-location phone fallback
also passes. The production reception E2E succeeds after controller data
changes and confirms its consent FK and unchanged historical evidence; direct
hash/snapshot mutation is rejected by PostgreSQL. Hash reconstruction and
every purpose/version/text/snapshot-field contribution are tested.

Production code changes: `src/privacy/catalog.ts`,
`src/privacy/controller-notice.ts`, `src/privacy/consent-service.ts`.
Migration added: **NO**. Tenant-scoped SELECT/INSERT, composite constraints,
RLS, evidence guards, audit and adult attestation remain in place. Frontend,
Sprint 4 and production offline contracts remain outside this publication.
Adversarial review and workshop-specific controller configuration remain
release requirements; this section does not declare full Sprint 3 closure.
