# Diccionario 04 — Privacidad y Plataforma

# Diccionario 04 — Privacidad y Plataforma

**Padre:** [Diccionario de Datos v1 — PostgreSQL](../Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL%203e06ab0a330d815fbb32e6200f8d5417.md)

<aside>
🛡️

`privacy_consents` es tenant-owned. `data_subject_requests` y `privacy_security_incidents` son **mixed-scope** porque ILVOX también puede actuar como Responsable propio; no reciben una policy RLS ciega `tenant_id=current_tenant`.

</aside>

# 1. privacy_consents

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
customer_id | uuid | NOT NULL | composite FK customers | titular MVP
purpose_code | varchar(80) | NOT NULL | - | finalidad separable
privacy_notice_version | varchar(40) | NOT NULL | - |
authorization_text_version | varchar(40) | NOT NULL | - |
channel | varchar(24) | NOT NULL | CHECK web|in_person|whatsapp|email|phone|import|other |
status | varchar(16) | NOT NULL DEFAULT granted | CHECK granted|revoked |
captured_at | timestamptz | NOT NULL | - |
revoked_at | timestamptz | NULL | required revoked |
evidence_hash | varchar(128) | NULL | - | hash de evidencia cuando aplique
evidence_media_id | uuid | NULL | composite FK media_assets |
ip_address | inet | NULL | - |
user_agent | text | NULL | - |
created_by_membership_id | uuid | NULL | composite FK memberships | null public/import
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - | solo lifecycle grant->revoke
```

Partial unique: máximo un consentimiento `granted` por `(tenant_id,customer_id,purpose_code)`. Revocar exige `revoked_at`. Evidencia/versión exacta permanece; una nueva autorización posterior crea **nueva fila**, no reactiva la antigua.

# 2. data_subject_requests — mixed-scope

```
id | uuid | NOT NULL | PK | global/mixed
controller_scope | varchar(16) | NOT NULL | CHECK tenant|ilvox |
tenant_id | uuid | NULL | FK workshops(id) | required scope=tenant; NULL scope=ilvox
customer_id | uuid | NULL | tenant-safe cuando scope=tenant |
user_id | uuid | NULL | FK users(id) | posible titular ILVOX
subject_reference | varchar(255) | NULL | - | referencia externa mínima si no hay FK
request_type | varchar(16) | NOT NULL | CHECK consult|update|correct|delete|revoke |
status | varchar(24) | NOT NULL DEFAULT received | CHECK received|in_review|awaiting_information|resolved|rejected |
received_at | timestamptz | NOT NULL | - |
due_at | timestamptz | NOT NULL | - | calculado por procedimiento aplicable
resolved_at | timestamptz | NULL | required resolved/rejected |
resolution | text | NULL | - | requerido al cerrar
evidence_reference | text | NULL | - | no secrets
assigned_to_reference | varchar(160) | NULL | - | operativo, NO autoridad; se migrará a plataforma interna futura
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

CHECK: `controller_scope=tenant <=> tenant_id IS NOT NULL`; `ilvox => tenant_id IS NULL`. `customer_id` solo puede usarse en scope tenant y debe pertenecer al mismo tenant; scope ilvox usa `user_id` y/o `subject_reference`. Al menos un identificador de titular/caso debe existir. Acceso mediante servicio/resolver mixed-scope, no policy tenant genérica.

# 3. privacy_security_incidents — mixed-scope

```
id | uuid | NOT NULL | PK |
controller_scope | varchar(16) | NOT NULL | CHECK tenant|ilvox |
tenant_id | uuid | NULL | FK workshops(id) | scope semantics
detected_at | timestamptz | NOT NULL | - |
reported_internally_at | timestamptz | NOT NULL | - |
systems_affected | text[] | NOT NULL | - | categorías/sistemas, no secrets
categories_of_data | text[] | NOT NULL | - |
estimated_records | integer | NULL | CHECK >=0 |
risk_level | varchar(16) | NOT NULL | CHECK low|medium|high|critical |
containment_actions | text | NULL | - |
sic_report_required | boolean | NOT NULL DEFAULT false | - | decisión documentada
sic_reported_at | timestamptz | NULL | - |
status | varchar(20) | NOT NULL DEFAULT open | CHECK open|investigating|contained|resolved|closed |
postmortem_reference | text | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

CHECK scope igual a DSR. Si `sic_reported_at` existe, `sic_report_required=true`. Mixed-scope access control; nunca exposición a tenant por una RLS genérica cuando el incidente es ILVOX-scope.

# 4. legal_acceptances

```
id | uuid | NOT NULL | PK | append-only acceptance evidence
acceptance_scope | varchar(16) | NOT NULL | CHECK global_user|tenant |
tenant_id | uuid | NULL | FK workshops(id) | required tenant scope
accepted_by_user_id | uuid | NOT NULL | FK users(id) |
document_type | varchar(32) | NOT NULL | CHECK terms|privacy_policy|dpa|commercial_terms|other |
document_version | varchar(40) | NOT NULL | - |
document_hash | varchar(128) | NOT NULL | - | exact content hash
accepted_at | timestamptz | NOT NULL | - |
ip_address | inet | NULL | - |
user_agent | text | NULL | - |
channel | varchar(24) | NOT NULL | CHECK web|admin|import|other |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Append-only: no se persiste `superseded` mutable. Estado efectivo **superseded** se deriva si existe una aceptación posterior aplicable del mismo `document_type`; cualquier revocación jurídicamente aplicable se registra como evento/proceso separado, no reescribiendo evidencia. Partial uniques: tenant `(tenant_id,accepted_by_user_id,document_type,document_version)`; global `(accepted_by_user_id,document_type,document_version) WHERE tenant_id IS NULL`.

# 5. webhook_events

```
id | uuid | NOT NULL | PK | original envelope append-only
provider | varchar(32) | NOT NULL | - |
provider_event_id | varchar(128) | NOT NULL | UNIQUE(provider,provider_event_id) | transport identity
tenant_id | uuid | NULL | FK workshops(id) cuando resuelto | puede llegar sin tenant
payload_hash | char(64) | NOT NULL | - | sha256 raw body
payload_json | jsonb | NOT NULL | - | payload original permitido
headers_json | jsonb | NULL | - | allowlist signature/request metadata
received_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Append-only. No status mutable de procesamiento.

# 6. webhook_processing_attempts

```
id | uuid | NOT NULL | PK |
webhook_event_id | uuid | NOT NULL | FK webhook_events(id) |
attempt_number | integer | NOT NULL | UNIQUE(webhook_event_id,attempt_number), CHECK >0 |
status | varchar(24) | NOT NULL | CHECK processing|succeeded|retryable_error|permanent_error |
started_at | timestamptz | NOT NULL | - |
finished_at | timestamptz | NULL | - |
last_error_code | varchar(120) | NULL | - | stable/redacted
last_error_message | text | NULL | - | no secrets/raw provider auth
worker_id | varchar(160) | NULL | - |
request_id | varchar(128) | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Intentos son append-oriented; no se modifica `webhook_events` para retry.

# 7. outbox_events

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NULL | FK workshops(id) | NULL solo evento global explícito
aggregate_type | varchar(80) | NOT NULL | - |
aggregate_id | uuid | NULL | - |
event_type | varchar(120) | NOT NULL | - |
event_version | smallint | NOT NULL DEFAULT 1 | CHECK >0 |
payload_json | jsonb | NOT NULL | - | contrato interno; no raw public token/OTP
idempotency_key | uuid | NULL | partial UNIQUE WHERE NOT NULL | obligatorio efecto externo sensible
status | varchar(24) | NOT NULL DEFAULT pending | CHECK pending|processing|processed|failed|dead_letter |
attempts | integer | NOT NULL DEFAULT 0 | CHECK >=0 |
available_at | timestamptz | NOT NULL DEFAULT now() | - |
processed_at | timestamptz | NULL | - |
last_error | text | NULL | redacted |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - | worker lifecycle
```

Índice worker `(status,available_at)`. Claim global controlado; al procesar evento tenant-owned el worker abre nueva transacción TenantContext bajo RLS.

**S1-08:** el flujo worker compara `outboxEventId` y `tenantId` del claim con la fila durable antes del handler normal o `processPhasedJob`/`prepare`. Un mismatch no cambia status, attempts, delivery ni auditoría; stall/requeue permite reclamar con el tenant correcto y procesar una vez. `app.bootstrap_claim_outbox_events`, `app.worker_get_outbox_event` y `app.worker_complete_outbox_event` son helpers globales por ID, no dependen de `app.tenant_id`; el tenant-binding es del flujo worker soportado. Sin columnas ni constraints nuevos.

# 8. sync_operations

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
operation_id | uuid | NOT NULL | UNIQUE(tenant_id,operation_id) | client idempotency identity
device_id | varchar(160) | NULL | - | no autoridad
membership_id | uuid | NOT NULL | composite FK memberships | actor revalidado online
operation_type | varchar(80) | NOT NULL | - | allowlisted command type
entity_type | varchar(80) | NOT NULL | - |
entity_id | uuid | NULL | - |
base_version | integer | NULL | CHECK >0 | optimistic conflict input
status | varchar(24) | NOT NULL | CHECK queued|syncing|applied|conflict|retryable_error|permanent_error | server result
result_json | jsonb | NULL | - | safe/minimal
client_created_at | timestamptz | NULL | untrusted informational |
received_at | timestamptz | NOT NULL DEFAULT now() | - |
processed_at | timestamptz | NULL | - |
```

El actor canónico es `membership_id`, no un `user_id` suelto. Sync reejecuta RBAC/RLS/guards. `client_created_at` nunca decide ordering/authorization por sí solo.

# 9. audit_logs

```
id | uuid | NOT NULL | PK | append-only
tenant_id | uuid | NULL | FK workshops(id) | null plataforma/global
actor_type | varchar(16) | NOT NULL | CHECK user|system|provider|platform |
actor_user_id | uuid | NULL | FK users(id) |
actor_membership_id | uuid | NULL | composite FK memberships cuando tenant |
action | varchar(120) | NOT NULL | - |
outcome | varchar(16) | NOT NULL | CHECK success|denied|failed |
entity_type | varchar(80) | NOT NULL | - |
entity_id | uuid | NULL | - |
reason_code | varchar(120) | NULL | - |
before_json | jsonb | NULL | allowlisted/minimized |
after_json | jsonb | NULL | allowlisted/minimized |
metadata_json | jsonb | NULL | allowlisted/minimized |
request_id | varchar(128) | NOT NULL | - |
trace_id | varchar(64) | NULL | - |
ip_address | inet | NULL | - |
user_agent | text | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

No secrets, token hashes/OTP/JWT, PAN/CVV ni blobs. Retención producto 24 meses salvo hold/obligación superior; purge solo proceso privilegiado auditado.

**Contrato S1-07 (0017):** API y worker solo tienen `INSERT` por columnas, no `INSERT` general. `user_agent` no es escribible por runtime y siempre queda NULL en filas nuevas; la columna se conserva para historia legacy y futura metadata derivada estructurada. `created_at` no es escribible por runtime: `DEFAULT now()` es el inicio de la transacción y no representa orden de commit. Worker tampoco escribe `ip_address`; API guarda únicamente `request.ip` sin `trustProxy` (peer TCP). JIT no recibe IP ni User-Agent.

Para filas API `actor_type=user`, `actor_user_id`, `actor_membership_id` y `request_id` corresponden a `app.user_id`, `app.membership_id` y `app.request_id`; `audit_logs_actor_guard_trg` rechaza divergencias con `42501 audit_logs_actor_guard`. API `system` y worker `system|provider` no llevan ids de actor; ningún runtime escribe `platform`. `entity_id` es NULL solo para `membership.invited` denegado en el catálogo Sprint 1. RLS `ENABLE + FORCE` aísla filas tenant; globales `identity.*` solo por funciones allowlisted. Los GUC de tenant/usuario/membership son contexto de aplicación, no prueba criptográfica; se presuponen credenciales runtime PostgreSQL no comprometidas (ADR-009 §11).

**Precisión S1-08:** en operaciones soportadas de la aplicación, un recurso B invisible no se escribe como `entity_id` ni metadata de una fila A. `entity_id` no tiene FK universal a todas las entidades y `audit_logs` no prueba por sí mismo su pertenencia al tenant ante SQL raw de una sesión runtime comprometida; las FKs compuestas específicas y la resolución bajo RLS del flujo soportado son las capas pertinentes.

# 10. feature_flags

```
id | uuid | NOT NULL | PK | mixed scope
tenant_id | uuid | NULL | FK workshops(id) | solo tenant scope
plan_id | uuid | NULL | FK plans(id) | solo plan scope
feature_key | varchar(120) | NOT NULL | - |
scope | varchar(16) | NOT NULL | CHECK global|plan|tenant |
enabled | boolean | NOT NULL | - |
value_json | jsonb | NULL | - | REPLACE semantics, no deep merge
enabled_from | timestamptz | NULL | - |
enabled_until | timestamptz | NULL | CHECK > enabled_from cuando ambos |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

CHECK scope: global => tenant/plan NULL; plan => solo plan; tenant => solo tenant. Partial unique por feature/scope. Precedencia `tenant > plan > global > code default`; `enabled=false` específico bloquea fallback. `scheduled/expired` no aplica y permite bajar al siguiente scope. `value_json` de la fila ganadora reemplaza el valor inferior completo; no se fusionan objetos entre scopes.

# 11. Nota RLS

- `privacy_consents`, `sync_operations` y filas tenant de `audit_logs` siguen la cobertura ADR-009.
- `data_subject_requests`, `privacy_security_incidents`, `legal_acceptances`, `feature_flags`, `webhook_events`, `webhook_processing_attempts` y `outbox_events` requieren policy/resolver por mixed/global scope; no una policy tenant genérica.
- El diccionario no otorga `BYPASSRLS` a API/worker.
