# S1-06 member management — cambios de documentación (NO canónicos todavía)

Preparado 2026-09-24 en el worktree `task/s1-06-member-management` (base `task/s1-05-audit-fix-3` = `4fa2e66`).
Implementación: comandos de ciclo de vida de memberships + migración **0015**. El docs canónico del checkout
principal y Notion **no** se editaron. Copiar **por secciones** (no reemplazar archivos). Requerido antes de merge:
AGENTS.md §1 (contrato consumido por la PWA → documentado antes de merge) y §3 (privilegios de runtime → ADR-009).
Este archivo se versiona con `git add -f` (el resto de `docs/` sigue gitignored).

| Destino (bajo `Arquitectura Técnica v1 — TallerMecario/`) | Sección | Texto | Clase |
| --- | --- | --- | --- |
| `../Arquitectura Técnica v1 — TallerMecario …md` (raíz) | nuevo §13.3 después de §13.2; actualizar "No incluido/Pendiente" de §13.2 | A | DOC_UPDATE_REQUIRED |
| `Estados y Transiciones por Dominio v1 …md` | nueva sección "Memberships" (y añadir `memberships` a "Dominios") | B | DOC_UPDATE_REQUIRED + DECISION_REQUIRED (aprobación) |
| `ADR-009 — RLS y privilegios …md` | §10 "Reducciones aplicadas…" (viñeta 0015) + §10.1 (usuarios del lock) | C | DOC_UPDATE_REQUIRED |
| `Diccionario de Datos v1 — PostgreSQL/Diccionario 01 …md` | §4 `memberships` | D | DOC_UPDATE_REQUIRED |
| `RBAC — Matriz completa de roles y permisos v1 …md` | §16 (nota de aplicación a estado de membership) | E | DOC_UPDATE_REQUIRED |
| `Modelo de Datos ERD v1 — PostgreSQL …md` | `## memberships` + «Invariante de owner activo» | F | DOC_UPDATE_REQUIRED |

Sin cambio estructural de tablas/columnas/constraints (0015 solo cambia GRANTs). Sin nuevo ADR (no cambia una
decisión arquitectónica: aplica ADR-009 §10 "UPDATE solo donde se requiere").

**DOC_CONFLICT:** ninguno bloqueante encontrado. (Observación menor, no conflicto: el bloque `## memberships` del ERD no
enumera `suspended_at`/`revoked_at`; el Diccionario, que gobierna columnas según AGENTS.md §3, sí → se completa en F.)

---

## A. Arquitectura §13.3 — Gestión de memberships (S1-06) — contrato backend ↔ PWA

```
GET  /api/v1/memberships                              tenant route: memberships.read
GET  /api/v1/memberships/:membershipId                tenant route: memberships.read
POST /api/v1/memberships/:membershipId/suspend        tenant route: memberships.manage_staff (+ autoridad sobre el objetivo en el servicio)
POST /api/v1/memberships/:membershipId/revoke         tenant route: memberships.manage_staff (+ autoridad sobre el objetivo en el servicio)
     body: ausente o exactamente {} (application/json)
```

- **Respuesta:** `{ "membership": MembershipDto }` (GET uno, suspend, revoke → 200) y `{ "memberships": MembershipDto[] }` (lista),
  `cache-control: no-store`. `MembershipDto = { membershipId, status, joinedAt, suspendedAt|null, revokedAt|null, roles: [{ role, assignedAt }] }`.
  Sin email, nombre ni `user_id`: el runtime no tiene acceso a `users` (ADR-009 §6.3). La lista incluye memberships
  `active`/`suspended`/`revoked` del tenant, orden `joined_at, id`, tope 200 (sin paginación, igual que §13.1).
- **Transiciones** (ver Estados y Transiciones › Memberships): `suspend` `active → suspended`; `revoke` `active → revoked` y
  `suspended → revoked` (conserva `suspended_at`). No existe comando de reactivación ni escritura genérica de `status`.
  Las memberships nunca se borran; los roles se conservan (historial); `users.status` nunca se toca.
- **Autorización** (RBAC §2/§4/§16.4/§16.5; solo permission codes): `memberships.manage_staff` **y** el permiso de
  asignación de **cada** rol que tiene el objetivo (`owner → roles.assign_owner`, `admin → roles.assign_admin`,
  `service_advisor|technician → roles.assign_staff`; misma regla que §13.2). Efecto: admin solo gestiona staff (y
  memberships sin roles); nunca owner/admin. Permisos del actor **releídos de PostgreSQL después de los locks**.
  Lectura: `memberships.read` (owner, admin).
- **Autogestión:** prohibida (fail-closed, DECISION_REQUIRED): `403 DOMAIN_ACTION_FORBIDDEN`, auditado `denied`
  `self_membership_modification`, commit durable.
- **Nunca desde el cliente:** tenant (TenantContext), actor (TenantContext), estado destino (lo fija el comando),
  roles/permisos, claims de Clerk. Cualquier campo en el body → 400; body no JSON → 415.
- **Errores estables** `{ error: { code, message, request_id } }`: `MEMBERSHIP_NOT_FOUND` 404 (id inexistente,
  malformado o de otro tenant: mismo cuerpo) · `DOMAIN_INVALID_STATE_TRANSITION` 409 (Estados §9) ·
  `LAST_OWNER_REQUIRED` 409 (trigger `m_last_active_owner`; inalcanzable vía API por construcción, backstop) ·
  `DOMAIN_ACTION_FORBIDDEN` 403 (Estados §9; autoridad insuficiente sobre el objetivo o autogestión; auditado `denied`,
  commit durable) · `PERMISSION_DENIED` 403 · `REQUEST_VALIDATION_FAILED` 400 · `REQUEST_BODY_MALFORMED` 400 ·
  `UNSUPPORTED_MEDIA_TYPE` 415. El cuerpo 409 no incluye `current_state`/`requested_action` (opcional en Estados §9).
- **Auditoría** (RBAC §20): `membership.suspended` / `membership.revoked`; `entity_type = membership`, `entity_id` =
  objetivo, `actor_type = user`, `actor_user_id`/`actor_membership_id` = actor, `before_json`/`after_json = {status}`,
  `metadata_json = {command, roles}`, `reason_code = member_status_management`; denegados: `outcome = denied`,
  `reason_code = membership_management_not_permitted` (+ `missing_permissions`) o `self_membership_modification`.
  `user_agent` NULL, sin email/token/JWT.
- **Transacción única** (misma jerarquía que §13.2 y el handler S1-03, ADR-009 §10.1): `app.lock_current_tenant_owner_set()`
  → actor `FOR SHARE` (permisos frescos) → objetivo `FOR UPDATE` (estado releído) → `manage_staff` → autoridad →
  transición → `UPDATE memberships` (solo columnas de ciclo de vida; el trigger 0012–0014 valida el owner activo) →
  audit → COMMIT. Cualquier error → ROLLBACK (salvo el 403 durable, que confirma solo su fila `denied`).
- **Efecto en sesiones:** el siguiente request del miembro suspendido/revocado recibe 403 (TenantContext revalida la
  membership activa en cada request; sin caché).
- **No incluido:** reactivación; autogestión ("salir del taller"); `Idempotency-Key`; motivo libre (`reason`);
  datos de usuario (nombre/email) en la lista; paginación por cursor.

Actualizar §13.2 "Pendiente": el punto (4) queda **parcialmente resuelto** por §13.3 (suspender/revocar); reactivación y
autogestión siguen pendientes.

## B. Estados y Transiciones — nueva sección "Memberships" (propuesta; requiere aprobación)

> Hoy el documento no define memberships (Diccionario 01 §4: "siguen sin definirse… (S1-06)"). S1-06 implementa el
> subconjunto derivable de RBAC §20 (`membership.suspended`, `membership.revoked`), ERD «Invariante de owner activo»
> (`active → suspended`, `active → revoked`) y el precedente S1-03 (el handler ya revoca memberships `suspended`).
> Todo lo demás queda fail-closed.

Estados: `active`, `suspended`, `revoked` (CHECK `memberships_status_check` + `memberships_status_coherence_check`).

| Comando | Origen | Destino | Guards | Efectos |
| --- | --- | --- | --- | --- |
| `suspendMembership` (API) | `active` | `suspended` | `memberships.manage_staff` + autoridad sobre roles del objetivo; no self; owner activo (DB) | `suspended_at = now()`; audit `membership.suspended` |
| `revokeMembership` (API) | `active`, `suspended` | `revoked` | ídem | `revoked_at = now()` (conserva `suspended_at`); audit `membership.revoked` |
| `revokeMembershipForDeletedIdentity` (worker S1-03) | `active`, `suspended` | `revoked` | salvo última owner activa (`kept_last_owner`) | audit `membership.revoked` (actor `provider`) |
| creación (onboarding S1-01 / invitación S1-04) | — | `active` | — | audit `membership.activated` |

- `revoked` es terminal (§1). `suspended → active` **no definido** (DECISION_REQUIRED).
- Transición inválida → `409 DOMAIN_INVALID_STATE_TRANSITION`, sin efectos.
- Concurrencia: serializada por el lock de owner-set del tenant + `FOR UPDATE` del objetivo; dos comandos
  incompatibles desde el mismo estado nunca aplican ambos.
- `users.status = disabled` no implica cambio de `memberships.status` y viceversa.

## C. ADR-009

**§10 "Reducciones aplicadas…", nueva viñeta:**

- **S1-06 (0015) `memberships`:** REVOKE `UPDATE` de tabla a `tallermecario_api` y `tallermecario_worker`;
  `GRANT UPDATE (status, suspended_at, revoked_at, updated_at)` a ambos. `id`, `tenant_id`, `user_id`, `joined_at`,
  `created_at` quedan inmutables para runtime (42501). `SELECT … FOR UPDATE/NO KEY UPDATE/SHARE` siguen funcionando
  (requieren UPDATE en al menos una columna). Policies (`tenant_select`, `tenant_insert`, `tenant_update`), RLS
  ENABLE/FORCE, SELECT/INSERT y triggers 0012–0014 sin cambio; sin funciones, `SECURITY DEFINER` ni `BYPASSRLS` nuevos.
  La migración falla si queda UPDATE de tabla, UPDATE en columnas no permitidas, DELETE/TRUNCATE/REFERENCES/TRIGGER
  o cualquier privilegio de PUBLIC. *Seguimiento:* el worker solo necesita `(status, revoked_at, updated_at)`
  (handler S1-03); conserva `suspended_at` porque las suites DB de S1-05 lo usan como escritor genérico de estado —
  estrecharlo requiere ajustar esos fixtures.
- Sustituye la frase de la viñeta S1-05 (0012/0013) "API conserva UPDATE de tabla (…; ningún endpoint escribe
  `status`)" por: "UPDATE solo de columnas de ciclo de vida desde 0015; los comandos S1-06 escriben `status`".

**§10.1:** en "Tenant-scoped", añadir los comandos S1-06 (`suspend`/`revoke`) a los usuarios de
`app.lock_current_tenant_owner_set()` (antes de cualquier row lock). En "Interacción con S1-03": el handler revoca
también memberships suspendidas vía API; `kept_last_owner` considera solo owners `active` (una co-owner suspendida
vía API no cuenta).

## D. Diccionario 01 §4 `memberships`

Sustituir la última frase del párrafo "Invariante (S1-05…)" ("Las transiciones de estado de memberships siguen sin
definirse…") por:

> Transiciones (S1-06, Estados y Transiciones › Memberships): `active → suspended` (`suspended_at`),
> `active|suspended → revoked` (`revoked_at`, conserva `suspended_at`), solo mediante los comandos
> `suspend`/`revoke` del API (§13.3) y el handler S1-03; sin reactivación, sin borrado. Mutabilidad runtime (0015):
> solo `status`, `suspended_at`, `revoked_at`, `updated_at`; `id`, `tenant_id`, `user_id`, `joined_at`, `created_at`
> inmutables para `tallermecario_api`/`tallermecario_worker`. La máquina de estados se aplica en la aplicación; la DB
> aplica coherencia (CHECK) y el invariante de owner activo, pero no bloquea una reactivación escrita por runtime
> (DECISION_REQUIRED).

## E. RBAC §16 — nota nueva (tras la regla 8)

> Las reglas 4–5 aplican también a comandos de estado de membership (S1-06): suspender/revocar una membership exige
> `memberships.manage_staff` y el permiso de asignación de cada rol que la membership tiene; admin solo gestiona
> memberships de staff (o sin roles). La regla 6 se extiende a estado: nadie suspende/revoca su propia membership por
> endpoints genéricos (salir del taller: flujo dedicado pendiente). Los intentos denegados se auditan (`denied`).

## F. ERD

- `## memberships`: listar `suspended_at timestamptz nullable`, `revoked_at timestamptz nullable` (ya en Diccionario/0000).
- «Invariante de owner activo»: añadir "Escritores de estado: comandos S1-06 `suspend`/`revoke` (API) y handler S1-03
  (worker), ambos tras `app.lock_current_tenant_owner_set()`". Dependencias de migración: `… → 0014 → 0015` (grants
  de columnas de `memberships`; sin cambio estructural).

---

## DECISION_REQUIRED (no resueltas; implementación fail-closed)

1. **Reactivación** `suspended → active` (y si `revoked` es reactivable, o si se re-ingresa solo por nueva invitación —
   enlaza con el pendiente S1-04 "reactivar vía invitación"). Hoy: sin ruta (404), revoked terminal. Si se aprueba:
   nombre de evento propio (`membership.activated` ya se usa para creación en onboarding/invitación), guard de
   `users.status`, y si la DB debe bloquear reactivaciones de runtime (hoy no lo hace, ver D).
2. **Autogestión / "salir del taller"**: hoy 403 `DOMAIN_ACTION_FORBIDDEN` para suspender/revocar la propia membership,
   incluso con co-owner. ¿Existe un comando dedicado `leave`? ¿Reautenticación reciente (como `ownership.transfer`)?
3. **Datos de usuario en la lista** (nombre/email): requiere función allowlisted nueva (runtime no lee `users`) +
   ADR-009 §7 + contrato de minimización PII.
4. **Motivo (`reason`) en suspend/revoke**: no definido; hoy no se acepta body.
5. **`Idempotency-Key`** en comandos (igual que S1-04/S1-05 pendiente). Reintento hoy → 409 determinista.
6. **Efectos colaterales al suspender/revocar**: invitaciones pendientes creadas por esa membership, asignaciones de
   órdenes (Sprint 2+), tokens emitidos. Hoy: ninguno.
7. **Paginación** de `GET /memberships` (tope 200).
8. **Worker: `UPDATE(suspended_at)`** — estrechar a `(status, revoked_at, updated_at)` ajustando fixtures S1-05.
9. Heredado S1-05 (4) "semántica administrativa S1-06": **resuelto** para suspender/revocar (derivado de RBAC §4/§16/§20
   + ERD); reactivación → punto 1.

## Interacción con S1-03 (sin cambio de semántica)

Handler `identity.membership_revocation_requested` sin modificar: `revoked` (incluye memberships suspendidas vía API),
`already_revoked` (revocadas vía API, sin segunda auditoría), `kept_last_owner` (co-owner suspendida vía API no cuenta),
`not_found` para tenant inexistente (contrato 0014, verificado con los grants 0015). `users.status` nunca cambia por
comandos de membership y viceversa. Carreras API ↔ handler probadas en ambos órdenes sin 40P01.
