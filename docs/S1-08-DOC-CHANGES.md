# S1-08 — aislamiento cross-tenant final (propuesta documental)

Preparado el 2026-09-25 en `task/s1-08-cross-tenant-final`, base `task/s1-07-audit` (`d873463`). **Fusionado por secciones en los siete documentos canónicos relevantes dentro de esta rama**, preservando S1-03…S1-07. Los archivos fuente canónicos del checkout principal se leyeron para crear la copia versionada de esta rama; no se editaron allí.

## Resultado y alcance

La suite S1-08 usa dos tenants y UUID reales de ambos sobre PostgreSQL local migrado desde cero. Cubre las rutas Sprint 1 de onboarding, identidad, invitaciones, memberships y roles; las tablas tenant-scoped de esos flujos, `audit_logs` y outbox; funciones ejecutables por runtime; locks y reutilización de conexión. La selección de tenant de un request requiere JWT verificado y membership activa en PostgreSQL. Los roles y permisos de Clerk en claims/metadata no conceden permisos de negocio. Una identidad sin membership recibe 403; no se crea membership implícita.

El camino soportado es request autenticado → JWT de Clerk verificado → selección de membership/`TenantContext` → `SET LOCAL app.*` en la transacción → RLS `ENABLE + FORCE` para roles runtime `NOBYPASSRLS`. Los GUC `app.tenant_id`, `app.user_id`, `app.membership_id` y `app.request_id` son **contexto establecido por la aplicación, no prueba criptográfica de identidad**. El modelo presupone credenciales PostgreSQL runtime no comprometidas. Una sesión runtime comprometida capaz de ejecutar SQL y establecer GUC arbitrarios queda fuera de este boundary; RLS no impide que esa sesión se presente como otro tenant. Este límite no se clasifica como bypass S1-08.

## Texto propuesto para docs canónicos

| Destino | Sección | Adición por sección |
| --- | --- | --- |
| Arquitectura Técnica v1 | TenantContext y §15 auditoría | Incorporar el camino soportado y frontera GUC de arriba; indicar que IDs de otro tenant se resuelven bajo RLS y las operaciones de dominio no escriben ni auditan una entidad invisible. Remitir a Operación §5.1–5.2 para el contrato de auditoría S1-07. |
| ADR-009 | RLS/privilegios y funciones runtime | Registrar la matriz S1-08: API/worker `NOBYPASSRLS`, no owners, `ENABLE + FORCE`, GUC transaction-local; funciones `SECURITY DEFINER` con EXECUTE explícito y alcance estrecho. Aclarar el límite de credenciales runtime indicado arriba. La API no puede invocar una función que acepte tenant UUID arbitrario para tomar locks de owner. |
| Operación v1 | §5.1–5.2 y worker/outbox | Añadir la verificación de coherencia entre claim y fila durable antes del handler o de marcar `processed`: deben coincidir `outboxEventId` y `tenantId`. Un mismatch falla sin efecto sobre el recurso ni avance del job ajeno; recovery con tenant correcto completa una vez. Conservar la atomicidad business + success audit y el catálogo S1-07. |
| Security Baseline | §19 | Aclarar que JWT/claims de Clerk no son autoridad de tenant, membership ni RBAC; PostgreSQL es la autoridad. Documentar liberación de los GUC al COMMIT/ROLLBACK, incluso error, retorno temprano y request denegado. Conservar JIT sin IP ni User-Agent, y la política de IP API del peer TCP. |
| RBAC | Sección de autoridad de permisos | La selección exige membership activa; suspensión y revocación toman efecto desde PostgreSQL. Claims `org_role`, `org_permissions` y metadata forjados no alteran los permisos. |
| ERD / Diccionario | Relaciones y tablas Sprint 1 | Conservar FKs compuestas y RLS de `workshops`, `memberships`, `membership_roles`, `membership_invitations`, `identity_sync_states` donde aplica, `audit_logs` y outbox relacionado; no hay cambio estructural S1-08. |

### Semántica API y enumeración

- Una consulta de A con UUID existente de B para membership o sus roles responde `404 MEMBERSHIP_NOT_FOUND`, igual que con UUID inexistente. Revocar una invitación B desde A responde 404 con el mismo código y mensaje que una invitación inexistente. Los listados de A no incluyen identificadores de B.
- Asignar/quitar rol y suspender/revocar membership B desde A no cambian B y responden 404. Seleccionar B con JWT de A sin membership activa en B responde 403. No hay endpoint de lectura de `audit_logs` en Sprint 1; `audit.read` sigue sin API.
- Aceptar una invitación es una excepción deliberada al selector de tenant: se resuelve por **hash exacto del token** y email verificado. El header de tenant y los claims no seleccionan la invitación. Un usuario de A con email distinto obtiene `INVITATION_EMAIL_MISMATCH`; la invitación B permanece pendiente y el único denied se registra en el tenant de la invitación resuelta, sin metadata de A. El token es una capacidad bearer; esta fila no constituye contaminación cross-tenant.
- Las denegaciones de selección cross-tenant no crean auditoría en B. Los denegados de dominio conservan la política S1-07. **En los flujos soportados de aplicación**, un ID B invisible no aparece como `entity_id` ni en metadata de una operación de A. `audit_logs` no valida universalmente que `entity_id` pertenezca a `tenant_id` frente a SQL raw de una sesión runtime comprometida; ese caso queda fuera del threat model.

### Garantías DB, funciones y locks

- `tallermecario_api` y `tallermecario_worker` son `NOBYPASSRLS`, no owners; las tablas tenant-scoped de Sprint 1 tienen RLS `ENABLE + FORCE`. Con contexto A, SELECT de filas B da cero; UPDATE/DELETE da cero o se deniega por grants; INSERT con `tenant_id` B se rechaza. FKs compuestas impiden enlazar membership, `assigned_by` y relaciones de invitación de otro tenant donde aplican. `audit_logs` conserva append-only y el guard de actor S1-07.
- El inventario de EXECUTE cubre API, worker, `identity_sync`, resolver y PUBLIC. El resolver bootstrap devuelve solo id/tenant por hash exacto de token; no admite enumeración por UUID. Las funciones de identidad/auditoría tienen sus contratos globales estrechos; los helpers Wompi/outbox son fronteras de integración y no dan a la API una escritura tenant-scoped arbitraria.
- La función owner-lock usa el tenant del contexto; no acepta un UUID libre. El runtime A no puede tomar row lock de un workshop B por la ruta soportada. Operaciones concurrentes de rol, estado de membership, invitación y auditoría de A no bloquean los comandos de B; el `owner_mutation_gate` global toma `ACCESS SHARE` en runtime.
- **INFO / límite:** las advisory keys deterministas pueden tomarse mediante SQL raw con una credencial runtime PostgreSQL comprometida. La garantía de aislamiento de locks cubre los comandos y funciones soportados, no esa sesión maliciosa; no se añade `lock_timeout` en S1-08.
- `SET LOCAL` y la transacción del request eliminan `tenant_id`, `user_id`, `membership_id`, `request_id` y permisos/contexto relacionados antes de reutilizar la conexión. Se comprobó COMMIT, ROLLBACK, error, retorno temprano y denegación con la misma conexión del pool.

### Worker/outbox: hallazgo y fix S1-08

**S108-01, MEDIUM, cerrado:** `processClaimedJob` aceptaba un `ClaimedJob` cuyo `tenantId` no coincidía con la fila outbox reclamada. Un claim B alterado a A podía ejecutar el handler con contexto A (sin modificar B por RLS) y después marcar el job B como `processed`, perdiendo trabajo. Ahora se comprueban `outboxEventId` y `tenantId` contra la fila durable antes de handlers normales o por fases, y antes de completar el job. Un mismatch lanza `OUTBOX_CLAIM_TENANT_MISMATCH`; B no cambia ni recibe auditoría. Un job A que nombre un recurso B tampoco modifica B bajo TenantContext A.

Este tenant-binding es una **garantía del flujo worker soportado** (`processClaimedJob` y la entrada directa `processPhasedJob`). `app.bootstrap_claim_outbox_events`, `app.worker_get_outbox_event` y `app.worker_complete_outbox_event` son helpers globales `SECURITY DEFINER` del worker: sus lecturas/transiciones por ID no dependen de `app.tenant_id`. El worker compara el claim con la fila durable **antes** de `prepare` o del handler, y solo entonces procesa con el tenant correcto. Un rechazo deja status, attempts, delivery y auditoría sin cambio; stall/requeue permite reclamar de nuevo con B y procesar una sola vez.

## Evidencia S1-08

- Suite dedicada: `test:cross-tenant:final`, **25/25 PASS**, incluido phased mismatch antes de `prepare`/red y recovery B exactamente una vez, con PostgreSQL real descartable y limpieza de DB/logins.
- Mutaciones: `test:cross-tenant:mutations`, **9/9 KILLED**: desactivar RLS; quitar FORCE; omitir tenant GUC; confiar en tenant del header; quitar FK compuesta `assigned_by`; GUC de sesión tras error; helper de lock con tenant UUID arbitrario; omitir comparación claim/tenant general del worker; omitir **solo** el chequeo de entrada `processPhasedJob`. Las mutaciones solo afectan DB descartable o JS compilado temporal, no el source.
- Regresión ejecutada en serie: typecheck, build, audit S1-07 65/65, member-lifecycle S1-06 48/48, member-roles S1-05 51/51, identity 89/89 + upgrade, invitations 56/56 + upgrade, onboarding 53/53, authz 26/26, authz:db 4/4, tenant-context core 70/70 + db 27/27 + api 51/51, api:security 12/12, api:multitenant 4/4, db:sprint0 59/59, migration-lock, wompi 20/20, outbox worker 19/19, secret scan y `npm audit --omit=dev` (0 vulnerabilidades). No hay migración S1-08; la suite aplica desde cero hasta 0017. No se repitió un upgrade desde 0017 porque el esquema no cambió.
- Cierre enfocado: S1-08 25/25, outbox worker 19/19, audit S1-07 65/65, typecheck y build, más 9/9 mutaciones. No se repitió la regresión completa porque la auditoría final ya la ejecutó.

## DOC_CONFLICT y DECISION_REQUIRED

- **DOC_CONFLICT: ninguno nuevo.** La corrección Security Baseline §19 ↔ Operación §5.1 sobre JIT/IP/User-Agent ya está fusionada en los canónicos de S1-07 y se preserva.
- **DECISION_REQUIRED D1–D6 de S1-07 siguen abiertas:** D1 `PERMISSION_DENIED` del guard de ruta; D2 eventos de login; D3 formato `request_id` worker; D4 SELECT worker en `audit_logs`; D5 API `audit.read`; D6 nombre de evento de reactivación. S1-08 no las resuelve.

## CI pendiente antes del Quality Gate final de Sprint 1

No se editó `.github/workflows/ci.yml`. Agregar al Gate, con las variables PostgreSQL ya usadas por CI:

```text
S1-04: npm run test:invitations:ci; npm run test:invitations:upgrade:ci
S1-05: npm run test:member-roles:ci; npm run test:member-roles:upgrade:ci; npm run test:member-roles:mutations:ci
S1-06: npm run test:member-lifecycle:ci; npm run test:member-lifecycle:upgrade:ci; npm run test:member-lifecycle:mutations:ci
S1-07: npm run test:audit:ci; npm run test:audit:upgrade:ci; npm run test:audit:mutations:ci
S1-08: npm run test:cross-tenant:final:ci; npm run test:cross-tenant:mutations:ci
Identidad: npm run test:identity:ci; npm run test:identity:upgrade:ci
Transversal: npm run test:authz:db:ci; npm run test:tenant-context:db:ci
```

S1-08 queda cerrado técnicamente y su documentación fusionada en esta rama. Esto no declara `PASSED` el Quality Gate final de Sprint 1; la deuda CI permanece abierta.
