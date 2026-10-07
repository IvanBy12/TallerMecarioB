# S4-B03 — Media idempotency, concurrency and resiliency

Implemented against frozen [S4-B01 v1](S4-B01-media-contract.md) and merged
[S4-B02](S4-B02-media-integrity.md). Scope: create/complete semantic replay,
PostgreSQL concurrency, bounded signed PUT renewal, safe inspection-read retries
and exactly-once mutation audits. No commit or push.

## Baseline and confirmed gaps

Branch `task/s4-b03-media-idempotency`, clean starting tree, base
`e829668ca8b02b8f77b4663fb829e766acc00521`. Reused the requested existing worktree
outside the repository root. Fully reviewed AGENTS.md, B01/B02, media service,
routes, R2, content inspector, tenant request lifecycle, schema, migration 0025,
media tests, package scripts and CI.

All five observations were confirmed: create compared only size/MIME after
terminal status checks; SELECT did not serialize absent-key creates; completed
replay skipped checksum equivalence; PUT renewal used a fixed 900 seconds;
inspection reads had no deliberate bounded retry policy.

Baseline gates passed: npm ci (94 packages), production audit (0 vulnerabilities),
secret scan, typecheck, lint, build, npm test (163/163), media API (52/52), media
fresh/upgrade/rerun (26 migrations, RLS retained, cleanup PASS).

## No migration

Existing tenant/key UNIQUE, tenant-composite FKs, FORCE RLS, v1 immutable expected
size/version and asset type/MIME/retention/captured timestamp provide all required
authoritative data. PostgreSQL transaction advisory locks need no new table or
fingerprint column. Schema, migration 0025, snapshots, journal and grants are
unchanged; no 0026.

## Create semantics and coordination

Semantic payload: verified tenant + UUID idempotency key + mediaType + exact
mimeType + admitted retentionClass + expectedSizeBytes + normalized capturedAt.
Normal request validation, authentication, membership, tenant context and RBAC
precede replay lookup. Operational create remains fail-closed.

`captured_at IS NOT DISTINCT FROM candidate::text::timestamptz` compares persisted
instants, preserving absence and PostgreSQL timestamp precision. Insert also
binds timestamp input through text to avoid the driver's JavaScript Date
serialization truncating microseconds. Equivalent offsets/fractional spellings
replay; distinct microsecond instants conflict. capturedAt never authorizes an
operation or supplies an expiry/retention clock.

Coordination uses `pg_advisory_xact_lock` on a signed 64-bit prefix of SHA-256 of
`media-create:v1:<lowercase tenant UUID>:<lowercase key UUID>`, before the absent-row
read. UUID case matches PostgreSQL equality. Collisions only serialize unrelated
operations; tenant predicates/RLS remain the authority. Locks release on commit
or rollback; no process-local/session lock. Lock order: advisory key → session →
asset. Asset is read in a separate statement after locking the session, so a
concurrent committed completion is visible. Complete keeps session → asset.
Create performs only local presigning, never R2 network I/O under these locks.

For v1 rows semantic mismatch precedes pending/completed/failed/expired outcomes
and does not mutate the row. Equivalent pending replay returns the same IDs,
object key and logical expiresAt with a bounded PUT. Equivalent terminal replay
returns existing ALREADY_COMPLETED/FAILED/EXPIRED codes. Legacy rows preserve B02
fail-safe outcomes without fabricated expectations or semantic proof.

## Complete replay and audits

Completion identity is uploadSessionId. Declared/unverified checksum hex compares
case-insensitively after lowercase normalization; absent differs from present.
Persisted completed checksum is compared before returning the stored successful
result, both for sequential replay and Phase-C losers. No HEAD/Range/reinspection,
metadata/timestamp rewrite or duplicate completion audit on completed replay.
Completed replay precedence, after normal request validation, is explicitly:
**authorization → resource availability → replay semantic equivalence → persisted
result**. An **active** asset with an incompatible completed checksum declaration
returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH`; an equivalent declaration returns the
persisted success. For an **unavailable/non-active** completed asset, the existing
availability error takes precedence even when the supplied checksum mismatches:
`deletion_requested_at`, `deleted_at` or `purged_at` returns
`404 MEDIA_ASSET_NOT_FOUND`; a non-active status (including quarantined) returns
`409 MEDIA_ASSET_NOT_ACTIVE`. Checksum equivalence is not disclosed in these cases.

This conservative security/privacy precedence preserves S4-B01's unavailable
asset protections and does not change successful replay semantics. S4-B01 does
not explicitly order simultaneous payload mismatch and asset unavailability.
Unavailable replay performs zero HEAD/Range calls, preserves checksums and all
session/asset timestamps, emits no extra completion audit and never reactivates.
ETag stays an opaque version token, not SHA-256; no checksum-verification claim.

Phase A releases its read transaction before Phase B. Phase C revalidates the
verified identity/membership/permission and locks session then asset. One winner
writes completion/checksum/timestamps/audit; equivalent losers read that winner,
incompatible losers return IDEMPOTENCY_PAYLOAD_MISMATCH. Failed/expired sessions
cannot complete. Exactly one create, completion, discovered expiration or
quarantine audit is committed per corresponding transition; replay is not a new
success event. Audit actor/tenant/request context still comes from verified GUCs.

## Signed PUT lifetime

Each issuance uses `min(900, floor((expiresAt - now) / 1000))`. The same `now` is
passed to SigV4 signing. TTL <1 produces durable expired outcome without a URL;
replay never changes expires_at. Tests validate helper boundaries and actual
X-Amz-Date/X-Amz-Expires against logical expiry. Initial URL can have 899 seconds.

## R2 inspection retry

HEAD and Range GET alone receive at most **two total attempts**. Retry candidates:
fetch/network failure, response-body transport exception, HTTP 429/5xx, or a
4-second attempt timeout while the parent deadline is still live. Backoff is
25 ms, abort-aware. Standalone HEAD retains a 5-second overall budget; complete
retains B02's single 10-second deadline across HEAD, ranges, inspection and retries.
Every attempt/body/backoff uses that parent abort signal; retries never restart
its clock. There is no PostgreSQL transaction during inspection or backoff.

404, 412, other deterministic 4xx, malformed metadata/range/ETag/encoding/length,
and deterministic content-invalid/unsupported inspection outcomes do not blindly
retry. PUT and presigning are not retried. Range/If-Match and signed headers are
identical across attempts. Each range keeps the 1 MiB bound; logical inspector
budgets are unchanged, with at most twice their transport bytes due to retries.
Exhaustion is safe 503 MEDIA_STORAGE_UNAVAILABLE, leaving session/asset/audit
unchanged and pending, never falsely active or quarantined.

## Tenant guarantees and remaining scope

Separate tenants may use the same key independently, including while another
tenant's coordination lock is held. Replay still requires authentication, active
membership, current RBAC and verified TenantContext; foreign completion and
missing completion are non-enumerable. Tests use real NOBYPASSRLS runtime logins,
separate HTTP connections, pg_locks barriers and overlapping HEAD barriers;
fixtures, databases, logins, external objects and local Docker stacks are cleaned.

**operational upload path remains contract-blocked by S4-B04**. No reception/damage
binding, purpose strings or new domain fields. B05 retention/holds, B06 delete/purge,
B07 assigned-technician resolution, B08 reconciliation and Sprint 13 offline sync
remain pending. **DURATION_POLICY_UNRESOLVED**: no numeric duration rule invented.
The existing media-integrity writer capability and signed-history guards remain.

## Final evidence — 2026-10-07

Node 22.23.3 (repository .nvmrc), PostgreSQL 18, isolated local disposable databases.
All commands exited 0; no skipped/cancelled behavioral tests.

| Command | Result |
| --- | --- |
| npm ci | 94 packages; existing 4 moderate development advisories; lockfile unchanged |
| npm audit --omit=dev | 0 vulnerabilities |
| npm run security:secret-scan | SECRET_SCAN_PASS |
| npm run typecheck / npm run lint / npm run build | PASS each; lint 259 files |
| npm test | 205/205: authz 26, tenant core 78, Wompi 20, presign 5, media 76 |
| npm run test:media:api:ci | 97/97 (52 B02 + 45 B03), cleanup PASS |
| npm run test:media:upgrade:ci | fresh + upgrade + rerun, ledger 26, RLS/history/cleanup PASS |
| npm run test:reception:api:ci | 123/123, cleanup PASS |
| npm run test:reception:upgrade:ci | 19 upgrade/preflight scenarios PASS |
| npm run test:tenant-context:api:ci | 75/75, cleanup PASS |
| node --test tests/media/r2-network.test.cjs tests/media/r2-transport.test.cjs tests/media/r2-integrity.test.cjs | 66/66 |
| npm run staging:deploy-drill:ci | all 35 gates PASS, distinct GOOD/BAD images, API/worker recovery and cleanup PASS |
| R2_EXTERNAL_GATE=1 node --env-file=<existing local env> scripts/test-media-r2.cjs | rerun once, real R2 6/6, object cleanup/transport gate PASS; databases=0, logins=0 |
| git diff --check | PASS |

Docker recovery drill used GOOD `sha256:b274f134dc87f96a1a6c08929ee3267cdc573032e8c7db13b2c24e858e378258`
and distinct BAD `sha256:7a2cca65816bb70868db8832b8c030c0fb229ea507b71712e7b5c1f1be747e67`.
These cleaned-up local artifacts prove implementation behavior, not real staging
or production certification; B02's staged recovery prerequisites still apply.
