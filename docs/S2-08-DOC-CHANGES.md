# S2-08 — cierre documental de lint y logging

- Base: `integration/sprint-2`.
- Alcance del cierre documental original: documentación únicamente. Sin código de producción, dependencias, configuración Biome, CI, tests, staging, migraciones ni cambios de `schema.ts` en ese cierre.
- Precedencia: `/docs` canónico. Las decisiones humanas siguientes están aprobadas; la implementación y evidencia del gate quedan pendientes.
- S2-04 permanece histórico: su «sin logger nuevo; sin lint nuevo» describía el alcance de ese ticket. El mínimo aprobado se introduce ahora en S2-08.

## DOC_GAP-01 — Lint

**Estado del contrato: CLOSED / aprobado. Estado de ejecución: pendiente.** Biome será dependencia solo de desarrollo; `npm run lint` será el script canónico y fallará en CI ante infracciones. Typecheck sigue separado; no ESLint/`typescript-eslint` ni `tsc` como sustituto de lint. Configuración/alcance razonable para `src/`, `tests/` y `scripts/`, sin reformateo masivo no solicitado. Fuente canónica: Arquitectura §18 y Quality Gate Sprint 2/S2-08.

## DOC_GAP-02 — Logging mínimo de requests Sprint 2

**Estado del contrato: CLOSED / aprobado. Estado de ejecución: pendiente.** Fastify/Pino integrado, `disableRequestLogging: true`, sin serialización automática del request crudo y exactamente un log estructurado de finalización por request manejado. Allowlist cerrada: `request_id`, `method`, `route` como plantilla (nunca URL cruda), `status_code`, `error_code` donde aplique, `duration_ms`; `tenant_id`, `user_id`, `membership_id` solo si provienen de contexto verificado por el servidor. Para rutas sin match se usa un identificador fijo sin datos de URL. Redacción central adicional.

**Aclaración humana posterior del contrato de campos:** `level` es metadato de severidad de la envoltura Pino, permitido además de la allowlist funcional anterior; no es un campo del payload de finalización. No se permite ningún otro metadato automático. `time` permanece deshabilitado, al igual que `pid`, `hostname`, `req`, `res`, URL cruda, query, headers y body. La privacidad y la unicidad del evento siguen vigentes.

No body, query string ni valores, URL cruda, Authorization/Cookie, JWT/tokens/secretos ni PII CRM (nombre, teléfono, email, valores de documento, placa, VIN, número de motor). El 500 `INTERNAL_ERROR` sigue genérico; un diagnóstico técnico seguro puede conservarse en log servidor tras minimizar/redactar, sin serializar request/error completos y sin duplicar el evento de finalización.

Pruebas exigidas: `request_id` y plantilla `route`; búsqueda/creación/error CRM sin query, PII, token o cookie; `error_code` cuando aplique; 500 sin detalle interno en respuesta y con diagnóstico seguro en log. Metrics, traces, dashboards SLO, alertas y `trace_id` se difieren después de Sprint 2. Fuentes canónicas: Arquitectura §16, Operación §6 y Quality Gate Sprint 2/S2-08.

**Cierre T7 posterior:** `request_id` es generado por el servidor y no lo sustituye un header del cliente. Las pruebas rechazan cookies crudas o codificadas, IDs de tenant enviados sin TenantContext verificado, request IDs aportados por el cliente y cualquier campo automático distinto de `level`. La sonda que sustituye la plantilla por `request.url` falla específicamente por fuga de URL/query privada. La implementación y las pruebas de T5–T7 se registran en la rama S2-08; T8–T9 y su evidencia de staging/gate final siguen pendientes.

## DOC_CONFLICT y efecto de base de datos

- **DOC_CONFLICT: NONE; conflicto sobre `level`: CLOSED.** `level` es solo envoltura Pino y la allowlist funcional permanece cerrada. No se cambia el texto histórico de S2-04.
- **Migración/schema: NONE.** No se modifica el modelo, `schema.ts` ni una migración.
- **Notion:** back-sync aplicado a Arquitectura Técnica §16/§18 (`3de6ab0a330d817ab78bcbd88c100e5a`), Operación §6/§6.7 (`3e06ab0a330d819ea376f6f7628679f6`) y Quality Gates Sprint 2 (`3df6ab0a330d818486e9dd6f06b5f573`). Las tres páginas se releyeron tras editar: los bloques S2-08 están presentes en las secciones correctas y la redacción de §6.7 prohíbe secretos en diagnósticos. Texto sincronizado con `/docs`; el resto de cada página se preservó mediante reemplazos anclados, sin re-export.
