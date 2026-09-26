# S2-05 Vehicles API Decisions

Bitácora del ticket S2-05 (Sprint 2 — Clientes + Vehículos, Vehicles API). **No reemplaza** a las fuentes canónicas: el contrato vive en Arquitectura §13.4 («Vehículos — cierre S2-05»), Diccionario 01 §11 y Operación §5.2 (catálogo CRM).

- Fecha: 2026-09-26.
- Origen: Architecture Handoff de S2-05 (CONTRACT READY: NO). DOC_GAP-01 y DOC_GAP-02 fueron aprobados por el responsable humano en el ticket; DOC_GAP-03 surgió en el cierre y el responsable humano aprobó la opción «igual que S2-04».
- Base: `integration/sprint-2` @ `e292ca0`, que ya integra S2-04 (merge `2a6fce2`: contrato `0d7d452` + implementación `c7ee120`/`8bcfd08`). No queda ninguna suposición de «S2-04 sin integrar».
- Solo documentación: sin cambios en `src/`, `tests/`, `scripts/`, `drizzle/`, `schema.ts`, RBAC, `package.json` ni CI.
- **Espacio de nombres:** los identificadores `DOC_GAP-01…03` de esta bitácora son los de S2-05. Las series `DOC_GAP-01…05` de S2-04 y `DOC_GAP-01…14` de S2-02 son distintas; en particular, el DOC_GAP-02 de S2-02 (archivo de clientes) sigue **DEFERRED** y este ticket no lo modifica.

## DOC_GAP-01

- **status:** CLOSED
- **decision:** PATCH no-op de vehicle. `expectedUpdatedAt` sigue siendo obligatorio y el OCC se valida siempre antes de decidir el no-op:
  1. resolver el vehicle bajo TenantContext/RLS;
  2. malformado, inexistente o de otro tenant → 404 `VEHICLE_NOT_FOUND`;
  3. comparar `expectedUpdatedAt` conservando microsegundos;
  4. obsoleto → 409 `RESOURCE_VERSION_CONFLICT`, aunque los valores pedidos sean iguales a los actuales;
  5. normalizar y mezclar el patch;
  6. calcular `changed_fields`.

  Si `changed_fields = []`: 200 con el `VehicleDto` actual; sin UPDATE; `updated_at` y `xmin` sin cambios; sin `vehicle.updated` ni fila en `audit_logs`. Si hay cambios: UPDATE condicional (OCC); `updated_at` avanza conservando la semántica de microsegundos de PostgreSQL; `vehicle.updated` con `changed_fields` minimizado (nombres, nunca valores).
- **fuentes:** Arquitectura §13.4 «Vehículos — cierre S2-05»; Operación §5.2 (regla de no auditar el no-op).

## DOC_GAP-02

- **status:** CLOSED
- **decision:** valores obligatorios y opcionales de vehicle.
  - Obligatorios en POST: `customerId`, `plate`, `vehicleType`, `brand`, `model`. Rechazan `null`; `plate`, `brand` y `model` rechazan además el valor vacío tras normalizar (→ 400 `REQUEST_VALIDATION_FAILED`). En PATCH, `plate`, `vehicleType`, `brand` y `model` tampoco aceptan `null`; `customerId` no es parcheable.
  - Opcionales anulables: `modelYear`, `color`, `vin`, `engineNumber`.
  - POST: ausente → `null`; `null` explícito → `null`; `color`/`vin`/`engineNumber` que quedan `""` tras la regla de texto → `null`; `modelYear: null` → `null`; `modelYear` no nulo debe ser entero en 1886–2200.
  - PATCH: ausente → sin cambio; `null` explícito → limpia el campo; `color`/`vin`/`engineNumber` que quedan `""` → `null`; `modelYear: null` → lo limpia.
  - `vin` y `engineNumber`: sin canonicalización adicional a la regla de texto del proyecto (NFC, trim, rechazo de controles/bidi; longitudes del Diccionario). Sin mayúsculas, sin quitar separadores y sin validar formato ni checksum de VIN.
- **fuentes:** Arquitectura §13.4 («Requests» y «Vehículos — cierre S2-05»); Diccionario 01 §11.

## DOC_GAP-03

- **status:** CLOSED
- **decision:** nombres en `vehicle.updated.metadata.changed_fields`, con el mismo criterio que S2-04 DOC_GAP-05 para customer.
  - Valores permitidos (nombres de columna persistida): `plate`, `vehicle_type`, `brand`, `model`, `model_year`, `color`, `vin`, `engine_number`.
  - Lista determinista y sin duplicados, siempre en el orden anterior (nunca el orden accidental del body / `Object.keys`).
  - Nunca `expectedUpdatedAt` / `expected_updated_at`, `customer_id`, `tenant_id`, `current_mileage_km`, `created_at` ni `updated_at`. Nunca valores (placa, VIN y número de motor siguen prohibidos en JSON de auditoría).
  - `vehicle.created` no cambia: metadata `{ownership_id, customer_id}`.
- **motivo:** Operación §5.2 solo decía «nombres» para `vehicle.updated`; sin fijar mayúsculas/minúsculas ni orden, la implementación tendría que adivinar.
- **fuentes:** Operación §5.2 «Catálogo CRM de Sprint 2»; Arquitectura §13.4 («Auditoría» y «Vehículos — cierre S2-05»).

## Otras constancias

- **`vehicles_plate_format_check`:** IMPLEMENTADO en S2-03 (`drizzle/0018_s2_03_crm_hardening.sql`). En `docs/` ya figuraba así desde `0766661` (ADR-009 §10, ERD §5, Diccionario 01 §11, Arquitectura §13.4). No queda texto «pendiente de incorporar a S2-03». Solo se sincroniza el estado; la regla y la migración no cambian.
- **Sin schema migration:** 0018 ya concede `GRANT UPDATE (plate, vin, vehicle_type, brand, model, model_year, color, engine_number, current_mileage_km, updated_at)` sobre `vehicles` a `tallermecario_api`. `model_year` ya tiene CHECK 1886–2200 y las cuatro columnas opcionales ya son anulables. No hay 0019 y `schema.ts` no cambia.
- **Sin cambio de RBAC / ADR-009 / Quality Gate:** `vehicles.create/read/update`, `vehicle_owners.manage` y el scope technician de RBAC §5/§17 no cambian; Quality Gate §5 (Sprint 2) ya cubre crear/leer/actualizar y las validaciones negativas.
- **Fuera de este cierre:** no se decide un `bodyLimit` específico para vehicles (no es un DOC_GAP aprobado; el `bodyLimit` de 16 KiB de S2-04 es exclusivo de customers).

## Sincronización Notion ↔ `docs/`

- **`docs/` primero, luego Notion** (2026-09-26 UTC), reemplazos anclados (sin re-export):
  - Arquitectura Técnica (`3de6ab0a330d817ab78bcbd88c100e5a`) §13.4: `null` en opcionales del POST/PATCH vehicle, bloque «Vehículos — cierre S2-05» y línea de Auditoría.
  - Operación (`3e06ab0a330d819ea376f6f7628679f6`) §5.2: nombres en `changed_fields` de vehicle y PATCH no-op de vehicle no auditado.
  - Diccionario 01 (`3e06ab0a330d81fb94c1c237556999a0`) §11: párrafo «Contrato S2-05».
- Cada página se releyó tras editar. Arquitectura §13.4 coincide línea a línea con `docs/` (85/85, normalizando indentación de Notion); Operación §5.2 y Diccionario 01 §11 contienen los mismos bloques. S2-02, S2-03, S2-04 y el contrato de ownership quedaron intactos.
- Estado de `vehicles_plate_format_check` en Notion: IMPLEMENTADO en ADR-009 §10, ERD §5 y Diccionario 01 §11 (verificado; sin cambios).

## Pasada de consistencia (solo lectura)

Arquitectura, Diccionario 01, ERD, RBAC, ADR-009, Operación y Quality Gate §5: sin DOC_CONFLICT. RBAC (`vehicles.update` owner/admin/service_advisor; technician sin update), ADR-009 §10 (grants por columna de 0018), ERD (columnas anulables) y Quality Gate §5 son coherentes con el contrato cerrado.
