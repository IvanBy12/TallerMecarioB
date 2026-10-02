# Contrato API — `GET /api/v1/me` y `GET /api/v1/me/context` (Track A, v1)

- **Estado:** CONGELADO (backend). Contrato canónico de Track A que desbloquea G5 del frontend (TA-01, TA-02, TA-03).
- **Fecha:** 2026-10-01. Rama `fix/s3-me-context-route` (base `main` 79a9a43; implementación `22d9d12`).
- **Implementación:** `src/api/me.ts` (`/me`), `src/api/me-context.ts` (`/me/context`), registro de ambos dentro de `buildApi` (`src/api/app.ts`), pipeline de tenant `src/api/tenant-request.ts`, selección `src/tenancy/tenant-selection.ts`, contexto `src/tenancy/tenant-context.ts`, grants `src/authz/{authorize,permission-grants}.ts`.
- **Pruebas:** `tests/api/tenant-context-integration.test.cjs` (`describe('GET /api/v1/me')` y `describe('GET /api/v1/me/context')`, PostgreSQL real, CI `test:tenant-context:api:ci`) y `tests/api/me-context-permissions.test.cjs` (serialización pura, `npm test`).
- **Fuentes canónicas:** Arquitectura Técnica v1 §13 (convenciones, envelope de error); ADR-006 (Clerk = solo identidad); ADR-009 §3/§7 (TenantContext, bootstrap con identificadores mínimos); RBAC — Matriz v1 §1/§18 (unión de roles activos, tenant domina); decisiones cerradas de S1-02 (selección por `X-Tenant-Id`).

Si el código diverge de este documento, es un bug del backend. Ningún campo, código o comportamiento que no aparezca aquí forma parte del contrato.

---

## 1. Resumen y autoridad

| Pregunta del frontend | Endpoint | Alcance |
| --- | --- | --- |
| ¿Quién soy y en qué talleres tengo membership activa? | `GET /api/v1/me` | Identidad (sin tenant) |
| ¿Qué hace el backend si no envío `X-Tenant-Id` (0/1/N)? | `GET /api/v1/me` → `tenantSelection` | Identidad |
| Nombre visible, zona horaria y moneda de UN taller | `GET /api/v1/me/context` | Tenant |
| Roles y permisos efectivos en UN taller | `GET /api/v1/me/context` | Tenant |

- `/me` es el endpoint de identidad/bootstrap. `/me/context` es el contexto autoritativo de UN tenant seleccionado. `/me/context` **no** reemplaza a `/me`; ambos coexisten.
- **No existe estado de "taller seleccionado" en el servidor.** El cliente envía `X-Tenant-Id` en cada request tenant; ese valor sólo es autoritativo después de que el pipeline del backend lo valida (membership activa del usuario verificado, revalidada dentro de la transacción del request).
- Clerk sólo prueba identidad (ADR-006). Ningún tenant, rol, permiso ni scope se lee de claims, metadata, cookies, path, query ni body.

## 2. Convenciones comunes

- **Autenticación:** `Authorization: Bearer <token de sesión Clerk>`. Falta, formato inválido o token no verificable → `401 AUTHENTICATION_REQUIRED`.
- **Método:** sólo `GET`. Sin body, sin query parameters, sin paginación.
- **Cache:** toda respuesta `200` lleva `Cache-Control: no-store`. El cliente no debe persistir estas respuestas como fuente de autorización.
- **Envelope de error** (único, Arquitectura §13):

  ```json
  { "error": { "code": "<CODE>", "message": "<texto>", "request_id": "<uuid v7>" } }
  ```

  Clasificar por `status` + `code`, nunca por `message`. `request_id` sirve para soporte/correlación.
- **429:** `RATE_LIMIT_EXCEEDED` con header HTTP `Retry-After` (segundos). El límite se aplica antes de autenticar (Security Baseline §10); su valor numérico no es parte del contrato. Nota: hoy CORS no expone `Retry-After` al JavaScript del navegador (ver §11).
- **5xx:** envelope genérico con `code: "INTERNAL_ERROR"` y mensaje genérico; nunca detalles internos.
- **UUIDs** en respuestas: forma canónica en minúsculas, 36 caracteres.

---

## 3. `GET /api/v1/me`

Endpoint identity-only: autentica y aplica rate limit, pero **no** resuelve membership, no crea TenantContext, no abre transacción tenant, no consulta el perfil del proveedor, no devuelve roles/permisos ni datos del taller, y nunca crea usuarios ni memberships.

### 3.1 Request

```
GET /api/v1/me
Authorization: Bearer <token>
```

`X-Tenant-Id` **no tiene semántica** en `/me`: se ignora y no selecciona tenant. Sin body, sin query, sin paginación.

### 3.2 Respuesta 200

```json
{
  "user": { "id": "<uuid>" } | null,
  "memberships": [
    { "membershipId": "<uuid>", "tenantId": "<uuid>" }
  ],
  "tenantSelection": {
    "mode": "unavailable" | "automatic" | "required",
    "tenantId": "<uuid>" | null
  }
}
```

| Campo | Semántica |
| --- | --- |
| `user` | `{ id }` = `users.id` del propio usuario cuando existe un usuario ACTIVO con al menos una membership ACTIVA; si no, `null`. `null` no distingue "sin usuario local", "usuario activo sin memberships" ni "usuario deshabilitado" (ADR-009 §7, sin oracle). |
| `memberships` | Memberships ACTIVAS del propio usuario, una por taller, ordenadas por `tenantId` y luego `membershipId`. Sólo identificadores: **sin nombre de taller** (ADR-009 §7). Es un snapshot, no prueba de autorización. |
| `tenantSelection` | Qué hará una ruta tenant **sin** `X-Tenant-Id`. |

| Memberships activas | `tenantSelection` | Ruta tenant sin header |
| --- | --- | --- |
| 0 | `{ "mode": "unavailable", "tenantId": null }` (y `user: null`, `memberships: []`) | `403 ACTIVE_MEMBERSHIP_REQUIRED` |
| 1 | `{ "mode": "automatic", "tenantId": "<esa tenantId>" }` | usa esa membership |
| N ≥ 2 | `{ "mode": "required", "tenantId": null }` | `409 TENANT_SELECTION_REQUIRED` |

Header: `Cache-Control: no-store`.

### 3.3 Errores de `/me`

| Status | `code` | Cuándo |
| --- | --- | --- |
| 401 | `AUTHENTICATION_REQUIRED` | Sin token, token inválido o no verificable. |
| 429 | `RATE_LIMIT_EXCEEDED` | Límite excedido (`Retry-After`). |
| 5xx | `INTERNAL_ERROR` | Fallo interno. |

`/me` nunca responde `400 TENANT_SELECTION_INVALID`, `403 ACTIVE_MEMBERSHIP_REQUIRED`, `403 TENANT_ACCESS_DENIED`, `403 PERMISSION_DENIED` ni `409 TENANT_SELECTION_REQUIRED`: esos estados se expresan en `tenantSelection`.

---

## 4. `GET /api/v1/me/context`

Ruta tenant normal: mismo pipeline que cualquier otra ruta tenant (identidad → memberships → `X-Tenant-Id` → una transacción → revalidación de la membership → GUCs `app.*` → filas RBAC bajo RLS → TenantContext → guard de permiso → handler → COMMIT).

### 4.1 Request

```
GET /api/v1/me/context
Authorization: Bearer <token>
X-Tenant-Id: <uuid de workshops.id>   (opcional según 0/1/N)
```

- **Permiso requerido:** `workshop.read`, scope de ruta **tenant**. En RBAC v1 lo tienen con scope `tenant` los cuatro roles base (owner, admin, service_advisor, technician). Una membership activa sin ningún rol, o cuyos roles no conceden `workshop.read`, recibe `403 PERMISSION_DENIED`.
- Sin body, sin query, sin paginación.

### 4.2 Semántica de `X-Tenant-Id` (decisión cerrada S1-02)

- Valor: UUID RFC 9562 con guiones (36 caracteres), sin distinguir mayúsculas/minúsculas; el servidor lo canonicaliza a minúsculas. UUID nil y max se rechazan.
- **Sin trim:** espacios alrededor, cadena vacía o sólo espacios → `400 TENANT_SELECTION_INVALID`.
- **Un único valor:** header repetido o lista separada por comas → `400 TENANT_SELECTION_INVALID`.
- **Selección explícita nunca hace fallback:** un tenant sin membership activa del usuario (ajeno, inexistente, membership suspendida/revocada, usuario deshabilitado) → `403 TENANT_ACCESS_DENIED`, sin indicar el motivo y sin caer a otra membership.
- **Sin header:** 0 memberships → `403 ACTIVE_MEMBERSHIP_REQUIRED`; 1 → selección automática; N → `409 TENANT_SELECTION_REQUIRED`.
- Para el selector (§7) el frontend **siempre** envía `X-Tenant-Id` explícito, incluso con una sola membership.

### 4.3 Respuesta 200

```json
{
  "context": {
    "tenantId": "<uuid>",
    "membershipId": "<uuid>",
    "userId": "<uuid>",
    "workshop": {
      "displayName": "<string>",
      "timezone": "<string>",
      "currency": "<string>"
    },
    "roles": ["owner" | "admin" | "service_advisor" | "technician"],
    "permissions": [
      {
        "code": "<permission-code>",
        "scopes": ["tenant"] | ["assigned"] | ["quality_control"] | ["assigned", "quality_control"]
      }
    ]
  }
}
```

- **Todos los campos son obligatorios.** Ningún otro campo forma parte del contrato; el serializador de respuesta descarta cualquier propiedad no listada (`additionalProperties: false` en todos los niveles).
- Header: `Cache-Control: no-store`.

| Campo | Origen | Semántica |
| --- | --- | --- |
| `tenantId` | Membership validada | `workshops.id` del tenant seleccionado y validado. |
| `membershipId` | Membership validada | `memberships.id` del usuario en ese tenant. |
| `userId` | Membership validada | `users.id` del propio usuario (el mismo valor que `/me` `user.id`). |
| `workshop.displayName` | `workshops.display_name` | Nombre visible del taller (≤160). |
| `workshop.timezone` | `workshops.timezone` | Zona IANA, p. ej. `America/Bogota`. |
| `workshop.currency` | `workshops.currency` | ISO 4217, p. ej. `COP`. |
| `roles` | `membership_roles` (RLS) | §5. |
| `permissions` | `role_permissions` de los roles activos (RLS) | §6. |

La lectura del taller corre dentro de la transacción del request; RLS (`workshops.id = app.current_tenant_id()`) es el límite. Nunca se devuelve otro taller. Si la fila no fuera visible (imposible por FK membership → workshop), la respuesta es `500 INTERNAL_ERROR`, sin fallback.

### 4.4 Lo que el cliente NUNCA envía

El cliente no suministra `roles`, `permissions`, `scopes`, `membershipId`, `userId` ni campos del taller, ni en este endpoint ni como autoridad en ningún otro. `membershipId`/`userId` devueltos son informativos para la UI; no son credenciales.

---

## 5. Roles

- **Informativos.** El frontend **no debe** autorizar operaciones por nombre de rol; puede usarlos sólo para presentación (etiquetas, onboarding de UI).
- La autorización la decide el backend en **cada** request a partir de los permisos efectivos de la membership revalidada.
- Sólo aparecen los roles efectivamente asignados a la membership actual (sin duplicados). Lista vacía es posible en datos, pero esa membership no tiene `workshop.read` y recibe `403 PERMISSION_DENIED` antes de llegar al handler.
- **Orden canónico `ROLE_CODES`:** `owner`, `admin`, `service_advisor`, `technician`. **No** es orden alfabético ni el orden de filas de la DB. Ejemplo: owner + admin → `["owner", "admin"]`.

## 6. Permisos efectivos y scopes

- Son los grants efectivos de la membership validada: unión de las filas `role_permissions` de sus roles activos, leídas de PostgreSQL en ese mismo request. **No** se derivan de Clerk, **no** los envía el cliente y el endpoint **no** los reconstruye desde la matriz RBAC estática.
- Sólo aparecen permisos realmente concedidos; un permiso sin ningún scope no se emite.
- **Orden:** por `code`, comparación por code point (independiente de locale). Sin duplicados.
- **`tenant` domina** sobre los scopes restringidos:

  | Scopes concedidos por los roles activos | `scopes` emitido |
  | --- | --- |
  | tenant (con o sin assigned / quality_control) | `["tenant"]` |
  | sólo assigned | `["assigned"]` |
  | sólo quality_control | `["quality_control"]` |
  | assigned + quality_control | `["assigned", "quality_control"]` (exactamente en ese orden) |

- Un scope restringido **no** equivale a tenant: indica que el backend exige además el check del recurso (asignación técnica / control de calidad). El frontend puede usarlo para mostrar u ocultar acciones, nunca como prueba de acceso.

## 7. Selector multi-taller (Opción A — decisión MVP Sprint 3)

`/me` devuelve sólo identificadores; el nombre visible de cada taller se obtiene con `/me/context`. El frontend **no debe** mostrar UUIDs crudos como etiqueta normal de un taller.

### 7.1 Algoritmo

1. `GET /api/v1/me`.
2. Según `memberships.length`:
   - **0** → estado `no_access` (sin taller utilizable). No llamar a `/me/context`.
   - **1** → `GET /api/v1/me/context` una vez con `X-Tenant-Id: memberships[0].tenantId` explícito.
   - **N** → `GET /api/v1/me/context` **una vez por membership**, en paralelo, cada request con su propio `X-Tenant-Id: memberships[i].tenantId` explícito.
3. Interpretación de cada respuesta de `/me/context`:

   | Respuesta | Acción del frontend |
   | --- | --- |
   | `200` | Entrada utilizable del selector; etiqueta = `context.workshop.displayName`. |
   | `403 PERMISSION_DENIED` | Esa membership **no** es un contexto de taller utilizable y **no debe** presentarse como seleccionable. |
   | `403 TENANT_ACCESS_DENIED` | Evidencia de bootstrap obsoleto (membership revocada/suspendida entre llamadas): volver a pedir `GET /api/v1/me` y recalcular. |
   | `401` / `429` / `5xx` | Manejo normal de sesión/transporte/reintento. **No** descartar la membership en silencio como si fuera denegación de permiso. |

4. Con el taller elegido, toda request tenant posterior lleva ese `X-Tenant-Id`. Estas lecturas no cambian ninguna selección global del backend (no existe).

### 7.2 Decisión y alcance

- Decisión de producto para el MVP de Sprint 3: el bootstrap multi-taller hace intencionalmente **N lecturas de contexto tenant** (N = memberships activas). Se acepta para el MVP; cada lectura cuenta para el rate limit.
- Podrá reemplazarse más adelante por un contrato agregado de bootstrap **sin cambiar el modelo de autoridad**: tenant validado server-side por request, roles informativos, permisos efectivos desde PostgreSQL.
- Una membership activa sin `workshop.read` no puede nombrarse con este contrato (su `/me/context` es `403 PERMISSION_DENIED`); por eso no se muestra.

## 8. Errores de `/me/context`

| Status | `code` | Cuándo |
| --- | --- | --- |
| 401 | `AUTHENTICATION_REQUIRED` | Sin token, token inválido o no verificable. |
| 400 | `TENANT_SELECTION_INVALID` | `X-Tenant-Id` malformado, vacío, con espacios, repetido o lista. |
| 403 | `ACTIVE_MEMBERSHIP_REQUIRED` | Sin header y 0 memberships activas. |
| 403 | `TENANT_ACCESS_DENIED` | Header con tenant sin membership activa del usuario (cualquier motivo; no se enumera), o membership invalidada entre el descubrimiento y la revalidación. |
| 403 | `PERMISSION_DENIED` | Membership activa sin `workshop.read` (sin roles o roles sin ese grant). |
| 409 | `TENANT_SELECTION_REQUIRED` | Sin header y ≥2 memberships activas. |
| 429 | `RATE_LIMIT_EXCEEDED` | Límite excedido (`Retry-After`). |
| 5xx | `INTERNAL_ERROR` | Fallo interno (mensaje genérico). |

`TENANT_ACCESS_DENIED` es idéntico para tenant inexistente, ajeno, membership suspendida/revocada y usuario deshabilitado (sin oracle de enumeración).

## 9. Minimización de datos

`/me/context` expone intencionalmente sólo: `tenantId`, `membershipId`, `userId`, `displayName`, `timezone`, `currency`, códigos de rol y permisos/scopes efectivos.

**No** expone: `legal_name`, `tax_id`, `slug`, `phone`, `email`, direcciones, `status` del taller, suscripción, billing/pagos ni timestamps (`created_at`/`updated_at`). La consulta SQL selecciona sólo `display_name`, `timezone` y `currency`.

El log de finalización del request contiene sólo los identificadores validados (`tenant_id`, `user_id`, `membership_id`, `request_id`); nunca nombre del taller, roles, permisos ni email.

## 10. DOC_GAP — WORKSHOP_ACCESS_STATUS_POLICY

- La validación de acceso tenant actual exige **usuario activo + membership activa** (`app.bootstrap_list_active_memberships` / `app.bootstrap_validate_active_membership`). **No** evalúa `workshops.status`.
- Ninguna fuente canónica define hoy si `workshops.status` = `trialing` / `active` / `suspended` / `cancelled` cambia la elegibilidad de acceso al tenant ("Estados y Transiciones por Dominio v1" cubre `subscriptions`, no `workshops`).
- Por lo tanto `/me/context` **no** inventa una regla de acceso por `workshops.status` y no expone ese campo.
- Si más adelante se aprueba una política, se aplica en el pipeline **central** de descubrimiento/revalidación de tenant, para que todas las rutas tenant (y `/me`) se comporten igual; no en `/me/context`.

## 11. Fuera de este contrato / pendientes

- **TA-07 (CORS):** la configuración actual refleja `Access-Control-Request-Headers`, así que un preflight con `Authorization` + `X-Tenant-Id` desde un origen permitido pasa; pero **no** se expone `Retry-After` al navegador. Este contrato **no** cierra TA-07.
- `workshops.status` como política de acceso: §10.
- Contrato agregado de bootstrap que sustituya el fan-out de §7: futuro, no planificado.
- Sync de este contrato a Notion (Arquitectura Técnica v1 §13): pendiente.

## 12. Bloqueos de frontend que resuelve

| Ítem | Estado tras este contrato |
| --- | --- |
| TA-01 | `GET /me` y semántica del selector `X-Tenant-Id` congeladas (§3, §4.2). |
| TA-02 | Contexto tenant autoritativo + permisos efectivos congelados (§4–§6, §8). |
| TA-03 | Estrategia de nombre visible multi-taller congelada (Opción A, §7). |

Este contrato está destinado a desbloquear G5.
