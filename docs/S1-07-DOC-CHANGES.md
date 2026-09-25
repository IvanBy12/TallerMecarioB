# S1-07 audit global — cambios de documentación (NO canónicos todavía)

Preparado 2026-09-24 en el worktree `task/s1-07-audit` (base `task/s1-06-audit-fix` = `5a464f7`).
Alcance: subsistema de auditoría de Sprint 1 (S1-01 onboarding, S1-02 TenantContext/RBAC, S1-03 identidad,
S1-04 invitaciones, S1-05 roles, S1-06 memberships). Sin funcionalidad de negocio nueva.
Implementación: migración **0017** (`drizzle/0017_s1_07_audit_log_guards.sql`) + suite `tests/audit/*`.
Los docs canónicos del checkout principal y Notion **no** se editaron. Copiar **por secciones** (no reemplazar
archivos). Requerido antes de merge: AGENTS.md §1/§3 (privilegios de runtime y trigger nuevo → ADR-009 + Diccionario).
Este archivo se versiona con `git add -f` (el resto de `docs/` sigue gitignored).

| Destino (bajo `Arquitectura Técnica v1 — TallerMecario/`) | Sección | Texto | Clase |
| --- | --- | --- | --- |
| `Operación, Retención, Recuperación y Observabilidad v1 …md` | §5.1 reglas + §5.2 catálogo | A | DOC_UPDATE_REQUIRED |
| `ADR-009 — RLS y privilegios …md` | §10 "Reducciones aplicadas…" (viñeta 0017) + §11 | B | DOC_UPDATE_REQUIRED |
| `Diccionario de Datos v1 — PostgreSQL/Diccionario 04 …md` | §9 `audit_logs` (notas) | C | DOC_UPDATE_REQUIRED |
| `Modelo de Datos ERD v1 — PostgreSQL …md` | `## audit_logs` + §18 "Append-only protegido por PostgreSQL" | D | DOC_UPDATE_REQUIRED |
| `RBAC — Matriz completa de roles y permisos v1 …md` | §20 (lista mínima → referencia al catálogo) | E | DOC_UPDATE_REQUIRED |
| `Security Baseline — Aplicación y Plataforma …md` | §19 (JIT: IP/user-agent) | F | DOC_CONFLICT → DOC_UPDATE_REQUIRED |
| `../Arquitectura Técnica v1 — TallerMecario …md` (raíz) | §15 Auditoría | G | DOC_UPDATE_REQUIRED |

Sin tablas ni columnas nuevas. **Cambio de privilegios + trigger nuevo (0017)** → ADR-009 §10 y Diccionario 04 §9
deben actualizarse antes del merge. Sin ADR nuevo: no cambia una decisión arquitectónica (aplica ADR-009 §3
"membership_id/user_id se usan para auditoría", §10 "DML explícito, mínimo" y §11 "append-only"; PostgreSQL pasa a
hacer cumplir el contrato vigente, igual que 0015/0016).

---

## 0. Resultado del audit (resumen)

| ID | Sev. | Hallazgo | Estado |
| --- | --- | --- | --- |
| S107-01 | MEDIUM | La atribución de actor no la garantizaba PostgreSQL: `tenant_insert` solo liga `tenant_id`; un INSERT de runtime podía atribuir una fila a **cualquier** usuario de la plataforma (`actor_user_id` FK global), a cualquier membership del tenant, a `actor_type = provider/platform`, y el worker podía escribir filas `actor_type = 'user'`. El código de la app sí deriva el actor del contexto (sin ruta explotable vía API). | **CERRADO** (0017 guard) |
| S107-02 | MEDIUM | Runtime con `INSERT` de tabla ⇒ podía persistir `user_agent` (el hardening S1-04 era solo de app) y fijar `created_at` (backdating). | **CERRADO** (0017 grants por columna) |
| S107-03 | LOW | `request_id` de filas de la API era texto libre (correlación falsificable). | **CERRADO** (0017: = `app.request_id`) |
| S107-04 | LOW | `request_id` de filas de worker con dos formatos: S1-03 = id del outbox (uuid), S1-04 correo = `outbox:<id>`. | DOC_UPDATE (sin cambio de código; §7) |
| S107-05 | LOW | `role.assigned` tiene actor distinto según origen (S1-05: quien asigna; S1-04 aceptación: el nuevo miembro, asignador en `metadata.assigned_by_membership_id`; S1-01: el propio owner, `metadata.bootstrap`). | DOC_UPDATE (§2; `reason_code` distingue el origen) |
| S107-06 | LOW | Trigger append-only 0002 identifica runtime con `current_user IN (...)`: un login con `INHERIT` miembro de api/worker saltaría **esa** capa (no los grants). 0017 usa `pg_has_role(..., 'USAGE')`. | Deuda LOW (alinear 0002 en una migración futura) |
| S107-07 | INFO | Fila JIT (`identity.user_provisioned_jit`) usa como `audit_logs.id` el mismo UUID que `users.id`. Tablas distintas: sin colisión; solo inusual. | Sin cambio |
| S107-08 | INFO | `identity.webhook_event_conflict`: cada reentrega del mismo `svix-id` con otro hash deja una fila `denied` (acotado por los reintentos de Svix). | Sin cambio (documentado §6) |

Verificado sin hallazgo: no hay eventos duplicados por operación, ni mismo evento con nombres distintos; toda
auditoría de éxito es atómica con su escritura de negocio (API, onboarding, aceptación y worker); los denegados
durables confirman solo su fila; ningún `audit_logs` contiene JWT, token, hash, nonce, email, nombre, cookie,
Authorization ni User-Agent; RLS aísla lectura y escritura entre tenants; runtime sin UPDATE/DELETE/TRUNCATE.

---

## 1. Catálogo final de eventos (Sprint 1)

`entity_id` siempre presente salvo `membership.invited` denegado (no se creó nada). `user_agent` siempre NULL.
`ip_address` = IP del socket solo en filas de la API (nunca en worker/bootstrap). `request_id` = id generado por el
servidor (UUIDv7, nunca `X-Request-Id` del cliente) en filas de la API; correlación con el job en filas de worker.

| action | dominio | tenant | actor_type | outcome → reason_code | entity_type / entity_id | before / after / metadata |
| --- | --- | --- | --- | --- | --- | --- |
| `identity.user_provisioned_jit` | S1-01/S1-04 (JIT en onboarding y en aceptación) | NULL | user (= el usuario creado) | success → NULL | user / users.id | metadata `{identity_provider}` |
| `workshop.created` | S1-01 | nuevo taller | user | success → `workshop_onboarding` | workshop / tenant | after `{status, timezone, currency, primary_location_id}` |
| `membership.activated` | S1-01, S1-04 | taller | user | success → `workshop_onboarding` \| `membership_invitation` | membership / nueva membership | after `{status, user_id}`; metadata `{invitation_id}` (S1-04) |
| `role.assigned` | S1-01, S1-04, S1-05 | taller | user | success → `workshop_onboarding` \| `membership_invitation` \| `member_role_management`; denied → `role_assignment_not_permitted` (+`missing_permissions`) \| `self_role_modification` | membership_role / membership objetivo | before/after `{roles}`; metadata `{role}` (S1-05), `{assigned_by_membership_id, invitation_id}` (S1-04), `{assigned_by_membership_id, bootstrap}` (S1-01) |
| `role.revoked` | S1-05 | taller | user | success → `member_role_management`; denied → ídem `role.assigned` | membership_role / membership objetivo | before/after `{roles}`; metadata `{role}` |
| `membership.invited` | S1-04 | taller | user | success → `membership_invitation`; denied → `role_assignment_not_permitted` | membership_invitation / invitación (NULL si denied) | after `{status, target_role, expires_at}`; denied metadata `{target_role, required_permission}` |
| `membership.invitation_revoked` | S1-04 | taller | user | success → `membership_invitation`; denied → `role_assignment_not_permitted` | membership_invitation | success: before/after `{status}`, metadata `{target_role}`; denied: metadata `{target_role, required_permission}` |
| `membership.invitation_accepted` | S1-04 | taller de la invitación | user (sin membership si denied) | success → `membership_invitation`; denied → `invitation_email_mismatch` | membership_invitation | success: before `{status: pending}`, after `{status, accepted_membership_id}`; denied: sin before/after/metadata |
| `membership.invitation_expired` | S1-04 (materialización al crear/aceptar) | taller | **system** | success → `membership_invitation` | membership_invitation | before/after `{status}`; metadata `{materialized_by, target_role}` |
| `membership.invitation_email_sent` | S1-04 worker | taller | **system** | success → `membership_invitation` | membership_invitation | metadata `{provider, provider_message_id, outbox_event_id, attempt, lease_state[, invitation_status_at_record]}` |
| `membership.invitation_email_skipped` | S1-04 worker | taller | **system** | success → `membership_invitation` | membership_invitation | metadata `{reason, outbox_event_id, attempt[, prior_attempt_unconfirmed]}` |
| `membership.suspended` | S1-06 | taller | user | success → `member_status_management`; denied → `membership_management_not_permitted` (+`missing_permissions`) \| `self_membership_modification` | membership | before/after `{status}`; metadata `{command, roles}` |
| `membership.revoked` | S1-06, S1-03 worker | taller | user (S1-06) \| **provider** (S1-03) | S1-06 como `membership.suspended`; S1-03 success → `identity_provider_user_deleted`, denied → `last_owner_invariant` | membership | before/after `{status}` (en `last_owner_invariant` before = after: la membership se conserva); metadata S1-03 `{reason, user_id, webhook_event_id}` |
| `identity.user_provisioned_webhook` | S1-03 worker | NULL | **provider** | success → NULL | user | metadata `{identity_provider, provider_event_type, status}` |
| `identity.user_profile_synced` | S1-03 worker | NULL | **provider** | success → NULL | user | metadata `{identity_provider, provider_event_type, changed_fields}` (nombres de campo, nunca valores) |
| `identity.user_disabled` | S1-03 worker | NULL | **provider** | success → NULL | user | metadata `{identity_provider, provider_event_type, reason}` |
| `identity.user_deleted` | S1-03 worker | NULL | **provider** | success → NULL | user | metadata `{identity_provider, provider_event_type, observation, previous_status, membership_revocations_enqueued}` |
| `identity.webhook_event_conflict` | S1-03 webhook (API) | NULL | **provider** | denied → NULL | webhook_event | metadata `{identity_provider, reason: payload_hash_mismatch}` |

Eventos por operación (sin duplicados): onboarding = JIT (si el usuario es nuevo) + `workshop.created` +
`membership.activated` + `role.assigned`; aceptación = JIT (si nuevo) + `membership.invitation_accepted` +
`membership.activated` + `role.assigned`; creación de invitación = `membership.invited` (+ `invitation_expired` de una
pendiente vencida del mismo email). Cada comando S1-05/S1-06 = una fila. Reintentos idempotentes (revocar una
invitación ya revocada, reentrega de webhook duplicada, job ya aplicado, correo ya enviado) = **0 filas**.

`RBAC §20` no lista `workshop.created`, `membership.invitation_*` ni `identity.*`: son adiciones ya aprobadas en S1-01,
S1-03 y S1-04; el catálogo anterior es la fuente única propuesta (texto E).

---

## 2. Semántica de actor

- `actor_type = user`: `actor_user_id` = usuario verificado del request; `actor_membership_id` = membership del
  TenantContext (`app.membership_id`). Nunca del body, query, headers ni claims de Clerk. Excepciones documentadas:
  - aceptación S1-04: el actor es el usuario que acepta; `actor_membership_id` = la membership recién creada (NULL en
    `invitation_email_mismatch`, porque no hay membership); el asignador del rol va en
    `metadata.assigned_by_membership_id` (= `membership_roles.assigned_by_membership_id`);
  - onboarding S1-01: el nuevo owner es actor de su propio alta (`metadata.bootstrap = true`);
  - JIT: `actor_user_id` = el usuario provisionado, sin tenant ni membership.
- `role.assigned`: el actor es **quien ejecuta el comando**; cuando el asignador es otro (aceptación) va en metadata.
- `actor_type = system`: efecto automático sin usuario ni proveedor (materializar una expiración, resultado de un
  envío de correo). Ambos ids de actor NULL. Nunca se atribuye al usuario que disparó el request (aunque la API lo
  escriba dentro de su request).
- `actor_type = provider`: efecto causado por el proveedor de identidad (Clerk) — lifecycle S1-03 y la revocación de
  memberships de una identidad eliminada. Ambos ids de actor NULL; la persona afectada va en `entity_id`/metadata.
- `actor_type = platform`: reservado (acciones internas ILVOX futuras); **ningún runtime puede escribirlo**.
- **Garantía en PostgreSQL (0017, `audit_logs_actor_guard_trg`)** para sesiones runtime (`current_user` es, o hereda,
  `tallermecario_api`/`tallermecario_worker`, no superusuario):
  - API: `user` ⇒ `actor_user_id = app.user_id` (obligatorio) y `actor_membership_id IS NOT DISTINCT FROM
    app.membership_id`; `system` ⇒ sin ids de actor; `request_id = app.request_id` (obligatorio); `provider`/`platform`
    rechazados.
  - worker: solo `system`/`provider` sin ids de actor (un job nunca actúa como usuario, exista o no).
  - Rechazo: `42501`, constraint `audit_logs_actor_guard`.
  - Las funciones `SECURITY DEFINER` allowlisted (JIT, lifecycle de identidad) corren como su owner NOLOGIN y conservan su
    propio contrato (acciones/entidades allowlisted, actor fijo). Rutas que escriben fuera del guard, por diseño:
    `app.bootstrap_provision_user` (EXECUTE api; fila JIT, actor = el usuario provisionado),
    `app.ingest_verified_clerk_webhook` (EXECUTE api; `identity.webhook_event_conflict`, actor `provider`) y
    `app.identity_sync_apply` (EXECUTE worker; `identity.*`, actor `provider`). Solo escriben filas **sin tenant** y nunca
    atribuyen a un usuario distinto del provisionado; su `request_id` lo aporta quien llama (correlación, no autoridad).
- **Límite del guard (threat model ADR-009 §1/§3/§10.1, verificado en el audit final):** `app.tenant_id`,
  `app.user_id`, `app.membership_id` y `app.request_id` son **contexto transaction-local fijado por la aplicación**
  (`bindTenantContext` a partir de una membership validada en la misma transacción), **no prueba criptográfica**. Una
  sesión runtime con SQL arbitrario puede ejecutar `SET LOCAL app.user_id/app.membership_id = …` (o `app.tenant_id`)
  y luego insertar una fila atribuida a otro miembro, o a otro tenant, exactamente igual que puede leer/escribir los
  datos de ese tenant bajo RLS. El guard **no** protege contra una credencial runtime comprometida ni contra SQL
  directo malicioso. Lo que sí garantiza es que el código de la aplicación no puede escribir un actor, un tenant o un
  `request_id` distintos del contexto que ligó; contra ese tipo de error (bugs, valores tomados del request) está
  probado con mutantes. Tampoco verifica que `app.membership_id` pertenezca a `app.user_id`; ambos los fija
  `bindTenantContext` a partir de la misma fila. La FK compuesta sí impide una membership de otro tenant. Filas
  `system` de la API: el guard no restringe la acción; hoy la API solo escribe `membership.invitation_expired`.

## 3. Semántica de tenant

- `tenant_id` = TenantContext (`app.tenant_id`) en tenant routes; en la aceptación, el tenant de la invitación resuelta
  por hash exacto (ADR-009 §7.8); en el worker, el tenant del job reclamado. Nunca del request.
- `tenant_id IS NULL` solo para eventos `identity.*` (identidad global), escritos exclusivamente por las funciones
  `SECURITY DEFINER` allowlisted; ningún runtime puede insertar filas sin tenant (RLS `tenant_insert`).
- RLS `ENABLE + FORCE`: `tenant_select`/`tenant_insert` (api, worker) con `tenant_id = app.current_tenant_id()`.
  Sin contexto: 0 filas y todo INSERT rechazado. Filas sin tenant: invisibles para runtime.
- La entidad auditada pertenece al mismo tenant (FK compuesta para `actor_membership_id`; para `entity_id` la app solo
  audita entidades resueltas bajo RLS: un id de otro tenant ⇒ 404 **sin** fila, nunca una fila que lo mencione).
- Selección cross-tenant (`X-Tenant-Id` sin membership) ⇒ 403 **sin** fila en ningún tenant: escribirla en el tenant
  destino permitiría a un tercero contaminar su auditoría; el runtime tampoco puede escribir filas de plataforma.

## 4. Append-only

- Grants: runtime `SELECT` + `INSERT` por columnas; sin `UPDATE`/`DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER`.
- Tres capas independientes (verificado en el audit final): (1) **grants**: el rechazo primario es
  `42501 permission denied for table audit_logs`, antes de cualquier trigger; (2) **RLS**: no existe policy
  UPDATE/DELETE, así que con un grant regresado UPDATE/DELETE afectan 0 filas; (3) **trigger defensivo 0002**
  (`audit_logs_append_only_row_trg`, `…_truncate_trg`): rechaza TRUNCATE con el grant regresado, y UPDATE/DELETE si
  además regresara una policy. Runtime no puede deshabilitar triggers (no es owner) ni usar `session_replication_role`
  (requiere superusuario; `pg_parameter_acl` vacío).
- Ninguna FK apunta a `audit_logs` (no hay CASCADE posible); sus FKs salientes son `NO ACTION`.
- 0017 no reescribe historia: filas legacy (p. ej. `user_agent` de antes de S1-04) quedan intactas (upgrade test).
- Purge por retención (24 meses) = proceso privilegiado futuro, fuera de Sprint 1.

## 5. Atomicidad

- Éxito: la fila se inserta en la **misma transacción** que la escritura de negocio, después de ella y antes del
  COMMIT (tenant routes: la transacción única del request; onboarding/aceptación: su transacción propia; worker: la
  transacción de `apply`/handler junto con el `processed` del outbox).
- Si falla la escritura de negocio (sentencia o COMMIT) ⇒ no queda fila de éxito (ni JIT).
- Si falla el INSERT de auditoría ⇒ se revierte el negocio (500): no existe cambio de negocio sin su fila. En el worker
  el job no queda `processed` y se reintenta; el reintento registra exactamente una fila.
- Denegados durables (`INVITATION_ROLE_NOT_ALLOWED`, `ROLE_ASSIGNMENT_NOT_ALLOWED`, `SELF_ROLE_MODIFICATION_FORBIDDEN`,
  `DOMAIN_ACTION_FORBIDDEN`, `INVITATION_EMAIL_MISMATCH`, expiración materializada): la transacción confirma solo la
  fila `denied`/`system` (y el JIT de la aceptación); si esa fila no puede escribirse la respuesta es 500, **nunca** un
  4xx sin su fila.
- `created_at` = `now()` = **inicio** de la transacción, fijado por PostgreSQL (runtime no puede escribirlo). **No** es
  orden de commit: una transacción iniciada antes puede confirmar después con `created_at` menor. El orden de una
  historia se reconstruye por contenido (`before_json` → `after_json`) o por el estado de la entidad, nunca por
  `created_at` entre transacciones concurrentes.

## 6. Política de denegados

Se persisten (outcome `denied`, commit durable) los denegados **de dominio de alto riesgo** (Operación §5.1):

| Caso | action / reason_code |
| --- | --- |
| Escalada de rol (asignar/revocar un rol sin su permiso de asignación) | `role.assigned`/`role.revoked` · `role_assignment_not_permitted` |
| Autogestión de roles | `role.*` · `self_role_modification` |
| Autoridad insuficiente sobre el objetivo (suspender/revocar owner/admin siendo admin) | `membership.suspended`/`revoked` · `membership_management_not_permitted` |
| Autogestión de membership | `membership.*` · `self_membership_modification` |
| Invitar / revocar invitación de un rol no asignable | `membership.invited` / `membership.invitation_revoked` · `role_assignment_not_permitted` |
| Aceptar con email distinto | `membership.invitation_accepted` · `invitation_email_mismatch` |
| Revocación que dejaría el taller sin owner activo (S1-03) | `membership.revoked` · `last_owner_invariant` (provider) |
| Conflicto de webhook (mismo `svix-id`, otro hash) | `identity.webhook_event_conflict` |

No se persisten (application logs/metrics, "ruido de validación común"): 401; 400/415; `PERMISSION_DENIED` del guard
de ruta (p. ej. advisor/technician en rutas de staff) y la relectura fresca de permisos tras los locks; selección
cross-tenant (403, ver §3); ids inexistentes/de otro tenant (404); transiciones inválidas y duplicados (409);
`LAST_OWNER_REQUIRED` (invariante, no autorización); tokens de invitación inválidos/usados/revocados. Cada intento
denegado durable es una fila (sin deduplicar), acotado por el rate limit de la ruta. Ver DECISION_REQUIRED D1.

Por qué casos parecidos se tratan distinto (sin inconsistencia):

- **Último owner.** `LAST_OWNER_REQUIRED` (API, 409) no se audita: vía API es inalcanzable por construcción (solo un
  owner tiene `roles.assign_owner` y nadie se modifica a sí mismo); el trigger `m_last_active_owner`/`mr_last_active_owner`
  es solo un backstop (Arquitectura §13.2/§13.3) y el request no cambia nada. `last_owner_invariant` (worker S1-03) **sí**
  se audita: es el resultado real de un evento del proveedor (la identidad se borró pero la membership se **conserva**
  deliberadamente), una decisión de estado que sin la fila no dejaría rastro.
- **Invitaciones.** El token inválido (404) no se resuelve a tenant ni a entidad, así que no hay tenant donde escribir y
  el runtime no puede escribir filas sin tenant. El token usado, revocado o vencido es un replay sin efecto (la
  expiración se materializa como fila `system`). El email distinto **sí** se audita: es una credencial **válida y viva**
  usada por otra identidad verificada, es decir, un posible mal uso.
- **Permisos.** La falta de `memberships.manage_staff`/`invite_staff`, sea en el guard de ruta o en la relectura fresca,
  es de la clase "sin acceso a la función" y no se persiste en ningún módulo. La falta del permiso de **asignación** de
  un rol (escalada) o de autoridad sobre el objetivo se persiste en todos los módulos (S1-04, S1-05 y S1-06).

## 7. Atribución system / worker / provider

- Worker: `actor_type` `system` (efectos propios: correo) o `provider` (efectos de Clerk: lifecycle, revocación);
  nunca `user`, nunca ids de actor, nunca `ip_address` (0017: sin grant) ni `user_agent`.
- Correlación: `request_id` del webhook = id del request que lo recibió (conflicto); filas de worker S1-03 = id del
  job de outbox (`outbox_events.id`, uuid); filas de correo S1-04 = `outbox:<outbox_events.id>`; además
  `metadata.outbox_event_id` (correo) o `metadata.webhook_event_id` (revocación). **Convención propuesta** para jobs
  nuevos: `outbox:<id>` (S107-04; no se reescriben filas existentes ni se cambia S1-03 sin decisión).
- `trace_id`: columna disponible (grant a api/worker) pero sin trazas distribuidas todavía (NULL). Pendiente de la
  fase de observabilidad (gate transversal "request/trace correlacionables").

## 8. Metadata permitida / prohibida

Permitido (allowlist por evento, §1): ids internos (UUID), códigos de rol/permiso/estado/comando, nombres de
campos cambiados, proveedor y id de mensaje del proveedor, número de intento, estado del lease, `expires_at`,
`timezone`/`currency`, IP del socket (columna `ip_address`, solo API).

**Política de IP (implementada, no ampliar sin decisión):** `ip_address` = `request.ip` de Fastify **sin
`trustProxy`**, es decir la dirección del peer TCP; no se interpreta `X-Forwarded-For` ni otro header del cliente. Detrás
de un proxy o balanceador sería la IP del proxy. Se guarda solo en filas de la API: onboarding, invitaciones (incluida la
aceptación, sus denegados y la expiración materializada), roles y memberships. **No** se guarda en filas del worker ni
en las de funciones bootstrap (`identity.user_provisioned_jit`, `identity.*`).

Prohibido (recursivo en `before_json`/`after_json`/`metadata_json`, y en `request_id`/`reason_code`):
JWT/session tokens, `Authorization`, cookies, token de invitación en claro, `token_hash`, nonce, cualquier digest
SHA-256 de credencial, secretos/API keys/firmas Svix, headers libres del cliente (`User-Agent`, `Referer`, …),
payloads completos (webhook, request, correo renderizado), email, nombre, teléfono y cualquier PII no necesaria;
valores de campos de perfil (solo sus nombres). La columna `user_agent` no la escribe ningún runtime (0017).
Verificado por `scanAudits` (tests/audit) sobre todas las filas producidas por la suite.

## 9. Privilegios `audit_logs` (tras 0017)

| Rol | SELECT | INSERT | UPDATE/DELETE/TRUNCATE | Notas |
| --- | --- | --- | --- | --- |
| `tallermecario_api` | tabla (RLS) | columnas: todas salvo `user_agent`, `created_at` | no | guard de actor 0017 |
| `tallermecario_worker` | tabla (RLS) | columnas: las de api salvo `ip_address` | no | guard: solo system/provider |
| `tallermecario_bootstrap_resolver` | no | columnas `id, tenant_id, actor_type, actor_user_id, action, outcome, entity_type, entity_id, metadata_json, request_id` (0005, sin cambio) | no | solo vía sus funciones allowlisted |
| `tallermecario_identity_sync` | no | no | no | llama a `app.bootstrap_append_identity_audit` (EXECUTE) |
| `PUBLIC` | no | no | no | tampoco EXECUTE de las funciones escritoras |
| `tallermecario_schema_owner` | owner | owner | owner | migraciones; sin uso runtime |

Funciones que escriben `audit_logs`: `app.bootstrap_provision_user` (EXECUTE: api) y
`app.bootstrap_append_identity_audit` (EXECUTE: identity_sync). `app.enforce_audit_log_actor()`: `SECURITY INVOKER`,
owner `tallermecario_schema_owner`, `search_path = pg_catalog`, sin EXECUTE para nadie.

---

## A. Operación §5.1 / §5.2 (añadir)

En §5.1 "Reglas", tras la viñeta S1-04:

- **(S1-07, 0017)** runtime escribe `audit_logs` solo por columnas: sin `user_agent` (nunca un header libre) ni
  `created_at` (reloj de PostgreSQL = inicio de la transacción; no es orden de commit). El worker tampoco escribe
  `ip_address`.
- **(S1-07, 0017)** actor ligado al contexto en PostgreSQL: API `user` = `app.user_id`/`app.membership_id`,
  `request_id` = `app.request_id`; API `system` y worker `system`/`provider` sin ids de actor; `provider`/`platform`
  nunca desde la API; `platform` nunca desde runtime.
- Toda fila de éxito se confirma en la misma transacción que su escritura de negocio; si no puede escribirse, el
  negocio se revierte. Los denegados durables confirman solo su fila.

En §5.2, sustituir la tabla "Invitaciones internas (S1-04)" por el **catálogo §1** de este documento (incluye
S1-01, S1-03, S1-05, S1-06) y añadir la política de denegados §6.

## B. ADR-009

§10 "Reducciones aplicadas…", nueva viñeta:

- **S1-07 (0017) `audit_logs`:** REVOKE `INSERT` de tabla a `tallermecario_api` y `tallermecario_worker`; `GRANT INSERT`
  por columnas (api: todas salvo `user_agent`, `created_at`; worker: además sin `ip_address`). `SELECT`, RLS
  ENABLE/FORCE, policies `tenant_select`/`tenant_insert` y triggers append-only 0002 sin cambio. Trigger
  `audit_logs_actor_guard_trg` (`BEFORE INSERT`, función `app.enforce_audit_log_actor()` SECURITY INVOKER, owner
  schema_owner, `search_path = pg_catalog`, sin EXECUTE para nadie) liga el actor al TenantContext para sesiones que
  son o heredan un runtime (no superusuario): ver Operación §5.1. `42501`, constraint `audit_logs_actor_guard`. Las
  funciones SECURITY DEFINER bootstrap no son sesiones runtime para el guard. Sin `SECURITY DEFINER`, `BYPASSRLS` ni
  policies nuevas; no reescribe filas. La migración falla si queda INSERT de tabla, INSERT en columnas no permitidas,
  UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, privilegio de PUBLIC, o INSERT de `user_agent`/`created_at` en el resolver
  o cualquier INSERT de identity_sync.

§11, añadir a la lista de capas: `actor guard -> el actor auditado es el contexto ligado (S1-07)`.

## C. Diccionario 04 §9 `audit_logs` (notas bajo el bloque)

- Runtime: INSERT por columnas (0017). `user_agent`: sin escritura runtime (S1-04/S1-07); la columna se conserva para
  filas legacy y futura metadata derivada estructurada. `created_at`: siempre `DEFAULT now()` (inicio de transacción);
  no escribible por runtime; no ordena commits.
- `actor_user_id`/`actor_membership_id`/`request_id` de filas API = GUCs `app.user_id`/`app.membership_id`/
  `app.request_id` (trigger `audit_logs_actor_guard_trg`, 42501). Worker: `actor_type` `system|provider` sin actor.
- `entity_id` NULL solo en `membership.invited` denegado.

## D. ERD

`## audit_logs`: añadir "Actor e INSERT por columnas garantizados en PostgreSQL (0017): ver ADR-009 §10". En §18
"Append-only protegido por PostgreSQL", marcar `audit_logs` como **implementado** (REVOKE UPDATE/DELETE/TRUNCATE +
trigger defensivo 0002 + guard de actor 0017). El paso documental `0019_audit_and_append_only_security` de §19 quedó
cubierto por 0002 + 0017 (numeración real distinta; la secuencia de §19 es solo documental).

## E. RBAC §20

Tras la lista mínima: "El catálogo completo de Sprint 1 (incluye `workshop.created`, `membership.invitation_*`,
`identity.*`) y la política de denegados viven en Operación §5.2. Los denegados de autorización de dominio listados
allí son los «intentos de escalada de privilegio relevantes» de esta sección."

## F. Security Baseline §19 — DOC_CONFLICT

Conflicto: §19 dice que `identity.user_provisioned_jit` registra "IP/user-agent cuando proceda"; Operación §5.1 (S1-04)
prohíbe persistir el header `User-Agent` (queda NULL). La fila JIT tampoco tiene IP (la función bootstrap no la recibe).
Resolución (Operación es la fuente más específica y posterior; refleja la implementación auditada). En §19, reemplazar
la frase "Para `identity.user_provisioned_jit`, registrar: … IP/user-agent cuando proceda y resultado. **No registrar JWT
ni payload completo de Clerk.**" por:

> Para `identity.user_provisioned_jit`, registrar: user_id interno (actor y entidad), `identity_provider`, `request_id`,
> timestamp (`created_at`) y resultado. Este evento no registra IP ni User-Agent: la función bootstrap no los recibe y,
> desde S1-04, ningún header libre del cliente (`User-Agent`, `Referer`, …) se persiste en `audit_logs`. **No registrar
> JWT ni payload de Clerk.** En los eventos escritos por la API, `ip_address` es la IP del peer de la conexión (sin
> `X-Forwarded-For`); los eventos de worker/proveedor no llevan IP (Operación §5.1).

Estado: **CLOSED** a nivel documental (texto final listo). Falta fusionarlo en el doc canónico. No bloquea S1-07.

## G. Arquitectura §15

Añadir: "Contrato de Sprint 1 cerrado en S1-07: catálogo, semántica de actor/tenant, atomicidad, política de denegados
y privilegios en Operación §5.1–§5.2; garantías en PostgreSQL (append-only 0002, actor/columnas 0017)."

---

## DOC_CONFLICT

1. **Security Baseline §19 ↔ Operación §5.1 (S1-04)** — `user_agent` en el evento JIT. Tarea afectada: S1-07
   (campos de `identity.user_provisioned_jit`). Implementación sigue Operación (NULL). Texto F, final: **CLOSED**
   (resuelto documentalmente; pendiente de fusión al canónico).

## DOC_UPDATE_REQUIRED

Textos A–G (catálogo único, 0017 en ADR-009/Diccionario/ERD, RBAC §20 → catálogo, Security §19).

## DECISION_REQUIRED (no resueltas; implementación actual fail-closed / sin cambio)

- **D1** ¿Deben auditarse los `PERMISSION_DENIED` de guard de ruta en rutas sensibles (`memberships.*`, `roles.*`) y la
  denegación por relectura fresca de permisos (actor degradado durante el request)? Hoy no (§6). RBAC §20 habla de
  "intentos de escalada relevantes" sin definirlos.
- **D2** Eventos de login/sesión (Operación §5.2 "login/JIT/revocaciones relevantes"; Security §19 "login/revocación
  cuando sea relevante"): no existe acción canónica ni se audita el login. Probable scope futuro (volumen alto).
- **D3** Formato único de `request_id` para filas de worker (`outbox:<id>` propuesto) — cambiaría S1-03.
- **D4** `SELECT` de `audit_logs` para `tallermecario_worker`: ningún caso de uso lo necesita (mínimo privilegio);
  se conserva porque el gate Sprint 0 exige `tenant_select` para ambos runtimes. Revocar requiere ajustar ese gate.
- **D5** API de lectura de auditoría (`audit.read` ya sembrado para owner/admin): **no existe** y Sprint 1 no la exige
  (Quality Gates §4) → scope futuro; cuando exista, DTO allowlisted y paginado, sin `ip_address` por defecto.
- **D6** Nombre del evento de reactivación de membership (si se aprueba la reactivación, S1-06): `membership.activated`
  hoy significa **creación**; reutilizarlo cambiaría su semántica.

## Deuda LOW / CI

- **CI (registrar para el cierre de Sprint 1, no corregido aquí; Quality Gates no lo asigna a S1-07):**
  `.github/workflows/ci.yml` no ejecuta `test:identity`, `test:identity:upgrade`, `test:invitations`
  (+`:upgrade`), `test:member-roles` (+`:upgrade`, `:mutations`), `test:member-lifecycle` (+`:upgrade`,
  `:mutations`), `test:authz:db`, `test:tenant-context:db` ni los nuevos `test:audit`, `test:audit:upgrade`,
  `test:audit:mutations`.
- S107-06: alinear `app.reject_runtime_append_only_mutation()` (0002) a `pg_has_role` como 0017.
- Retención/purge privilegiado de auditoría (24 meses) y `trace_id`: fuera de Sprint 1 (gate transversal).
- Logins huérfanos del clúster local `tm_test_mlapi_2ca50082c46d4843` / `tm_test_mlwrk_2ca50082c46d4843` (miembros de
  api/worker) quedaron de una corrida S1-06 interrumpida. No forman parte de ninguna migración y no afectan a los
  tests. Limpieza manual posterior: `DROP ROLE` en el clúster local.

## Audit final de arquitectura (2026-09-25, worktree `.claude/worktrees/s1-07-final-audit` @ `0106bdd`)

Primera pasada de solo lectura, con un probe independiente de la suite contra PostgreSQL real y logins NOBYPASSRLS
(65 comprobaciones; los únicos fallos iniciales se debían a regex del probe con mensajes en español y se
re-verificaron aparte). Segunda pasada: solo este documento.

- ACL 0017: sin INSERT de tabla; columnas exactas para api y worker; resolver sin cambio; identity_sync sin INSERT;
  PUBLIC sin ACL de tabla ni de columna; api/worker no son miembros de ningún rol; `pg_parameter_acl` vacío.
- Spoof de actor por SQL directo: API (`provider`, `platform`, `system`+ids, otro user o membership de A, user de B,
  user inexistente, membership NULL, `request_id` forjado) → todos `42501 audit_logs_actor_guard`. Worker (`user` con o
  sin GUCs de usuario, `provider`+ids, `platform`) → guard. Tenant B desde el contexto A → 42501 (RLS).
- GUC spoofing: aceptado tras `SET LOCAL app.*` (atribuir a otro miembro, escribir en otro tenant), que es el límite
  documentado en §2 (ADR-009 §1/§3/§10.1). Una membership de otro tenant sigue bloqueada por la FK compuesta.
- 0017 con precondición inválida (drift `UPDATE(outcome)` a api, `SELECT` a PUBLIC): rechazado atómicamente (ledger
  en 17, sin función ni trigger, grants intactos). Un drift `INSERT(user_agent)` al worker lo elimina el REVOKE y 0017
  aplica.
- Funciones que escriben `audit_logs`: exactamente 2 directas (resolver, `SECURITY DEFINER`, `search_path` fijo, sin
  PUBLIC) y 2 indirectas (`ingest_verified_clerk_webhook` para api, `identity_sync_apply` para worker; owner
  identity_sync). Solo escriben filas sin tenant con actor fijo; ver §2.
- Mutaciones: las 15 de la rama más 3 del auditor (`grant-table-insert`, `grant-created-at`, `grant-worker-ip`,
  ejecutadas desde una copia fuera del repo) → 18/18 KILLED.

Observaciones nuevas (LOW/INFO; no bloquean y no requieren cambio de código en S1-07):

- **LOW** El guard no restringe la acción de las filas `system` escritas por la API (hoy solo
  `membership.invitation_expired`). Endurecimiento futuro posible: allowlist de acciones `system` para la API.
- **INFO** El guard omite la comprobación (`RETURN NEW`) si `current_user` no apareciera en `pg_roles`; en la práctica
  es imposible. Es fail-open teórico; alinearlo cuando se toque 0002 (S107-06).
- **INFO (pre-S1, fuera de alcance)** `app.append_wompi_webhook_attempt` (0004) es `SECURITY DEFINER` con owner
  `tallermecario_schema_owner` y EXECUTE para el worker. Su SQL es estático y solo toca `webhook_processing_attempts`,
  así que no salta 0017. ADR-009 §8 pide un owner dedicado; queda registrado para Wompi y Sprint 0.
- **INFO** `ip_address` detrás de un proxy es la IP del proxy (sin `trustProxy`); ver la política de IP en §8.

## Evidencia (2026-09-24, PostgreSQL local real)

- `test:audit`: 65/65 PASS (6 archivos; limpieza de BD/logins verificada).
- `test:audit:upgrade`: `UPGRADE_0016_TO_HEAD_PASS` (historial byte-idéntico, re-ejecución no-op).
- `test:audit:mutations`: 15/15 KILLED — `drop-lifecycle-success-audit`, `drop-role-success-audit`, `grant-update`,
  `grant-delete`, `append-only-removed`, `actor-from-request`, `db-actor-guard`, `tenant-from-request`,
  `db-tenant-policy`, `store-token-hash`, `store-authorization`, `persist-user-agent`, `grant-user-agent`,
  `audit-before-commit`, `worker-user-actor`. S1-06 `actor-from-request` re-ejecutado con 0017: KILLED.
- Regresión (ejecutada en serie; una primera corrida en paralelo falló solo al migrar BDs concurrentemente):
  typecheck, build, member-lifecycle 48/48 (+upgrade), member-roles 51/51 (+upgrade 0010–0013), identity 89/89
  (+upgrade), invitations 56/56 (+upgrade), onboarding 53/53, authz 26/26, authz:db 4/4, tenant-context core 70/70,
  db 27/27, api 51/51, api:security 12/12, api:multitenant 4/4, db:sprint0 59/59, migration-lock, wompi 20/20,
  outbox worker 19/19, secret scan PASS, `npm audit --omit=dev` 0 vulnerabilidades.
- Audit final (2026-09-25, @ `0106bdd`, en serie): la misma regresión en verde (`test:audit` 65/65 con 0 skipped y
  0 todo; `invitations:upgrade` PASS; `identity:upgrade` PASS) y 18/18 mutantes muertos.
