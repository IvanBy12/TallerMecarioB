# S2-04 Customers API Decisions

Bitácora del ticket S2-04 (Sprint 2 — Clientes + Vehículos, Customers API). **No reemplaza** a las fuentes canónicas: el contrato vive en Arquitectura §13.4 («Clientes — cierre S2-04»), Diccionario 01 §10 y Operación §5.2 (catálogo CRM).

- Fecha: 2026-09-26.
- Origen: Architecture Handoff de S2-04 (CONTRACT READY: NO; cinco DOC_GAP abiertos). Las cinco decisiones fueron aprobadas por el responsable humano.
- Base: `integration/sprint-2` @ `0766661`. Solo documentación: sin cambios en `src/`, `tests/`, `scripts/`, `drizzle/`, `schema.ts`, RBAC, `package.json` ni CI.
- **Espacio de nombres:** los identificadores `DOC_GAP-01…05` de esta bitácora son los de S2-04. Los `DOC_GAP-01…14` de `docs/S2-02-DOC-CHANGES.md` son otra serie; en particular, el **DOC_GAP-02 de S2-02** (archivo de clientes, Diccionario 01 §10) sigue **DEFERRED** por D-02 y este ticket no lo modifica.

## DOC_GAP-01

- **status:** CLOSED
- **decision:** PATCH no-op. `expectedUpdatedAt` sigue siendo obligatorio y el OCC se valida siempre antes de decidir el no-op:
  1. resolver el customer bajo TenantContext/RLS;
  2. inexistente o de otro tenant → 404 `CUSTOMER_NOT_FOUND`;
  3. comparar `expectedUpdatedAt` conservando microsegundos;
  4. obsoleto → 409 `RESOURCE_VERSION_CONFLICT`, aunque el payload resulte semánticamente idéntico;
  5. normalizar y mezclar el patch;
  6. calcular `changed_fields`.

  Si `changed_fields = []`: 200 con el `CustomerDto` actual; sin UPDATE; sin modificar `updated_at`; sin `customer.updated` ni fila en `audit_logs`. Evita escrituras falsas, avances artificiales del token OCC y auditorías sin cambio real, sin permitir bypass del OCC.
- **fuentes:** Arquitectura §13.4 «PATCH no-op»; Operación §5.2 (regla de no auditar el no-op).

## DOC_GAP-02

- **status:** CLOSED
- **decision:** null y strings vacíos.
  - `firstName`, `lastName`, `phone`: no aceptan `null`, `""` ni un valor que quede vacío tras normalizar → 400 `REQUEST_VALIDATION_FAILED`.
  - `email`, `documentType`, `documentNumber`, `notes`: aceptan `null` en POST (donde son opcionales) y en PATCH (`null` = limpiar explícitamente el campo).
  - En esos cuatro campos, un valor que tras su normalización queda `""` (p. ej. `""` o solo espacios exteriores) se canonicaliza a `null`. Nunca se almacenan strings vacíos.
  - Par de documento: `documentType`/`documentNumber` terminan ambos `null` o ambos con valor válido, nunca solo uno. En PATCH se evalúa sobre el estado resultante tras mezclar con la fila existente.
  - Ejemplos: ambos `null` → válido; `documentType = "CC"` + `documentNumber = ""` → `documentNumber = null` → estado roto → 400 `REQUEST_VALIDATION_FAILED`; `notes = "   "` → `null`; `email = ""` → `null`.
- **fuentes:** Arquitectura §13.4 («Requests» y «Obligatorios y anulables» / «Par de documento»); Diccionario 01 §10.

## DOC_GAP-03

- **status:** CLOSED
- **decision:** notes 2000 + bodyLimit 16 KiB.
  - `notes`: máximo 2000 Unicode code points **después** de normalizar; excederlo → 400 `REQUEST_VALIDATION_FAILED`. La columna PostgreSQL sigue siendo `text` (sin migración).
  - `POST /api/v1/customers` y `PATCH /api/v1/customers/:customerId`: `bodyLimit = 16384` bytes (16 KiB); excederlo → 413 `PAYLOAD_TOO_LARGE` (mapper existente de `src/api/app.ts`).
- **fuentes:** Arquitectura §13.4 («`notes`» y «Tamaño del body»); Diccionario 01 §10.

## DOC_GAP-04

- **status:** CLOSED
- **decision:** multiline notes. `notes` es texto libre y puede contener saltos de línea. Normalización específica:
  1. validar Unicode bien formado;
  2. NFC;
  3. CRLF → LF;
  4. CR → LF;
  5. trim exterior;
  6. si queda vacío → `null`;
  7. se permite LF (U+000A) interno;
  8. no se colapsan espacios internos;
  9. no se colapsan líneas múltiples;
  10. no se eliminan saltos de línea internos.

  Se rechazan TAB (U+0009), los demás caracteres de control C0/C1 y los de control bidi. Máximo 2000 code points tras normalizar. La excepción de LF **no** aplica a `firstName`, `lastName`, `email`, `documentType`, `documentNumber`, `phone` ni al filtro `name`, que siguen la regla general de rechazo de caracteres de control.
- **fuentes:** Arquitectura §13.4 (regla de texto + «`notes`»); Diccionario 01 §10.

## DOC_GAP-05

- **status:** CLOSED
- **decision:** audit snake_case.
  - `customer.created` → metadata `{ fields: [...] }`; `customer.updated` → metadata `{ changed_fields: [...] }`.
  - Valores permitidos (nombres de columna persistida): `first_name`, `last_name`, `phone`, `email`, `document_type`, `document_number`, `notes`.
  - Lista determinista y sin duplicados, siempre en el orden anterior (nunca el orden accidental del body / `Object.keys`).
  - Nunca `expectedUpdatedAt` / `expected_updated_at` (control OCC, no dato del customer), `tenant_id`, `created_at` ni `updated_at`. Nunca valores PII.
- **fuentes:** Operación §5.2 «Catálogo CRM de Sprint 2»; Arquitectura §13.4 («Auditoría»).

## Otras constancias

- **Filtro de nombre:** `name` es el **único** filtro de nombre (`GET /api/v1/customers?name=...`): prefijo sobre `first_name` OR `last_name`, sin distinguir mayúsculas y distinguiendo acentos. Filtros aprobados: `phone`, `documentNumber`, `name`, combinados con AND. **No existen** query params `firstName` ni `lastName`, ni `q` ni búsqueda por email. El ticket original del handoff proponía `firstName`/`lastName`; fue corregido por `/docs` (Arquitectura §13.4, D-07 de S2-02, Operación §6.3) y gana el contrato canónico.
- **Requisito verificable de collation (sin fijar collation en la documentación):** `ÁLVARO` y `álvaro` deben coincidir; `alvaro` no debe coincidir con `Álvaro`. La implementación debe demostrarlo en PostgreSQL 18; una comparación sin case-folding Unicode (p. ej. collation `"C"`) no cumple. La expresión concreta pertenece a la implementación + tests.
- **Sin schema migration:** `customers` y los grants de 0018 soportan el contrato; `notes` sigue `text`; no hay 0019.
- **Sin cambio de RBAC:** `customers.read/create/update` (owner, admin, service_advisor); technician sin acceso; `customers.archive` sembrado sin endpoint.
- **Sin archive:** sin DELETE, archive, unarchive ni `archived_at` (D-02 de S2-02, DEFERRED).
- **Sin idempotency:** sin `Idempotency-Key` CRM (D-22); UUIDv7 generado por el servidor.
- **CI wiring diferido a S2-08 (planificación, no DOC_GAP de producto):** S2-04 no modifica `.github/workflows/ci.yml`; crea y ejecuta localmente sus scripts de prueba. El cableado integral de CI de las suites CRM se revisa/cierra en el S2-08 Final Quality Gate. No bloquea la implementación.
- **Derivaciones del handoff que se mantienen** (salen de las fuentes; no son decisiones nuevas): query params desconocidos o duplicados → 400; `phone` elimina solo el espacio ASCII y los separadores aprobados (`-`, `.`, `(`, `)`); `expectedUpdatedAt` y `createdAt`/`updatedAt` conservan microsegundos (6 decimales); `cache-control: no-store` según el contrato; rate limit existente; sin logger nuevo; sin lint nuevo.

## Sincronización Notion ↔ `docs/`

- **Notion primero** (2026-09-26 UTC), reemplazos anclados (sin re-export):
  - Arquitectura Técnica (`3de6ab0a330d817ab78bcbd88c100e5a`) §13.4: nota en la regla de texto, `null` en opcionales del POST, redacción del par de documento, bloque «Clientes — cierre S2-04» y línea de Auditoría.
  - Operación (`3e06ab0a330d819ea376f6f7628679f6`) §5.2: nombres en `fields`/`changed_fields` y no-op de PATCH no auditado.
  - Diccionario 01 (`3e06ab0a330d81fb94c1c237556999a0`) §10: vacío → NULL en anulables, excepción multilínea de `notes`, redacción del par de documento.
- Cada página se releyó tras editar; S1 (recuperado por DOC_CONFLICT-02), S2-02 (D-01a/D-01b y resto), S2-03, RBAC y el contrato de vehicles/ownership quedaron intactos.
- `docs/` recibió exactamente los mismos bloques de texto.
