# S3-04 — Edit Reception

## 1. Summary

Implementado `PATCH /api/v1/receptions/:receptionId` para recepciones abiertas,
con TenantContext/RLS, autorización por permissions, transacción compartida,
OCC con microsegundos y auditoría atómica. La rama es
`codex/s3-04-edit-reception`, basada en `integration/sprint-3` (`5c61e2c`).

No se añade migración ni columna `version`. No se implementan cierre, cancelación,
reapertura, GET/list, checklist, daños, firmas, media ni frontend.

## 2. Editable fields decision

La allowlist comprende exactamente:

- `appointmentId` / `appointment_id`: UUID canónico del tenant o `null` para limpiar.
- `locationId` / `location_id`: UUID canónico del tenant o `null` para limpiar.
- `mileageKm` / `mileage_km`: entero PostgreSQL no negativo, nunca `null`.
- `fuelLevelPct` / `fuel_level_pct`: entero 0..100 o `null`; 0 se conserva.
- `customerNotes` / `customer_notes`: nota multilínea o `null`.
- `advisorNotes` / `advisor_notes`: nota interna multilínea o `null`.

Decisión sustentada en el handoff S3-04, Diccionario 01 §15, `src/db/schema.ts`,
la allowlist `GRANT UPDATE` de 0019 y el permiso canónico `receptions.update_open`.
`app.enforce_reception_lifecycle()` congela explícitamente `vehicle_id` y
`customer_id`; ambos permanecen inmutables. También se rechazan identidad,
tenant, status, actor receptor, fechas del servidor y cualquier propiedad ajena
a la allowlist. Los grants de `status`/`closed_at` se reservan a futuros comandos
de lifecycle y no los expone este PATCH.

## 3. API contract

Request JSON estricto: `{ expectedUpdatedAt, ...subconjunto no vacío de campos editables }`.
Omitir un campo conserva su valor; enviar únicamente el token es inválido.
Respuesta 200: `{ reception: ReceptionDto }`, idéntico DTO de S3-03,
con `cache-control: no-store`. El path acepta UUID canónico y normaliza mayúsculas.

Las notas reutilizan exactamente el schema de S3-03: Unicode bien formado,
NFC, CRLF/CR a LF, trim exterior, vacío a `null`, máximo 2000 code points,
sin TAB, controles C0/C1 ni controles bidi. UUID opcional vacío es inválido.

Errores conservan `{ error: { code, message, request_id } }`:

- 400 `REQUEST_VALIDATION_FAILED`: body/token/tipos/rangos inválidos o campos prohibidos.
- 401 `AUTHENTICATION_REQUIRED`; 403 `PERMISSION_DENIED`.
- 404 `RECEPTION_NOT_FOUND`: recepción malformada, inexistente o ajena.
- 404 `APPOINTMENT_NOT_FOUND` / `LOCATION_NOT_FOUND`: referencia inexistente o ajena.
- 409 `RESOURCE_VERSION_CONFLICT`: token obsoleto.
- 409 `RECEPTION_NOT_EDITABLE`: estado distinto de open.
- 409 `RECEPTION_MILEAGE_CONFLICT`: kilometraje inferior al snapshot del vehículo.
- 413 `PAYLOAD_TOO_LARGE`: body superior a 16 KiB; 415 `UNSUPPORTED_MEDIA_TYPE`.
- 500 `INTERNAL_ERROR`: sanitizado; sin SQLSTATE, SQL, constraints ni mensajes de BD.

## 4. OCC implementation

Se reutiliza el patrón SQL de Customers/Vehicles: comparar en PostgreSQL
`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
contra el token opaco. No se convierte el token a `Date`.

La comparación sucede bajo el lock de recepción y se repite en el UPDATE
condicional. Un token stale falla antes del no-op, sin UPDATE ni audit.
`updated_at = GREATEST(now(), updated_at + interval '1 microsecond')`
garantiza un token estrictamente nuevo incluso cuando el timestamp almacenado
está en el futuro.

## 5. Lock order

Orden real de locks de filas en un cambio efectivo:

1. Recepción del tenant: `FOR NO KEY UPDATE OF r`.
2. Vehículo asociado: `FOR NO KEY UPDATE`, adquirido por el trigger lifecycle de 0019.
3. Locks de integridad de referencias adquiridos por las FKs del UPDATE.
4. INSERT de auditoría en la misma transacción.

La aplicación hace SELECTs ordinarios de appointment/location sólo si cambian a
un UUID no nulo; esos SELECTs no solicitan locks de filas. No prebloquea vehículo
ni añade lecturas de kilometraje. El trigger existente bloquea el vehículo en
cualquier UPDATE real, incluso cuando cambia sólo una nota. El no-op termina
después de bloquear la recepción y no toca el vehículo. Compatible con el futuro
orden de cierre reception → vehicle → advisory(order_number).

## 6. Open-only behavior

Tras bloquear y resolver la recepción bajo el tenant, se comprueba open antes
del OCC. Una recepción no-open devuelve 409 `RECEPTION_NOT_EDITABLE`, también
con payload idéntico o token stale. El mensaje no revela el estado interno.
Los fixtures cerrados usan el mecanismo DB de tests existente con firmas,
orden e historial inicial válidos; todos los triggers permanecen activos.

## 7. Mileage behavior

Sintaxis inválida devuelve 400. El trigger de PostgreSQL compara el nuevo
kilometraje con `vehicles.current_mileage_km` bajo lock del vehículo.
El constraint conocido `receptions_vehicle_mileage_guard` se mapea a 409;
otros CHECK/FK/UNIQUE no se convierten indiscriminadamente a ese error.
Snapshot nulo admite cualquier entero válido y la igualdad es válida.
Este PATCH no modifica el kilometraje del vehículo.

## 8. Tenant isolation

Todos los SELECT/UPDATE de producción incluyen el tenant del TenantContext.
Los permisos, GUCs RLS, actor e INSERT de auditoría usan ese mismo contexto.
No se acepta tenant del cliente. UUID ajeno e inexistente tienen el mismo
status/code/message; `request_id` es específico de cada request.
Las FKs compuestas y RLS continúan siendo autoridad final ante carreras.
No se añade relación appointment → vehicle/customer no definida por el dominio.

## 9. RBAC

Permiso existente `receptions.update_open`, documentado en RBAC y sembrado
por 0006: owner, admin y service_advisor tienen scope tenant; technician está
denegado. La ruta usa el sistema de permissions y no comprueba roles hardcodeados.
La autorización corre antes de validar el body.

## 10. Audit behavior

Cada UPDATE efectivo emite exactamente un `reception.updated` con outcome
success, tenant, usuario y membership del actor y entity_type/entity_id correctos.
`before_json` y `after_json` son NULL. Sólo se guarda
`metadata_json.changed_fields`, con nombres snake_case en orden determinista
de la allowlist; nunca valores, notas ni el token. Si falla el INSERT de audit,
el lifecycle transaccional hace rollback del UPDATE y conserva el token previo.

## 11. No-op behavior

Con token vigente, se comparan los valores normalizados enviados con la fila
bloqueada. Sin diferencias se devuelve 200 con el DTO actual, sin UPDATE,
sin cambio de `updated_at`/`xmin`, sin audit y sin lock de vehículo.

## 12. Concurrency

La prueba OCC retiene un lock de recepción y espera que dos PATCH alcancen
el SELECT bloqueado mediante `pg_blocking_pids`/`pg_stat_activity`, incluyendo
waiters indirectos. Sólo libera después de confirmar ambos waiters: exactamente
un 200, un 409, datos/token del ganador y un audit.

Otra prueba bloquea vehículo y demuestra con NOWAIT que el PATCH ya posee
el lock de recepción mientras el trigger espera. El no-op pasa con ese vehículo
bloqueado. Una carrera adicional retiene la recepción, confirma que PATCH espera,
crea el cierre válido en BD y hace COMMIT; PATCH observa closed y devuelve 409
sin escritura ni audit. Esto no añade una API de cierre.

## 13. Files changed

- `src/receptions/routes.ts`: ruta PATCH, permission canónico, JSON/16 KiB y path seguro.
- `src/receptions/validation.ts`: body estricto y allowlist con normalización compartida.
- `src/receptions/service.ts`: lock/open/OCC/no-op, UPDATE monotónico y audit atómico.
- `tests/reception-api/patch.test.cjs`: cobertura S3-04 en PostgreSQL real con runtime RLS.
- `tests/reception-api/create.test.cjs`: registro de PATCH y errores DB desconocidos.
- `.github/workflows/ci.yml`: nombre del gate existente actualizado para S3-03/S3-04.
- `docs/S3-04-EDIT-RECEPTION.md`: contrato, decisiones y entrega.

## 14. Tests added/changed

12 nuevos tests PATCH agrupados: DTO/audit/privacy, OCC de microsegundos/futuro,
no-op/limpieza, validación estricta/Unicode/16 KiB, anti-oracle/referencias,
RBAC/auth, closed, mileage, rollback de audit, carrera OCC forzada, orden de locks
y carrera con cierre DB. Más 8 tests POST existentes: 20 API en total.
El runner existente descubre `tests/reception-api/*.test.cjs`; el mismo comando
`test:reception:api` ya incluido en CI ejecuta ambos archivos sin runner/workflow nuevo.

## 15. Commands executed

Gates finales ejecutados secuencialmente, con configuración local cargada desde
`.env` en el proceso padre y sin registrar credenciales:

```text
npm run security
npm run build
npm run typecheck
npm run lint
npm test
npm run test:runtime:db
npm run test:reception
npm run test:reception:db
npm run test:reception:upgrade
npm run test:reception:mutations
npm run test:crm:api
npm run test:crm:db
npm run test:outbox:ci
npm run test:cross-tenant:final
npm run test:db:cross-row
git diff --check
```

También se ejecutó `npm run test:reception:api` directamente durante el desarrollo
y se repitió tres veces con
`TEST_NAME_PATTERN="OCC concurrency|lock order:|PATCH waiting behind"`.
Security y lint se volvieron a ejecutar después de agregar la documentación.

## 16. Exact results

Todos los gates finales: exit code 0.

- Security: `SECRET_SCAN_PASS`. Build, typecheck y lint: PASS; 197 archivos lintados.
- `npm test`: authz 26/26, TenantContext core 70/70, Wompi 20/20 y media presign 2/2.
- Runtime DB: `RUNTIME_DATABASE_ROLE_BOUNDARY_PASS`.
- Recepción API: 20/20; recepción DB: 11/11 (también en la ejecución separada).
- Upgrade recepción: caso válido 0018 → 0019 con datos intactos y rerun no-op;
  siete escenarios inválidos rechazados con rollback completo y ledger=19.
- Mutaciones recepción: 9/9 KILLED.
- CRM API: 75/75. CRM DB: 21/21.
- Outbox: 19/19. Cross-tenant: 25/25. Cross-row: 62/62.
- Concurrencia dirigida: 3/3 repeticiones, cada una con las 3 carreras PASS;
  node:test informa 4/4 porque incluye el harness del archivo POST sin matches.
- En todas las suites node:test completas: FAIL=0, SKIP=0, TODO=0.
- Los runners confirmaron cleanup de sus bases, logins y artefactos temporales.
- `git diff --check`: sin salida, exit code 0.

Se resolvieron dos fallos iniciales antes de los gates finales: el build del
avance parcial exigía estrechar el tipo de la referencia opcional antes de SQL;
la primera suite API pasó 18/19 porque el fixture del timestamp futuro usaba
un parámetro timestamptz que el driver convertía a Date, truncando microsegundos.
El fixture ahora usa `::text::timestamptz` y comprueba el valor completo en BD;
el código OCC compara texto en PostgreSQL desde el principio.

## 17. Remaining risks

El cierre S3-06 debe conservar reception → vehicle → advisory(order_number).
No se alteran invariantes PostgreSQL ni la arquitectura Single DATABASE_URL.
Las pruebas locales no confirman una ejecución nueva de GitHub Actions.

## 18. git diff --stat

Snapshot staged de la entrega completa, contra `integration/sprint-3`:

```text
 .github/workflows/ci.yml            |   2 +-
 docs/S3-04-EDIT-RECEPTION.md        | 258 ++++++++++++++++++++
 src/receptions/routes.ts            |  22 +-
 src/receptions/service.ts           |  66 +++++-
 src/receptions/validation.ts        |  50 ++++
 tests/reception-api/create.test.cjs |   5 +
 tests/reception-api/patch.test.cjs  | 461 ++++++++++++++++++++++++++++++++++++
 7 files changed, 858 insertions(+), 6 deletions(-)
```

Se añade también este documento canónico al commit, siguiendo los reportes
S2/S3 ya versionados; no se añaden otros archivos locales ignorados de `docs/`.

## 19. git status --short

Antes del commit:

```text
M  .github/workflows/ci.yml
A  docs/S3-04-EDIT-RECEPTION.md
M  src/receptions/routes.ts
M  src/receptions/service.ts
M  src/receptions/validation.ts
M  tests/reception-api/create.test.cjs
A  tests/reception-api/patch.test.cjs
```

El documento se incorpora explícitamente al índice porque `docs/` ignora
nuevos archivos por defecto. Después del commit, `git status --short` debe
quedar sin salida. Se verifica al finalizar, sin hacer merge.
