# S4-B07 — Assigned technician media authorization

Base `b5f192f`, branch `task/s4-b07-assigned-media-access`. Implementation
uses the supplied B07 contract and the canonical B04/B05/B06 repository contracts.
No Notion browsing, domain/schema changes, historical migration edits, commit or push.

## Existing lifecycle feasibility

`closeReception` atomically closes the reception and creates its one service order.
Open receptions have no order; closed receptions have exactly one. Assignments
reference existing orders. B04 operational create/replay/completion/attach require
an open reception and immutable reception/damage/initial-consent binding.

Assigned reads of historical intake/damage evidence are therefore feasible.
None of the four existing upload operations can simultaneously satisfy an active
order assignment and B04 open-parent eligibility. Their tenant-wide route guards
remain intact; a technician cannot receive a PUT URL or enter external inspection.

The precise missing contract is an order-level operational upload/association
binding: approved order resource/target and purpose, allowed order lifecycle,
consent source and historical authorization, immutable session evidence, tenant
constraints, retention/audit semantics, and the concurrency/locking protocol.
That contract must be supplied before extending media.upload. Reception editability
and pre-order assignments are not inferred or weakened.

## Read and direct-download authorization

The two media-list routes and direct download declare `media.read`, resource scope.
Tenant-wide grants retain the existing services and skip assignment checks.
Restricted grants resolve the verified membership through PostgreSQL RBAC and
active lead/support assignments, never client flags, order IDs or asset creators.
Quality-control-only, unrelated and released assignments do not authorize media.

Restricted reads first take the existing membership administration lock hierarchy:
owner-mutation gate/workshop, then active caller membership FOR SHARE and fresh
media.read grant. They then use the unchanged B05 sorted reception → damage →
order → upload-session → asset graph locks, and finally matching assignment rows
FOR SHARE. This makes status/role changes and assignment release serialize with
capability issuance. The tripwire is marked only after validating the resource.

A technician download requires active operational photo/video/video360, no
quarantine/integrity failure and no deletion/tombstone/purge markers. Every
reception/damage association must have canonical purpose and authoritative tenant
lineage, a closed reception's one order and a current lead/support assignment.
Every session must be completed with matching immutable B04 evidence and the
same binding identity. Historical consent is validated without reinterpreting
later consent revocation, as required by B04.

All nine reference families are examined. Signature and privacy evidence are
denied even when asset metadata looks operational. Finding/work-activity/QC/
delivery/quote families have no B04 canonical association/read API contract and
fail closed. Missing/unattached/conflicting/ambiguous evidence also denies.
A binding by itself is not a final association and cannot authorize a download.

Restricted lists validate the actual reception/damage and filter each asset
through that same full graph; unsafe or inactive evidence is omitted. Discovery
is not returned, and batch graph locks preserve sorted tiers across multi-links.
Malformed/foreign/unassigned IDs return non-disclosing 404; missing route-level
permissions retain 403. Denied requests never create a signed GET URL.

The existing 300-second URL TTL and expiration DTO remain. Download responses now
explicitly use Cache-Control: no-store, including errors. No signed URL/key/credential
is added to logs, audit events or list DTOs. Issued URLs remain usable until expiry;
assignment revocation does not recall a capability already issued before revocation.

## Concurrency and unchanged invariants

A committed release that wins the assignment row lock is rechecked and denied.
An authorized reader that wins keeps the row lock through synchronous signing and
request commit; release waits and subsequent requests deny. Fresh grant checks
also deny a role/status revocation committed after request-start RBAC.

Technician completion is denied before R2 inspection, so there is no supported
technician upload flow in which assignment release can race finalization. The
existing external-inspection reauthentication still protects tenant-wide uploads;
a regression removes their tenant-wide grant during inspection and verifies
failed finalization and failed replay under the same idempotency key.

No production media mutation or destructive R2 operation is introduced. B04
association/binding/lock order, B05 retention clocks/holds, B06 deletion/purge/
reconciliation guards, signature immutability, privacy protection and PostgreSQL
FORCE RLS/NOBYPASSRLS privileges are unchanged. No migration is needed.

## Verification

Permanent API and PostgreSQL regressions are in
`tests/media-api/assigned-authorization.test.cjs` and run automatically in
`npm run test:media:api:ci`. They use disposable PostgreSQL 18, NOBYPASSRLS API
sessions, fake R2 inspection and PostgreSQL lock barriers, not timing sleeps.
Fixture-only corruption probes disable triggers only inside privileged local
transactions; normal API/runtime SQL probes keep all guards enabled.

`npm run test:media:assigned:mutations:ci` validates its unmodified control,
mutates only temporary compiled artifacts, requires behavioral failures and
fixture cleanup, and detects six mutations: accepting released/QC assignments,
ignoring sensitive references or binding consensus, omitting the tripwire mark,
and dropping the assignment lock. The shared test harness adds only this opt-in
media-specific mutation hook; normal production behavior is unaffected.

## Operational limits and review

Restricted reads currently serialize through the existing per-tenant workshop
lock, and list authorization locks the complete discovered graph without new
pagination. This conservative choice preserves the existing membership and media
lock protocols; load/performance tuning should be assessed during review.

Authorization is checked at issuance, not each future storage GET. URLs use the
existing short client-visible expiry. Newly discovered graph changes fail closed
through the existing lineage-change guard. No automatic read retry or new upload
contract is introduced. The independent adversarial review of Phase A found no
security bypasses; its two merge-required CI corrections are addressed below.

## Quality gates — 2026-10-10

PostgreSQL 18.6 in a disposable local container; fake/local R2 only. Counts
overlap across suites and must not be added as unique test totals. All final gates
exit 0. The original production-media 403 expectation was updated for the new
404 assigned-resource contract; its complete reception API gate was rerun.

| Command | Result | Count | Exit |
| --- | --- | --- | --- |
| `npm run test:media:api:ci` | PASS | 593 tests | 0 |
| `npm run test:media:purge:ci` | PASS | 125 tests | 0 |
| `npm run test:reception:api:ci` | PASS | 123 tests | 0 |
| `npm run test:reception:db:ci` | PASS | 24 tests | 0 |
| `npm run test:tenant-context:api:ci` | PASS | 75 tests | 0 |
| `npm run test:tenant-context:db:ci` | PASS | 27 tests | 0 |
| `npm run test:db:sprint0:ci` | PASS | 65 tests | 0 |
| `npm run test:media:upgrade:ci` | PASS | 12 scenarios | 0 |
| `npm test` | PASS | 205 tests | 0 |
| `npm run typecheck` | PASS | 0 errors | 0 |
| `npm run lint` | PASS | 278 files | 0 |
| `npm run build` | PASS | 0 errors | 0 |
| `npm run security:secret-scan` | PASS | 0 findings; 5 new files included via disposable Git index | 0 |
| `git diff --check` | PASS | 0 whitespace errors; new files also checked via disposable Git index | 0 |
| `npm run test:media:assigned:mutations:ci` | PASS | 45 control tests; 6/6 mutants detected | 0 |

The real staging index is unchanged. All temporary test databases/roles created
by passing runners are cleaned up. The disposable PostgreSQL container and its
volume are removed at delivery, including any interrupted fixture. No production
storage request, commit or push was performed. These are the original Phase A
gates; the targeted post-review verification is recorded below.

## Targeted CI review fixes — 2026-10-11

F6-1 registers the exact `npm run test:media:assigned:mutations:ci` command in
`.github/workflows/ci.yml`, inside the existing `mutations` job immediately after
the complete reception mutation gate. A preceding dedicated step runs the runner's
failure-mode regressions. Both steps execute serially under the existing pull-request
condition, fail on nonzero exit, and have no skip or failure suppression. The job's
PostgreSQL 18 service, `needs: validate`, ambient spec reporter, and every prior
mutation step/condition remain unchanged; no concurrent database job is added.

F6-2 accepts complete TAP (`#`) and spec (`ℹ`) control summaries. For actual child
test processes, this runner explicitly replaces only its child environment's
`NODE_OPTIONS` with `--test-reporter=tap`. This makes diagnostic parsing independent
of the ambient reporter and provides structured evidence of the intended mutation.
The global CI reporter stays spec for the existing runners. Child color output is
also disabled to preserve machine-readable diagnostics.

A passing control requires a zero process exit, no signal/spawn error or infrastructure
stderr, a nonempty complete summary with zero failures/cancellations/skips/todos,
and successful migration and fixture cleanup. A killed mutant additionally requires
its application marker, exit 1, the expected harness error, and every selected test
failing with the intended diagnostic: 200 instead of 404 for unauthorized disclosure,
500 instead of 200 for the missing tripwire, or the named PostgreSQL assignment-lock
barrier timeout for the omitted row lock. Missing/ambiguous summaries, surviving or
invalid mutants, wrong assertions, hook/query errors, and cleanup/infrastructure
failures stop the gate. An arbitrary nonzero exit is never counted as a kill.

Verification used Node 22.23.3 and PostgreSQL 18.6 in a disposable local container,
with serial database suites and fake/local R2 only. Each command below exited 0.

| Command | Result |
| --- | --- |
| `node --test tests/media-harness/assignment-mutations.test.cjs` | 47/47 PASS |
| `NODE_OPTIONS=--test-reporter=spec node --test tests/media-harness/assignment-mutations.test.cjs` | Same 47/47 PASS |
| `npm run test:media:assigned:mutations:ci` | Control PASS; 6 killed, 0 survived, 0 invalid |
| `NODE_OPTIONS=--test-reporter=spec npm run test:media:assigned:mutations:ci` | Control PASS; 6 killed, 0 survived, 0 invalid |
| `npm run test:media:api:ci` | 593/593 PASS; fixture cleanup PASS |
| `npm test` | 205 tests PASS across the standard suites |
| `npm run lint` | PASS; 279 files, no fixes |
| `npm run typecheck` | PASS; 0 errors |
| `npm run build` | PASS; 0 errors |
| `git diff --check` | PASS; untracked targeted files checked separately |

The same six outcomes were observed in both ambient reporter environments; child
diagnostics intentionally use TAP in both.

| Mutant | Default environment | Ambient spec environment | Intended failures per run |
| --- | --- | --- | --- |
| `accept_released` | KILLED | KILLED | 1 |
| `accept_qc` | KILLED | KILLED | 1 |
| `ignore_sensitive_graph` | KILLED | KILLED | 1 |
| `ignore_binding_consensus` | KILLED | KILLED | 1 |
| `omit_tripwire_mark` | KILLED | KILLED | 2 |
| `omit_assignment_lock` | KILLED | KILLED | 1 |

Failure-mode tests cover both summary formats, explicit child reporter selection,
failed controls (including zero exit with failed tests), nonzero exits with passing
summaries, absent/ambiguous/empty/inconsistent summaries, cancelled tests, spawn
errors/signals, surviving/invalid mutants, unrelated assertions and infrastructure
errors, missing mutation/migration proof, and failed fixture cleanup.

Final diff review is limited to the workflow, assigned-media mutation runner, its
new failure-mode tests, and this document. Initial hashes confirm all other Phase A
files are unchanged. No production authorization, schema, migrations, or B04/B05/B06
behavior is changed by these corrections. All disposable databases and test roles
were absent after the passing suites; the PostgreSQL container and volume were
removed. All work remains uncommitted and unpushed on the supplied branch.

## Remaining nonblocking risks from independent review

- Order-terminal-state read policy remains an explicit future decision; this
  targeted correction adds no terminal-state rule.
- A future media reference family requires a catalog/inventory guard so the
  complete graph authorization cannot silently omit a new reference table.
- Assigned reads serialize under a tenant-wide lock. Load validation and bounded
  response size remain necessary before production rollout.
- Existing presigned GET URLs can remain valid for up to 300 seconds after
  assignment revocation; revocation prevents subsequent issuance, not an already
  issued capability.
- Assigned-order uploads remain blocked pending their separate operational
  contract described above. Phase B is not implemented.

S4-B07 PHASE A — READY FOR TARGETED RE-REVIEW
