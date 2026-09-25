# S1-05 member role management — cambios de documentación tras audit fixes 1–3 (0011–0014, NO canónicos todavía)

Preparado 2026-09-24 en el worktree `task/s1-05-audit-fix-3` (base `0e7a7b8`). Estado final de la
implementación: migraciones **0011 + 0012 + 0013 + 0014**. El docs canónico del checkout principal y Notion
**no** se editaron. Copiar **por secciones** (no reemplazar archivos). Requerido antes de merge:
AGENTS.md §1/§3 (cambio estructural → ERD + Diccionario) y la introducción (contrato consumido por la
PWA → documentado antes de merge). Este archivo está versionado con `git add -f` (el resto de `docs/`
sigue gitignored).

| Destino (bajo `Arquitectura Técnica v1 — TallerMecario/`) | Sección | Texto |
| --- | --- | --- |
| `../Arquitectura Técnica v1 — TallerMecario …md` (raíz) | nuevo §13.2, después de §13.1 | A |
| `ADR-009 — RLS y privilegios …md` | §10 "Reducciones aplicadas…" (nuevas viñetas S1-05) y nueva subsección "Lock de owner-set" | B |
| `Diccionario de Datos v1 — PostgreSQL/Diccionario 01 …md` | §4 `memberships`, §9 `membership_roles`, nota de objeto `app.owner_mutation_gate` | C |
| `Modelo de Datos ERD v1 — PostgreSQL …md` | reglas de integridad ("todo taller conserva al menos un owner activo") | D |

## Estado (cierre documental, 2026-09-24)

- **Fusionado al docs canónico** (`TallerMecarioB/docs`, gitignored) por secciones desde esta rama (`5553279`): Arquitectura nuevo §13.2 (A + DECISION_REQUIRED S1-05); ADR-009 §6.1 (nota `membership_roles`), §10 viñetas S1-05 y nuevo §10.1 (B + interacción S1-03 + datos legacy); Diccionario 01 §4 y §9 + nota `app.owner_mutation_gate` (C); ERD regla de owner activo + nueva subsección «Invariante de owner activo» con dependencias 0011→0014 (D).
- Verificado: solo 2 líneas originales sustituidas (ampliadas, no borradas), 0 `.rej`/conflictos; contenido S1-03 (`identity_sync_states`, Clerk lifecycle) y S1-04 (`membership_invitation_deliveries`, lease) intacto; ninguna afirmación de `user disabled ⇒ membership revoked`; la única mención de los helpers UUID de 0012 es su eliminación en 0013. Notion no fue editado.

---

## A. Arquitectura §13.2 — Roles de memberships (S1-05) — contrato backend ↔ PWA

```
GET    /api/v1/memberships/:membershipId/roles             tenant route: memberships.read
POST   /api/v1/memberships/:membershipId/roles             tenant route: memberships.manage_staff (+ roles.assign_* en el servicio)
       body {"role_code": "owner" | "admin" | "service_advisor" | "technician"}   (additionalProperties: false)
DELETE /api/v1/memberships/:membershipId/roles/:roleCode   tenant route: memberships.manage_staff (+ roles.assign_* en el servicio)
```

- **Respuesta:** `{ "membership": { "membershipId", "status", "roles": [{ "role", "assignedAt" }] } }`, `cache-control: no-store`. POST → 201, DELETE → 200, GET → 200 (también para memberships `suspended`/`revoked`).
- **Autorización** (RBAC §4/§16/§18; solo permission codes, nunca nombres de rol): cambiar el rol R de la membership T exige `memberships.manage_staff`, el permiso de asignación de R **y** el de cada rol que T ya tiene (`owner → roles.assign_owner`, `admin → roles.assign_admin`, `service_advisor|technician → roles.assign_staff`). Efecto: admin gestiona solo staff y no puede tocar una membership que tenga owner/admin. Los permisos del actor se **releen de PostgreSQL después de los locks** (no del snapshot del inicio del request): un actor degradado mientras su request espera queda denegado. Nadie modifica sus propios roles (RBAC §16.6) → 403.
- **Nunca desde el cliente:** tenant (sale del TenantContext), `assigned_by_membership_id` (= membership del actor), listas de permisos, claims de Clerk (`org_role`, `org_permissions`, metadata). Campos extra en el body → 400.
- **Errores estables** `{ error: { code, message, request_id } }`:
  `MEMBERSHIP_NOT_FOUND` 404 (id inexistente, malformado o de otro tenant) ·
  `MEMBERSHIP_NOT_ACTIVE` 409 ·
  `ROLE_ALREADY_ASSIGNED` 409 ·
  `ROLE_NOT_ASSIGNED` 404 ·
  `LAST_OWNER_REQUIRED` 409 ·
  `ROLE_ASSIGNMENT_NOT_ALLOWED` 403 (auditado `denied`, commit durable) ·
  `SELF_ROLE_MODIFICATION_FORBIDDEN` 403 (auditado `denied`, commit durable) ·
  `PERMISSION_DENIED` 403 · `REQUEST_VALIDATION_FAILED` 400 · `UNSUPPORTED_MEDIA_TYPE` 415.
- **Auditoría** (RBAC §20): `role.assigned` / `role.revoked`; `entity_type = membership_role`, `entity_id` = membership objetivo, `actor_user_id`/`actor_membership_id` = actor, `before_json`/`after_json = {roles:[…]}`, `metadata_json = {role}`; denegados con `reason_code = role_assignment_not_permitted` (+ `missing_permissions`) o `self_role_modification`. Sin email, token, JWT ni User-Agent (NULL).
- **Transacción única:** `app.lock_current_tenant_owner_set()` (puerta compartida + fila `workshops` del tenant del TenantContext, ver ADR-009) → actor `FOR SHARE` → objetivo `FOR UPDATE` → permisos frescos → invariantes → INSERT/DELETE en `membership_roles` → audit → COMMIT. Cualquier error → ROLLBACK total (salvo los dos 403 durables, que confirman solo su fila `denied`).
- **No incluido:** comando de reemplazo atómico de rol; `Idempotency-Key`; gestión de estado de memberships (S1-06).

## B. ADR-009 §10 — nuevas viñetas + subsección "Lock de owner-set"

**Grants (estado final):**

- **0011 `membership_roles`:** REVOKE `UPDATE` a `tallermecario_api` y `tallermecario_worker`; policy `tenant_update` eliminada (un cambio de rol es DELETE + INSERT, Diccionario 01 §9). `GRANT DELETE` solo a `tallermecario_api`, policy `tenant_delete FOR DELETE TO tallermecario_api USING (tenant_id = app.current_tenant_id())`. Worker: SELECT/INSERT, sin UPDATE/DELETE. Policies: `tenant_select`, `tenant_insert` (api, worker), `tenant_delete` (api).
- **0012/0013 `memberships`:** sin cambio de grants. API conserva UPDATE de tabla (S1-04/S1-05 toman `FOR UPDATE`/`FOR SHARE`, que lo requieren; ningún endpoint escribe `status`); worker conserva UPDATE (handler S1-03). Ningún runtime tiene DELETE/TRUNCATE.
- **0013 `workshops`:** sin cambio: api/worker ya tenían UPDATE + policy `tenant_update` (0000), que es lo que permite `FOR NO KEY UPDATE` de **su propio** workshop bajo RLS.
- **0013 `app.owner_mutation_gate`:** tabla sin columnas ni filas (solo objeto de lock), owner `tallermecario_schema_owner`, RLS ENABLE/FORCE, `SELECT` a api/worker, nada a PUBLIC.
- **0014:** `CREATE OR REPLACE` de `app.lock_current_tenant_owner_set()` únicamente (quita el `RAISE 55000` cuando el workshop no es visible); sin cambios de grants, owner, `SECURITY INVOKER` ni `search_path`.
- **0013 funciones:** `app.lock_current_tenant_owner_set()` — sin argumentos, EXECUTE solo api/worker. `app.enforce_owner_set_lock_order()`, `app.enforce_membership_owner_invariant()`, `app.enforce_membership_role_invariants()` — funciones de trigger, sin EXECUTE a nadie (no invocables directamente). Todas SECURITY INVOKER, owner `tallermecario_schema_owner`, `search_path = pg_catalog, public`, sin EXECUTE a PUBLIC. **Eliminadas** (0013): `app.lock_tenant_owner_set(uuid)`, `app.assert_tenant_keeps_active_owner(uuid, text)` y la función de trigger 0012 `app.lock_current_tenant_owner_set()` (el nombre se reutiliza para la interfaz runtime). Sin `SECURITY DEFINER` ni `BYPASSRLS` nuevos.

**Lock de owner-set (0013) — jerarquía única:**

```
app.owner_mutation_gate  ─►  fila public.workshops del tenant (FOR NO KEY UPDATE)  ─►  filas memberships / membership_roles
```

- **Tenant-scoped (runtime con TenantContext):** puerta en `ACCESS SHARE` → fila `workshops` de `app.current_tenant_id()` (bajo RLS: solo su propio tenant es visible/lockeable) → filas. Interfaz: `app.lock_current_tenant_owner_set()`; la usan los comandos S1-05 y el handler S1-03, y el trigger `BEFORE … FOR EACH STATEMENT` de `memberships`/`membership_roles` para cualquier UPDATE/DELETE del runtime. Contrato de la función (0014): sin tenant context → `55000` (fail-closed); tenant context malformado → `22P02`; workshop visible → puerta `ACCESS SHARE` + fila `workshops` `FOR NO KEY UPDATE`; **workshop inexistente / no visible → puerta `ACCESS SHARE`, sin lock de fila y sin error** (no-op). **Un TenantContext válido cuyo workshop ya no existe/no es visible no convierte una operación de 0 filas en error de locking; se preserva el not_found del dominio** (p. ej. el handler S1-03 devuelve `not_found` como antes de 0013). Es seguro porque bajo RLS tampoco es visible ninguna fila de ese tenant (FK → `workshops`, mismo predicado), y no crea oráculo: un runtime solo ve su tenant ligado, así que "no visible" equivale a "no existe". El trigger de sentencia aplica la misma regla (desde 0013).
- **Privilegiado / sin scope (superuser o `BYPASSRLS`):** el trigger de sentencia toma la puerta en `ACCESS EXCLUSIVE` **antes de tocar filas**; espera a todo holder tenant-scoped y luego toma la fila `workshops` de cada tenant afectado en los triggers de fila, cuando ninguna transacción tenant-scoped puede tener una. Esto elimina el ciclo 0012 (privilegiado: fila → lock de tenant; runtime: lock de tenant → fila) que producía `40P01`.
- **Un runtime no puede apuntar a otro tenant:** no hay función runtime que acepte un tenant id; la fila `workshops` de otro tenant es invisible bajo RLS (el `FOR NO KEY UPDATE` devuelve 0 filas); con solo `SELECT` sobre la puerta, el único modo que un runtime puede tomar es `ACCESS SHARE` (los demás modos de `LOCK TABLE` exigen UPDATE/DELETE/TRUNCATE → 42501), que solo retrasa escrituras privilegiadas, nunca a otro tenant.
- **Snapshot:** cada comprobación del invariante es una sentencia nueva ejecutada después de adquirir los locks → en READ COMMITTED ve todo lo confirmado mientras esperaba. Fuera de READ COMMITTED una reducción de owners falla cerrada.
- **Boundary administrativo (no cubierto):** superusuarios/roles administrativos de PostgreSQL pueden tomar cualquier lock (incluida la puerta exclusiva o la fila de cualquier workshop) y desactivar triggers (`session_replication_role = replica`); eso es boundary de administración, no de tenant. Una sesión runtime que fija `app.tenant_id` a otro tenant obtiene acceso a los datos de ese tenant igual que antes (los GUC son contexto, no prueba criptográfica — ADR-009 §3); el lock no añade superficie sobre eso. Los advisory locks built-in (`pg_advisory_xact_lock`, PUBLIC) siguen disponibles para cualquier sesión, pero el owner-set ya no los usa.
- **Orden no soportado:** una transacción que primero bloquea la fila `workshops` por otra vía (p. ej. un UPDATE del perfil del taller) y después reduce owners puede interbloquearse con una escritura privilegiada; ninguna ruta actual lo hace.

## C. Diccionario 01

**§4 `memberships` — añadir:** Invariante (S1-05, 0012/0013): una membership `active` que tiene rol `owner` no puede pasar a `suspended`/`revoked` (ni cambiar id/tenant, ni borrarse) si es la última owner activa del taller → `23514 m_last_active_owner`. No aplica a memberships sin rol owner ni a transiciones desde `suspended`/`revoked`; reactivar (`→ active`) no está restringido por este guard. Toda UPDATE/DELETE sobre `memberships` pasa por el lock de owner-set (ADR-009 §10). Las transiciones de estado de memberships siguen sin definirse en Estados y Transiciones v1 (S1-06).

**§9 `membership_roles` — añadir tras "No UPDATE directo de rol…":** Implementado (0011–0014): runtime sin UPDATE; DELETE solo API bajo RLS tenant; `assigned_by_membership_id` = actor del TenantContext (FK compuesta mismo tenant). Trigger `app.enforce_membership_role_invariants`: `mr_membership_not_active` (INSERT sobre membership no `active`) y `mr_last_active_owner` (remoción de la última fila owner activa). "Guard de último owner se evalúa transaccionalmente" = lock de owner-set (puerta + fila `workshops`) + chequeo posterior al lock.

**Objeto de infraestructura (no de dominio):** `app.owner_mutation_gate` — tabla sin columnas ni filas usada solo como lock global del owner-set (ADR-009 §10). No contiene datos, no es tenant-owned, no aparece en `schema.ts`.

## D. ERD — regla "todo taller conserva al menos un owner activo"

**Garantizado por PostgreSQL** (0011–0014) para toda escritura en `membership_roles` o `memberships` que reduzca el conjunto {membership `active` ∧ rol `owner`}, sea de runtime o de una sesión privilegiada con triggers activos:

- remoción del rol `owner` (DELETE, o UPDATE por sesión privilegiada);
- `memberships.status` `active → suspended` y `active → revoked` de una owner;
- cambio de `id`/`tenant_id` o DELETE de una membership owner activa (el runtime no tiene DELETE; las FKs de `membership_roles` también lo impiden mientras tenga roles);
- carreras entre cualquiera de las anteriores, incluidas escrituras privilegiadas sin TenantContext (jerarquía única de locks; la última en confirmar ve a todas las demás; sin `40P01` entre runtime y privilegiado).

**No cubre / límites explícitos:**

- No repara datos existentes: un tenant que ya tuviera 0 owners activos antes de 0012 no se corrige; solo se bloquean nuevas reducciones de owners (los cambios de memberships no-owner siguen permitidos).
- `users.status = 'disabled'` no afecta al conteo: una membership `active` de un usuario deshabilitado cuenta como owner activo. `users.status = disabled` **no** implica `membership.status = revoked` (semántica S1-03).
- Una transacción que pasa transitoriamente por 0 owners (quitar el owner antes de añadir el nuevo) se rechaza en la sentencia que reduce: añadir primero. `ownership.transfer` (RBAC §16.7) no existe todavía.
- Sesiones con `session_replication_role = replica` (solo superusuario; fixtures/mantenimiento) no ejecutan triggers.
- Reducciones de owner fuera de READ COMMITTED se rechazan (fail-closed).

---

## Interacción con S1-03 (sin cambio de semántica)

- El handler `identity.membership_revocation_requested` sigue: revoca memberships del usuario borrado salvo la última owner activa (`kept_last_owner`, auditada `membership.revoked`/`denied`/`last_owner_invariant`); no toca `users`; no reactiva nada.
- Único cambio: llama `app.lock_current_tenant_owner_set()` (tenant = el del job, ya ligado como TenantContext por el worker) **antes** de sus row locks, igual que los comandos S1-05; tras la espera lee el estado confirmado. El trigger de `memberships` es el respaldo en DB.
- Job cuyo tenant ya no existe (UUID válido sin workshop): el lock es un no-op (0014) y el handler termina en `not_found`, sin modificar memberships ni roles, sin auditoría ni outbox, y sin bloquear a tenants reales — igual que antes de 0013.

## DECISION_REQUIRED abiertas (no resueltas)

1. Cambios de roles sobre memberships `suspended`/`revoked` (hoy 409 `MEMBERSHIP_NOT_ACTIVE`; lectura permitida).
2. Admin sobre target owner/admin (hoy denegado, derivado de RBAC §16.5).
3. Membership activa con 0 roles (hoy permitido retirar su último rol).
4. Semántica administrativa futura S1-06 (suspender/revocar/reactivar desde API; el guard ya aplica a esas escrituras).
5. Reemplazo atómico de rol (no implementado).
6. `Idempotency-Key` en la API (pendiente, igual que S1-04).
