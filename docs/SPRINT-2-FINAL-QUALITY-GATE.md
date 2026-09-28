# Sprint 2 — Final Quality Gate evidence (T9, 2026-09-28)

**Sprint 2 Quality Gate: PASSED. Date: 2026-09-28.** Independent evidence review accepted the final remote evidence. This documentation closure was written after the tested commit and does not change the tested product SHA.

## Gate record (Quality Gates §2)

- **Sprint:** 2.
- **Gate / task:** S2-08 T9 Final Quality Gate.
- **Date:** 2026-09-28.
- **Version / commit:** `9e0254d4056e614fdc67ea110e785d761de43ff9` (tested SHA).
- **Environment:** GitHub Actions + disposable staging.
- **Responsible:** Iván Leonardo Patiño Suárez.
- **Independent reviewer:** Claude / independent evidence review (completed and accepted).
- **Cases executed / PASS–FAIL:** `validate` PASS; `mutations` PASS (122/122 killed); `staging` PASS (20/20 gates), including migration ledger 19/19, CRM E2E, tenant isolation, ownership history, exact audit, log privacy, rollback/recovery, and cleanup. See the detailed evidence below.
- **Evidence:** GitHub Actions run [#36390497888](https://github.com/IvanBy12/TallerMecarioB/actions/runs/36390497888) on the tested SHA.
- **Known blocking defects:** none.
- **Deferred items:** D-02, D-11, D-22 and the previously documented staging/observability scope; details below. These are not gate defects.
- **Final decision:** PASSED.

- Branch: `task/s2-08-final-quality-gate`
- Tested commit (full SHA): `9e0254d4056e614fdc67ea110e785d761de43ff9`
- GitHub Actions run: [CI #36390497888](https://github.com/IvanBy12/TallerMecarioB/actions/runs/36390497888), push event for that SHA.
- Job conclusions on that run: `validate=success` (job `108825033335`), `mutations=success` (job `108825777754`), `staging=success` (job `108825777711`).
- CI runner Node: `v22.23.2` (mutation and staging logs). The mutation job alone sets `NODE_OPTIONS=--test-reporter=spec`.
- Main branch: **not merged**. This evidence document was created after the green run and is not part of the tested SHA.

## T9 CI history and local checks

Commit `c3ce50e` enabled the `task/s2-08-final-quality-gate` ref in the `mutations` job condition so the remote T9 mutation gate could execute. Commit `9e0254d` pinned `NODE_OPTIONS=--test-reporter=spec` only in the `mutations` job for Node 22. Neither commit changed product behavior. No product, parser, test, schema, migration, `validate`, or `staging` changes were made by these T9 CI corrections. The final tested SHA is `9e0254d4056e614fdc67ea110e785d761de43ff9`; run #36390497888 has green `validate`, `mutations`, and `staging` jobs on that exact SHA. Strict YAML 1.2 parse with unique-key validation passed. Exactly one `NODE_OPTIONS` appears, under `mutations`; all nine mutation `npm run` scripts exist; no `continue-on-error` appears. `git diff --check`, secret scan (`SECRET_SCAN_PASS`), typecheck, build, lint, and `npm test` passed locally. The first sandboxed build attempt could not write `dist/` in the external worktree; the write-enabled rerun passed with no TypeScript errors.

## Remote validate — PASS

Every `validate` step concluded `success`: secret scan (`SECRET_SCAN_PASS`), production dependency audit (`npm audit --omit=dev`: 0 vulnerabilities), typecheck, Biome lint (184 files), and build. Functional steps passed for RBAC and TenantContext core/DB/API, clean migration and PostgreSQL, multitenant API, Clerk identity and upgrade, API security, onboarding, invitations and upgrade, membership roles/lifecycle and upgrades, Sprint 1 audit and upgrade, final cross-tenant isolation, CRM PostgreSQL integrity, CRM migration upgrade, CRM customer/vehicle/ownership API, outbox, Wompi, concurrent-migration lock, and RBAC documentation parity. These are conclusions from job `108825033335` in the same run, not from a different SHA.

## Remote mutations — PASS

All nine mutation steps concluded `success` on Node `v22.23.2`:

| Runner | Killed / total |
| --- | ---: |
| Sprint 1 role mutations | 13/13 |
| Sprint 1 membership lifecycle mutations | 15/15 |
| Sprint 1 audit mutations | 15/15 |
| Sprint 1 cross-tenant mutations | 9/9 |
| CRM database mutations | 12/12 |
| CRM customer API mutations | 18/18 |
| CRM vehicle API mutations | 22/22 |
| CRM ownership API mutations | 17/17 |
| Request logging privacy mutation | 1/1 |
| **Total** | **122/122** |

The nine runner summaries account for the entire expected set: **0 survived, 0 invalid, 0 apply failures**. No product defect or real mutation survivor was found. Historical diagnostic run [#36372003509](https://github.com/IvanBy12/TallerMecarioB/actions/runs/36372003509) failed because Node 22 emitted a reporter format the mutation parsers did not classify; it is not used as final green evidence.

## Remote staging — PASS

Job `108825777711` ran `staging:deploy-drill:ci` on Node `v22.23.2` in a disposable Docker stack. The `STAGING_DRILL_REPORT` marks all 20 fields PASS, including build, deploy, migration, health/live/readiness, smoke, CRM E2E, tenant isolation, ownership history, audit, log privacy, bad configuration, rollback recovery, data preservation, redeploy, and cleanup.

| T8 gate | Remote evidence |
| --- | --- |
| Migration ledger | `MIGRATION_LEDGER_PASS 19/19; latest 0018; plate check valid; history guard enabled`. Ledger hashes/timestamps match the 19 migration files and journal entries. |
| Migration idempotency | `MIGRATION_IDEMPOTENCY_PASS 19/19; schema unchanged` after a second migration pass. |
| CRM E2E and tenant isolation | `CRM_E2E_PASS`: 23 deployed HTTP requests across two tenants, including customer, vehicle, lookup, ownership change and history. Report fields `crm_e2e` and `tenant_isolation` are PASS. |
| Ownership history | E2E confirms microsecond timestamps and unchanged vehicle row; report field `ownership_history` is PASS. |
| Exact audit | `AUDIT_EXACT_PASS A=7 B=3 total=10`. |
| Log privacy | `STAGING_LOG_PRIVACY_PASS 23 completion events; closed field contract`. |
| Bad-config recovery | Bad deploy correctly failed readiness; known-good redeploy succeeded. `bad_config`, `rollback_recovery`, and `rollback_redeploy` are PASS. |
| Data preservation | Report field `rollback_data_preserved` is PASS; migration ledger and schema stayed unchanged after recovery. |
| Cleanup | Report field `cleanup` is PASS; disposable stack and temporary artifacts were removed. |

## Known defects, deferred scope, and decision

- **Known defects from this gate:** none. Remote `validate`, `mutations`, and `staging` are green on the same SHA.
- **Deferred by existing contracts:** customer archive/delete (S2-02 D-02); non-owner/secondary ownership and a database trigger for the always-owned invariant (D-11); CRM `Idempotency-Key` (D-22, reconsider in Sprint 3 if mobile E2E needs it, otherwise Sprint 13); cloud staging before pilot; metrics, traces, SLO dashboards, alerts, and `trace_id` after Sprint 2. These are documented scope decisions, not newly discovered gate defects.
- **Final decision (2026-09-28): Sprint 2 Quality Gate PASSED.** Independent evidence review completed and accepted. The decision rests on `validate` PASS, `mutations` PASS (122/122 killed), `staging` PASS (20/20), migration ledger 19/19, CRM E2E PASS, tenant isolation PASS, ownership history PASS, exact audit PASS, log privacy PASS, rollback/recovery PASS, cleanup PASS, and no blocking defects. The decision does not imply a merge to `main`.
