# S4-GAP-01 — Service Order Media Query Contract

Fecha: 2026-10-15, America/Bogota. Repositorio: `IvanBy12/TallerMecarioB`.
Rama: `task/s4-gap-01-order-media`. Base verificada:
`47c8fc954a9951775ff7539f7fa02c0bcf39dd80`.
Worktree: `/Users/ivanby/Documents/Proyectos/TallerMecarioB-worktrees/s4-gap-01-order-media`.

**Estado actual: D01–D07 aprobadas el 2026-10-15; implementación backend S4-GAP-01A verificada; la revisión focalizada F1–F6 se conserva en §15; remediación F1-N1 en §16. Merge BLOCKED hasta revisión independiente del nuevo candidato. Frontend fuera del alcance de 01A.**
N§7.23 y el Quality Gate global siguen BLOCKED hasta frontend y aceptación integrada.
No se consultó Notion ni se modificó el frontend, schema, migraciones o grants. Sin commit, push, PR ni almacenamiento real destructivo.

## 0. Aprobación expresa y trazabilidad — 2026-10-15

**EXISTING CONTRACT — APPROVED.** El responsable del producto aprobó expresamente D01–D07 el 15 de octubre de 2026; el encargo S4-GAP-01A suministrado por el usuario comunica esa aprobación y autoriza su implementación backend. Sustituye el estado pendiente del intercambio anterior. La decisión se contrastó por el responsable con Quality Gates Sprint 4, RBAC v1, Diccionarios 02 y 03, Security Baseline y ADR-003.

Esta procedencia es información aportada por el usuario, no acceso ni verificación directa del agente en Notion. No se atribuye a esas fuentes haber contenido previamente los detalles nuevos de API, DTO, cursor o timeouts. No se suministraron revisiones/fechas individuales de esos documentos y no se inventan.

Las condiciones aprobadas son las diez decisiones del intercambio contractual: MVP intake_evidence/damage_evidence; media.read sin orders.read adicional; forma B04 más source y nextCursor; todos los estados, assigned lead/support activo incluso en terminales; cursor contextual cifrado/autenticado y temporal; disponibilidad/legacy estrictos sin debilitar B07; frontend mínimo en fase posterior; locks/presupuestos sujetos a pruebas; revisión independiente de descarga tenant-wide; exclusión de B07 Phase B, familias/propósitos/duración/purga/permisos nuevos.

**M01–M04 permanecen BLOCKED — MISSING CONTRACT y no aprobados.** D06 define la propuesta aprobada de superficie mínima, pero S4-GAP-01A prohíbe editar el repositorio frontend. Los límites 1000/2s/8s/15s no se sustituyen ni se habilitan sin pruebas de corrección y carga.

Las secciones 1–13 conservan el análisis original del 15 de octubre como trazabilidad: sus etiquetas PROPOSED/pendiente describen aquel estado histórico. Para D01–D07 prevalece esta aprobación expresa; las reservas M01–M04 y exclusiones mantienen su clasificación. La sección 14 registrará implementación/evidencia actual sin alterar el alcance aprobado.

Clasificación aplicable a todas las secciones:

- **EXISTING CONTRACT**: regla documentada en las fuentes canónicas locales citadas.
- **VERIFIED IMPLEMENTATION**: comportamiento comprobado por inspección del código,
  constraints, triggers o composición de rutas; no implica prueba ejecutada de ese comportamiento.
- **PROPOSED — REQUIRES APPROVAL**: alternativa concreta para revisar; no es política vigente.
- **BLOCKED — MISSING CONTRACT**: capacidad dependiente sin contrato suficiente;
  no puede implementarse mediante inferencias. Solicitar al usuario el extracto
  canónico correspondiente antes de habilitarla.

Las tablas clasifican cada decisión. Los detalles de una propuesta heredan su
clasificación, incluidos ejemplos de DTO, errores, parámetros y límites.

## 1. Problema y criterio de aceptación

**EXISTING CONTRACT.** B09, matriz N§7.23: «Consulta/vista media por orden».
Hoy las rutas públicas listan por recepción o daño; resolver internamente una
orden para B07 no constituye una consulta pública por orden. F07-C, matriz E/#23,
confirma que la galería de recepción no satisface este criterio.

**PROPOSED — REQUIRES APPROVAL (D01).** MVP de galería de orden: reunir exclusivamente
las asociaciones canónicas de recepción de origen y sus daños. No prometer toda
la evidencia futura del ciclo de orden. Aprobación de ese alcance necesaria para
confirmar que cubre la intención de N§7.23.

Aceptación futura: consultar una orden propia autorizada, recorrer toda la galería
paginada, identificar el origen de cada elemento y visualizarlo mediante la descarga
existente; sin duplicados ni acceso cruzado. Incluir casos tenant-wide y assigned,
revocación, evidencia histórica, no disponible y errores de storage; demostrarlo con
pruebas backend, componentes, navegador y E2E real sobre SHAs identificados.

Esta fase entrega únicamente el contrato. La aprobación documental, la implementación,
la verificación local y el cierre del gate con integración real son hitos separados.

## 2. Fuentes verificadas y precedencia

**VERIFIED IMPLEMENTATION.** Se leyó `AGENTS.md`, se ejecutó `git worktree list`
y se reutilizó el worktree solicitado, limpio y en la base esperada. El checkout
backend principal tenía el mismo HEAD y estaba limpio; las lecturas de código
realizadas allí corresponden a esa misma revisión. No se crearon worktrees.

| Fuente | Secciones verificadas / uso | Clasificación |
| --- | --- | --- |
| [B01](S4-B01-media-contract.md) | §§2, 4–5, 8–13, 15–17: lifecycle, familias, privacidad, descarga, límites de inferencia | EXISTING CONTRACT |
| [B02](S4-B02-media-integrity.md), [B03](S4-B03-media-idempotency.md), `src/media/service.ts`, `content.ts`, `operational-binding.ts` | Integridad, metadata histórica, complete/replay y autorización inicial | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B04](S4-B04-media-associations.md), `src/media/associations.ts`, `routes.ts`, migraciones 0026/0028 | Phase A y B, dos purposes aprobados, MediaDto, listas y asociaciones | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B05](S4-B05-media-retention.md), `src/media/retention.ts` | Relojes, nueve familias, bindings y tiers de locks | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B06](S4-B06-media-delete-purge.md), migración 0029 | Marcadores, inventario, tombstones, fence/lease y límites de activación | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B07](S4-B07-assigned-media-authorization.md), `src/media/assigned-authorization.ts` | Lecturas Phase A, restricciones por asset, asignaciones, concurrencia y Phase B bloqueada | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B08](S4-B08-media-reconciliation.md), `src/media/reconciliation.ts` | Ausencia de objeto, incertidumbre y scanner sin reparación | EXISTING CONTRACT / VERIFIED IMPLEMENTATION |
| [B09](quality/s4-backend-final-quality-gate.md) | Matriz §2/#23 y límites de evidencia real | EXISTING CONTRACT |
| `src/db/schema.ts`, migraciones 0000, 0019, 0020, 0024–0030 | FK/UNIQUE/CHECK, triggers diferidos, inmutabilidad, permisos y RLS | VERIFIED IMPLEMENTATION |
| `src/receptions/close.ts`, `queries.ts`, `routes.ts`; `src/authz/{rbac-matrix,resource-authorization}.ts` | Creación de orden, resumen, permisos y tripwire | VERIFIED IMPLEMENTATION |
| `src/api/tenant-request.ts`, `src/tenancy/tenant-context-db.ts`, `src/platform/runtime-database.ts`, `src/memberships/membership-access.ts` | Sesión tenant, grants frescos y jerarquía de administración | VERIFIED IMPLEMENTATION |
| `tests/media-api/{associations,assigned-authorization,operational-binding,retention,delete-purge,final-quality-gate}.test.cjs` | Cobertura reutilizable; no sustituye nuevas pruebas de orden | VERIFIED IMPLEMENTATION |

Frontend inspeccionado **solo en lectura** en
`/Users/ivanby/Documents/Proyectos/TallerMecario`, HEAD
`9052f263daaf233508ba5625e86b42c96cefd6bd`, estado Git limpio:

- `AGENTS.md` y reglas aplicables de API, RBAC, recepción/privacy, media, PWA,
  UI y calidad; `docs/OPEN-QUESTIONS.md`.
- `docs/api/reception-and-media-contract-status.md`, convenciones HTTP y
  `docs/quality/s4-f07-{a-operational-media-adapter,b-reception-media-orchestration,c-media-final-gate,media-final-readiness}.md`.
- `src/features/reception/reception-operational-media-{types,contract,api}.ts`,
  `reception-context.tsx`, `reception-detail-page.tsx`, `reception-workflow.tsx`,
  `reception-operational-gallery.tsx`, `use-operational-gallery.ts` y pruebas asociadas.
- `src/app/app-routes.tsx`, `navigation.ts`, cliente compartido de media y
  `e2e-harness-tests/browser/secure/desktop-operational-gallery.spec.ts`.

**EXISTING CONTRACT.** Las decisiones específicas posteriores prevalecen sobre
notas históricas: B04 Phase B aprueba `intake_evidence`, `damage_evidence` y
video360 en daños; B07 Phase A habilita lecturas assigned. El informe preliminar
F07 y sus afirmaciones de B04 pendiente/no video360 son históricos. F07-C sí
implementa galería de recepción, pero mantiene #23 bloqueado. No se corrigen esos
archivos en esta fase. No se siguió ningún enlace de Notion.

## 3. Relaciones reales del dominio

| Pregunta | Evidencia y conclusión | Clasificación |
| --- | --- | --- |
| ¿Orden sin recepción? | No: `service_orders.reception_id NOT NULL`; `service_orders_reception_lineage_fk` enlaza tenant/recepción/vehículo/cliente con la recepción exacta | VERIFIED IMPLEMENTATION |
| ¿Varias órdenes por recepción? | No: `service_orders_reception_key UNIQUE(tenant_id,reception_id)` | VERIFIED IMPLEMENTATION |
| ¿Recepción abierta con orden? | No bajo guards normales: `service_orders_reception_guard_trg` exige recepción `closed` y hace inmutable el linaje | VERIFIED IMPLEMENTATION |
| ¿Recepción cerrada sin orden? | No en estado comprometido válido: `receptions_order_required_ct` diferido exige orden; la UNIQUE establece exactamente una. Recepción cancelada no implica orden | VERIFIED IMPLEMENTATION |
| ¿Cómo nace la orden? | `closeReception` bloquea recepción y, en una transacción, cierra, crea orden `reception`/versión 1, evento inicial y audit. Cierre repetido devuelve la misma orden. Migración 0024 permite cerrar sin firma | VERIFIED IMPLEMENTATION / EXISTING CONTRACT |
| ¿Cómo recuperar el origen? | Buscar `service_orders` por `(tenant_id,id)` y unir su `reception_id` a `receptions` con tenant; nunca por vehículo, cliente, fecha o “última recepción” | VERIFIED IMPLEMENTATION |
| ¿Cómo llegar a daños? | `vehicle_damages(tenant_id,reception_id)` → `damage_media(tenant_id,damage_id)` → `media_assets(tenant_id,id)`; recepción → `reception_media` equivalente | VERIFIED IMPLEMENTATION |
| ¿Qué es evidencia final? | Filas reales `reception_media`/`damage_media`, con purposes exactos `intake_evidence`/`damage_evidence`; photo/video/video360. Binding y sesión no son asociación final | EXISTING CONTRACT |
| ¿Qué demuestra el binding? | Autorización inicial durable de la sesión y exactitud recepción/daño/consentimiento. No concede lectura por sí solo ni inicia la retención operativa | EXISTING CONTRACT |
| ¿Hay familias adicionales? | Tablas de finding/activity/QC/delivery/quote, firmas y privacy existen y se incluyen en el inventario de seguridad/retención, pero no son fuentes aprobadas de esta galería | EXISTING CONTRACT |

Las FK compuestas y acciones NO ACTION conservan pertenencia y referencias;
los CHECK de purpose/sort y guards B04 validan asociaciones nuevas. No inferir
que dos FK independientes de asociación prueben por sí mismas todo el binding
histórico. Registros legacy/corruptos requieren las verificaciones de §§7–8.

**VERIFIED IMPLEMENTATION.** Estados de orden existentes:
`reception`, `diagnosis`, `quote_pending`, `approved`, `partially_approved`,
`rejected`, `in_progress`, `quality_control`, `ready_for_delivery`, `delivered`,
`cancelled`. Solo los dos últimos exigen `closed_at`. El nombre `reception` de
la orden no significa que su recepción esté abierta. B07 no filtra por estado
de orden; B04 permite lectura histórica con parent cerrado.

**PROPOSED — REQUIRES APPROVAL (D03).** Conservar para esta consulta la lectura
en los once estados, incluidos delivered/cancelled y rejected. Para técnicos
sigue haciendo falta asignación activa elegible, incluso en estados terminales.
No liberar ni crear asignaciones automáticamente al cambiar estado. Esta política
explícita por orden no está aprobada por la mera ausencia de filtro actual en B07.

## 4. Contrato API propuesto

Todo este apartado es **PROPOSED — REQUIRES APPROVAL (D01/D04/D07)** salvo referencias
expresas al contrato de descarga existente.

`GET /api/v1/orders/:orderId/media?limit=20&cursor=<opaque>`

- Ruta autenticada interna del personal; `config.permission='media.read'`,
  `permissionScope='resource'`. Reutilizar identidad y selección de tenant actuales.
  No nueva autoridad desde `orderId`, `tenantId` en query, creador ni flags del cliente.
- No añadir `orders.read` como segundo permiso implícito. El listado no devuelve
  datos generales de orden/CRM; la navegación puede usar su guard vigente. Cambiar
  esto requeriría decisión explícita, no modificar la matriz de roles silenciosamente.
- Guard de permiso antes del recurso; resolver orden propia y recepción cerrada
  exacta. Unir solo recepción y daños de ese origen, con tenant en cada join.
- Sin body, filtros, `includeDeleted`, selección de familia/purpose, URLs, offset,
  expansiones ni ordenamiento libre. Rechazar propiedades query extra y repetidas.
- UUID válido se canoniza; malformed/missing/foreign/unassigned son el mismo 404
  de orden. Validar forma query después de permiso y acceso al recurso, evitando
  que la validación de cursor revele existencia o autorización de una orden ajena.
- Respuesta 200 `{ media: OrderMediaDto[], nextCursor: string | null }`; vacío
  autorizado es 200, nunca 404. El servidor determina el origen.
- `Cache-Control: no-store` en éxitos y errores, incluido rechazo temprano de auth,
  permisos, rate limit o validación. No ETag/304 ni caché de galería; verificar hooks.
- Listar no firma URLs, no consulta R2, no recalcula retención y no escribe asociaciones,
  media, sesiones, jobs ni eventos de mutación. Logs operativos seguros con request_id;
  no inventar auditoría de lectura como requisito de producto.

### Orden, duplicados y paginación (D04)

Orden total ascendente: `(sourceRank, sourceId, sortOrder, mediaAssetId, purpose)`.
`sourceRank=0` recepción y `1` daño; `sourceId=receptionId` o `damageId` según origen.
UUID en comparación nativa PostgreSQL; purpose con orden byte determinista.
Recepción primero, después grupos de daño por UUID; dentro del grupo se mantiene
el desempate B04. No ordenar por capture/upload ni por etiqueta traducida.

Una sola aparición por asset. Una misma fila repetida por la consulta se elimina
por identidad natural de asociación antes de paginar. Si el asset tiene destinos
canónicos distintos o linaje contradictorio, omitirlo entero: no escoger arbitrariamente
un origen ni fragmentar su evaluación entre páginas. Consultar el grafo completo
del asset, incluso referencias fuera de la página y de la orden solicitada.

`limit`: entero decimal 1…100, default 20; cursor y límite inválidos → 400.
No es un máximo de evidencias permitidas en la orden. B04 no fija cantidad.
Leer como máximo `limit+1` asociaciones candidatas distintas por ventana keyset;
procesar como máximo `limit`, usando la adicional solo como señal de continuación.
Aplicar el filtro de autorización y disponibilidad **antes de serializar**, sin
rellenar automáticamente la página mediante escaneos ilimitados.

El cursor avanza sobre la última candidata procesada, aunque se haya omitido;
una página puede tener menos de `limit` elementos o estar vacía con continuación.
`nextCursor=null` significa fin del recorrido actual. No devolver totales, IDs
omitidos, motivos, número de bloqueados ni etiquetas de orígenes sin media visible.
Frontend conserva “Cargar más” ante continuación; no confunde página vacía con
orden sin evidencia. No bucle automático de páginas vacías.

Cursor propuesto: token base64url versionado, cifrado autenticado, limitado a
2048 caracteres y con vigencia de 15 minutos desde su emisión. Contiene la última
tupla, tenant, orden, usuario/membership, limit y versión de ordenamiento; todos
se verifican en cada uso. Un base64 legible de IDs descartados o HMAC sin cifrado
no protege su confidencialidad. Clave dedicada server-side y rotación por key-id,
configuración propuesta `MEDIA_ORDER_CURSOR_KEY`; no reutilizar credenciales R2,
JWT ni secreto de consentimientos. Faltante/malformada impide habilitar la ruta;
clave retirada/cursor vencido/manipulado/cruzado → el mismo 400 seguro, sin detalles.
El formato interno no concede autorización ni se registra en logs. Esta elección
agrega gestión de secretos y requiere aprobación expresa; no existe este codec hoy.

Revalidar permisos y grafo en cada página. No snapshot persistente entre páginas:
eliminación/revocación puede reducir resultados; no devolver datos previamente
omitidos por un cursor. Nuevos elementos anteriores al cursor requieren recargar
el recorrido. Dentro de un recorrido estable no hay duplicados ni saltos; frontend
deduplica por asset al acumular y reinicia desde cero si cambia contexto/permiso.

### Límites de trabajo y errores (D07)

Además de la ventana, máximo propuesto de 1000 filas de referencias/sesiones/padres
inventariadas para el batch, deduplicando padres, con consultas de descubrimiento
acotadas a presupuesto restante + 1. Incluir referencias sensibles/reservadas y
bindings en el presupuesto. Revalidar después de esperar locks: no llamar primero
a helpers que materialicen un grafo ilimitado y contar al final. Un grafo mayor
falla cerrado; nunca truncar la evidencia que decide autorización.

Proponer `SET LOCAL lock_timeout='2s'` y `statement_timeout='8s'`, más deadline de
15s para toda la consulta con cancelación/rollback; son nuevos límites de esta ruta,
no una garantía del helper B07 actual. No habilitar sin implementación y prueba de
estos límites, incluida detección de crecimiento concurrente. Validar índices con
EXPLAIN sobre fixtures grandes antes de decidir una migración adicional.

| HTTP / code | Resultado público propuesto |
| --- | --- |
| 200 | Lista completa de la ventana autorizada, posiblemente vacía |
| 400 `REQUEST_VALIDATION_FAILED` | Query/body no admitido o cursor inválido; mensaje sin valores privados |
| 401 / errores actuales de autenticación | Conservar sobre y flujo de sesión del middleware |
| 403 `PERMISSION_DENIED` | Falta media.read en el guard, antes de lookup |
| 403 / denegación tenant actual | Membership/selección no autorizada, sin identificar recursos ajenos |
| 404 `SERVICE_ORDER_NOT_FOUND` | Malformed/inexistente/ajena/no asignada/QC-only; mismo mensaje seguro |
| 409 `MEDIA_ASSOCIATION_CONFLICT` | Grafo cambió durante locks; rollback íntegro; reconsulta GET manual |
| 429 / error actual de rate limit | Conservar política global, sin cuota nueva inventada |
| 503 `MEDIA_QUERY_LIMIT_EXCEEDED` | Presupuesto de grafo excedido; sin resultados parciales ni tamaños internos |
| 503 `MEDIA_QUERY_RETRY` | Timeout/contención/deadline; reconsulta explícita, sin retry automático ilimitado |
| 500 / error interno seguro actual | Invariante raíz orden/recepción imposible o fallo inesperado; sin SQL/linaje |

`SERVICE_ORDER_NOT_FOUND` ya aparece en el helper interno de retención por orden;
su uso HTTP en esta ruta sigue siendo propuesta. Los dos códigos 503 son nuevos.
Sobre de error vigente: `{ error: { code, message, request_id } }`.
No emitir un 409 por cada asset inválido: se omite, según §7; el 409 corresponde a
un conjunto de locks que cambió y no permite una lectura segura.

## 5. DTO propuesto

**EXISTING CONTRACT.** B04 define ocho campos de MediaDto. En el runtime su tipo
local se llama `AssociationDto` y no está exportado; no hay un tipo público
TypeScript `MediaDto` reutilizable directamente. Reutilizar la forma wire y extraer
un tipo/proyección común requiere trabajo posterior, sin modificar los DTO B04.

**PROPOSED — REQUIRES APPROVAL (D02).** Extender esa forma, sin anidar ni renombrar
los campos existentes:

```ts
type MediaDto = {
  mediaAssetId: string; // UUID canónico
  mediaType: 'photo' | 'video' | 'video360';
  mimeType: string;
  sizeBytes: number | null;
  capturedAt: string | null; // UTC, seis decimales
  uploadedAt: string | null; // UTC, seis decimales
  purpose: 'intake_evidence' | 'damage_evidence';
  sortOrder: number; // 0..2147483647
};
type OrderMediaDto = MediaDto & {
  source:
    | { type: 'reception'; receptionId: string }
    | { type: 'damage'; receptionId: string; damageId: string };
};
type OrderMediaPage = {
  media: OrderMediaDto[];
  nextCursor: string | null;
};
```

`source.type='reception'` implica purpose `intake_evidence`; `damage` implica
`damage_evidence`. Toda source.receptionId es el origen de la orden y cada damageId
es su hijo tenant-scoped. Validar estas dependencias en serializer y parser.
El tipo estrechado aplica a esta galería; no redefine el tipo genérico de media.

Ejemplo sintético válido, recepción seguida de daño:

```json
{
  "media": [
    {
      "mediaAssetId": "11111111-1111-4111-8111-111111111111",
      "mediaType": "photo", "mimeType": "image/jpeg", "sizeBytes": 24576,
      "capturedAt": null, "uploadedAt": "2026-10-14T15:00:00.123456Z",
      "purpose": "intake_evidence", "sortOrder": 0,
      "source": { "type": "reception", "receptionId": "22222222-2222-4222-8222-222222222222" }
    },
    {
      "mediaAssetId": "33333333-3333-4333-8333-333333333333",
      "mediaType": "video360", "mimeType": "video/mp4", "sizeBytes": null,
      "capturedAt": null, "uploadedAt": null,
      "purpose": "damage_evidence", "sortOrder": 0,
      "source": { "type": "damage", "receptionId": "22222222-2222-4222-8222-222222222222", "damageId": "44444444-4444-4444-8444-444444444444" }
    }
  ],
  "nextCursor": null
}
```

Los nulls históricos permanecen null: no inventar capture/upload ni backfill.
Solo proyectar claves permitidas. No bucket, object_key/objectKey, checksum,
credenciales, URL firmada, sesión/binding/consentimiento, retention/hold, causa de
cuarentena, notas, descripción del daño, customer/vehicle/membership ni IDs sensibles.
Los únicos campos nuevos públicos son `source` y `nextCursor` (D02/D04).
Etiquetas de daño enriquecidas/estado unavailable/contadores requieren otro contrato.

## 6. Matriz RBAC

**EXISTING CONTRACT / VERIFIED IMPLEMENTATION.** `rbac-matrix.ts`, filas 106–107:
owner/admin/service_advisor tienen `media.read=T`, technician `media.read=A`.
Los grants combinados respetan dominancia tenant; no autorizar por nombre de rol.
B07 solo acepta `lead_technician`/`support_technician` con `released_at IS NULL`
para la membership actual; `quality_control` no sirve para esta lectura.

| Actor / grant efectivo | Consulta propuesta | Restricciones y descarga | Clasificación |
| --- | --- | --- | --- |
| owner | 200 orden propia sin assignment | Media permitida por §7; download tenant actual | EXISTING CONTRACT para T; PROPOSED — REQUIRES APPROVAL para nueva ruta |
| admin | Igual que owner | No autoridad sobre otros tenants | Igual |
| service_advisor | Igual, media.read T | No requiere permiso de eliminar ni nuevo permiso | Igual |
| technician con lead/support activo | 200 solo orden asignada, incluso vacía | Cada asset satisface grafo B07; descarga reautoriza | EXISTING CONTRACT para A; PROPOSED — REQUIRES APPROVAL para agregación |
| technician sin assignment / released / QC-only | 404 igual a orden inexistente | No capability ni IDs de evidencia | EXISTING CONTRACT B07; nueva ruta propuesta |
| Sin media.read | 403 previo al recurso | Sin consulta/URL | EXISTING CONTRACT |
| Membership suspendida/revocada / tenant inválido | Denegación actual del contexto | Sin fallback a otro tenant | EXISTING CONTRACT |
| Grant tenant y assigned combinados | Rama tenant | No exigir assignment artificialmente | EXISTING CONTRACT |

**EXISTING CONTRACT.** No se habilita B07 Phase B. Aunque el catálogo dé
`media.upload=A` al técnico, los guards actuales de create/replay/complete/attach
exigen tenant y permanecen denegados. La orden nace cuando la recepción ya está
cerrada; no existe combinación válida assignment + parent abierto para ese upload.

## 7. Reglas tenant, RLS, disponibilidad y seguridad

**EXISTING CONTRACT.** Todas las consultas usan el mismo cliente reservado de
la transacción TenantContext, GUCs locales y tenant verificado. FORCE RLS y sesiones
NOBYPASSRLS son obligatorios, además de predicados tenant y FK compuestas.
El runtime valida login `tallermecario_runtime` NOINHERIT, rol efectivo API/worker,
sin superuser/BYPASSRLS ni privilegios de schema indebidos. No ejecutar como owner,
migrator, purger o lifecycle. No nueva función SECURITY DEFINER ni grants/migración
por conveniencia de la lectura. Verificar catálogo real en las pruebas DB futuras.

**VERIFIED IMPLEMENTATION — diferencias que no deben ocultarse.**

- `listAssociatedMedia` tenant-wide excluye status deleted y los tres marcadores;
  no exige active ni revisa explícitamente quarantine/integrity/bindings. Por ello
  puede listar metadata no descargable. No atribuirle el filtro estricto B07.
- `listAssignedMedia` usa `eligibleGraph`: activo operacional, flags limpios,
  nueve familias y todas las sesiones, bindings congruentes y assignment en cada
  recepción relacionada. Omite evidencia insegura. No reconstruye prueba inicial.
- `getMediaDownloadUrl` exige activo y marcadores vacíos para tenant-wide; devuelve
  409 si no activo, 404 si ausente/marcado. Los flags de integridad/cuarentena y el
  grafo completo se verifican adicionalmente en el camino assigned de la ruta.
- `lockOrderMediaRetention` y `orderAssetIds` incluyen más familias y bindings
  para protección; no son un resolver autorizado de galería ni una consulta paginada.

**PROPOSED — REQUIRES APPROVAL (D05).** Reglas de la nueva galería, deliberadamente
más estrechas que la lista B04 tenant-wide, sin modificar esta última:

| Situación del asset candidato | Tenant-wide | Assigned |
| --- | --- | --- |
| active, operational, photo/video/video360, purpose/linaje exactos y sin flags/marcadores | Incluir si cumple resto de esta tabla | Incluir solo con prueba B07 completa |
| pending_upload / uploaded / quarantined / deleted | Omitir | Omitir |
| deletion_requested_at / deleted_at / purged_at presente, aun status active stale | Omitir | Omitir |
| quarantined_at o integrity_failure_code presente, aun active inconsistente | Omitir | Omitir |
| Firma/privacy, tipo document/quote_pdf o referencia sensible mezclada en asset operacional | Omitir; no mostrar referencias ni razón | Omitir; B07 ya lo deniega |
| Referencia finding/work_activity/QC/delivery/quote, sola o mezclada | No es fuente y asset mixto se omite en este MVP | Omitir, como B07 |
| Solo binding, sin asociación canónica | Omitir | Omitir |
| Varios destinos canónicos, purpose/parent roto o conflicto de pruebas presentes | Omitir entero | Omitir entero |
| Legacy con asociación exacta válida, metadata disponible, pero sin binding durable | Incluir sin fabricar/backfill de prueba inicial, manteniendo capacidad histórica T | Omitir, B07 exige todas las pruebas |
| Varias sesiones con prueba equivalente completa | Incluir una vez | Incluir una vez si B07 autoriza |
| Prueba existente incompleta/pending/failed/expirada o binding contradictorio | Omitir; ausencia histórica total se distingue de evidencia presente inválida | Omitir |
| Retención vencida/hold activo sin marcadores de indisponibilidad | Lectura permitida; no son permisos de lectura ni órdenes de borrar | Igual, si grafo autoriza |

Para la excepción legacy tenant-wide: ausencia total de bindings permite solo
sesiones ausentes o sesiones existentes completed con completed_at; una mezcla de
sesiones bound/unbound o cualquier prueba existente inválida no usa esa excepción.
No exigir que el consentimiento esté actualmente sin revocar para mostrar la
misma evidencia histórica autorizada. Los checks de prueba histórica preservan B04.

D05 requiere aprobación explícita para disponibilidad, legacy y exclusión de assets
mixtos tenant-wide. No convertirlo silenciosamente en un endurecimiento global de
las rutas B04 ni de la descarga tenant-wide de firmas/documentos autorizados.

**EXISTING CONTRACT.** Ninguna asociación crea un privilegio. Un técnico requiere
assignment para la orden consultada incluso sin candidatos, y cada asset visible
requiere autorización completa sobre todas sus referencias; conocer IDs no basta.
No aceptar origen desde frontend ni ignorar una referencia porque cae fuera del
MVP. Familias futuras deben actualizar el inventario y obtener contrato antes de uso.

**EXISTING CONTRACT / VERIFIED IMPLEMENTATION.** Descargar conserva
`GET /api/v1/media/:id/download-url` → `{mediaAssetId,downloadUrl,expiresAt}`, TTL
300 segundos. El listado no es capability y no garantiza futura descarga. Reautorizar
al solicitar URL; revocación o tombstone posterior al listado impide nueva emisión.
URL emitida antes de revocación puede seguir funcionando hasta expirar.

**VERIFIED IMPLEMENTATION — riesgo de concurrencia existente.** La rama assigned
del download toma locks B07/B05 antes de firmar. La rama tenant-wide invoca
`getMediaDownloadUrl` directamente y no toma esos locks: no afirmar que está
probada la serialización delete↔emisión para todos los roles por usar esa función.
B01 §9 exige esa serialización. **PROPOSED — REQUIRES APPROVAL (D07)**:
comprobar con barreras DB y, en la implementación posterior, alinear la emisión
tenant-wide al protocolo común de locks y grant fresco sin restringir sus familias
históricas autorizadas ni cambiar el DTO. Es trabajo de compatibilidad explícito,
no un cambio ejecutado por este documento.

## 8. Estado y concurrencia

**PROPOSED — REQUIRES APPROVAL (D07).** Algoritmo de lectura en una transacción
READ COMMITTED, sin R2 y con rollback completo ante conflictos:

1. Resolver identidad/membership/tenant y guard media.read con el middleware actual.
   Tomar owner-mutation gate/workshop mediante `lockCurrentTenantOwnerSet`, luego
   membership actual FOR SHARE y reconsultar grants. Aplicar también a tenant-wide
   en la nueva ruta; B07 hoy lo hace solo para la rama restringida. Un grant tenant
   retirado no puede seguir usando una decisión request-start: denegar y reconsultar
   con contexto nuevo; no degradar a assigned con estado de tripwire obsoleto.
2. Descubrir orden/recepción y candidatos de ventana mediante lecturas sin locks de
   hijos/media. Verificar acceso al recurso antes de revelar validación de cursor;
   un precheck assigned puede ser no bloqueante, pero se repite bajo locks al final.
   Descubrir todos los padres/sesiones/referencias de cada candidato con presupuesto.
3. Tomar en batch los tiers B05, IDs ordenados en cada tier: recepción FOR NO KEY
   UPDATE → daño FOR SHARE → orden FOR NO KEY UPDATE → todas las sesiones FOR UPDATE
   → assets FOR UPDATE. Incluir la orden/recepción solicitadas aun en galería vacía
   y padres adicionales del grafo. No bloquear la orden antes de su recepción.
4. Tomar filas de assignment elegibles FOR SHARE en orden determinista después de
   los tiers, como B07; repetir membership/grant pertinente, estado de orden/recepción,
   inventario, candidatos y linaje. Bajo locks, verificar asignación de orden vacía
   y el grafo completo de cada asset. No invocar `listAssignedMedia` sucesivamente
   por daño: volvería a adquirir tiers anteriores después de locks de assets.
5. Si aparece padre/sesión no cubierto, abortar con el conflicto existente; no
   adquirir un parent tardío, devolver descubrimiento ni omitir checks. Este GET
   propone reconsulta manual, como lecturas B07 sin retry automático nuevo. Si el
   presupuesto crece más allá del tope, abortar con 503 antes de resultado alguno.
6. Filtrar/deduplicar/ordenar, generar DTO/cursor y marcar el tripwire assigned solo
   después del check real de orden y assets. El middleware lo comprueba antes del
   éxito/commit; no responder parcialmente si falla. Mantener locks hasta commit.

El helper común deberá permitir verificar inventario/proof sin recalcular ni auditar
retención y hacer respetar el presupuesto antes y después de locks. Su API actual
no acredita por sí misma los límites propuestos; requiere diseño y pruebas.

**EXISTING CONTRACT.** Reader que gana mantiene assignment/membership y locks hasta
commit; revocación espera y la siguiente petición se deniega. Revocación que gana
se observa al revalidar: cero filas/URLs sensibles. Para download assigned los locks
se conservan durante firma síncrona, nunca durante tráfico R2. Rol/status revocado
después del guard inicial debe ser observado antes de emitir acceso.

**PROPOSED — REQUIRES APPROVAL.** La nueva galería serializa cuarentena/tombstone y
cambios participantes de referencia bajo asset locks, manteniendo el orden B05/B06.
Un cambio posterior a su commit invalida disponibilidad futura; no promete snapshot
entre GET de lista y GET de URL. Los triggers/fences existentes gobiernan cambios
concurrentes; leer no toma un lease físico ni activa el purger. No afirmar ausencia
de deadlocks sin barreras y pruebas multiasset/multiorigen; los timeouts son límite
de espera, no prueba de orden correcto. Escritores privilegiados que deshabilitan
triggers están fuera del protocolo soportado.

**EXISTING CONTRACT.** Retención no es autorización de lectura. No tocar relojes
order.closed_at+12 meses/warranty, floors comprometidos, versiones, holds, firma
histórica, revocación posterior de consentimiento ni jobs B06. Scanner B08 puede
observar active_missing sin cambiar lifecycle: una fila activa no prueba binario
presente. El cliente maneja fallo de visualización sin inferir ausencia definitiva.

## 9. Contrato frontend propuesto

**VERIFIED IMPLEMENTATION.** F07-C funciona en detalle de recepción; su DTO/parser
solo acepta purpose intake_evidence. `can(..., 'media.read', true)` solicita tenant
scope: UI assigned permanece fail-closed aunque el backend B07 ya soporte lecturas.
La ruta `/ordenes` se renderiza con `ModulePlaceholderPage`; no hay detalle productivo
ni cliente de consulta de galería por orden. El resumen de orden tras cerrar recepción
no es una API/vista de orden. No hay integración existente que baste con conectar un hook.

**PROPOSED — REQUIRES APPROVAL (D06).** Crear una superficie mínima de evidencia
`/ordenes/:orderId/media`, presentada como galería de la orden, sin inventar un DTO
general de orden ni pedir recepción/CRM a técnicos. Puede integrarse como sección
en el futuro detalle de orden. Enlace desde el resumen de cierre ya existente con
serviceOrder.id; acceso directo autorizado para técnicos asignados. No construir
listado general de órdenes en esta tarea.

La relación con un futuro detalle completo, sus datos, UX y endpoint general sigue
**BLOCKED — MISSING CONTRACT** si se elige exigirlos como prerrequisito. La superficie
mínima anterior permite una propuesta implementable sin asumir ese contrato.

Contrato de consumo y UX (D06):

- Nuevo `OrderMediaDto`/parser estricto de valores y relaciones source↔purpose,
  origin IDs, metadata nullable y nextCursor. Proyectar solo claves permitidas;
  rechazar página incoherente completa. No ensanchar el parser de recepción a daños.
- Permisos efectivos del runtime verificado: tenant o assigned para esta galería;
  no comparación de roles. Permitir intentar consulta assigned no es afirmar que
  el ID esté autorizado. No abrir uploads ni habilitar toda recepción/CRM al técnico.
- `loading`, `loaded`, `error`; vacío global solo tras recorrer/terminar sin elementos.
  Grupo “Recepción” y grupos “Daño” por ID; usar etiquetas neutrales locales, no
  descriptions/zoneCode obtenidos de un endpoint más privilegiado. Preservar orden
  servidor y fusionar grupos entre páginas sin duplicar asset ni encabezados vacíos.
- Página vacía con cursor: “No hay elementos visibles en esta página” y “Cargar más”;
  no afirmar que existen evidencias denegadas. Error de siguiente página conserva
  elementos previos seguros; 401/403/404 invalida la vista/capabilities del contexto.
- Reutilizar patrón F07-C de “Ver/Ocultar”, fotos `<img>` y video/video360 `<video
  controls preload='none'>`. Video360 es clasificación de evidencia, no prueba de
  proyección inmersiva ni un visor 360 nuevo. Foco y teclado, status/alert semánticos,
  mobile/tablet/desktop y controles estables durante carga/error/expiración.
- Obtener URL solo al seleccionar el asset mediante la ruta download existente;
  comprobar mediaAssetId de respuesta y expiresAt. No prefirma ni prefetch binarios.
  Si producto pide descarga como archivo además de visualizar, definir UX aparte;
  no asumir Content-Disposition ni CORS que no se hayan verificado.
- URL exclusivamente en memoria, retirada al ocultar, expirar, error o cambio de
  contexto. Timer y focus/pageshow/visibilitychange vuelven a comprobar expiración;
  URL ya vencida no se monta. Nueva petición explícita para recuperar acceso, sin
  renovación automática infinita. Video se pausa y retira src/load al desmontar.
- No bearer, X-Tenant-Id ni cookies de app hacia R2; crossOrigin anonymous y política
  de referrer segura. No URLs/cursor en logs, storage, Cache Storage, IndexedDB,
  service worker, analytics ni errores genéricos; no API fallback offline contra no-store.
- 403: permiso/contexto no disponible, retirar vista y refrescar contexto por mecanismo
  actual. 404: texto indistinguible “La orden o evidencia no existe o no está disponible
  para tu acceso”. 409/503/429: reconsulta controlada sin bucles. Fallo de storage o
  URL vencida: retirar capacidad, informar y permitir nueva solicitud explícita;
  no marcar asset borrado ni alterar el detalle de recepción/orden.
- Remontar/abortar por identidad, tenant, permisos y orderId; descartar respuestas
  tardías de listado, paginación y download. Reiniciar cursor y acumulación, desmontar
  binarios. No solicitar endpoints de recepción para completar la galería assigned.

## 10. Matriz de pruebas propuesta

Todo escenario de la nueva ruta/vista es **PROPOSED — REQUIRES APPROVAL** y **NOT_RUN**
en esta fase. Las pruebas existentes indicadas se reutilizan como fixtures/regresión,
no como evidencia ejecutada de N§7.23. Pruebas DB futuras: PostgreSQL real con login
API NOBYPASSRLS, FORCE RLS/guards activos; fake R2 para pruebas locales. Corrupción
solo en fixture privilegiada descartable; nunca deshabilitar guards para el camino probado.

| Escenario | Nueva comprobación requerida | Reutilización / regresión existente |
| --- | --- | --- |
| owner/admin/service_advisor | Nueva ruta propia 200 sin assignments; grant tenant domina combinación de roles | `associations.test.cjs`, `assigned-authorization.test.cjs` |
| Técnico lead/support asignado | Ruta 200, recepción y todos sus daños autorizados; galería vacía también autoriza el recurso | Fixtures y grafo B07; nueva cobertura por orden |
| No asignado/released/QC-only | 404 igual a inexistente, cero IDs/cursor/URLs y cero signing | B07 negativos, nuevos asserts de agregado |
| Assignment de otra orden / dos órdenes | Nunca heredar permiso de una a otra ni por creatorId | B07 dos órdenes; nueva ruta |
| Membership revoked/suspended, rol retirado | Guard vigente y grant fresco; no salida con snapshot obsoleto | B07 request-start stale y lifecycle suites; nueva ruta y rama T |
| Tenant cruzado, inexistente, UUID inválido | Mismo 404 autorizado al recurso; falta permiso conserva 403 antes de lookup | B04/B07/FORCE RLS; pruebas nuevas de ruta y cursor |
| Recepción y varios daños | Los seis pares origen/tipo, exactitud source/purpose, sin notas/PII | B04 associations + operational-binding; proyección nueva |
| Once estados de orden | Lectura y download según D03, assigned activo en terminales; ningún upload nuevo | Fixtures orden/retención; matriz nueva por estado |
| Active / deleted y todos los marcadores | Solo activos disponibles; flags stale-active se excluyen; cambio tras listar deniega URL | B06 y B07; nuevo listado y carrera |
| Quarantine / integrity failure / pending / uploaded | Omisión; no metadata de razón ni signing; video360 conserva clasificación | Integridad, B07, B09; nuevo agregado |
| Firma/privacy y siete familias no canónicas | Una referencia sensible/reservada vence apariencia operacional incluso si cae fuera de página/orden | B07 reserved-family/mixed-signature; tests nuevos T y A |
| Asociación incompleta/conflictiva | Sin vínculo final no entra; wrong damage/foreign parent/purpose y binding conflictivo no autorizan | B04/B07 corrupt fixtures; nuevas ventanas |
| Históricos | Nulls intactos; sin binding solo T según D05; mezcla/prueba inválida se omite; consentimiento revocado posterior conserva evidencia válida | B04/B07 histórico; casos legacy nuevos |
| Sesiones equivalentes/múltiples orígenes | Un asset, una entrada; pruebas equivalentes aceptadas; destinos incompatibles se omiten globalmente aun en páginas separadas | B04 multiple sessions/B07 consensus; agregado nuevo |
| Orden total/paginación | Empates, sourceRank/sourceId, defaults, 1/100, final, página filtrada vacía con cursor y sin loop | B04 tie ordering; codec/keyset completamente nuevos |
| Cursor | Expiry, rotación, tamper, versión, tamaño, tenant/orden/usuario/membership/limit; sin tuple legible ni autoridad heredada | Nuevos unitarios y HTTP; no existe codec actual |
| Cambio entre páginas | Revalidar autorización, retirar capacidad UI; eliminación no revive; recarga para inserciones anteriores | Nuevo BE/FE |
| Revocación gana / lector gana | Barreras PostgreSQL para assignment, role y membership con ambos ganadores; cero signing tras revocación ganadora | B07 barriers; nueva lista y rama T de URL |
| Tombstone/cuarentena/referencia gana | Listing↔mutación y download tenant↔delete; validar jerarquía y no parent tardío | B04/B05/B06 barriers; ampliación nueva |
| Deadlocks/presupuesto | Múltiples assets/orígenes, referencias fuera de ventana, fanout >1000, crecimiento mientras espera, timeout/deadline y rollback limpio | B05 lock proof + B04 concurrency; nuevas pruebas de límites |
| Sin duplicados ni filtración | Lista/errores/logs/cursor sin capabilities, storage identity, checksum/PII; GET sin mutaciones/audits de éxito nuevos | B04 safe DTO, B07 zero sign, scanner existente; asserts nuevos |
| Regresión B04/B07 | Rutas y DTO previos intactos, asignado no abre uploads/replay/complete/attach, tripwire obligatorio | Suites existentes y seis mutaciones B07 |
| Frontend contrato y estados | Parser, agrupación, páginas, nulls, loading/empty/error, 403/404, recuperación y foco | F07-C 44 casos y adapter/client; nuevas pruebas por orden |
| Frontend aislamiento/expiry | Cambiar orden/tenant/permisos durante list/page/download, respuestas tardías, desmontaje video y no persistencia | F07-C isolation/timer; nuevos casos de acumulación y assigned |
| Navegador sintético | 390/1280px, teclado, focus, empty/error, origin groups, carga incremental, sin tokens a storage | Harness F07-C; nuevo spec de orden, no etiquetar E2E real |
| E2E real | Crear recepción/daños + foto/video360, complete/attach, cerrar y consultar por ID de orden tras recarga; descargar como T/A, negar tenant/QC/revocado, TTL y outage | Nuevo flujo real Clerk/API/PostgreSQL/R2/CORS, SHAs y evidencia sanitizada |

Comandos futuros tras aprobación: `npm run build`, `npm run lint`, `npm test`,
`npm run test:media:api:ci`, `npm run test:media:assigned:mutations:ci`,
`npm run test:reception:api:ci`, suites DB tenant/runtime y regresiones B06 pertinentes.
Actualizar inventario de conteos exactos del runner B09 si se añaden tests; no
permitir skips ni confundir total antiguo con mínimo actual. Ejecutar bases serialmente.
Frontend: typecheck/lint/build, pruebas de adaptador/galería, harness y flujo E2E
real separado. Upgrade solo si una migración resulta necesaria y es aprobada.
No ejecutar purger, R2 DELETE, B07 Phase B ni gate completo que incluya operaciones
fuera del entorno autorizado por esta especificación.

## 11. Decisiones pendientes de aprobación y contratos ausentes

| ID | Decisión concreta | Estado / qué bloquea |
| --- | --- | --- |
| D01 | GET `/api/v1/orders/:orderId/media`, media.read resource, solo intake+damage, sin orders.read extra ni familias futuras | PROPOSED — REQUIRES APPROVAL; confirmar que este MVP satisface el alcance #23 |
| D02 | MediaDto existente + source discriminada, sin labels/PII; envelope media/nextCursor | PROPOSED — REQUIRES APPROVAL; bloquea serializer y parser nuevos |
| D03 | Lectura en los once estados, incluidos delivered/cancelled; assigned activo siempre | PROPOSED — REQUIRES APPROVAL; B07 no define política terminal explícita |
| D04 | Orden por origen, deduplicación fail-closed, default20/max100, ventanas filtrables, cursor cifrado 15min/2048 chars y clave dedicada | PROPOSED — REQUIRES APPROVAL; UX de página vacía, orden y operación de claves deben aprobarse juntos |
| D05 | Solo disponibles, omitir mixtos sensibles/reservados; excepción legacy T exacta, sin relajar B07 | PROPOSED — REQUIRES APPROVAL; no aplicar como política aprobada a listas B04 |
| D06 | Superficie mínima `/ordenes/:orderId/media`, enlace desde cierre y acceso assigned sin recepción/CRM, grupos neutrales y recuperación | PROPOSED — REQUIRES APPROVAL; falta vista operativa de órdenes hoy |
| D07 | Grants frescos/locks comunes, presupuesto1000, timeouts2s/8s/deadline15s, nuevos 503 y coherencia de emisión T con B01 | PROPOSED — REQUIRES APPROVAL; diseño y pruebas deben demostrar límites y serialización |
| M01 | Media de finding/work_activity/QC/delivery/quote o firma/privacy dentro de esta galería | BLOCKED — MISSING CONTRACT; solicitar catálogo/DTO/semántica de lectura y privacidad antes de ampliar |
| M02 | Upload técnico por orden | BLOCKED — MISSING CONTRACT; requiere binding/purpose/estado/consentimiento/auditoría/retención/locks de B07 Phase B; excluido |
| M03 | Detalle completo de orden como requisito de UI | BLOCKED — MISSING CONTRACT; si producto rechaza D06 mínimo, solicitar DTO/ruta/UX del detalle antes de implementarlo |
| M04 | Mostrar tombstones/unavailable y razón, atributos descriptivos de daño, límites de duración | BLOCKED — MISSING CONTRACT; no inventar campos ni políticas; excluidos de MVP |

No se necesita inventar esas capacidades para presentar este contrato a aprobación.
La viabilidad del dominio actual está respaldada por código y constraints. Si la
aceptación de D01 exige alguna capacidad M01–M04, detener ese trabajo dependiente
y pedir al usuario el extracto de Notion pertinente, sin acceder directamente.
Ningún silencio se interpreta como aprobación de D01–D07.

## 12. Plan de implementación por archivos, posterior a aprobación

Todo este plan es **PROPOSED — REQUIRES APPROVAL**, no una lista de cambios realizados.
Los nombres nuevos son rutas propuestas; conservar arquitectura existente sin crear
un módulo completo de órdenes por conveniencia.

| Archivo / repositorio | Trabajo posterior y restricción |
| --- | --- |
| BE `src/media/routes.ts` | Registrar GET, schema query/body, no-store temprano, error seguro y scope resource; conservar rutas previas |
| BE nuevo `src/media/order-query.ts` | Resolver orden/origen, unión canónica tenant, ventana keyset, presupuesto, batch locks y proyección; sin R2 ni writes |
| BE nuevo `src/media/order-query-cursor.ts` | Codec cifrado autenticado/versionado, binding/expiry/rotación y validación estricta de D04 |
| BE `src/api/app.ts` y configuración de arranque pertinente | Inyectar clave de cursor validada sin imprimirla; pruebas de falta/config inválida. Revisar redacción de logs de query |
| BE `src/media/associations.ts` / nuevo `src/media/dto.ts` | Extraer forma/proyección común tipada sin cambiar payload, orden ni comportamiento B04 |
| BE `src/media/assigned-authorization.ts` | Extraer validadores/locks de lector y grafo reutilizables; no copiar checks divergentes ni invocar una lista por cada daño; mantener tripwire y Phase B cerrado |
| BE `src/media/retention.ts` | Facilitar discovery/proof acotados y revalidación reutilizable sin recalcular retención; conservar tiers, inventario y callers B04/B05/B06 |
| BE `src/media/service.ts` / download en `routes.ts` | Verificar y alinear serialización tenant-wide de signing con B01 según §7, sin limitar familias de descarga aprobadas ni cambiar DTO/TTL |
| BE `src/media/errors.ts` | Códigos seguros para presupuesto/timeout; no confundir con delete retry ni durable mutation outcome |
| BE nuevo `tests/media-api/order-query.test.cjs` y pruebas unitarias del cursor | Matriz §10, fixtures existentes, barriers, comportamiento público y anti-enumeración |
| BE tests assigned/associations/delete-purge y harness/runner B09 | Regresiones necesarias, bounds/no side effects y actualizar conteos esperados solo con evidencia real |
| BE schema/migraciones | Ningún cambio previsto. Si EXPLAIN exige índice, justificar tenant/index/impacto y crear migración nueva aprobada; nunca editar históricas |
| FE nuevos `src/features/orders/order-media-{types,contract,api}.ts` | DTO/parser y cliente GET/list/download del contrato nuevo, runtime tenant verificado, sin depender de DTO de recepción |
| FE nuevos `order-media-page.tsx`, `order-media-gallery.tsx`, `use-order-media.ts` en ese módulo | Vista mínima, estado paginado, abort/isolation, grupos y assigned UX |
| FE `src/app/app-routes.tsx`, wiring de runtime y `src/features/reception/reception-workflow.tsx` | Ruta concreta y enlace por ID de orden; no reemplazar placeholder por un módulo ficticio ni solicitar detalle sin contrato |
| FE galería/hook de recepción y compartidos media | Reutilizar primitivas de visualización/expiry solo si se conserva regresión; no ampliar su parser ni abrir upload técnico |
| FE tests/orders, `e2e-harness-tests/browser/secure/` y `e2e/` | Tests de contrato/UX, spec sintético de orden y flujo real separados |
| BE este documento y B09 / FE matriz F07 | Solo en fase futura autorizada, registrar aprobaciones, SHAs y evidencia de implementación; no marcar #23 PASS con contrato solo |

Revisar locks/tenant/inventario antes de habilitar la ruta. Un cambio transversal
al helper B05 o al signing exige regresión específica, aunque no modifique schema.
No hay decisión implícita de crear índices, grant, migración, worker, endpoint general
de órdenes, endpoint de asociación por orden ni nuevo catálogo de purposes.

## 13. Riesgos, compatibilidad B01–B09 y verificación de esta fase

| Bloque | Compatibilidad requerida / riesgo | Clasificación |
| --- | --- | --- |
| B01 | Agregación de enlaces reales permitida; no API genérica de familias; descarga temporal separada. Endpoint nuevo necesita aprobación | EXISTING CONTRACT / PROPOSED — REQUIRES APPROVAL |
| B02 | No revalidar bytes, HEAD ni afirmar digest/duración/360 verificados al listar; flags indisponibles se excluyen | EXISTING CONTRACT / PROPOSED — REQUIRES APPROVAL para filtro nuevo T |
| B03 | GET no crea sesión/idempotency key ni altera replay; upload/replay siguen con guards vigentes | EXISTING CONTRACT |
| B04 | Payloads, orden y lecturas actuales intactos; nueva source extiende solo endpoint nuevo. Riesgo de filtrar históricos T requiere D05 | EXISTING CONTRACT / PROPOSED — REQUIRES APPROVAL |
| B05 | Tiers, proof e inventario completo preservados; lectura no inicia/recalcula reloj. No usar helper de retención como permiso de lectura | EXISTING CONTRACT |
| B06 | Marcadores bloquean exposición y URLs; no unlink, delete, purge ni habilitación de worker. Emitidos antes retienen TTL | EXISTING CONTRACT |
| B07 | Assigned por lead/support actual y grafo por asset; QC/familias reservadas fail-closed; no upload técnico. Batch locking evita invertir tiers | EXISTING CONTRACT / PROPOSED — REQUIRES APPROVAL para nueva agregación |
| B08 | Activo no garantiza objeto presente. No HEAD por elemento, repair ni promoción a active por nueva consulta | EXISTING CONTRACT |
| B09 | #23 y gate global siguen BLOCKED hasta aprobación, implementación y evidencia; no usar resultados sintéticos como live E2E | EXISTING CONTRACT |

Riesgos de la propuesta: serialización por workshop puede limitar concurrencia;
fanout de grafo no se resuelve solo con paginar la respuesta; cursor cifrado necesita
operación de claves; páginas filtradas son menos densas; no snapshot entre páginas;
legacy T y políticas terminales necesitan aprobación explícita. El acceso ya emitido
no se revoca inmediatamente. No se ofrece prueba de rendimiento ni ausencia de
deadlocks mediante inspección. Descargas tenant-wide requieren verificar la diferencia
entre código y serialización contractual señalada en §7.

**VERIFIED IMPLEMENTATION — comprobaciones de esta fase documental.**

- `npm run build`: PASS, exit 0.
- `npm run lint`: PASS, exit 0, 290 archivos, sin fixes.
- `npm test`: PASS, exit 0, 205 tests (26 + 78 + 20 + 5 + 76), sin failures, skips, cancelados ni todos.
- Los tres gates de baseline se ejecutan en el checkout principal limpio con el
  mismo SHA `47c8fc9`, donde ya existen dependencias; el worktree solicitado carece
  de node_modules. No se instalan/copían dependencias ni se edita código para esta fase.
  El build genera únicamente la salida ignorada habitual. No acreditan el nuevo endpoint.
- Revisión documental: relaciones respaldadas por constraints, aislamiento tenant,
  nueve familias, grant por recurso, diferencias reales T/A y propuestas identificadas.
  Comprobación de whitespace, enlaces locales, ejemplo JSON y único entregable: PASS.
- No ejecutadas suites de DB/API, mutation testing ni frontend/E2E: cambio solo
  documental, ninguna implementación nueva; no se afirma que esos escenarios pasaron.

Git: solo se crea este documento en el worktree solicitado. La regla vigente
`.gitignore: docs/*` lo ignora; no se cambia .gitignore ni el índice porque el encargo
permite únicamente este archivo y no solicita staging. Revisar con
`git status --short --ignored -- docs/S4-GAP-01-order-media-query-contract.md`
y `git diff --no-index -- /dev/null docs/S4-GAP-01-order-media-query-contract.md`.
No hay cambios tracked ni staged, commit, push o PR.

**Cierre histórico S4-GAP-01: CONTRACT READY FOR APPROVAL; sustituido por la aprobación de §0.**

## 14. S4-GAP-01A — Implementación backend y evidencia (2026-10-17)

### 14.1 Alcance implementado y decisiones congeladas

D01–D07 son **EXISTING CONTRACT — APPROVED 2026-10-15**, según la trazabilidad
aportada por el usuario en §0. Esta fase implementa exclusivamente el backend.
D06 permanece aprobada para una fase frontend posterior; M01–M04 y las exclusiones
siguen sin aprobación. No se consulta Notion ni se presume que sus textos ya
contenían las decisiones nuevas de esta API.

`GET /api/v1/orders/:orderId/media` usa `media.read` resource-aware, sin un segundo
permiso orders.read. Resuelve la orden tenant-scoped y su recepción cerrada exacta;
agrega únicamente reception_media/intake_evidence y damage_media/damage_evidence.
Los once estados existentes permiten lectura. Las asignaciones lead/support activas
siguen siendo necesarias en la rama assigned, incluso en estados terminales.

Se exportó la forma/proyección B04 como `MediaDto`/`mediaDtoProjection`, manteniendo
los ocho campos wire anteriores y su comportamiento. Solo la ruta nueva agrega
`source` discriminado a cada item y `nextCursor` al envelope. Las metadata nullable
históricas se conservan; no hay URLs, bucket/key, checksum, consentimiento, notas,
retención ni atributos de administración en el listado.

La nueva consulta no llama al storage, no crea auditorías de mutación ni cambia
assets, sesiones, asociaciones, retención o jobs. La prueba de inmutabilidad compara
xmin de los assets y conteo de auditorías antes/después, además de los contadores
de signing/transport. B07 Phase B y uploads de técnicos siguen cerrados.

### 14.2 Autorización, disponibilidad y locks

Se reutilizan los validadores reales B07 `lockReader`, `assignedReception` y
`eligibleGraph`, conservando sus defaults para listas/descargas assigned existentes.
Solo la nueva galería tenant-wide opta por D05: ausencia total de binding permite
media histórica con asociación única válida y sesiones ausentes o todas completed
con completed_at. Una mezcla bound/unbound, prueba presente inválida, destinos
contradictorios o referencias sensibles/reservadas nunca usa esa excepción.

En ambos scopes la galería excluye estados no activos, marcadores de eliminación,
flags de cuarentena/integridad, clases/tipos incompatibles, referencias sensibles y
familias sin contrato. En assigned se conserva la evaluación de todas las sesiones,
consenso de binding, consentimiento histórico y asignación del grafo. Una sesión
sin asociación final no crea autoridad. Revocación posterior de consentimiento o
un hold no se reinterpretan como permiso nuevo ni como borrado de historia.

Una sola transacción y un solo batch de locks, incluyendo orden/recepción aun en
una página vacía: gate de administración/workshop → membership FOR SHARE y grant
fresco → recepciones → daños → órdenes → sesiones → assets → assignments FOR SHARE,
con IDs ordenados en cada tier B05. No se llama una lista B07 separada por daño.
Los cambios de linaje fuera del conjunto bloqueado abortan el request con el 409
existente; nunca se toma un parent tardío. No hay retry automático que renueve el
presupuesto. El tripwire assigned se marca tras autorización real del recurso.

Se preservan FORCE RLS, login/roles NOBYPASSRLS y tenant en todos los joins. Sin
schema, migraciones, índices, permisos o grants productivos nuevos. Los roles
LOGIN adicionales usados por pruebas son fixtures desechables, eliminados al terminar.

### 14.3 Paginación, configuración y límites efectivos

Default 20, máximo 100; ventana de `limit+1`, procesando como máximo limit. Orden
ascendente `(sourceRank,sourceId,sortOrder,mediaAssetId,purpose COLLATE C)`. La
consulta no multiplica asociaciones por joins a sesiones; las PK y la autorización
del grafo evitan duplicados/destinos ambiguos. El cursor avanza por la última
candidata procesada aun si se omite; página vacía con continuación es válida.
No totales ni motivos/IDs de elementos descartados. Acceso se revalida en cada página.

Cursor AES-256-GCM, IV aleatorio de 12 bytes, tag de 16 bytes y AAD versionado con
key-id. Payload cifrado/authenticated: versión, tenant, order, user, membership,
limit, última tupla, issuedAt y expiresAt. Vigencia 15 minutos; máximo 2048 caracteres;
base64url canónico. Manipulado, vencido, clave retirada o contexto distinto retorna
el mismo 400 seguro. La prueba de rotación retiene claves previas sin dar autoridad
a un cursor ni registrar su contenido.

`MEDIA_ORDER_CURSOR_KEY` es configuración server-side JSON, validada antes de abrir
el pool productivo: `{ "activeKeyId": "key-id", "keys": { "key-id": "<clave aleatoria de 32 bytes en base64url canónico>" } }`.
No copiar el placeholder como una clave. Se admiten hasta ocho key-ids; conservar
las claves previas necesarias durante rotación y retirarlas cuando corresponda.
El codec copia las claves y las conserva solo en su closure. No usar secretos de
R2, JWT o consentimiento como material de cursor. No hay clave aleatoria de
fallback en producción.

**Habilitación:** sin la variable, la ruta nueva no se registra; configuración
presente inválida detiene el startup antes de DB. Una clave válida permite registrar
la ruta. Las suites habilitan mediante material sintético en memoria; esta tarea
no modifica un ambiente productivo ni instala claves reales. La habilitación del
despliegue requiere revisión del cambio y la configuración correspondiente.

`lockMediaRetention` acepta presupuesto opcional solo para esta consulta. Descubrimiento
raw con UNION ALL/LEFT JOIN y LIMIT de detección incluye referencias rotas, las nueve
familias y bindings; sesiones y padres participan en el conteo, deduplicando padres.
La prueba con 498 sesiones equivalentes de un asset de daño da exactamente 1000
filas de grafo y pasa; una sesión adicional falla 503. También se prueba crecimiento
por encima del límite mientras el lector espera un lock. No se autoriza sobre un
inventario truncado y no se materializan listas de tamaño ilimitado para luego contarlas.
Los callers B04/B05/B06 existentes mantienen su protocolo sin el límite opt-in.

No-store se fija antes de auth y rate limiting, incluyendo 401/403/404/429. El deadline
monotónico de 15 segundos empieza en onRequest y no se renueva en el handler: cubre
identidad, espera de reserva, bootstrap, RBAC, grafo y comprobación previa a commit.
La nueva ruta reserva una conexión antes de bootstrap para que esas lecturas también
sean acotadas; bootstrap sigue siendo solo descubrimiento, nunca autoridad. Las
otras rutas conservan su orden normal de descubrimiento/reserva.

Cada statement de esta ruta recibe timeout `min(8s, presupuesto restante)` y los
locks tienen 2s. PostgreSQL cancela el statement; se espera su resultado y se hace
rollback antes de liberar la conexión, evitando un paquete cancel tardío sobre otra
petición. Timeout → 503 MEDIA_QUERY_RETRY; presupuesto de grafo → 503
MEDIA_QUERY_LIMIT_EXCEEDED. Una identidad tardía no reanuda el pipeline; una reserva
tardía se libera sin BEGIN ni queries tenant. Cleanup usa la conexión original sin
wrapper para poder hacer rollback aunque se haya agotado el plazo. Como cualquier
timeout de aplicación, no certifica un SLO bajo suspensión del proceso o red fallida.

### 14.4 Corrección de compatibilidad de descarga — revisión específica

**VERIFIED IMPLEMENTATION / defecto reproducido antes del cambio.** La prueba
`tenant download: deletion wins and no stale presigned URL can escape` falló en el
camino tenant-wide anterior: con la transacción B06 de tombstone aún sin commit,
el GET devolvió 200 y firmó usando el snapshot active anterior. Se verificó el lock
real en PostgreSQL y se preservó el registro local de reproducción sanitizable;
no se contactó R2. Causa: esa rama no tomaba los locks que la rama assigned ya usa.

La corrección aislada en `src/media/download-authorization.ts` toma grant/membership
frescos y el grafo B05 antes de invocar el servicio actual de signing. El cambio de
routing es una llamada explícita en la rama tenant-wide. No aplica el filtro de
galería D05 ni el grafo restricted a esas descargas: firmas/document/quote_pdf
históricos permitidos conservan acceso y DTO/TTL 300s. La prueba anterior pasa
tras el cambio; otra prueba demuestra lector/emisión gana y eliminación espera.
También se prueban revocaciones de rol/membership T durante el request.

Este subcambio debe recibir revisión adversarial específica: `download-authorization.ts`,
la rama tenant-wide de download en `routes.ts`, y los casos tenant download del
suite de orden. No se afirma revocación instantánea de URLs ya emitidas, ni se
cambia el comportamiento de descarga histórica autorizado por introducir la galería.

### 14.5 Matriz ejecutada y límites de evidencia

**Resultado final: backendAutomatedGate=PASS, 27/27 pasos, exit 0.**
Ejecución completa: 2026-10-17T12:56:41-05:00 → 2026-10-17T13:04:00-05:00, America/Bogota.
Node v22.23.3; PostgreSQL 18.6 (180006); darwin/arm64; storage simulated_only.
HEAD `47c8fc954a9951775ff7539f7fa02c0bcf39dd80` con working tree dirty: HEAD no identifica por sí solo estos cambios sin commit.
Digest SHA-256 de los 16 archivos de código/tests/runners modificados o nuevos, ordenados por ruta,
concatenando `ruta UTF-8 + NUL + bytes del archivo`: `4871afb64345b656bd9f57d6bd0a1cba974b26e3d95ef0c099c94c4913e2f2e9`. Documentos excluidos del digest.

| Comando / grupo registrado por B09 | Evidencia verificada | Exit |
| --- | --- | --- |
| `npm run security:secret-scan` | PASS — 1 marca(s) estricta(s) | 0 |
| `npm run typecheck` | PASS | 0 |
| `npm run lint` | PASS | 0 |
| `npm run build` | PASS | 0 |
| `npm run test` | PASS — 26/26, 78/78, 20/20, 5/5, 76/76 | 0 |
| `node --test media network/reconciliation + media-harness` | PASS — 143/143, 55/55 | 0 |
| `npm run test:db:sprint0:ci` | PASS — 65/65 | 0 |
| `npm run test:authz:db:ci` | PASS — 4/4 | 0 |
| `npm run test:tenant-context:db:ci` | PASS — 27/27 | 0 |
| `npm run test:api:multitenant:ci` | PASS — 4/4 | 0 |
| `npm run test:tenant-context:api:ci` | PASS — 75/75 | 0 |
| `npm run test:api:security:ci` | PASS — 12/12 | 0 |
| `npm run test:cross-tenant:final:ci` | PASS — 25/25 | 0 |
| `npm run test:reception:db:ci` | PASS — 24/24 | 0 |
| `npm run test:reception:upgrade:ci` | PASS — 20 marca(s) estricta(s) | 0 |
| `npm run test:reception:api:ci` | PASS — 123/123 | 0 |
| `npm run test:runtime:db:ci` | PASS — 1 marca(s) estricta(s) | 0 |
| `npm run test:db:migration-lock:ci` | PASS — 1 marca(s) estricta(s) | 0 |
| `npm run test:media:api:ci` | PASS — 725/725 | 0 |
| `npm run test:media:upgrade:ci` | PASS — 22 marca(s) estricta(s) | 0 |
| `npm run test:media:assigned:mutations:ci` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-reception-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-signature-api-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-close-api-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-reception-queries-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-reception-contract-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |
| `node scripts/test-inspection-mutations.cjs` | PASS — 1 marca(s) estricta(s) | 0 |

Los conteos se solapan entre suites y no se suman como tests únicos. `npm test`:
205 tests. Media API: **725/725**, con **104 casos nuevos** (102 de orden + 2 de deadline).
B07: **6/6 mutaciones detectadas, 0 sobrevivientes, 0 inválidas, 0 fallos de control**.
Regresión de mutaciones S3: recepción 22/22, firma 7/7, cierre 11/11, consultas 24/24,
contrato 19/19 e inspección 7/7, todas detectadas. Piso B09 sube de 621 a **725**
solo después del primer resultado completo 725/725; el run completo vuelve a verificarlo.
El harness del gate pasa 55/55 y conserva fallos cerrados para parcialidad/skips/summary inválido.

Carga sintética local: 105 assets con grafos válidos, 3 recorridos completos de
páginas de 100 (6 páginas); máximo observado en el gate completo: 130 ms
por página. Prueba adicional: 151 assets y plan con índices existentes. Exactamente
1000 filas de grafo pasa; crecimiento y exceso fallan cerrados. Ocho lecturas paralelas
con fuentes mezcladas terminan sin deadlock ni duplicados. Esto no certifica carga de staging.

Secret scan normal y scan adicional sobre índice Git temporal con archivos nuevos
más este contrato ignorado: **PASS**; índice real del usuario sin cambios.
`git diff --check` y comprobación de whitespace de todos los archivos nuevos/ignorados:
**PASS**. Enlaces locales, JSON de ejemplo y fences del contrato: **PASS**.
Sin cambios en schema, migraciones, índices/grants productivos, package/lockfile,
.gitignore, checkout backend principal ni frontend. Sin staging real, commit, push o PR.


Todas las pruebas de esta fase usan PostgreSQL 18.6 desechable local y storage
simulado. Los casos de tombstone usan entrypoints B06 con guards/RLS activos; no
arrancan el purger ni ejecutan un DELETE R2 real. La corrupción necesaria para
probar historia/linaje imposible ocurre exclusivamente en fixtures privilegiadas,
no en las sesiones runtime que ejercitan la API.

Los escenarios backend de §10 tienen cobertura permanente nueva en
`tests/media-api/order-query.test.cjs` y `order-query-deadline.test.cjs`.
Frontend/componentes/navegador y E2E real de §10 están **NOT_RUN — fuera del alcance
01A**, no se acreditan con un PASS backend. Los bloqueos de integración/storage,
duración, Phase B, familias futuras y purga física no se cierran por esta tarea.

La prueba del deadline se separa en un archivo propio para conservar los 60s por
archivo del runner; no se incrementan ni se suprimen timeouts/failures/skips. El
conteo B09 solo se eleva después de verificar el total completo con cero skips,
cancelados, failures o todo; no se rebajan pisos.

### 14.6 Archivos, riesgos residuales y Git

Runtime: `src/api/{app,server,tenant-request}.ts`,
`src/media/{associations,assigned-authorization,retention,routes}.ts`, nuevos
`src/media/{order-query,order-query-cursor,order-query-limits,download-authorization}.ts`.
Pruebas: los dos archivos order-query de media-api; runner/contrato de cobertura B09
y sus pruebas del piso. Documentación: este contrato y actualización de evidencia B09.
Sin cambios en schema/migraciones/índices/grants, dependencias ni repositorio frontend.

Riesgos residuales: lectura conserva serialización por workshop; la carga sintética
local no certifica capacidad/SLO de staging; rotación/consistencia de claves requiere
operación de secretos por despliegue; cursores no mantienen un snapshot entre páginas;
URLs previamente emitidas pueden seguir funcionando hasta expirar. La revisión
específica de signing T y la revisión adversarial de todo el cambio siguen siendo
necesarias antes de integrar/habilitar. No se habilita B07 Phase B ni otro M01–M04.

Se conserva la rama `task/s4-gap-01-order-media`, base `47c8fc9`, cambios sin commit,
push ni PR. El documento continúa ignorado por `docs/*`; debe incluirse explícitamente
en el futuro commit (`git add -f docs/S4-GAP-01-order-media-query-contract.md`) cuando
el usuario autorice esa fase. No se modifica .gitignore ni se hace staging del usuario.

N§7.23 y el Quality Gate global de Sprint 4 siguen **BLOCKED**: faltan frontend y
aceptación integrada. El resultado de 01A es preparación para revisión backend,
no cierre del criterio de producto ni certificación productiva.

Infraestructura de prueba: al terminar el gate se verificaron cero bases temporales.
Quedaban tres logins de fixtures de runners previos en el clúster aislado; el servidor
se detuvo y su directorio de datos se eliminó íntegramente, retirándolos con él.
No se alteraron roles de una instancia compartida. Scripts de parche, índice Git
temporal y logs crudos se eliminaron; solo se conservan evidencias sanitizadas en
`/private/tmp/tm-s4-gap-01a/` para esta revisión. El worktree con cambios sin commit
se conserva.

**S4-GAP-01A READY FOR ADVERSARIAL REVIEW**


## 15. S4-GAP-01A — remediación tras revisión adversarial (2026-10-17)

Esta sección actualiza el estado de revisión de §14 y conserva su evidencia histórica.
El primer adjunto terminaba a mitad de F3. El responsable aportó después su
continuación y F4–F6, regresiones y entregables; esta remediación incluye ese
alcance expreso. La aprobación D01–D07 continúa vigente.

### 15.1 F1 — espera de locks y ocupación del pool

**Causa verificada.** El arreglo de compatibilidad B01 toma correctamente el gate
de administración/membresía y el grafo B05 antes de emitir la URL, pero la rama
tenant-wide carecía de presupuestos SQL. En PostgreSQL 18.6 local desechable, la
regresión E1 anterior al arreglo esperó **5021 ms**, respondió 200 y firmó una URL
sintética al soltar el holder. E2, con 12 solicitudes y pool API real `max=10`,
demoró la lectura autorizada del tenant B **5043 ms**; las descargas tardaron
5024–5129 ms. Es una regresión de disponibilidad, no una prueba de bypass de
borrado: los locks de seguridad se conservan.

**Corrección.** `download-limits.ts` aplica, exclusivamente a la descarga GET y al
HEAD automático de Fastify, admisión por proceso/pool de `max(1, pool.max - 1)`
operaciones. En el pool de 10 admite 9 y rechaza de inmediato el exceso con 503
`MEDIA_QUERY_RETRY`, dejando capacidad para otras rutas. No usa tenant, roles ni
cabeceras sin verificar como autoridad o clave de admisión. No crea una cola propia.
La admisión precede cualquier consulta de bootstrap: la conexión se reserva una
vez, con espera máxima de 2 s. Una reserva tardía no ejecuta BEGIN, GUCs ni queries;
se libera cuando llega. Su cupo permanece ocupado hasta entonces, evitando que
reintentos creen una cola ilimitada de reservas pendientes en postgres.js.

Tras BEGIN, antes de bootstrap y `lockReader`, se establece `SET LOCAL
statement_timeout='8s'` y `SET LOCAL lock_timeout='2s'`. El mismo cliente reservado
recorre membresía, RBAC, autorización, locks B05 y lectura previa a firma. La
función de autorización tenant-wide también establece los presupuestos si se
invoca directamente dentro de una transacción. No se impone a descargas el
deadline total de 15 s de galería: 8 s es un límite por sentencia, no por operación.
Bajo múltiples sentencias/locks el total no se anuncia como 2 s ni 8 s.

55P03, 57014 y 40P01 se convierten en 503 seguro; otros SQLSTATE siguen propagándose
como antes. Ninguna víctima de autorización/timeout/deadlock alcanza la firma.
Los límites son locales a la transacción; el lifecycle usa el cliente raw para
ROLLBACK y sólo después libera conexión y cupo. No hay cancelación de protocolo
que pueda llegar tarde a una conexión reutilizada. Los permisos/estados/errores
de dominio y el historial de familias sensibles siguen rigiendo su contrato.
La descarga funciona sin `MEDIA_ORDER_CURSOR_KEY`. No cambian esquema, grants,
B07 Phase B, frontend ni la retención/purga física.

**Criterios de aceptación, reproducibles en `download-contention.test.cjs`:**

- E1: holder con barrera PostgreSQL, 503 tras aproximadamente 2 s (1.8–3.5 s
  incluyendo planificación), sin firmas/URL ni transacciones filtradas; al soltar
  el holder la siguiente descarga debe responder 200.
- E2: 12 intentos contra A con el lock retenido y pool API real NOBYPASSRLS de 10,
  con al menos 9 esperas comprobadas en `pg_stat_activity`; B debe completar su
  GET autorizado de clientes en <1 s. Todos los intentos A deben fallar 503 sin
  firmas y recuperarse en <9.5 s en este escenario (8 s por sentencia + 1.5 s de
  margen). `lock_timeout` reinicia al esperar otro lock; una cola de tuple/row
  puede tardar alrededor de 4 s. El watchdog sólo suelta el holder a los 10 s si
  falla la prueba. Tres intentos se rechazan antes del pool por admisión.
- Medir adquisiciones y tenencia de las conexiones por observación de los métodos
  nativos de postgres.js; no se sustituye el pool. Ejecutar GET y HEAD para que
  HEAD no pueda eludir la protección.
- Agotamiento externo del pool: reservar sus 10 conexiones reales, lanzar 12
  descargas; fallan en 1.8–3.5 s. Otros 12 reintentos deben fallar en <0.5 s sin
  nuevas reservas mientras las anteriores siguen pendientes. Soltar conexiones
  y comprobar limpieza y descarga posterior exitosa.
- 57014 real con `pg_sleep(10)` debe abortar la sentencia a los 8 s; antes de
  ROLLBACK otra sentencia observa 25P02. Tras rollback, ambos timeouts vuelven a
  0 y la conexión funciona. 22012 por división por cero conserva su SQLSTATE.

Resultados del gate final se registran debajo después de completar su ejecución.

### 15.2 F2 — deadlock 40P01 y protocolo B05

Se reproducen ciclos reales, con holder de orden y lector de recepción, tanto en
HTTP de descarga como de galería. El writer de prueba invierte deliberadamente
la jerarquía; se retrasa su `deadlock_timeout` a 5 s para que PostgreSQL elija al
lector como víctima al detectar el ciclo, antes de su `lock_timeout` de 2 s.
`pg_stat_database.deadlocks` debe incrementar exactamente una vez. Ambas respuestas
son 503 `MEDIA_QUERY_RETRY`, sin firma ni retry automático, y una descarga posterior
recupera el servicio. No se fabrican excepciones 40P01 en mocks.

Inspección de operaciones existentes: no hay comando API de transición terminal
de órdenes en `src`; el cierre de recepción crea la orden tras bloquear recepción.
B05/B06 y las lecturas usan el grafo común. No se encontró una pareja de comandos
soportados que justifique reordenar sus locks a partir del ciclo artificial.
Dos regresiones adicionales comprueban ambos ganadores con la primitiva B05 real.

Todo futuro writer de ciclo de vida de orden debe tomar, si aplica, el gate de
administración/membresía **antes** de locks de dominio y llamar
`lockOrderMediaRetention` **antes de bloquear o actualizar la orden**. Jerarquía
B05: recepciones → daños → órdenes → sesiones → assets; IDs ordenados por nivel;
asignaciones se toman después en lecturas B07. Recalcular en la misma transacción
con la prueba obtenida. La clasificación 40P01 no sustituye este protocolo.
Este requisito también queda documentado junto a la primitiva en `retention.ts`.


### 15.3 F3 — regresiones permanentes y mutantes focalizados

Los IDs M03/M15/etc. de esta sección identifican mutantes de la revisión; no
aprueban las exclusiones M01–M04 de contrato faltante documentadas anteriormente.

Se añaden casos al suite existente, compartiendo sus fixtures y barreras; M29
se ubica en el archivo de deadline para conservar el límite de 60 s por archivo.
No se duplican suites completas ni se modifica semántica para matar mutantes.

| Guard | Condición negativa permanente | Efecto al retirar sólo el guard |
| --- | --- | --- |
| M03 | Mientras espera el gate real, el actor pasa de permiso tenant a assigned. El writer runtime sigue gate → workshop → roles. Se comprueba galería y descarga; una petición nueva puede usar su asignación válida | El mutante de lectura fresca permite 200 donde se exige 404 |
| M15 | Cambiar sort_order mientras el lector espera el asset sustituye el primer candidato por otro asset que no está en su lock set | Responde 200 en vez de 409 MEDIA_ASSOCIATION_CONFLICT |
| M16 | Página vacía y página filtrada mantienen locks sobre recepción y orden. Otro backend usa NOWAIT para probar ambos | Sin parents explícitos, la página vacía deja adquirir el lock que debe denegarse |
| M20 | Consultar el timeout efectivo de PostgreSQL con presupuesto restante de 1800 ms | Falla la aserción si SQL ve 8000 ms en vez del presupuesto restante |
| M27 | Construir buildProductionApi con keyring válido y llamar HTTP a una orden real | Omitir el codec de registro devuelve 404 en vez de galería 200 |
| M29 | onSend termina después de vencer el deadline, habiendo concluido el handler. El lifecycle debe rechazar antes de COMMIT | Sin recheck devuelve 200 en vez de 503 |
| M34b | Insertar una sesión equivalente después del tier de sesiones mientras el lector espera el asset | Sin detección de sesiones desconocidas devuelve 200 en vez de 409 |
| M34c | Pausar después de SQL real con assets vacíos y parent explícito; insertar una orden tardía sin incluirla en los locks conocidos | Sin detección de órdenes nuevas retorna una prueba en vez de conflicto |

Los fixtures adversariales de M15/M34 usan un writer privilegiado y réplica local
para producir cambios que los comandos actuales normalmente impedirían. No se
concede bypass al lector ni se atribuye el estado corrupto a una operación pública
soportada. M34c aísla el guard de orden tardía del guard diferente de parent enlazado.

`node scripts/test-order-media-mutations.cjs` ejecuta controles y los ocho mutantes
sobre la compilación temporal del harness (`tallermecario-crm-api-test-*`, fuera del
worktree), eliminada en finally. Valida anclas, migración, limpieza, un único test
fallido con ERR_ASSERTION, título/archivo correctos, cero PASS seleccionados y
cero cancelaciones/skips/todos. Un error de infraestructura o una ancla ausente no
cuenta como detección. Resultado observado: **8 detectados, 0 supervivientes,
0 inválidos**; M03/M15/M16/M20/M27/M29/M34b/M34c. M29 control y mutante requieren
el deadline real; no se falsea el reloj de la aplicación para ese caso.

### 15.4 F4 — configuración y aviso de despliegue

`.env.example` y `staging.env.example` documentan MEDIA_ORDER_CURSOR_KEY como
entrada comentada de nombre, sin material. Explican keyring, omisión para desactivar,
rotación y sincronización de relojes. Compose documenta su omisión en el drill;
no se le inyecta cadena vacía ni clave generada. `buildProductionApi` emite una sola
entrada fija `event=order_media_route_disabled`, `reason=cursor_key_missing` cuando
falta el codec. El aviso no contiene entorno, IDs de clave, valores ni cursores.
Con clave válida se registra la ruta sin ese aviso. Con clave malformada, el proceso
real de startup termina con MEDIA_ORDER_CURSOR_CONFIGURATION_INVALID antes de
necesitar una URL de base de datos válida; se verifica en un child hermético.

### 15.5 F5 — reloj y configuración ambigua (no bloqueante)

Antes de la corrección, el experimento determinista confirmó rechazo con emisor
1 ms adelantado, aceptación de JSON con un key ID duplicado (ganaba el último) y
aceptación de bytes idénticos bajo dos IDs. No se encontró bypass de autorización:
los cursores nunca sustituyen membresía, permiso ni asignación.

Se conserva `issuedAt > now` como rechazo cerrado. Es un riesgo operativo de
disponibilidad entre instancias con reloj desincronizado; deben sincronizar UTC
antes de compartir el keyring y supervisar su desfase. No se añade tolerancia ni
se amplía la vigencia: pruebas deterministas rechazan +1 ms futuro y expiración
exacta issuedAt+900000, aceptando issuedAt y el último milisegundo anterior.

Se rechazan nombres JSON duplicados, incluso alias Unicode escapados, para evitar
que JSON.parse sustituya silenciosamente material/ID de rotación. También se
rechazan bytes repetidos bajo IDs distintos: retirar un ID no retira un secreto
comprometido si otro ID mantiene ese mismo material activo. Es una configuración
de rotación insegura y ambigua, no un nuevo permiso ni un cambio del formato público
de cursor. Nombres distintos con claves distintas y la rotación válida siguen
aceptados. Los errores son fijos y no revelan material; ningún secreto real entra
en templates, logs, tests o evidencia.

### 15.6 F6 — piso B09 independiente

El runner exige de forma independiente media API >= **725** al construir el plan,
además del piso creciente del JSON. El harness tiene una aserción literal de ese
baseline, negativas para 724/621 y positiva para un aumento legítimo. Los cuatro
casos nuevos elevaron su conteo observado 55 → **59**, confirmado antes de actualizar
su piso. Copias temporales reales con s4-quality-coverage.json modificado a 724 y
621 fallaron el harness con exit 1 y MEDIA_API_COVERAGE_FLOOR_INVALID. Se eliminaron
las copias. Permanecen todas las protecciones contra summaries parciales, skips,
cancelaciones, falso PASS, filtros, npmrc y sustitución de reporters.

### 15.7 Matriz de regresión final y fuente revisable
Gate completo **PASS, exit 0, 27/27 pasos**, PostgreSQL 18.6 local desechable, storage simulado. Inicio UTC `2026-10-18T04:24:47.663Z`; fin `2026-10-18T04:32:44.714Z`. Comando: `DATABASE_URL=postgresql://postgres@127.0.0.1:54390/postgres S4_GATE_DISPOSABLE_DATABASE=1 npm run test:s4:quality-gate -- --report /private/tmp/tm-s4-gap-01a-remediation/full-gate-report.json`.

| Comprobación | Resultado |
| --- | --- |
| `npm run security:secret-scan` | PASS; exit 0 — 1 marcadores |
| `npm run typecheck` | PASS; exit 0 |
| `npm run lint` | PASS; exit 0 |
| `npm run build` | PASS; exit 0 |
| `npm run test` | PASS; exit 0 — 26/26, 78/78, 20/20, 5/5, 76/76 |
| `node --test tests/media/r2-network.test.cjs tests/media/r2-transport.test.cjs tests/media/reconciliation.test.cjs tests/media/reconciliation-r2.test.cjs tests/media-harness/assignment-mutations.test.cjs tests/media-harness/quality-gate.test.cjs` | PASS; exit 0 — 143/143, 59/59 |
| `npm run test:db:sprint0:ci` | PASS; exit 0 — 65/65 |
| `npm run test:authz:db:ci` | PASS; exit 0 — 4/4 |
| `npm run test:tenant-context:db:ci` | PASS; exit 0 — 27/27 |
| `npm run test:api:multitenant:ci` | PASS; exit 0 — 4/4 |
| `npm run test:tenant-context:api:ci` | PASS; exit 0 — 75/75 |
| `npm run test:api:security:ci` | PASS; exit 0 — 12/12 |
| `npm run test:cross-tenant:final:ci` | PASS; exit 0 — 25/25 |
| `npm run test:reception:db:ci` | PASS; exit 0 — 24/24 |
| `npm run test:reception:upgrade:ci` | PASS; exit 0 — 20 marcadores |
| `npm run test:reception:api:ci` | PASS; exit 0 — 123/123 |
| `npm run test:runtime:db:ci` | PASS; exit 0 — 1 marcadores |
| `npm run test:db:migration-lock:ci` | PASS; exit 0 — 1 marcadores |
| `npm run test:media:api:ci` | PASS; exit 0 — 747/747 |
| `npm run test:media:upgrade:ci` | PASS; exit 0 — 22 marcadores |
| `npm run test:media:assigned:mutations:ci` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-reception-mutations.cjs` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-signature-api-mutations.cjs` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-close-api-mutations.cjs` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-reception-queries-mutations.cjs` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-reception-contract-mutations.cjs` | PASS; exit 0 — 1 marcadores |
| `node scripts/test-inspection-mutations.cjs` | PASS; exit 0 — 1 marcadores |

Media API **747/747**, sin fallos/cancelaciones/skips/todos; 22 regresiones nuevas de remediación (126 nuevas desde 621): nueve F1/F2/B05, doce F3/F4/F5 y una M29. Piso **725 → 734 → 747**, cada aumento posterior al conteo completo observado y confirmado en gate. Harness B09 **59/59**; `npm test` **205**. B07: **6 mutaciones detectadas**; regresiones de mutación S3 completas PASS.

Ejecuciones focalizadas adicionales (exit 0): `node scripts/test-order-media-mutations.cjs` (8/8 detectados, controles sin fallos); `node --test tests/media-harness/quality-gate.test.cjs` (59/59). Los JSON mutantes 724 y 621 fallaron intencionadamente con exit 1. La suite completa verifica ambos ganadores de firma/borrado, downgrade/revocación de rol/membresía, historial signature/document/quote_pdf, técnicos assigned, cursor/paginación y todos los guards indicados arriba.

Mediciones del gate final (ms; sin identificadores ni URLs):

| Escenario | Medición |
| --- | --- |
| E1 | respuesta 2011; firmas 0 |
| E2 GET | 12 intentos; 9 esperas; B 9; recuperación 4014; checkout nativo 0–5; tenencia A hasta rollback/release 2009–4005 |
| E2 HEAD | 12 intentos; 9 esperas; B 2; recuperación 4011; checkout nativo 0–0; tenencia A hasta rollback/release 2010–4007 |
| acquisition | 24 intentos; primera ráfaga 2009; reintentos rechazados 12 |

La admisión se aplica por proceso/pool; no es un scheduler global entre réplicas. Con pool de una conexión no hay slot adicional para B; siguen los límites SQL/de adquisición. Las mediciones prueban los escenarios indicados, no certifican capacidad de producción.

Historia de ejecución: un primer gate F1/F2 terminó FAIL/exit 143 durante media API tras reposo del host confirmado en pmset: archivos de 60 s registraron 616 s y 909 s; una sentencia de 8 s se observó tras 26 s. Se conserva separado y no sirve como evidencia válida de latencia. La repetición completa F1/F2 pasó 27/27 con 734 media API, antes de recibir F3–F6 completos. El gate FINAL arriba incorpora F1–F6 y se ejecutó íntegro sobre otro clúster nuevo con caffeinate -i limitado al comando. Un intento final adicional se detuvo en el secret scan al desplazar un comentario de Compose una línea con excepción histórica revisada; se movió el comentario al final para conservar las posiciones, sin modificar el scanner ni ampliar su allowlist. Se conserva también ese reporte de preflight abortado. No se relajaron tests, pisos ni timeouts.

Identidad de fuentes finales: rama `task/s4-gap-01-order-media`, HEAD `47c8fc954a9951775ff7539f7fa02c0bcf39dd80`. Digest SHA-256 de 24 archivos modificados/nuevos no documentales (ruta relativa UTF-8, NUL y bytes, orden lexicográfico): `3a4e3b985f53123daaffdc941a73904259096527738b8f41b4bbe94998a52e72`. Se congelaron antes del gate y se verifican al cierre.

Estado Git del parche completo (incluye trabajo 01A anterior; sin staging real, commit, push ni PR):

- Modificados (15): `.env.example`, `docker-compose.staging.yml`, `docs/quality/s4-backend-final-quality-gate.md`, `scripts/s4-quality-coverage.json`, `scripts/test-crm-api.cjs`, `scripts/test-s4-quality-gate.cjs`, `src/api/app.ts`, `src/api/server.ts`, `src/api/tenant-request.ts`, `src/media/assigned-authorization.ts`, `src/media/associations.ts`, `src/media/retention.ts`, `src/media/routes.ts`, `staging.env.example`, `tests/media-harness/quality-gate.test.cjs`.
- Nuevos (10): `scripts/order-media-mutations.cjs`, `scripts/test-order-media-mutations.cjs`, `src/media/download-authorization.ts`, `src/media/download-limits.ts`, `src/media/order-query-cursor.ts`, `src/media/order-query-limits.ts`, `src/media/order-query.ts`, `tests/media-api/download-contention.test.cjs`, `tests/media-api/order-query-deadline.test.cjs`, `tests/media-api/order-query.test.cjs`.
- Ignorado canónico: `docs/S4-GAP-01-order-media-query-contract.md` por docs/*. Debe incorporarse explícitamente al autorizar una futura integración; no se modifica .gitignore.

Evidencia sanitizada en `/private/tmp/tm-s4-gap-01a-remediation/`: full-gate-report.json, validation-summary.json, guard-mutations.log, floor-mutations.json, secret-scan.log, f1-f2-full-gate-report.json y sleep-invalid-full-gate-report.json. Secret scan adicional incluye nuevos e ignorados con índice temporal; el índice real se conserva idéntico.

**F1–F6 completos para revisión focalizada.** N§7.23 y el gate global de Sprint 4 permanecen BLOCKED por frontend/aceptación integrada y evidencia externa; producción NOT_READY. Sin frontend, schema, migraciones, grants, nuevos propósitos/duraciones/permisos ni purga/B07 Phase B. Descarga TTL 300 s y cursor 15 min intactos.

Limpieza final: inventario posterior al gate con **0 bases temporales** y **0 otras
conexiones cliente**. Los únicos roles LOGIN eran canónicos (postgres, API,
worker y migrator), sin logins de fixtures. Ambos servidores PostgreSQL propios
se detuvieron y sus directorios de datos se retiraron; no se tocaron instancias
compartidas. Se retiraron helpers/copias/logs crudos desechables y se conservó sólo
la evidencia sanitizada indicada. El backend principal y frontend permanecen
limpios; el worktree con el parche sin commit se conserva para revisión.

S4-GAP-01A READY FOR TARGETED RE-REVIEW


## 16. S4-GAP-01A — F1-N1 disponibilidad final (2026-10-18)

**Estado vigente: candidato verificado localmente; MERGE BLOCKED hasta que un revisor
independiente verifique el nuevo candidato.** N§7.23 / Full Sprint 4 / Production
Readiness siguen BLOCKED / BLOCKED / NOT_READY. No se integra por este encargo.
Las ejecuciones de §§14–15 son históricas y se preservan: 621 era el baseline B09
antiguo; 725 y 747 pertenecen a fases posteriores. El baseline inmediato de esta
remediación es **747 media API, 205 generales, 59 harness, 8 mutantes focalizados,
6 B07 y 27 pasos**. No se presenta ninguno de esos conteos como el resultado nuevo.

### 16.1 Reproducción del defecto sano

La admisión sin espera de §15 limitaba correctamente a pool.max−1 activos, pero
rechazaba cualquier llegada adicional aunque el DB estuviera sano. Se reprodujo
con PostgreSQL **18.6**, API NOBYPASSRLS/pool real max=10, HTTP real y R2 simulado,
sin locks artificiales. Treinta lotes (tres repeticiones de diez formas) sumaron
**672 solicitudes: 270 HTTP 200 y 402 HTTP 503**. En cada lote 10/12/20/40 GET,
el resultado fue 9 éxitos y respectivamente 1/3/11/31 rechazos; HEAD, mezcla y
ambos tenants confirmaron el mismo problema. No era agotamiento real de SQL:
se rechazaba antes de poder aprovechar las liberaciones próximas.

### 16.2 Diseño y límites elegidos

Se conserva **max(1, pool.max−1)** como límite activo (9 con max=10). Un pool de
una sola conexión conserva su limitación previa: no puede reservar otra para B.
Al agotarse los activos se admite una cola **FIFO de hasta 64 waiters**, cada uno
con **500 ms de espera máxima de admisión**. Cola realmente llena o plazo vencido
→ 503 MEDIA_QUERY_RETRY, sin reintentos internos. El deadline usa performance.now.
La entrega comprueba expiración además del timer, por lo que un timer demorado
por el event loop nunca habilita una entrega fuera de plazo. Nuevas llegadas no
saltan waiters existentes. La identidad se verifica antes de entrar; tenant,
roles y cabeceras no se usan como autoridad ni para reservar cupos ajenos.

Son decisiones de ingeniería de este candidato, no nuevos requisitos de producto.
Cuarenta simultáneas requieren como máximo 31 esperas tras las 9 activas; 64 da
margen acotado para ráfagas solapadas sin elevar concurrencia SQL. Se evaluó el
extremo de 500 ms del rango sugerido 250–500 ms: la matriz sana posterior termina
muy por debajo de esa ventana, según mediciones debajo, y 500 ofrece margen de
planificación respecto de 250 manteniendo un límite corto bajo contención.
Estas cifras locales no certifican rendimiento de producción.

Esperar admisión **no invoca database.reserve**. Al recibir cupo comienza el
límite independiente de **2 s de adquisición**; siguen **2 s por espera de lock**
y **8 s por sentencia**, locales a la transacción. No se añade el deadline total
15 s de galería a las descargas. Una reserva nativa abandonada conserva el cupo
hasta llegar/fallar; al llegar se libera sin BEGIN y sólo entonces devuelve cupo.
Así no se acumulan reservas nativas abandonadas sin límite.

El release del cupo es idempotente. Cancelación/expiración retira la entrada,
borra su timer y listener AbortSignal. La integración HTTP observa aborted y el
close de la respuesta (no el close normal de un GET ya recibido). Desconexiones
antes de usar SQL fallan cerradas; si ya hay SQL en vuelo, se espera su terminación
acotada y se hace ROLLBACK antes de soltar conexión/cupo. El cliente raw sigue
permitiendo cleanup aunque el proxy de consultas rechace una cancelación.
Hay pruebas de la carrera de cancelación justo después de entregar cupo, de una
reserva nativa tardía y de disconnect durante bootstrap y durante locks de handler.
GET y HEAD usan exactamente la misma admisión y cancelación.

### 16.3 Ráfagas sanas — antes y después

Cada fila resume tres repeticiones. Los elapsed son duración HTTP total del lote,
no sólo espera de admisión. Los máximos de activos/cola se muestrean durante las
solicitudes; poolPeak observa reservas/liberaciones nativas sin sustituir el pool.

| Forma | Solicitudes por repetición | Antes 200/503 por repetición | Después 200/503 por repetición | Después elapsed ms (mín–máx) | Máx activos / cola |
| --- | ---: | --- | --- | --- | --- |
| GET | 10 | 9/1; 9/1; 9/1 | 10/0 ×3 | 41–56 | 9 / 1 |
| GET | 12 | 9/3; 9/3; 9/3 | 12/0 ×3 | 54–65 | 9 / 3 |
| GET | 20 | 9/11; 9/11; 9/11 | 20/0 ×3 | 93–102 | 9 / 11 |
| GET | 40 | 9/31; 9/31; 9/31 | 40/0 ×3 | 184–188 | 9 / 31 |
| HEAD | 10 | 9/1; 9/1; 9/1 | 10/0 ×3 | 46–48 | 9 / 1 |
| HEAD | 12 | 9/3; 9/3; 9/3 | 12/0 ×3 | 56–58 | 9 / 3 |
| HEAD | 20 | 9/11; 9/11; 9/11 | 20/0 ×3 | 91–98 | 9 / 11 |
| HEAD | 40 | 9/31; 9/31; 9/31 | 40/0 ×3 | 179–189 | 9 / 31 |
| mixed | 40 | 9/31; 9/31; 9/31 | 40/0 ×3 | 178–183 | 9 / 31 |
| two-tenants | 20 | 9/11; 9/11; 9/11 | 20/0 ×3 | 59–65 | 9 / 11 |

Resultado posterior focalizado: **672/672 HTTP 200, cero 503**, máximo 9 reservas
activas y pico 31 waiters. mixed alterna GET/HEAD en 40 requests; two-tenants hace
10 GET de A y 10 de B simultáneos. No se confunde esa prueba sana con el agotamiento.
El gate final repetirá la matriz sobre las fuentes congeladas y registrará sus
mediciones independientes abajo.

### 16.4 Contención, agotamiento y cancelación

E1 ahora retiene **workshop, recepción y asset por separado**. Barreras de
pg_blocking_pids comprueban la espera; el lector responde 503 en torno a 2 s con
cero firmas, hace rollback y la siguiente descarga autorizada funciona al liberar.
Se preservan ambos ganadores de borrado/emisión y revocaciones del suite existente.

E2 ejecuta 12 GET y luego 12 HEAD contra A con lock real. Se observan 9 esperas
PostgreSQL y 3 waiters de admisión. Mientras tanto B ejecuta simultáneamente
clientes y galería, mediante HTTP real y el mismo pool: ambos deben terminar en
<1 s, antes de que terminen los holders A. Todos los A deben fallar sin firmas;
las esperas de admisión vencen alrededor de 500 ms y los activos conservan los
límites SQL. Recuperación de este escenario <9.5 s, contemplando que lock_timeout
reinicia entre locks. Clientes/galería y descarga posterior comprueban recuperación.

Pruebas permanentes adicionales: llenar los 64 waiters y enviar overflow (503
anticipado); expirar la cola sin una sola reserva nativa; quitar GET/HEAD cancelados
antes de vencer el plazo; entregar FIFO antes de un recién llegado; release doble
sin modificar el contador; cancelar después del handoff pero antes de reservar;
cancelar reserva nativa pendiente y liberar su resultado tardío sin BEGIN;
cancelar bootstrap/SQL activo sin liberar prematuramente. Se comprueban cero
idle-in-transaction, cupos y waiters cero al recuperar y listeners AbortSignal
retirados. La cola no hace polling ni crea un scheduler de fondo.

### 16.5 LOW restantes y regresiones permanentes

**F1-N2:** FIFO evita saltos indefinidos dentro del pool, pero no es cuota justa
por tenant ni scheduler entre réplicas. A bloqueado puede ocupar los nueve cupos
y hacer que una descarga de B expire tras 500 ms. Esa limitación global ya existía
como 503 inmediato; no se afirma que desaparezca. La cola no toma una décima
conexión y la prueba demuestra progreso independiente de clientes/galería de B.
No se observó una regresión material nueva que justifique introducir una política
por tenant a partir de cabeceras sin verificar. Se deja esta limitación explícita
para revisión y futuras pruebas de despliegue, sin prometer SLA productivo.

**F3-N1:** dos regresiones HTTP permanentes ejercitan openTenantRequest con
selección malformada y tenant ajeno/no miembro. Tras 400/403 reservan las diez
conexiones reales y comprueban timeout settings 0/0 y ninguna transacción abierta.
El cleanup del test revierte cualquier tx aun al fallar. Retirar únicamente el
ROLLBACK del catch produce ERR_ASSERTION en la regresión, no un error de fixture.

**F3-N2:** CI invoca explícitamente node scripts/test-order-media-mutations.cjs en
el job mutations, serial tras B07, con timeout-minutes=5. Se mantiene el gate de
27 pasos sin alterar su semántica. El runner añade F3N1 y N1 a los ocho guards
anteriores: N1 restaura rechazo inmediato y debe fallar la matriz sana. Valida
controles, anclas, migraciones, cleanup, diagnósticos/título/archivo, cero survivors,
invalids, skips o cancelaciones. No se ha ejecutado CI remoto: no hay push/PR.

**F6-N1 / F5:** 747 es el baseline inmediato y los conteos nuevos se registran
sólo después de observar ejecución completa. Se preserva mínimo independiente
725 como piso histórico, nunca se rebaja cobertura. El cursor mantiene rechazo
de issuedAt futuro y expiración exacta 15 min; sigue el requisito operativo UTC.
No se cambió criptografía, TTL de descarga 300 s, RBAC, B07 Phase B, propósitos,
duraciones, schema/migraciones/grants, frontend ni purga/R2 real.


### 16.6 Verificación final sobre fuentes congeladas

**Gate completo local PASS, 27/27 pasos, exit 0.** PostgreSQL 18.6 nuevo,
R2 exclusivamente simulado. Esta verificación permite solicitar revisión; no
levanta el bloqueo de merge ni ninguno de los pendientes de producto/despliegue.

Inicio UTC `2026-10-18T05:18:45.470Z`; fin `2026-10-18T05:26:39.371Z`. Comando exacto:

`DATABASE_URL=postgresql://postgres@127.0.0.1:54392/postgres S4_GATE_DISPOSABLE_DATABASE=1 npm run test:s4:quality-gate -- --report /private/tmp/tm-s4-gap-01a-f1n1/full-gate-report.json`.

| Comando | Evidencia | Exit |
| --- | --- | ---: |
| `npm run security:secret-scan` | PASS — 1 marcadores verificados | 0 |
| `npm run typecheck` | PASS | 0 |
| `npm run lint` | PASS | 0 |
| `npm run build` | PASS | 0 |
| `npm run test` | PASS — 26/26, 78/78, 20/20, 5/5, 76/76 | 0 |
| `node --test tests/media/r2-network.test.cjs tests/media/r2-transport.test.cjs tests/media/reconciliation.test.cjs tests/media/reconciliation-r2.test.cjs tests/media-harness/assignment-mutations.test.cjs tests/media-harness/quality-gate.test.cjs` | PASS — 143/143, 59/59 | 0 |
| `npm run test:db:sprint0:ci` | PASS — 65/65 | 0 |
| `npm run test:authz:db:ci` | PASS — 4/4 | 0 |
| `npm run test:tenant-context:db:ci` | PASS — 27/27 | 0 |
| `npm run test:api:multitenant:ci` | PASS — 4/4 | 0 |
| `npm run test:tenant-context:api:ci` | PASS — 75/75 | 0 |
| `npm run test:api:security:ci` | PASS — 12/12 | 0 |
| `npm run test:cross-tenant:final:ci` | PASS — 25/25 | 0 |
| `npm run test:reception:db:ci` | PASS — 24/24 | 0 |
| `npm run test:reception:upgrade:ci` | PASS — 20 marcadores verificados | 0 |
| `npm run test:reception:api:ci` | PASS — 123/123 | 0 |
| `npm run test:runtime:db:ci` | PASS — 1 marcadores verificados | 0 |
| `npm run test:db:migration-lock:ci` | PASS — 1 marcadores verificados | 0 |
| `npm run test:media:api:ci` | PASS — 761/761 | 0 |
| `npm run test:media:upgrade:ci` | PASS — 22 marcadores verificados | 0 |
| `npm run test:media:assigned:mutations:ci` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-reception-mutations.cjs` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-signature-api-mutations.cjs` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-close-api-mutations.cjs` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-reception-queries-mutations.cjs` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-reception-contract-mutations.cjs` | PASS — 1 marcadores verificados | 0 |
| `node scripts/test-inspection-mutations.cjs` | PASS — 1 marcadores verificados | 0 |

Media API **761/761** (14 nuevas sobre el baseline inmediato 747), harness **59/59**,
generales **205**; sin fallos, skips, cancelaciones ni todos. El piso JSON subió
747 → **761 sólo tras observar el suite completo**, y el gate confirmó de nuevo ese
conteo. Mínimo independiente histórico 725 intacto. Mutantes focalizados: **10
eliminados, 0 supervivientes, 0 inválidos** (N1 y F3N1 nuevos más los 8 anteriores),
ejecutados además del gate con `node scripts/test-order-media-mutations.cjs` (exit 0).
El CI invoca ese mismo runner con un límite de cinco minutos. B07: **6 detectados**;
S3: recepción22/firma7/cierre11/consultas24/contrato19/inspección7, todos detectados.
La sintaxis y la invocación CI se validaron con YAML.safe_load; no se ejecutó CI remoto.

Los casos incluidos vuelven a verificar deletion-wins/reader-wins, downgrade de rol,
revocación de membresía, signature/document/quote_pdf históricos, técnicos assigned
autorizados/denegados y B07 Phase B denegada. TTL300s, permisos, aislamiento y
privacidad no se relajaron para conseguir capacidad de ráfaga.

Mediciones independientes del gate final:

| Caso | Resultado real | Criterio |
| --- | --- | --- |
| E1 workshops | 2011 ms; 0 firmas | 503; 1.8–3.5 s y retry posterior200 |
| E1 receptions | 2009 ms; 0 firmas | 503; 1.8–3.5 s y retry posterior200 |
| E1 media_assets | 2008 ms; 0 firmas | 503; 1.8–3.5 s y retry posterior200 |
| E2 GET | B clientes 31 ms / galería 30 ms; A recuperación 4008 ms; activos 9, cola 3 | B <1s; A sin firmas; recuperación <9.5s |
| E2 HEAD | B clientes 20 ms / galería 18 ms; A recuperación 4007 ms; activos 9, cola 3 | B <1s; A sin firmas; recuperación <9.5s |
| Expiración de cola | 502 ms; reservas nativas 0 | >=450ms y <1s; ninguna reserva |
| Cola llena | 65 intentos; pico 64; rápido/lento 9/513 ms; reservas 0 | 65×503; máximo64 waiters; ninguna reserva |
| Cancelación GET | cleanup 1 ms; reservas 0 | <300ms; waiter0; sin firmas |
| Cancelación HEAD | cleanup 0 ms; reservas 0 | <300ms; waiter0; sin firmas |
| Pool agotado real | primera ráfaga 2010 ms; segunda 514 ms | adquisición2s; nueva admisión500ms; reserva tardía sin BEGIN |

| Ráfaga final | Por lote ×3 | HTTP200 / HTTP503 total | elapsed ms mín–máx | p50 ms mín–máx | Activos / waiters máx |
| --- | --- | --- | --- | --- | --- |
| GET | 10×3 | 30 / 0 | 49–61 | 30–37 | 9 / 1 |
| GET | 12×3 | 36 / 0 | 63–66 | 38–40 | 9 / 3 |
| GET | 20×3 | 60 / 0 | 102–113 | 59–67 | 9 / 11 |
| GET | 40×3 | 120 / 0 | 200–215 | 109–118 | 9 / 31 |
| HEAD | 10×3 | 30 / 0 | 51–56 | 31–36 | 9 / 1 |
| HEAD | 12×3 | 36 / 0 | 58–65 | 36–40 | 9 / 3 |
| HEAD | 20×3 | 60 / 0 | 102–105 | 59–62 | 9 / 11 |
| HEAD | 40×3 | 120 / 0 | 200–212 | 107–115 | 9 / 31 |
| mixed | 40×3 | 120 / 0 | 199–211 | 111–114 | 9 / 31 |
| two-tenants | 20×3 | 60 / 0 | 63–69 | 41–42 | 9 / 11 |

Resultado final: **672/672 HTTP200, cero 503**; máximo HTTP del lote 215 ms frente a ventana de admisión500ms. El HTTP total acota por arriba la espera de admisión de estos casos. No se extrapola a producción.

### 16.7 Identidad, inventario y entrega

Rama `task/s4-gap-01-order-media`, HEAD/base `47c8fc954a9951775ff7539f7fa02c0bcf39dd80`; working tree dirty esperado. SHA-256 de 25 fuentes no documentales modificadas/nuevas, rutas UTF-8 ordenadas + NUL + bytes: `fd4d5c83c8ad104e70611433cdcc656f8bbbddf20a84794c21cf351b6d0cbdc7`. Digest histórico previo F1–F6: `3a4e3b985f53123daaffdc941a73904259096527738b8f41b4bbe94998a52e72`. Las fuentes se congelaron antes del gate y se verifican al cierre.

- Modificados (16): `.env.example`, `.github/workflows/ci.yml`, `docker-compose.staging.yml`, `docs/quality/s4-backend-final-quality-gate.md`, `scripts/s4-quality-coverage.json`, `scripts/test-crm-api.cjs`, `scripts/test-s4-quality-gate.cjs`, `src/api/app.ts`, `src/api/server.ts`, `src/api/tenant-request.ts`, `src/media/assigned-authorization.ts`, `src/media/associations.ts`, `src/media/retention.ts`, `src/media/routes.ts`, `staging.env.example`, `tests/media-harness/quality-gate.test.cjs`.

- Nuevos (10): `scripts/order-media-mutations.cjs`, `scripts/test-order-media-mutations.cjs`, `src/media/download-authorization.ts`, `src/media/download-limits.ts`, `src/media/order-query-cursor.ts`, `src/media/order-query-limits.ts`, `src/media/order-query.ts`, `tests/media-api/download-contention.test.cjs`, `tests/media-api/order-query-deadline.test.cjs`, `tests/media-api/order-query.test.cjs`.

- Ignorado canónico: `docs/S4-GAP-01-order-media-query-contract.md`, conservado para
  inclusión explícita en un commit futuro. No se modifica .gitignore.
- Índice real idéntico, staging cero; sin commit, push ni PR. Backend principal y
  frontend no reciben cambios. No schema/migraciones/grants/purger ni R2 DELETE.

Secret scan ampliado y whitespace incluyen nuevos e ignorados mediante índice
temporal separado del real. Evidencia sanitizada local en
`/private/tmp/tm-s4-gap-01a-f1n1/`: validation-summary.json, full-gate-report.json,
final-mutations.log y secret-scan.log. Los resultados previos de otras fases siguen
en sus directorios y fechas históricos; no se sobreescriben.

**MERGE BLOCKED hasta revisión independiente del candidato actualizado.**
N§7.23 BLOCKED; Full Sprint 4 Gate BLOCKED; Production Readiness NOT_READY.

La invocación local equivalente al paso de CI, con
`NODE_OPTIONS=--test-reporter=spec node scripts/test-order-media-mutations.cjs`,
terminó exit0 en 53159ms: 10 detectados, cero supervivientes o inválidos, dentro
del timeout300000ms. No se ejecutó CI remoto. Evidencia: `ci-mutations.log`.

Al cierre ambos clústeres PostgreSQL18.6 desechables fueron detenidos y eliminados.
El inventario final del clúster del gate registró cero bases de pruebas y cero
otras conexiones cliente; sólo roles login canónicos del clúster desechable
(postgres/API/migrator/worker), eliminados junto con él. El clúster de benchmarks
registró también cero bases de pruebas y cero conexiones residuales. Se conservan
únicamente los resúmenes y resultados sanitizados; se retiran copias y logs crudos.

S4-GAP-01A F1-N1 READY FOR FINAL RE-REVIEW
