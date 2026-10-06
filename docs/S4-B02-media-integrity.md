# S4-B02 — Media completion & integrity

## Scope and baseline

Implemented against [S4-B01 v1](S4-B01-media-contract.md), especially §§3, 5, 12.1, 13 and 15. Backend only. Initial checkout `main`, base SHA `647def1f7b381a98cb9d73081e64c8a6f95f6984`, clean working tree. Reused the existing clean `task/s4-b02-media-integrity` worktree at that SHA. Baseline typecheck, lint, build and `npm test` passed (129 tests); no pre-existing failures observed. No commits or shared staging/production deployment performed; local disposable deployment drills only.

## Implementation and guarantees

- New create requests require a positive safe integer `expectedSizeBytes` within the existing media-type maximum. It is persisted in `upload_sessions`, never inferred from storage. HTTP missing/zero/negative/fractional input is 400 `REQUEST_VALIDATION_FAILED`; over-limit remains 422 `MEDIA_SIZE_TOO_LARGE`.
- The strict B01 type/retention matrix is enforced. Generic operational create (`photo`, `video`, `video360`) fails closed with 403 `PERMISSION_DENIED`, without emitting a PUT capability; B02 introduces no domain fields or associations. **operational upload path remains contract-blocked by S4-B04**.
- Complete still uses `uploadSessionId` and preserves the success DTO. Phase A reads metadata in a short tenant transaction, releases it with ROLLBACK, Phase B inspects R2 without SQL, and Phase C reauthenticates/revalidates membership and permission in a new transaction and locks session then asset. Queries retain explicit tenant predicates and FORCE RLS. Completion rejects failed, expired, ineligible or deletion-marked resources, and rechecks expiry after external validation. It cannot reactivate quarantined media.
- Storage identity must match the configured R2 provider/bucket before any read; misconfiguration is recoverable. HEAD establishes existence and usable integer size. Zero/over-limit → `MEDIA_SIZE_INVALID`; in-range size unequal to the immutable expectation → `MEDIA_METADATA_MISMATCH`. Exact R2 Content-Type must equal the persisted/signed allowlisted MIME; missing, different, parameterized or case-changed MIME → `MEDIA_METADATA_MISMATCH`.
- Deterministically invalid objects transition through `uploaded` to `quarantined` with actual size, original `uploaded_at`, `quarantined_at` and `integrity_failure_code`; their session becomes `failed` with `completed_at = NULL`. The route explicitly commits these 422 outcomes. States and audit commit together; audit failure rolls everything back.
- Success writes validated size, `uploaded_at`, `active`, `completed`, `completed_at` and audit atomically. Completed replay returns stored data without rereading R2 or adding another success audit. Session locks serialize overlapping completions; full payload/concurrency idempotency remains B03.
- Storage timeout, 5xx, missing/unusable size, partial-read failure, version changes and temporary inspector/runtime failures produce safe 503 `MEDIA_STORAGE_UNAVAILABLE`. No integrity result, upload timestamp, activation or quarantine is recorded; the session remains retryable pending. A missing object retains 409 `UPLOAD_NOT_FOUND_IN_STORAGE`.
- Audit actor and request correlation come only from verified transaction-local GUCs. Events: `media.upload_session_created`, `media.upload_session_expired`, `media.upload_completed`, `media.quarantined`. Audits/errors/logs contain no bucket, key, signed URL, object bytes or provider response. Existing authorization and NOBYPASSRLS assumptions remain in force.

## Migration: YES — 0025

Previous schema had no durable exact expectation or quarantine clock. Added only:

| Table | Additions | Invariant |
| --- | --- | --- |
| `upload_sessions` | `integrity_version`, `expected_size_bytes` | Historical rows become `legacy` with NULL expectation; future inserts default to `v1` and require a positive expectation. |
| `media_assets` | `quarantined_at`, `integrity_failure_code` | B02 invalidation persists the server clock and one of the three existing safe integrity codes or the internal MEDIA_FORMAT_UNSUPPORTED / MEDIA_INSPECTION_LIMIT_EXCEEDED distinctions. |

Drizzle schema, generated snapshot/journal and SQL columns/checks agree. A SECURITY INVOKER trigger imposes the per-type maximum and immutable tenant/asset/version/expectation identity, and prevents API/worker insertion of fabricated legacy sessions. The diagnostic check permits retaining quarantine evidence in a later `deleted` state; it implements no delete/purge transition. Existing PKs, tenant FKs, indexes, deletion behavior, FORCE RLS, signed-evidence guards and grants are retained. No new lookup index is needed for these ID-addressed operations. Migration uses the existing transactional runner and a 5-second lock timeout.

No historical expected size or quarantine timestamp is fabricated; historical evidence/statuses remain unchanged. Legacy pending sessions expire with durable `UPLOAD_SESSION_EXPIRED` before HEAD, requiring a new key/session. Historical completed replay is a read of already-active history, not a new v1 validation. The strict v1 writer requirement is retained. Pre-B02 runtime rollback is prohibited after 0025; use the implemented and tested pinned v1 recovery procedure below. Deploy migration only after quiescing old writers and validating a compatible candidate AND recovery artifact.

Fresh DB, upgrade from the previous 25-migration main with pending/completed/failed legacy rows, and rerun no-op all pass. The existing reception upgrade suite also passes without rewriting historical columns; it explicitly checks that newly added historical quarantine/evidence fields remain NULL.

## Real-format inspection and resource limits

The backend reads only the object already in R2; client uploads continue directly to R2. Range and If-Match are signed with SigV4. ETag pins the HEAD observation as an opaque version token. GET must return exact 206 Content-Range, expected length and same ETag; ignored ranges, encoding, oversized or truncated transport responses are recoverable infrastructure failures.

One completion has a 10-second deadline/AbortController, with a 5-second default for standalone HEAD. Each range is at most 1 MiB; non-video inspections read at most 21 MiB total (published object maxima are at most 20 MiB), and video inspection reads at most 2 MiB total. Inspection calls/top-level video atoms are capped at 128; nested atom lists at 10,000 and PNG chunks at 4,096. Non-video bytes occupy a bounded input buffer plus one range buffer; PNG expansion is streamed in 64 KiB chunks and stops on inconsistent length. Expected PNG expansion above 64 MiB is a deterministic technical inspection limit with terminal MEDIA_CONTENT_INVALID and internal MEDIA_INSPECTION_LIMIT_EXCEEDED; it is not a new product dimension policy. No video `mdat` body is loaded. No runtime bytes are persisted or logged.

| MIME | Structural evidence |
| --- | --- |
| `image/png` | Signature; ordered IHDR/IDAT/IEND, bounded lengths, all chunk CRCs, valid dimensions/color/depth, zlib integrity, exact scanline byte count and filters including Adam7. |
| `image/jpeg` | SOI/EOI, bounded marker/table/scan segments, frame dimensions, quantization/Huffman table structure and nonempty entropy data; truncation rejected. |
| `image/webp` | Exact RIFF/WEBP length and chunk bounds, VP8/VP8L frame header, dimensions and VP8X reserved fields. |
| `application/pdf` | PDF header, terminal EOF/startxref, classic xref entries or bounded unfiltered/Flate xref streams pointing to actual numbered objects and a catalog/page-tree root. |
| `video/mp4`, `video/quicktime` | Explicit ftyp brand family, bounded atom lengths including 64-bit sizes; moov/mvhd, video track/handler, track/media headers, sample descriptions, size/timing table consistency, chunk-offset table and offsets inside an mdat. moov may follow a large mdat. Fragmented containers with empty init sample tables, mvex/trex defaults, explicit or moof-relative data bases, and trun sample sizes/byte spans are supported without reading samples. |

References: [PNG structure/CRC](https://www.w3.org/TR/png/), [QuickTime atoms](https://developer.apple.com/documentation/quicktime-file-format/atoms), [HTTP Range/If-Match](https://www.rfc-editor.org/rfc/rfc9110.html).

This is bounded structural format validation, not a complete decode of every JPEG/WebP/video sample, arbitrary PDF stream validation, malware scan or proof that a video is 360°. Payload corruption invisible to these structural checks is not claimed detected. Animated PNG/WebP, ambiguous old MOV without ftyp, unrecognized MP4 brands, incremental/hybrid PDFs, xref predictors/object streams/indirect stream lengths, implicit fragment bases or mixed init/sample-table video layouts remain unsupported. These deterministic structures terminate with public 422 MEDIA_CONTENT_INVALID, quarantined asset + failed session + one audit, and internal MEDIA_FORMAT_UNSUPPORTED. The public code means that the object cannot satisfy completion integrity with this bounded inspector; it does **not** assert that an unsupported valid format is corrupt. Deterministic ceilings use internal MEDIA_INSPECTION_LIMIT_EXCEEDED with the same terminal public outcome. Failed replay returns UPLOAD_SESSION_FAILED without R2 or further audit. There is no new public error code or enum state.

## Review fixes: transaction and observation guarantees

The original two-line tenant-request change only extends the closed durable-code map. It never commits by exception class or arbitrary 4xx. Commit requires a server-declared route code, an explicit mark, matching HTTP status and a completed resource authorization tripwire. Generic onError, serialization/onSend failure and unmarked error responses roll back. Completion now **returns** completed/durable-error outcomes from Phase C; its route alone marks returned expiration/quarantine outcomes. Thrown MediaError instances receive no durable mark. Existing create-expiration behavior is preserved.

The media inspection gap is registered only for POST `/api/v1/media/upload-sessions/:id/complete`, media.upload, tenant scope; other routes cannot request it. Phase A uses no row locks and is rolled back/released before HEAD, Range GET or parsing, including when storage fails. Phase C uses a new reserved client and repeats identity verification, active membership discovery/validation, GUC binding, RBAC and exact original tenant/user/membership comparison. It locks session then asset, rechecks status/expiry/deletion markers, and compares captured version/expected size, session/asset identity, expiry, MIME, media type, provider/bucket/key and asset status before using the observation. SQL contains tenant predicates plus FORCE RLS; `unsafe` SELECTs use bound $1/$2 parameters and only a server-controlled FOR UPDATE suffix.

ETag is an opaque Phase-B version token; every Range is signed with If-Match and must return the same ETag. Applicability after inspection additionally relies on B01's write-once object capability: unique opaque key, signed If-None-Match `*`, exact MIME, no client overwrite/delete capability. A second PUT is rejected with 412 in the real R2 gate. No external HEAD is introduced inside Phase C: PostgreSQL cannot atomically lock R2, and another HEAD would still have a cross-system race. Trusted bucket administrators/workers must preserve the write-once lifecycle; out-of-band replacement by privileged operators is outside this completion guarantee. No periodic reconciliation/purge behavior is added.

Delayed HEAD/GET tests observe zero idle API transactions, acquire session and asset NOWAIT locks from another connection, and create a session in a different tenant before releasing the delayed read. Tests mutate MIME, expiry, deletion markers and active membership during inspection and prove Phase C cannot activate stale observations. Concurrent completion still commits one completion/audit; B03 retains full idempotency ownership.

## Migration rollout and compatible recovery — R4

True previous-writer compatibility would allow missing/fabricated expectations or let the old completion path certify legacy content. It is not adopted. The strict 0025 invariant remains; the previous main INSERT column lists are tested after migration and fail with 23514, rolling back the preceding asset insert. Historical rows stay legacy, never fabricated v1. Fresh/upgrade/rerun remain covered, and startup checks reject pre-0025 or missing/disabled expectation constraints/trigger.

The local disposable drill is **implementation evidence**, not real staging certification. It pins an immutable GOOD v1 image, exercises the existing invalid-DB-credential failure, then builds a distinct disposable BAD candidate whose startup capability module and worker entrypoint intentionally fail. The BAD artifact uses valid, unchanged DB configuration; both API and worker exit nonzero and readiness fails. Recovery selects the previously pinned GOOD image ID for both processes, proves API readiness and real worker outbox claim/transition, keeps the complete 0025 ledger/constraints/triggers unchanged, preserves CRM/reception/media/audit history, and performs an authenticated v1 media create with its exact expectation, audit and signed write-once header. The fixture lives only in an OS temporary build context; it introduces no production failure flag or bypass. No shared staging/production deployment is claimed.

**Release prerequisite:** for any real target environment applying 0025, a v1-compatible recovery artifact must be an immutable image digest that has **already passed the required real staging gates before 0025 is applied to that target**. Production application of 0025 is forbidden without that previously staged, retained and pinned recovery digest. Local builds, capability probes and the disposable drill alone do not establish known-good status. Writers remain stopped if no previously validated v1 recovery digest exists.

For the **first B02 production rollout**, promote the exact immutable image digest that successfully passed the REAL staging environment as the initial known-good v1 recovery artifact. Record its staging results and digest in the production release evidence before production migration. The production candidate must also be pinned to an immutable digest. Initial promotion may use the same exact staging-validated digest for candidate and recovery; a failed or merely local/preflight candidate cannot serve as independent binary recovery evidence. The local binary drill must always demonstrate `GOOD_RECOVERY_IMAGE_ID != BAD_CANDIDATE_IMAGE_ID` and restore GOOD after BAD fails.

Deployment procedure (same compose services and migration runner):

1. Build immutable v1 artifacts and retain the exact recovery digest already validated by real staging, together with an immutable production candidate digest. Record both digests and the prior real staging gate evidence in the release record. For each retained artifact run `docker run --rm --entrypoint node <immutable-image-reference> dist/media/deployment.js --artifact-capability`; require exit 0 and `MEDIA_INTEGRITY_WRITER_v1`. A capability probe supplements the staging evidence; it does not replace it. The local drill pins Docker content IDs (`docker image inspect --format '{{.Id}}' <image>`). Registry promotion must record and deploy the exact `repository@sha256:...` manifest digest validated in staging. Mutable tags are never recovery evidence. Never rebuild "the same version" after migration or substitute a new digest for the validated artifact.
2. Quiesce/drain old API and worker processes before migration (`docker compose ... stop api worker`). Keep them stopped throughout migration. Apply 0025 to a real target only after the previously staged recovery prerequisite is satisfied; use the locked transactional `migrate` service, followed by `provision-runtime-login`. No migration down/relabeling, trigger disablement, or fabricated legacy session is permitted.
3. Set API/worker images to the immutable v1 candidate digest and start them. Preserve the production startup checks for the 0025 schema, expectation/failure constraints, enabled trigger and v1 default, plus the release artifact capability gate. An artifact without `MEDIA_INTEGRITY_WRITER_v1` must never reopen writers. Require readiness, authenticated media creation with persisted v1 size and audit, worker operation, tenant/RBAC/CRM/reception and log/audit staging gates.
4. On candidate binary or configuration failure, keep PostgreSQL at 0025 and redeploy API **and worker** to the previously validated, pinned GOOD v1 recovery digest using a compose override. Restore valid configuration; require readiness, worker operation, authenticated v1 writer and data/history preservation. **Old/pre-B02 images are never valid recovery targets after 0025.** If the retained artifact is unavailable, leave writers stopped until the exact validated artifact is restored; never relax integrity constraints or rebuild a replacement version to recover service.
5. Run `npm run staging:deploy-drill:ci` as implementation verification before rollout. Require GOOD/BAD immutable IDs, differing digests, BAD capability/startup rejection with valid DB configuration, GOOD API and worker recovery to the recorded ID, schema still at 0025, persisted data/history preserved, authenticated v1 media creation after recovery, and cleanup PASS. Also require the existing bad-credential scenario. The drill removes its local stacks/images and temporary environment/override/build files. **Real staging promotion remains a separate prerequisite before production migration.**


Local R4 binary drill evidence (2026-10-06):

- `GOOD_RECOVERY_IMAGE_ID`: `sha256:a5caaeacf13036def240196c5aed7d00d5be67e3a05715c92800e6eaeb7a84a0`
- `BAD_CANDIDATE_IMAGE_ID`: `sha256:8938a945b53b13802a012e9675b9120c6698afa8f5fd5cf84b0e3ef212363fc3`
- Digests differ; BAD capability/startup rejected for both processes; GOOD restored both container image IDs, API readiness and worker DB claim/transition. Ledger stayed at 26 migrations with latest `0025_s4_b02_media_integrity`; constraints/triggers and persisted CRM/reception/media/audit history matched the pre-failure snapshots. Authenticated v1 create returned 201 after recovery, with expected size 68, write-once header and one creation audit. Cleanup PASS.

These disposable local images were removed by cleanup. Their IDs document implementation evidence only; they are not retained or certified production recovery artifacts. A real staging-validated digest must still be promoted and retained before production 0025.


## Checksum terminology and pending gates

`checksumSha256` / `checksum_sha256` retain their compatibility name. A client declaration must be exactly 64 hex characters and is normalized lowercase. It is **declared/unverified**, including historical values. Tests intentionally activate with a syntactically valid declaration different from actual bytes to prevent any accidental claim of verification. ETag is never stored/compared as SHA-256. No full-object SHA-256 is computed: reading/hash-processing 750 MiB videos adds cost beyond this bounded integrity inspection. A future verified checksum requires separate persisted method/object/time evidence.

- **DURATION_POLICY_UNRESOLVED — NOT PASS:** no numeric video duration maximum or rejection invented; no claim of full video integrity under the unresolved duration requirement.
- **B04:** initial operational domain/consent binding and reception/damage associations remain blocked. Integrity tests use a clearly marked privileged operational fixture; the public endpoint does not fake this context.
- **B03:** full semantic create/complete replay equivalence, concurrent create conflict handling and renewed PUT lifetime remain pending. Expected size/MIME conflicts on pending create are already rejected, and completion is serialized, without claiming B03 complete.
- **B05:** uses the newly persisted quarantine clock; no retention engine, historical-clock reconstruction or hold subsystem implemented.
- B06/B07/B08, purge, assignment resolution, periodic R2 reconciliation and offline synchronization remain outside scope.
- Real external R2 functional testing passed, but this is not production certification of every format, 750 MiB latency/cost, duration policy or operational domain path.

## Test evidence — 2026-10-06

PostgreSQL 18 ran in an isolated disposable local container; API suites used NOINHERIT/NOBYPASSRLS logins. Hermetic tests require no R2 credentials. External R2 testing used only synthetic tenant/object IDs and confirmed object/database/login cleanup. No credentials were copied into the worktree or evidence.

| Command | Result | Exit |
| --- | --- | --- |
| `npm ci` | 94 packages installed from lockfile | 0 |
| `npm audit --omit=dev` | 0 vulnerabilities | 0 |
| `npm run security:secret-scan` | SECRET_SCAN_PASS | 0 |
| `npm run typecheck` | PASS | 0 |
| `npm run lint` | PASS | 0 |
| `npm run build` | PASS | 0 |
| `npm test` | 163/163; authz 26, tenant core 78, Wompi 20, presign 5, bounded integrity/transport 34 | 0 |
| `npm run test:media:api:ci` | 52/52; includes terminal unsupported retry, xref streams, real fragmented video, delayed I/O/no transaction, Phase-C mutations, old-writer rejection and v1 recovery | 0 |
| `npm run test:media:upgrade:ci` | fresh + upgrade + rerun, ledger 26, preserved history/RLS, cleanup PASS | 0 |
| `npm run test:reception:api:ci` | 123/123 including signature regression; cleanup PASS | 0 |
| `npm run test:tenant-context:api:ci` | 75/75; durable outcomes/RLS, unrelated 422 without mark, thrown MediaError, exception after explicit mark all rollback; cleanup PASS | 0 |
| `npm run test:reception:upgrade:ci` | 19 upgrade/preflight scenarios; rollback/history/rerun/cleanup PASS | 0 |
| `node --test tests/media/r2-network.test.cjs tests/media/r2-transport.test.cjs` | 23/23 | 0 |
| `R2_EXTERNAL_GATE=1 node --env-file=<existing-local-env> scripts/test-media-r2.cjs` | real R2 6/6; no recovered transport failures; signed conditional PUT/HEAD/Range/GET and cleanup PASS | 0 |
| `npm run test:crm:api:ci` | 75/75; CRM partial-write/audit rollback retained | 0 |
| `npm run test:identity:ci` | 89/89; identity/authentication boundary retained | 0 |
| `npm run test:member-lifecycle:ci` | 48/48; mutation/audit rollback retained | 0 |
| `npm run staging:deploy-drill:ci` | all gates PASS; distinct immutable GOOD/BAD images; bad config and binary rejected; GOOD restores API and worker DB polling; 0025/data/history preserved; authenticated v1 create; cleanup PASS (local implementation evidence) | 0 |
| `DATABASE_URL=<local> npm run db:generate` | no schema changes / snapshot parity PASS | 0 |
| AVFoundation independent fixture decode | fragmented MP4 and MOV, 3 frames each | 0 |
| `git diff --check` | PASS | 0 |

DB commands require a disposable local admin `DATABASE_URL`; normal `npm test` remains hermetic and has no PostgreSQL/R2 credential requirement. New binary fixtures are tiny synthetic files documented in [fixtures README](../tests/media/fixtures/README.md). API raw body is still limited by Fastify; no upload-byte body field was added.
