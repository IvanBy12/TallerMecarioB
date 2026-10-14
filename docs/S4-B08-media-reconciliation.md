# S4-B08 — Media Reconciliation & Observability

Implementation date: 2026-10-11. Repository `IvanBy12/TallerMecarioB`, branch
`task/s4-b08-media-reconciliation`, base `9732aec`. Changes remain uncommitted and
unpushed. This is a read-only operational scanner, with no HTTP/public endpoint,
repair command, automatic purge, or production scheduling/activation.

## Authority and verified infrastructure

Read `AGENTS.md`, B01 §§5/11/13/15, B05, B06 and B07. Relevant local Notion exports
were read from the primary checkout: Operation/Retention/Recovery/Observability
§§1–3.5 and 6.6–6.7, Security Baseline §14, and ADR-009. Notion was not browsed.
B01 provides the schema/ERD authority; actual schema and migrations through 0029
were inspected and then exercised on disposable PostgreSQL 18.

`media_assets` retains pending/uploaded/active/quarantined/deleted metadata;
`purged_at` is a marker, not another enum. Composite tenant FKs, global UNIQUE
(storage_provider,bucket,object_key), FORCE RLS, immutable session expectations,
B05 retention/holds, B06 jobs/leases/parked reconciliation, and B07 authorization
are preserved. Metadata is never deleted by this scanner. All nine reference
families remain protected by B05/B06. B08 needs existence/lifecycle observations,
not an eligibility decision, so it does not recalculate retention or interpret
unresolved privacy clocks/external hold linkages.

## Architecture and scope

`src/media/reconciliation.ts` separates bounded orchestration from authoritative
PostgreSQL reads and provider inspection. `reconciliation-r2.ts` supplies only
HEAD and ListObjectsV2 GET. It reuses the existing SigV4 signer; binary GET,
PUT, DELETE and bucket/configuration mutations are absent from this adapter.
The existing completion/delete transport semantics remain unchanged.

`src/worker/media-reconciliation-run.ts` is an explicit one-shot operator process.
It requires exact `MEDIA_RECONCILIATION_ENABLED=true`, a dedicated restricted
`MEDIA_RECONCILIATION_DATABASE_URL`, canonical `MEDIA_RECONCILIATION_TENANT_IDS`,
and a secret `MEDIA_RECONCILIATION_REPORT_KEY` of at least 32 characters.
Use independently generated high-entropy report material, not a password or R2 key.
It uses the existing R2 environment names, with separately scoped read-only
credentials. No ordinary worker/Docker/API startup launches it. Nothing enables
`MEDIA_PURGE_ENABLED` or starts the production purger.

Defaults: page size 50, at most 10 database pages total across configured tenants,
10 inventory pages, HEAD concurrency 4, duration 30 seconds. Operator knobs:
`MEDIA_RECONCILIATION_PAGE_SIZE` (1–100), `MAX_DATABASE_PAGES` (1–100),
`MAX_INVENTORY_PAGES` (1–100), `CONCURRENCY` (1–16), `MAX_DURATION_MS` (1–120000),
all with the `MEDIA_RECONCILIATION_` prefix. At maximum, inventory memory is bounded
by 10,000 keys; only 50 redacted anomaly samples are emitted. Database pages use
(tenant,id) keyset pagination; LIST uses opaque continuation tokens. Repeated
keys/tokens and invalid page shapes fail closed. Exactly-full final database pages
need a subsequent empty page to establish completeness.

There is no durable checkpoint: a partial/cancelled/interrupted scan is rerun from
the beginning with appropriate bounded limits. No stale cursor is treated as a
complete inventory. Very large buckets exceeding a full bounded run need a future
reviewed inventory/checkpoint design; this implementation reports partial and
suppresses orphan promotion. Configuration is operator-controlled, never client input.

## Reconciliation classifications

| Classification | Meaning |
| --- | --- |
| `active_exists` | HEAD 200 and unchanged current active metadata. Existence only; no integrity certification. |
| `active_missing` | HEAD 404 in configured storage and unchanged current active metadata. Point-in-time absence; no mutation. |
| `pending_upload` | Current pending, unexpired upload session; presence or absence is expected during PUT/completion. |
| `incomplete_upload` | Pending-upload asset without a current pending capability. Not an orphan or a deletion decision. |
| `uploaded_unverified` | Uploaded lifecycle, not activated. Scanner does not validate bytes or activate it. |
| `quarantined` | Quarantine metadata, with separate exists/missing observation. Never reactivated or purged. |
| `deletion_in_progress` | Deleted/requested/tombstoned, unpurged metadata. Neither an active loss nor an orphan. |
| `reconciliation_required` | B06 parked incident. Scanner reports it but cannot clear/resume/confirm the job. |
| `purged_absent` | Historical purged metadata and HEAD 404; expected absence. |
| `purged_object_present` | Purged metadata but HEAD 200; investigate possible late PUT, wrong target or confirmation drift. |
| `metadata_object` | LIST object matches authoritative metadata in any tenant and any state. Global probe reveals no owner/state. |
| `orphan_candidate` | Complete scan, successful fresh HEAD and repeated global metadata absence. Candidate for manual investigation only. |
| `orphan_observation` | Provisional unmatched LIST observation; incomplete/failed scan prevents candidate promotion. |
| `inventory_changed` | Listed unmatched object disappears before HEAD. No destructive repair follows. |
| `lifecycle_changed` | Asset/session/job fingerprint changed between DB read and HEAD revalidation, or metadata disappeared. |
| `uncertain` | Storage/DB/configuration/protocol observation failed. No absence assertion. |

## Missing-object detection and storage failures

HEAD targets bucket/key/provider taken only from internal metadata. A bucket/provider
mismatch is `metadata_configuration`; the scanner never probes a guessed alternate
target. HEAD alone supplies absence; omissions from LIST never do. An active missing
observation does not change status, deleted_at, purged_at, retention, holds, sessions,
references, jobs or audit records. A held active absence carries only a boolean hold
indicator and escalates an alert without exposing a hold reason.

Each provider attempt has a 2-second timeout, with up to three attempts for safe
reads, 50/100 ms retry backoff, and the overall cancellation/deadline signal.

| Condition | Normalized failure / behavior |
| --- | --- |
| HEAD 404 | `missing`; no retry, only after lifecycle revalidation. |
| LIST 404 | `not_found`; bucket/access/configuration diagnostic, never object absence. |
| 401/403 | `access_denied`; no retry or missing classification. |
| 429 | `rate_limited`; bounded retries, then uncertainty. |
| 5xx | `provider_failure`; bounded retries, then uncertainty. |
| Deadline | `timeout`; bounded retries unless overall signal cancelled. |
| Network failure | `network_failure`; bounded retries. |
| Cancellation | `cancelled`; no new work or retry. |
| Redirect/invalid XML/page | `protocol_failure`; no empty-list fallback. |

Responses/bodies/URLs/headers/errors are never included in reports. LIST body reads
are capped at 512 KiB. The strict subset XML reader rejects DTD/entity expansion,
unsupported/malformed structure, duplicate required fields, invalid key counts,
wrong bucket/prefix, duplicate keys, missing/repeated tokens and unrecognized entity
syntax. URL-encoded keys are decoded once. Unsupported protocol forms deliberately
fail closed instead of claiming an empty inventory.

Protocol references: [Cloudflare S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
and [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
These document protocol support, not evidence of this deployment's actual permissions.

## Orphan detection and privileged existence boundary

A tenant prefix is not authoritative ownership. A valid legacy object key can be
referenced by another tenant, and there is no tenant-prefix CHECK. Tenant-scoped
queries alone cannot safely determine global absence. This is the demonstrated
reason for migration **0030**, which adds no table, column, index or data rewrite:

- `tallermecario_media_reconciler`: NOLOGIN, NOINHERIT, NOBYPASSRLS, no superuser,
  DDL, lifecycle memberships or writes. Allowlisted operational SELECT columns on
  media_assets/upload_sessions/media_purge_jobs, under tenant SELECT policies.
- `app.media_storage_metadata_exists(text,text[])`: bounded 1–100-key probe of
  provider/bucket/key identity, with no lifecycle filter. Returns only supplied keys
  and existence booleans. No tenant, ID, PII, hold reason or other metadata escapes.
- SECURITY DEFINER owner is `tallermecario_media_inventory_owner`: NOLOGIN,
  NOINHERIT, NOBYPASSRLS, no elevated attributes or persistent memberships. Only
  SELECT(storage_provider,bucket,object_key) on media_assets and schema USAGE
  remain. The exact-owner SELECT policy applies only to this role; schema_owner
  has no B08 global SELECT policy. FORCE RLS is retained. Fixed
  `search_path=pg_catalog`, qualified references, validation and boolean results
  are unchanged. Only the reconciler has delegated EXECUTE; the function owner
  retains PostgreSQL's inherent ownership rights but cannot be assumed by runtimes.
  The B06 migration lifecycle grants temporary SET membership and schema CREATE,
  creates the helper under its isolated owner, then revokes both. PostgreSQL 18
  clean migration, upgrade, no-op ledger rerun and atomic rollback are tested.
  Role creation requires the same privileged offline provisioning boundary as B06;
  unexpected persistent membership or broad reads/writes fail the migration closed.

Global existence includes pending, completed, failed/expired uploads, quarantine,
tombstones, purged and signed/linked historical metadata. LIST pagination must finish
successfully and the configured DB sweep must complete before candidates are
promoted. Unmatched objects receive HEAD and another global lookup after LIST.
Any scan failure, cancellation, incomplete page budget or metadata configuration
error suppresses all orphan promotion. There is no age heuristic or orphan DELETE.

A bucket-wide LIST includes namespaces outside configured tenants; only global
booleans and redacted references leave that inventory. Tenant-scoped lifecycle
observations apply only to the explicit operator tenant list; a complete run does
not certify active availability for omitted tenants. Inventory completeness means
valid provider pagination finished, not a transactionally frozen bucket snapshot.

## Races with B05/B06 and uploads

No PostgreSQL transaction or graph/fence lock is held during network I/O. Every
metadata HEAD is followed by a fresh tenant query and fingerprint comparison of
asset identity/state, B05 floor/hold, session status/creation/expiry and B06 job
state/storage outcome. A committed completion/quarantine/retention/hold/delete/purge
change invalidates the prior observation. Current expiry/hold booleans use the DB
clock. The scanner never evaluates retention eligibility and never competes for a
physical purge lease. All existing B05/B06 writer coordination remains unchanged.

Pending capabilities and uploaded objects can coexist. Uncompleted/expired session
metadata still prevents an orphan classification. A tombstoned object remains
legitimate until the B06 lifecycle completes. A purged row remains historical
metadata even if a late PUT recreates a key. B06 reconciliation_required stays parked.

There is no atomic PostgreSQL/R2 snapshot. A change after the final re-read is
possible. Reports are observations, not durable absence/repair capabilities. Repeat
and investigate candidates before any separately approved incident/remediation.
A scan cannot recover already lost evidence or resolve B06's late-hold policy.

## Security, reporting and startup

The dedicated deployment connects with a separate NOINHERIT login whose only role
membership is reconciler, using SET privilege without inheritance. Provision through
normal DBA controls; never use API, normal worker, purger or migrator credentials.
A minimal DBA provisioning template (set its password through the secret store/
interactive PostgreSQL controls, never a literal in source or shell history):

```sql
CREATE ROLE tallermecario_media_reconciliation_runtime LOGIN NOINHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT tallermecario_media_reconciler TO tallermecario_media_reconciliation_runtime
  WITH INHERIT FALSE, SET TRUE;
```

The values-empty `.env.example` documents the disabled configuration. After provisioning
and setting an approved tenant scope in a protected environment, build and explicitly
run `npm run worker:media-reconciliation`. A scheduler may invoke that one-shot command
under reviewed operational controls; B08 does not create a schedule.

The entry point rejects elevated session/effective roles, relation ownership,
additional memberships/reads/writes and execution of unrelated privileged app
functions; it verifies FORCE RLS on all three tables. The connection defaults to
read-only transactions. Each metadata transaction independently uses BEGIN READ ONLY,
transaction-local tenant context, 2-second statement and 500-ms lock timeouts.
Reservation cancellation releases late-arriving connections. In-flight SQL finishes
within its statement timeout; signal cancellation prevents subsequent queries/work.
No borrowed context remains in the pool.

Reports contain version, random run ID, timestamps, completion flags, bounded counts,
closed-enum failures/alerts and HMAC references. `scope: configured_tenants`,
`tenantsRequested`, `tenantsWithRows`, `databaseRows` and `tenantCoverage` explicitly
report the configured scope. Each coverage entry has a tenant HMAC reference, row
count and `not_started`/`partial`/`complete`/`failed` status (at most 100 entries).
Rows count validated metadata returned by pages, including fetched rows whose HEAD
was skipped after cancellation; they are not a verified-object denominator. A
completed empty metadata scope emits `scope_empty`; completed zero-row tenants in
a mixed scope emit `scope_coverage_gap`. Both are operational warnings and exit 2,
while enumeration may still be complete. Failed/unvisited sweeps never certify
empty coverage. A valid empty tenant and a nonexistent tenant both mean no media
metadata was found; the scanner deliberately cannot certify workshop existence
without broader reads. Resolve the HMAC reference in an authorized operator session
and verify the configured list; do not create synthetic assets. No tenant/asset ID, bucket, key,
credentials, URL, filename, SQL exception, stack, PII or provider body is emitted.
Keep the report key in the secret store and stable to correlate repeated findings;
rotate it under normal operational controls. References cannot be used to download
objects. Sampling reserves one deterministic minimum reference per observed anomaly
class, with held missing separate and failures separated by closed failure code.
Remaining slots prioritize held missing, purged present, parked reconciliation and
active missing, then stable HMAC order. Samples deduplicate identifying references
while counts include every observation. At most 50 samples are retained; selecting
uses at most 51 candidates and bounded maps. `samplesTruncated` explicitly signals
omitted references. More classes than capacity throw
`MEDIA_RECONCILIATION_SAMPLES_UNACTIONABLE` (opaque `sampling_capacity`, exit 1),
never a fully actionable report. Operators can compute the same reference from an authorized DB inventory
in a protected session; never paste raw metadata into logs or public incidents.

There are no business mutations requiring new audit events. Retain redacted run
reports in access-controlled operational telemetry for provenance. Reads never
insert audit events or duplicate existing lifecycle audits. Repeated scans are
idempotent observations with fresh run IDs. SIGINT/SIGTERM returns a cancelled,
partial report; hard termination may produce no report and must be detected by
external job supervision. Exit 0 = completed without alerts; 2 = partial/cancelled
or actionable findings; 1 = opaque startup/configuration/role failure.

## Alert thresholds and operator resolution procedure

These are B08 operational defaults, not new retention or legal/product rules. The
report supplies signals; deployment monitoring must apply repeated-run/time windows.
No alert is actually sent to an external service by B08.

| Signal | Operational threshold / response |
| --- | --- |
| `active_missing` | Any unchanged active HEAD 404: high-priority incident; immediately verify account/configuration and repeat independent HEAD. |
| `held_missing` | Any held active absence: critical evidence-availability incident. Preserve hold and metadata. |
| `purged_object_present` | Any: high-priority lifecycle drift; check valid/legacy PUT windows and B06 job facts. Never automatically delete. |
| `manual_reconciliation` | Any B06 parked job: critical manual investigation; do not resume or clear it. |
| `orphan_candidates` | Any complete run: warning; escalate if the same reference persists across two complete runs. |
| `storage_access` | Any 401/403/LIST404/configuration failure: immediate warning; repeated consecutive runs critical. |
| `scope_empty` / `scope_coverage_gap` | Warning, exit 2; verify configured tenants against protected inventory. A complete enumeration with no media is not a clean PASS. |
| `scan_incomplete` / uncertainty | One failed/partial run warning; two consecutive failed runs critical. Absence of a completed scheduled report beyond two intended intervals also critical. |
| rate/timeout/5xx | Any exhausted retry warning; >5% failed inspected operations for 15 minutes or two consecutive failing runs critical. Partial scans cannot produce a healthy denominator. |

1. Preserve the redacted run ID, scope, classification, timestamps and failure counts.
   Keep production purge disabled. Do not edit metadata to conceal an observation.
2. For access/configuration failures, verify the expected account/endpoint/bucket in
   a protected operator session, secret rotation, token scope, rate limits/network
   and R2 service status. Obtain an independently known canary object's successful
   HEAD. A LIST success alone does not prove HEAD permission or bucket privacy.
3. For active absence, repeat HEAD against authoritative metadata with independent
   read credentials after correcting configuration. Check recent completion,
   quarantine, holds, tombstones and B06 jobs/audits. Do not relabel 403 as absence.
4. For orphan candidates, resolve the HMAC reference within protected inventory,
   repeat a complete scan, verify all historical metadata/global existence, pending
   capabilities, concurrent uploads and any restored database's RPO. Unknown
   objects may be historical/manual uploads; age is not deletion authority.
5. For B06 drift/parked cases, follow B06's incident boundary. Preserve history,
   holds and tombstones. Independently prove a recovery copy and evidence identity
   before seeking an authorized restoration/resolution. B08 supplies no setter,
   override, reactivation, purge confirmation, automatic repair or resume authority.
6. Attach only redacted evidence to operational incidents. Any mutation/restoration
   requires a separately approved command and its transactional audit contract.

## Permanent regressions and quality gates

`tests/media/reconciliation-r2.test.cjs`: signing/pagination/XML bounds and malformed
responses, HEAD/LIST distinctions, 401/403/404/429/5xx, retries, timeouts, network,
redirects, cancellation and bounded response bodies, using fake fetch only.
`tests/media/reconciliation.test.cjs`: active/pending/quarantined/uploaded/deleted/
purged/parked classifications, holds, orphan candidates, cross-scope historical
matches, partial pages, DB/provider failures, lifecycle/inventory races, concurrency,
redaction, repeated scans and cancellation/interruption/deadlines.
`tests/media-api/reconciliation.test.cjs`: PostgreSQL tenant RLS, minimal grants,
negative function/role/DML/PII tests, a real-DB/fake-S3 end-to-end scan with captured logs and method assertions, global existence across all states/legacy
ownership, B05/B06 overlap, tombstones/purged history, paging and pooled context.
The existing media upgrade runner includes 0029→0030 preservation/no-op rerun,
invalid role isolation and late-failure rollback. CI runs both new gates alongside
all previous gates. The shared disposable API harness cleans up the new role.

Final execution evidence is recorded below after all gates finish. Automated tests
use disposable PostgreSQL 18 and simulated R2; no production bucket is scanned.

## Live R2 evidence still pending

**PENDING — not PASS:** actual bucket privacy (r2.dev and custom-domain exposure),
credential read/list scope and absence of write/delete permissions, deployed account/
bucket correctness, successful canary HEAD/LIST, network/TLS, and live bounded-load
behavior. These cannot be proven from environment names, code or fake transport.
No real R2 credentials were accessed or live bucket request made for this task.
The provider compatibility documentation is not a privacy/permission certificate.
B06 activation and unresolved late-hold/recovery requirements remain unchanged.

## Known limitations and blockers

No S4-B08 business-contract blocker was found in the supplied/local contracts.
Live deployment evidence and monitoring/provisioning are pending release work.
Full inventories beyond 10,000 objects or 120 seconds remain partial; durable
checkpointing/streamed large-inventory reconciliation is future reviewed work.
Observations cannot guarantee future object presence or prove recovery. Existing
B02 duration policy, B07 order-upload contract and B06 destructive activation
blockers remain their respective owners' unresolved scope.

## Final validation evidence — 2026-10-11

Node 22.23.3; PostgreSQL **18.6** in a disposable `postgres:18-alpine` container;
R2 simulated only. Every command below exited 0. Counts overlap and must not be
summed as unique tests. The earlier fixture-expectation failure and unconditional
owner-policy catalog failure were corrected and their affected gates rerun.
This historical baseline was superseded by the targeted R1–R3 remediation below.
The dedicated owner policy explicitly checks CURRENT_USER; global probe results preserve
input order using WITH ORDINALITY. Runtime tenant policies remain tenant-scoped.

| Command | Final result |
| --- | --- |
| `npm run typecheck` | PASS, zero errors |
| `npm run lint` | PASS, 286 files, no fixes |
| `npm run build` | PASS, zero errors |
| `npm run test:media:reconciliation` | PASS, 65/65 scanner/transport regressions |
| `npm run test:media:api:ci` | PASS, 609/609; includes 16 B08 PostgreSQL/integration regressions |
| `npm run test:media:reconciliation:ci` | PASS, focused B08 gate; also included in full media API gate |
| `npm run test:media:purge:ci` | PASS, 125/125 |
| `npm run test:media:upgrade:ci` | PASS, 15 scenarios; fresh ledger 31; history, ACL and rollback preserved |
| `npm run test:reception:api:ci` | PASS, 123/123 |
| `npm run test:reception:db:ci` | PASS, 24/24 |
| `npm run test:tenant-context:api:ci` | PASS, 75/75 |
| `npm run test:tenant-context:db:ci` | PASS, 27/27 |
| `npm run test:db:sprint0:ci` | PASS, 65/65 |
| `npm run test:api:security:ci` | PASS, 12/12 |
| `npm run test:cross-tenant:final:ci` | PASS, 25/25 |
| `npm run test:authz:db:ci` | PASS, 4/4 |
| `npm run test:runtime:db:ci` | PASS, restricted runtime login/role boundary |
| `npm test` | PASS, 205 tests across the standard suites |

`test:media:r2:ci` is deliberately not executed: that gate requires live credentials
and performs external storage effects. Its live privacy/permissions/evidence remain
pending, not a simulated PASS. The permanent B08 suites use fake storage only.

## Files changed and Git status

- `.env.example`: values-empty dedicated configuration, disabled by default.
- `.gitignore`: exact exception for this canonical document.
- `.github/workflows/ci.yml`: new hermetic reconciliation gates.
- `package.json`: explicit scanner command and test gates.
- `drizzle/0030_s4_b08_media_reconciliation.sql` and `drizzle/meta/_journal.json`:
  dedicated read-only role, tenant policies and bounded global existence probe.
  No schema layout changes or new schema snapshot are necessary.
- `src/media/r2.ts`: shared signing core and internal LIST signing.
- `src/media/reconciliation-r2.ts`, `src/media/reconciliation.ts`, and
  `src/worker/media-reconciliation-run.ts`: transport, scanner, bounded metadata
  reads and one-shot operator process.
- `scripts/test-crm-api.cjs`: include new canonical role in fixture cleanup.
- `scripts/test-media-integrity-upgrade.cjs`: B08 upgrade and atomic rollback probes.
- `scripts/test-media-reconciliation.cjs`: focused hermetic PostgreSQL gate.
- `tests/media/reconciliation-r2.test.cjs`, `tests/media/reconciliation.test.cjs`,
  `tests/media-api/reconciliation.test.cjs`: permanent transport/scanner/DB regressions.
- `docs/S4-B08-media-reconciliation.md`: authority, implementation and operational evidence.

The preexisting clean worktree for `task/s4-b08-media-reconciliation` was reused at
`/Users/ivanby/Documents/Proyectos/TallerMecarioB-worktrees/s4-b08-media-reconciliation`.
Its HEAD remains the supplied base `9732aecbda126c100ce9e04e07ea7b9b86e86987`.
All 17 changed/new project files remain unstaged, uncommitted and unpushed.
The primary checkout remains on main with no source changes. The borrowed dependency
symlink is removed at delivery; no audit checkout or temporary repository directory
was created inside either source tree. The worktree is preserved with the user's work.

Final secret scan and whitespace gate: **PASS**. Both used a disposable Git index
including all nine new files; the real index hash and empty staging state were
unchanged. No .env, credentials, storage capability or PII artifact was added.
Before teardown, the disposable cluster had zero fixture databases and zero
`tm_*` test logins. The PostgreSQL container and its anonymous volume were removed,
including any cluster-global test roles. Temporary compilation/audit artifacts and
the borrowed dependency symlink were removed. No commit, push, real R2 request or
production purger startup occurred. Final Git status: eight modified tracked files,
nine new untracked project files, no staged changes; main checkout remains clean.

## Targeted R1–R3 remediation — 2026-10-12

R1 removes global authority from the shared schema owner; catalog/runtime tests
verify exact column ACLs, isolated owner attributes/memberships, unauthorized EXECUTE
and SET denial, unchanged validation, FORCE RLS and cross-tenant legacy existence.
R2 reproduces the original 60 deletion observations plus held missing and purged
present: exact counts, both critical references, 50 samples, explicit truncation,
and no sensitive data. Competing categories are deterministic across pagination,
concurrency and repeated runs. R3 tests populated, valid empty, nonexistent and
mixed scopes, failed probes, incomplete sweeps, cancellation, repeated runs and
actual one-shot process exit statuses with simulated transport only.

Remaining nonblocking findings are preserved without implementation expansion:

- R4: Default budgets can produce partial scans at production scale.
- R5: Wrong bucket/endpoint can produce mass false missing alerts; independently
  known live canary HEAD and deployment configuration remain required.
- R6: Extend reconciler privilege auditing beyond its existing checked schemas
  before production where applicable (owner relation ACLs are checked separately).
- R7: Pending upload states can mask missing active-object observations.
- R8: Missing uploaded/quarantined objects are not currently critical alerts.
- R9: Redirect handling, retry jitter and dot-segment hardening remain future work.
- R10: Read transaction cleanup can emit avoidable rollback notices in PostgreSQL.

Final targeted validation is recorded in the remediation report; earlier counts
above describe the original B08 implementation, not the final remediation.


### Final targeted validation

PostgreSQL **18.6**, disposable localhost-only container; R2 fully simulated.
All final commands exited 0. Counts overlap between focused and full suites.

| Command | Tests/scenarios | Exit |
| --- | ---: | ---: |
| `npm run typecheck` | PASS | 0 |
| `npm run lint` | PASS | 0 |
| `npm run build` | PASS | 0 |
| `npm run test:media:reconciliation` | 73 | 0 |
| `npm run test:media:reconciliation:ci` | 22 | 0 |
| `npm run test:media:upgrade:ci` | 17 scenarios | 0 |
| `npm run test:media:api:ci` | 615 | 0 |
| `npm run test:media:purge:ci` | 125 | 0 |
| `npm run test:reception:api:ci` | 123 | 0 |
| `npm run test:reception:db:ci` | 24 | 0 |
| `npm run test:tenant-context:api:ci` | 75 | 0 |
| `npm run test:tenant-context:db:ci` | 27 | 0 |
| `npm run test:db:sprint0:ci` | 65 | 0 |
| `npm run test:api:security:ci` | 12 | 0 |
| `npm run test:cross-tenant:final:ci` | 25 | 0 |
| `npm run test:authz:db:ci` | 4 | 0 |
| `npm run test:runtime:db:ci` | PASS | 0 |
| `npm test` | 205 | 0 |

Actual PostgreSQL catalogs confirm owner `tallermecario_media_inventory_owner`,
all seven elevation/login/inheritance flags false, zero memberships in either
direction, no table-level SELECT, no retained app CREATE, and exactly
`bucket`, `object_key`, `storage_provider` readable. Function EXECUTE ACL contains
only the owner and reconciler; PUBLIC/ordinary/offline runtime execution is denied.
Schema owner without tenant context sees zero media rows; cross-tenant boolean
existence remains correct. FORCE RLS is unchanged. Upgrade invalid-owner membership
and broad-read probes fail closed; injected late failure rolls back ownership,
policy/grant changes, data/history and ledger. Clean and upgraded ledgers have 31
entries; migration rerun is a no-op.

The independent read-only candidate review found no concrete surviving bypass or
regression in R1–R3. It separately ran all 38 scanner tests successfully. No commit
or push was performed; the original 17 changed/new B08 files remain unstaged.
