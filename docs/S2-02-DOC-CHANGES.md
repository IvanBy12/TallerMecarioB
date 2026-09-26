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
| D-16 | Historial: `customers.read` + `vehicles.read`; DTO con `customer {firstName, lastName}`; orden `validFrom DESC`; technician 403. Límite y desempate aprobados después en N-1 (§1.1) | Arq §13.4, RBAC §5 |
| D-17 | DEFER: QC como A. Interino: solo `lead_technician`/`support_technician` activos. Reabrir en Sprint 5 | RBAC §17, Arq §13.4 |
| D-18 | Technician asignado → `VehicleTechDto`; no asignado → 404 `VEHICLE_NOT_FOUND`; listados → 403 | RBAC §17, Arq §13.4 |
| D-19 | Auditoría de las 5 mutaciones CRM, minimizada | Operación §5.2, RBAC §20, Arq §13.4 |
| D-20 | Códigos nuevos: `CUSTOMER_NOT_FOUND`, `VEHICLE_NOT_FOUND`, `VEHICLE_PLATE_ALREADY_EXISTS`, `VEHICLE_OWNERSHIP_CONFLICT`, `RESOURCE_VERSION_CONFLICT` + mapeo de backstops | Arq §13.4 |
| D-21 | PATCH exige `expectedUpdatedAt`, token opaco que preserva microsegundos; sin columna `version` | Arq §9, §13.4 |
| D-22 | DEFER: `Idempotency-Key` e IDs de cliente CRM | Arq §9, §13.4 |
| D-23 | El staging drill remoto de CI cuenta como staging de S2 si S2-08 lo amplía; lint y observabilidad los cierra S2-08 con herramientas aprobadas | QG §5 |
| D-24…D-32 | Confirmaciones de documentación existente (sin cambio) | — |

### 1.1 Decisión humana adicional tras el review final

**N-1 (APPROVED):** límite del historial de propietarios para `GET /api/v1/vehicles/:vehicleId/owners`:

- máximo 200 registros, sin paginación en Sprint 2;
- orden `validFrom DESC` con desempate determinista `ownershipId DESC` (`ORDER BY valid_from DESC, id DESC`).

Motivo: el historial por vehículo es naturalmente pequeño; 200 es un límite defensivo que evita una ruta sin tope; el desempate da un orden estable cuando `validFrom` coincide. Sin cambios de schema ni de índices. Arquitectura §13.4 ya lo describe así, por lo que no requirió edición.

## 2. DOC_CONFLICT-01 — CLOSED

- **Conflicto:** Quality Gates §5 ("CRUD cliente/vehículo") y el Roadmap ("CRUD completo") frente a ERD §18, Dicc §1, ADR-009 §4 y RBAC §5 (sin borrado físico; baja lógica "según política futura").
- **Resolución (D-02):** en Sprint 2, "CRUD" = CREATE / READ / UPDATE / LIST-SEARCH, sin DELETE ni archivo. Quality Gates §5 fue actualizado en Notion y en `docs/`.
- **S2-07** se cierra formalmente como diferimiento documentado; no requiere migración.

## 3. Matriz final DOC_GAP-01…14

| GAP | Tema | Estado | Decisión | Diferido y trigger de reapertura |
|---|---|---|---|---|
| 01 | Normalización de placa | **CLOSED** | D-01a, D-01b | D-01c (formatos por `vehicle_type`) DEFERRED → datos del piloto (Sprint 15) o placas legítimas rechazadas en Sprint 3 |
| 02 | Archivo de clientes | **DEFERRED** | D-02 | Motivo, interino, trigger e impacto futuro completos en §4 (fila D-02) y en Diccionario 01 §10 |
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

## 4. Diferimientos aprobados (H2 para D-02; H11 para el resto)

| ID | Qué | Comportamiento interino | Motivo | Trigger | Impacto futuro |
|---|---|---|---|---|---|
| D-02 (DOC_GAP-02) | Archivo/baja lógica de clientes (archive, unarchive, `archived_at`/estado) | Todo customer permanece activo; sin endpoint de archive ni de delete; `customers.archive` sembrado sin endpoint; CRUD S2 = CREATE/READ/UPDATE/LIST-SEARCH | No existe necesidad de negocio explícita; Arq §6 y ERD §1/§18 limitan el soft delete a necesidades explícitas; no hay contrato ni permiso de unarchive; obligaría a definir efectos sobre búsqueda, recepción y nuevas relaciones; archivar no es supresión/anonimización DSR | Necesidad de negocio explícita, flujo DSR/anonimización o necesidad de ocultar clientes operativamente; como máximo antes del piloto (S15) | Posible `archived_at` o `status` (migración estructural + Diccionario + ERD); ampliar la allowlist de `GRANT UPDATE` de `customers` (0018); decidir permiso/comando de unarchive; decidir listado/búsqueda y participación en nuevas receptions/ownership; tests y Quality Gate |
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

### DOC_CONFLICT-02 — CLOSED: deuda de sincronización de Sprint 1 (cierre en «Registro de cierre», al final de esta sección)

**Inventario confirmado por el review final** (fetch de Notion posterior a las ediciones S2-02). Contenido de Sprint 1 presente en el export `docs/` y **ausente** en Notion:

| Documento | Bloques ausentes en Notion |
|---|---|
| Arquitectura Técnica | §13.1–§13.3; notas S1-07/S1-08 de §15 |
| RBAC | notas S1-06 (§16) y S1-08 (§18); nota del catálogo de Sprint 1 en §20 (página sin editar desde el 2026-09-19 antes de S2-02) |
| ADR-009 | reducciones de §10 de 0009–0017; privilegios finales de `audit_logs`; §10.1 |
| Operación | §5.1 reglas de Sprint 1; catálogo de 18 acciones; política de intentos denegados; D1–D6; S1-08; §8.1 runbook de Resend |
| ERD | `identity_sync_states`; `membership_invitation_deliveries`; invariante de owner activo |
| Diccionario 01 | §3.1; §5.1 |

- **Contradicciones con S2-02:** ninguna. El contrato S2-02 es coherente con ese contenido (allowlist y política de denegados de auditoría, 404 sin oráculo, patrón de grants por columna). En Notion solo deja referencias colgantes (p. ej. §13.2 `role_code`, guard 0017, §10.1), que forman parte de este conflicto (N-2).
- **Fuente de verdad:** no se modifica la jerarquía documental. Este registro no declara `docs/` autoritativo sobre Notion ni lo contrario.
- **Impacto:**
  - NO bloquea S2-02 ni S2-03.
  - Debe cerrarse antes del Quality Gate de Sprint 2 (S2-08).
  - Preferiblemente se cierra antes de S2-04, porque los implementadores CRM necesitan las convenciones S1 de Arquitectura §13.2/§13.3 y la política de auditoría de Operación §5.2.
- **Plan aprobado: BACK-SYNC**, como tarea documental separada:
  - Restaurar en Notion únicamente los bloques faltantes, usando como evidencia el contenido de Sprint 1 del export `docs/`.
  - Antes de copiar cada bloque: comprobar que corresponde a decisiones cerradas de Sprint 1, que no contradice S2-02 y que preserva el contenido S2-02 ya presente.
  - Prohibido un re-export destructivo de Notion sobre `docs/`.
- **Colocación de S2-02 en Notion** (para el back-sync):
  - ADR-009: el bullet S2-03 está antes de §11 con una línea introductoria; al restaurar §10/§10.1 debe quedar dentro de la lista de reducciones.
  - RBAC §20: el párrafo CRM va tras "Nunca registrar tokens o secretos en el audit log." (mismo ancla en `docs/`).

#### Registro de cierre — DOC_CONFLICT-02: CLOSED (2026-09-26 UTC)

- **Causa:** los cierres de Sprint 1 (S1-03…S1-08) se aplicaron al export `docs/` pero no a las páginas de Notion; S2-02 lo detectó al editar Notion.
- **Fuente usada:** los archivos actuales de `docs/` en `main` `e0ea533` (S2-01, S2-02 y S2-03 integrados). Dirección única `docs/` → Notion. Sin re-export ni reescritura de páginas completas: solo reemplazos anclados (`update_content`) de los bloques ausentes, con el mismo texto que `docs/`.
- **Método:** por página, fetch de Notion → comparación bloque a bloque con `docs/` (normalización línea a línea + búsqueda de marcadores S1-0x / migraciones 0007–0017) → edición solo de los bloques MISSING → nuevo fetch y verificación del resultado y de los marcadores S2.
- **Contenido restaurado en Notion:**

| Página | Bloques añadidos |
|---|---|
| Arquitectura Técnica | §5 verificación S1-08; §13.1, §13.2, §13.3 (antes de §13.4); §15 notas S1-07 y S1-08 |
| RBAC | §16 párrafo S1-06 (tras la regla 9, para no romper la lista numerada); §18 nota S1-08; §20 nota del catálogo Sprint 1 |
| ADR-009 | §2 fila `tallermecario_identity_sync` y reglas; §3 nota S1-08; §6.1 línea Tenancy (0009/0011); §7 casos 7–8; §9 S1-08, regla transacción/red S1-03 y lease S1-04; §10 reducciones S1-04…S1-07 (0009–0017) y privilegios finales de `audit_logs`; §10.1 completo; §11 guard de actor, frontera GUC y alcance S1-08; §14 DEPLOYMENT_SECURITY_DELTA |
| Operación | §5.1 reglas S1-04/S1-07/S1-08 y frontera de confianza; §5.2 catálogo de 18 acciones (idéntico al de `docs/`), actores, política de denegados, D1–D6, deuda CI/LOW, S1-08; §8.1 runbook de Resend |
| ERD | dominio Tenancy e identidad; relación `IDENTITY_SYNC_STATES`; `identity_sync_states`; columnas y máquina de estados 0016 de `memberships`; restricciones S1-04 de `membership_invitations`; `membership_invitation_deliveries`; «Invariante de owner activo»; Clerk en `webhook_events`; S1-08 en `outbox_events`; S1-07/S1-08 en `audit_logs`; índices obligatorios; nota 0002/0017 de append-only; nota 0019 documental |
| Diccionario 01 | §3 tombstone `user.deleted`; §3.1; §4 constraints 0016 e invariante S1-05/S1-06; §5 contrato del token y CHECKs 0008–0010; §5.1; §9 nota S1-05 y `app.owner_mutation_gate` |

- **Ampliación sobre el inventario:** los bloques de Diccionario 01 §3/§4/§5/§9, ADR-009 §2/§3/§6.1/§7/§9/§11/§14, Arquitectura §5 y los del ERD fuera de las tres tablas inventariadas cumplen las cuatro condiciones (presentes en `docs/`, Sprint 1 cerrado, ausentes en Notion, sin contradicción con Sprint 2). En Diccionario 01 §4 la frase de constraints de Notion era una versión anterior e incompleta de la misma regla (subconjunto, no contradicción) y se reemplazó por la de `docs/`. En ADR-009 §10 la línea introductoria provisional de S2-02 se sustituyó por la de `docs/`, según la colocación prevista arriba; el bullet S2-03 queda dentro de la lista, sin cambios.
- **Sprint 2 preservado:** verificado tras cada edición. Intactos: Arquitectura §9 (CRM S2-02) y §13.4; RBAC §5 Sprint 2, §17 `vehicles.read` A y §20 CRM; ADR-009 bullet S2-03 (incluida la frase de EXECUTE de N-4); Operación catálogo CRM de §5.2 y §6.3; ERD CRM (§5, D-01a/D-01b, Frozen-on-close, §17 S2-02, §18 S2-02); Diccionario 01 §10–§12 (DOC_GAP-02, D-01a/D-01b, Frozen-on-close).
- **Conflictos:** 0. Diferencias residuales solo de formato (tablas/menciones de Notion, auto-link de «localhost»), sin cambio de contenido.
- **Fuera de alcance:** el estado «pendiente de incorporar a S2-03» de `vehicles_plate_format_check` (Notion y `docs/`) no forma parte de DOC_CONFLICT-02 y no se modificó.
- **Commit de cierre:** el commit que introduce este registro en la rama `task/docs-back-sync-s1-notion`.
- Este registro es bitácora, no fuente normativa.

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

## 9. Estado de los findings del review final (sobre `f8dbdcc`)

| ID | Estado | Resolución |
|---|---|---|
| R-1 | CLOSED | DOC_GAP-02 ahora registra motivo, interino, trigger e impacto futuro en Diccionario 01 §10 (Notion y `docs/`) y en §4 (fila D-02) |
| R-2 | CLOSED | Inventario confirmado de DOC_CONFLICT-02 en §7, con plan BACK-SYNC; el conflicto se cerró con el back-sync del 2026-09-26 (ver registro de cierre en §7) |
| N-1 | APPROVED | Límite 200 + `ownershipId DESC` registrados en §1.1; Arq §13.4 ya lo describía |
| N-2 | CLOSED (DOC_CONFLICT-02) | Referencias colgantes resueltas por el back-sync: §13.2 `role_code`, guard 0017 y §10.1 ya existen en Notion |
| N-3 | INFO (sin cambio) | Arq §13 es la lista genérica con `:id`; §13.4 define los nombres `:customerId`/`:vehicleId` |
| N-4 | CLOSED | ADR-009 §10 (Notion y `docs/`): "`EXECUTE` revocado de PUBLIC y no concedido a ningún rol runtime; el owner conserva su privilegio implícito de PostgreSQL". Verificado: 0000 solo hace `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` en `app`, y 0018 no concede EXECUTE. La frase del ERD ("sin EXECUTE a PUBLIC") ya era exacta |
| N-5 | INFO (sin cambio) | La referencia de Notion a este registro es informativa (bitácora), no una dependencia contractual |

Ediciones en Notion de esta remediación (2026-09-26 UTC): Diccionario 01 §10 (bloque DOC_GAP-02) y ADR-009 §10 (frase de EXECUTE). Las mismas ediciones se aplicaron en `docs/`.
