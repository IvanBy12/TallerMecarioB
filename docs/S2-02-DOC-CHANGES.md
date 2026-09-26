# S2-02 — CRM Contract Decisions: registro de sincronización documental

Bitácora del ticket S2-02 (Sprint 2 — Clientes + Vehículos). **No sustituye** a las fuentes canónicas: el contrato vive en Arquitectura §9/§13/§13.4, Diccionario §2 y 01 §10–§12, ERD §5/§17/§18, RBAC §5/§17/§20, ADR-009 §10, Operación §5.2/§6.3 y Quality Gates §5.

- Fecha: 2026-09-25.
- Decisiones aprobadas por el responsable humano (H1–H11 del decision pack S2-02).
- Base: `main@d4cbfda`. Sin cambios de código, migraciones, tests, `schema.ts` ni CI.

## 1. Decisiones aplicadas

| ID | Decisión aprobada | Documentos |
|---|---|---|
| D-01a | La placa almacenada cumple `plate = btrim(plate) AND plate = upper(plate COLLATE "C")` | Dicc 01 §11, ERD §5, ADR-009 §10 |
| D-01b | Placa canónica `^[A-Z0-9]{1,16}$`. Normalizador: trim → quitar espacios, `-` y `.` → mayúsculas ASCII → validar. Backstop DB `vehicles_plate_format_check` | Arq §13.4, Dicc 01 §11, ERD §5, ADR-009 §10 |
| D-01c | DEFER: formatos por `vehicle_type` | Dicc 01 §11 |
| D-02 | Sin DELETE, archive, `archived_at`, estado de archivo ni unarchive en Sprint 2. `customers.archive` queda sembrado sin endpoint. QG §5: CRUD = CREATE/READ/UPDATE/LIST-SEARCH | QG §5, Dicc 01 §10, ERD §18, RBAC §5 |
| D-03 | camelCase; ids `customerId`/`vehicleId`/`ownershipId`; bodies estrictos (extra → 400); id malformado → 404; `no-store`; envelopes | Arq §13, §13.4 |
| D-04 | Clientes: POST, GET `:customerId`, GET listado, PATCH | Arq §13, §13.4 |
| D-05 | Vehículos: POST (con propietario), GET `:vehicleId`, GET `?plate=`, PATCH. `currentMileageKm` solo lectura | Arq §13.4, Dicc 01 §11 |
| D-06 | Keyset `id DESC`, `limit` 20/100, cursor opaco base64url versionado | Arq §13, §13.4 |
| D-07 | Clientes: `phone` exacto, `documentNumber` exacto, `name` prefijo (AND). Vehículos: `plate` exacta. Query strings CRM redactadas en logs | Arq §13.4, ERD §17, Operación §6.3 |
| D-08 | Regla de texto (NFC/trim/control-bidi/no vacío); phone normalizado `^\+?[0-9]{7,15}$` sin +57 ni unicidad; email trim + formato; `documentType`/`documentNumber` ambos o ninguno | Arq §13.4, Dicc 01 §10 |
| D-09 | DEFER: canonicalización de email/documento/VIN/número de motor, catálogo `document_type`, E.164 | Dicc 01 §10, Arq §13.4 |
| D-10 | Propietario actual = `is_primary AND valid_to IS NULL`; la API de S2 solo crea `owner` + primario | Arq §13.4, Dicc 01 §12, ERD §5 |
| D-11 | DEFER: relaciones no-owner, primario no-owner, varias vigentes, solapes, cierre sin sucesor, invariante en DB | Dicc 01 §12, Arq §13.4 |
| D-12 | `vehicle_owners` Frozen-on-close (confirma el trigger de S2-03) | Dicc §2, Dicc 01 §12, ERD §5/§18, ADR-009 §10 |
| D-13 | DEFER: `valid_to` futuro y fecha efectiva enviada por el cliente; en S2 el servidor fija los timestamps | Dicc 01 §12 |
| D-14 | `POST /vehicles/:vehicleId/owners {customerId, expectedCurrentOwnershipId}`: lock → no-op 200 → premisa → 409 `VEHICLE_OWNERSHIP_CONFLICT` → `clock_timestamp()` → cerrar → insertar → audit | Arq §13.4, ERD §5 |
| D-15 | `POST /vehicles` exige `customerId`; vehicle + owner inicial atómicos; invariante solo en app | Arq §13.4, ERD §5 |
| D-16 | Historial: `customers.read` + `vehicles.read`; DTO con `customer {firstName, lastName}`; orden `validFrom DESC`; technician 403 | Arq §13.4, RBAC §5 |
| D-17 | DEFER: QC como A. Interino: solo `lead_technician`/`support_technician` activos. Reabrir en Sprint 5 | RBAC §17, Arq §13.4 |
| D-18 | Technician asignado → `VehicleTechDto`; no asignado → 404 `VEHICLE_NOT_FOUND`; listados → 403 | RBAC §17, Arq §13.4 |
| D-19 | Auditoría de las 5 mutaciones CRM, minimizada | Operación §5.2, RBAC §20, Arq §13.4 |
| D-20 | Códigos nuevos: `CUSTOMER_NOT_FOUND`, `VEHICLE_NOT_FOUND`, `VEHICLE_PLATE_ALREADY_EXISTS`, `VEHICLE_OWNERSHIP_CONFLICT`, `RESOURCE_VERSION_CONFLICT` + mapeo de backstops | Arq §13.4 |
| D-21 | PATCH exige `expectedUpdatedAt`, token opaco que preserva microsegundos; sin columna `version` | Arq §9, §13.4 |
| D-22 | DEFER: `Idempotency-Key` e IDs de cliente CRM | Arq §9, §13.4 |
| D-23 | El staging drill remoto de CI cuenta como staging de S2 si S2-08 lo amplía; lint y observabilidad los cierra S2-08 con herramientas aprobadas | QG §5 |
| D-24…D-32 | Confirmaciones de documentación existente (sin cambio) | — |

## 2. DOC_CONFLICT-01 — CLOSED

- **Conflicto:** Quality Gates §5 ("CRUD cliente/vehículo") y el Roadmap ("CRUD completo") frente a ERD §18, Dicc §1, ADR-009 §4 y RBAC §5 (sin borrado físico; baja lógica "según política futura").
- **Resolución (D-02):** en Sprint 2, "CRUD" = CREATE / READ / UPDATE / LIST-SEARCH, sin DELETE ni archivo. Quality Gates §5 fue actualizado en Notion y en `docs/`.
- **S2-07** se cierra formalmente como diferimiento documentado; no requiere migración.

## 3. Matriz final DOC_GAP-01…14

| GAP | Tema | Estado | Decisión | Diferido y trigger de reapertura |
|---|---|---|---|---|
| 01 | Normalización de placa | **CLOSED** | D-01a, D-01b | D-01c (formatos por `vehicle_type`) DEFERRED → datos del piloto (Sprint 15) o placas legítimas rechazadas en Sprint 3 |
| 02 | Archivo de clientes | **DEFERRED** | D-02 | Necesidad de negocio explícita (p. ej. fusión de duplicados u ocultar clientes en recepción) o flujo DSR/anonimización; siempre antes del piloto (Sprint 15). Interino: sin archivo ni borrado |
| 03 | Rutas y DTO CRM | **CLOSED** | D-03, D-04, D-05 | — |
| 04 | Búsqueda y paginación | **CLOSED** | D-06, D-07 | `q` libre, email, VIN, prefijo de placa, `unaccent` y trigram → evidencia UX de Sprint 3 o `EXPLAIN ANALYZE` real |
| 05 | Códigos de error CRM | **CLOSED** | D-20 | — |
| 06 | Auditoría CRM | **CLOSED** | D-19 | Auditar lecturas de PII → Sprint 14 (hardening de privacidad) |
| 07 | Semántica y concurrencia de ownership | **CLOSED** | D-10, D-12, D-14 | D-11/D-13 DEFERRED → pedido de flotas/empresas, contactos secundarios o retrodatado (Sprint 3+) o piloto |
| 08 | Propietario inicial | **CLOSED** | D-15 | Invariante en DB (constraint trigger) diferida con D-11 |
| 09 | Permiso del historial | **CLOSED** | D-16 | — |
| 10 | Normalización de phone/email/documento | **CLOSED** | D-08 | D-09 DEFERRED → Sprint 9 (E.164/WhatsApp) o DSR/facturación (documento) |
| 11 | QC como scope A | **DEFERRED** | D-17 | Sprint 5 (asignaciones). Interino: solo lead/support activos |
| 12 | OCC en PATCH | **CLOSED** | D-21 | — |
| 13 | Idempotency-Key / IDs de cliente | **DEFERRED** | D-22 | Sprint 3 si el E2E móvil demuestra la necesidad; si no, Sprint 13 (`sync_operations`). Interino: UUIDv7 del servidor |
| 14 | Staging para el Gate | **CLOSED** (decisión) | D-23 | La ejecución y la evidencia pertenecen a S2-08 |

## 4. Diferimientos aprobados (H11)

| ID | Qué | Comportamiento interino | Motivo | Trigger | Impacto futuro |
|---|---|---|---|---|---|
| D-01c | Formatos de placa por `vehicle_type` | Cualquier `^[A-Z0-9]{1,16}$` | El Gate S2 no valida formatos | Piloto o placas legítimas rechazadas en S3 | CHECK por tipo o validación en app |
| D-09 | Canonicalización de email, documento, VIN y número de motor; catálogo `document_type`; E.164 | trim/NFC; email con validación de formato | Sin unicidad ni búsqueda que dependa de ello | S9 (E.164), DSR o facturación | Normalizadores; posible CHECK |
| D-11 | Relaciones no-owner, primario no-owner, solapes, cierre sin sucesor, invariante "siempre dueño" en DB | La DB las permite; la API no las expone | El Gate solo exige conservar la historia | Pedido de flotas/empresas o piloto | Rutas nuevas; constraint trigger diferido |
| D-13 | `valid_to` futuro y fecha efectiva del cliente | Solo hora del servidor | El Gate solo exige conservar la historia | Pedido de retrodatar (S3+) | Campo `effectiveAt` + regla en el trigger |
| D-17 | QC como A | Estricto: solo lead/support activos | No hay órdenes reales en S2 | Sprint 5 | Resolver ampliado + RBAC §17 |
| D-22 | `Idempotency-Key` e IDs de cliente | UUIDv7 del servidor; ownership no-op en reintento | CRM no está en la lista de operaciones sensibles (ADR-005) | S3 si el E2E móvil lo exige; si no, S13 | `id` opcional en POST o `sync_operations` |

## 5. Delta exacto pendiente sobre S2-03 (`a277cd1`, no implementado en S2-02)

- **D-12:** confirma sin cambios `vehicle_owners_history_guard_trg` y los grants de columna.
- **D-01b** exige, antes del merge de S2-03, estos cambios en `0018` (sin merge ni ledger aplicado fuera de BDs desechables) o en una `0019`:
  1. **Constraint:** `ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_plate_format_check CHECK (plate COLLATE "C" ~ '^[A-Z0-9]{1,16}$')`. Verificar la semántica del rango bajo `"C"`.
  2. **Preflight:** ampliar el bloque (bajo el mismo `NO FORCE`/`ACCESS EXCLUSIVE`) para abortar si alguna fila incumple el formato. La detección de colisiones debe agrupar por la forma canónica compacta: `upper(regexp_replace(btrim(plate), '[ .-]', '', 'g') COLLATE "C")`. El mensaje no debe exponer placas, VIN ni ids.
  3. **Autoverificación** `$crm_hardening_checks$`: exigir `vehicles_plate_format_check` (`contype='c'`, `convalidated`).
  4. **`schema.ts`:** `rawCheck('vehicles_plate_format_check', '"plate" COLLATE "C" ~ ''^[A-Z0-9]{1,16}$''')` + snapshot regenerado sin drift.
  5. **Tests:**
     - HD-32 deja de ser caracterización: `ABC-123`, `ABC 123`, `ABC.123`, `ñ12345` y `''` → `23514 vehicles_plate_format_check` (o `…normalized_check`, según el orden de evaluación, asertado por nombre) en INSERT y UPDATE.
     - Casos válidos límite: `A`, 16 caracteres.
     - Upgrade con legado no canónico y con colisión canónica (`ABC-123` frente a `ABC123`) → falla atómica.
  6. **Mutaciones:** dropear o relajar `vehicles_plate_format_check` debe hacer fallar la suite.
  7. **Fixtures:** placas de helpers/backups/tests solo `[A-Z0-9]`.
- **Sin otro impacto:** worker REVOKE ALL, grants de columna, OCC (usa `updated_at`, ya en el grant) y archivo (diferido) son compatibles.

## 6. Requisitos que S2-02 deja a S2-08

- **Staging drill remoto:** ampliarlo con 0018, el ledger esperado, health/smoke, E2E CRM (customer → vehicle → búsqueda → cambio de propietario → historial, con 2 tenants), rollback y evidencia del run remoto.
- **Lint y observabilidad:** cerrarlos explícitamente con las convenciones/herramientas aprobadas del repo; S2-02 no introduce herramientas.

## 7. Sincronización Notion ↔ `docs/`

- **Notion actualizado primero** (2026-09-25/26 UTC):
  - Quality Gates (`3df6ab0a330d818486e9dd6f06b5f573`) §5.
  - Arquitectura Técnica (`3de6ab0a330d817ab78bcbd88c100e5a`) §9, §13, §13.4.
  - Diccionario (`3e06ab0a330d815fbb32e6200f8d5417`) §2.
  - Diccionario 01 (`3e06ab0a330d81fb94c1c237556999a0`) §10–§12.
  - ERD (`3df6ab0a330d81fda465f8944c3291e6`) §5, §17, §18.
  - RBAC (`3e06ab0a330d81d398ffe925a65506c8`) §5, §17, §20.
  - ADR-009 (`3e06ab0a330d8162b0cfff78ad1cb9b1`) §10.
  - Operación (`3e06ab0a330d819ea376f6f7628679f6`) §5.2, §6.3.
- **Sincronización de `docs/`:** se aplicaron exactamente los mismos bloques de texto. **No** se re-exportó la página completa desde Notion (ver DOC_CONFLICT-02).

### DOC_CONFLICT-02 — OPEN (preexistente, no bloquea S2-02)

- **Fuentes en conflicto:** las páginas Notion de Arquitectura Técnica, RBAC y ADR-009 (y posiblemente Operación y ERD) **no contienen** el contenido canónico de Sprint 1 que sí existe en el export `docs/`:
  - Arquitectura §13.1–§13.3 y los párrafos S1-07/S1-08 de §15;
  - RBAC §16 (S1-06), §18 (S1-08) y el párrafo del catálogo S1 en §20 (Notion editado por última vez el 2026-09-19);
  - ADR-009 §10 (reducciones 0009–0016) y §10.1.
- **Riesgo:** re-exportar Notion a `docs/` borraría decisiones canónicas de Sprint 1.
- **Colocación de S2-02:** en Notion, el bullet de ADR-009 va antes de §11 con una línea introductoria, y el párrafo de RBAC §20 va tras "Nunca registrar tokens o secretos en el audit log." (mismo ancla en `docs/`).
- **Afecta a:** la fuente canónica de Sprint 1 y el ítem "Documentación técnica actualizada" del Gate de Sprint 1/Sprint 2 (S2-08).
- **Qué no afecta:** el contrato S2-02 es idéntico en ambas copias.
- **Decisión humana requerida:** back-sync de los cambios S1-04…S1-08 de `docs/` a Notion (recomendado, antes de S2-08) o declarar `docs/` como copia autoritativa.

## 8. Archivos del export tocados

- `Arquitectura Técnica v1 — TallerMecario …md`
- `Diccionario de Datos v1 — PostgreSQL …md` (nuevo en git; antes solo local)
- `Diccionario 01 — Tenancy, Identidad, CRM, Agenda y …md` (nuevo en git; antes solo local)
- `Modelo de Datos ERD v1 — PostgreSQL …md`
- `RBAC — Matriz completa de roles y permisos v1 …md`
- `ADR-009 — RLS y privilegios PostgreSQL por TenantC …md`
- `Operación, Retención, Recuperación y Observabilida …md`
- `Quality Gates — Reglas y Pruebas por Sprint …md`
- Este registro.
