\# TallerMecario Backend — AGENTS.md



Multi-tenant SaaS for vehicle workshops (Colombia). Modular Monolith.



This repository is the \*\*backend\*\*: API, worker, and database schema/migrations. API and worker may share code and a container image with different start commands. The PWA lives in a separate repository; do not add frontend code here. Anything the PWA consumes (API DTOs, stable error codes, offline sync operations, public token flows) is defined by this backend, and a change to it must be documented before merge.



Stack: Node.js + Fastify + TypeScript + Zod, PostgreSQL 18.x + Drizzle, Cloudflare R2, Clerk (behind an `IdentityProvider` interface), WhatsApp Cloud API (one WABA per workshop), and Wompi.



Product name: \*\*TallerMecario\*\*. ILVOX identifies the organization/operator where the documentation requires it (for example data-processing responsibilities or workshop → ILVOX billing), not the product.



The canonical docs are written in Spanish; their titles below are kept in Spanish so they can be located exactly.



\## 1. Source of truth



If this file contradicts `/docs`, `/docs` wins.



Do not load all of `/docs` by default. Read only the relevant documents/sections and their explicit dependencies.



| Topic                                            | Document                                                               |

| ------------------------------------------------ | ---------------------------------------------------------------------- |

| Architecture, flows, API                         | Arquitectura Técnica v1 — TallerMecario                                |

| Tables, columns, types, mutability (`schema.ts`) | Diccionario de Datos v1 — pages 01 to 05                               |

| Relations, indexes, composite FKs, migrations    | Modelo de Datos / ERD v1                                               |

| States and transitions                           | Estados y Transiciones por Dominio v1                                  |

| Permissions and roles                            | RBAC — Matriz completa de roles y permisos v1                          |

| RLS and PostgreSQL privileges                    | ADR-009                                                                |

| Wompi and WhatsApp                               | Contratos Externos — Wompi + WhatsApp v1                               |

| Inventory, catalog, dashboard                    | Inventario y Dashboard Comercial v1 — TallerMecario + ADR-010          |

| Security                                         | Security Baseline — Aplicación y Plataforma                            |

| Retention, backups, observability, migrations    | Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario |

| Personal data                                    | Protección de Datos Personales — Colombia v1                           |

| Tests per sprint                                 | Quality Gates — Reglas y Pruebas por Sprint                            |

| Architectural decisions                          | ADR-001 to ADR-010                                                     |



A structural change requires updating ERD + Dictionary, and an ADR if it changes an architectural decision, before merge.



If a topic is not covered, do not invent tables, columns, states, permissions, endpoints, or domain rules.



If two canonical sources contradict each other, record `DOC\_CONFLICT`, continue with unaffected work, and ask only if the conflict blocks the current task. List every `DOC\_CONFLICT` in your final summary, naming the two sources and the affected task.



\## 2. Invariants (never break)



1\. \*\*Tenant isolation:\*\* `tenant\_id` comes exclusively from `TenantContext`, never from body, params, query strings, or an external provider. Tenant-aware relationships use composite FKs such as `(tenant\_id, fk\_id) → parent(tenant\_id, id)`, with the corresponding child-side index. Apply RLS `ENABLE + FORCE` according to ADR-009; runtime roles are `NOBYPASSRLS`, and tenant context is transaction-local. Every tenant-owned change requires cross-tenant tests in PostgreSQL and through the API.



2\. \*\*Authorization and state:\*\* authorization is deny-by-default by permission code. States change only through domain commands.



3\. \*\*Append-only histories:\*\* runtime cannot UPDATE/DELETE/TRUNCATE `order\_status\_history`, `quote\_authorizations`, `inventory\_movements`, `billing\_events`, `audit\_logs`, or `webhook\_events`. FKs pointing to append-only history use RESTRICT/NO ACTION, never CASCADE.



4\. \*\*Quotes:\*\* a sent quote version is immutable; changes create a new version. A technician may only propose a `supplemental` quote in draft with `labor` lines and cannot send or authorize it. A supplemental quote does not change the order state.



5\. \*\*Public customer access:\*\* quote authorization requires a quote token plus verified OTP. An order-tracking token cannot authorize. Tokens and OTPs are persisted only as hashes and `expires\_at` is always validated. The end customer never has a user, membership, or RBAC role.



6\. \*\*Inventory:\*\* every stock change creates an `inventory\_movement` and updates `inventory\_balances` in the same transaction under the required lock. Never mutate `quantity\_on\_hand` directly. Negative stock is rejected. Corrections use compensating movements. `track\_inventory=true` only applies to `item\_type=part`; `location\_id` is always explicit.



7\. \*\*Derived data:\*\* dashboard metrics derive from operational records; do not create a mutable `dashboard\_metrics` source of truth. Commercial participation uses `sales\_originator\_membership\_id`, not `created\_by`. `deliveries.payment\_status` and `outstanding\_balance` derive from the payments ledger. `quantity\_actual` does not increase `quantity\_billed`.



8\. \*\*Money, dates, and IDs:\*\* money uses `bigint` minor units, never float. Dates/times use `timestamptz` UTC. Primary keys are UUID/UUIDv7 generated by the application according to the canonical schema.



9\. \*\*Media:\*\* never store binary media in PostgreSQL. Upload directly to R2 using short-lived signed URLs. `object\_key` must not contain PII. Use domain-specific link tables with real FKs; do not introduce polymorphic `media\_links`.



10\. \*\*External integrations:\*\* asynchronous external effects that must not couple the internal transaction to a provider (WhatsApp, Wompi, email) use `outbox\_events` + worker. Synchronous exceptions must be explicitly allowed by the canonical contract/architecture, such as R2 signed URLs or identity-provider authentication. External-provider failure must not roll back an already committed internal transaction.



11\. \*\*Webhooks and idempotency:\*\* verify signature over the raw body → persist → ACK → process asynchronously. Preserve `UNIQUE(provider, provider\_event\_id)` where defined. Use `Idempotency-Key` on sensitive operations and `operation\_id` for offline mutations. The offline client is never authoritative: synchronized operations pass through RBAC, TenantContext, domain validation, and RLS again.



12\. \*\*Channels and billing:\*\* WhatsApp is a communication channel, not a source of truth. Resolve inbound tenant server-side from the configured `phone\_number\_id`. SaaS billing through Wompi and customer payments to the workshop (`customer\_payments`) are separate domains. Application modules consume local entitlements, not Wompi directly. A `confirmed` customer payment is immutable; corrections use reversal plus a new payment.



13\. \*\*Data security:\*\* never log tokens, OTPs, signatures, payment-card data, JWTs, secrets, or unnecessary PII. `audit\_logs` use minimized, allowlisted before/after data.



14\. \*\*Architecture and migrations:\*\* TallerMecario is a Modular Monolith. Do not introduce microservices. Do not import another module's internals; consume its public contracts. Migrations are forward-only using expand/migrate/contract where required. Only the migration runner executes DDL.



\## 3. Schema, PostgreSQL, and migrations



\* Source of tables and columns: `Diccionario de Datos v1`, pages 01 to 05, together with the ERD. Compute the actual table inventory during audits; never assume a fixed count.

\* Types, nullability, defaults, mutability, and column-level constraints come from the Dictionary.

\* Relationships, composite FKs, mandatory indexes, integrity rules, and migration dependencies come from the ERD.

\* Do not rename or change documented columns, types, constraints, or relationships without a corresponding documentation change.

\* Anything Drizzle cannot express reliably belongs in migration SQL, such as deferred constraint triggers, REVOKE, `SECURITY DEFINER` functions, defensive append-only protections, or other cross-row constraints.

\* Do not apply generic tenant RLS to global or mixed-scope tables. Verify the exact classification in the Dictionary and ADR-009 before creating policies.

\* Examples that require special treatment include `plans`, `users`, `roles`, `permissions`, `data\_subject\_requests`, `privacy\_security\_incidents`, `legal\_acceptances`, and other documented nullable-tenant/mixed-scope tables.

\* Preserve non-trivial documented constraints, including exactly one primary location per workshop, the XOR constraint on `signatures`, and one final authorization decision per quote version.

\* Respect ERD FK dependencies. If an FK references a table created later, add the FK in a later migration; never weaken or remove the relationship merely to solve migration ordering.

\* When the environment permits, validate meaningful schema work through the full chain: canonical docs → `schema.ts` → generated PostgreSQL DDL → PostgreSQL runtime.

\* A successful TypeScript compile or Drizzle generation alone does not prove schema correctness.



\## 4. States and transitions



Canonical source: `Estados y Transiciones por Dominio v1`.



Do not invent states, transitions, enum values, terminal-state behavior, or reopening rules.



State changes happen only through documented domain commands. Never implement generic endpoints that write `status`.



Before modifying a state flow, read its canonical section.



\## 5. RBAC



Canonical source: `RBAC — Matriz completa de roles y permisos v1`.



System roles: `owner`, `admin`, `service\_advisor`, `technician`.



Authorization is deny-by-default by permission code. Do not hardcode domain authorization decisions using role names.



Permissions marked `A` (assigned resources) or `Q` (quality control) are resolved server-side against `assignments` and actual resource context, never through client-supplied flags.



Preserve the documented anti-escalation, last-owner, assignment, and separation-of-duties rules.



Before creating or modifying permissions, seeds, authorization guards, or resource-scope rules, consult the canonical matrix.



\## 6. Out of scope for the MVP



Do not implement these without an explicit ADR + ERD change:



\* suppliers;

\* purchase orders;

\* accounts payable;

\* lots, serial numbers, or expiry tracking;

\* stock reservations;

\* average/FIFO inventory costing;

\* accounting profit;

\* official accounting;

\* commissions or payroll;

\* custom roles per workshop;

\* internal platform access or impersonation;

\* machine-to-machine API keys.



\## 7. Quality Gates



Canonical source: `Quality Gates — Reglas y Pruebas por Sprint`.



A sprint ends only when its applicable Gate is `PASSED` with verifiable evidence.



\* Required test not executed = `NOT\_READY`.

\* Cross-tenant leak = `FAIL`.

\* Data loss or corruption = `FAIL`.

\* Duplicate charge/payment effect = `FAIL`.

\* Incorrect authorization = `FAIL`.

\* Blocking regression = `FAIL`.

\* Never report `PASS` for a check that was not actually executed.

\* Never manually convert a `FAILED` Gate into `PASSED`.



Before closing a sprint task, consult only the Gate for the affected sprint and any explicitly required transversal criteria.



The applicable Quality Gate is the Definition of Done; do not maintain a parallel DoD.



\## 8. Current phase



Documentation Freeze is lifted.



Implement and correct `schema.ts`, migrations, seeds, RLS/policies, and triggers from the ERD + Dictionary.



Sprint 0 is not yet `PASSED`; Sprint 1 remains blocked by its Gate.



\## 9. Commands



Use the scripts defined in `package.json`.



Do not invent commands, change package managers, or install global tools when the repository already provides the required script or dependency.



Before running database/schema commands, inspect the relevant package scripts and Drizzle configuration.



Do not claim a check passed unless the command actually ran successfully.



\## 10. Backend and database safety



\* Never read, print, or commit `.env` files or secrets. Run commands only against the local or CI database, never staging or production.

\* Do not use `drizzle-kit push` or any command that changes the schema without a migration file. Schema changes go through generated, reviewed migrations.

\* Isolation and RLS tests must connect with the runtime roles from ADR-009 (`NOBYPASSRLS`, non-owner), never as owner, migrator, or superuser, which bypass RLS and make the test pass falsely. Use at least two tenants.

\* API conventions (base path `/api/v1`, stable error codes with `request\_id`, DTO allowlists, `Idempotency-Key`) come from `Arquitectura Técnica v1 — TallerMecario`; do not invent alternatives.

