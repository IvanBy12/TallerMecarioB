# S4-B09 — Sprint 4 backend final media quality gate

Date: 2026-10-13, America/Bogota. Repository: `IvanBy12/TallerMecarioB`.
Branch: `task/s4-b09-media-quality-gate`. Base/HEAD: `8e52adee1870f39e19774efa8865d70b288ef7f9`.
The reviewed candidate is the uncommitted B09 patch over that SHA; HEAD alone does
not identify the new files. No commit, push, PR, shared deployment or live R2 operation.

## 1. Executive gate decision

| Gate | Decision | Meaning |
| --- | --- | --- |
| Backend automated gate | PASS | Final corrected 27-step local execution in §11; historical §9 execution is retained separately; PostgreSQL 18.6 and simulated R2 only. |
| Full Sprint 4 gate | BLOCKED | Mandatory integration evidence and unresolved contracts remain. |
| Production readiness | NOT_READY | No final-SHA live R2/browser E2E, staged recovery digest, or B06 activation approval. |

B09 changes verification, regression tests, CI and this evidence record. Application
routes, permissions, schema, migrations, retention policy and production workers
are unchanged. A merged implementation or a successful local command does not
satisfy an external acceptance criterion. The simulator does not prove bucket
privacy, browser CORS, physical recovery or provider expiry.

## 2. Canonical sources and acceptance matrix

`N§7.1`–`N§7.24` below are the **24 criteria supplied verbatim by the user in this
chat**, “Quality Gates — Sprint 4: Video 360° + evidencias”. No Notion access was
used. Their order is preserved. The export has no revision timestamp; its source
is the supplied text, not an independently fetched Notion revision.

Normative backend details: [B01](../S4-B01-media-contract.md),
[B02](../S4-B02-media-integrity.md), [B03](../S4-B03-media-idempotency.md),
[B04](../S4-B04-media-associations.md), [B05](../S4-B05-media-retention.md),
[B06](../S4-B06-media-delete-purge.md), [B07](../S4-B07-assigned-media-authorization.md),
[B08](../S4-B08-media-reconciliation.md). Later approved contracts resolve specific
historical B01 gap statements: B04's two purposes and damage+video360 are resolved;
B07 Phase A supplies assigned reads. Earlier B02/B03 “B04 pending” notes are
historical, not current blockers. Duration and B07 order uploads remain unresolved.
B01 §16 and migration 0024 require **normal reception close without a signature**.

Status vocabulary: PASS = the stated scoped behavior has executed evidence;
FAIL = observed failure; BLOCKED = a required contract/environment is missing;
NOT_RUN = no execution claimed; DEFERRED = explicitly reserved by a source.
The local and acceptance columns deliberately describe different scopes. A local
PASS cannot promote a BLOCKED acceptance row. All source/test paths are relative
to the backend repository unless explicitly prefixed FE. Execution IDs refer to §9.
`M` means the full `test:media:api:ci` execution, including every media API file.
`U` means `test:media:upgrade:ci`; `R` means reception API/DB executions.

| # / requirement and source | Owner | Implementation | Permanent tests | Executed backend evidence / local status | Staging/production evidence still required | Acceptance status / exact reason |
| --- | --- | --- | --- | --- | --- | --- |
| 1. retention_class/retention_until/policy_version and deletion/purge state; N§7.1, B01 §§2/10/11 | BE | `src/db/schema.ts`, migrations 0025–0030, `src/media/retention.ts` | `tests/media-api/retention.test.cjs`, `delete-purge.test.cjs`, upgrade runner | M/U: persisted versions, floors, markers, grants; PASS | Deployment/schema capability and migration release record | PASS — local persisted schema behavior; deployment remains §7 pending |
| 2. Incomplete upload expiry/cleanup baseline 24h; N§7.2, B01 §7, B05 Product clocks, B06 | BE/Ops | `service.ts`, `retention.ts`, `purger.ts`, migration 0029 | `idempotency.test.cjs`, `retention.test.cjs`, `delete-purge.test.cjs` under `tests/media-api/` | M: 15-minute capability expiry is distinct from session.created_at+24h cleanup; PASS | Approved dormant-purger activation and bounded canary | BLOCKED — automated eligibility/purge uses fake storage; activation prohibited pending §8 |
| 3. Operational terminal order+12 months, warranty+90d when longer; N§7.3, B05 Product clocks | BE | `retention.ts`, 0029 SQL evaluator; `lockOrderMediaRetention` primitive | `tests/media-api/retention.test.cjs`, B05 differential oracle in `delete-purge.test.cjs` | M: UTC months, microseconds, exact warranty lineage, longest floor; PASS | Future delivered/cancelled command must use the approved lock/recalculation primitive | PASS — evaluator contract; no terminal-order API integration is claimed |
| 4. Signature/PDF/evidence 36-month default or stronger; N§7.4, B01 §10, B05 | BE/product | `retention.ts`, SQL evaluator, `src/receptions/signature.ts` | `retention.test.cjs`, `delete-purge.test.cjs`, reception `signature.test.cjs` | M/R: signed_at and delivered_at clocks; unresolved clocks protect; PASS for specified clocks | Approved exact quote/document/privacy authorization clocks before their purge | BLOCKED — PDF/linked-document/privacy clocks are expressly unresolved; no substitute timestamp |
| 5. Legal hold prevents automatic purge; N§7.5, B05/B06 | BE/Ops/product | SQL evaluator, purge fence/job protocol | `retention.test.cjs`, `delete-purge.test.cjs` | M: held/future/unresolved obligations and physical-phase races; PASS | Approved hold setter and late-hold/copy/recovery policy | BLOCKED — local enforcement passes; complete operational protection/recovery remains unresolved |
| 6. deleted_at prevents new signed URLs before purged_at; N§7.6, B01 §9, B06 | BE | `service.ts`, `assigned-authorization.ts`, migration 0029 | `delete-purge.test.cjs`, `assigned-authorization.test.cjs`, `idempotency.test.cjs` | M: request/deleted/purged markers deny issuance, including completed replay; PASS | Deployment smoke; already-issued capabilities retain bounded TTL | PASS — issuance protection, no instant recall of an existing capability claimed |
| 7. Retention worker respects links/holds and audits; N§7.7, B05/B06 | BE/Ops | `purger.ts`, 0029 narrow entrypoints, durable jobs | `delete-purge.test.cjs`, upgrade runner | M/U: protective links, expired linked evidence, once-only audits, rollback/retry; PASS | B06 controlled activation, independent recoverable copy and incident path | BLOCKED — dormant worker is tested, not production-authorized |
| 8. Detect missing R2 object and orphan without metadata; N§7.8, B08 | BE/Ops | `reconciliation.ts`, `reconciliation-r2.ts`, worker, migration 0030 | `tests/media/reconciliation*.test.cjs`, `tests/media-api/reconciliation.test.cjs` | Unit/M/U: missing vs access errors, global metadata existence, partial suppression; PASS | Read-only identity, canary HEAD/LIST, scope/load and alert routing | BLOCKED — live operational scanner evidence absent |
| 9. Upload session; N§7.9, B01 §§3/6/7, B02–B04 | BE | `service.ts`, `operational-binding.ts`, `routes.ts` | Media API integrity/idempotency/binding tests | M/U: create/replay/expiry/complete, consent lineage, exactly-once audit; PASS | Authenticated target deployment smoke | PASS — tenant-wide operational backend flow; technician upload is separately blocked |
| 10. Temporary signed URL; N§7.10, B01 §§7/9, B03 | BE/Ops | `r2.ts`, `service.ts` | `tests/media/r2-presign.test.cjs`, media API idempotency/assigned tests | Unit/M: signed headers, PUT ≤min(900, session remaining), GET 300s; PASS | Real provider acceptance/expiry and browser headers | BLOCKED — local signing assertions do not prove provider behavior |
| 11. Client video directly to R2; N§7.11, B01/B04; FE F07-A/B | FE/BE/Ops | BE capability + inspection; FE direct PUT transport/orchestrator | BE binding/integrity/associations; FE shared/media + orchestration tests | M: photo/video/video360 complete/attach; simulated only; PASS | Browser real video PUT→complete→attach without API byte proxy | BLOCKED — no real browser/storage execution |
| 12. Photos; N§7.12, B02/B04; FE F02/F07 | FE/BE | Bounded PNG/JPEG/WebP inspection, operational links; FE capture | `tests/media/content.test.cjs`, media API integrity/association/B09 tests; FE picker tests | Unit/M: format, declared MIME, size, attach/list; PASS | Device/browser capture and real R2 round trip | BLOCKED — real capture/upload evidence absent |
| 13. Retry; N§7.13, B03; FE F04/F07 | FE/BE | Stable semantic create/complete replay; bounded inspection retries | Media API idempotency; `tests/media/r2-integrity.test.cjs`; B09 final-quality-gate | Unit/M: payload mismatch, exactly-once, recoverable failures; PASS | Real browser ambiguous PUT/retry and expiry evidence | BLOCKED — local retries pass; real transport recovery not executed |
| 14. Interrupted upload; N§7.14, B02/B03/B05; FE F04 | FE/BE | Pending retryable session, incomplete clock, FE cancellation | Integrity/binding/retention tests; B09 missing/partial range scenarios | M: pending asset/session/binding preserved, same-key retry; PASS | Actual cancellation/interruption and resumed user flow | BLOCKED — no browser/provider interruption execution |
| 15. Invalid file rejected; N§7.15, B01 §5, B02 | BE/FE/product | `content.ts`, R2 metadata/range inspection, durable quarantine | Content/R2 integrity tests; `tests/media-api/integrity.test.cjs` | Unit/M: corrupt/truncated/MIME/size/unsupported and partial inspection; PASS for bounded format checks | Approved numeric duration/measurement plus deployment smoke | BLOCKED — duration policy missing; no full decoder/malware/360-proof guarantee |
| 16. Metadata persisted; N§7.16, B02–B06 | BE | `service.ts`, bindings/associations, migrations | Integrity/binding/association/retention/upgrade tests | M/U: exact size/version/identity and immutable history; PASS | Target deployment smoke | PASS — real local PostgreSQL persistence verified |
| 17. Checksum/size when applicable; N§7.17, B01 §5, B02/B03 | BE | Expected/actual size, declared checksum syntax/normalization/replay | `integrity.test.cjs`, `idempotency.test.cjs`, R2/content unit tests | Unit/M: mismatch size rejected; SHA declaration deliberately differs from actual bytes; PASS | Provider sizes/inspection canary; verified-checksum contract if later required | PASS — SHA is declared/unverified, ETag is opaque; no independent digest supported or claimed |
| 18. Specific domain media links; N§7.18, B04 Phase B | BE | `associations.ts`, reception_media/damage_media | `associations.test.cjs`, `operational-binding.test.cjs`, upgrade runner | M/U: canonical purposes and immutable lineage; PASS | Real deployed attach/list and browser gallery | PASS — reception/damage MVP; other domain workflows remain source-excluded |
| 19. No polymorphic media_links write; N§7.19, B04 | BE | Explicit reception/damage route/table selection, composite FKs | Association strict body/direct runtime SQL, DB foundation | M/DB: no arbitrary table/purpose accepted; PASS | No additional external evidence for this code-level rule | PASS |
| 20. Media A cannot link entity B; N§7.20, B01 §§8/12, B04 | BE | TenantContext, tenant predicates/FORCE RLS/composite FKs and binding guards | Association/binding/retention/assigned tests; final cross-tenant suite | M/DB: foreign and cross-reception/damage targets rejected with no foreign writes/audits; PASS | Deployment multitenant smoke | PASS — backend authorization/DB enforcement verified locally |
| 21. Download URL expires; N§7.21, B01 §9, B07 | BE/FE/Ops | Signed 300s GET; FE local timer removes view | Presign/assigned tests; FE gallery timer/Chromium tests | Unit/M confirms signed TTL; PASS for issuance | Real GET before/after TTL from approved origin and unauthorized-origin negative | BLOCKED — provider expiry not executed; client timer is not storage enforcement |
| 22. R2 outage does not destroy reception; N§7.22, B02–B04 | BE/FE | Independent reception transaction; retryable media completion | New `tests/media-api/final-quality-gate.test.cjs`; FE F07-B/C | M: six real-DB HTTP-route cases preserve reception/consent/damages; the photo/provider case now preserves one actual persisted signature and its media through retry/attach/close; see §11 | Real browser R2 outage/interruption with existing reception retained | BLOCKED — simulator proves backend preservation; real integrated case absent |
| 23. Media query/view by order; N§7.23, B01 §8, FE F07-C matrix #23 | BE/FE/product | Current list routes address reception/damage; assignments resolve an order internally | Assigned tests cover those resources, not a public order gallery | NOT_RUN — no order query/view contract/API/spec to execute | Approved order route/DTO/UI contract, implementation and automated + browser evidence | BLOCKED — unapproved acceptance gap, not a source-approved deferral |
| 24. E2E reception + video + photos; N§7.24 | FE/BE/Ops | Separate implemented components; no current real S4 Playwright flow | Existing real e2e specs are S3; synthetic F07 gallery/harness is separate | NOT_RUN — no real S4 E2E executed | Provisioned HTTPS/Clerk/API/PG/R2/CORS, valid fixtures, safe evidence, matching SHAs | BLOCKED |

## 3. B01–B08 implementation evidence

| Contract | Independently inspected implementation and boundary | Permanent execution |
| --- | --- | --- |
| B01 | Six existing media types, strict type/MIME/class matrix; uploadSessionId completion identity; tenant and server authorization; signature history; migration 0024 unsigned close. Old gap notes are not evidence of current failures. | Unit, M, R, DB and U |
| B02 | Exact immutable expectation; HEAD size/MIME and ETag-pinned bounded ranges; success/quarantine durable transaction; fresh reauthorization after external inspection; schema capability/legacy preflight. | Integrity/content/R2 tests, M, U; local binary drill separately §9 |
| B03 | Tenant+key advisory serialization; capturedAt instant/microsecond equivalence; declared checksum replay; expiry-bounded renewal; finite read retries outside SQL transaction. | Idempotency unit/API + R2 integrity; M |
| B04 | Immutable initial server consent/reception/damage authorization; no current-consent revocation invalidation of the same operation; new operations require valid consent; canonical intake_evidence/damage_evidence; completed binding remains historical. | Binding/association tests, M/U, including concurrent close/attach and direct runtime INSERTs |
| B05 | All nine reference families + session bindings; known max/no-shortening floors; UTC calendar months; warranty exact lineage; unresolved clocks protect; API/worker column ACLs. | Retention tests + independent B05 differential oracle in purge tests, M/U |
| B06 | Early tombstones; jobs/leases/session fences; narrow lifecycle role/functions, FORCE RLS; no SQL transaction over external DELETE; retries and parked reconciliation; no physical recovery claim. | Delete/purge tests M; clean/upgrade/invalid-role/injected-failure rollback U |
| B07 Phase A | Assigned lead/support reads + direct downloads; released/QC/foreign/sensitive graph denied; membership/grant/assignment locking through issuance; next request denies after revocation. Phase B writes remain closed. | Assigned authorization M and six independently applied compiled-artifact mutants |
| B08 | Tenant-scoped observations + bounded global existence boolean under isolated column-only owner; no write/delete; partial scans suppress orphan promotion; count/sample redaction and operational exit statuses. | Scanner/transport unit + reconciliation API M and upgrade U |

## 4. Critical negative and tenant-isolation matrix

Every PASS below refers to the automated local executions in §9. These tests use
real PostgreSQL role/lock/FK/RLS behavior and simulated external storage. Existing
privileged corruption probes are fixture-only and are not runtime authority.

| Attack/failure | Permanent coverage | Observed scope/status |
| --- | --- | --- |
| Tenant A reads/completes/attaches B | Media integrity/binding/associations/assigned tests; `tests/cross-tenant/`; new B09 recovery case | PASS: missing/foreign 404/403, no foreign mutation or capability |
| Assigned vs unassigned; QC/released; revoked membership/role | `assigned-authorization.test.cjs`, tenant request lifecycle | PASS: deny unsafe graph, protect signature/privacy evidence, no signing on denial |
| Assignment release/issuance race | Assigned tests with PostgreSQL barriers, `omit_assignment_lock` mutant | PASS: both winners serialized; already-issued GET valid for up to 300s is the documented bound |
| Changed idempotency payload / concurrent create or complete | `tests/media-api/idempotency.test.cjs`, binding tests | PASS: deterministic 409 mismatch; one identity/transition/audit |
| Permission/membership/parent changes during inspection | Integrity/binding/assigned tests | PASS: fresh Phase C denies activation; current consent revocation alone preserves previously authorized same operation |
| Cross-reception/damage association | Association/binding strict bodies, FKs and raw-runtime tests | PASS: no retargeting or fabricated consent/parent |
| Malformed/oversized/MIME/actual-size/format mismatch | Content/R2 integrity/API integrity | PASS: 400/422, quarantine durable where specified; unsupported structure not falsely called a decoder finding |
| Missing object, 5xx/network, partial range | R2 integrity/API integrity; six B09 outage cases | PASS: 409/503; pending/retryable with no false activation/quarantine and unchanged reception |
| Retention/hold/committed historical reference | Retention/B05 oracle/delete-purge/signature tests | PASS: complete reference inventory and retained historical identity |
| New signed URL after request/tombstone/purge | Delete-purge/assigned/idempotency tests | PASS: availability precedes payload replay disclosure; no new URL |
| Purge vs attach, hold, session reactivation, competing claimant | Delete-purge real-lock tests | PASS: shared fences, eligibility recheck, bounded retry, immutable terminal transitions |
| Restore after physical loss | Delete-purge parked-job/expired-lease/late-hold cases | BLOCKED for actual restoration: no approved recovery command/copy. Tests PASS for parking without clearing holds/history or claiming recovered bytes |
| DB/audit rollback plus external failure/success | Integrity/retention/delete-purge and reception API | PASS: rollback before commit; DB failure after DELETE is durable uncertainty, not fictitious external rollback |
| Old-schema upgrades and hostile role ACLs | `scripts/test-media-integrity-upgrade.cjs`, reception upgrade, runtime/Sprint0 DB suites | PASS: fresh + upgrades + rerun, invalid-role/preflight fail closed, late failure restores ledger/history/grants |
| False orphan / legacy cross-tenant object / partial scan / lifecycle race | Reconciliation unit and real-DB API tests | PASS: global identity across all states, re-read fingerprints, no candidate promotion from failed/partial scans |
| Signature history / reception close | Reception signature/close, retention/purge, upgrades and B09 | PASS: append-only identity retained; unsigned close valid; no history rewriting or signature requirement restored |

No unexpected successful negative case is accepted as a pass. Mutation gates
must return success only after their intended behavioral failures and cleanup.
Six B07 mutants have explicit control/diagnostic/cleanup validation; historical
reception mutation tools have their existing validation limits and are not claimed
to provide a new exhaustive security scan.

## 5. Integrity and retention limits

Expected size, actual size and exact MIME are distinct persisted/observed facts.
The inspector validates bounded structure, not every encoded sample, arbitrary
PDF content, malware absence or a genuine 360-degree recording. Large-video
latency/cost and real browser formats remain target-environment evidence.
SHA-256 in the current API/database is **declared/unverified**. ETag is an opaque
object-version observation, never relabeled as SHA-256. No verified-checksum
capability was silently added or marked complete.

The 900s upload capability and 24h incomplete cleanup baseline are different
clocks. Operational 12-month retention starts at the linked order's terminal
closed_at, never reception close/upload/attach. Exact warranty evidence extends
with +90 days only when its proven obligation wins. Signature signed_at uses
36 UTC calendar months; quote/document/privacy clock gaps remain protective.
Retention floors never shorten; an expired hold never erases a floor or resolves
an unknown obligation. Legal-hold setters, incident/DSR linkage and order-terminal
command integration remain explicitly outside these existing contracts.

## 6. Frontend and real-E2E dependencies

The frontend **is accessible read-only** at
`/Users/ivanby/Documents/Proyectos/TallerMecario`, clean HEAD
`9052f263daaf233508ba5625e86b42c96cefd6bd`. Its `AGENTS.md`, media/quality modules,
package scripts, quality matrices and current `e2e/` inventory were inspected.
No frontend file was changed and no frontend test rerun is claimed.

The current `docs/quality/s4-f07-c-media-final-gate.md` final audit cites reviewed
commit `4c0066860ded1a9f8c7a5769f6342d45d9071827`: 1315 Vitest tests,
191 harness tests, 9 gallery Chromium cases, all **historical synthetic evidence**.
It explicitly marks real D1–D12 and Sprint 4 BLOCKED/NOT_READY. Earlier F07 readiness
notes predate B04/B07/B08 and cannot override the newer backend executions here.

| Required frontend evidence | Accessible source/spec | Current status | Exact dependency/owner |
| --- | --- | --- | --- |
| Reception with photos | F02, F07-A/B/C reports and capture/orchestration tests | BLOCKED for real execution | FE/Ops: real authenticated reception + valid photo → PUT/complete/attach/list |
| Video360 capture/upload/playback | F03 + F07-B; gallery synthetic Chromium | BLOCKED | FE/product/Ops: device-compatible valid MP4/MOV; approved duration; actual playback and direct PUT |
| Progress, retry, cancellation | F04, F07-A/B + media unit tests | BLOCKED for real transport | FE/Ops: browser progress, ambiguity, cancel and explicit retry evidence |
| Interrupted upload recovery | F04/F07-B; backend B09 negative/recovery tests | BLOCKED for integrated case | FE/BE/Ops: incomplete PUT/partial inspection, stable IDs, reception retained; no invented offline persistence |
| R2 outage preserves reception | F07-B/C synthetic; backend B09 six cases | BLOCKED for live case | FE/Ops: controlled provider outage/failure with reception data and retry retained |
| Listing/download | F07-C reception gallery, B04/B07 backend routes | BLOCKED for real; order view also absent | FE/BE/product: actual persisted list and authorized temporary GET; separate order query/view contract |
| Browser-compatible presigned requests | FE readiness R2/CORS section | BLOCKED | Ops/FE: permitted-origin OPTIONS→PUT with exact signed headers, readable PUT response, GET/Range, denied-origin control |
| Full reception + video + photos | Current real `e2e/s3-*.spec.ts` only; synthetic desktop gallery is separate | NOT_RUN | FE/BE/Ops: provisioned HTTPS, Clerk test users/tenants, final backend/frontend SHAs, PG18 migrations, private R2, cleanup and redacted media-aware collector |

The existing S3 reception E2E and local Docker recovery drill do not certify the
real Sprint 4 media path. Do not substitute jsdom, intercepted Chromium, an E2E
listing command, Node provider tests, or an unexecuted harness for this evidence.

## 7. Live R2 and production readiness

All entries below are **NOT_RUN in B09** and block the corresponding release gate.
Historical B02/B03 documents cite real Node R2 tests on their earlier SHAs; that
history is not independently rerun final-SHA evidence and does not prove browser CORS.
No R2 credentials were read, copied or exercised; no bucket lifecycle/configuration,
physical production purge, LIST cleanup or real object request was performed.

| Required evidence | Owner / safe scope and success record |
| --- | --- |
| Private bucket, no public r2.dev/custom-domain exposure | Ops: approved target account/bucket; configuration and unauthenticated-negative evidence, redacted |
| Separate upload/read/list vs delete identities | Ops/security: effective scoped permissions, negative forbidden-method probes on approved disposable canaries; no credentials in report |
| Actual PUT/HEAD/GET/LIST canaries | Ops/BE: explicitly approved staging bucket, synthetic unique namespace, signed conditional PUT and duplicate 412, exact HEAD/range/content response, bounded LIST; reviewed cleanup scope |
| URL expiry | BE/FE/Ops: GET/PUT before/after TTL and replay near session expiry on the target provider |
| Browser CORS | FE/Ops: exact approved origin, OPTIONS/signed Content-Type/If-None-Match, PUT response exposed, GET/Range and disallowed origin; API CORS is separate |
| Provider error handling | BE/Ops: controlled 401/403/404/429/5xx/network cases with safe codes, no false missing/complete/quarantine |
| Runtime secrets/log redaction | Ops: deployed API/worker/request/provider/audit telemetry; local test redaction and source scanner alone cannot certify deployed pipelines |
| Reconciliation limits/performance | Ops/BE: canary known independently, tenant scope/coverage, CPU/memory/DB locks/provider limits on representative inventory; budget exhaustion remains partial |
| Alerts | Ops: actual configured receiver/escalation/on-call route and delivery test for missing held object, access failure, partial/absent run and parked B06 job |
| Schema rollout and binary recovery | Release/BE: exact immutable candidate and retained **previously real-staging-validated v1 recovery digest**; quiesced old writers, final ledger/capability and deployment smoke |

B08 defaults (50 rows/page, 10 DB/inventory pages, HEAD concurrency 4, 30s) and
maximum 10,000 inventory keys/120s can leave production scans partial. Partial or
empty tenant coverage is not a healthy complete inventory. Remaining documented
B08 risks R4–R10 and B07 tenant-lock/list scalability are retained for operational
review; this gate adds no tuning or hidden scope expansion.

## 8. Contract blockers versus approved reservations

| Dependency | Classification and source | Gate consequence |
| --- | --- | --- |
| Numeric video duration and trusted measurement | BLOCKED — B01 §5.6/B02 explicitly unresolved; user-supplied checklist supplies no value/unit/method | No complete video-integrity or unconditional Sprint PASS |
| B07 Phase B order-bound upload | DEFERRED in B07 scope, still BLOCKED for full acceptance: requires binding/target/purpose/lifecycle/consent/retention/auth/concurrency contract; no new approval supplied | Assigned reads PASS does not certify technician uploads; routes stay fail-closed |
| Order query/view | BLOCKED unapproved gap — N§7.23 required; FE final matrix explicitly says absent | Reception/damage gallery and internal assignment joins do not close this criterion |
| B06 physical activation / late hold / restoration | BLOCKED — B06 Production activation boundary and Physical DELETE recovery | No production purge. Need dry-run, limits/canary, separate identity, recovery copy, hold cutoff/setter and authorized incident/resolution process |
| Quote/PDF/generic linked document/privacy clocks | DEFERRED/reserved — B01 §10/B05 | Keep protection; no invented timestamp, no claim all 36-month clocks complete |
| External incident/DSR hold linkage; hold setter | DEFERRED/reserved — B05 | Explicit media hold enforcement tested; no complete legal-hold management claim |
| Future domain mutation workflows and offline first upload after revocation | DEFERRED — B01 §12.1/§17, B04/B07 | No future purpose/endpoint/offline policy introduced; this does not waive N§7.23/24 |
| Live R2, real E2E and B08 operation | BLOCKED evidence — §§6–7 | Code merge or fake transport cannot discharge provisioning/canary/performance/alerts |

## 9. Historical pre-remediation automation and executed evidence

These executions predate F-1 remediation. Exit-zero evidence from the old runner
is not sufficient to certify coverage. This table preserves execution history;
§11 is the corrected runner, source identity and targeted re-review evidence.

Use repository Node `.nvmrc` 22.23.3 / npm 10.9.9 and a **disposable localhost-only
PostgreSQL 18 admin cluster**. This is necessary because suites create databases,
roles, migrations and adversarial role fixtures. Do not point them at a shared DB.
No `.env` is loaded by the new runner. `DATABASE_URL` is supplied by the caller;
`S4_GATE_DISPOSABLE_DATABASE=1` acknowledges the disposable scope. The old runner checked local URL/protocol and PostgreSQL major 18 before any suite.
The corrected preflight additionally rejects populated clusters; see §11.

```sh
# DATABASE_URL must already address the disposable localhost PostgreSQL 18 cluster.
S4_GATE_DISPOSABLE_DATABASE=1 npm run test:s4:quality-gate -- --report /tmp/s4-b09.json
```

`--media-only` is the CI subset (`npm run test:s4:quality-gate:ci`), after existing
CI type/lint/build/foundation/reception steps. It executes every hermetic media
unit/harness file plus the complete media API and upgrade suites. It deliberately
removes duplicated focused purge/reconciliation DB runs: their files already run
in the full media API suite. Mutations retain the existing serial PR CI job; the
full local profile also runs B07 and reception mutants. No live upload-flow test,
production worker, destructive provider harness or credentialed R2 gate is invoked.

Child environments remove provider credentials/enable flags, filters, injected
mutations and migration overrides, and pin the reporter. Plans run serially,
stop on the first nonzero result, preserve that step's numeric exit status, and
record signal/spawn errors. Report fields separate `scopeAutomatedGate`,
`backendAutomatedGate`, `fullSprint4Gate`, `productionReadiness` and pending
external evidence. A successful CI subset leaves backendAutomatedGate=NOT_RUN
because it is only a subset; successful full execution still reports Sprint
BLOCKED/production NOT_READY. Closing external blockers requires a separately
reviewed evidence update; the runner never infers them from environment names.

Environment: macOS arm64; Node v22.23.3; npm 10.9.9; PostgreSQL 18.6
(`postgres:18-alpine`, aarch64), published only on 127.0.0.1 with a throwaway
trust-auth cluster and no real credential. All API tests use their normal
NOBYPASSRLS/NOINHERIT runtime logins; synthetic identity/storage doubles only.
Dependency tree reused from the primary checkout without lockfile changes.

| ID | Executed command / scope | Count or evidence | Exit |
| --- | --- | --- | --- |
| Q01 | `npm run security:secret-scan` | PASS | 0 |
| Q02 | `npm run typecheck` | PASS | 0 |
| Q03 | `npm run lint` | PASS | 0 |
| Q04 | `npm run build` | PASS | 0 |
| Q05 | `npm run test` | 205 passed; fail/skip/cancel/todo all 0 | 0 |
| Q06 | `node --test` additional R2 network/transport/scanner + both media harness files (exact six-file list in gate.log) | 157 passed; fail/skip/cancel/todo all 0 | 0 |
| Q07 | `npm run test:db:sprint0:ci` | 65 passed; fail/skip/cancel/todo all 0 | 0 |
| Q08 | `npm run test:authz:db:ci` | 4 passed; fail/skip/cancel/todo all 0 | 0 |
| Q09 | `npm run test:tenant-context:db:ci` | 27 passed; fail/skip/cancel/todo all 0 | 0 |
| Q10 | `npm run test:api:multitenant:ci` | 4 passed; fail/skip/cancel/todo all 0 | 0 |
| Q11 | `npm run test:tenant-context:api:ci` | 75 passed; fail/skip/cancel/todo all 0 | 0 |
| Q12 | `npm run test:api:security:ci` | 12 passed; fail/skip/cancel/todo all 0 | 0 |
| Q13 | `npm run test:cross-tenant:final:ci` | 25 passed; fail/skip/cancel/todo all 0 | 0 |
| Q14 | `npm run test:reception:db:ci` | 24 passed; fail/skip/cancel/todo all 0 | 0 |
| Q15 | `npm run test:reception:upgrade:ci` | 19 upgrade/preflight scenarios | 0 |
| Q16 | `npm run test:reception:api:ci` | 123 passed; fail/skip/cancel/todo all 0 | 0 |
| Q17 | `npm run test:runtime:db:ci` | PASS | 0 |
| Q18 | `npm run test:db:migration-lock:ci` | PASS | 0 |
| Q19 | `npm run test:media:api:ci` | 621 passed; fail/skip/cancel/todo all 0 | 0 |
| Q20 | `npm run test:media:upgrade:ci` | 17 scenarios; ledger 31; no-op rerun; data/history/ACL/rollback and cleanup PASS | 0 |
| Q21 | `npm run test:media:assigned:mutations:ci` | S4B07: killed=6; survived=0 | 0 |
| Q22 | `npm run test:reception:mutations:ci` | RECEPTION: killed=22; SIGNATURE: killed=7; S306: killed=11; S307: killed=24; S3C: killed=19; S3I: killed=7; survived=0 | 0 |
| Q23 | `npm run test:s4:quality-gate:ci -- --report /tmp/s4-b09-evidence/ci-gate.json` | Final CI profile: 238 unit/harness + 621 API tests, 17 upgrade scenarios; backendAutomatedGate=NOT_RUN (subset), scope PASS, full Sprint BLOCKED | 0 |
| Q24 | `node --test tests/media-harness/quality-gate.test.cjs` after final runner cleanup | 14/14; no failures/skips/cancellations | 0 |
| Q25 | `npm run test:reception:harness` | 272/272; LF/CRLF, fixtures and mutation infrastructure | 0 |
| Q26 | `npm run rbac:check-doc-parity` | 103 permission codes, full cell parity | 0 |
| Q27 | `npm run staging:deploy-drill:ci` | 35/35 local Docker build/migration/CRM/reception/worker/recovery/cleanup gates; synthetic identity/storage config | 0 |
| Q28 | `npm audit --omit=dev --json` | 0 production vulnerabilities | 0 |
| Q29 | `npm run lint`; `npm ls --depth=0 --json` on final source | Lint PASS; dependency tree valid | 0 each |
| Q30 | Ruby/Psych YAML parse + structural Python assertions | PG18 service, PR trigger, package script, acknowledgement env, always-uploaded report, no duplicated focused DB suites, retained B07 mutation step | 0 |
| Q31 | Secret scan + whitespace using disposable index with all 9 modified/new files | `SECRET_SCAN_PASS`; `git diff --cached --check` PASS; real index SHA unchanged | 0 each |
| Q32 | `git diff --check`; final Git status / source manifest / fixture cleanup | Whitespace PASS; no runtime/schema/migration/frontend edits; cleanup recorded below | 0 |
| External | Live R2 / real S4 browser E2E / shared staging / production purge | NOT_RUN: no approved credentials/environment/safety scope; contract/evidence blockers §§6–8 | — |
| Remote tooling | GitHub Actions run; actionlint | NOT_RUN: no push/PR/remote run authorized; actionlint unavailable. Local YAML/structural checks and CI profile were executed | — |

Full local run: **2026-10-13T21:14:05.396000-05:00 → 2026-10-13T21:22:32.086000-05:00**, exit 0,
22 recorded steps in the **superseded orchestration** (the last step contained six
reception mutation runners). The final corrected full-run plan has **27 steps**,
with each of those six runners recorded individually; see §11.
Final CI-profile run: **2026-10-13T21:23:01.991000-05:00 → 2026-10-13T21:24:55.402000-05:00**, exit 0.
Both record base HEAD `8e52adee1870f39e19774efa8865d70b288ef7f9` and a dirty working tree.

Execution provenance: the full run used the existing `test:reception:mutations:ci`
aggregate, with no `.env` present. During B09 runner cleanup, its final plan was
changed to call **the same six unchanged Node mutation entrypoints directly**,
avoiding the aggregate's optional dotenv loader. Their actual mutation executions
are Q22; final runner unit tests and final CI subset were then executed separately
(Q23/Q24). The full mutation aggregate was not repeated after this orchestration-only
cleanup. Application code and the test-clock fixes were already final for Q01–Q22.

Historical pre-remediation verification/CI/test source identity (eight changed files, excluding this
self-referential evidence document): **SHA-256 `f48abcdb09fb635f95833c62f69eed2ba2a1de710cadfc42b3f3882504c094eb`**. Reproduce from
`/tmp/s4-b09-evidence/source-manifest.sha256`: sorted repository-relative paths,
each line `<sha256(file bytes)>  <path>\n`, SHA-256 over that UTF-8 manifest.
This identifies the final uncommitted patch content in addition to base HEAD.

Local drill immutable image IDs: GOOD
`sha256:6409e3077f72f6d925a3864c1a49596003dc47265626b874c2fce18d5075493a`, BAD
`sha256:1a7fd231c161ddeaea5fad1f54bc66327c6d0a11b3847dfb7df1218d747737ae`.
Both were local disposable images removed by the drill. They are not registry
manifest digests or retained real-staging recovery artifacts.


Counts overlap between standard/focused/CI profiles and mutation controls; do
not sum them as unique tests. U includes 17 fresh/upgrade/hostile-role/atomic
rollback scenarios and current **31-entry** ledger. Reception upgrade includes
19 preflight/rollback/history scenarios. Exact child exit codes and timings are
recorded by the runner; raw synthetic logs are temporary local audit artifacts under `/tmp/s4-b09-evidence`,
not public production telemetry.

### Initial failure and correction

The first full run exited **1** and stopped at media API: **619/621 passed, 2 failed**.
The failures were the existing “one remaining whole second…” and “expiry during
storage validation…” tests, which relied on PostgreSQL wall-clock offsets and
subsecond scheduling windows. No new B09 scenario failed. The raw failure and
JSON report were retained separately; neither is relabeled PASS.

The two tests now use Node's test-scoped application Date clock. The first sets
persisted exact 1800/800/−1000ms boundaries; the second advances logical time only
after HEAD starts, crossing session expiry inside the 10-second inspection budget.
Real SQL, HTTP/routes, signing, expiration state and audit assertions remain. No
production time behavior, timeout, expiry policy or assertion was relaxed. The
exact transient environmental cause of the first run was not established; a later
DB/host clock sample was within 1ms after connection warmup. The final full media
suite passed all 621 tests with the deterministic fixtures.

### Historical permanent coverage added (superseded signature claim corrected)

- `tests/media-api/final-quality-gate.test.cjs`: six scenarios, photo/video360 ×
  missing object/provider 503/interrupted range. Real PostgreSQL persistence and
  HTTP routes originally proved reception/consent/damage and absence of signatures plus asset/session/
  binding/audit unchanged on failure; that unsigned fixture did not establish
  preservation of an existing signature. The signed photo/provider correction is
  documented in §11; foreign completion cannot mutate;
  same-key retry preserves session identity; completion→attach replay lists one
  association with one audit; normal close retains the media without a signature.
- `tests/media-harness/quality-gate.test.cjs`: runner failures, exact nonzero exits,
  signals, spawn errors, empty/subset false certification, pending external evidence,
  ambient filter/mutation/credential isolation and exclusion of live/redundant gates.
  These test gate failure handling, not application policy invented for B09.

The historical harness contained **14** tests. The corrected harness has **55** tests, including real child-process and disposable-cluster negatives (§11). CI configuration was parsed and its gate/script/PostgreSQL/artifact wiring checked
locally as described in the command table. No GitHub Actions run or remote CI PASS
is claimed. The existing PR mutation job remains required independently of the
local result. No new dependency or lockfile edit.

## 10. Release recommendation, changes and Git status

The local verification patch may be reviewed with its scoped automated evidence.
Do not approve Sprint 4 release or physical production purge from this report.
Resolve the contracts in §8 and produce final-SHA integrated frontend/backend/R2,
real staging/recovery and operational evidence in §§6–7, then rerun acceptance.

Changed files: `.github/workflows/ci.yml`, `.gitignore`, `package.json`,
`scripts/test-s4-quality-gate.cjs`, `scripts/s4-quality-coverage.json`,
`tests/media-api/final-quality-gate.test.cjs`,
`tests/media-harness/quality-gate.test.cjs`, and this report. `tests/media-api/idempotency.test.cjs` and `tests/media-api/integrity.test.cjs` also replace fragile wall-clock windows with deterministic test clocks. No `src/`, `drizzle/`,
frontend or business contract edits. Tenant/FK/RLS/privilege rules were checked
through existing permanent suites and the new negative recovery assertions.

Historical pre-remediation Git state: **5 modified tracked files + 4 new canonical files, all unstaged**. Final targeted-remediation state appears in §11.
The requested branch/worktree is preserved with the review patch. HEAD is unchanged;
no commit, push or PR. Main checkout remains clean on the supplied base. The real
index remained unchanged while scanning new files through an OS-temporary index.
The borrowed `node_modules` symlink is removed before delivery.

After the historical pre-remediation gates, the disposable PostgreSQL cluster was checked for leftover fixture
databases/logins and then removed with its anonymous volume. The local deployment
drill reported full cleanup of its independent stack/images/temp files. No physical
production purge or real bucket operation occurred. Canonical evidence remains in
this document; raw synthetic logs/JSON and the source manifest are under
`/tmp/s4-b09-evidence` for local adversarial review and are disposable. Temporary
helper scripts, draft report and alternate Git index are removed at delivery.

Historical Sprint acceptance remains PARTIAL — GATE BLOCKED.


## 11. S4-B09 Targeted Remediation Report

### F-1 — npm configuration isolation

The original runner's exact adversarial reproduction returned exit **0**, printed
`S4_B09_AUTOMATED_PASS profile=ci-media exit=0`, and executed **34/621 API tests**
(all 34 passing, failure/skip/cancel/todo zero). The independent unit/harness child
still executed 238 tests. The reproduced injected value was:

```text
--test-name-pattern=two.orders|strict.empty.body|B09.photo/missing|equivalent.sequential.create|CREATE.persists.v1|technician.remains.denied|dedicated.login.passes|pending.cleanup.is.created_at|strict.body.rejects
```

The corrected runner uses an environment whitelist (OS paths/temp/locale and the
explicit database URL), removes all inherited npm configuration, providers, test
filters, mutation selectors and Node loaders, and reconstructs `NODE_OPTIONS`
as `--test-reporter=tap`. It executes fixed Node entrypoints directly. The existing
`npm run …` step names are logical compatibility labels; no child npm process or
package-script lookup occurs. Project, user and global `.npmrc` therefore cannot
inject options or alternate scripts. Installed dependencies still resolve normally;
the gate neither installs dependencies nor changes the lockfile. No `.env` loader
is invoked. Start the gate with Node; invalid options/preloads applied before Node
starts cannot be undone by JavaScript and must cause startup failure, never PASS.

### F-1 — Test coverage verification

`scripts/s4-quality-coverage.json` and the runner's separate unit/harness floors form the version-controlled coverage contract. Foundation
floors are 26/78/20/5/76, media API is **621**, added unit/assignment suites are
143 (full) or 224 (CI), and the quality-gate harness is independently checked at
**55**. Other critical DB/API floors are 65/4/27/4/75/12/25/24/123. Floors allow
intentional growth while rejecting the reproduced 34/621 and zero execution.

Only contiguous, unambiguous Node TAP summaries are accepted for these suites:
integer tests/pass counts must agree and meet the floor, with zero fail, skipped,
cancelled and todo. Missing/malformed/duplicate/out-of-order/spec/custom summaries
fail closed. Signal, timeout, spawn error and nonzero exit take precedence over
summary validation. Migration/runtime/mutation runners instead require their
version-controlled exact success/cleanup/count contracts, including multiplicity;
no fabricated TAP summary is required from those custom tools. Reports retain
actual counts, floors, evidence errors and validated marker counts. Only the exact
full plan may certify `backendAutomatedGate=PASS`; CI always leaves it `NOT_RUN`.

### F-2 — Signature-history evidence

The photo/provider outage case creates active signature media using the existing
fixture conventions, captures a signature through the real reception HTTP route,
and asserts that exactly one persisted signature references that actual media ID.
SQL snapshots include the complete signature and referenced media rows before
failure. PostgreSQL rejects attempts to alter the signer and signed media object
key with SQLSTATE 23514. Failure, foreign-tenant completion, same-session retry,
completion/attachment replay and closure preserve those rows exactly. The other
five outage cases continue to establish normal closure without a signature.
Comparing two null signature collections is no longer cited as preservation of
an existing signature. Every added historical query/mutation is tenant scoped;
no authorization, schema, migration, storage policy or runtime code changed.

### F-3 — PostgreSQL disposable-cluster preflight

Before launching any suite, the runner requires explicit acknowledgement, a
localhost PostgreSQL URL without query overrides, PostgreSQL major 18, the
`postgres` maintenance database and superuser, exactly the three standard
`postgres/template0/template1` databases, no non-system roles except `postgres`,
and no user objects in the maintenance database. Canonical TallerMecario roles,
fixture roles, arbitrary user roles, extra databases, relations, functions,
types and additional user schemas are rejected. Connection/catalog inspection failure also prevents execution. The
preflight is read-only and never cleans a cluster to make it pass. Missing
port/user/database URL components are normalized to explicit 5432/postgres/postgres,
and that same URL is passed to children, preventing PGPORT/PGUSER/PGDATABASE
defaults from selecting a different endpoint. The postgres.js option-parser
regression verifies that port behavior without making a connection.

Runtime harness negatives first validate a fresh dedicated cluster, then create
only their own known role/database/table fixtures, verify rejection and preservation,
and remove only those fixtures. No ordinary developer PostgreSQL installation is
used. CI has a separate fresh `postgres:18.6-alpine` service on localhost port 5433,
because the earlier validation steps populate roles on the original service.
The standalone gate builds `dist/` before tests in both full and CI profiles.

The guard conservatively establishes fresh catalog state; it does not establish
ownership/exclusive use against another actor concurrently changing the cluster.
Continue to use a dedicated disposable container, never a shared PostgreSQL host.

### F-6 — Evidence consistency

The final full plan records **27 steps**; CI records **4**, including a fresh build.
Media upgrade has **17 scenarios**, **22 PASS marker occurrences** including
history/cleanup evidence, and **21 distinct PASS lines**. These are not 22 tests or
22 scenarios. Reception upgrade has 19 scenarios plus its teardown marker. The
24 canonical acceptance criteria, B01–B08 contracts and external blockers remain
unchanged: B07 Phase B, approved video duration, service-order gallery, live R2,
browser E2E and real staging/recovery evidence are still blocked/pending.

Final execution matrix and source identity follow below.

### Remaining findings — F-4/F-5

Cleanup checks in existing failing runners may miss leaked fixture roles. The new
preflight rejects such leftovers on the next invocation but does not repair those
cleanup implementations. A timed-out child may leave descendants running; process
tree termination is not claimed. The idempotency expiry case still uses a real
five-second session window. The precise causes of the original two timing failures
remain unknown. These concerns are documented, not relabeled resolved.

Temporary raw logs/JSON/original-runner snapshots under `/tmp/s4-b09-remediation`
are disposable review aids. The canonical durable evidence is this document, the
coverage contract and permanent regression tests intended for version control;
no claim depends on those temporary files remaining available. No remote CI,
live R2, shared staging, frontend E2E or destructive storage execution is claimed.


### Regression matrix — final executions

Final full execution: **2026-10-13T22:42:46-05:00 → 2026-10-13T22:59:53-05:00**, **27 steps, exit 0**.
Environment: macOS arm64, Node v22.23.3/npm 10.9.9, fresh dedicated PostgreSQL
**18.6** Docker containers, fake R2. Dependency tree reused from the primary
checkout; no install/lockfile changes. The final full run and serial injection
matrix use disposable PostgreSQL with `fsync=off` and `synchronous_commit=off`;
these are test-only durability settings, not production durability evidence.
The earlier successful normal CI control used the default settings. No application
assertion, coverage floor, test timeout, schema or business rule was relaxed.

The logical commands below execute the fixed Node entrypoints described above.
Counts are per subprocess summary and may overlap; do not sum them as unique tests.
Custom-runner marker counts are evidence lines, not test/scenario counts.

| Commands | Executed count / validated evidence | Exit |
| --- | --- | --- |
| `npm run security:secret-scan` | 1 required markers | 0 |
| `npm run typecheck` | successful command | 0 |
| `npm run lint` | successful command | 0 |
| `npm run build` | successful command | 0 |
| `npm run test` | 26/78/20/5/76 | 0 |
| `node --test tests/media/r2-network.test.cjs tests/media/r2-transport.test.cjs tests/media/reconciliation.test.cjs tests/media/reconciliation-r2.test.cjs tests/media-harness/assignment-mutations.test.cjs tests/media-harness/quality-gate.test.cjs` | 143/55 | 0 |
| `npm run test:db:sprint0:ci` | 65 | 0 |
| `npm run test:authz:db:ci` | 4 | 0 |
| `npm run test:tenant-context:db:ci` | 27 | 0 |
| `npm run test:api:multitenant:ci` | 4 | 0 |
| `npm run test:tenant-context:api:ci` | 75 | 0 |
| `npm run test:api:security:ci` | 12 | 0 |
| `npm run test:cross-tenant:final:ci` | 25 | 0 |
| `npm run test:reception:db:ci` | 24 | 0 |
| `npm run test:reception:upgrade:ci` | 20 required markers | 0 |
| `npm run test:reception:api:ci` | 123 | 0 |
| `npm run test:runtime:db:ci` | 1 required markers | 0 |
| `npm run test:db:migration-lock:ci` | 1 required markers | 0 |
| `npm run test:media:api:ci` | 621 | 0 |
| `npm run test:media:upgrade:ci` | 22 required markers | 0 |
| `npm run test:media:assigned:mutations:ci` | 1 required markers | 0 |
| `node scripts/test-reception-mutations.cjs` | 1 required markers | 0 |
| `node scripts/test-signature-api-mutations.cjs` | 1 required markers | 0 |
| `node scripts/test-close-api-mutations.cjs` | 1 required markers | 0 |
| `node scripts/test-reception-queries-mutations.cjs` | 1 required markers | 0 |
| `node scripts/test-reception-contract-mutations.cjs` | 1 required markers | 0 |
| `node scripts/test-inspection-mutations.cjs` | 1 required markers | 0 |

| Final regression command / ambient condition | Executed count | Exit |
| --- | --- | --- |
| `DATABASE_URL=<fresh local PG18.6> node --test tests/media-harness/quality-gate.test.cjs` | 55/55; live positive/negative catalog checks; zero fail/skip/cancel/todo | 0 |
| `node scripts/test-s4-quality-gate.cjs --media-only --report <temp JSON>`; normal environment | 224 + 55 unit/harness, 621 API; 17 upgrade scenarios/22 markers | 0 |
| Same command; exact `npm_config_node_options` pattern quoted above | 224 + 55, **621/621 API**; 17 scenarios/22 markers | 0 |
| Same command; exact uppercase `NPM_CONFIG_NODE_OPTIONS` pattern | 224 + 55, **621/621 API**; 17 scenarios/22 markers | 0 |
| Same command; temporary HOME `.npmrc` contains `node-options=<exact pattern>` | 224 + 55, **621/621 API**; 17 scenarios/22 markers | 0 |
| Same command; npm no-match pattern plus TEST_NAME_PATTERN/TEST_FILE_FILTER | 224 + 55, **621/621 API**; 17 scenarios/22 markers | 0 |
| Same command; NODE_OPTIONS and npm_config_node_options both request spec | 224 + 55, **621/621 API**; 17 scenarios/22 markers | 0 |
| Permanent simulated-summary regressions: 34/621, zero, failures, skips, cancellations, todo, missing/malformed/duplicate/contradictory summary, spec/custom reporter | Each invalid gate result rejected with exit 1; included in harness 55/55 | 0 (harness) |
| Permanent actual-child failure / unexpected exit / SIGTERM / missing summary | Gate exits 1 / 7 / 143 / 1; included in harness 55/55 | 0 (harness) |
| Populated own post-run container: gate `--media-only` | `DISPOSABLE_CLUSTER_NOT_FRESH`; **zero suites launched**, no PASS marker | 1 (expected) |
| Literal `npm run typecheck`, `npm run lint`, `npm run build` | Compiled; lint clean | 0 each |
| Literal `npm test` | 26/78/20/5/76 = **205**, zero fail/skip/cancel/todo | 0 |
| Secret scanner with OS-temp alternate index/objects including all 10 patch files | SECRET_SCAN_PASS; real index unchanged | 0 |
| `git diff --cached --check` using that alternate index; `git diff --check` | New and tracked-file whitespace clean | 0 each |
| Ruby/Psych CI YAML parse and local structural assertions | Separate PG18.6 service, localhost URL, ack and retained mutation step | 0 |

All six final CI profiles report scope PASS, backend **NOT_RUN**, Sprint **BLOCKED**,
production **NOT_READY**. Backend PASS is confined to the complete final full run.

Failed/intermediate execution history is retained separately and never counted as
PASS. The original exact bypass returned exit 0 with 238 unit/harness and 34 API
tests. An exploratory incomplete pattern (`assigned`) failed on fixture hooks and
a timeout. Initial concurrent verification yielded 608/607/1 cancelled (full),
607/606/1 cancelled (lowercase injection), and 608/607/1 cancelled (uppercase),
all **exit 1, AUTOMATED_FAIL**. The associations file hit its existing 60-second
timeout; concurrency coincided with higher durations, but the exact causal chain
was not established. A first CI container readiness race failed startup before
launching suites; readiness was subsequently checked on TCP rather than the
initialization socket. An early embedded fake password in the new CI URL was
rejected by the secret scanner and corrected to the dedicated trust-auth service.
The final serial normal/injection matrix and final full run passed without relaxing
any test. These observations do not resolve F-4/F-5 or the earlier two flaky failures.

### Final source identity and Git state

Source manifest SHA-256, excluding this self-referential report:
**`dfd6d38871f6cfca5a904c0ec829f70e9b6480cd82756dc2ba4b85ca6773072b`**. The exact nine-file manifest is embedded below; recompute each file
hash, join these sorted `<sha256>  <relative path>\n` lines as UTF-8, then hash the
joined manifest. This durable record supersedes the historical §9 source digest.

```text
83f0679ba73cc4ade16bd2e39c9f48164e663e0097804b7277605089e6537352  .github/workflows/ci.yml
4035b5d6a56cbcf56c0bf805df847a0a85928279eb02737c7bb315885fcf2ab5  .gitignore
55f11acc56acc40b22a6bba1587bcc9573fb601adf22e197e3a5db85bed7a60e  package.json
507ff0f13261828394761728839f343ed51c9c63288d1964b54530fab623490e  scripts/s4-quality-coverage.json
a47e7545049beef02519a57f85557531485879e55915c38fe5351e1dd17f223a  scripts/test-s4-quality-gate.cjs
ff4cdac09ccf776916bdcb992f00ffc128637d8fcc029ae45e8ad13aebc66908  tests/media-api/final-quality-gate.test.cjs
a92ebf91bd7a29ac125a25af5790deb676702f5510388e2782eb05a4587374e8  tests/media-api/idempotency.test.cjs
bddc7756b2b27aafa215674a32bbbf797dbe8cd68a4a737a39f5e95a9edc956f  tests/media-api/integrity.test.cjs
bfde42ff7b55395a392806fe4b946ef1364c7daa057d1d18a8266ada3df795ba  tests/media-harness/quality-gate.test.cjs
```

Branch: `task/s4-b09-media-quality-gate`. HEAD remains
`8e52adee1870f39e19774efa8865d70b288ef7f9`. Worktree:
`/Users/ivanby/Documents/Proyectos/TallerMecarioB-worktrees/s4-b09-media-quality-gate`.
**5 modified tracked files + 5 new canonical files, all unstaged**; no commit, push
or PR. Tracked modifications: `.github/workflows/ci.yml`, `.gitignore`, `package.json`,
`tests/media-api/idempotency.test.cjs`, `tests/media-api/integrity.test.cjs`.
New files: this report, `scripts/test-s4-quality-gate.cjs`,
`scripts/s4-quality-coverage.json`, `tests/media-api/final-quality-gate.test.cjs`,
`tests/media-harness/quality-gate.test.cjs`. Main checkout is clean on the same SHA.

Final cleanup: the borrowed `node_modules` symlink and disposable helper scripts,
original-runner copy, injected HOME and alternate Git index/objects were removed.
All own matrix containers and anonymous volumes were removed; the final full-run
container was inspected then removed with its volume. The full-run inventory showed only the `postgres` database and 10 canonical
TallerMecario roles plus `postgres`, with no fixture roles/databases. The fixture
inventory and cleanup result are retained in temporary JSON. Raw synthetic logs/JSON remain
outside the repository under `/tmp/s4-b09-remediation` as disposable review aids.
No source dependency on those logs or helper files remains. Worktree retained
because it contains the requested uncommitted review patch.

S4-B09 READY FOR TARGETED RE-REVIEW


## S4-GAP-01A — 2026-10-17: media por orden, sin cierre de N§7.23

El responsable del producto aprobó D01–D07 el 2026-10-15, según el encargo expreso
aportado por el usuario; no se consultó Notion. [Contrato y evidencia 01A](../S4-GAP-01-order-media-query-contract.md),
§§0 y 14, registran alcance, procedencia y decisiones nuevas. M01–M04 permanecen
sin aprobación; no se habilitan familias futuras, uploads técnicos ni purga física.

El backend implementa GET /api/v1/orders/:orderId/media (media.read resource),
recepción/daños exclusivamente, source discriminado, paginación contextual cifrada,
validación por asset y presupuesto 1000/2s/8s/15s. Se reproduce y corrige por separado
la emisión tenant-wide sin locks frente a un tombstone concurrente, preservando
las descargas históricas permitidas. Ambos ganadores de carrera tienen pruebas.

Gate completo local de 27 pasos: **PASS, exit 0** en PostgreSQL 18.6 desechable y
storage simulado. `npm test`: 205; media API: **725/725**, incluidos 104 casos nuevos;
B07: seis mutaciones detectadas; todas las mutaciones de regresión S3: PASS.
El piso API del contrato de cobertura pasa **621 → 725** después de verificar el
conteo completo, y vuelve a pasar dentro del gate completo. No se rebajan pisos
ni se suprimen skips/failures. Typecheck/lint/build, multitenant/runtime/permisos,
upgrades, secret scan y diff checks pasan; detalle/comandos en contrato §14.5.

La fila histórica #23 de §2 describe el baseline B09 anterior a esta aprobación.
Estado vigente: contrato backend aprobado e implementación local verificada;
**aceptación N§7.23 todavía BLOCKED**, pendiente frontend y aceptación integrada.
Full Sprint 4 sigue BLOCKED y producción NOT_READY; el runner conserva expresamente
ese bloqueo. Los demás pendientes de B01–B09 no se cierran por este cambio.
Sin modificación frontend/schema/migraciones/grants, commit, push, PR o R2 DELETE real.


## S4-GAP-01A — remediación F1–F6 tras revisión adversarial

[Contrato §15](../S4-GAP-01-order-media-query-contract.md) conserva hallazgos,
criterios, tiempos, resultados negativos y la matriz final de 27 pasos. F1 conserva
locks tenant-wide y aplica adquisición 2 s, lock 2 s, sentencia 8 s y admisión
por pool a GET/HEAD. ROLLBACK precede a release; reservas tardías no abren tx.
F2 clasifica 40P01 real como 503 sin retries y documenta el protocolo B05.

F3: ocho guards retirados en compilados temporales produjeron los fallos previstos
(M03/M15/M16/M20/M27/M29/M34b/M34c); cero supervivientes o inválidos. F4: templates
sin material y aviso fijo de ruta deshabilitada; clave inválida falla pre-pool.
F5: desfase +1 ms sigue fallando cerrado, TTL exacto 15 min; UTC sincronizado es
requisito operativo. Se rechazan JSON ambiguo y claves de bytes repetidos.
F6: piso independiente >=725; copias JSON 724/621 fallan el harness, mientras
se permiten aumentos legítimos. No se rebajan otros requisitos de cobertura.

Gate FINAL sobre fuentes congeladas: **27/27 PASS, exit 0**. Media API **747/747**
(22 regresiones nuevas de remediación; piso 725 → 734 → 747 tras conteos completos),
harness **59/59**, unit **205**, B07 **6 mutaciones detectadas**, mutaciones S3 PASS.
Un intento F1/F2 fue invalidado por reposo y luego repetido con éxito; el gate
intermedio 734/734 y el final 747/747 tienen reportes separados. Sin omisiones,
skips, cancelaciones o ampliación de umbrales para pasar.

**S4-GAP-01A READY FOR TARGETED RE-REVIEW.** N§7.23/Full Sprint 4 BLOCKED y
producción NOT_READY continúan. Sin commit/push/PR, frontend/schema/migraciones/grants,
nuevos propósitos, duración de video inventada, purga productiva o B07 Phase B.


## S4-GAP-01A — F1-N1 disponibilidad final, 2026-10-18

[Contrato §16](../S4-GAP-01-order-media-query-contract.md) registra reproducción,
diseño, límites, matrices y digest final. El baseline inmediato era 747/205/59,
8 mutantes focalizados, 6 B07 y 27 pasos; 621/725 se conservan como historia.
La admisión mantiene pool.max−1 activos, añade 64 esperas FIFO de hasta500ms sin
conexión mientras se espera y conserva adquisición2s/lock2s/sentencia8s. Cancelación
y entregas tardías limpian sus recursos; SQL en vuelo termina antes de ROLLBACK/release.

Ráfagas sanas reales: 672/672 HTTP200 tras el cambio frente a 270 HTTP200 / 402 HTTP503 antes,
incluyendo 10/12/20/40 GET y HEAD, mezclas y dos tenants, tres repeticiones. E1
retiene workshop/recepción/asset por separado; E2 demuestra progreso de clientes y
galería B con A bloqueado. La cola global no es una cuota por tenant: otras
descargas pueden expirar cuando un tenant ocupa todos los activos. No se promete SLA.

Regresiones nuevas: 14 media API sobre747 → **761/761**, piso aumentado tras conteo
completo y confirmado en gate final. Generales **205**, harness **59/59**, gate
**27/27 PASS, exit0**. Mutantes focalizados **10/10** (incluye rechazo inmediato y
rollback omitido); CI los invoca explícitamente con timeout5min, sin ejecución remota.
B07 **6/6**; S3 completo PASS. Tests, fuentes congeladas, comandos e inventario en §16.

**Merge BLOCKED hasta revisión independiente del nuevo candidato.** N§7.23/Full
Sprint4 siguen BLOCKED y producción NOT_READY. Sin commit/push/PR, frontend,
schema/migraciones/grants, nuevos propósitos/duraciones, purga ni B07 PhaseB.
