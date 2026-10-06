# S4-B01 Media Contract

## 1. Status and scope

**Versión:** S4-B01 v1, 2026-10-06. Contrato backend normativo para revisión; no certifica que B02–B09 estén implementados. Cambiar una regla congelada exige revisión y actualización explícita de esta versión. `IMPLEMENTATION_GAP` identifica diferencias del runtime; `RESERVED/UNRESOLVED` prohíbe inventar una regla de producto al implementar.

Baseline verificado antes de editar: checkout principal `main`, HEAD `e3d9e5469ed5e0b7152e1bdbbdec53e16bd6d836`, `git status --short` vacío. Se reutiliza el worktree limpio `task/s4-b01-media-contract`, mismo HEAD, después de `git worktree list` y lectura completa de AGENTS.md. S4-B00 se consultó en el chat **Auditar brechas de media Sprint 4**; no existe informe B00 versionado local. Sus propuestas no sustituyen las fuentes siguientes.

Autoridad: extractos canónicos suministrados en S4-B01, [Arquitectura §8/§13, ADR-003 aceptada](<Proyecto Aplicaciones para Talleres Bogota/Arquitectura Técnica v1 — TallerMecario 3de6ab0a330d817ab78bcbd88c100e5a.md>), [ERD, Media y enlaces](<Proyecto Aplicaciones para Talleres Bogota/Arquitectura Técnica v1 — TallerMecario/Modelo de Datos ERD v1 — PostgreSQL 3df6ab0a330d81fda465f8944c3291e6.md>), [Operación §2/§3.5](<Proyecto Aplicaciones para Talleres Bogota/Arquitectura Técnica v1 — TallerMecario/Operación, Retención, Recuperación y Observabilida 3e06ab0a330d819ea376f6f7628679f6.md>), [RBAC §6](<Proyecto Aplicaciones para Talleres Bogota/Arquitectura Técnica v1 — TallerMecario/RBAC — Matriz completa de roles y permisos v1 3e06ab0a330d81d398ffe925a65506c8.md>), [Security Baseline §14](<Proyecto Aplicaciones para Talleres Bogota/Arquitectura Técnica v1 — TallerMecario/Security Baseline — Aplicación y Plataforma 3e06ab0a330d81cc932dc2c9725121e7.md>) y [contrato vigente de recepción §3/§5.8](api/reception-contract.md).

Los archivos completos enlazados de ADR-003 y Diccionario 03 no están presentes. Los extractos del ticket y la aclaración canónica del usuario en este chat (2026-10-06) permiten congelar transporte y estructura de enlaces: Diccionario 03 define purpose varchar(48), sin enumerar valores; Security Baseline exige duración, sin máximo numérico. El usuario confirma reservar ambas constantes sin bloquear B01 (§4/§5). **Procedencia:** el agente de implementación no accedió a Notion directamente. Los extractos canónicos de fuentes ausentes del repositorio local fueron consultados en Notion y suministrados explícitamente a través del chat de revisión de S4-B01. Evidencia del runtime: [rutas](../src/media/routes.ts), [servicio](../src/media/service.ts), [R2](../src/media/r2.ts), [schema](../src/db/schema.ts), [firma](S3-05-reception-signature.md) y migraciones [0022](../drizzle/0022_s3_05_signed_media_quarantine.sql), [0023](../drizzle/0023_s3_reception_signature_retention.sql), [0024](../drizzle/0024_reception_close_without_signature.sql).

## 2. Canonical lifecycle

Media: `pending_upload → uploaded → active` o `pending_upload → uploaded → quarantined`. `uploaded` significa objeto confirmado presente, no contenido aprobado. `uploaded_at` lo fija el servidor una sola vez; `captured_at` no inicia retención. Un asset activo puede pasar a cuarentena por un hallazgo posterior; en media firmada se conserva la excepción de 0022/0023 y no se permite reactivación automática.

Estados existentes, sin nuevos enums: `pending_upload`, `uploaded`, `active`, `quarantined`, `deleted`. Delete/purge es un lifecycle separado (§11); `purged_at` es un marcador, no un sexto estado. Sesiones: `pending`, `completed`, `expired`, `failed`; `completed` exige `completed_at`. No reabrir sesiones fallidas/expiradas. Auditar creación, completion, cuarentena, asociaciones, retención/holds y eliminación con actor, tenant, IDs, resultado y request/job ID; replay no duplica auditoría de éxito.

PostgreSQL mantiene metadata y autoridad tenant; bucket R2 privado mantiene binarios. API no recibe/proxy el body grande. Object keys son internas, opacas y sin PII necesaria; no constituyen autorización. Las FKs compuestas, RLS y checks existentes siguen siendo obligatorios. Una comparación de tenant solo en aplicación no los sustituye.

## 3. Upload session contract

Se preserva `POST /api/v1/media/upload-sessions`. Tenant/actor provienen de TenantContext verificado. B01 no modifica el body publicado, que exige `mediaType`, `mimeType`, `retentionClass`, `idempotencyKey`; `expectedSizeBytes` y `capturedAt` son hoy opcionales. No se introduce un header de idempotencia paralelo.

| Campo | Semántica congelada para implementación |
| --- | --- |
| `mediaType` | Uno de `photo`, `video360`, `video`, `signature`, `quote_pdf`, `document`; sin nuevos tipos. |
| `mimeType` | MIME esperado exacto de la tabla siguiente; persistido y firmado en `Content-Type`. No aceptar parámetros/aliases no publicados. |
| `idempotencyKey` | UUID del cliente, único por tenant y operación create; mismo payload semántico según §6. No acredita identidad ni assignment. |
| `expectedSizeBytes` | Tamaño exacto final que irá en PUT, entero positivo dentro del límite del tipo. B02 debe exigirlo para sesiones nuevas, persistirlo y compararlo; hoy solo se valida si llega y no se persiste. Sesiones antiguas sin expectativa no pueden declararse validadas bajo v1: vencerlas/reiniciar con clave nueva, sin inferir la expectativa desde HEAD. |
| `capturedAt` | Timestamp RFC 3339 opcional declarado por cliente; ausencia = sin dato. Normalizar el instante a UTC para equivalencia. No usarlo como reloj de permisos, expiry, uploaded_at o retención. |
| `retentionClass` | Modelo **B: aceptación únicamente bajo matriz estricta**, nunca autoridad libre sobre política/TTL. Reglas abajo; cambiar comportamiento corresponde a B02/B04/B05. |

Se congelan los límites efectivos actuales de `src/media/service.ts` como baseline técnico de v1 (MiB = 1,048,576 bytes), sin atribuir estos números a una fuente de producto ausente:

| Tipo | MIME permitido | Máximo bytes | Clase que puede solicitar el cliente en upload genérico |
| --- | --- | ---: | --- |
| `photo` | `image/jpeg`, `image/png`, `image/webp` | 20,971,520 | `operational` |
| `video360` | `video/mp4`, `video/quicktime` | 786,432,000 | `operational` |
| `video` | `video/mp4`, `video/quicktime` | 524,288,000 | `operational` |
| `signature` | `image/png` | 2,097,152 | `authorization_evidence` |
| `quote_pdf` | `application/pdf` | 20,971,520 | `document` |
| `document` | `application/pdf`, `image/jpeg`, `image/png` | 20,971,520 | `document` |

Todas las demás parejas tipo/clase se rechazan con `RETENTION_CLASS_NOT_ALLOWED`. `ephemeral_upload` **no** es un permiso del cliente para elegir TTL ni la clase automática de todo asset pendiente: un asset pendiente conserva la `retention_class` objetivo ya validada (p. ej. `operational` para `photo`) y no hay reclasificación silenciosa pendiente→operacional. `ephemeral_upload` queda disponible solo para flujos de asset efímero explícitamente definidos (hoy ninguno en esta matriz). La limpieza de incompletos (§7/§10) se rige por el estado y los timestamps de `upload_session`, no por `retention_class`. `warranty_evidence`/`delivery_evidence` requieren evidencia de dominio comprobada y decisión server-side al asociar; el endpoint genérico no permite solicitar esas clases. No reclasificar silenciosamente filas históricas, especialmente firmas. Las clases siguen existiendo en schema aunque no sean solicitables libremente.

La matriz no otorga 36 meses a una imagen solo por etiquetarla `signature`: sin vínculo real aplica el baseline de activo no asociado de §10. Una recepción/foto nunca obtiene `authorization_evidence` mediante el campo del cliente; la asociación valida tipo, propósito y dominio además de clase. `retention_until`, versión de política y holds son siempre del servidor.

Respuesta publicada de create/replay pendiente: `201 { uploadSessionId, mediaAssetId, status: "pending", uploadUrl, uploadMethod: "PUT", uploadHeaders, objectKey, expiresAt }`. `expiresAt` significa vencimiento lógico de sesión; el vencimiento de cada URL se limita por §7. Conservar `Content-Type` y `If-None-Match: *` firmados, misma key para replay y key nueva para sesión nueva ([S3-02](S3-02-R2-EVIDENCE-INTEGRITY.md)). `objectKey` publicado se trata como dato opaco por compatibilidad; nunca en errores/logs. La URL solo aparece en la respuesta de éxito autorizada.

**IMPLEMENTATION_GAP:** hoy cualquier clase enumerada combina con cualquier tipo; falta persistencia/obligatoriedad del tamaño esperado y equivalencia del payload. B02/B03/B04/B05 deben cerrar estos gaps sin afirmar que B01 cambia runtime.

**Precondición de upload operacional (§12.1):** para `photo`, `video` y `video360` operacionales, la emisión del PUT firmado exige contexto de dominio verificado para TODOS los roles. El body genérico actual no lo transporta (**CONTRACT GAP**, S4-B04/S4-B07). Hasta cerrarlo, B02/B03 no pueden declarar completo el camino de upload operacional.

## 4. Media type / purpose / retention matrix

`purpose` es hoy `varchar(48) NOT NULL`, parte de la PK, sin catálogo/check canónico en schema/docs disponibles. Las descripciones humanas de esta tabla **no son strings de API**. `RESERVED/UNRESOLVED` exige el extracto canónico del usuario antes de habilitar esas finalidades en B04; no usar valores de fixtures como autoridad ni aceptar texto arbitrario.

| media_type | Dominio / uso | purpose de enlace | retention_class | Estado permitido del parent | Quién puede asociar | Reloj |
| --- | --- | --- | --- | --- | --- | --- |
| `photo` | `reception_media`, evidencia general | RESERVED/UNRESOLVED | `operational` | `open` conforme mutación de recepción S3; `closed`/`cancelled` no habilitados | `media.upload` tenant o assigned comprobado, sujeto a elegibilidad del parent | orden relacionada `delivered`/`cancelled` + 12 meses |
| `video360` | `reception_media`, evidencia general | RESERVED/UNRESOLVED | `operational` | igual | igual | igual |
| `video` | `reception_media`, evidencia general | RESERVED/UNRESOLVED | `operational` | igual | igual | igual |
| `photo` | `damage_media`, evidencia de daño | RESERVED/UNRESOLVED | `operational` | daño existente con recepción `open` | igual, resolviendo recepción del daño | orden relacionada `delivered`/`cancelled` + 12 meses |
| `video` | `damage_media`, evidencia de daño | RESERVED/UNRESOLVED | `operational` | igual | igual | igual |
| `signature` | acto de firma de recepción en `signatures` | No aplica: no es purpose de galería | `authorization_evidence` | recepción `open` | `signatures.capture`: owner/admin/service_advisor | `signatures.signed_at` + 36 meses |
| `quote_pdf` | `quote_media`, versión exacta de cotización | RESERVED; flujo futuro excluido | `document`; baseline especial de PDF 36 meses | RESERVED/UNRESOLVED | No habilitado por B04 | evento de autorización/estado terminal correspondiente; exacto UNRESOLVED (B05) |
| `document` | documento genérico / dominio aún no aprobado | RESERVED/UNRESOLVED | `document` | RESERVED/UNRESOLVED | No habilitado por B04 | sin vínculo: uploaded_at + 30 días; vinculado: política UNRESOLVED (B05) |

B04 puede construir garantías tenant, elegibilidad, idempotencia, ordenamiento y lecturas para las cinco filas de recepción/daño, pero no publicar una finalidad hasta resolver su string canónico. `video360` en daños, firma en galería, PDF/documento en recepción/daño y combinaciones no listadas no quedan autorizadas por este contrato. No ampliar mutaciones a recepción cerrada para hacer funcionar assigned; cualquier necesidad posterior requiere contexto canónico y revisión de v1. El permiso assigned no evita estas restricciones de estado (§12).

Garantía/autorización/entrega conservan sus baselines de §10 cuando exista vínculo de dominio probado; este ticket no inventa purposes, captura de garantías ni rutas de dominios futuros.

## 5. Completion and integrity semantics

Identidad canónica: **upload session**. `POST /api/v1/media/upload-sessions/:id/complete` recibe `uploadSessionId`, no `mediaAssetId`. Body actual: objeto opcional con `checksumSha256` opcional; éxito `200 { mediaAssetId, status: "active", sizeBytes, checksumSha256 }`. B01 no añade respuestas async ni renombra campos.

Antes de activar una sesión nueva bajo este contrato, B02 debe satisfacer conjuntamente:

1. Sesión/asset del tenant y actor autorizado; sesión pendiente y no vencida al confirmar la transición (§7), sin marcadores de delete/purge.
2. Objeto encontrado mediante key/bucket obtenidos exclusivamente de metadata interna. HEAD ausente → `UPLOAD_NOT_FOUND_IN_STORAGE`, sesión pendiente y retry dentro de lifetime; un PUT `412` no demuestra completion.
3. Tamaño real entero positivo, dentro de allowlist y **exactamente igual** al esperado persistido. `size_bytes` guarda el tamaño real validado. HEAD sin tamaño utilizable no activa.
4. `Content-Type` R2 presente y exactamente igual al MIME esperado permitido/persistido y al firmado. Metadata MIME ausente/incompatible no activa. `Content-Type` y extensión no demuestran el tipo real del binario.
5. Validación confiable del formato/contenido real compatible con tipo/MIME según Security Baseline §14: contenido corrupto, otro formato o hallazgo de contenido peligroso → cuarentena. Si se necesita proceso dedicado que lea bytes desde R2, queda como gap B02; el API sigue sin hacer proxy de la carga. No asumir que HEAD realiza escaneo o que SigV4 `UNSIGNED-PAYLOAD` autentica bytes.
6. Para `video`/`video360`, Security Baseline §14 exige límite de duración. **DURATION_POLICY_UNRESOLVED:** faltan valor/unidad por tipo y método confiable de medición; no inventar segundos ni omitir esta condición al declarar integridad completa. B02 puede implementar las validaciones independientes, pero no debe implementar rechazo por duración hasta una decisión contractual explícita del máximo; el gate de duración permanece pendiente, sin presentarlo como satisfecho. No añadir una garantía de que un video contiene realmente una captura 360° sin requisito y validador aprobados.

**Checksum declarado:** `checksumSha256` enviado por cliente, objetivo 64 caracteres hex SHA-256, normalizado a minúsculas. Hoy solo se comprueba longitud 64 y se guarda en `checksum_sha256`; no existe prueba de bytes. Campo de respuesta/DB actual mantiene significado **declarado/no verificado**, incluidos históricos.

**Checksum verificado:** digest calculado sobre bytes por proceso confiable, o comprobación de proveedor acreditada para algoritmo, operación y semántica concretos. Requiere evidencia persistida de algoritmo, valor, método, objeto y momento de verificación, separada de la declaración. Nunca elevar históricos a verificados ni usar ETag como SHA-256. ETag sirve como identificador opaco de versión/observación; no hay comparación segura con el SHA-256 declarado por su mera presencia. Los ETags multipart tienen semántica propia ([Cloudflare: upload/ETags](https://developers.cloudflare.com/r2/objects/upload-objects/)); comprobar soporte concreto de checksums antes de usarlo ([compatibilidad S3 R2](https://developers.cloudflare.com/r2/api/s3/api/)).

v1 no hace obligatorio un checksum criptográfico verificado para activar cuando todas las demás validaciones se satisfacen y no se declara esa garantía. Si se aporta declaración sin mecanismo confiable, permanece explícitamente no verificada. Cuando un mecanismo confiable produce un digest comparable y difiere del declarado, no activar: `MEDIA_METADATA_MISMATCH` y cuarentena. Esto verifica concordancia con la declaración, no identidad del autor ni seguridad del contenido.

Objeto confirmado inválido → `uploaded → quarantined`, sesión `failed`, metadata/razón y auditoría durables aunque HTTP sea 422; no usar `completed` ni `completed_at` para failure. Timeout/5xx/validación técnica no disponible → error recuperable seguro, pendiente sin falsa cuarentena ni active. Activación y `completed`/`completed_at`, observaciones de integridad y auditoría deben confirmar atómicamente. Si no pueden terminar las validaciones confiables, no responder active. No hay nuevo estado de enum por esta regla.

**IMPLEMENTATION_GAP B02:** runtime valida existencia/rango, ignora Content-Type/ETag, no compara tamaño esperado, guarda checksum declarado y no inspecciona contenido/duración. Faltan expectativas y evidencia de validación confiable; si requieren columnas/proceso, B02 diseña la migración allí. Persistir inicio de cuarentena es dependencia B02/B05 para el reloj de 7 días.

## 6. Idempotency and concurrency semantics

Equivalencia create: mismo tenant + key + tipo/MIME exactos + clase admitida + tamaño esperado + capturedAt normalizado (ausencia = ausencia). Con contexto de recurso futuro, dominio/target/purpose verificados también forman parte del payload. No incluir URL firmada ni timestamps generados por servidor en la huella. Revalidar permisos en cada replay; la key no concede acceso a otro actor.

| Caso | Resultado congelado |
| --- | --- |
| Create, misma key/payload, pendiente vigente | Misma sesión, asset, key y expires_at; puede renovar PUT limitado al tiempo restante. 201 publicado. |
| Create, misma key/payload, completed | 409 `UPLOAD_SESSION_ALREADY_COMPLETED`; misma operación lógica, sin nueva sesión ni PUT. No cambiar el éxito publicado de create por un DTO distinto. |
| Create, misma key/payload, expired/failed | 409 `UPLOAD_SESSION_EXPIRED` / `UPLOAD_SESSION_FAILED`; clave nueva para otra operación. |
| Create, misma key/payload incompatible | 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`, incluso si la sesión ya terminó; validar permiso antes de revelar estado. |
| Create concurrentes equivalentes | Una pareja asset/sesión y una auditoría; perdedor observa ganador confirmado. UNIQUE tenant/key permanece backstop, sin SQL 500 por contención esperada ni asset huérfano por rollback parcial. |
| Complete repetido equivalente | Retorna resultado persistido sin HEAD obligatorio, sin reescritura de checksum/tamaño/uploaded_at/completed_at/audit. Si hoy asset ya no está active, mantener 409 `MEDIA_ASSET_NOT_ACTIVE`; delete markers lo hacen no disponible. |
| Complete repetido incompatible | 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`. La equivalencia incluye declaración de checksum normalizada y ausencia frente a presencia; no permite reemplazarla después. |
| Complete concurrentes equivalentes/incompatibles | Un solo ganador de transición; segundo devuelve resultado persistido o conflicto según payload. Failed/expired no se convierten en completed. |

Completar usa identidad de sesión como operación idempotente; no crea otra key. Las operaciones con validaciones de formato inválidas siguen el envelope 400/422 aplicable antes de comparar una huella válida. B03 implementa serialización/locks/transiciones condicionales y rollback conjunto; no basta SELECT seguido de INSERT. Crear/complete/attach/delete/hold/purge deben compartir protocolo de coordinación sobre el asset para que una finalización no reactive uno eliminado.

**IMPLEMENTATION_GAP B03:** no hay huella/comparación de payload ni control de create/complete concurrentes. Añadir auditoría transaccional y outcomes durables, R2 con timeout/retry acotado y error recuperable; no reintentar en bucle con transacción fallida.

## 7. Expiration semantics

| Concepto | Regla v1 |
| --- | --- |
| Signed PUT capability | TTL máximo actual 900 s; cada emisión/renovación usa `min(900, floor(segundos restantes hasta expires_at))`. No emitir si resulta <1. Vencimiento firmado ≤ expires_at, incluso con truncamiento/precisión de SigV4. |
| Upload session | Lifetime inicial actual 900 s desde creación server-side; expires_at inmutable por replay. `now >= expires_at` impide nuevo PUT/completion, aunque fila siga pending o el objeto se haya cargado antes. Revalidar antes de confirmar completion tras HEAD/inspección. |
| Cleanup incompleto | Baseline 24 h, independiente de autorización y **de `media_assets.retention_class`**: lo gobiernan el status y los timestamps de `upload_session`, no la clase del asset (§3: el pendiente conserva su clase objetivo). Para v1 se fija reloj reproducible `upload_sessions.created_at + 24 h` (elección operacional admitida por el baseline creación/expiración); holds suspenden purge. No extender la sesión ni permitir completion durante esas 24 h. |

Expiry de URL puede ocurrir antes que expiry lógico de sesión: solo permite obtener otra URL dentro del lifetime restante. URL vencida nunca da permiso por no haberse ejecutado cleanup. Una sesión ya completada permite replay de resultado aunque su antiguo expires_at haya pasado, sin validar/activar otra vez ni emitir PUT. La limpieza física puede retrasarse por hold/fallo; nunca altera las reglas de permiso.

**IMPLEMENTATION_GAP B03/B05/B06:** renovación actual fija otros 900 s, solo chequea expiry antes de HEAD, cleanup no implementado. No borrar físicamente una key mientras queden PUT capabilities válidas que pudieran recrearla; B06 debe coordinar el purge con expiry lógico y la ventana máxima de capacidades históricas emitidas por el runtime anterior.

## 8. Reception and damage association contract

B04 implementará únicamente `reception_media` y `damage_media` sobre tablas existentes. No introduce `media_links` polimórfica. Lectura agregada por orden puede unir enlaces reales, preservando tenant y permisos de cada recurso.

- Parent debe existir en tenant autenticado: recepción `open`, o daño real cuyo `reception_id` lleva a recepción `open`, conforme §4/S3. Cerrar/cancelar no permite nueva asociación bajo v1; lecturas históricas sí conservan enlaces. No reinterpretar que el esquema admita `cancelled` como permiso de mutación operativo.
- Asset del mismo tenant, `active`, sin `deletion_requested_at`, `deleted_at`, `purged_at`, tipo/clase/purpose admitidos por §4. No asociar pending/uploaded/quarantined ni revivir deleted/purged. `purpose` reservado no se habilita con un valor ad hoc.
- Escritura autenticada con `media.upload` y elegibilidad/autorización concreta del parent; lectura con `media.read`. TenantContext y RLS en todas las consultas; FKs `(tenant_id,target_id)` y `(tenant_id,media_asset_id)` reales, sin IDs de cliente usados como tenant truth.
- `sort_order`: entero PostgreSQL 0…2,147,483,647; por defecto 0. Índices `(tenant_id,media_asset_id)` y `(tenant_id,target_id,sort_order)` existentes no dan unicidad al orden. Empates permitidos; lectura determinista por `sort_order`, `media_asset_id`, `purpose`. No inventar un límite de cantidad.
- Identidad del enlace: `(tenant_id,target_id,media_asset_id,purpose)`, como PK existente. Repetirla con mismo sort_order devuelve el enlace persistido, sin duplicar audit/retención. Diferente sort_order → 409 `MEDIA_ASSOCIATION_CONFLICT`; no convertir replay en reorder implícito. Otra finalidad requiere aprobación de esa combinación, no un truco para eludir duplicados. Retrys se identifican por esa identidad; un comando futuro de reorder requiere contrato propio.
- Una transacción valida/serializa parent y media, inserta enlace, recalcula/compromete retención y audita. Debe coordinar close (lock de recepción antes de media como firma), attach/delete y holds (§11), respetando orden global de locks. Guardar solo el enlace y diferir la protección de retención dejaría una carrera inadmisible.

**IMPLEMENTATION_GAP B04/B05:** sin servicios/rutas/lecturas de enlaces, sin catálogo purpose, sin guards de estado/compatibilidad ni recalculación. Las FKs/PK/check sort_order existentes son necesarias, pero no cubren todo el contrato. No se crean rutas ni constraints en B01.

## 9. Download/access contract

`GET /api/v1/media/:id/download-url` exige `media.read` y recurso autorizado. Nueva signed GET se deniega si falta asset, tenant incorrecto, status distinto de active, o cualquiera de `deletion_requested_at`, `deleted_at`, `purged_at` está presente. Tenant ajeno y faltante tienen la misma respuesta segura; los marcadores hacen el asset no disponible incluso con status stale active. Lecturas de galería no son atajos para generar URLs.

Conservar respuesta de éxito `200 { mediaAssetId, downloadUrl, expiresAt }` y TTL máximo actual **300 s**. Serializar emisión/autorización con delete: si deletion request confirmó primero, no emitir; si emisión ganó, esa capacidad fue emitida antes del bloqueo. Signed URLs ya emitidas son capacidades temporales y no se garantiza revocación instantánea sin otra arquitectura; deben expirar pronto. No devolver bucket/key/URL en errores o auditoría.

**IMPLEMENTATION_GAP B06/B07:** download actual revisa deleted_at/status, no deletion_requested_at ni purged_at explícito, ni assignment. El CHECK de purge exige deleted_at y ofrece defensa indirecta, no sustituye las condiciones contractuales.

## 10. Retention and hold contract

| Caso | Baseline / reloj server-side |
| --- | --- |
| pending/incomplete | 24 h desde `upload_sessions.created_at` (§7); dirigido por status/timestamps de la sesión, independiente de `retention_class`. El asset pendiente puede conservar su clase objetivo validada; no se implica que sea `ephemeral_upload` ni reclasificación silenciosa pendiente→operacional |
| active sin vínculo de dominio | 30 días desde uploaded_at |
| quarantined sin incidente/hold | 7 días desde entrada efectiva a cuarentena |
| photo/video/video360 operacional asociado | 12 meses calendario desde evento real de orden delivered/cancelled |
| warranty media probado | max(baseline operacional, warranty_expires_at + 90 días) |
| signature / quote PDF / authorization / delivery evidence | default producto 36 meses calendario desde acto de autorización/firma/entrega o estado terminal correspondiente; firmas de recepción usan signed_at. Eventos de flujos futuros y documento genérico vinculado quedan UNRESOLVED, no usar uploaded_at como sustituto. |
| `privacy_consents.evidence_media_id` | Evidencia de autorización: recibe el baseline de producto de **36 meses** (calendario) como authorization evidence, sujeto a holds/contrato/requisito legal más estrictos. Reloj exacto: **RESERVED/UNRESOLVED** (ver abajo); mientras tanto protege contra purge. |

Estos defaults son de producto, no una afirmación de obligación legal. Sin orden terminal no inicia TTL operacional: retention_until null significa reloj aún no calculable, **no permiso de purge**. Si hay varios vínculos, tomar fecha más larga; un vínculo protector con reloj aún no iniciado impide usar otro plazo menor para purgar. Asociación, cierre/terminalidad, garantía, cambio de política y holds disparan evaluación server-side. Cierre de recepción no equivale a delivered/cancelled de orden.

**Evidencia de consentimiento de privacidad:** todo asset referenciado por `privacy_consents.evidence_media_id` es evidencia de autorización; su baseline de 36 meses aplica por ese vínculo y no solo por figurar en el inventario de §11. Un plazo mayor por hold, contrato u obligación legal prevalece (máximo de obligaciones). **RESERVED/UNRESOLVED:** solo el timestamp exacto que actúa como reloj de autorización del consentimiento (candidatos en la fila de consentimiento: `captured_at`, `revoked_at` u otro evento) no está suficientemente canonizado; no elegir uno por conveniencia ni usar `uploaded_at` como sustituto. Sin reloj resuelto, `retention_until` null significa reloj no calculable y **no** permiso de purge: el vínculo protege contra purge/remove-unattached (§11) hasta que B05 resuelva el reloj con extracto canónico.

Retención de evidencia comprometida no se acorta retroactivamente por plan; conservar política/version y piso comprometido. Desvincular no habilita rebajar automáticamente al baseline de 30 días. Cuarentena tampoco reduce un plazo de evidencia de dominio más largo: aplicar máximo de obligaciones, con cualquier hold por encima de TTL. No hacer mutable `retention_class` histórica de firma para implementar el cálculo.

`legal_hold_until` vigente, disputa, security incident y DSR investigation suspenden purge, incluso cuando TTL vence. La ausencia de legal_hold_until no prueba ausencia de otros holds: B05 debe resolver/persistir fuentes y motivos, incluyendo suspensión sin fin conocido; el baseline ya exige respetar esos holds, aunque su representación final sea diseño pendiente. Si no puede demostrar elegibilidad, no purgar. Hold no habilita download de asset ya bloqueado. La política de supresión procedente no se confunde con limpieza automática; se revalida impedimento legal/contractual y acceso se bloquea inmediatamente cuando se acepta (§11).

**IMPLEMENTATION_GAP B05:** solo se guarda clase/version v1; faltan cálculo, piso comprometido, fuentes de hold, eventos y reloj de cuarentena. Requisitos sobre futuras garantías/terminalidad no autorizan implementar sus módulos completos; usar las fuentes/fixtures aprobados hasta sus sprints.

## 11. Delete/purge contract

`media.remove_unattached` solo owner/admin. **Unattached** = ningún vínculo de dominio en el tenant, no solo ausencia de reception_media. Inventario mínimo obligatorio: `reception_media`, `damage_media`, `finding_media`, `work_activity_media`, `quality_check_media`, `delivery_media`, `quote_media` (versión exacta), **`signatures.signature_media_id` y `privacy_consents.evidence_media_id`**. Upload session no es vínculo de dominio, pero protege lifetime de PUT pendiente. Toda nueva referencia media exige actualizar inventario/retención y guards antes de habilitarla.

Remove-unattached no permite eliminar evidencia comprometida mediante un unlink previo. Elegibilidad exige ausencia de todos esos vínculos, no purge previo, sin holds ni obligación de retención protectora vigente; rechazo determinista si existe protección. La operación no concede un override de los baselines. Un objeto pending exige además coordinación con capabilities PUT para su eliminación física. Histórico firmado nunca se elimina vía remove-unattached; su eventual purge lo evalúa el proceso de retención específico con §14. Retención vencida de media vinculada se evalúa por ese proceso dedicado según obligaciones de cada vínculo, conservando referencias históricas; no se finge unattached ni se elimina mientras un vínculo siga siendo protector.

Two-phase: `eligible → deletion_requested_at → bloqueo de nuevas signed URLs / status deleted + deleted_at → grace operacional máximo 7 días → revalidar holds, enlaces y obligaciones → DELETE R2 → purged_at + audit`. El primer paso persistido de solicitud/bloqueo es atómico y auditable. `deleted_at` significa inaccesible en producto; `purged_at` confirma borrado físico, y cumple CHECK `purged_at >= deleted_at`. Grace no es una espera obligatoria: para supresión procedente se intenta pronto con objetivo primario ≤7 días salvo impedimento/hold. Con hold no se promete purge en siete días.

| Carrera | Invariante requerido en B04/B05/B06 |
| --- | --- |
| attach vs delete | Coordinación sobre mismo asset: attach gana → delete ve vínculo y rechaza; delete gana → attach ve marcador y rechaza. Nunca ambos éxitos dejando evidencia adjunta purgada. |
| hold vs delete/purge | Hold confirmado antes de decisión destructiva impide purge; si llega tras bloqueo, mantener bloqueo y suspender purge. Crear/modificar hold usa la misma coordinación; ninguno puede confirmar protección entre revalidación final y DELETE físico sin ser observado. |
| purge vs nueva asociación | Una solicitud de delete impide asociaciones nuevas. Revalidar todas las referencias, incluso escrituras privilegiadas/legacy que pudieron introducir vínculos. Cualquier vínculo protector nuevo detiene purge; no quitarlo automáticamente. |
| purge vs fallo DB/R2 | No marcar purged_at por intento/timeouts. DELETE confirmado/ausencia comprobada permite concluir idempotentemente tras recuperación; persistir intento/resultado y reconciliar si R2 borró y DB no confirmó. No regenerar key ni reactivar para resolverlo. |

Una revalidación en DB seguida de DELETE sin coordinación durante la llamada externa es insuficiente. B06 debe diseñar mecanismo durable/locks compartidos por attach y holds, con RLS tenant y recovery; no simular atomicidad distribuida DB/R2. La migración debe imponer invariantes en PostgreSQL donde corresponda, además de las comprobaciones del worker.

Purge usa proceso y credencial dedicados, privilegios mínimos por operación; API/runtime normal sin mass-delete. Helper `deleteR2Object` no implementa este lifecycle. Lifecycle R2 solo para prefijos puramente efímeros, nunca autoridad de retention de evidencia. B08 reconcilia faltantes/huérfanos sin borrar automáticamente un huérfano basado solo en edad/listado.

## 12. RBAC/resource authorization

| Permiso | owner | admin | service_advisor | technician |
| --- | --- | --- | --- | --- |
| `media.read` | tenant | tenant | tenant | assigned |
| `media.upload` | tenant | tenant | tenant | assigned |
| `media.remove_unattached` | allowed | allowed | denied | denied |

Assigned se comprueba server-side por **media → enlace específico → recepción/orden → assignment**, siempre del mismo tenant y membership activo. Reusar semántica existente de [queries.ts](../src/receptions/queries.ts): assignment `lead_technician`/`support_technician`, `released_at IS NULL`. Con múltiples enlaces, acceso requiere al menos un vínculo con recurso autorizado; no concede acceso a parents ajenos ni expone su identidad. Firma conserva permiso propio `signatures.capture`, nunca se deduce de media.upload.

### 12.1 Invariante de upload operacional (todos los roles)

**Antes de iniciar una nueva operación de media operacional:** para `photo`, `video` y `video360` (incluye evidencia de daño), **no se obtiene la capacidad PUT firmada inicial sin contexto de dominio verificado y autorización válida `service_provision` para la operación**. La cadena es obligatoria y ordenada, para owner, admin, service_advisor y technician por igual; ningún rol la omite por ser tenant-wide:

1. contexto verificado de recepción/daño (el target existe y se resuelve server-side, no por ID suelto del cliente);
2. mismo tenant que el TenantContext verificado;
3. recepción elegible/`open` (§4/§8; un daño resuelve su recepción);
4. recepción cubierta por el consentimiento canónico `service_provision` (`receptions.privacy_consent_id`, contrato S3-04.5), válido/otorgado para esta operación en el punto de autorización inicial (`status = 'granted'`, `revoked_at IS NULL` en ese momento). Una revocación ya efectiva antes de ese punto deniega la nueva operación, aunque la recepción siga siendo históricamente válida;
5. autorización RBAC/de recurso (`media.upload` tenant-wide, o assigned comprobado para technician; §12);
6. solo entonces, emitir la capacidad PUT firmada inicial y vincular la operación al contexto autorizado con evidencia server-side verificable.

**Replay de create / complete / attach:** revalidar tenant, identidad de recepción/daño vinculada, lifecycle del parent y de media conforme §§4–9, RBAC/autorización de recurso y evidencia server-side de que la operación fue válidamente autorizada y vinculada al iniciarse. Esa revalidación comprueba la validez de la autorización inicial; **no exige que `service_provision` siga actualmente otorgado/sin revocación en cada replay, complete o attach**. Una revocación posterior no invalida automáticamente un upload ya iniciado válidamente, ni reescribe su validez histórica. Replay continúa la misma operación y binding bajo idempotencia/expiry existentes; no autoriza otra captura, otro target ni una operación nueva.

La revocación posterior a la creación válida de una recepción no invalida retroactivamente esa recepción (contrato de recepción §4.4). Impide futuras capturas/nuevas operaciones de media operacional según privacidad; conservar la validez histórica de recepción/upload no exime una nueva operación de la autorización inicial anterior, ni omite las comprobaciones actuales de tenant, lifecycle o RBAC.

**RESERVED/UNRESOLVED — offline (Sprint 13):** media capturada antes de revocar, pero cuyo primer upload se solicita después de revocar, no tiene comportamiento exacto demostrable con la evidencia server-side actual: el body genérico no acredita autorización/binding inicial y `capturedAt` es solo una declaración del cliente. El contrato de sincronización offline de Sprint 13 debe resolver ese escenario; no confiar en `capturedAt`, inventar autorización histórica ni habilitar una excepción al requisito de autorización válida para nuevas operaciones.

Ser creador del asset, conocer su ID o enviar tenant/order ID no prueba contexto ni assignment. Un asset todavía sin vínculo solo se resuelve para technician por ese contexto validado, jamás por acceso tenant-wide; GET aún exige `active` y §9. Firma conserva su permiso y flujo propios (`signatures.capture`), fuera de esta cadena.

**CONTRACT GAP (dueño S4-B04; S4-B07 añade la resolución assigned de technician):** el body publicado de create no contiene ni resuelve ese contexto, y el binding sesión↔contexto y la forma de API no están definidos. B01 **no inventa nombres wire** de ese campo/ruta. Hasta que B04 cierre el binding/API y B07 la resolución assigned, el PUT operacional se trata como no habilitado para sesiones nuevas (fail-closed; en particular para technician). **B02/B03 no pueden declarar completo el camino de upload operacional** sin esta precondición; su alcance se limita a las validaciones de completion/idempotencia independientes del binding. No asumir assignment por vehículo ni una orden/asignación en recepción `open` (el contrato S3 no la tiene): no habilitar estados parent adicionales ni cambiar RBAC a tenant. Si se requiere otro flujo de creación previo a orden, hace falta extracto canónico y revisión de v1.

## 13. Stable error contract

Envelope existente: `{ "error": { "code": "...", "message": "mensaje seguro", "request_id": "..." } }`. Preservar nombres/status públicos; fallos de validación de request usan 400 `REQUEST_VALIDATION_FAILED`. Sin object_key, bucket, signed URL, body/error R2, SQL/stack/secrets ni pistas de existencia cross-tenant. URL solo en respuestas de éxito autorizadas (§3/§9).

Inventario completo de `new MediaError` en servicio actual:

| HTTP | Código estable actual | Uso |
| --- | --- | --- |
| 422 | `MEDIA_TYPE_NOT_ALLOWED` | Tipo no soportado |
| 422 | `RETENTION_CLASS_NOT_ALLOWED` | Clase inválida; usar también para pareja tipo/clase incompatible |
| 422 | `MIME_TYPE_NOT_ALLOWED` | MIME no permitido para tipo |
| 422 | `MEDIA_SIZE_TOO_LARGE` | Tamaño esperado fuera del límite (formato/≤0 en HTTP: validación 400) |
| 409 | `UPLOAD_SESSION_ALREADY_COMPLETED` | Replay create de completed |
| 409 | `UPLOAD_SESSION_FAILED` | Sesión failed |
| 409 | `UPLOAD_SESSION_EXPIRED` | Expiry efectivo/materializado |
| 404 | `UPLOAD_SESSION_NOT_FOUND` | Sesión ausente/ajena/no visible para recurso |
| 409 | `MEDIA_ASSET_NOT_ACTIVE` | Asset propio visible, estado no disponible; replay complete si dejó de estar active |
| 404 | `MEDIA_ASSET_NOT_FOUND` | Asset ausente/ajeno/no visible, o inaccesible por delete markers |
| 409 | `UPLOAD_NOT_FOUND_IN_STORAGE` | Objeto ausente; retry pendiente |
| 422 | `MEDIA_SIZE_INVALID` | Tamaño real cero/excesivo; cuarentena durable |

Errores requeridos a implementar, sin presentarlos como emitidos hoy:

| HTTP | Código v1 | Condición / dueño |
| --- | --- | --- |
| 409 | `IDEMPOTENCY_PAYLOAD_MISMATCH` | Replay/concurrent incompatible create/complete, B03 |
| 422 | `MEDIA_METADATA_MISMATCH` | Tamaño válido en rango pero distinto de esperado, Content-Type faltante/distinto, digest verificado comparable distinto, B02 |
| 422 | `MEDIA_CONTENT_INVALID` | Tipo real/contenido corrupto/peligroso o duración fuera de política aprobada; cuarentena, B02 |
| 503 | `MEDIA_STORAGE_UNAVAILABLE` | Timeout/fallo proveedor recuperable sin detalles R2, B03/B08 |
| 409 | `MEDIA_ASSOCIATION_CONFLICT` | Asociación/orden incompatible o combinación tipo/purpose no admitida, B04 |
| 404 | `RECEPTION_NOT_FOUND` / `DAMAGE_NOT_FOUND` | Parent ausente/ajeno/no visible; reusar existentes, B04/B07 |
| 409 | `RECEPTION_NOT_EDITABLE` | Parent visible no open; reusar existente, B04 |
| 409 | `MEDIA_DELETE_NOT_ELIGIBLE` | Vínculo/retención/state incompatible con remove-unattached, B06 |
| 409 | `MEDIA_LEGAL_HOLD` | Hold bloquea delete del asset autorizado; sin motivo sensible, B05/B06 |
| 403 | `PERMISSION_DENIED` | Permiso denegado antes de lookup de recurso; existente core, B07 |

Tras permiso general, recurso fuera de assignment usa el mismo 404 que faltante/ajeno; no introducir error que confirme otra orden/tenant. Tenant core conserva `TENANT_ACCESS_DENIED`, `ACTIVE_MEMBERSHIP_REQUIRED`, `TENANT_SELECTION_INVALID`/`_REQUIRED` con sus envelopes actuales. `RESOURCE_AUTHORIZATION_CHECK_MISSING` es un bug server-side (500 tripwire), no una respuesta normal de assignment. No filtrar errores esperados de UNIQUE a SQL 500; errores internos genuinos conservan `INTERNAL_ERROR` seguro. Para una sesión failed, futuros replays dan `UPLOAD_SESSION_FAILED`; no repetir mutaciones de cuarentena.

## 14. Signature-history invariant

B01 no altera 0021–0023 ni debilita `media_signed_active_trg`. Hoy media firmado congela identidad (provider/bucket/key/tipo/MIME/size/checksum/clase), deleted_at/purged_at y status, salvo `active → quarantined`; signatures es append-only/single-use con referencias tenant-safe.

Migración futura **S4-B06** debe cumplir conjuntamente:

1. Runtime/API no puede actualizar/borrar/truncar histórico `signatures`, cambiar su media identity, sustituir bytes/key/clase ni activar/borrar/purgar firmado por atajo. Conservar las restricciones de captura, unicidad y cuarentena actual.
2. Solo proceso privilegiado dedicado puede transicionar physical lifecycle de **media** después de elegibilidad de retention y holds, con revalidación serializada/audit y §11. Tener rol privilegiado por sí solo no demuestra elegibilidad.
3. Preservar fila histórica de firma y referencia a metadata media, incluso tras eliminación física; no cascade/delete de firma/media tombstone para hacer funcionar purge. Hash declarado histórico no se reetiqueta como verificado.
4. Excepción estrecha comprobable por operación/rol y tenant; sin deshabilitar globalmente triggers, `session_replication_role`, cambios globales de RLS ni shortcut BYPASSRLS. Runtime no puede asumir credencial/rol retention ni invocar una entrada privilegiada sin autorización.
5. Verificar upgrade/preflight sin reescribir evidencia, restricciones runtime directas, tenant ajeno, holds, carreras, rollback y recuperación del worker. Si se requiere SECURITY DEFINER, revisar owner/search_path/EXECUTE y superficie mínima con el diseño aprobado, no privilegio general.

El vínculo de firma no equivale a retención infinita: el proceso dedicado evalúa la obligación histórica vencida; remove-unattached siempre lo ve como vínculo. La migración resuelve esa distinción sin convertir firmas en unattached.

## 15. Implementation gaps mapped to S4-B02…B09

Este mapa adopta los identificadores/alcances propuestos en S4-B00 y los limita por las reglas anteriores; todos son pendientes, no trabajo incluido en B01.

| Ticket | Gap observado / entrega exigida |
| --- | --- |
| **S4-B02 — Completion/integridad** | Persistir/exigir expectedSizeBytes y definir upgrade de sesiones; validar MIME R2, formato/contenido, duración (valor canónico pendiente); separar checksum declarado/verificado y evidencia confiable; cuarentena durable sin active falso. Aplicar matriz tipo/clase de upload. En complete, revalidar tenant, binding, lifecycle, RBAC y autorización inicial válida según §12.1, sin invalidarla automáticamente por revocación posterior. No declarar completo el upload operacional sin la precondición inicial §12.1 (CONTRACT GAP B04). §§3–5. |
| **S4-B03 — Idempotencia/concurrencia/resiliencia** | Huella semantic payload, create/complete serializados, UNIQUE con conflicto determinista, replay inmutable, TTL PUT ≤ sesión y expiry tras validación, timeouts/retries seguros y audit upload. Replay/complete revalidan tenant, binding, lifecycle, RBAC y autorización inicial válida (§12.1); una revocación posterior no la invalida automáticamente ni permite una operación nueva por replay. No declarar completo el upload operacional sin la precondición inicial §12.1 (CONTRACT GAP B04). §§6–7/13. |
| **S4-B04 — Asociaciones/lecturas** | **Dueño del CONTRACT GAP §12.1:** definir binding sesión↔contexto verificado de recepción/daño y su forma de API (sin nombres wire congelados por B01) y exigir para una nueva operación la cadena contexto→tenant→recepción open→consentimiento `service_provision` válido/otorgado en la autorización inicial→RBAC→PUT firmado inicial; consentimiento ya revocado deniega la nueva operación. Conservar evidencia server-side de autorización/binding inicial y revalidarla junto con tenant, identidad, lifecycle y RBAC en attach/replay/complete, sin invalidación automática por revocación posterior (§12.1). Solo reception_media/damage_media, catálogo purpose pendiente antes de habilitarlo, estados parent open, compatibilidad, sort_order, FK/guards, attach replay y locks comunes, lectura por recepción/daño/orden con permisos; recalculación con B05. §§4/8/11. |
| **S4-B05 — Retención/holds** | Relojes/floors/max por todos los vínculos, orden no terminal, warranty, firma/actos 36 meses, clase server-side limitada, fuentes hold, cuarentena timestamp con B02. Reloj de PDF futuro/documento vinculado UNRESOLVED. §§3/4/10. |
| **S4-B06 — Delete/purge** | Inventario completo unattached incl. signatures/privacy, bloqueo desde deletion_requested_at en GET/complete/attach, coordinación capabilities PUT/GET, two-phase worker/privilegio mínimo, grace/revalidación/retry/audit, migración de signed-media guard cumpliendo §14. §§9/11/14. |
| **S4-B07 — Assigned** | Añadir la resolución assigned de technician sobre el binding que defina B04: recurso tenant/assignment para upload/replay/complete/read/download/attach; parent elegible. Exigir consentimiento válido al iniciar nuevas operaciones; en replay/complete/attach revalidar tenant, binding, lifecycle, RBAC y autorización inicial válida sin exigir consentimiento actualmente no revocado (§12.1). Conservar fail-closed hasta cerrar el CONTRACT GAP §12.1. §12. |
| **S4-B08 — Reconciliación/observabilidad** | Scan active sin objeto/huérfanos, evidencia bucket privado/privilegios reales, diagnósticos/alertas sin capabilities ni secretos; no purge masivo automático por LIST/edad. §§5/11/13. |
| **S4-B09 — Quality Gate** | Negativos tenant/assignment, payload replay/races, formato/MIME/size/duración según política, clocks/holds/purge/upgrade, regresión firma histórica y cierre sin firma; R2 externo/staging por SHA final. Checks de B01 no acreditan estos subsistemas ni cierran Gate R2. |

Decisiones canónicas pendientes, confirmadas expresamente por el usuario: strings purpose (B04); máximo/unidad de duración por tipo (B02, sin rechazo numérico previo a aprobación). Otras reservas: reloj exacto de PDF/otros documentos vinculados y fuentes de holds sin fecha (B05); binding/forma de API del contexto de upload operacional (CONTRACT GAP, dueño B04; B07 añade la resolución assigned de technician); reloj de autorización de `privacy_consents.evidence_media_id` (B05); captura offline previa a revocación con primer upload posterior sin evidencia server-side suficiente de autorización inicial (RESERVED/UNRESOLVED, Sprint 13; §12.1, sin confiar en `capturedAt`). Esta reserva permite revisar B01; bloquea solo la implementación dependiente, sin fallback inventado. B02 debe diseñar/evidenciar el validador confiable y su persistencia; no afirmar soporte de proveedor por analogía con S3.

## 16. Resolved documentation conflicts

- **DOC_CONFLICT-01 — CLOSED:** Arquitectura §8 usaba `POST /media/{id}/complete`, ambiguo respecto al asset; canónico es `POST /api/v1/media/upload-sessions/:id/complete` con **uploadSessionId**. Conservar ruta productiva porque completion gobierna sesión, expiry/idempotencia/completed_at y devuelve mediaAssetId; renombrarla rompería compatibilidad sin beneficio acreditado. Se corrige únicamente la referencia de secuencia local y se enlaza este contrato; no crear alias ni cambiar rutas.
- **DOC_CONFLICT-02 — CLOSED:** Quality Gates histórico y S3-06 describían firma como requisito de cierre. Contrato vigente S3 y migración 0024 (decisión 2026-10-05), corroborados en close.ts, permiten cierre normal sin firma. Sprint 4 **no restaura firma obligatoria**. Captura legacy y evidencia histórica permanecen con sus protecciones. Se anota el carácter histórico de S3-06 y se aclara el gate local; no alterar código/migraciones.

No elegir tercera alternativa silenciosa ante otra contradicción: registrar DOC_CONFLICT con fuentes, decidir explícitamente con contexto canónico o pedirlo. Ausencia de catálogo purpose/duración no se resuelve convirtiendo fixtures ni propuestas B00 en autoridad.

## 17. Scope exclusions

B01 solo documentación y mínima regla Git para hacer visible el nuevo documento: `.gitignore` ignoraba nuevos archivos docs; excepción exacta a este contrato, sin abrir otros documentos no versionados. No modifica runtime, schema, migraciones, rutas, workers ni permisos reales R2.

No frontend, sincronización Notion, workflows de finding/work_activity/quality_check/delivery/quote, módulo completo de garantías/asignaciones/transición de órdenes, ni Sprint 13 (`sync_operations`, cola offline, conflict engine). Las tablas futuras solo se consideran para proteger tenant, retención y delete eligibility. No se crea/ejecuta prueba ficticia de comportamiento futuro ni upload/delete externo R2 para este ticket. Build/typecheck/lint y suite npm test local existente verifican el baseline; no son evidencia del Quality Gate completo de Sprint 4. No commit hasta petición del usuario.
