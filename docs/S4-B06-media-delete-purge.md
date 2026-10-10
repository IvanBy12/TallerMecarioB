# S4-B06 — Media remove-unattached and physical purge

Implemented on `task/s4-b06-media-delete-purge`, base
`56c6e056934d271ada3c7ace667cdd2dbe809da3`. Backend only, no commit/push.
Authority: supplied B06 ticket, [B01](S4-B01-media-contract.md),
[B04](S4-B04-media-associations.md), [B05](S4-B05-media-retention.md).

## Command and visibility

`POST /api/v1/media/:mediaAssetId/remove-unattached`, permission
`media.remove_unattached`, tenant scope, owner/admin only. Permission is checked
before resource lookup, including malformed IDs. No body preferred; `{}` is also
accepted. Any other JSON body/property or query parameter is rejected. No tenant,
retention decision or reason input. Same verified transaction, whole-transaction
retry on changed lock graph, at most three tries with refreshed authorization.

First acceptance and every **manual-origin** replay return **202** with exactly
`{mediaAssetId, deletionState:"deleted"}`; after physical confirmation replay is
**202** `{mediaAssetId, deletionState:"purged"}`. `purged` is a response deletion
state, never a media status. No internal job, storage identity or blocker details.
All replies are no-store. Foreign/missing: 404 MEDIA_ASSET_NOT_FOUND. Protection:
409 MEDIA_DELETE_NOT_ELIGIBLE; an active authorized hold: 409 MEDIA_LEGAL_HOLD.
Automatic-origin tombstones never count as manual replay: 409 MEDIA_DELETE_NOT_ELIGIBLE, including linked/signed evidence and already purged objects. No reference details escape. Permission: 403 PERMISSION_DENIED. Fence/lock contention: 503 MEDIA_DELETE_RETRY; retry with backoff. The request performs no storage calls.

Unattached checks reception_media, damage_media, finding_media,
work_activity_media, quality_check_media, delivery_media, quote_media,
signatures.signature_media_id and privacy_consents.evidence_media_id. Sessions and
bindings remain historical capabilities/evidence and do not count as domain
links. They still participate in B05 eligibility. No unlink endpoint or link
deletion is added.

The SQL entry point repeats current membership/owner-admin/permission validation,
complete inventory and B05 eligibility under sorted reception → damage → order →
all sessions → asset locks. An unknown newly committed parent/session aborts the
whole transaction. SQL `media_retention_decision` is the shared authority consumed
by B05 and B06: all calendar clocks, committed MAX floors, unresolved protection,
live upload capabilities and PostgreSQL-clock legal holds remain mandatory.

## Tombstone and durable work

One transaction writes deletion_requested_at, status=deleted, deleted_at,
server reason manual_unattached (automatic path: retention_expired), one unique
tenant/asset job and one media.deletion_requested audit. Enqueue or audit failure
rolls everything back. purged_at remains NULL. Replays emit no duplicate audit/job.
No media metadata/reference row is physically deleted.

Download and completion already test all markers; B06 filters deletion-marked
assets from reception/damage galleries. Historical signature IDs remain visible
under their existing API contract. Existing signed URLs issued before deletion
remain bounded capabilities per B01; no instant revocation claim is added.
DB guards reject reactivation, marker clearing, false purge ordering, new
references/session bindings and mutation of tombstone evidence identity.

`media_purge_jobs` has composite tenant/asset PK, tenant/job uniqueness and NO ACTION
FKs, forced RLS, bounded due/scan indexes, prior lifecycle, server reason, attempt
count, last normalized result, claim ID/backend and physical lease. States:
queued, claimed, retryable_storage_failure, storage_deleted, storage_absent,
db_confirmation_retry, suspended, reconciliation_required, completed. `storage_outcome`
records not_attempted, unknown, deleted, absent or failed independently of the job state.
Metadata never stores raw R2 errors. A BEFORE UPDATE trigger enforces immutable
tenant/asset/job ID, prior lifecycle, reason and creation provenance. Storage identity
remains immutable on the tombstone and request audit. Claims require an expired lease,
a new claim ID, matching backend and incremented attempt. Result transitions require
that live claim and its fence. Completion requires a confirmed result, asset marker
and final audit in the same transaction. Completed and reconciliation_required jobs
are terminal for automatic operations; neither can be reclaimed or cleared by the
reviewed functions. Protected work without potential deletion can be suspended.
Protected work with an unknown or confirmed destructive outcome parks with one
reconciliation audit in the same transaction.

The privilege boundary is the NOLOGIN, NOINHERIT, NOBYPASSRLS lifecycle role and
its reviewed function code: both are part of the trusted computing base. API, worker
and purger cannot SET ROLE to lifecycle or inherit its privileges. Migration and
bootstrap reject **all persistent membership edges into or out of lifecycle**,
including intermediate roles that would create indirect SET or effective privilege
paths. The migration's own temporary bootstrap membership is removed before commit.
The trusted bootstrap credential and DBA can change roles/code; arbitrary SQL run as
lifecycle can assert an external result. Diagnostic PL/pgSQL call context/function
names cannot prevent that, and the context-name guard has been removed. The dedicated
purger is also trusted to report transport facts. PostgreSQL cannot prove R2 deletion.
Fixed pg_catalog search_path, qualified objects, explicit grants, forced tenant RLS
and structural guards remain enforced. Runtime roles have no direct job mutations.

TEMP was assessed: PostgreSQL's database-wide PUBLIC TEMP grant cannot be denied
just to lifecycle by revoking a role-specific grant. Revoking PUBLIC would change
unrelated roles and fixture infrastructure. This migration leaves database TEMP
privileges intact, adds none, and relies on lifecycle isolation and trusted code,
not on TEMP or diagnostic function names. Lifecycle has no application-schema CREATE
privilege after bootstrap. Stronger isolation from arbitrary trusted-role SQL would
require a separate architecture review; B06 does not claim to provide it.

## Dedicated credential and phases

`tallermecario_media_purger` is NOLOGIN/NOBYPASSRLS/non-owner, with schema usage and
only allowlisted function EXECUTE; no media table UPDATE. A separate NOINHERIT
LOGIN is provisioned by `scripts/provision-media-purger-login.cjs`, using a
bootstrap/migrator credential and MEDIA_PURGER_DB_PASSWORD from the secret store.
Only a randomized SCRAM-SHA-256 verifier reaches PostgreSQL statements during provisioning; printable ASCII passwords avoid SASLprep ambiguity. Neither password nor verifier is printed. API/worker are not members of either dedicated role. The NOLOGIN/NOBYPASSRLS
`tallermecario_media_lifecycle` owns fixed-search_path functions, has tenant RLS
and explicit read/lock/column grants, and owns no tables. Neither API, worker nor
purger can SET ROLE to it. Its internal helpers are not publicly executable.

The purger defaults disabled. An approved deployment must explicitly set
MEDIA_PURGE_ENABLED=true before `npm run worker:media-purger`, with MEDIA_PURGER_DATABASE_URL, explicit
MEDIA_PURGE_TENANT_IDS and separate deletion-authorized R2 credentials. The API
and purger use the same R2_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY
names through loadR2ConfigFromEnv; credential separation and permission scoping
are enforced by deployment configuration, not intrinsically by that helper. Startup
rejects relation ownership (including inherited effective ownership), superuser/BYPASSRLS, inherited login privileges, direct/transitive API/worker/lifecycle/schema-owner memberships, and effective direct destructive table/column grants on media/assets or jobs. Failed, false or timed-out advisory unlock closes the pool and terminates with a nonzero exit instead of restarting a cycle on a closed connection. Normal worker is
unchanged. A separate job table follows existing outbox claim/backoff/phased
execution conventions while keeping the normal outbox credential out of purge.

Phase A commits tombstone/audit/job. Immediately before storage, the purger takes
a session advisory fence keyed by tenant/asset, then a short tenant-bound DB
transaction reacquires the full graph and re-evaluates B05. For tombstones the
evaluator resumes ONLY the job's immutable prior lifecycle, preserving its
original clocks. Newly discovered references are evaluated even for deleted
assets. Privacy/quote unresolved clocks remain protective. A blocker suspends
unattempted/known-failed work, or parks potentially destructive work for reconciliation,
and leaves the asset deleted. A unique claim and **120-second durable lease**
survive DB session loss; no active lease can be taken over.

Phase B has **no SQL transaction**, retaining the reserved connection's advisory
fence. DELETE is one five-second, redirect-disabled request, started no later than
ten seconds after claim preparation begins. The lease supplies conservative
margin around that bounded provider call and remains until confirmation/expiry,
including unknown timeout outcomes. No distributed atomicity is claimed.

Phase C records confirmed deleted/absent in a separate short transaction, then
reacquires graph, checks tenant/claim/backend/fence and full retention, sets
purged_at, writes media.purged and completes the job atomically. Audit replay is
exactly once because the terminal state and audit share the transaction.

Only DELETE 200/204 confirms successful idempotent deletion. Ambiguous DELETE 404 (including endpoint, bucket or account drift) is storage_unavailable; retry is allowed only while full protection remains satisfied; it never proves object absence. No standalone HEAD proof is used. Timeout/5xx/unknown never sets
purged_at. Failure backoff is bounded at 900 seconds, one attempt per cycle.
Process crash releases session fence but leaves the durable lease. A live lease is required for result recording and confirmation; an expired worker cannot confirm even while it retains a session fence. After expiry,
claim increments attempt and repeats DELETE against the same key. R2 success plus
DB failure retries successful idempotent DELETE against the same immutable key, without recreating keys/objects.
Jobs with a recorded result but rolled-back confirmation remain retryable only
while protection permits; new protection parks the job for reconciliation.

## Coordination and historical evidence

All nine reference families and upload_sessions have a DB insertion/retargeting
guard. B04 reception/damage retain their stronger canonical graph guards. A
committed association wins before a manual tombstone: deletion rejects. Tombstone
wins: association rejects. Pending/completing upload still protects eligibility;
legitimate expired cleanup never allows completion to reactivate deleted media.

Future hold commands MUST bind tenant context and use the B05 sorted graph plus
the same asset advisory/lease primitive. The media and retention-source triggers reject a
hold/floor or order/warranty/delivery/lineage change while a physical lease/fence exists, using 55006 and
media_purge_fence_guard; the future command must roll back and retry. It must
never wait holding a row lock across storage. A hold committed before claim
suspends physical purge. No hold setter/clearer is implemented. Privileged
writers that disable guards or bypass the shared protocol are unsupported.

Signed evidence uses the same full eligibility-backed operation, with only a
narrow lifecycle exception in the signed trigger. Its identity/key/MIME/checksum/
class/history and signature row/reference remain immutable. Normal API remove
always rejects signed evidence. Expired linked evidence can purge its R2 object
without removing any domain link. Consent evidence remains unresolved/protective.

RLS ENABLE/FORCE remains on all tenant tables and jobs. Each job runs under
transaction-local tenant context; foreign asset/job IDs never resolve. Migration
0029 replaces only the temporary 0027 deletion prohibition; 0027 is unchanged.
Migration performs no retention inference or historical deletion. All migration
changes are atomic; role-isolation/preflight failure retains prior guards/grants.

Discovery uses a deterministic tenant/asset UUID cursor, at most 100 rows per
batch. The partial index excludes tombstones. A MATERIALIZED index page limits discovery to 100 live rows before cheap protection filters; future floors/active holds are flagged and skipped without graph locking, while the cursor still advances past them. It does not infer authority from age. Rows without a known floor remain candidates because B05 can derive clocks from links. Each query/graph lock has bounded statement/lock timeouts (8s/2s). Every candidate passes the full locked evaluator before queueing. Candidate
55P03 lock contention and bounded statement-timeout 57014 are skipped after rollback;
40001 gets at most three complete transactions before skipping. Other cancellations
and unexpected errors propagate as discovery failures and are logged. Each next
candidate uses a fresh transaction. The cursor advances over blocked rows and resets
after the final page, so future sweeps revisit them. Due jobs run independently
even if discovery fails, with their own tenant-bound claim and protection checks. Old
status/date alone is insufficient. Operational target: physical purge within
seven days after acceptance when no hold/external failure blocks it; prompt
attempts are allowed, with no mandatory seven-day delay.

## Physical DELETE / expired lease boundary and recovery

The lease/fence prevents a participating protection writer during a bounded physical
attempt; it does not preserve a binary forever. DELETE may succeed, the process may
crash before DB confirmation, the lease may expire and a new hold may then commit.
Recovery re-evaluates the full protection graph. If `storage_outcome` is unknown,
deleted or absent, it atomically parks `reconciliation_required` and records one
`media.purge_reconciliation_required` event with job ID, reason, attempts and normalized
outcome. Hold/history remain intact, purged_at stays NULL and no media.purged is emitted.
Due selection excludes parked jobs; claim/result/confirm cannot resume them. Hold
expiration alone never authorizes takeover or another storage request. No recovery
endpoint or resolution authority has been approved; these cases stay parked.

A claim conservatively records unknown before transport: a crash may have crossed
the destructive boundary, but an attempt is not proof of physical loss. DELETE 200/204
records deleted; legacy trusted normalized absent results remain supported by the DB
protocol, but this R2 transport returns only deleted. Explicit 401/403 rejection or
failure before transport can record failed/not_attempted when all earlier outcomes
were also known non-destructive. The claim preserves its preceding durable outcome
in claim_storage_outcome; known failure can restore that knowledge without erasing
an earlier uncertain or confirmed destructive outcome. A timeout, 5xx or 404 never proves absence.
Ordinary transient failures still retry when no new protection exists.

Incident handling must distinguish three separate facts:

1. **DB consistency:** the parked job and once-only audit preserve the incident.
2. **Physical object status:** independently verify the intended account/bucket/key;
   unknown is potential absence, not confirmed loss. A DELETE success establishes
   provider acceptance, not availability of any recovery copy.
3. **Actual evidence recovery:** restoration requires an independently verified
   recoverable copy or another approved remediation path, plus verification of
   evidence identity/integrity and an authorized incident record.

A safely parked job does not recover evidence. Preserve the hold and tombstone;
do not fabricate rollback, clear protection, set purged_at or emit media.purged to
conceal absence. Resolution authorization, recovery procedure and any future resume
workflow remain unresolved and require a separate approved change.

**Production risk:** without a verified recoverable copy, physically deleted evidence
protected by a late hold may be unrecoverable. A formal policy must define the hold's
effective cutoff relative to physical DELETE and the required recovery mechanism.
The DB/R2 ordering gap is not an atomic transaction and remains an activation blocker.

The advisory key is predictable from tenant/asset UUIDs and hashtextextended, and a DB actor can hold it deliberately. Requests use nonblocking advisory acquisition and bounded graph locks; contention returns a normalized retryable result. Privileges are not expanded. An actor with database lock access can still cause repeated denial of service while retaining that lock; operations must identify/revoke that session through normal DBA controls.

## Verification and deferrals

Focused PostgreSQL/R2-fake tests run in test:media:purge:ci and normal CI validate;
the same file also runs in test:media:api:ci. Covers RBAC, inventory, tombstones,
replay, raw-role bypass, signed/linked preservation, tenant isolation, enqueue/
audit/storage/confirmation failures, abandoned claims, concurrent workers,
holds and real PostgreSQL attach/complete barriers. Upgrade suite includes fresh,
0028→0029 preserving history and framework rerun. No real production R2 is used.

B07 assignment, B08 reconciliation/orphans, legal hold mutation, external
DSR/incident linkage, offline authorization and numeric duration remain deferred.

## Production activation boundary

Merging dormant B06 code does not authorize physical deletion. No API, normal worker,
Docker startup or CI command starts the purger automatically; tests use fake/local
R2 only. Startup requires exact MEDIA_PURGE_ENABLED=true and an explicit canonical
tenant list. Omission/false disables startup before DB/R2 access; SIGTERM/SIGINT stop
new work after the current bounded operation. Operators can terminate the dedicated
process and remove its enable setting to keep it disabled.

Activation additionally requires an approved dry-run mode (not implemented here),
bounded rate limits and canary rollout, separately scoped delete-authorized R2
credentials in the dedicated deployment, scan/lock-load validation, a formal late-hold
and physical-deletion policy, an independently verified recovery-copy policy,
reconciliation authorization/recovery process, and a future legal-hold setter that
respects the shared fence/lease. The runtime DB gate must pass on a clean disposable
cluster. These prerequisites remain release blockers; this pass adds only the minimal
startup guard, not a production rollout system.

## Validation evidence

The final F1–F4 pass is dated 2026-10-10. Earlier B06/review-fix gate evidence is
superseded for the changed implementation; refer to the final report delivered with
this pass for current command counts and exits. The earlier local staging deploy drill exercised API/migrations and
deployment recovery, and did not execute the dedicated purger. Permanent PostgreSQL
and fake transport tests separately verify the purger/bootstrap. Production R2 is
never contacted. A passing gate matrix does not remove the activation blockers above.
