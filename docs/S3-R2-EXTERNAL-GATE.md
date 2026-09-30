# S3 R2 External Gate

R2 BLOCKER OPEN. Branch: `fix/s3-r2-external-gate`. Base:
`task/s3-backend-final-quality-gate` (`f9948140925df42bbf4f6c7469b60d622e7d6faa`).
No frontend, Sprint 4, privacy or production schema changes. No merge.

## Root-cause analysis

Prior real runs: 6/6, then 5/6 with `UND_ERR_CONNECT_TIMEOUT` on
`CROSS_TENANT_INITIAL_PUT`, then 5/6 on `SIGNATURE_REPLAY_SAME_PUT`.
No SigV4 defect has been demonstrated. This session reproduced local transport
instability on Node 26.4.0: 4/6 with `UND_ERR_SOCKET` on
`CROSS_TENANT_INITIAL_PUT` and `UND_ERR_CONNECT_TIMEOUT` on
`SIGNATURE_MISSING_CONDITION_PUT`; each failed on attempt 1/1.

A subsequent strict real run on Node 22.23.3 passed 6/6 without transient
transport failures. This single observation does not prove Node 26 was the
cause, nor establish stability of the GitHub runner. Network/account/endpoint
causality remains unproven until external runs supply evidence.

## Production code changed? YES/NO

NO. `src/media/r2.ts`, `src/media/service.ts`, schema and migrations unchanged.
The existing service scopes queries by tenant; signature and quarantine
constraints remain intact. Changes are limited to test transport diagnostics,
fixture cleanup evidence, the test command and a dedicated manual workflow.

## PUT retry behavior

PUT attempts = 1. Socket/connect failures remain ambiguous and fail the test;
no PUT replay or automatic whole-suite rerun is added. GET/HEAD/DELETE retain
their existing three-attempt bound (100/300 ms backoff). The external gate
fails even when these retries recover a transient failure.

## Diagnostic results

Test-only script: `node --env-file=.env scripts/diagnose-r2-network.cjs` locally;
`node scripts/diagnose-r2-network.cjs` in Actions. Three sequential samples;
at most two resolved addresses per family, TCP/TLS/unsigned HTTP HEAD probes,
five-second bounds per connection probe. No PUT, credentials, object path,
signed URL, authorization, account hostname, or IP address is logged.
Output contains only family, address ordinal, layer, timing, numeric HTTP
status and allowlisted error codes. Certificate verification stays enabled.

Outside the local sandbox (Node 26.4.0), all three samples found two IPv4
addresses. All six TCP, TLS and HTTP probes succeeded; unsigned HEAD `/`
returned HTTP 400. TCP: 3–7 ms; TLS: 14–2475 ms; HTTP: 25–1051 ms.
IPv6 lookup returned `ENOENT` in all samples, so no IPv6 connection could be
tested. This does not demonstrate problematic IPv6 selection. No
`ipv4first`, timeout increase or production transport change is applied.
Sandbox-denied probes are excluded from network conclusions.

## External workflow

`.github/workflows/r2-external.yml`: `workflow_dispatch` only; no push or PR
trigger. Job uses Environment `R2`, Node 22.23.3 from `.nvmrc`, and a fresh
`postgres:18` service on the runner. `DATABASE_URL` is fixed to loopback;
there is no external database secret. The fixture still creates its own
random database and NOBYPASSRLS login, migrates, runs and cleans them.
Concurrent gates are serialized without canceling a running cleanup.

Commands: `npm ci`, `npm run build`, presign/transport/network regressions,
unsigned network diagnostics, then `npm run test:media` with
`R2_EXTERNAL_GATE=1`. The runner validates TAP evidence for exactly six tests,
six passes, zero failures/cancellations/skips, object cleanup and zero
transient failures before emitting `REAL_R2_GATE_PASS 6/6`.
Every job summary records run ID, attempt and tested commit.

GitHub requires the manual workflow to exist on the default branch before
dispatching it against another ref:
[GitHub manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
Registration on the default branch is an external prerequisite; this task
does not merge or modify that branch.

## Secrets required

Environment `R2` was verified by names only and already contains:
`R2_ENDPOINT`, `R2_REGION`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`. Values were neither retrieved nor printed.
Endpoint/region/bucket may alternatively use Actions variables; key ID and
secret key must use secrets. No `DATABASE_URL` secret is required.

## Run 1

Pending `workflow_dispatch`; no accepted external run ID yet.

## Run 2

Pending `workflow_dispatch`; no accepted external run ID yet.

## Run 3

Pending `workflow_dispatch`; no accepted external run ID yet.

## R2 functional/security results

Local strict Node 22.23.3 real run: **6/6 PASS**. Missing/wrong
`If-None-Match` and tampered key: 403 each. First valid PUT: 200. Same-byte
and changed-byte replays: 412 each. Cross-tenant complete/download: 404.
Original bytes, length and ETag persisted; signed reference survived
quarantine, which denied new API download URLs with 409.

Build, lint, `npm test`, `test:media:presign` (2/2), and combined transport
and diagnostic tests (13/13) passed locally. Local success is not a substitute
for three external workflow runs.

## Cleanup evidence

Both real local runs emitted `R2_OBJECT_CLEANUP_PASS`,
`FIXTURE_RESIDUE databases=0 logins=0` and `FIXTURE_CLEANUP_PASS`.
The strict successful run also emitted `R2_TRANSPORT_STABILITY_PASS`.
R2 cleanup targets only this run's recorded keys and verifies absence by HEAD;
there is no bucket listing, prefix purge or broad object cleanup.
Database cleanup targets only the generated DB/login and canonical roles
absent from a successfully captured pre-run snapshot. It preserves existing
roles. Cleanup evidence is emitted even if functional tests fail.

## Remaining risks

Three consecutive real manual workflow runs on the final commit are still
required: each 6/6, `FIXTURE_CLEANUP_PASS`, no connect/socket failure, no DB/login
residue, no broad cleanup and no PUT retry. A failed run resets the accepted
consecutive sequence. Do not replace a failed run with a retry attempt or
discard its evidence. If the GitHub runner reproduces the failure, investigate
R2 endpoint/account/network and keep the blocker open. The Sprint 3 final
quality-gate document stays unchanged until this acceptance is met.

## Commit SHA

See the implementation commit reported in the handoff. Accepted external
run IDs must all identify that same final tested commit.

S3 R2 EXTERNAL GATE CLOSED: NO
