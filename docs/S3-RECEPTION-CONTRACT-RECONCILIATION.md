# S3 reception HTTP contract reconciliation — evidencia local

Fecha: 2026-10-02 (America/Bogota). Runtime de los gates aceptados: Node 22.23.3.

## Target y procedencia

- Worktree: C:/Users/leopa/OneDrive/Documentos/Proyectos/TallerMecarioB-worktrees/s3-reception-contract-reconcile.
- Rama: fix/s3-reception-contract-reconcile.
- Base verificada y limpia antes de editar: 89186a4162e1401bcf14b82d259ed7927205e519.
- Referencia histórica: task/s3-reception-contract, daff672ea22ab07c2e8e3e7656088268a304e321.
- Commit previsto: fix(api): reconcile reception HTTP contract. El SHA final se entrega en el handoff; este documento forma parte de ese commit.
- No merge, cherry-pick, push ni acceso a Notion. Se reutilizó el worktree exacto solicitado.

## Huecos reales y contrato resultante

En la base faltaban los tres GET, el puntero explícito de presentación de privacidad, docs/api/reception-contract.md y la suite/harness del contrato. La captura, catálogo y configuración de privacidad de producción ya existían y son autoritativos.

| GET | Query / permiso | Respuesta 200 |
| --- | --- | --- |
| /api/v1/privacy-notice | purposeCode obligatorio; privacy_consents.capture | privacyNotice: purposeCode, privacyNoticeVersion, privacyNoticeText, authorizationTextVersion, authorizationText, controller |
| /api/v1/customers/:customerId/privacy-consents | status=granted obligatorio, purposeCode opcional; privacy_consents.read | privacyConsents: arreglo de DTOs vigentes, ordenados por purposeCode/id |
| /api/v1/reception-acceptance-document | Sin query ni body; signatures.capture | acceptanceDocument: documentVersion, text |

controller contiene exactamente legalName, address, phone, email, rightsChannel. Cada consentimiento contiene exactamente privacyConsentId, customerId, purposeCode, privacyNoticeVersion, authorizationTextVersion, channel, status, capturedAt, createdAt. No se exponen hashes, snapshots persistidos, IP, identidad del capturador, bundles ni secretos.

Los GET tienen no-store después de pasar el pipeline de autenticación/tenant/RBAC. Las claves extra y duplicadas se rechazan con 400 REQUEST_VALIDATION_FAILED. El lookup omite revocados, exige el cliente del tenant y devuelve el mismo 404 CUSTOMER_NOT_FOUND para UUID malformado, cliente ausente o ajeno cuando la query es válida. Las pruebas comparan las filas de negocio y auditoría antes/después de lecturas exitosas y rechazadas.

La presentación publica privacy_notice_es-CO_v1 + service_provision_es-CO_v1 mediante PRODUCTION_PRIVACY_DOCUMENT_PRESENTATION. Finalidades sin autorización publicada, punteros ausentes o versiones inexistentes fallan con 409 PRIVACY_DOCUMENT_VERSION_NOT_AVAILABLE. Un controlador incompleto falla con 409 PRIVACY_NOTICE_NOT_CONFIGURED, igual que capture.

## Portado y preservado

Se portaron selectivamente las lecturas, parsers, puntero, proyección compartida de ConsentDto, inventario de rutas y 11 mutaciones históricas. El contrato/test vertical se adaptó al backend actual. Se añadieron 8 mutaciones: body de aceptación, duplicados, tres no-store y tres predicados explícitos de tenant.

No se portó el commit completo ni el backend antiguo. Se corrigieron afirmaciones históricas del documento: omisión de signature/serviceOrder en detalle, recuperación tras firma, retención de 0023, precisión distinta entre POST de firma y su resumen, cache antes del guard y una supuesta cota de cinco finalidades que PostgreSQL no impone. El documento reconciliado reconoce la autoridad de la privacidad de producción y de S3-05/S3-07, en vez de declarar prioridad sobre ellos.

Preservados sin diff: schema.ts, todas las migraciones (incluida 0023 y su preflight), /me/context y framework de autenticación/tenant, controller-notice, canonical-text, notice-bundle, consultas/read-state y scope técnico, signature, close y package-lock. El GET de aceptación resuelve el mismo documento utilizado por signature; el test verifica el hash persistido internamente sin exponerlo en HTTP. Se mantiene media signature/active/authorization_evidence sin deleted_at/purged_at, y active -> quarantined después de firmar.

## Consistencia de privacidad y seguridad

GET y capture usan el mismo PrivacyConsentDependencies.catalog.resolve y el mismo currentControllerNotice/buildControllerNoticeSnapshot. Tests de producción fijan los bytes publicados y sus hashes independientes; el test HTTP compara controller con el snapshot capturado. Se verifica email canónico, rightsChannel y fallback de teléfono de la sede, y fail-closed para configuración ausente/inválida. No se duplicaron textos ni lógica de configuración del controlador.

Los tres permisos ya existen en la matriz canónica; la paridad de sus 103 códigos permanece intacta. El framework autoriza antes de validar recursos/query/body y no cambió X-Tenant-Id. Las pruebas usan logins NOBYPASSRLS NOINHERIT de runtime y FORCE RLS, más asserts/mutaciones de los predicados explícitos de tenant que RLS podría ocultar. PostgreSQL conserva las FK compuestas, unique por consentimiento vigente y CHECK de estado/revocación.

## Archivos de pruebas

- tests/reception-api/contract.test.cjs: 12 tests HTTP/seguridad/consistencia/returning-customer/revocación/tenant/sin escrituras; el runner focalizado incluye además 17 primitives de privacidad: 29/29.
- tests/reception-api/create.test.cjs: inventario y permisos del GET nuevo, conservando scope resource del detalle actual.
- tests/reception-harness/contract-mutations.test.cjs: 76 checks (19 mutaciones x LF/CRLF/anchor ausente/anchor duplicado).
- tests/reception-harness/fixture-cleanup.test.cjs: cuatro combinaciones de tests exitosos/fallidos y cleanup exitoso/fallido.

El harness valida sintaxis antes de aplicar mutaciones. Su control exige cero fail/skipped/todo/cancelled y cleanup verificado. Cada mutante debe aplicarse, provocar fallos de tests y demostrar cleanup. test-crm-api ahora verifica cleanup también al propagar un fallo de tests: ya no puede ocultarlo ese error original.

## Gates aceptados: comandos y conteos finales

Los comandos se ejecutaron desde el worktree bajo Node 22.23.3. Se cargó el .env ya existente del repositorio principal sin copiarlo ni mostrar credenciales. DATABASE_URL apuntaba al runtime sin CREATEDB; el bootstrap eliminó esa variable para que los runners usaran los campos PG* administrativos locales. Cada suite creó sus DB/logins desechables, migró 0000..0023 y limpió sus fixtures. Las suites de migración se ejecutaron en serie.

| Comando realmente ejecutado | PASS | FAIL | SKIP/TODO/CANCELLED |
| --- | ---: | ---: | ---: |
| `npm test` | 126 | 0 | 0 |
| `npm run test:reception:api:ci` | 107 | 0 | 0 |
| `TEST_FILE_FILTER=contract.test.cjs node scripts/test-reception-api.cjs` | 29 | 0 | 0 |
| `npm run test:reception:db:ci` | 23 | 0 | 0 |
| `npm run test:crm:api:ci` | 75 | 0 | 0 |
| `npm run test:crm:db:ci` | 22 | 0 | 0 |
| `npm run test:api:security:ci` | 12 | 0 | 0 |
| `npm run test:api:multitenant:ci` | 4 | 0 | 0 |
| `npm run test:cross-tenant:final:ci` | 25 | 0 | 0 |
| `npm run test:tenant-context:api:ci` | 72 | 0 | 0 |
| `npm run test:db:sprint0:ci` | 62 | 0 | 0 |
| `npm run test:reception:harness` | 272 | 0 | 0 |
| npm run test:reception:upgrade:ci | 19 escenarios | 0 | 0 |
| npm run test:crm:upgrade:ci | 7 escenarios | 0 | 0 |

También ejecutados con exit 0: npm run build, npm run typecheck, npm run lint (243 archivos), npm run test:db:migration-lock:ci, npm run security:secret-scan y npm run rbac:check-doc-parity (103 códigos). npm test desglosa 26 authz + 78 tenant core/context permissions + 20 Wompi + 2 presign. Los 29 tests focalizados se solapan con la suite completa; no representan tests adicionales únicos.

| Mutaciones: comando / componente | KILLED | SURVIVED / invalid apply |
| --- | ---: | ---: |
| npm run test:reception:mutations:ci — PostgreSQL | 22 | 0 |
| mismo comando — signature | 7 | 0 |
| mismo comando — close | 11 | 0 |
| mismo comando — queries | 24 | 0 |
| npm run test:reception:contract:mutations:ci (incluido en el agregado) | 19 | 0 |
| NODE_OPTIONS=--test-reporter=spec npm run test:crm:api:mutations:ci | 18 | 0 |
| npm run test:crm:mutations:ci | 12 | 0 |
| NODE_OPTIONS=--test-reporter=spec npm run test:cross-tenant:mutations:ci | 9 | 0 |
| Total aceptado | 122 | 0 |

Los controles normales son verdes; los fail=N de mutantes representan los fallos intencionales que los eliminan. No hubo skips ni fallos normales en las corridas finales.

Drizzle: node node_modules/drizzle-kit/bin.cjs check --config=<temporal> y generate --config=<temporal>, con la definición actual y una copia de drizzle en OS temp. Ambos pasaron. generate informó No schema changes, nothing to migrate; comparación byte a byte confirmó cero migraciones generadas y cero cambios canónicos. No se ejecutó push ni migración sobre la DB de la aplicación.

DB gates solicitados no ejecutados por falta de credenciales: ninguno. No se ejecutaron staging, despliegue ni el gate R2 externo: esta tarea reconcilia el contrato local y conserva las dependencias externas documentadas.

## Corridas diagnósticas fallidas (no contadas como PASS)

- Con la conexión runtime inicial, el setup falló con PostgreSQL 42501 antes de tests; se usó el perfil PG* administrativo local existente.
- Un assert nuevo de contrato dio 27 PASS / 1 FAIL al comparar el signedAt de POST (ms) con detalle (us). Se cambió el assert para comparar el detalle con el valor exacto persistido; no se cambió el producto.
- La primera suite completa dio 105 PASS / 1 FAIL: el inventario anterior aún desconocía el GET de aceptación. Se portó la actualización de inventario compatible; suite final 107/107.
- Drizzle check con out absoluto falló por su resolución de rutas en Windows. Se corrigió únicamente la configuración temporal a rutas relativas; ambos gates finales pasaron.
- Primera mutación CRM API: exit 1, 18 INVALID por reporter TAP; no se contó ningún kill. La CI ya exige spec. Se repitió con NODE_OPTIONS=--test-reporter=spec y pasó 18/18, sin modificar ni saltar los tests.

## Inspección Git y cierre

Ejecutados: git worktree list; git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git status --short; git show --stat daff672ea22ab07c2e8e3e7656088268a304e321; git diff main...task/s3-reception-contract; git diff task/s3-reception-contract..main; git diff --stat; git diff; git diff --check. Los diffs históricos completos se conservaron en OS temp durante la revisión. El port aplicó sólo los paths explícitos compatibles; no hubo merge/cherry-pick.

Previo al commit se revisan git diff --cached --check y --stat, y se repite secret-scan después de incluir los archivos nuevos. El handoff entrega el SHA y el git status final. Ningún push está autorizado ni se ejecuta. El worktree conserva la rama para revisión; todavía no se integra en main.

Comprobación independiente del cluster: PostgreSQL 18.4. Los checks amplios encontraron una DB CRM con datos del 2026-09-28 (America/Bogota) y cuatro logins de pruebas existentes; dos corresponden a esa DB antigua y dos a member-lifecycle, cuyo runner no se ejecutó en esta tarea. Se conservaron esos recursos ajenos. Los checks de teardown de cada fixture propio verificaron DB/logins=0; los 19 mutantes nuevos exigen esa evidencia en cada corrida.