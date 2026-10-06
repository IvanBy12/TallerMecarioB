# Contrato API — Recepción de vehículo, privacidad y firma (S3, v1)

- **Estado:** CONGELADO (backend). Desbloquea el contrato HTTP de S3-B08 *Reception vertical slice* del frontend, salvo los bloqueos de §11.
- **Fecha de reconciliación:** 2026-10-02. Rama `fix/s3-reception-contract-reconcile`, base `main` `89186a4162e1401bcf14b82d259ed7927205e519`. Referencia histórica: `daff672`; se portaron sólo lecturas y cobertura compatibles.
- **Implementación:** `src/receptions/*` (`routes.ts`, `validation.ts`, `service.ts`, `queries*.ts`, `signature.ts`, `close.ts`, `acceptance-document.ts`), `src/privacy/*` (`routes.ts`, `validation.ts`, `consent-service.ts`, `catalog.ts`, `controller-notice.ts`), registro en `src/api/server.ts`.
- **Pruebas:** `tests/reception-api/contract.test.cjs` (este contrato de punta a punta, con dependencias de privacidad de producción) más las suites por ticket: `create`, `patch`, `queries`, `signature`, `close`, `privacy-consent`, `production-privacy` (`tests/reception-api/`), `tests/reception/*` (BD) y los runners de mutación (`npm run test:reception:mutations`).
- **Fuentes canónicas:** Arquitectura Técnica v1 §13 (convenciones, envelope de error); Diccionario 01 §15–18 y Diccionario 04/05 §1.1 (RECEPTION-CONSENT-01, D-PRIV-01…05, D-SIG-01); RBAC — Matriz v1 §6/§13; docs de ticket `docs/S3-04-5-…`, `S3-04-…`, `S3-05-…`, `S3-06-…`, `S3-07-…`.

Este documento consolida el contrato HTTP actual. Las decisiones de privacidad de producción y los contratos actuales S3-05/S3-07 son autoritativos; las descripciones históricas se reconciliaron con ellos. Los endpoints marcados **NUEVO** cierran los huecos de lectura del slice (§10). S3 Final Gaps añade escritura de inspección (§5.10) y registra Media/R2 productivo; sin cambios de esquema, migraciones, `/me/context`, cierre ni autorización de recursos.

---

## 1. Endpoints

| # | Método y path | Permiso (scope) | Éxito | Estado |
| --- | --- | --- | --- | --- |
| 1 | `GET /api/v1/customers/:customerId/privacy-consents?status=granted` | `privacy_consents.read` (tenant) | 200 | **NUEVO** |
| 2 | `GET /api/v1/privacy-notice?purposeCode=service_provision` | `privacy_consents.capture` (tenant) | 200 | **NUEVO** |
| 3 | `POST /api/v1/customers/:customerId/privacy-consents` | `privacy_consents.capture` (tenant) | 201 | existente (S3-04.5) |
| 4 | `POST /api/v1/receptions` | `receptions.create` (tenant) | 201 | existente (S3-03/04.5) |
| 5 | `GET /api/v1/receptions` | `receptions.read` (tenant) | 200 | existente (S3-07) |
| 6 | `GET /api/v1/receptions/:receptionId` | `receptions.read` (tenant o assigned) | 200 | existente (S3-07) |
| 7 | `PATCH /api/v1/receptions/:receptionId` | `receptions.update_open` (tenant) | 200 | existente (S3-04) |
| 8 | `GET /api/v1/reception-acceptance-document` | `signatures.capture` (tenant) | 200 | **NUEVO** |
| 9 | `POST /api/v1/receptions/:receptionId/signature` | `signatures.capture` (tenant) | 201 | existente (S3-05) |
| 10 | `POST /api/v1/receptions/:receptionId/close` | `receptions.close` (tenant) | 200 | existente (S3-06) |
| 11 | `PATCH /api/v1/receptions/:receptionId/checklist` | `receptions.update_open` (tenant) | 200 | S3 Final Gaps §5.10 |
| 12 | `PATCH /api/v1/receptions/:receptionId/damages` | `receptions.update_open` (tenant) | 200 | S3 Final Gaps §5.10 |

**No existen** (y no deben simularse en el frontend): cancelar recepción, reabrir, borrar o reemplazar recepción, revocar consentimiento, leer firma, bundle offline de aviso, `Idempotency-Key`. Ver §9 y §11. Un path inexistente responde 404 con el body por defecto de Fastify (no el envelope estable).

## 2. Convenciones comunes

- **Autenticación y tenant:** `Authorization: Bearer <Clerk session JWT>` y `X-Tenant-Id: <uuid>` en cada request. El tenant y el actor nunca se aceptan en el body.
- **Orden de rechazo:** 401 `AUTHENTICATION_REQUIRED` → errores de tenant (400 `TENANT_SELECTION_INVALID`, 409 `TENANT_SELECTION_REQUIRED`, 403 `TENANT_ACCESS_DENIED` / `ACTIVE_MEMBERSHIP_REQUIRED`) → 403 `PERMISSION_DENIED` → 415 / 413 / 400 del body o query → reglas de dominio. La autorización corre **antes** de validar el body.
- **Envelope de error:** `{ "error": { "code": string, "message": string, "request_id": string } }`. El cliente decide por `code` (estable); `message` es seguro pero no contractual. 500 → `INTERNAL_ERROR` sin detalles SQL.
- **Bodies:** JSON estricto (`additionalProperties: false`); `Content-Type: application/json` obligatorio donde hay body (si no, 415 `UNSUPPORTED_MEDIA_TYPE`); JSON inválido → 400 `REQUEST_BODY_MALFORMED`; demasiado grande → 413 `PAYLOAD_TOO_LARGE`. Campos desconocidos, tipos erróneos o fuera de rango → 400 `REQUEST_VALIDATION_FAILED`.
- **Query strings:** sólo las claves documentadas, cada una una vez; si no → 400 `REQUEST_VALIDATION_FAILED`.
- **UUIDs:** texto UUID de 36 caracteres; se aceptan mayúsculas y se responden en minúsculas; NIL/MAX son inválidos. En un path, un UUID malformado responde el mismo 404 que uno inexistente.
- **Timestamps:** el POST de firma devuelve `signedAt` en UTC con milisegundos; su resumen de detalle conserva microsegundos de PostgreSQL. Los DTOs de privacidad/recepción y el cierre usan strings UTC con microsegundos, formato exacto `YYYY-MM-DDTHH:MM:SS.ffffffZ` (p. ej. `2026-10-01T15:04:05.123456Z`). Tratarlos como opacos cuando se usan como token de versión.
- **Cache:** las respuestas de negocio de estos endpoints llevan `cache-control: no-store`. Los rechazos previos de autenticación/tenant/RBAC conservan los headers del framework actual; no se cambia su pipeline.
- **Rate limit:** 429 `RATE_LIMIT_EXCEEDED` con header `Retry-After` (segundos).
- **Anti-oráculo:** recursos ajenos al tenant e inexistentes devuelven exactamente el mismo status/code/message.

## 3. Flujo del slice (revisión explícita 2026-10-05)

1. **Cliente y vehículo (CRM, contratos S2):** el `customerId` de la recepción debe ser el **propietario principal vigente** del vehículo (D-PRIV-03). Obtenerlo con `GET /api/v1/vehicles/:vehicleId/owners` (S2-06). Entrega por terceros, representantes o menores: fuera del MVP.
2. **Consentimiento `service_provision` → `privacyConsentId`:**
   1. `GET /api/v1/customers/:customerId/privacy-consents?status=granted&purposeCode=service_provision`.
   2. Si devuelve un elemento: usar su `privacyConsentId` (cliente recurrente; no se vuelve a capturar).
   3. Si está vacío: `GET /api/v1/privacy-notice?purposeCode=service_provision`, **mostrar** `privacyNoticeText`, `authorizationText` y el bloque `controller`, obtener la declaración de mayoría de edad, y `POST /api/v1/customers/:customerId/privacy-consents` reenviando **exactamente** `privacyNoticeVersion` y `authorizationTextVersion` recibidos. Usar `privacyConsent.privacyConsentId` de la respuesta 201.
   4. Las finalidades opcionales (`marketing`, `image_use`, `appointment_reminders`, `service_notifications_whatsapp`) no tienen textos publicados (409 en el paso 3) y nunca condicionan la recepción.
3. **Crear recepción:** `POST /api/v1/receptions` con `vehicleId`, `customerId`, `privacyConsentId`, `mileageKm` (+ opcionales).
4. **Editar mientras está abierta:** `PATCH /api/v1/receptions/:receptionId` y batches `PATCH …/checklist` / `PATCH …/damages` (§5.10), con `expectedUpdatedAt` = último `updatedAt` recibido.
5. **Sin firma digital:** el flujo estándar pasa de la inspección al cierre. No solicita documento de aceptación, captura ni subida R2. Los endpoints §5.6–5.7 se mantienen para compatibilidad con clientes anteriores; no son un requisito del cierre. La evidencia ya registrada conserva sus reglas de retención.
6. **Cerrar:** `POST /api/v1/receptions/:receptionId/close` (sin body) → recepción `closed` + orden de servicio `reception`.

## 4. Privacidad y consentimiento

### 4.1 `GET /api/v1/customers/:customerId/privacy-consents` — NUEVO

Fuente única de un `privacyConsentId` ya existente. Query: `status` (**obligatorio**, único valor admitido `granted`) y `purposeCode` (opcional, código del catálogo). Devuelve los consentimientos **vigentes** del cliente (`status='granted'` y sin `revoked_at`), a lo sumo uno por finalidad (índice parcial `privacy_consents_one_granted_uq`), ordenados por `purposeCode` y luego id. Sin paginación. La captura online acepta las cinco finalidades del catálogo; la garantía de PostgreSQL es una fila vigente por finalidad, sin CHECK que limite el catálogo de finalidades en almacenamiento. Los revocados no se listan (`status=revoked` → 400: no publicado).

```json
200 { "privacyConsents": [ PrivacyConsentDto ] }
```

Errores: 400 `REQUEST_VALIDATION_FAILED` (query); 403 `PERMISSION_DENIED` (técnico); 404 `CUSTOMER_NOT_FOUND` (inexistente, ajeno o malformado: idénticos). Lectura pura: sin locks, escrituras ni auditoría.

### 4.2 `GET /api/v1/privacy-notice` — NUEVO

Query: `purposeCode` (obligatorio). Devuelve las versiones **presentadas para nuevas capturas** ("aviso vigente") y la identidad del Responsable (el taller) construida exactamente como la construye la captura.

```json
200 {
  "privacyNotice": {
    "purposeCode": "service_provision",
    "privacyNoticeVersion": "privacy_notice_es-CO_v1",
    "privacyNoticeText": "Información sobre el tratamiento de datos personales\n\n…",
    "authorizationTextVersion": "service_provision_es-CO_v1",
    "authorizationText": "Autorización para el tratamiento de datos personales — prestación del servicio\n\n…",
    "controller": {
      "legalName": "string", "address": "string", "phone": "string|null",
      "email": "string|null", "rightsChannel": "Correo electrónico: <email>"
    }
  }
}
```

- Textos: UTF-8/NFC/LF, sin salto final; mostrarlos íntegros sin reescribirlos. SHA-256 de los bytes literales: aviso `fd459b09…f474385`, autorización `61b3686e…d361f6` (pins completos en `S3-04-5-RECEPTION-PRIVACY-CONTRACT.md`).
- La versión presentada es un **puntero explícito** en código (`PRODUCTION_PRIVACY_DOCUMENT_PRESENTATION`), nunca "la última" del catálogo. Publicar v2 = añadirla al catálogo **y** mover el puntero; v1 sigue capturable mientras siga publicada.
- No incluye hash, snapshot persistido, bundle ni secretos.

Errores: 400 `REQUEST_VALIDATION_FAILED` (falta/duplicado/clave extra/finalidad desconocida); 403 `PERMISSION_DENIED`; 409 `PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE` (finalidad sin texto publicado: todas salvo `service_provision`); 409 `PRIVACY_NOTICE_NOT_CONFIGURED` (al taller le falta razón social, sede principal con dirección completa, teléfono o email válido — mismo criterio que la captura).

### 4.3 `POST /api/v1/customers/:customerId/privacy-consents` — existente

Body (≤ 16 KiB):

```json
{
  "purposeCode": "service_provision",
  "privacyNoticeVersion": "privacy_notice_es-CO_v1",
  "authorizationTextVersion": "service_provision_es-CO_v1",
  "channel": "in_person",
  "capturedAt": null,
  "adultAttestationConfirmed": true
}
```

- `channel` ∈ `web | in_person | whatsapp | email | phone | import | other`. Para el slice: `in_person`.
- `capturedAt`: opcional/nullable; si se envía, instante RFC 3339 con offset explícito. Evidencia declarada, no autoridad de orden (si se omite, el servidor usa `now()`).
- `adultAttestationConfirmed`: debe ser el literal `true` (D-PRIV-04).
- Texto, hash, snapshot, `rightsChannel`, tenant y status enviados por el cliente → 400 (propiedades desconocidas).

```json
201 { "privacyConsent": PrivacyConsentDto }

PrivacyConsentDto = {
  "privacyConsentId": "uuid", "customerId": "uuid", "purposeCode": "service_provision",
  "privacyNoticeVersion": "string", "authorizationTextVersion": "string",
  "channel": "string", "status": "granted",
  "capturedAt": "timestamp", "createdAt": "timestamp"
}
```

Errores: 400 `REQUEST_VALIDATION_FAILED`; 403; 404 `CUSTOMER_NOT_FOUND`; 409 `PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE` (versión no publicada o no coincide; sin fallback); 409 `PRIVACY_NOTICE_NOT_CONFIGURED`; 409 `PRIVACY_CONSENT_ALREADY_GRANTED` (ya hay uno vigente para esa finalidad → usar §4.1); 413; 415. Persiste el snapshot del Responsable leído **en el momento de la captura** y el hash canónico; audita `privacy_consent.captured` con metadata mínima.

### 4.4 Reglas de `privacyConsentId` (RECEPTION-CONSENT-01 / D-PRIV-01)

- **Origen exacto:** `privacyConsent.privacyConsentId` de §4.3 (201) o `privacyConsents[].privacyConsentId` de §4.1. Nunca se deriva ni se busca implícitamente "el último": `POST /receptions` sin él → 400.
- **Elegible** sólo si: mismo tenant, mismo `customerId` que la recepción, `purposeCode='service_provision'`, `status='granted'`, `revoked_at IS NULL`, y `created_at` del consentimiento ≤ `created_at` de la recepción. No depende de la versión del aviso: un consentimiento vigente capturado con v1 cubre recepciones futuras del mismo cliente hasta que se revoque.
- **Errores al crear la recepción:** inexistente o de otro tenant → 404 `PRIVACY_CONSENT_NOT_FOUND`; otro cliente, otra finalidad, revocado u orden temporal inválido → 409 `PRIVACY_CONSENT_NOT_ELIGIBLE` (un solo código: no revela cuál).
- **Revocación:** no hay ruta HTTP (no existe permiso canónico; DOC_GAP pre-existente). Una revocación (`granted → revoked`, terminal) no altera recepciones existentes, que conservan su `privacy_consent_id` inmutable; deja de listarse en §4.1 y bloquea nuevas recepciones con ese id. Nueva autorización = **nueva fila** vía §4.3. Recuperación del cliente ante 409 `PRIVACY_CONSENT_NOT_ELIGIBLE`: conservar el formulario, re-ejecutar §3 paso 2 (mostrar aviso + nueva captura) y reintentar.
- **Concurrencia:** la creación toma el consentimiento `FOR SHARE`: si la revocación confirma antes, la creación falla con 409; si la creación confirma antes, la recepción es válida y la revocación espera.
- **Snapshot mostrado vs. persistido:** la captura relee el taller; si un admin cambia identidad/contacto del taller entre §4.2 y §4.3, se persiste lo vigente al capturar (riesgo LOW documentado; el snapshot persistido es la autoridad).

## 5. Recepciones

### 5.1 `ReceptionDto` (respuesta de create y PATCH)

```json
{
  "receptionId": "uuid", "vehicleId": "uuid", "customerId": "uuid",
  "appointmentId": "uuid|null", "locationId": "uuid|null",
  "receivedByMembershipId": "uuid",
  "mileageKm": 0, "fuelLevelPct": "integer 0..100|null",
  "customerNotes": "string|null", "advisorNotes": "string|null",
  "status": "open", "receivedAt": "timestamp", "closedAt": null,
  "createdAt": "timestamp", "updatedAt": "timestamp"
}
```

`privacyConsentId` no se expone en ningún DTO de recepción (evidencia de privacidad separada). `receivedByMembershipId` es la membership del usuario autenticado.

### 5.2 `POST /api/v1/receptions`

Body (≤ 16 KiB): `vehicleId`, `customerId`, `privacyConsentId` (UUID, obligatorios), `mileageKm` (entero 0…2147483647, obligatorio); opcionales `appointmentId`, `locationId` (UUID|null), `fuelLevelPct` (entero 0…100|null), `customerNotes`, `advisorNotes` (string|null; Unicode válido, NFC, CRLF/CR→LF, trim, máx. 2000 code points, sin TAB/controles C0-C1/bidi; vacío → null).

`201 { "reception": ReceptionDto }`. Audita `reception.created` (metadata: campos enviados + `privacy_consent_id`).

Errores, en orden de evaluación: 400 `REQUEST_VALIDATION_FAILED`; 404 `VEHICLE_NOT_FOUND` → `CUSTOMER_NOT_FOUND` → `APPOINTMENT_NOT_FOUND` → `LOCATION_NOT_FOUND`; 409 `VEHICLE_OWNERSHIP_CONFLICT` (el cliente no es el propietario principal vigente; no revela quién lo es); 404 `PRIVACY_CONSENT_NOT_FOUND`; 409 `PRIVACY_CONSENT_NOT_ELIGIBLE`; y ya en el INSERT (autoridad PostgreSQL, sin orden relativo contractual entre ambos): 409 `RECEPTION_ALREADY_OPEN` (ya hay una recepción abierta para el vehículo) o 409 `RECEPTION_MILEAGE_CONFLICT` (kilometraje menor al registrado en el vehículo). Además 413; 415.

### 5.3 `GET /api/v1/receptions` (listado — decisión definitiva)

Query: `limit` (1…100, **default 25**), `cursor` (opaco), `status` (`open` | `closed`), `vehicleId`, `customerId` (UUID). Orden: `receptionId` descendente (UUIDv7 ≈ más recientes primero); keyset estable ante inserciones intermedias, sin snapshot global.

```json
200 {
  "receptions": [ {
    "receptionId": "uuid", "vehicleId": "uuid", "customerId": "uuid",
    "mileageKm": 0, "fuelLevelPct": "integer|null", "status": "open|closed",
    "receivedAt": "timestamp", "closedAt": "timestamp|null", "updatedAt": "timestamp"
  } ],
  "nextCursor": "string|null"
}
```

Sólo scope tenant (owner/admin/asesor); un técnico recibe 403 aunque tenga asignaciones. No incluye datos de CRM, consentimiento, firma ni orden: el frontend los obtiene de sus propios endpoints.

### 5.4 `GET /api/v1/receptions/:receptionId`

`200 { "reception": … }`:
- **Scope tenant:** todos los campos de `ReceptionDto` (con `status` `open|closed` y `closedAt` según corresponda) + `checklist` + `damages` + `signature` + `serviceOrder`.
- **Scope assigned** (técnico líder/soporte con asignación activa a la orden de esa recepción): sólo `receptionId`, `vehicleId`, `mileageKm`, `fuelLevelPct`, `status`, `receivedAt`, `closedAt`, `checklist`, `damages`, `signature`, `serviceOrder`.
- `checklist[]`: `checkItemId`, `code`, `label`, `status` (`ok|issue|not_checked|not_applicable`), `notes`, `createdAt`; orden code, id. `damages[]`: `damageId`, `zoneCode`, `damageType`, `severity` (`minor|moderate|severe`), `description`, `createdAt`; orden creación, id. Escritura de ambos mediante §5.10; GET conserva las vistas tenant/assigned y sus DTOs.

Ambas vistas incluyen `signature`: null o `{ signatureId, documentVersion, signedAt }`, y `serviceOrder`: null o `{ id, orderNumber, status }`. `orderNumber` es string decimal exacto (PostgreSQL `order_number::text`), incluso fuera del rango seguro de JS. Abierta sin firma: ambos null; abierta con firma histórica: sólo firma; cerrada: serviceOrder obligatorio y signature nullable. No se incluyen identidad del firmante, media de firma, hashes ni detalles adicionales de la orden. Estados inconsistentes fallan con 500 `INTERNAL_ERROR` sin filtrar el diagnóstico interno; véase S3-07.

Errores: 404 `RECEPTION_NOT_FOUND` (malformado, inexistente, ajeno o no asignado: idénticos); 403; 500 `INTERNAL_ERROR`.

### 5.5 `PATCH /api/v1/receptions/:receptionId` (actualización de recepción abierta)

Body (≤ 16 KiB): `expectedUpdatedAt` (obligatorio, formato exacto de §2) + **al menos uno** de `appointmentId` (UUID|null), `locationId` (UUID|null), `mileageKm` (entero, nunca null), `fuelLevelPct` (0…100|null), `customerNotes`, `advisorNotes` (mismas reglas que create). Omitir un campo lo conserva; `null` lo limpia. `vehicleId`, `customerId`, `privacyConsentId`, `status` y fechas son inmutables (enviarlos → 400).

`200 { "reception": ReceptionDto }`. Sin cambios efectivos (valores normalizados idénticos) → 200 con el DTO actual, sin cambiar `updatedAt` ni auditar. Con cambios → `updatedAt` estrictamente nuevo y auditoría `reception.updated` (`changed_fields`).

Errores: 400 `REQUEST_VALIDATION_FAILED`; 404 `RECEPTION_NOT_FOUND`; 409 `RECEPTION_NOT_EDITABLE` (no está `open`; se evalúa antes del token); 409 `RESOURCE_VERSION_CONFLICT` (token obsoleto); 404 `APPOINTMENT_NOT_FOUND` / `LOCATION_NOT_FOUND`; 409 `RECEPTION_MILEAGE_CONFLICT`; 413; 415.

### 5.6 `GET /api/v1/reception-acceptance-document` — NUEVO

Sin body ni query (cualquier body o clave → 400). `200 { "acceptanceDocument": { "documentVersion": "reception_acceptance_es-CO_v1", "text": "ACEPTACIÓN DE RECEPCIÓN DEL VEHÍCULO\n\n…" } }`. Única versión publicada; SHA-256 de los bytes UTF-8 del texto: `192829413c90bd0a1a58c9301274fa10c608da30e6c4b4c7f38174deea11125e`. El hash no se expone en la respuesta. Errores: 400; 403.

### 5.7 `POST /api/v1/receptions/:receptionId/signature`

Body (≤ 2 KiB): `{ "signatureMediaId": "uuid", "signedByName": "string ≤200", "signedByDocument": "string ≤60|null (opcional)", "documentVersion": "reception_acceptance_es-CO_v1" }`. El firmante es el cliente; el actor auditado es el usuario autenticado.

`201 { "signature": { "signatureId", "receptionId", "signatureMediaId", "documentVersion", "signedAt" } }`.

Errores: 400; 404 `RECEPTION_NOT_FOUND`; 409 `RECEPTION_NOT_EDITABLE` (no `open`); 409 `ACCEPTANCE_DOCUMENT_VERSION_MISMATCH`; 404 `SIGNATURE_MEDIA_NOT_FOUND`; 409 `SIGNATURE_MEDIA_NOT_ELIGIBLE` (no es `signature`, no `active`, retención distinta de `authorization_evidence`, borrada o purgada); 409 `RECEPTION_ALREADY_SIGNED`; 409 `SIGNATURE_MEDIA_ALREADY_USED` (D-SIG-01: un media firma un solo acto); 413; 415.

### 5.8 `POST /api/v1/receptions/:receptionId/close` (cierre)

Sin body ni `Content-Type` (cualquier body, incluso `{}`, → 400).

```json
200 {
  "reception": { "id": "uuid", "status": "closed", "closedAt": "timestamp", "updatedAt": "timestamp" },
  "serviceOrder": {
    "id": "uuid", "receptionId": "uuid", "vehicleId": "uuid", "customerId": "uuid",
    "orderNumber": "decimal string, correlativo por taller", "status": "reception",
    "openedAt": "timestamp", "version": 1
  }
}
```

(Nota: aquí la recepción usa la clave `id`, no `receptionId`, tal como se publicó en S3-06.) No requiere firma digital de recepción (decisión del usuario, 2026-10-05; migración 0024). No revalida consentimiento ni propietario al cerrar. Las firmas históricas y su media siguen conservadas. Actualiza `current_mileage_km` del vehículo si cambió, crea exactamente una orden + historial inicial y audita `reception.closed`, todo atómico.

Errores: 400; 404 `RECEPTION_NOT_FOUND`; 409 `RECEPTION_MILEAGE_CONFLICT`; 500 `RECEPTION_ORDER_INTEGRITY_ERROR` (invariante roto; no reintentar).

### 5.9 Cancelación — NO EXISTE en S3

Decisión canónica vigente (DOC_CONFLICT-01, aceptada en S3-06/S3-07 y en el gate final de Sprint 3): el ciclo operativo de S3 es `open → closed`. `cancelled` existe sólo como valor histórico del esquema. No hay endpoint, permiso (`receptions.cancel` no existe en la matriz RBAC) ni filtro de listado para cancelación; tampoco reapertura (`receptions.reopen` existe en RBAC pero sin comando). Una recepción abierta por error se corrige con PATCH o se cierra; la lógica de anulación queda para una decisión de producto futura (§11-B2).

### 5.10 Escritura de inspección — contrato congelado S3 Final Gaps

- `PATCH /api/v1/receptions/:receptionId/checklist`:
  `{ "expectedUpdatedAt": "YYYY-MM-DDTHH:MM:SS.ffffffZ", "items": [{ "code": "lights", "label": "Luces", "status": "ok", "notes": null }] }`.
  Batch 1…100. Cada item requiere exactamente code/label/status/notes; status `ok|issue|not_checked|not_applicable`. Upsert por `(tenant_id,reception_id,code)` conserva id/createdAt; códigos omitidos se conservan. Code repetido en batch → 400. Code sensible a mayúsculas tras NFC/trim; no se renombra ni elimina.
- `PATCH /api/v1/receptions/:receptionId/damages`:
  `{ "expectedUpdatedAt": "YYYY-MM-DDTHH:MM:SS.ffffffZ", "damages": [{ "operation": "create", "zoneCode": "front", "damageType": "scratch", "severity": "minor", "description": null }, { "operation": "update", "damageId": "uuid", "zoneCode": "rear", "damageType": "dent", "severity": "moderate", "description": "Observación" }] }`.
  Batch 1…100. create requiere exactamente operation/zoneCode/damageType/severity/description, sin ID cliente; update añade damageId obligatorio. No elimina/reemplaza filas: IDs y createdAt conservados. Severity `minor|moderate|severe`. damageId duplicado → 400. ID inexistente/de otra recepción/tenant → 404 `DAMAGE_NOT_FOUND`, mismo mensaje y rollback completo.
- Límites: body ≤64 KiB; code/zoneCode/damageType ≤64 code points, label ≤160 (schema); notas/descripción nullable ≤2000 (límite HTTP como notas de recepción). Unicode válido, NFC, CRLF/CR→LF, trim; sin TAB/controles C0-C1/bidi. Identificadores/label vacíos rechazados; notas/descripción vacías → null. Sin catálogo de códigos inventado. Todas las propiedades son obligatorias; keys extra, enums/UUIDs inválidos, batches vacíos/excesivos → 400 `REQUEST_VALIDATION_FAILED`.
- Permiso tenant `receptions.update_open` para owner/admin/service_advisor; technician assigned → 403 `PERMISSION_DENIED` antes del body. Tenant/actor server-owned.
- Una transacción TenantContext: padre tenant-scoped `FOR NO KEY UPDATE` → open → comparación textual expectedUpdatedAt → hijos → updatedAt estrictamente creciente en PostgreSQL → auditoría → commit. Cada batch aceptado consume versión incluso si repite valores; repetir token → 409 `RESOURCE_VERSION_CONFLICT`. Frente a close, gana quien obtiene el lock primero; escritura posterior al close → 409 `RECEPTION_NOT_EDITABLE` antes del token. Trigger 0019 preservado.
- Éxito 200 `{ "reception": ReceptionDetailDto }`: mismo detalle tenant §5.4, arrays completos y nuevo updatedAt; GET refleja lo confirmado. 404 `RECEPTION_NOT_FOUND` ajeno/inexistente/malformado indistinguible. Envelope/no-store/413/415/JSON malformado según §2.
- Auditoría atómica `reception.checklist_updated` / `reception.damages_updated`, entidad reception, actor/request/IP como PATCH, metadata sólo count. Sin notas/descripción/PII, secretos ni URLs. Rollback sin auditoría de éxito.

## 6. Idempotencia y política de reintentos

No se usa `Idempotency-Key` en ninguno de estos endpoints (el header se ignora; probado). Cada comando se protege con su clave natural, y una respuesta perdida se recupera así:

| Comando | Reintento tras timeout / 5xx / red | Resultado del reintento si el primero confirmó | Recuperación |
| --- | --- | --- | --- |
| §4.3 captura | Seguro | 409 `PRIVACY_CONSENT_ALREADY_GRANTED` | §4.1 devuelve el mismo `privacyConsentId` |
| §5.2 create | Seguro (mismo vehículo) | 409 `RECEPTION_ALREADY_OPEN` | `GET /receptions?vehicleId=…&status=open` → la recepción creada |
| §5.5 PATCH | Seguro (OCC) | 409 `RESOURCE_VERSION_CONFLICT` | `GET /receptions/:id`; si los valores ya están aplicados, terminado; si no, reintentar con el `updatedAt` nuevo |
| §5.10 inspección | Seguro (OCC, reenviar exactamente el mismo batch/token) | 409 `RESOURCE_VERSION_CONFLICT` | GET devuelve arrays e IDs confirmados; reconciliar antes de generar otro create de daño con token nuevo |
| §5.7 firma | Seguro | 409 `RECEPTION_ALREADY_SIGNED` | Consultar el resumen de firma en §5.4 y continuar con el cierre |
| §5.8 close | **Idempotente** | 200 con el **mismo** body (orden, número y timestamps idénticos; sin nueva auditoría) | — |
| GETs | Seguros | — | — |

Cada request corre en una única transacción PostgreSQL: un 4xx/5xx no deja escrituras parciales. Reintentos automáticos: sólo ante error de red, 5xx distinto de `RECEPTION_ORDER_INTEGRITY_ERROR`, o 429 (respetando `Retry-After`), con backoff. Nunca reintentar automáticamente un 4xx.

## 7. Concurrencia y versionado

- **Versionado optimista:** `updatedAt` de cualquier DTO de recepción es el token opaco para `expectedUpdatedAt`. No hay campo `version` en recepciones (la orden de servicio sí trae `version`).
- **Una recepción abierta por vehículo:** índice único parcial; dos creates simultáneos para el mismo vehículo → uno 201 y otro 409 `RECEPTION_ALREADY_OPEN`. Tras el cierre, el vehículo puede recibirse de nuevo.
- **Orden de locks:** create = vehículo → propietario → consentimiento (`FOR SHARE`) → INSERT; PATCH / firma / close = recepción → vehículo (→ lock de numeración en close). Cambio de propietario concurrente: si gana el cambio, el create del cliente anterior falla con 409 `VEHICLE_OWNERSHIP_CONFLICT`.
- Close compite con PATCH y firma bajo el lock de la recepción: si close confirma primero, PATCH/firma reciben 409 `RECEPTION_NOT_EDITABLE`.

## 8. Permisos (RBAC — Matriz v1, sin chequeos por nombre de rol)

| Permiso | Owner | Admin | Asesor de servicio | Técnico |
| --- | --- | --- | --- | --- |
| `receptions.read` | T | T | T | A (sólo detalle §5.4, vista restringida) |
| `receptions.create`, `receptions.update_open`, `receptions.close` | T | T | T | — (403) |
| `signatures.capture` (§5.6, §5.7) | T | T | T | — |
| `privacy_consents.capture` (§4.2, §4.3) | T | T | T | — |
| `privacy_consents.read` (§4.1) | T | T | T | — |

T = scope tenant; A = scope assigned. `receptions.read` no otorga `customers.read`, `vehicles.read`, `signatures.read` ni `orders.read`. Las acciones del frontend deben derivarse de los permisos efectivos de `GET /api/v1/me/context`, no del nombre del rol.

## 9. Relación con customer y vehicle

- `vehicleId` y `customerId` deben existir en el tenant; son inmutables tras crear.
- `customerId` = propietario principal vigente al crear (D-PRIV-03); un cambio de propietario posterior no reinterpreta recepciones existentes.
- El consentimiento pertenece al cliente (no al vehículo): un consentimiento vigente cubre recepciones de cualquiera de sus vehículos.
- El kilometraje de la recepción no puede ser menor que `vehicles.current_mileage_km`; el cierre actualiza ese snapshot.

## 10. Discrepancias encontradas y resolución

| Id | Tipo | Hallazgo | Resolución |
| --- | --- | --- | --- |
| RC-01 | DOC_GAP | Ningún mecanismo online definía cómo obtener el aviso "vigente" y la identidad del Responsable que el Diccionario 05 §1.1 exige mostrar (el bundle es sólo offline, ADR-005/Sprint 13). | **NUEVO** §4.2 con puntero explícito de versión presentada; mismo builder de snapshot que la captura. |
| RC-02 | DOC_GAP (bloqueante) | Un cliente recurrente (consentimiento vigente único por finalidad) no tenía forma de obtener su `privacyConsentId`: la captura respondía 409 y no había lectura. | **NUEVO** §4.1 con el permiso existente `privacy_consents.read`. |
| RC-03 | DOC_GAP | La firma exige mostrar el texto de aceptación y enviar su `documentVersion`, pero no había lectura. | **NUEVO** §5.6. |
| RC-04 | DOC_CONFLICT-01 (pre-existente) | Notion/extracto frontend lista DTOs de "cancel"; backend canónico S3: sin cancelación. | Se mantiene la decisión canónica; §5.9. Actualizar el extracto de Notion. |
| RC-05 | DOC_CONFLICT | Notion §13: "`Idempotency-Key` en operaciones sensibles"; ningún endpoint de recepción/privacidad lo implementa. | Prevalece el contrato específico (como CRM D-22): idempotencia por clave natural, §6. Registrar en Notion. |
| RC-06 | DOC_CONFLICT | Notion §13 (formato S2-02): `limit` default 20; recepciones (S3-07, código) default 25. | Prevalece el contrato específico S3-07 (25, máx. 100). Registrar la excepción en Notion. |
| RC-07 | Código obsoleto | Comentarios en `server.ts` y `privacy/routes.ts` decían que la copia de privacidad no estaba publicada (falso desde Privacy v1). | Corregidos. |
| RC-08 | INFO | Close devuelve `reception.id` mientras los demás DTOs usan `receptionId`. | Congelado tal como se publicó en S3-06; documentado en §5.8. |
| RC-09 | INFO | Rutas inexistentes devuelven el 404 por defecto de Fastify, no el envelope estable. | Comportamiento genérico pre-existente; fuera de alcance. |

## 11. Decisiones o dependencias todavía bloqueantes

- **B1 — Wiring Media/R2 resuelto:** el entrypoint productivo registra exactamente `registerMediaRoutes` y exige las cinco variables R2 antes de abrir el pool; una configuración incompleta falla con `R2_CONFIGURATION_MISSING`. Endpoints: `POST /api/v1/media/upload-sessions`, `POST /api/v1/media/upload-sessions/:id/complete`, `GET /api/v1/media/:id/download-url`. Se conservan RBAC tenant, RLS, rate limit de upload, URLs firmadas y PUT write-once `If-None-Match: *`. **R2 External Gate permanece OPEN**: faltan tres ejecuciones externas consecutivas sobre el SHA final; resolver el wiring no cierra ese gate ni Sprint 3.
- **B2 — Cancelación/anulación:** si S3-B08 la necesita, requiere decisión de producto + permiso RBAC nuevo + transición en el trigger de ciclo de vida (migración). Hoy no existe (§5.9).
- **B3 — Checklist y daños resuelto en backend:** contrato §5.10 y rutas batch con IDs estables, OCC, RBAC tenant y auditoría atómica. Frontend checklist/daños, E2E mobile frontend+backend y cierre documental siguen pendientes; no se declara Sprint 3 PASSED.
- No bloqueantes para el slice: revocación por HTTP (sin permiso canónico), bundle/sincronización offline (ADR-005), lectura independiente de la firma. El detalle de recepción ya incluye su resumen mínimo (§5.4).

## 12. Preservación de evidencia y reconciliación

La migración 0023 y su preflight no cambian. Media de firma: `signature`, `active`, `authorization_evidence`, sin borrado ni purga. Tras firmar, se permite `active → quarantined` y se conserva la evidencia histórica y su resumen; la retención permanece inmutable. El GET del documento de aceptación usa el mismo `receptionAcceptanceDocument` que valida la firma y no escribe evidencia.

DOC_CONFLICT histórico resuelto: el documento de `daff672` omitía los resúmenes actuales de detalle y la retención de 0023. Se corrige documentación/cobertura; se preserva la implementación actual. No se encontró conflicto entre las lecturas históricas de privacidad y la configuración vigente de producción. GET y captura comparten catálogo, resolución exacta y `currentControllerNotice`, incluyendo la validación del email y el teléfono alternativo de sede.

## 13. Sincronización pendiente

Sincronización externa pendiente: enlazar este contrato desde Notion (Arquitectura Técnica v1 §13 y Diccionario 05 §1.1) y el extracto `reception-and-media-contract-status.md` del frontend, registrando RC-01…RC-06. Esta reconciliación no accede a Notion ni modifica el frontend.
