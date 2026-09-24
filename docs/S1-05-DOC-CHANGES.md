# S1-05 member role management (+ audit fix) — cambios de documentación preparados (NO canónicos todavía)

Preparado 2026-09-24 en el worktree `task/s1-05-audit-fix` (base `ecd1366`). `docs/` es gitignored.
El docs canónico del checkout principal y Notion **no** se editaron. Copiar **por secciones**
(no reemplazar archivos). Requerido antes de merge: AGENTS.md §1/§3 (cambio estructural → ERD +
Diccionario) y la introducción (contrato consumido por la PWA → documentado antes de merge).

| Destino (bajo `Arquitectura Técnica v1 — TallerMecario/`) | Sección | Texto |
| --- | --- | --- |
| `../Arquitectura Técnica v1 — TallerMecario …md` (raíz) | nuevo §13.2, después de §13.1 | A |
| `ADR-009 — RLS y privilegios …md` | §10 "Reducciones aplicadas…" (nuevas viñetas S1-05) | B |
| `Diccionario de Datos v1 — PostgreSQL/Diccionario 01 …md` | §4 `memberships` y §9 `membership_roles` (añadir tras las notas existentes) | C |
| `Modelo de Datos ERD v1 — PostgreSQL …md` | reglas de integridad ("todo taller conserva al menos un owner activo") | D |

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
- **Transacción única:** `app.lock_tenant_owner_set(tenant)` → actor `FOR SHARE` → objetivo `FOR UPDATE` → permisos frescos → invariantes → INSERT/DELETE en `membership_roles` → audit → COMMIT. Cualquier error → ROLLBACK total (salvo los dos 403 durables, que confirman solo su fila `denied`).
- **No incluido:** comando de reemplazo atómico de rol; `Idempotency-Key`; gestión de estado de memberships (S1-06).

## B. ADR-009 §10 — nuevas viñetas

- **S1-05 (0011) `membership_roles`:** REVOKE `UPDATE` a `tallermecario_api` y `tallermecario_worker`; policy `tenant_update` eliminada (un cambio de rol es DELETE + INSERT, Diccionario 01 §9). `GRANT DELETE` solo a `tallermecario_api`, con policy `tenant_delete FOR DELETE TO tallermecario_api USING (tenant_id = app.current_tenant_id())`. Worker: SELECT/INSERT sin UPDATE/DELETE. Policies resultantes: `tenant_select`, `tenant_insert` (api, worker), `tenant_delete` (api).
- **S1-05 (0011/0012) invariante de owner activo** — "owner activo" = fila `membership_roles` con rol `owner` sobre una membership con `status = 'active'` (el `users.status` **no** interviene):
  - Lock único por tenant: `app.lock_tenant_owner_set(uuid)` = `pg_advisory_xact_lock(hashtextextended('tallermecario.membership_roles.owner_set/' || tenant_id, 0))`. Lo toman: los comandos S1-05, el handler S1-03 `membership-revocation` (antes de sus row locks), los triggers `BEFORE … FOR EACH STATEMENT` de `memberships`/`membership_roles` (tenant de la sesión, antes de cualquier row lock) y el chequeo del invariante. Orden global: lock de tenant → row locks.
  - `app.assert_tenant_keeps_active_owner(uuid, text)`: toma el lock y **después** evalúa `EXISTS (owner activo)` en una sentencia nueva (snapshot READ COMMITTED posterior a la espera); fuera de READ COMMITTED la reducción falla cerrada.
  - Triggers: `membership_roles_invariants_trg` (0011, función redefinida en 0012: INSERT exige membership `active`; DELETE/UPDATE de fila `owner` → assert, constraint `mr_last_active_owner`) y `memberships_owner_invariant_trg` (0012, AFTER UPDATE OR DELETE: una membership `active` con rol owner que sale de `active` o cambia id/tenant → assert, constraint `m_last_active_owner`, SQLSTATE 23514).
  - Todas las funciones: SECURITY INVOKER, owner `tallermecario_schema_owner`, `search_path` fijo (`pg_catalog[, public]`), sin EXECUTE a PUBLIC; EXECUTE de los dos helpers solo para api/worker. Sin `SECURITY DEFINER` ni `BYPASSRLS` nuevos. `memberships`: sin cambio de grants (api conserva UPDATE de tabla porque S1-04/S1-05 usan `FOR UPDATE`/`FOR SHARE`, que lo requieren; worker conserva UPDATE para el handler S1-03; ningún runtime tiene DELETE/TRUNCATE).

## C. Diccionario 01

**§4 `memberships` — añadir:** Invariante (S1-05, 0012): una membership `active` que tiene rol `owner` no puede pasar a `suspended`/`revoked` (ni cambiar id/tenant, ni borrarse) si es la última owner activa del taller → `23514 m_last_active_owner`. No aplica a memberships sin rol owner ni a transiciones desde `suspended`/`revoked`; reactivar (`→ active`) no está restringido por este guard. Las transiciones de estado de memberships siguen sin definirse en Estados y Transiciones v1 (S1-06).

**§9 `membership_roles` — añadir tras "No UPDATE directo de rol…":** Implementado (0011/0012): runtime sin UPDATE; DELETE solo API bajo RLS tenant; `assigned_by_membership_id` = actor del TenantContext (FK compuesta mismo tenant). Trigger `app.enforce_membership_role_invariants`: `mr_membership_not_active` (INSERT sobre membership no `active`) y `mr_last_active_owner` (remoción de la última fila owner activa). "Guard de último owner se evalúa transaccionalmente" = advisory lock por tenant + chequeo post-lock (ver ADR-009 §10).

## D. ERD — regla "todo taller conserva al menos un owner activo"

**Garantizado por PostgreSQL** (0011 + 0012) para toda escritura en `membership_roles` o `memberships` que reduzca el conjunto {membership `active` ∧ rol `owner`}, cualquiera sea la sesión (runtime o privilegiada):

- remoción del rol `owner` (DELETE, o UPDATE por sesión privilegiada);
- `memberships.status` `active → suspended` y `active → revoked` de una owner;
- cambio de `id`/`tenant_id` o DELETE de una membership owner activa (el runtime no tiene DELETE; las FKs de `membership_roles` también lo impiden mientras tenga roles);
- carreras entre cualquiera de las anteriores (serializadas por el lock de tenant; la última en confirmar ve a todas las demás).

**No cubre / límites explícitos:**

- No repara datos existentes: un tenant que ya tuviera 0 owners activos antes de 0012 no se corrige; solo se bloquean nuevas reducciones de owners (cambios de memberships no-owner siguen permitidos).
- `users.status = 'disabled'` no afecta al conteo: una membership `active` de un usuario deshabilitado cuenta como owner activo (semántica S1-03: el caso last-owner de `user.deleted` conserva la membership estructural, auditada `membership.revoked`/`denied`/`last_owner_invariant`; el usuario deshabilitado no obtiene acceso). `users.status = disabled` **no** implica `membership.status = revoked`.
- Una transacción que pasa transitoriamente por 0 owners (quitar el owner antes de añadir el nuevo) se rechaza en la sentencia que reduce: añadir primero. `ownership.transfer` (RBAC §16.7) no existe todavía.
- Sesiones con `session_replication_role = replica` (solo superusuario; fixtures/mantenimiento) no ejecutan triggers.
- Reducciones de owner fuera de READ COMMITTED se rechazan (fail-closed).
- Sesiones sin contexto de tenant (privilegiadas) no pasan por el lock previo de sentencia: toman el lock por fila (posible deadlock detectado por PostgreSQL, nunca violación del invariante).

---

## Interacción con S1-03 (sin cambio de semántica)

- El handler `identity.membership_revocation_requested` sigue: revoca memberships del usuario borrado salvo la última owner activa (`kept_last_owner`, auditada `denied`/`last_owner_invariant`); no toca `users`; no reactiva nada.
- Cambio único: toma `app.lock_tenant_owner_set(app.current_tenant_id())` **antes** de sus row locks, igual que los comandos S1-05 (evita el deadlock por orden inverso y le hace ver, tras la espera, una remoción de rol owner confirmada mientras esperaba). El trigger 0012 es el respaldo en DB.

## DECISION_REQUIRED abiertas (no resueltas)

1. Cambios de roles sobre memberships `suspended`/`revoked` (hoy 409 `MEMBERSHIP_NOT_ACTIVE`; lectura permitida).
2. Admin sobre target owner/admin (hoy denegado, derivado de RBAC §16.5).
3. Membership activa con 0 roles (hoy permitido retirar su último rol).
4. Semántica administrativa futura S1-06 (suspender/revocar/reactivar desde API; el guard 0012 ya aplica a esas escrituras).
5. Reemplazo atómico de rol (no implementado).
6. `Idempotency-Key` en la API (pendiente, igual que S1-04).
