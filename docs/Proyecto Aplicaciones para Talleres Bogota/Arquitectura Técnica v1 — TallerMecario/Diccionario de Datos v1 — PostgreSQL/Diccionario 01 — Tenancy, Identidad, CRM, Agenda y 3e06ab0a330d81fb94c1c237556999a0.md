# Diccionario 01 — Tenancy, Identidad, CRM, Agenda y Recepción

# Diccionario 01 — Tenancy, Identidad, CRM, Agenda y Recepción

**Padre:** [Diccionario de Datos v1 — PostgreSQL](../Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL%203e06ab0a330d815fbb32e6200f8d5417.md)

<aside>
ℹ️

Formato: `columna | tipo | null/default | constraints/FK | notas`. Los defaults de tiempo se aplican server/DB según migración; `now()` se expresa como baseline.

</aside>

# 1. workshops

```
id | uuid | NOT NULL | PK | tenant identity
slug | varchar(80) | NOT NULL | UNIQUE | lowercase/normalizado server-side
legal_name | varchar(200) | NOT NULL | - | razón/nombre legal
display_name | varchar(160) | NOT NULL | - | nombre visible
tax_id | varchar(40) | NULL | - | NIT/u otro identificador
phone | varchar(32) | NULL | - | formato normalizado
email | varchar(320) | NULL | - | contacto
timezone | varchar(64) | NOT NULL DEFAULT America/Bogota | - | IANA TZ
currency | char(3) | NOT NULL DEFAULT COP | CHECK uppercase 3 chars | moneda operativa
status | varchar(16) | NOT NULL DEFAULT trialing | CHECK trialing|active|suspended|cancelled | server-owned
created_at | timestamptz | NOT NULL DEFAULT now() | - | immutable
updated_at | timestamptz | NOT NULL DEFAULT now() | - | mutable entity timestamp
```

Reglas: `workshops.id` es el `tenant_id`. RLS especial compara `id=current_tenant_id()`. Se permiten múltiples memberships con rol owner; no existe “primary owner” en MVP. Nunca se permite dejar un taller activo sin al menos un owner activo.

# 2. workshop_locations

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | FK workshops(id), UNIQUE(tenant_id,id) |
name | varchar(160) | NOT NULL | - |
address_line | text | NOT NULL | - |
city | varchar(120) | NOT NULL | - |
department | varchar(120) | NOT NULL | - |
country_code | char(2) | NOT NULL DEFAULT CO | - | ISO-3166-1 alpha-2
phone | varchar(32) | NULL | - |
is_primary | boolean | NOT NULL DEFAULT false | partial UNIQUE tenant WHERE true | máximo una principal
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Índices: `(tenant_id)`, partial unique `(tenant_id) WHERE is_primary=true`.

**Invariante de ubicación principal:** todo workshop debe conservar exactamente una `workshop_location` principal. El partial unique evita dos principales; un constraint trigger diferido al COMMIT, disparado por creación/cambios relevantes de `workshops` y por INSERT/UPDATE/DELETE de `workshop_locations`, valida que el conteo de filas `is_primary=true` sea exactamente 1. `createWorkshop` debe crear workshop + ubicación principal dentro de la misma transacción de onboarding. Cambiar la principal requiere demover la anterior y promover la nueva en una sola transacción. Eliminar la principal sin reemplazo en esa misma transacción debe fallar.

# 3. users

```
id | uuid | NOT NULL | PK | global, sin tenant_id
identity_provider | varchar(32) | NOT NULL DEFAULT clerk | - | adapter identity
external_subject | varchar(255) | NOT NULL | UNIQUE(identity_provider,external_subject) | Clerk user id
email | varchar(320) | NOT NULL | - | email verificado/canónico disponible
full_name | varchar(200) | NULL | - |
status | varchar(16) | NOT NULL DEFAULT active | CHECK active|disabled | server-owned
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Runtime no navega `users` globalmente; bootstrap/JIT usa funciones allowlisted.

Un `user.deleted` del proveedor **nunca** borra la fila: la deja `disabled` (tombstone en `identity_sync_states`). Un usuario `disabled` no resuelve memberships activas ni obtiene acceso (ADR-006 §19).

# 3.1 identity_sync_states

Estado técnico **global** de sincronización de lifecycle por identidad externa (S1-03; ADR-006 §19, ADR-009 §2). No guarda perfil ni payload del proveedor. Migración: `0007_s1_03_clerk_identity_lifecycle`.

```
id | uuid | NOT NULL | PK | UUIDv7 generado por la aplicación
identity_provider | varchar(32) | NOT NULL | UNIQUE(identity_provider,external_subject), CHECK IN (clerk) | provider
external_subject | varchar(255) | NOT NULL | UNIQUE(identity_provider,external_subject) | Clerk user id (subject)
user_id | uuid | NULL | FK users(id) ON DELETE NO ACTION; índice identity_sync_states_user_idx | NULL si nunca existió users local (tombstone previo a created, email no verificado)
lifecycle_state | varchar(16) | NOT NULL DEFAULT active | CHECK active|blocked|deleted | derivado server-side
last_event_id | varchar(128) | NOT NULL | - | provider_event_id (svix-id) del último evento aplicado
last_event_type | varchar(64) | NOT NULL | - | user.created|user.updated|user.deleted (+ tipos defensivos)
last_event_occurred_at | timestamptz | NOT NULL | - | `timestamp` del envelope Clerk: clave de orden de negocio
last_event_rank | smallint | NOT NULL | CHECK IN (0,1) | 1 = user.deleted; 0 = resto (desempate a igual timestamp)
deleted_at | timestamptz | NULL | CHECK (lifecycle_state='deleted') = (deleted_at IS NOT NULL) | tombstone
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

- Constraints: `identity_sync_states_identity_key` UNIQUE(identity_provider, external_subject); `identity_sync_states_provider_check`; `identity_sync_states_lifecycle_check`; `identity_sync_states_rank_check`; `identity_sync_states_tombstone_check`; FK `identity_sync_states_user_id_users_id_fk`.
- Orden monotónico: un evento se aplica solo si `(occurred_at, rank, provider_event_id COLLATE "C")` es estrictamente mayor que la posición almacenada; en caso contrario es `duplicate`/`stale` y no produce efectos.
- Tombstone terminal: con `lifecycle_state='deleted'` todo evento posterior —incluido un `user.created`/`user.updated` reentregado fuera de orden— es `tombstoned`: no crea ni reactiva `users`.
- `blocked` es durable localmente: unban/unlock nunca lo levantan desde el webhook.
- Sin RLS tenant (tabla global sin `tenant_id`). `REVOKE ALL` para `PUBLIC`, `tallermecario_api`, `tallermecario_worker` y `tallermecario_bootstrap_resolver`. Solo `tallermecario_identity_sync` recibe `SELECT, INSERT, UPDATE`, ejercido exclusivamente por funciones `SECURITY DEFINER` allowlisted. Sin `DELETE` para nadie en runtime.

# 4. memberships

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | FK workshops(id), UNIQUE(tenant_id,id) |
user_id | uuid | NOT NULL | FK users(id) |
status | varchar(16) | NOT NULL DEFAULT active | CHECK active|suspended|revoked | server-owned
joined_at | timestamptz | NOT NULL DEFAULT now() | - |
suspended_at | timestamptz | NULL | CHECK coherencia con status |
revoked_at | timestamptz | NULL | CHECK coherencia con status |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Constraints: `UNIQUE(tenant_id,user_id)`; `memberships_status_check`, `memberships_status_coherence_check` y `memberships_lifecycle_state_check` (0016): `active` exige `suspended_at`/`revoked_at` NULL; `suspended` exige `suspended_at` NOT NULL y `revoked_at` NULL; `revoked` exige `revoked_at` NOT NULL. Triggers `memberships_status_transition_trg` y `memberships_timestamp_history_trg` (0016). Cambios de privilegio auditables.

Invariante (S1-05, migraciones `0012`–`0014`): una membership `active` que tiene rol `owner` no puede pasar a `suspended`/`revoked` (ni cambiar id/tenant, ni borrarse) si es la última owner activa del taller → `23514 m_last_active_owner`. No aplica a memberships sin rol owner ni a transiciones desde `suspended`/`revoked`; el guard de owner no define reactivación, y el guard de ciclo de vida 0016 la prohíbe actualmente. `users.status = disabled` no altera `memberships.status` (semántica S1-03). Toda UPDATE/DELETE sobre `memberships` pasa por el lock de owner-set (ADR-009 §10.1). Transiciones (S1-06, Estados y Transiciones › Memberships): `active → suspended` (`suspended_at`),
`active|suspended → revoked` (`revoked_at`, conserva `suspended_at`), solo mediante los comandos
`suspend`/`revoke` del API (§13.3) y el handler S1-03; sin reactivación, sin borrado. Mutabilidad runtime (0015):
solo `status`, `suspended_at`, `revoked_at`, `updated_at`; `id`, `tenant_id`, `user_id`, `joined_at`, `created_at`
inmutables para `tallermecario_api`/`tallermecario_worker`. PostgreSQL impone la máquina de estados (0016): solo
esas tres transiciones (`23514 m_status_transition`; incluye escrituras de `status` al mismo valor), historial de
timestamps (`23514 m_lifecycle_history`) y CHECK `memberships_lifecycle_state_check`:
`active` ⇒ `suspended_at` y `revoked_at` NULL; `suspended` ⇒ `suspended_at` NOT NULL, `revoked_at` NULL;
`revoked` ⇒ `revoked_at` NOT NULL y `suspended_at` se conserva si venía de `suspended` (NULL si venía de `active`). Ninguna reactivación es posible por SQL de runtime; habilitarla exige una decisión
y una migración nueva.

# 5. membership_invitations

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | FK workshops(id), UNIQUE(tenant_id,id) |
email | varchar(320) | NOT NULL | - | original para display
email_normalized | varchar(320) | NOT NULL | - | comparación
target_role_id | uuid | NOT NULL | FK roles(id) | server-owned
token_hash | varchar(128) | NOT NULL | UNIQUE | nunca token crudo
status | varchar(16) | NOT NULL DEFAULT pending | CHECK pending|accepted|expired|revoked |
expires_at | timestamptz | NOT NULL | - | baseline emisión + 7 días
accepted_at | timestamptz | NULL | - |
accepted_by_user_id | uuid | NULL | FK users(id) |
accepted_membership_id | uuid | NULL | composite FK tenant->memberships |
invited_by_membership_id | uuid | NOT NULL | composite FK tenant->memberships |
revoked_at | timestamptz | NULL | - |
revoked_by_membership_id | uuid | NULL | composite FK tenant->memberships |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Índices: `(tenant_id,status,expires_at)`, `(tenant_id,email_normalized)`, partial unique `(tenant_id,email_normalized) WHERE status=pending`. Seguridad siempre comprueba `expires_at`, aunque cleanup aún no materialice `expired`.

**Contrato del token (S1-04).** El token crudo nunca se persiste en ninguna forma (ni reversible):

```
nonce      = 32 bytes del CSPRNG, base64url (43 chars); vive SOLO en outbox_events.payload_json del job de correo
key        = MEMBERSHIP_INVITATION_TOKEN_SECRET (>= 32 bytes; mismo valor en API y worker); key_version en el payload (v1)
token      = base64url(HMAC-SHA256(key, "tallermecario.membership_invitation.token.v1" || 0x00 || invitation_id || 0x00 || nonce))   -- 43 chars
token_hash = hex(SHA-256(token))   -- único valor en membership_invitations
```

El worker re-deriva el mismo token en cada reintento (mismo nonce) y lo verifica contra `token_hash` antes de enviar; una fuga solo de BD da nonce + hash (sin token); el secreto solo no sirve sin el nonce. Aceptación: `SHA-256(token presentado)` → resolución exacta por hash.

CHECKs/trigger (0008–0010): `mi_accepted_coherence_check`, `mi_revoked_coherence_check`, `mi_token_hash_format_check` (`^[0-9a-f]{64}$`), `mi_expiry_after_creation_check`; trigger `app.enforce_membership_invitation_lifecycle` (creación `pending`/no vencida; columnas de identidad inmutables — incluye `email`, `token_hash`, `expires_at`; estados terminales; `expired` solo tras `expires_at`; `accepted` solo antes de `expires_at` y con membership+rol coherentes; **0009**: rechaza `pending → terminal` mientras exista lease de envío vigente, `55006 mi_delivery_in_progress`). Mutabilidad: solo `status`, `accepted_*`, `revoked_*` cambian, y solo mediante los comandos create/revoke/accept del API; el worker solo lee (0010).

# 5.1 membership_invitation_deliveries

Tenant-owned (S1-04 audit fix, 0009). Lease de envío del correo de invitación + resultado del proveedor; una fila por invitación, creada por el worker.

```
tenant_id | uuid | NOT NULL | PK(tenant_id,invitation_id); FK workshops(id) |
invitation_id | uuid | NOT NULL | composite FK (tenant_id,invitation_id) -> membership_invitations(tenant_id,id) |
lease_id | uuid | NULL | - | dueño del lease (un id por intento); server-owned
lease_outbox_event_id | uuid | NULL | sin FK (retención de outbox) | job dueño
lease_attempt | integer | NULL | CHECK > 0 | attempts del job al adquirir
lease_acquired_at | timestamptz | NULL | - |
lease_expires_at | timestamptz | NULL | CHECK > lease_acquired_at | vigente si > now()
lease_count | integer | NOT NULL DEFAULT 0 | CHECK >= 0 | leases adquiridos
sent_at | timestamptz | NULL | CHECK coherencia con provider_message_id | aceptación del proveedor registrada
provider_message_id | varchar(128) | NULL | CHECK length 1..128 | id de Resend (no secreto)
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Constraints: `mid_lease_coherence_check` (los cinco `lease_*` todos NULL o todos NOT NULL), `mid_lease_window_check`, `mid_lease_attempt_check`, `mid_lease_count_check`, `mid_sent_coherence_check`, `mid_provider_message_id_check`. Escritura solo por las funciones SECURITY DEFINER de worker (ADR-009); API: SELECT bajo RLS; worker: sin grant. Sin PII, sin token, sin hash de token.

# 6. roles

```
id | uuid | NOT NULL | PK | global/system
code | varchar(64) | NOT NULL | UNIQUE | owner|admin|service_advisor|technician
name | varchar(120) | NOT NULL | - |
scope | varchar(16) | NOT NULL DEFAULT tenant | CHECK tenant | MVP
is_system | boolean | NOT NULL DEFAULT true | - | custom roles fuera MVP
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

# 7. permissions

```
id | uuid | NOT NULL | PK | global/system
code | varchar(120) | NOT NULL | UNIQUE | permission code canónico
description | text | NOT NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

# 8. role_permissions

```
role_id | uuid | NOT NULL | PK(role_id,permission_id), FK roles(id) |
permission_id | uuid | NOT NULL | PK(role_id,permission_id), FK permissions(id) |
created_at | timestamptz | NOT NULL DEFAULT now() | - | seed/system
```

Global/read-only en runtime.

# 9. membership_roles

```
tenant_id | uuid | NOT NULL | FK workshops(id) |
membership_id | uuid | NOT NULL | PK(tenant_id,membership_id,role_id), composite FK memberships |
role_id | uuid | NOT NULL | PK(...), FK roles(id) |
assigned_by_membership_id | uuid | NOT NULL | composite FK memberships same tenant | actor
assigned_at | timestamptz | NOT NULL DEFAULT now() | - |
```

No UPDATE directo de rol: asignar/remover fila mediante comando autorizado + auditoría. Guard de último owner se evalúa transaccionalmente.

Implementado (S1-05, migraciones `0011`–`0014`): runtime sin UPDATE; DELETE solo API bajo RLS tenant (`tenant_delete`); `assigned_by_membership_id` = actor del TenantContext (FK compuesta mismo tenant), nunca del request; auditoría `role.assigned` / `role.revoked`. Trigger `app.enforce_membership_role_invariants`: `mr_membership_not_active` (INSERT sobre membership no `active`) y `mr_last_active_owner` (remoción de la última fila owner activa). "Guard de último owner se evalúa transaccionalmente" = lock de owner-set (puerta `app.owner_mutation_gate` + fila `workshops`) + chequeo posterior al lock (ADR-009 §10.1).

**Objeto de infraestructura (no de dominio):** `app.owner_mutation_gate` — tabla sin columnas ni filas usada solo como lock global del owner-set (migración `0013`, ADR-009 §10/§10.1). No contiene datos, no es tenant-owned, no aparece en `schema.ts`.

# 10. customers

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | FK workshops(id), UNIQUE(tenant_id,id) |
document_type | varchar(24) | NULL | - |
document_number | varchar(40) | NULL | - | no unique baseline
first_name | varchar(120) | NOT NULL | - |
last_name | varchar(120) | NOT NULL | - |
phone | varchar(32) | NOT NULL | - |
email | varchar(320) | NULL | - |
notes | text | NULL | - | internal/minimize PII
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Índices: `(tenant_id,phone)`, `(tenant_id,document_number)`. **Se elimina `whatsapp_opt_in` como fuente de verdad**: autorización por finalidad/canal vive en `privacy_consents`; no se aceptará un booleano CRM como evidencia jurídica.

**Contrato S2-02 (reglas de API; sin CHECK en DB en Sprint 2):**

- Texto: NFC + trim + rechazo de caracteres de control/bidi; no vacío en columnas NOT NULL.
- `phone`: se guarda normalizado (sin espacios, `-`, `.`, `(` ni `)`) y cumple `^\+?[0-9]{7,15}$`; no se asume indicativo de país.
- `email`: trim + validación de formato; sin lowercase canónico.
- `document_type` y `document_number`: ambos o ninguno. `document_type` es texto 1–24 sin catálogo; `document_number` lleva trim + NFC sin canonicalización.
- Sin unicidad en phone, email ni documento.
- **Sin archivo ni borrado en Sprint 2:** no existe `archived_at` ni estado de archivo; `customers.archive` queda sin endpoint hasta una necesidad de negocio explícita o el flujo DSR/anonimización (antes del piloto).
- Diferido (D-09): catálogo de `document_type`, canonicalización de documento y email, E.164 (reabrir en Sprint 9 o DSR/facturación).

**DOC_GAP-02 — archivo de clientes: DEFERRED (S2-02, D-02).**

- **Motivo:** todavía no existe una necesidad de negocio explícita. Arquitectura §6 y ERD §1/§18 limitan el soft delete a necesidades explícitas. No existe contrato ni permiso de unarchive. Implementarlo ahora obligaría a definir efectos sobre búsqueda, recepción y nuevas relaciones. Archivar no es supresión/anonimización DSR (Protección de Datos §6–§7).
- **Comportamiento interino:** todo customer permanece activo; no existe endpoint de archive ni de delete; `customers.archive` sigue sembrado sin endpoint; en Sprint 2, CRUD = CREATE / READ / UPDATE / LIST-SEARCH.
- **Trigger de reapertura:** necesidad de negocio explícita, flujo DSR/anonimización o necesidad de ocultar clientes operativamente; como máximo antes del piloto (Sprint 15).
- **Impacto futuro esperado:**
  - posible columna `archived_at` o `status`, con migración estructural y actualización de Diccionario + ERD;
  - ampliar la allowlist de `GRANT UPDATE` por columnas de `customers` establecida en 0018;
  - decidir el permiso/comando de unarchive;
  - decidir el comportamiento de listado/búsqueda y si un customer archivado puede participar en nuevas receptions u ownership;
  - tests y Quality Gate correspondientes.

# 11. vehicles

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | FK workshops(id), UNIQUE(tenant_id,id) |
plate | varchar(16) | NOT NULL | UNIQUE(tenant_id,plate) | canónica ^[A-Z0-9]{1,16}$ (ver nota S2-02)
vin | varchar(32) | NULL | - |
vehicle_type | varchar(24) | NOT NULL | CHECK car|motorcycle|other |
brand | varchar(80) | NOT NULL | - |
model | varchar(100) | NOT NULL | - |
model_year | smallint | NULL | CHECK 1886..2200 |
color | varchar(60) | NULL | - |
engine_number | varchar(80) | NULL | - |
current_mileage_km | integer | NULL | CHECK >=0 | snapshot de conveniencia
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

La placa es única por tenant, no global.

**Forma canónica de `plate` (S2-02; D-01a + D-01b):** `plate` cumple `^[A-Z0-9]{1,16}$`. La API normaliza la entrada así: trim → eliminar espacios, `-` y `.` → mayúsculas ASCII → validar. PostgreSQL la protege con dos CHECK:

- `vehicles_plate_normalized_check`: `plate = btrim(plate) AND plate = upper(plate COLLATE "C")` (migración 0018).
- `vehicles_plate_format_check`: backstop de formato `plate COLLATE "C" ~ '^[A-Z0-9]{1,16}$'`, pendiente de incorporarse a S2-03 antes de su merge.

Los formatos por `vehicle_type` están diferidos (D-01c: se reabren con datos del piloto o con placas legítimas rechazadas en Sprint 3). `current_mileage_km` es solo lectura para el cliente en Sprint 2; lo escribe el servidor y Sprint 3 define la regla desde recepción.

# 12. vehicle_owners

```
id | uuid | NOT NULL | PK | historial relación
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
vehicle_id | uuid | NOT NULL | composite FK vehicles |
customer_id | uuid | NOT NULL | composite FK customers |
relationship_type | varchar(24) | NOT NULL DEFAULT owner | CHECK owner|authorized_driver|company_contact|other |
is_primary | boolean | NOT NULL DEFAULT true | - |
valid_from | timestamptz | NOT NULL DEFAULT now() | - |
valid_to | timestamptz | NULL | CHECK > valid_from |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Índices: `(tenant_id,vehicle_id,valid_to)`, `(tenant_id,customer_id)`. Partial unique: máximo un owner principal vigente por vehículo donde `is_primary=true AND valid_to IS NULL`.

**Mutabilidad: Frozen-on-close (S2-02, D-12).** Mientras `valid_to IS NULL`, solo `valid_to` puede pasar de NULL a un timestamp `> valid_from`; los demás campos no cambian en ningún UPDATE. Con `valid_to IS NOT NULL` la fila es inmutable. Lo imponen `vehicle_owners_history_guard_trg` (0018) y el grant de API limitado a `valid_to`.

**Propietario actual:** la fila `is_primary = true AND valid_to IS NULL`. En Sprint 2 la API solo crea filas `relationship_type = owner`, `is_primary = true`. Al cambiar de propietario cierra la vigente e inserta la nueva con el mismo instante del servidor (`clock_timestamp()` tras el lock del vehículo). El servidor fija siempre `valid_from` y `valid_to`.

Diferido (D-11/D-13): relaciones no-owner, primario no-owner, varias vigentes no primarias y solapes, cierre sin sucesor, invariante “todo vehículo tiene propietario” en DB, fecha efectiva del cliente y `valid_to` futuro.

# 13. appointments

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
customer_id | uuid | NOT NULL | composite FK customers |
vehicle_id | uuid | NULL | composite FK vehicles |
location_id | uuid | NULL | composite FK workshop_locations |
scheduled_start | timestamptz | NOT NULL | - |
scheduled_end | timestamptz | NOT NULL | CHECK > start |
reason | text | NOT NULL | - |
status | varchar(16) | NOT NULL DEFAULT scheduled | CHECK scheduled|confirmed|arrived|cancelled|no_show|completed |
source | varchar(24) | NOT NULL DEFAULT staff | CHECK staff|customer|import|other |
created_by_membership_id | uuid | NULL | composite FK memberships | null si origen externo/import
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

Índice `(tenant_id,scheduled_start)`.

# 14. reminders

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
appointment_id | uuid | NULL | composite FK appointments |
customer_id | uuid | NOT NULL | composite FK customers |
channel | varchar(16) | NOT NULL | CHECK whatsapp|email|sms|other |
scheduled_for | timestamptz | NOT NULL | - |
status | varchar(16) | NOT NULL DEFAULT pending | CHECK pending|queued|sent|failed|cancelled |
sent_at | timestamptz | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

# 15. receptions

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,vehicle_id,customer_id) |
vehicle_id | uuid | NOT NULL | composite FK vehicles |
customer_id | uuid | NOT NULL | composite FK customers |
appointment_id | uuid | NULL | composite FK appointments |
location_id | uuid | NULL | composite FK workshop_locations |
received_by_membership_id | uuid | NOT NULL | composite FK memberships |
mileage_km | integer | NOT NULL | CHECK >=0 |
fuel_level_pct | smallint | NULL | CHECK 0..100 |
customer_notes | text | NULL | - |
advisor_notes | text | NULL | - | internal
status | varchar(16) | NOT NULL DEFAULT open | CHECK open|closed|cancelled |
received_at | timestamptz | NOT NULL DEFAULT now() | - |
closed_at | timestamptz | NULL | CHECK coherencia status |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
updated_at | timestamptz | NOT NULL DEFAULT now() | - |
```

`closed|cancelled` exige `closed_at`; `open` exige `closed_at IS NULL`.

# 16. reception_check_items

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
reception_id | uuid | NOT NULL | composite FK receptions |
code | varchar(64) | NOT NULL | UNIQUE(tenant_id,reception_id,code) |
label | varchar(160) | NOT NULL | - | snapshot
status | varchar(24) | NOT NULL | CHECK ok|issue|not_checked|not_applicable |
notes | text | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

# 17. vehicle_damages

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
reception_id | uuid | NOT NULL | composite FK receptions |
zone_code | varchar(64) | NOT NULL | - | esquema UI estable
damage_type | varchar(64) | NOT NULL | - |
severity | varchar(16) | NOT NULL DEFAULT minor | CHECK minor|moderate|severe |
description | text | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

# 18. signatures

```
id | uuid | NOT NULL | PK |
tenant_id | uuid | NOT NULL | UNIQUE(tenant_id,id) |
reception_id | uuid | NULL | composite FK receptions |
delivery_id | uuid | NULL | composite FK deliveries |
signed_by_name | varchar(200) | NOT NULL | - |
signed_by_document | varchar(60) | NULL | - | minimize
signature_media_id | uuid | NOT NULL | composite FK media_assets | media_type=signature guard domain
signed_at | timestamptz | NOT NULL | - |
ip_address | inet | NULL | - |
created_at | timestamptz | NOT NULL DEFAULT now() | - |
```

CHECK XOR: exactamente uno de `reception_id`/`delivery_id` es NOT NULL. Evidencia append-only después de firma.