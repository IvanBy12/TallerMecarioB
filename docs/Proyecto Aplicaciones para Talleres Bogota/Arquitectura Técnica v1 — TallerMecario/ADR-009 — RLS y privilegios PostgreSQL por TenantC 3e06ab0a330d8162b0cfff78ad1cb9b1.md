# ADR-009 — RLS y privilegios PostgreSQL por TenantContext

<aside>
🛡️

**Decisión:** PostgreSQL RLS será una barrera obligatoria de aislamiento por tenant en las tablas tenant-owned. La aplicación seguirá aplicando RBAC y reglas de recurso; RLS no duplicará permisos funcionales como “technician assigned-only”.

</aside>

**Estado:** Baseline documental v1 — Sprint 0  

**Motor:** PostgreSQL 18.x  

**Implementación:** diferida hasta cerrar documentación; los SQL siguientes son especificación, no scripts autorizados.

# 1. Objetivo y límite de seguridad

- Evitar que un query que olvide `WHERE tenant_id = ...` lea o modifique datos de otro taller.
- Impedir INSERT/UPDATE que cambie una fila hacia otro `tenant_id` aunque la aplicación tenga un bug.
- Mantener FKs compuestas como protección estructural; RLS no las reemplaza.
- Mantener RBAC/resource scope en Fastify; RLS baseline responde **“¿es del tenant actual?”**, no **“¿qué rol puede hacer esta acción?”**.
- RLS es defensa en profundidad contra errores de consulta/contexto. No se considera defensa suficiente frente a un backend completamente comprometido que ya controle la credencial runtime.

# 2. Roles físicos PostgreSQL

| Rol | Uso | Privilegios baseline |
| --- | --- | --- |
| `tallermecario_schema_owner` | NOLOGIN; propietario de schemas/tablas/policies | DDL/ownership. Nunca usado por API/worker. |
| `tallermecario_migrator` | CI/CD migrations solamente | Puede `SET ROLE` al schema owner durante migración. Sin uso en runtime. |
| `tallermecario_api` | Fastify runtime | USAGE schema + DML explícito por tabla. `NOBYPASSRLS`, no owner, sin DDL/TRUNCATE/CREATE ROLE/CREATE DB. |
| `tallermecario_worker` | worker/jobs | DML explícito y RLS igual que API cuando toca datos tenant-owned. `NOBYPASSRLS`, no owner. |
| `tallermecario_bootstrap_resolver` | NOLOGIN; owner de funciones bootstrap allowlisted | `BYPASSRLS` excepcional y mínimo; SELECT solo en las tablas estrictamente necesarias para resolver contexto antes de conocer tenant. Nunca se conecta directamente. |
| `tallermecario_identity_sync` | NOLOGIN, NOINHERIT, `NOBYPASSRLS`; owner **exclusivo** de las funciones `SECURITY DEFINER` de lifecycle de identidad (S1-03, migración 0007) | `SELECT, INSERT, UPDATE` en `identity_sync_states`; en `users` solo columnas (`INSERT` id/identity_provider/external_subject/email/full_name/status; `UPDATE` email/full_name/status/updated_at), **sin DELETE**; `INSERT` en `webhook_events`/`webhook_processing_attempts`/`outbox_events` acotado por columnas y por policy `identity_sync_insert` (solo el job global `identity.provider_user_lifecycle_received` y el fan-out por tenant `identity.membership_revocation_requested`). Nunca se conecta directamente. |

Reglas:

- API y worker **nunca** reciben `BYPASSRLS` y nunca son propietarios de tablas.
- API/worker no pueden `SET ROLE` a owner, migrator ni bootstrap resolver.
- Ningún rol runtime (`tallermecario_api`, `tallermecario_worker`, `tallermecario_bootstrap_resolver`) es miembro de `tallermecario_identity_sync` ni puede `SET ROLE` a él; la migración 0007 revoca cualquier membresía y falla si persiste un camino `SET ROLE`. Los runtime solo reciben `EXECUTE` de funciones concretas: `tallermecario_api` → `app.ingest_verified_clerk_webhook`; `tallermecario_worker` → `app.identity_sync_classify`, `app.identity_sync_apply`, `app.identity_sync_record_attempt`. `PUBLIC` no tiene `EXECUTE`.
- `tallermecario_identity_sync` existe separado del resolver porque el resolver (`BYPASSRLS`) debe seguir sin privilegios de escritura de identidad (`INSERT users.status`, `UPDATE users.email`); las lecturas cross-tenant necesarias (memberships a revocar) y la auditoría sin tenant siguen en funciones allowlisted del resolver (`app.bootstrap_list_user_memberships_for_revocation`, `app.bootstrap_append_identity_audit`), ejecutables solo por `tallermecario_identity_sync`.
- Roles con `BYPASSRLS` autorizados: únicamente `tallermecario_bootstrap_resolver` (además del superusuario administrativo del clúster, que la aplicación no usa).
- no existe `GRANT ALL ON ALL TABLES` para runtime;
- nuevos objetos nacen sin acceso runtime hasta grant/migración explícita;
- `public`/schema de aplicación no concede `CREATE` a usuarios runtime ni `PUBLIC`;
- superuser/credencial administrativa de proveedor no se usa por la aplicación.

# 3. TenantContext dentro de PostgreSQL

El contexto de tenant se materializa como parámetros transaction-local, establecidos únicamente después de autenticar/resolver el contexto en backend.

**S1-08, reutilización de conexión:** la selección verifica JWT y membership activa en PostgreSQL; la aplicación liga `app.tenant_id`, `app.user_id`, `app.membership_id`, `app.request_id` y contexto de permisos con `SET LOCAL` en la transacción. Tras COMMIT o ROLLBACK —también por error, retorno temprano o denegación— la misma conexión no hereda el contexto del request anterior. Los GUC siguen siendo contexto confiado por la aplicación, no prueba criptográfica.

Especificación conceptual:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :tenant_id, true);
SELECT set_config('app.user_id', :user_id, true);
SELECT set_config('app.membership_id', :membership_id, true);
SELECT set_config('app.request_id', :request_id, true);
-- queries tenant-owned
COMMIT;
```

`true` significa contexto local a la transacción. No se permite contexto tenant session-wide porque el pool podría reutilizar una conexión para otro request.

Helper conceptual:

```sql
app.current_tenant_id()
  -> NULLIF(current_setting('app.tenant_id', true), '')::uuid
```

Reglas:

- toda operación tenant-owned, incluso SELECT, corre dentro de una transacción con contexto;
- contexto ausente produce NULL y por diseño ninguna policy tenant debe devolver filas;
- `tenant_id` nunca sale de body/query del cliente como autoridad;
- `membership_id`/`user_id` se usan para auditoría y bootstrap; la policy tenant principal compara únicamente tenant;
- los GUC `app.*` son contexto, no prueba criptográfica de autorización. Fastify sigue siendo responsable de establecerlos desde identidad/membership verificados.

# 4. Forma canónica de las policies

Para una tabla normal con `tenant_id`:

```sql
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON customers
  FOR SELECT TO tallermecario_api, tallermecario_worker
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_insert ON customers
  FOR INSERT TO tallermecario_api, tallermecario_worker
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_update ON customers
  FOR UPDATE TO tallermecario_api, tallermecario_worker
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

DELETE no se habilita genéricamente. Solo una tabla con caso de borrado físico aprobado recibe GRANT + policy DELETE específica.

Para `workshops`, cuya PK `id` es el tenant:

```
USING / WITH CHECK: id = app.current_tenant_id()
```

`WITH CHECK` en UPDATE es obligatorio: además de impedir modificar una fila ajena, evita mover una fila propia de Tenant A a Tenant B.

# 5. ENABLE + FORCE RLS

Toda tabla tenant-owned cubierta debe usar:

```
ENABLE ROW LEVEL SECURITY
FORCE ROW LEVEL SECURITY
```

`FORCE` reduce el riesgo de bypass accidental por ownership. Aun así, superusers y roles `BYPASSRLS` siguen fuera del modelo runtime; por eso esas credenciales nunca pertenecen a API/worker.

# 6. Cobertura RLS — tablas tenant-owned

## 6.1 Política tenant directa obligatoria

Aplica policy estándar `tenant_id = current_tenant` a:

**Tenancy:** `workshop_locations`, `memberships`, `membership_invitations`, `membership_invitation_deliveries` (0009; sin `tenant_update`, escritura solo vía funciones de lease §9), `membership_roles` (0011; sin `tenant_update`, `tenant_delete` solo para `tallermecario_api`).

**CRM:** `customers`, `vehicles`, `vehicle_owners`.

**Agenda:** `appointments`, `reminders`.

**Recepción:** `receptions`, `reception_check_items`, `vehicle_damages`, `signatures`.

**Órdenes:** `service_orders`, `service_order_items`, `order_status_history`, `assignments`.

**Diagnóstico:** `diagnostics`, `findings`, `recommendations`.

**Catálogo:** `catalog_items`.

**Inventario:** `inventory_balances`, `inventory_movements`.

**Cotizaciones:** `quotes`, `quote_versions`, `quote_items`, `quote_authorization_tokens`, `quote_authorization_challenges`, `quote_authorizations`, `quote_authorization_items`.

**Operación:** `work_activities`, `technician_logs`, `quality_checks`, `deliveries`.

**Media:** `media_assets`, `upload_sessions`, `reception_media`, `damage_media`, `finding_media`, `work_activity_media`, `quality_check_media`, `delivery_media`, `quote_media`.

**Comunicaciones:** `tenant_whatsapp_accounts`, `message_threads`, `messages`, `customer_order_access_tokens`.

**Billing tenant:** `subscriptions`, `billing_events`, `payments`.

**Pagos operativos:** `customer_payments`, `customer_payment_allocations`, `customer_payment_reconciliation_runs`.

**Sync/Audit tenant:** `sync_operations`; `audit_logs` para filas con tenant.

**Privacidad tenant-scoped:** `privacy_consents` (consentimiento del cliente final; `tenant_id` obligatorio, siempre atado a un taller).

## 6.2 `workshops`

RLS especial por `workshops.id = current_tenant_id()`.

## 6.3 Global/read-only — sin RLS tenant

`roles`, `permissions`, `role_permissions`, `plans` son catálogos globales. Runtime solo recibe los grants mínimos necesarios; escritura queda en migrator/plataforma.

`users` es identidad global y no se expone como tabla navegable por runtime. El bootstrap de identidad/memberships usa funciones allowlisted.

## 6.4 Mixed-scope / plataforma — no policy tenant genérica

- `feature_flags`: scopes global/plan/tenant; se accede mediante resolver de flags, no por SELECT indiscriminado.
- `legal_acceptances`: puede ser tenant o global_user; requiere contrato específico, no `tenant_id = current_tenant` ciego.
- `webhook_events` y `webhook_processing_attempts`: ingestion/processing puede ocurrir antes de resolver tenant; acceso restringido por roles/funciones de integración.
- `outbox_events`: cola cross-tenant; worker reclama trabajos mediante función controlada y luego procesa cada job bajo TenantContext.
- `data_subject_requests`: `tenant_id` nullable — puede referirse a datos que un taller trata como Responsable o a datos que ILVOX trata como Responsable propio; mismo tratamiento mixed-scope que `legal_acceptances`, no `tenant_id = current_tenant` ciego.
- `privacy_security_incidents`: `tenant_id` nullable — un incidente puede afectar un taller específico o ser transversal a la plataforma; acceso restringido a roles/funciones internas de cumplimiento, no policy tenant genérica.
- auditoría/plataforma con `tenant_id IS NULL`: no visible a un tenant mediante policy normal.

# 7. Bootstrap antes de conocer tenant

Hay flujos legítimos donde no existe `app.tenant_id` todavía. No se resuelven desactivando RLS ni dando SELECT global a `tallermecario_api`.

Se permiten exclusivamente funciones `SECURITY DEFINER` allowlisted, propiedad de `tallermecario_bootstrap_resolver`, con `search_path` fijo a schemas confiables y `EXECUTE` revocado de `PUBLIC`.

Casos baseline:

1. **Login/selector de taller:** listar memberships activas del usuario Clerk ya verificado y validar que puede entrar al tenant elegido.
2. **Token público de cotización:** resolver `token_hash` exacto, estado, expiración y tenant/version sin permitir scans.
3. **Token público de seguimiento:** resolver hash exacto del `customer_order_access_token`.
4. **WhatsApp webhook:** resolver `phone_number_id` exacto hacia `tenant_whatsapp_accounts` después de validar autenticidad del webhook.
5. **Wompi webhook:** resolver referencia/transaction id exacto hacia payment/subscription después de validar firma.
6. **Worker:** reclamar batch de `outbox_events`; cada job resultante se procesa en una nueva transacción tenant-scoped.
7. **Lifecycle de identidad (S1-03):** el webhook Clerk verificado persiste mediante `app.ingest_verified_clerk_webhook` (owner `tallermecario_identity_sync`); el worker aplica el lifecycle global mediante `app.identity_sync_apply`. La revocación de memberships de un usuario eliminado se lista vía `app.bootstrap_list_user_memberships_for_revocation` y se ejecuta como **un job por tenant** (`identity.membership_revocation_requested`) procesado por el worker bajo TenantContext + RLS (§9); nunca se modifica una membership fuera de su tenant.

8. **Aceptación de invitación interna (S1-04, 0008):** `app.bootstrap_resolve_membership_invitation(p_token_hash)` — hash SHA-256 hex exacto → `(invitation_id, tenant_id)`; nunca por prefijo/email/tenant; sin status/email/rol en el resultado. `EXECUTE` solo para `tallermecario_api` (no worker, no PUBLIC). Grants del resolver sobre `membership_invitations`: SELECT de columnas `id, tenant_id, token_hash` (0008) y `status, expires_at` (0009, funciones de lease); **ningún** INSERT/UPDATE. Tras la resolución, todo corre bajo `app.tenant_id` de la invitación + RLS en una sola transacción (identity-only: el invitado aún no tiene membership).

Las funciones bootstrap devuelven solo identificadores mínimos y nunca listas arbitrarias de datos de negocio.

# 8. Seguridad de SECURITY DEFINER

- owner dedicado NOLOGIN;
- `search_path` fijo; ningún schema escribible por runtime aparece primero;
- nombres de objetos schema-qualified;
- `REVOKE EXECUTE ... FROM PUBLIC` y GRANT solo al rol requerido;
- parámetros tipados y sin SQL dinámico salvo caso auditado;
- resultado mínimo;
- auditoría de invocaciones sensibles cuando aplique;
- tests de inputs inexistentes/manipulados y cross-tenant;
- el rol bootstrap no recibe DDL ni acceso genérico a todas las tablas.

# 9. Worker y jobs

`tallermecario_worker` no usa `BYPASSRLS`.

**Tenant-binding S1-08 del flujo soportado:** `processClaimedJob` coteja `outboxEventId` y `tenantId` del claim con la fila durable antes del handler normal o del phased; `processPhasedJob` repite el cotejo antes de `prepare`/red y `apply`. Un mismatch produce `OUTBOX_CLAIM_TENANT_MISMATCH`, sin completar el job ni consumir un intento adicional. Stall/requeue permite un claim posterior con el tenant correcto y procesamiento exactamente una vez. `app.bootstrap_claim_outbox_events`, `app.worker_get_outbox_event` y `app.worker_complete_outbox_event` son helpers globales `SECURITY DEFINER` por ID: **no dependen de `app.tenant_id`** para la lectura/transición; el binding reside en el flujo worker. Su EXECUTE no está concedido a API ni PUBLIC. La ruta soportada procesa efectos de negocio bajo TenantContext y RLS del tenant cotejado.

Flujo:

```
claim job global controlado
   ↓
job_id + tenant_id
   ↓
BEGIN nueva transacción
   ↓
set_config(app.tenant_id, tenant, true)
   ↓
procesar tablas tenant-owned bajo RLS
   ↓
COMMIT
```

Un job sin tenant válido no puede tocar tablas tenant-owned.

**Regla transacción / red (S1-03):** ningún job mantiene una transacción PostgreSQL, una conexión reservada ni locks abiertos durante una llamada a un proveedor externo. El handler de lifecycle Clerk es *phased*: (A) claim + lectura en autocommit; (B) una sola llamada al Backend API de Clerk con timeout finito, sin transacción ni conexión reservada; (C) nueva transacción corta que toma el advisory lock por identidad, relee `identity_sync_states` y descarta el snapshot si un evento más nuevo ganó la carrera mientras (B) esperaba la red.

**Entrega del correo de invitación (S1-04 audit fix, 0009) — lease de envío.** Mismo esquema phased, más coordinación con las transiciones terminales de `membership_invitations`:

- Funciones `SECURITY DEFINER` allowlisted, owner `tallermecario_bootstrap_resolver`, `search_path = pg_catalog, public`, sin EXECUTE a PUBLIC, `EXECUTE` solo para `tallermecario_worker`:
  - `app.worker_acquire_invitation_email_lease(outbox_event_id, lease_id, lease_seconds)` — lease de 2..120 s; tenant e invitación se derivan del job reclamado (`status='processing'`, event_type/aggregate exactos), nunca de un parámetro; resultado mínimo (`acquired | skip_* | already_sent | busy | not_claimed | not_found`, `lease_until`, `prior_attempt_unconfirmed`);
  - `app.worker_complete_invitation_email_delivery(outbox_event_id, lease_id, provider_message_id)` — dentro de la transacción (C): registra la aceptación del proveedor una sola vez y libera el lease (misma commit que el audit y el `processed` del outbox);
  - `app.worker_release_invitation_email_lease(outbox_event_id, lease_id)` — liberación temprana solo si no hay request en vuelo (no se envió o el proveedor rechazó definitivamente).
- Punto de serialización: advisory lock transaccional `hashtextextended('tallermecario.membership_invitation.delivery/' || invitation_id, 0)` tomado por esas funciones y por el trigger de ciclo de vida en toda transición `pending → terminal`. No requiere privilegio de tabla (un row lock `FOR UPDATE/SHARE` exigiría UPDATE al worker/owner). El trigger (SECURITY INVOKER, corre como `tallermecario_api`) rechaza con `55006 mi_delivery_in_progress` mientras haya lease vigente.
- Grants del resolver en `membership_invitation_deliveries`: solo a nivel columna (SELECT/INSERT/UPDATE de columnas `lease_*`, `sent_at`, `provider_message_id`, `updated_at`); ningún grant de tabla. `tallermecario_api`: SELECT bajo RLS (lo lee el trigger). `tallermecario_worker`: ningún privilegio.
- Invariante: si una transición terminal confirmó, ningún envío asociado puede **comenzar** después: todo lease previo expiró (y con él el deadline local del intento, medido desde antes del acquire) o fue liberado tras terminar su request; todo acquire posterior ve el estado terminal. Un lease vigente nunca se toma (ni por un intento posterior del mismo job). Worker muerto ⇒ el lease expira; no hay estado zombie.
- **Alcance del invariante — riesgo residual LOW, sin impacto de autorización.** El lease coordina el envío bajo relojes normales de ejecución: el deadline local se mide con el reloj monotónico del proceso worker y el lease con el reloj de PostgreSQL. Una suspensión prolongada del host/VM del worker entre la validación del deadline y la escritura efectiva del request al socket (p. ej. pausa de la VM durante la cual el reloj monotónico del huésped no avanza) podría dejar salir un correo tardío después de que el lease expiró y de que una transición terminal confirmó. El mecanismo **no** ofrece una garantía física absoluta frente a una suspensión arbitraria del host. Consecuencia acotada: el token de ese correo sigue siendo inválido porque la invitación ya es terminal (`accept` → 410/409, nunca crea membership ni rol); si el worker registra luego la aceptación del proveedor, `membership.invitation_email_sent` lo refleja con `lease_state` distinto de `held` e `invitation_status_at_record`, sin cambiar el estado de la invitación.

# 10. Permisos físicos DML

Baseline runtime:

- `SELECT` solo donde el caso de uso lo requiere;
- `INSERT` solo en tablas creadas por ese runtime;
- `UPDATE` solo en tablas mutables;
- `DELETE` deny-by-default;
- `TRUNCATE`, `REFERENCES`, `TRIGGER`, DDL: nunca para API/worker;
- históricos append-only: INSERT/SELECT según necesidad, sin UPDATE/DELETE/TRUNCATE;
- secrets/credential material no reside en tablas de aplicación.

RLS no protege operaciones como `TRUNCATE`; por eso los REVOKE físicos siguen siendo obligatorios.

Reducciones aplicadas sobre el baseline genérico de 0000 (que concede SELECT/INSERT/UPDATE en toda tabla tenant mutable a ambos runtimes):

- **S1-04 (0010):** `tallermecario_worker` solo `SELECT` en `membership_invitations` (REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER); la policy `tenant_update` de esa tabla aplica solo a `tallermecario_api`. `tenant_select`/`tenant_insert` conservan ambos roles (gate Sprint 0; una policy no concede nada sin privilegio). La migración falla si el worker conserva cualquier vía de escritura (directa, PUBLIC, membresía, columna).
- **S1-04 (0009):** `membership_invitation_deliveries` sin grant al worker; API solo SELECT; sin policy `tenant_update`.
- **S1-05 (0011) `membership_roles`:** REVOKE `UPDATE` a `tallermecario_api` y `tallermecario_worker`; policy `tenant_update` eliminada (un cambio de rol es DELETE + INSERT, Diccionario 01 §9). `GRANT DELETE` solo a `tallermecario_api`, policy `tenant_delete FOR DELETE TO tallermecario_api USING (tenant_id = app.current_tenant_id())`. Worker: SELECT/INSERT, sin UPDATE/DELETE. Policies resultantes: `tenant_select`, `tenant_insert` (api, worker), `tenant_delete` (api).
- **S1-05 (0012/0013) `memberships`:** conserva los triggers de owner y la jerarquía de locks; desde 0015, API y worker tienen UPDATE solo de columnas de ciclo de vida. Los comandos S1-06 escriben `status`; el handler S1-03 conserva su revocación. Ningún runtime tiene DELETE/TRUNCATE.
- **S1-05 (0013) `workshops`:** sin cambio: api/worker ya tenían UPDATE + policy `tenant_update` (0000), que es lo que permite `FOR NO KEY UPDATE` de **su propio** workshop bajo RLS (§10.1).
- **S1-05 (0013) `app.owner_mutation_gate`:** tabla sin columnas ni filas (solo objeto de lock), owner `tallermecario_schema_owner`, RLS ENABLE/FORCE, `SELECT` a api/worker, nada a PUBLIC.
- **S1-05 (0013) funciones:** `app.lock_current_tenant_owner_set()` — sin argumentos, EXECUTE solo api/worker. `app.enforce_owner_set_lock_order()`, `app.enforce_membership_owner_invariant()`, `app.enforce_membership_role_invariants()` — funciones de trigger, sin EXECUTE a nadie (no invocables directamente). Todas SECURITY INVOKER, owner `tallermecario_schema_owner`, `search_path = pg_catalog, public`, sin EXECUTE a PUBLIC. **Eliminadas** en 0013: `app.lock_tenant_owner_set(uuid)`, `app.assert_tenant_keeps_active_owner(uuid, text)` (helpers de 0012 que aceptaban un tenant id arbitrario) y la función de trigger 0012 `app.lock_current_tenant_owner_set()` (el nombre se reutiliza para la interfaz runtime). Sin `SECURITY DEFINER` ni `BYPASSRLS` nuevos.
- **S1-05 (0014):** `CREATE OR REPLACE` de `app.lock_current_tenant_owner_set()` únicamente (sin `RAISE 55000` cuando el workshop no es visible, §10.1); sin cambios de grants, owner, `SECURITY INVOKER` ni `search_path`.

- **S1-06 (0015) `memberships`:** REVOKE `UPDATE` de tabla a `tallermecario_api` y `tallermecario_worker`;
  `GRANT UPDATE (status, suspended_at, revoked_at, updated_at)` a ambos. `id`, `tenant_id`, `user_id`, `joined_at`,
  `created_at` quedan inmutables para runtime (42501). `SELECT … FOR UPDATE/NO KEY UPDATE/SHARE` siguen funcionando
  (requieren UPDATE en al menos una columna). Policies (`tenant_select`, `tenant_insert`, `tenant_update`), RLS
  ENABLE/FORCE, SELECT/INSERT y triggers 0012–0014 sin cambio; sin funciones, `SECURITY DEFINER` ni `BYPASSRLS` nuevos.
  La migración falla si queda UPDATE de tabla, UPDATE en columnas no permitidas, DELETE/TRUNCATE/REFERENCES/TRIGGER
  o cualquier privilegio de PUBLIC. *Seguimiento:* el worker solo necesita `(status, revoked_at, updated_at)`
  (handler S1-03); conserva `suspended_at` porque las suites DB de S1-05 lo usan como escritor genérico de estado —
  estrecharlo requiere ajustar esos fixtures.
- **S1-06 audit fix (0016) `memberships`:** máquina de estados en PostgreSQL. CHECK `memberships_lifecycle_state_check`
  (timestamps exactos por estado; validado contra filas existentes). Triggers `memberships_status_transition_trg`
  (`BEFORE UPDATE OF status`; solo `active→suspended`, `active→revoked`, `suspended→revoked`; `23514 m_status_transition`)
  y `memberships_timestamp_history_trg` (`BEFORE UPDATE`; solo cambia el timestamp del estado de entrada;
  `23514 m_lifecycle_history`). Funciones `app.enforce_membership_status_transition()` /
  `app.enforce_membership_lifecycle_history()`: SECURITY INVOKER, owner `tallermecario_schema_owner`,
  `search_path = pg_catalog, public`, sin EXECUTE para nadie, no leen tablas ni toman locks. Aplican a runtime y a sesiones
  privilegiadas con triggers activos; sin grants, `SECURITY DEFINER` ni `BYPASSRLS` nuevos; grants 0015 intactos.
- **S1-07 (0017) `audit_logs`:** REVOKE `INSERT` de tabla a `tallermecario_api` y `tallermecario_worker`; `GRANT INSERT` por columnas (API: todas salvo `user_agent`, `created_at`; worker: además sin `ip_address`). `SELECT`, RLS `ENABLE + FORCE`, policies `tenant_select`/`tenant_insert` y triggers append-only 0002 se conservan. `audit_logs_actor_guard_trg` (`BEFORE INSERT`, `app.enforce_audit_log_actor()` SECURITY INVOKER, owner schema_owner, `search_path=pg_catalog`, sin EXECUTE directo) liga actor y `request_id` al contexto de sesiones que son o heredan runtime, con rechazo `42501 audit_logs_actor_guard`. API: `user` corresponde a `app.user_id`/`app.membership_id`, `system` sin actor, `request_id=app.request_id`; worker: solo `system`/`provider` sin actor. API no escribe `provider`/`platform`; ningún runtime escribe `platform`. Funciones `SECURITY DEFINER` allowlisted de identidad/bootstrap conservan su contrato global. Sin nueva policy, `SECURITY DEFINER`, `BYPASSRLS` ni reescritura de historia. La migración falla ante privilegios de tabla/columna fuera de la allowlist o PUBLIC.

Privilegios finales de `audit_logs`: API `SELECT` bajo RLS + INSERT por columnas sin `user_agent`/`created_at`; worker `SELECT` bajo RLS + las columnas API salvo `ip_address`; ambos sin UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. `tallermecario_bootstrap_resolver` conserva únicamente INSERT por columnas `id, tenant_id, actor_type, actor_user_id, action, outcome, entity_type, entity_id, metadata_json, request_id` para sus funciones allowlisted; sin SELECT/UPDATE/DELETE/TRUNCATE. `tallermecario_identity_sync` no tiene INSERT directo y llama `app.bootstrap_append_identity_audit` por EXECUTE. `PUBLIC` no tiene privilegios ni EXECUTE de las funciones escritoras. `tallermecario_schema_owner` es owner de migraciones, sin uso runtime. `app.bootstrap_provision_user` (EXECUTE API) y `app.bootstrap_append_identity_audit` (EXECUTE identity_sync) son las funciones escritoras directas; `app.ingest_verified_clerk_webhook` y `app.identity_sync_apply` escriben indirectamente bajo sus contratos de identidad.

- **S2-03 (0018) `customers`, `vehicles`, `vehicle_owners`** (reducciones aprobadas en S2-02):
  - **API:** `tallermecario_api` conserva SELECT e INSERT y recibe UPDATE solo por columnas:
    - `customers`: `document_type, document_number, first_name, last_name, phone, email, notes, updated_at`;
    - `vehicles`: `plate, vin, vehicle_type, brand, model, model_year, color, engine_number, current_mileage_km, updated_at`;
    - `vehicle_owners`: solo `valid_to`.
  - **Inmutable para runtime (42501):** `id`, `tenant_id` y `created_at`; en `vehicle_owners`, todo salvo `valid_to`.
  - **Worker:** `tallermecario_worker` no tiene privilegio de tabla ni de columna en las tres tablas (REVOKE ALL). Ningún caso de uso del worker toca CRM en Sprint 2; un sprint futuro (p. ej. WhatsApp/recordatorios) otorgará solo lo que su contrato documente.
  - **PUBLIC:** sin privilegios. Sin DELETE/TRUNCATE/REFERENCES/TRIGGER para ningún runtime.
  - **RLS y policies:** `tenant_select/insert/update` para {api, worker} y RLS ENABLE/FORCE, sin cambio (una policy no concede nada sin privilegio).
  - **Trigger Frozen-on-close:** `vehicle_owners_history_guard_trg` → `app.enforce_vehicle_owner_history()` (SECURITY INVOKER, owner `tallermecario_schema_owner`, `search_path = pg_catalog`, sin EXECUTE a nadie).
  - **CHECK:** `vehicles_plate_normalized_check`.
  - **Preflight de placa:** como `schema_owner` es NOBYPASSRLS, desactiva `FORCE` en `vehicles` temporalmente bajo `ACCESS EXCLUSIVE` y lo restaura antes de la CHECK.
  - **Autoverificación:** la migración falla si queda UPDATE de tabla, UPDATE fuera de la allowlist o cualquier privilegio de worker/PUBLIC, o si RLS, policies, función, trigger o constraints no coinciden.
  - **Delta aprobado en S2-02, pendiente de incorporar a S2-03 antes de su merge:** CHECK `vehicles_plate_format_check` (`plate COLLATE "C" ~ '^[A-Z0-9]{1,16}$'`) con su preflight, `schema.ts` y tests.

## 10.1 Lock de owner-set e invariante de owner activo (S1-05, 0011–0014)

"Owner activo" = fila `membership_roles` con rol `owner` sobre una membership con `status = 'active'` (el `users.status` **no** interviene). Toda escritura que reduzca ese conjunto — remoción del rol owner, `memberships.status` `active → suspended/revoked`, cambio de id/tenant o DELETE de una membership owner activa — la valida PostgreSQL con los triggers `membership_roles_invariants_trg` (`mr_last_active_owner`, `mr_membership_not_active`) y `memberships_owner_invariant_trg` (`m_last_active_owner`), SQLSTATE `23514`.

Jerarquía única de locks (0013):

```
app.owner_mutation_gate  ─►  fila public.workshops del tenant (FOR NO KEY UPDATE)  ─►  filas memberships / membership_roles
```

- **Tenant-scoped (runtime con TenantContext):** puerta en `ACCESS SHARE` → fila `workshops` de `app.current_tenant_id()` (bajo RLS: solo su propio tenant es visible/lockeable) → filas. Interfaz: `app.lock_current_tenant_owner_set()`; la usan los comandos S1-05, los comandos S1-06 `suspend`/`revoke` y el handler S1-03, y el trigger `BEFORE … FOR EACH STATEMENT` de `memberships`/`membership_roles` para cualquier UPDATE/DELETE del runtime. Contrato (0014): sin tenant context → `55000` (fail-closed); tenant context malformado → `22P02`; workshop visible → puerta `ACCESS SHARE` + fila `workshops` `FOR NO KEY UPDATE`; **workshop inexistente / no visible → puerta `ACCESS SHARE`, sin lock de fila y sin error** (no-op). **Un TenantContext válido cuyo workshop ya no existe/no es visible no convierte una operación de 0 filas en error de locking; se preserva el not_found del dominio.** Es seguro porque bajo RLS tampoco es visible ninguna fila de ese tenant (FK → `workshops`, mismo predicado), y no crea oráculo: un runtime solo ve su tenant ligado, así que "no visible" equivale a "no existe". El trigger de sentencia aplica la misma regla.
- **Privilegiado / sin scope (superuser o `BYPASSRLS`):** el trigger de sentencia toma la puerta en `ACCESS EXCLUSIVE` **antes de tocar filas**; espera a todo holder tenant-scoped y luego toma la fila `workshops` de cada tenant afectado en los triggers de fila, cuando ninguna transacción tenant-scoped puede tener una. Esto elimina el ciclo de 0012 (privilegiado: fila → lock de tenant; runtime: lock de tenant → fila) que producía `40P01`.
- **Aislamiento de locks entre tenants:** no hay función runtime que acepte un tenant id; la fila `workshops` de otro tenant es invisible bajo RLS (el `FOR NO KEY UPDATE` devuelve 0 filas); con solo `SELECT` sobre la puerta, el único modo que un runtime puede tomar es `ACCESS SHARE` (los demás modos de `LOCK TABLE` exigen UPDATE/DELETE/TRUNCATE → 42501), que solo retrasa escrituras privilegiadas, nunca a otro tenant. El owner-set ya no usa advisory locks.
- **Snapshot:** cada comprobación del invariante es una sentencia nueva ejecutada después de adquirir los locks → en READ COMMITTED ve todo lo confirmado mientras esperaba. Fuera de READ COMMITTED una reducción de owners falla cerrada.
- **Boundary de operaciones privilegiadas (no cubierto):** superusuarios/roles administrativos de PostgreSQL pueden tomar cualquier lock (incluida la puerta exclusiva o la fila de cualquier workshop) y desactivar triggers (`session_replication_role = replica`); eso es boundary de administración, no de tenant. Una sesión runtime que fija `app.tenant_id` a otro tenant obtiene acceso a los datos de ese tenant igual que antes (los GUC son contexto, no prueba criptográfica — §3); el lock no añade superficie sobre eso. Los advisory locks built-in (`pg_advisory_xact_lock`, PUBLIC) siguen disponibles para cualquier sesión, pero el owner-set no los usa.
- **INFO S1-08:** las advisory keys deterministas también pueden ser tomadas con SQL raw por una credencial runtime comprometida. El aislamiento de locks probado cubre funciones y comandos soportados: A no bloquea la fila workshop de B y sus operaciones concurrentes progresan mientras el owner-set usa `ACCESS SHARE` global. El SQL raw de una sesión comprometida queda fuera del threat model; no se añade `lock_timeout` sin defecto funcional demostrado.
- **Orden no soportado:** una transacción que primero bloquea la fila `workshops` por otra vía (p. ej. un UPDATE del perfil del taller) y después reduce owners puede interbloquearse con una escritura privilegiada; ninguna ruta actual lo hace.
- **Interacción con S1-03 (sin cambio de semántica):** el handler `identity.membership_revocation_requested` revoca memberships del usuario borrado salvo la última owner activa (`kept_last_owner`, auditada `membership.revoked`/`denied`/`last_owner_invariant`); no toca `users`; no reactiva nada; `users.status = disabled` **no** implica `membership.status = revoked`. Único cambio: llama `app.lock_current_tenant_owner_set()` (tenant = el del job, ya ligado como TenantContext por el worker) **antes** de sus row locks, igual que los comandos S1-05. Un job cuyo tenant ya no existe (UUID válido sin workshop) termina en `not_found` sin modificar memberships ni roles, sin auditoría ni outbox y sin bloquear a tenants reales, igual que antes de 0013.
- **S1-03 con S1-06:** el handler puede revocar una membership suspendida por la API y devuelve `already_revoked` para una ya revocada sin intentar escribir `status` de nuevo. `kept_last_owner` cuenta solo owners `active`; una co-owner suspendida no cuenta. `not_found` para tenant inexistente se conserva.
- **0016 y datos legacy:** el CHECK `memberships_lifecycle_state_check` se valida contra filas existentes; una fila incoherente hace fallar la migración atómicamente, sin avance del ledger ni objetos parciales. Se corrige mediante mantenimiento explícito y luego se reaplica. `session_replication_role = replica` de superusuario puede omitir los triggers, pero no el CHECK.
- **No repara datos legacy:** un tenant que ya tuviera 0 owners activos antes de 0012 no se corrige automáticamente; solo se bloquean nuevas reducciones de owners.


# 11. Append-only + RLS

Las dos capas se acumulan:

```
RLS              -> solo filas del tenant
GRANT/REVOKE      -> qué comando puede ejecutar el rol
append-only guard -> histórico no se reescribe
audit actor guard -> actor y request_id corresponden al contexto ligado (S1-07)
FK compuesta      -> relaciones no cruzan tenants
RBAC Fastify      -> quién puede ejecutar la acción de negocio
```

Históricos críticos mantienen `REVOKE UPDATE`, `REVOKE DELETE`, `REVOKE TRUNCATE` y trigger defensivo cuando corresponda, además de RLS si son tenant-owned.

**Frontera GUC:** `app.tenant_id`, `app.user_id` y `app.membership_id` son contexto establecido por la aplicación tras validar la identidad/membership, no prueba criptográfica de identidad. El modelo presupone credenciales runtime PostgreSQL no comprometidas. Una sesión runtime comprometida capaz de fijar GUC arbitrarios puede operar bajo otro tenant/actor; RLS y el guard de auditoría no la protegen. El guard limita divergencias entre los valores que escribe la aplicación y el contexto que ella ligó; no verifica por sí mismo que `app.membership_id` corresponda a `app.user_id`. `app.request_id` es correlación de la API, tampoco autoridad.

**Alcance S1-08 de auditoría:** los flujos soportados no escriben `entity_id` de B en una fila de A ni contaminan la auditoría de B al rechazar una selección cross-tenant. `audit_logs` no tiene una FK polimórfica ni un guard universal que valide la pertenencia de cualquier `entity_id` al tenant frente a SQL raw de una sesión runtime comprometida. Las FKs compuestas sí validan relaciones concretas como `actor_membership_id`.

# 12. Pruebas obligatorias Sprint 0

- [ ]  `tallermecario_api` y `tallermecario_worker` son `NOBYPASSRLS` y no son owner de tablas.
- [ ]  Runtime no puede `SET ROLE` a schema owner/migrator/bootstrap.
- [ ]  Tabla tenant-owned tiene `relrowsecurity=true` y `relforcerowsecurity=true`.
- [ ]  `pg_policies` contiene policy esperada por comando/rol.
- [ ]  Sin `app.tenant_id`, SELECT retorna 0 filas y INSERT/UPDATE fallan.
- [ ]  Tenant A SELECT no observa filas Tenant B.
- [ ]  Tenant A UPDATE/DELETE no afecta Tenant B.
- [ ]  Tenant A INSERT con `tenant_id=B` falla por `WITH CHECK`.
- [ ]  Intentar UPDATE `tenant_id A -> B` falla.
- [ ]  Contexto transaction-local desaparece al COMMIT/ROLLBACK; conexión reutilizada no hereda tenant anterior.
- [ ]  FKs compuestas siguen rechazando relación A -> B incluso con RLS correctamente configurado.
- [ ]  Append-only rechaza UPDATE/DELETE/TRUNCATE del runtime.
- [ ]  Bootstrap auth devuelve solo memberships del usuario verificado.
- [ ]  Resolver token público por hash inexistente no filtra existencia/tenant.
- [ ]  Resolver WhatsApp `phone_number_id` A no retorna Tenant B.
- [ ]  Worker reclama job global y luego solo opera el tenant del job bajo RLS.
- [ ]  Funciones SECURITY DEFINER no son ejecutables por PUBLIC y usan search_path seguro.
- [ ]  Runtime no puede ALTER/DISABLE RLS ni CREATE POLICY.

# 13. FAIL crítico

FAIL inmediato del Gate si:

- runtime puede leer/escribir otra tenant mediante SQL normal;
- `tenant_id` puede cambiar A -> B;
- contexto de una conexión pooled se filtra al siguiente request;
- runtime tiene `BYPASSRLS` o ownership accidental;
- una función bootstrap permite enumerar datos cross-tenant;
- un histórico crítico puede modificarse/borrarse/truncarse.

# 14. Nota de implementación

Cuando se levante el Documentation Freeze, las policies se generarán mediante migraciones versionadas y se validarán con pruebas de integración ejecutadas **directamente contra PostgreSQL**, no solo a través de la API.

**DEPLOYMENT_SECURITY_DELTA (registrado en el cierre de S1-03, 2026-09-23):** en el entorno local de desarrollo la API/worker pueden abrir la conexión con un `session_user` administrativo y luego `SET ROLE tallermecario_api` / `tallermecario_worker` (el pool aplica `connection.role`). RLS se evalúa sobre el rol efectivo, por lo que no afectó a S1-03, pero un `session_user` privilegiado podría `RESET ROLE`. **Producción/staging deben conectarse directamente con un login runtime restringido** (`tallermecario_api` / `tallermecario_worker`, `NOBYPASSRLS`, no owner, sin membresía en roles privilegiados), conforme a §2. Pendiente de deployment; no forma parte del alcance de S1-03.

# 15. Referencias oficiales

- PostgreSQL 18 — Row Security Policies.
- PostgreSQL 18 — CREATE ROLE / `BYPASSRLS`.
- PostgreSQL 18 — `current_setting` / `set_config`.
- PostgreSQL 18 — Function Security / `search_path`.
- PostgreSQL 18 — `pg_policies`.
