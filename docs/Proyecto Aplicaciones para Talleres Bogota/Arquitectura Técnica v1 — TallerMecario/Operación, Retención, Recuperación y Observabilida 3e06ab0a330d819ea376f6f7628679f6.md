# Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario

<aside>
⚙️

**Objetivo:** cerrar el baseline operativo de TallerMecario para retención de media, recuperación/backup, conciliación de pagos del cliente, auditoría/cumplimiento y observabilidad. Los plazos de producto aquí definidos no se presentan como plazos legales obligatorios; una norma, contrato, garantía, disputa o legal hold puede exigir conservar por más tiempo.

</aside>

**Estado:** Baseline documental v1 — Sprint 0  

**Ámbito:** MVP/piloto → release comercial  

**Implementación:** diferida hasta levantar el Documentation Freeze.

# 1. Principios transversales

- PostgreSQL es source of truth para metadata, estados y evidencia; R2 conserva binarios.
- Retención ≠ backup. Retención define cuánto tiempo debe existir un dato; backup define capacidad de recuperación tras incidente.
- Append-only ≠ retención infinita. Un histórico no se modifica durante su vida útil, pero puede ser purgado al vencer su política mediante un proceso de retención privilegiado y auditable.
- La API/worker normal no borra históricos ni objetos R2 arbitrariamente.
- Toda eliminación sensible es two-phase: dejar de servir/acceder primero, purgar físicamente después de las validaciones/hold correspondientes.
- Legal hold/disputa/incidente activo siempre prevalece sobre el TTL automático.
- Los datos personales se conservan solo durante un periodo razonable y necesario para la finalidad y obligaciones aplicables; los defaults de ILVOX deben poder documentarse y revisarse.

# 2. Retención de media / Cloudflare R2

## 2.1 Campos adicionales de `media_assets`

Además de la metadata existente, baseline:

```
retention_class
retention_until timestamptz nullable
retention_policy_version
legal_hold_until timestamptz nullable
deletion_requested_at timestamptz nullable
deleted_at timestamptz nullable
purged_at timestamptz nullable
delete_reason varchar nullable
```

`deleted_at` significa inaccesible para producto; `purged_at` confirma que el objeto ya fue eliminado físicamente de R2.

## 2.2 Clases y defaults

| Clase/caso | Baseline | Inicio del reloj |
| --- | --- | --- |
| `pending_upload` / upload incompleto | 24 horas | creación/expiración de upload session |
| Objeto activo sin vínculo de dominio | 30 días | `uploaded_at` |
| `quarantined` sin incidente/hold | 7 días | quarantine |
| Fotos / video / video360 operacionales | 12 meses | orden `delivered` o `cancelled` |
| Media ligada a garantía | el mayor entre 12 meses post-orden y `warranty_expires_at + 90 días` | según regla |
| Firma, PDF de cotización, evidencia de autorización/entrega | 36 meses de producto | autorización/entrega/estado terminal correspondiente |

Los 12/36 meses son **defaults de producto**, no una afirmación de obligación legal colombiana. Antes de producción, la política contractual/legal puede ampliar o reducir cuando proceda.

## 2.3 Reglas de cálculo

- `retention_until` se determina server-side al asociar/cerrar el recurso.
- Si un asset tiene múltiples vínculos, aplica la fecha de retención **más larga**.
- `legal_hold_until`, disputa, incidente o DSR en investigación suspende el purge automático.
- Cambiar un plan nunca acorta retroactivamente una evidencia ya comprometida por garantía/hold.
- Para órdenes no terminales, no se inicia todavía el TTL operativo.

## 2.4 Eliminación two-phase

```
eligible_for_delete
   ↓
deletion_requested_at
   ↓
bloquear nuevas signed URLs / status deleted
   ↓
grace operacional máximo 7 días
   ↓
validar que no exista hold/vínculo nuevo
   ↓
DELETE R2
   ↓
purged_at + audit event
```

Para una solicitud de supresión procedente, el acceso se bloquea inmediatamente y el purge primario se intenta sin esperar al fin del grace normal; objetivo operacional: **≤7 días** en storage primario, salvo impedimento legal/contractual/hold.

## 2.5 Uso de lifecycle de R2

- Lifecycle rules de R2 pueden usarse para prefijos puramente efímeros (`tmp/`, multipart/incomplete).
- La retención de evidencia de negocio **no** depende únicamente de reglas de edad del bucket porque requiere orden, garantía, vínculo y legal hold.
- Las credenciales de API normales no reciben permiso de borrado masivo de R2; el purge lo ejecuta un worker/credencial dedicada de retención.
- No se habilita bucket-wide retention lock como baseline, porque dificultaría supresiones legítimas; puede evaluarse para prefijos de evidencia regulada en el futuro.

# 3. Backups, RPO/RTO y recuperación

## 3.1 Objetivos MVP/piloto

| Componente | RPO objetivo | RTO objetivo |
| --- | --- | --- |
| PostgreSQL producción | ≤ 15 min | ≤ 4 h |
| Configuración crítica/infra-as-code | ≤ 24 h / cada cambio versionado | ≤ 4 h |
| Media R2 | objeto confirmado debe existir en R2 antes de marcar `active`; metadata DB queda sujeta al RPO PostgreSQL | ≤ 4 h para restaurar acceso/configuración; no se promete reconstrucción de un objeto físicamente purgado |

## 3.2 PostgreSQL

Baseline:

- continuous WAL/PITR habilitado en producción;
- ventana PITR mínima: **14 días**;
- backup/base snapshot automático diario;
- backups cifrados y con credenciales distintas a runtime;
- API/worker no tienen privilegios para alterar/borrar backups;
- alerta crítica si no existe backup exitoso en las últimas 26 horas o si el archivado WAL queda rezagado más allá del RPO;
- toda migración destructiva/riesgosa exige checkpoint/backup verificado y plan de rollback/forward-fix.

## 3.3 Restore drills

- restore completo a ambiente aislado **antes del piloto**;
- después: **mensual** y adicional tras cambio de proveedor/estrategia de backup;
- no se considera PASS solo porque el proveedor muestre “backup successful”.

Validación mínima tras restore:

```
DB inicia
migración/schema version esperada
último timestamp dentro del RPO
conteos/sampling de entidades críticas
FKs y RLS presentes
append-only protections presentes
login/tenant smoke
orden/cotización/payment smoke
outbox/webhook no se redespacha accidentalmente
```

Cada ejercicio registra `started_at`, `recovery_point`, `restored_at`, RPO observado, RTO observado, defectos y resultado PASS/FAIL en evidencia del Gate/runbook.

## 3.4 Restauración y efectos externos

Restaurar DB a un punto anterior **no autoriza a repetir efectos externos**. Después de restore:

- Wompi se reconcilia antes de volver a cobrar/activar;
- outbox ya enviado se valida con idempotency/provider refs;
- WhatsApp no reenvía automáticamente mensajes históricos;
- customer payments registrados después del recovery point se reconcilian contra evidencia operacional antes de reingreso manual.

## 3.5 Media R2

R2 es el storage primario de media, no un “backup secundario”. Baseline económico:

- no duplicar toda la media en otro proveedor durante piloto;
- checksum/size/object key permiten detectar inconsistencias;
- API runtime no dispone de borrado masivo;
- eliminación se hace por proceso dedicado/two-phase;
- job periódico identifica `media_assets.active` cuyo objeto R2 no existe y objetos huérfanos sin metadata;
- cualquier estrategia futura de réplica cross-provider se decide con costo/volumen reales.

# 4. Customer payments — conciliación operativa

<aside>
💰

`customer_payments` es dinero cliente final → taller. No es Wompi SaaS y, en MVP, la mayoría de métodos pueden ser registrados manualmente. La conciliación baseline asegura consistencia del ledger ILVOX; no certifica que un banco/Nequi/Daviplata haya liquidado fondos salvo que exista integración futura con ese proveedor.

</aside>

## 4.1 Campos y semántica

Extender baseline de `customer_payments` con:

```
idempotency_key uuid nullable
recorded_by_membership_id
confirmed_at nullable
confirmed_by_membership_id nullable
reversed_by_membership_id nullable
reversal_reason text nullable
correction_of_payment_id nullable
```

Reglas:

- `amount > 0`;
- MVP Colombia: `currency = COP`;
- `receipt_number`, cuando exista, único por tenant;
- `idempotency_key`, cuando exista, único por tenant;
- status: `pending | confirmed | reversed`;
- un `confirmed` ya no permite editar monto, moneda, método, referencia ni `paid_at`; correcciones usan reversal + nuevo payment;
- `reversed` exige `reversed_at`, actor y razón;
- payment reverse mantiene la fila histórica; nunca DELETE.

## 4.2 Allocations

- `allocated_amount > 0`;
- FK compuesta payment/order mismo tenant;
- solo pagos `confirmed` pueden aportar saldo efectivo;
- suma de allocations de un payment no puede superar `amount`;
- allocation es inmutable en MVP; si se asignó incorrectamente, se revierte el payment y se crea un registro corregido (`correction_of_payment_id`); una capacidad de reallocation parcial se difiere.
- saldo no asignado está permitido.

Derivados:

```
payment_allocated = SUM(allocations)
payment_unallocated = payment.amount - payment_allocated

order_paid = SUM(allocations de payments confirmed)
order_outstanding = order_billable_total - order_paid
```

Un payment `reversed` aporta **0** al saldo efectivo aunque sus allocations históricas sigan existiendo.

## 4.3 Reconciliation run

Entidad propuesta `customer_payment_reconciliation_runs`:

```
id
tenant_id
period_start
period_end
status: ok | issues
confirmed_total
allocated_total
unallocated_total
reversed_total
discrepancy_count
details_json (sin PII innecesaria)
started_at
finished_at
created_at
```

Job diario por tenant y ejecución manual owner/admin:

- recomputa saldos desde ledger;
- detecta over-allocation, montos negativos/imposibles, payment confirmado sin timestamps/actor, reversal inconsistente, currency inválida, receipt duplicado donde corresponda;
- compara `deliveries.outstanding_balance/payment_status` snapshot contra ledger derivado y alerta drift;
- **no corrige silenciosamente** datos; crea issue/resultado y exige comando de corrección autorizado.

# 5. Auditoría y cumplimiento

## 5.1 `audit_logs` baseline

Campos mínimos:

```
id
tenant_id nullable
actor_type: user | system | provider | platform
actor_user_id nullable
actor_membership_id nullable
action
outcome: success | denied | failed
entity_type
entity_id nullable
reason_code nullable
before_json nullable
after_json nullable
metadata_json nullable
request_id
trace_id nullable
ip_address nullable
user_agent nullable
created_at
```

Reglas:

- append-only para runtime: INSERT/SELECT según permiso, sin UPDATE/DELETE/TRUNCATE;
- `before_json/after_json` contienen únicamente campos relevantes; no snapshot ciego de entidades con PII;
- secretos, hashes de token, OTP, JWT, PAN/CVV, Authorization headers y cuerpos de media nunca entran al audit log;
- **(S1-04)** ningún header libre controlado por el cliente (`User-Agent`, `Referer`, …) se persiste: puede contener cualquier credencial (p. ej. un token de invitación vigente) y ni truncado ni redacción por patrón prueban su ausencia. `user_agent` queda NULL; si surge una necesidad operativa, solo metadata derivada, estructurada y no reversible (p. ej. familia de cliente de un conjunto cerrado), nunca el header original;
- **(S1-07, 0017)** API y worker tienen `INSERT` por columnas, nunca `INSERT` general de tabla. Ninguno puede escribir `user_agent` ni `created_at`; el worker tampoco `ip_address`. `user_agent` siempre es NULL para filas nuevas; las filas legacy no se reescriben. `created_at` usa `DEFAULT now()` de PostgreSQL (inicio de transacción), **no representa orden de commit**;
- **(S1-07, 0017)** el trigger `audit_logs_actor_guard_trg` liga en sesiones runtime el actor y `request_id` de la API a `app.user_id`, `app.membership_id` y `app.request_id`; la API solo inserta `user` o `system` y el worker solo `system` o `provider`. `system`/`provider` no llevan ids de actor; `platform` queda reservado y ningún runtime lo inserta. El guard no restringe la acción de filas `system` de API (hoy solo `membership.invitation_expired`), deuda LOW;
- `tenant_id` de filas tenant proviene del TenantContext (en aceptación, de la invitación resuelta por hash; en worker, del job reclamado), nunca del request. RLS `ENABLE + FORCE` y policies `tenant_select`/`tenant_insert` permiten solo el tenant ligado; sin contexto no hay lectura ni INSERT. Filas globales de `identity.*` se escriben por funciones `SECURITY DEFINER` allowlisted y son invisibles para runtime;
- **(S1-08)** en los flujos soportados de aplicación, un ID B invisible no aparece como `entity_id` ni en metadata de una operación de A, y una selección cross-tenant denegada no crea fila en B. `audit_logs` no verifica universalmente que todo `entity_id` pertenezca a `tenant_id` frente a SQL raw de una sesión runtime comprometida; esta frontera está fuera del threat model de ADR-009;
- **Frontera de confianza:** `app.tenant_id`, `app.user_id` y `app.membership_id` son contexto establecido por la aplicación a partir de identidad/membership validadas, **no prueba criptográfica de identidad**. El modelo presupone que las credenciales runtime PostgreSQL no están comprometidas. Una sesión runtime comprometida con SQL arbitrario puede establecer GUC distintos y actuar bajo otro contexto; RLS y el guard no protegen frente a esa sesión. La FK compuesta impide asociar una membership de otro tenant al tenant ligado, pero el guard no verifica por sí mismo la relación `app.membership_id` ↔ `app.user_id`;
- todo éxito de auditoría se confirma en la misma transacción que el cambio de negocio (incluido el `processed` del outbox en worker). Si falla el negocio, no queda éxito; si falla el INSERT de auditoría, se revierte el negocio. Los denegados durables confirman solo su fila (y el JIT de aceptación, si se creó); un fallo al auditar devuelve 500;
- `ip_address` en filas API = `request.ip` de Fastify **sin `trustProxy`**, es decir, peer TCP (detrás de proxy, IP del proxy). No se interpreta `X-Forwarded-For`. JIT, bootstrap, worker y eventos de proveedor no guardan IP ni User-Agent;
- runtime tiene SELECT bajo RLS e INSERT por columnas, sin UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. Además de los grants, no hay policy UPDATE/DELETE y existen triggers defensivos append-only de 0002. Ninguna FK apunta a `audit_logs`; sus FKs salientes usan NO ACTION. Purge privilegiado según §5.3;
- `request_id` de filas API es UUIDv7 generado por el servidor, no `X-Request-Id` del cliente. `trace_id` permanece NULL hasta implementar trazas distribuidas. El worker usa hoy dos formatos: S1-03 `outbox_events.id` (UUID) y S1-04 correo `outbox:<outbox_events.id>`; un formato único sigue abierto (D3);
- eventos denied de alto riesgo sí se auditan; ruido de validación común se queda en application logs/metrics;
- cambios hechos por sistema/provider conservan `actor_type` y correlación con webhook/outbox cuando aplique.

## 5.2 Eventos obligatorios

Como mínimo:

- memberships/invitaciones/roles/ownership;
- login/JIT/revocaciones relevantes;
- cambios de configuración/feature flags/integraciones;
- creación/revocación/consumo de tokens públicos y OTP (sin valores crudos);
- quote authorization manual/pública;
- payment confirm/reverse y reconciliación con issues;
- mutaciones de inventario: `inventory.initial_stock_recorded`, `inventory.receipt_recorded`, `inventory.adjustment_in_recorded`, `inventory.adjustment_out_recorded`, `inventory.transfer_recorded`, `inventory.consumption_recorded`, `inventory.return_recorded`;
- `inventory.adjustment_out_recorded` exige razón y correlación con actor, producto, ubicación, cantidad, balance before/after, movement id y request_id; transfer correlaciona ambos movimientos mediante `transfer_group_id`;
- exportación/anonymización/supresión de datos;
- DSR y privacy/security incidents;
- cambios de legal hold/retention;
- acciones administrativas internas futuras;
- cambios sensibles de billing/subscription.

### Catálogo implementado de Sprint 1 (S1-01…S1-07)

Estas **18 acciones** son el catálogo vigente de Sprint 1; la lista de mínimos anterior conserva eventos previstos para otros sprints. `entity_id` está presente salvo en `membership.invited` denegado, cuando no se creó invitación. `user_agent` siempre es NULL en filas nuevas. Los campos JSON son allowlists, sin snapshots completos.

| action | dominio, tenant y actor | outcome → reason_code | entidad y contenido minimizado |
| --- | --- | --- | --- |
| `identity.user_provisioned_jit` | S1-01/S1-04; global; user provisionado | success → NULL | user / `users.id`; metadata `{identity_provider}`; sin IP |
| `workshop.created` | S1-01; nuevo taller; user | success → `workshop_onboarding` | workshop; after `{status, timezone, currency, primary_location_id}` |
| `membership.activated` | S1-01/S1-04; taller; user | success → `workshop_onboarding` o `membership_invitation` | membership; after `{status, user_id}`; metadata `{invitation_id}` en S1-04 |
| `role.assigned` | S1-01/S1-04/S1-05; taller; user | success → `workshop_onboarding`, `membership_invitation` o `member_role_management`; denied → `role_assignment_not_permitted` (+ `missing_permissions`) o `self_role_modification` | membership_role / membership objetivo; before/after `{roles}`; metadata `{role}` en S1-05, `{assigned_by_membership_id, invitation_id}` en S1-04, `{assigned_by_membership_id, bootstrap}` en S1-01 |
| `role.revoked` | S1-05; taller; user | success → `member_role_management`; denied como `role.assigned` | membership_role / membership objetivo; before/after `{roles}`; metadata `{role}` |
| `membership.invited` | S1-04; taller; user | success → `membership_invitation`; denied → `role_assignment_not_permitted` | membership_invitation; after `{status, target_role, expires_at}`; denied `entity_id=NULL`, metadata `{target_role, required_permission}` |
| `membership.invitation_revoked` | S1-04; taller; user | success → `membership_invitation`; denied → `role_assignment_not_permitted` | membership_invitation; success before/after `{status}`, metadata `{target_role}`; denied metadata `{target_role, required_permission}` |
| `membership.invitation_accepted` | S1-04; taller de invitación; user (sin membership si denied) | success → `membership_invitation`; denied → `invitation_email_mismatch` | membership_invitation; success before `{status: pending}`, after `{status, accepted_membership_id}`; denied sin before/after/metadata |
| `membership.invitation_expired` | S1-04; taller; system | success → `membership_invitation` | membership_invitation; before/after `{status}`; metadata `{materialized_by, target_role}` |
| `membership.invitation_email_sent` | S1-04 worker; taller; system | success → `membership_invitation` | membership_invitation; metadata `{provider, provider_message_id, outbox_event_id, attempt, lease_state[, invitation_status_at_record]}`; el proveedor aceptó la entrega |
| `membership.invitation_email_skipped` | S1-04 worker; taller; system | success → `membership_invitation` | membership_invitation; metadata `{reason, outbox_event_id, attempt[, prior_attempt_unconfirmed]}` |
| `membership.suspended` | S1-06; taller; user | success → `member_status_management`; denied → `membership_management_not_permitted` (+ `missing_permissions`) o `self_membership_modification` | membership; before/after `{status}`; metadata `{command, roles}` |
| `membership.revoked` | S1-06 user o S1-03 worker provider; taller | S1-06 como `membership.suspended`; S1-03 success → `identity_provider_user_deleted`, denied → `last_owner_invariant` | membership; before/after `{status}` (en `last_owner_invariant`, iguales); S1-03 metadata `{reason, user_id, webhook_event_id}` |
| `identity.user_provisioned_webhook` | S1-03 worker; global; provider | success → NULL | user; metadata `{identity_provider, provider_event_type, status}` |
| `identity.user_profile_synced` | S1-03 worker; global; provider | success → NULL | user; metadata `{identity_provider, provider_event_type, changed_fields}` (nombres, nunca valores) |
| `identity.user_disabled` | S1-03 worker; global; provider | success → NULL | user; metadata `{identity_provider, provider_event_type, reason}` |
| `identity.user_deleted` | S1-03 worker; global; provider | success → NULL | user; metadata `{identity_provider, provider_event_type, observation, previous_status, membership_revocations_enqueued}` |
| `identity.webhook_event_conflict` | S1-03 webhook API; global; provider mediante función allowlisted | denied → NULL | webhook_event; metadata `{identity_provider, reason: payload_hash_mismatch}`; una fila por reentrega conflictiva |

Onboarding: JIT si el usuario es nuevo + `workshop.created` + `membership.activated` + `role.assigned`. Aceptación: JIT si es nuevo + `membership.invitation_accepted` + `membership.activated` + `role.assigned`. Creación de invitación: `membership.invited` y, si aplica, `membership.invitation_expired` de la pendiente vencida del mismo email. Cada comando S1-05/S1-06 deja una fila. Reintentos idempotentes sin nuevo efecto dejan **0 filas**.

### Actores y correlación

`user` atribuye el comando al usuario verificado y a la membership del TenantContext; nunca a valores del body, query, header o claims externos. En onboarding, el nuevo owner audita su propio alta (`metadata.bootstrap=true`). En aceptación, el actor es el usuario que acepta y la membership recién creada; si se deniega por email distinto, no hay membership. Si el asignador del rol es otro, se conserva en `metadata.assigned_by_membership_id`. JIT atribuye al usuario provisionado, sin tenant ni membership. `system` representa un efecto automático, incluso la expiración escrita por API; `provider` representa un efecto de Clerk, incluso la revocación de memberships del usuario eliminado. Ambos carecen de ids de actor; la persona afectada va en entidad/metadata. `platform` está reservado.

Las funciones `SECURITY DEFINER` allowlisted de bootstrap/identidad escriben filas globales fuera del guard de sesiones runtime, con actor y entidad limitados por su contrato. Su `request_id` es correlación, no autoridad. El guard de 0017 devuelve `42501` (`audit_logs_actor_guard`) al rechazar actor o request_id de runtime. El worker nunca actúa como `user`. El `request_id` del webhook conflictivo es el request API que lo recibió; el worker S1-03 usa el UUID del job de outbox y S1-04 correo `outbox:<id>`, además de referencias al job/evento en metadata. Unificar el formato está pendiente (D3).

### Política de denegados de Sprint 1

Se persisten con `outcome=denied` los intentos de asignar/revocar roles sin permiso (`role_assignment_not_permitted`), autogestión de roles (`self_role_modification`), autoridad insuficiente sobre una membership objetivo (`membership_management_not_permitted`), autogestión de membership (`self_membership_modification`), invitación/revocación de rol no asignable (`role_assignment_not_permitted`), aceptación con email distinto (`invitation_email_mismatch`), revocación de último owner por lifecycle del proveedor (`last_owner_invariant`) y conflicto de webhook (`identity.webhook_event_conflict`). Cada intento durable confirma una fila, sujeto al rate limit de la ruta.

No se persisten en `audit_logs`: 401; 400/415; `PERMISSION_DENIED` del guard de ruta y de la relectura fresca de permisos; selección cross-tenant (403, sin contaminar el tenant destino); ids inexistentes o de otro tenant (404); transiciones inválidas y duplicados (409); `LAST_OWNER_REQUIRED` de API; tokens de invitación inválidos/usados/revocados. Estos casos quedan en logs/metrics de aplicación. `LAST_OWNER_REQUIRED` de API es un backstop inalcanzable por el flujo autorizado; `last_owner_invariant` de worker registra la decisión de conservar la última membership owner activa tras borrado de identidad. Un token inválido no resuelve tenant; un token válido usado por otro email sí deja denegado. La falta de permiso para entrar a la función no se audita como la escalada de asignar un rol. La decisión sobre `PERMISSION_DENIED` de ruta sigue abierta (D1).

Metadata permitida: ids internos, códigos de rol/permiso/estado/comando, nombres de campos cambiados, proveedor/id de mensaje, intento/lease, expiración, timezone/currency e IP solo en columna `ip_address` de API. Prohibidos en JSON, `request_id` y `reason_code`: JWT/sesiones, Authorization, cookies, tokens/hashes/nonces, secretos/firmas, headers libres (`User-Agent`, `Referer`), payloads completos, email, nombre, teléfono y valores de perfil. No hay logs de login/sesión implementados en este catálogo (D2).

### Decisiones abiertas y deuda de cierre Sprint 1

- **D1** Auditar `PERMISSION_DENIED` del guard de ruta y de la relectura fresca de permisos: abierto; hoy no se persiste.
- **D2** Eventos de login/sesión: abiertos; aún no existe acción canónica ni audit de login.
- **D3** Formato único de `request_id` de worker: abierto; S1-03 UUID y S1-04 `outbox:<id>` permanecen.
- **D4** `SELECT audit_logs` de `tallermecario_worker`: abierto; hoy se conserva por el gate Sprint 0, aunque ningún caso actual lo requiere.
- **D5** API `audit.read`: abierto; permiso sembrado para owner/admin, sin endpoint Sprint 1. Un futuro DTO debe ser allowlisted y paginado, sin `ip_address` por defecto.
- **D6** Nombre del evento de reactivación de membership: abierto si se aprueba reactivación; `membership.activated` hoy denota creación.

**Deuda CI:** `.github/workflows/ci.yml` no ejecuta actualmente las suites S1-04, S1-05, S1-06, S1-07, identity, `authz:db` ni `tenant-context:db` (incluidas sus variantes upgrade/mutations aplicables). Debe resolverse antes del Quality Gate final del Sprint 1; CI no se cambia en S1-07.

**Actualización S1-08 de la deuda CI:** `test:cross-tenant:final:ci` y `test:cross-tenant:mutations:ci` también deben incorporarse al Quality Gate final del Sprint 1, junto con los comandos anteriores. No se modifica CI en S1-08. Lista exacta en `docs/S1-08-DOC-CHANGES.md`.

**Actualización del Quality Gate final (2026-09-25):** el workflow de la rama `task/sprint-1-final-quality-gate` incorpora las suites funcionales y upgrades S1-04…S1-08, identidad, `authz:db` y `tenant-context:db`, con ejecución serial de suites que migran PostgreSQL. La deuda CI anterior describe el estado al cerrar S1-08. Las mutaciones S1-05…S1-08 son gate manual/pre-release; S1-04 tiene sondas de mutación con rollback dentro de `test:invitations`, sin runner separado. La ejecución remota del workflow y el resultado oficial del Gate se registran por separado.

**LOW/INFO:** alinear el trigger append-only 0002 a `pg_has_role` como 0017 (hoy `current_user IN (...)` no cubre un login que herede runtime; los grants sí lo cubren). El guard 0017 hace `RETURN NEW` si `current_user` no aparece en `pg_roles`, fallback teórico fail-open; revisar junto con 0002. La función Wompi `app.append_wompi_webhook_attempt` preexistente es `SECURITY DEFINER` con owner schema_owner, pero solo toca `webhook_processing_attempts`, no `audit_logs`; su owner dedicado queda pendiente en el ámbito Wompi/Sprint 0. Los logins locales `tm_test_ml*` son residuos de una corrida S1-06 interrumpida, no migraciones. Retención/purge privilegiado y `trace_id` siguen fuera de Sprint 1.

### S1-08 — aislamiento final y recuperación de outbox

- API: JWT Clerk verificado y membership activa en PostgreSQL fijan el TenantContext; claims de rol/permisos/metadata del proveedor no son autoridad. Un UUID real de otro tenant equivale a uno inexistente para GET membership/roles y revoke invitación (404 con mismo código/mensaje); seleccionar B sin membership activa da 403. Listados/commands de A no leen ni mutan B. Aceptación usa hash exacto de token y email verificado, no el header de tenant; un token válido con email distinto deja el denied mínimo en el tenant de la invitación.
- PostgreSQL: API/worker `NOBYPASSRLS`, no owners; RLS `ENABLE + FORCE` para tablas tenant-owned de Sprint 1 y FKs compuestas impiden lecturas, escrituras y enlaces cross-tenant bajo el contexto establecido por la aplicación. El inventario EXECUTE cubre API, worker, identity_sync, bootstrap resolver y PUBLIC. Las funciones de identidad tienen contratos globales acotados; no existe helper runtime de owner-lock que acepte tenant UUID libre.
- Worker: antes de handler normal o phased, `processClaimedJob` coteja el ID y tenant del claim con la fila outbox durable; `processPhasedJob` también coteja antes de `prepare`, por lo que un mismatch no realiza llamada de red, cambio de negocio, auditoría ni `processed`. Status/attempts/delivery quedan intactos tras el rechazo. Stall/requeue recupera el job y B puede reclamarlo y procesarlo una sola vez. Este binding es del **flujo worker soportado**: `app.bootstrap_claim_outbox_events`, `app.worker_get_outbox_event` y `app.worker_complete_outbox_event` son helpers globales por ID y no dependen de `app.tenant_id`.
- Locks y pool: A no toma lock de fila de workshop B mediante funciones/comandos soportados; operaciones concurrentes de roles, estado, invitación y auditoría de B progresan mientras A usa `ACCESS SHARE` en `owner_mutation_gate`. `SET LOCAL` se libera al COMMIT/ROLLBACK y la misma conexión no hereda tenant, usuario, membership, request_id ni permisos tras error, retorno temprano o denegación.
- Threat model: los GUC son contexto fijado por la aplicación, no prueba criptográfica. SQL raw con credencial runtime comprometida puede establecer GUC arbitrarios o tomar advisory keys deterministas; queda fuera de esta garantía (INFO). No se añadió `lock_timeout`. Al cerrar S1-08, el Quality Gate final de Sprint 1 y la deuda CI seguían abiertos; su estado posterior se registra en la actualización del Quality Gate de esta sección.

## 5.3 Retención audit/compliance

- `audit_logs`: **24 meses** baseline de producto, luego purge controlado si no existe hold/obligación superior;
- application request logs: **30 días**;
- distributed traces: **14 días**;
- métricas operativas: **90 días** de detalle baseline;
- evidencia jurídica/aceptaciones tiene su política de negocio/privacidad y no se purga por el TTL de logs.

El purge de tablas append-only solo puede ejecutarlo un proceso de retención privilegiado y auditable; “append-only” impide alteración por runtime, no obliga a conservar para siempre.

## 5.4 Evidencia de cumplimiento

Todo Gate sensible debe conservar referencia a:

```
commit/release
ambiente
fecha
casos ejecutados
resultado
defectos
evidencia de logs/metrics
responsable/ejecutor
decisión PASS/FAIL
```

# 6. Observabilidad

## 6.1 Tres señales

1. **Logs estructurados JSON** — eventos/request/errors.
2. **Metrics** — disponibilidad, latencia, tasas, colas, DB, uploads, proveedores.
3. **Traces** — request → DB/outbox/worker/provider cuando aporte diagnóstico.

No crear una tabla PostgreSQL para application logs. `audit_logs` tiene una finalidad distinta.

## 6.2 Correlación obligatoria

Cuando aplique:

```
request_id
trace_id
tenant_id
user_id
membership_id
route / operation
service = api | worker
status_code / result
error_code
duration_ms
provider / provider_ref
outbox_event_id / webhook_event_id
```

`request_id` siempre existe. Si llega uno externo no confiable, se valida formato/longitud o se genera uno nuevo. `trace_id` sigue formato del sistema de tracing.

## 6.3 Cardinalidad y privacidad

- `tenant_id`, user/customer/order IDs pueden existir en logs/traces protegidos, pero **no** como labels de métricas de alta cardinalidad.
- metrics usan labels acotados: route template, method, status class, error_code, provider, operation.
- bodies HTTP completos no se loguean por defecto.
- logs aplican redaction central de claves sensibles (`authorization`, `cookie`, `token`, `otp`, `secret`, payment instrument data).

## 6.4 SLO/SLI baseline

| Indicador | Objetivo MVP/piloto |
| --- | --- |
| Disponibilidad API | 99.0% mensual |
| API lectura p95 | ≤ 500 ms, excluyendo upload directo/provider async |
| API escritura p95 | ≤ 1 s, excluyendo upload directo/provider async |
| Webhook ACK p95 | ≤ 1 s después de verificación + persistencia durable |
| Outbox normal p95 | efecto despachado ≤ 2 min cuando proveedor disponible |
| Backup diario | 100% exitoso; no gap >26 h |

4xx esperados no cuentan como indisponibilidad. 5xx, timeout del servicio y readiness fallida sí alimentan el SLI según contrato definido.

## 6.5 Health

```
GET /health/live
  proceso/event loop vivo; no llama proveedores

GET /health/ready
  DB/conexión y dependencias internas indispensables
```

WhatsApp/Wompi/R2 outbound asíncrono no deben tumbar readiness de toda la API por una caída externa; su salud se expresa mediante métricas/alertas específicas.

## 6.6 Alertas baseline

| Señal | Warning | Critical |
| --- | --- | --- |
| API 5xx | >2% durante 15 min | >5% durante 5 min |
| Readiness | — | fallida ≥2 min |
| DB pool | >80% 10 min | >95% 5 min |
| Oldest outbox | >10 min | >30 min; pagos/autorizaciones críticas >5 min |
| Webhook processing | errores repetidos | DLQ/efecto financiero-autorización sin procesar |
| R2 upload failure | >5% 15 min | >15% 5 min |
| Backup | restore drill >35 días | sin backup válido >26 h / WAL fuera RPO |
| Cross-tenant/security | spike de denies | cualquier evidencia confirmada de fuga |

## 6.7 Error contract

Errores de aplicación usan código estable:

```json
{
  "error": {
    "code": "DOMAIN_PRECONDITION_FAILED",
    "message": "Safe client message",
    "request_id": "..."
  }
}
```

Stack trace/SQL/provider secrets solo en telemetría protegida; nunca en respuesta production.

# 7. Estrategia de migraciones y rollback

## 7.1 Principios

- Las migraciones son **forward-only por defecto** en producción. Una migración ya aplicada no se edita ni se reordena.
- `down migration` no es el mecanismo principal de recuperación de producción: rollback puede significar rollback de aplicación compatible, forward-fix o, como último recurso ante pérdida/corrupción, restore/PITR.
- `tallermecario_migrator` ejecuta DDL; `tallermecario_api`/`tallermecario_worker` nunca migran ni tienen DDL.
- Solo un runner de migraciones opera por ambiente/release; se usa lock/advisory lock o mecanismo equivalente para impedir dos migraciones concurrentes.
- Toda migración se prueba en DB vacía **y** como upgrade desde la versión anterior/clone representativo.
- Cada release registra schema version/commit y la aplicación valida compatibilidad esperada al arrancar.

## 7.2 Expand / migrate / contract

Para cambios con riesgo de incompatibilidad:

```
EXPAND
  agregar tabla/columna/index/constraint compatible
  ↓
DEPLOY compatible
  código soporta schema viejo+nuevo cuando aplique
  ↓
MIGRATE/BACKFILL
  por lotes, reanudable, observable e idempotente
  ↓
VERIFY
  conteos/invariantes/telemetría
  ↓
CONTRACT
  eliminar columna/constraint viejo en release posterior
```

Reglas:

- contract solo ocurre cuando la versión antigua de aplicación ya no está ejecutándose, el backfill está verificado y la ventana de rollback compatible se cerró;
- rename/drop/type rewrite grande nunca se hace como cambio destructivo único si puede resolverse con expand/contract;
- datos históricos/append-only no se reescriben masivamente sin plan específico y evidencia;
- cambios que introduzcan `tenant_id`, FK/RLS/NOT NULL deben permitir backfill + validación antes de endurecer la constraint.

## 7.3 Operaciones PostgreSQL con locks/costo

Baseline para tablas con volumen significativo:

- crear índices de producción mediante estrategia online/`CREATE INDEX CONCURRENTLY` cuando corresponda;
- constraints costosas pueden crearse `NOT VALID` y luego `VALIDATE CONSTRAINT` cuando PostgreSQL lo permita;
- backfills grandes se ejecutan por lotes con checkpoint/progreso, no dentro de una única transacción gigante;
- establecer `lock_timeout`/`statement_timeout` conservadores en migraciones sensibles; excederlos falla el deploy en vez de congelar operación;
- operaciones no transaccionales se modelan explícitamente y deben poder reanudarse/validarse.

## 7.4 Orden de despliegue

```
CI valida migrations
   ↓
backup/checkpoint si cambio riesgoso
   ↓
pre-deploy EXPAND migration
   ↓
deploy API/worker compatible
   ↓
smoke + métricas
   ↓
backfill async/controlado si aplica
   ↓
verify invariantes
   ↓
CONTRACT en release posterior
```

No ejecutar contract destructivo automáticamente en el mismo deploy que introduce el reemplazo.

## 7.5 Rollback por tipo de fallo

**Falla antes de commit de migración transaccional:** rollback DB automático y release detenido.

**Migración expand aplicada pero app falla:** revertir versión de aplicación a una que sea compatible con el schema expandido; no borrar inmediatamente columnas/tablas nuevas.

**Backfill falla:** detener/reanudar desde checkpoint; los lotes deben ser idempotentes. No revertir datos correctos para “volver atrás” salvo plan explícito.

**Contract/destructivo falla o produce corrupción:** detener tráfico/escrituras afectadas, evaluar forward-fix; si hay pérdida/corrupción real usar restore/PITR según runbook y luego reconciliar efectos externos.

## 7.6 Regla especial para efectos externos

Una migración/restore nunca debe reemitir pagos, WhatsApp, webhooks ni outbox ya consumidos. Después de restore se ejecuta reconciliación antes de reactivar workers que puedan producir efectos externos.

## 7.7 Gate de migraciones

- [ ]  migraciones aplican desde DB vacía;
- [ ]  upgrade desde versión anterior/clone staging funciona;
- [ ]  segunda ejecución no reaplica/duplica efectos impropiamente;
- [ ]  dos runners concurrentes no pueden migrar al mismo tiempo;
- [ ]  runtime no tiene DDL;
- [ ]  expand schema permite rollback de aplicación durante ventana compatible;
- [ ]  backfill reanuda tras fallo y verifica invariantes;
- [ ]  contract está separado del release expand correspondiente;
- [ ]  operación riesgosa tiene backup/checkpoint y rollback/forward-fix documentado;
- [ ]  restore/migration no redespacha efectos externos.

# 8. Runbooks mínimos antes del piloto

- DB restore/PITR;
- R2 missing object/orphan cleanup;
- Wompi reconciliation post-incident;
- customer payment correction/reversal;
- outbox backlog/provider outage;
- webhook poison/retry/DLQ;
- suspected cross-tenant incident;
- privacy deletion/legal hold;
- observability outage.

## 8.1 Correo transaccional de invitaciones (Resend) — S1-04

Variables (plantillas versionadas `.env.example` / `staging.env.example`, sin valores reales; secretos solo en el entorno):

| Variable | Proceso | Notas |
| --- | --- | --- |
| `MEMBERSHIP_INVITATION_TOKEN_SECRET` | API + worker | base64/base64url, ≥ 32 bytes aleatorios; **mismo valor** en ambos; rotación = nueva `key_version` (no soportada aún: jobs con otra versión fallan permanentemente) |
| `MEMBERSHIP_INVITATION_ACCEPT_URL` | API | página de aceptación de la PWA; https (http solo localhost); sin query ni fragmento |
| `MEMBERSHIP_INVITATION_EMAIL_FROM` | API | remitente verificado en Resend |
| `RESEND_API_KEY` | worker | secreto |
| `RESEND_API_BASE_URL` | worker | opcional (default `https://api.resend.com`) |
| `RESEND_TIMEOUT_MS` | worker | opcional (default 10000, máx 30000); lease de entrega = timeout + 15 s |

- **Fail closed:** con todas vacías, invitaciones deshabilitadas (sin rutas ni handler). Con cualquiera presente, cada proceso exige su propio conjunto o no arranca.
- Accept URL y remitente quedan congelados en el snapshot de cada job al crear la invitación; cambiarlos solo afecta invitaciones nuevas.
- **Requisito de despliegue (bloqueante para E2E real):** el **click tracking de Resend DEBE estar desactivado** para el dominio remitente de invitaciones antes de cualquier E2E real. No se asume que un redirect de tracking preserve el aislamiento del fragmento `#token=` (el token nunca debe llegar a un servidor intermedio). Verificar también que no haya reescritura de enlaces en el dominio.
- Idempotencia: `Idempotency-Key: membership-invitation/<invitation_id>`; mismo key ⇒ mismo request. Ventana de deduplicación del proveedor finita: un reintento tras un corte largo puede reenviar el mismo correo (mismo link).
- Operación del lease: tras un fallo ambiguo (timeout/red/5xx) la invitación queda en `409 INVITATION_IN_PROGRESS` para revoke/accept hasta que vence el lease (≤ timeout + 15 s); worker muerto ⇒ mismo efecto, sin bloqueo permanente. Runbook de backlog/outage del outbox aplica.
- Riesgo residual (LOW, sin impacto de autorización): una suspensión prolongada del host/VM del worker entre la validación del deadline y la escritura efectiva al socket puede producir un correo tardío tras vencer el lease (ver ADR-009 §9, alcance del invariante). El enlace de ese correo no concede acceso si la invitación ya es terminal. Si aparece `membership.invitation_email_sent` con `lease_state` ≠ `held`, revisar pausas del host del worker; no requiere acción sobre datos.
- E2E real contra Resend: ejecutado y documentado durante el cierre final de S1-04. No se repite en el Quality Gate final de Sprint 1 sin motivo nuevo.

# 9. Quality Gate transversal

- [ ]  Retention worker identifica y purga correctamente media vencida sin tocar hold/warranty vigente.
- [ ]  Media eliminada deja de generar signed URLs antes del purge físico.
- [ ]  R2 orphan/missing-object scan detecta inconsistencias.
- [ ]  PITR/restore cumple RPO ≤15 min y RTO ≤4 h en ejercicio medido.
- [ ]  Restore no duplica outbox/payment/provider effects.
- [ ]  Confirmed customer payment es inmutable salvo transición explícita a reversed.
- [ ]  Allocation total nunca supera amount y saldo de orden se deriva del ledger.
- [ ]  Reconciliation run detecta drift y no corrige silenciosamente.
- [ ]  Audit log sensible es append-only para runtime y no contiene secretos/OTP/tokens crudos.
- [ ]  Purge por retención usa actor/proceso privilegiado separado y deja audit event.
- [ ]  Logs/metrics/traces correlacionan request → worker/provider donde aplique.
- [ ]  Redaction tests prueban que Authorization/Cookie/token/OTP/payment secrets no aparecen.
- [ ]  SLO dashboards y alertas baseline funcionan en staging.
- [ ]  `/health/live` y `/health/ready` tienen semántica distinta y provider externo caído no vuelve unready la API si la operación crítica puede seguir.
- [ ]  Migraciones cumplen estrategia expand/migrate/contract y rollback/forward-fix documentado.
- [ ]  Backfill grande es reanudable/idempotente y no depende de una transacción monolítica.
- [ ]  Contract destructivo no ocurre en el mismo release que introduce el reemplazo.

# 10. Referencias técnicas/jurídicas

- PostgreSQL 18 — Backup and Restore / Continuous Archiving and PITR: [https://www.postgresql.org/docs/18/backup.html](https://www.postgresql.org/docs/18/backup.html)
- Cloudflare R2 — Object lifecycle rules: [https://developers.cloudflare.com/r2/buckets/object-lifecycles/](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- Cloudflare R2 — Durability: [https://developers.cloudflare.com/r2/reference/durability/](https://developers.cloudflare.com/r2/reference/durability/)
- Ley 1581 de 2012: [https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981)
- SIC — principio de temporalidad/finalidad: conservar datos solo por el tiempo razonable y necesario para la finalidad y exigencias aplicables.

<aside>
🚦

Con esta especificación, los valores de retención, DR, conciliación, auditoría y observabilidad dejan de ser menciones genéricas. El PASS sigue dependiendo de implementación y evidencia del Gate correspondiente.

</aside>
