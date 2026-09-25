# Quality Gates — Reglas y Pruebas por Sprint

<aside>
🚦

**Regla principal:** un sprint NO termina porque se cumplan dos semanas. Termina únicamente cuando su Quality Gate pasa con evidencia verificable. Si falla cualquier criterio crítico, el sprint vuelve a corrección y no habilita el siguiente.

</aside>

**Ámbito:** Sprint 0 → Sprint 16  

**Metodología:** Scrum 2 semanas + Quality Gates  

**Roadmap:** [Metodologia Scrum 2 week  + Gates (RoadMap)](../Metodologia%20Scrum%202%20week%20+%20Gates%20(RoadMap)%203de6ab0a330d80cc94e0dc6f270efdf0.md)  

**Sprint 0:** [Sprint 0 Backlog](Sprint%200%20Backlog%203de6ab0a330d807faf46ce81d957ecba.md)  

**ERD:** [Modelo de Datos / ERD v1 — PostgreSQL](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Modelo%20de%20Datos%20ERD%20v1%20%E2%80%94%20PostgreSQL%203df6ab0a330d81fda465f8944c3291e6.md)

# 1. Gate transversal obligatorio

Todo sprint debe pasar dos capas: **Gate transversal** + **Gate específico del sprint**.

- [ ]  Criterios de aceptación completos.
- [ ]  TypeScript sin errores.
- [ ]  Lint sin errores bloqueantes.
- [ ]  Unit tests del dominio afectado.
- [ ]  Integration tests de persistencia/integraciones afectadas.
- [ ]  E2E del flujo crítico cuando corresponda.
- [ ]  Autorización/RBAC probada.
- [ ]  Aislamiento multitenant probado cuando existan recursos tenant-owned.
- [ ]  Casos negativos probados, no solo happy path.
- [ ]  Idempotencia probada donde existan reintentos/webhooks/pagos/sync.
- [ ]  Manejo de errores probado.
- [ ]  Logs/observabilidad suficientes.
- [ ]  Migración aplicada en staging cuando cambie DB.
- [ ]  Estrategia de rollback/recuperación definida para cambios riesgosos.
- [ ]  Smoke tests después del deploy.
- [ ]  Regresión de flujos previos críticos.
- [ ]  Documentación técnica actualizada.
- [ ]  Evidencia del Gate adjunta/enlazada.
- [ ]  Riesgos críticos abiertos = 0.

<aside>
🛑

**Fase actual:** el ERD baseline definitivo y el Diccionario de Datos v1 ya están cerrados documentalmente y habilitan la creación y rectificación de `schema.ts`. La implementación del esquema puede avanzar en paralelo al cierre de la documentación restante de Sprint 0; esa documentación pendiente no bloquea `schema.ts` salvo que introduzca un conflicto explícito con su contrato canónico. Esto no crea un Gate nuevo ni sustituye las pruebas originales. El Quality Gate de Sprint 0 sigue siendo uno solo y solo podrá considerarse PASSED cuando se complete la documentación requerida y se ejecuten con evidencia las pruebas técnicas definidas para la base del proyecto.

</aside>

# 2. Evidencia mínima para aprobar

Cada Gate debe registrar: fecha, versión/commit, ambiente, responsable, casos ejecutados, PASS/FAIL, evidencia, defectos y decisión final.

Estados: **NOT_READY → READY_FOR_GATE → TESTING → PASSED / FAILED**.

Un FAILED se corrige y se vuelve a ejecutar; no se cambia manualmente a PASSED.

# 3. Sprint 0 — Arquitectura y proyecto

**Quality Gate único de Sprint 0.** La documentación se cierra primero porque define qué vamos a construir; después se implementa la base técnica necesaria y se ejecutan todas las pruebas del mismo Gate. El Sprint 0 no pasa hasta completar ambos tipos de criterio.

## Documentación requerida dentro del Gate

- [ ]  Arquitectura baseline revisada.
- [x]  ERD definitivo + Diccionario de Datos v1 cerrado y enlazado: [Diccionario de Datos v1 — PostgreSQL](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Diccionario%20de%20Datos%20v1%20%E2%80%94%20PostgreSQL%203e06ab0a330d815fbb32e6200f8d5417.md).
- [ ]  Multitenancy documentado.
- [ ]  Matriz RBAC/permisos aprobada y enlazada: [RBAC — Matriz completa de roles y permisos v1](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/RBAC%20%E2%80%94%20Matriz%20completa%20de%20roles%20y%20permisos%20v1%203e06ab0a330d81d398ffe925a65506c8.md).
- [ ]  Estados/transiciones por dominio aprobados y enlazados: [Estados y Transiciones por Dominio v1](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Estados%20y%20Transiciones%20por%20Dominio%20v1%203e06ab0a330d819080edfe450a75a7f5.md).
- [ ]  Estrategia PostgreSQL: FKs compuestas, RLS/permisos y tenant isolation aprobada y enlazada: [ADR-009 — RLS y privilegios PostgreSQL por TenantContext](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/ADR-009%20%E2%80%94%20RLS%20y%20privilegios%20PostgreSQL%20por%20TenantC%203e06ab0a330d8162b0cfff78ad1cb9b1.md).
- [ ]  Append-only e historial.
- [ ]  Archivos/R2 y retención aprobados y enlazados: [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).
- [ ]  Offline/sync/conflictos aprobados y enlazados: [ADR-005 — PWA + IndexedDB para operación offline](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/ADR-005%20%E2%80%94%20PWA%20+%20IndexedDB%20para%20operaci%C3%B3n%20offline%203e06ab0a330d81a58a05dabdf042f145.md).
- [ ]  Contratos Wompi + WhatsApp aprobados y enlazados: [Contratos Externos — Wompi + WhatsApp v1](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Contratos%20Externos%20%E2%80%94%20Wompi%20+%20WhatsApp%20v1%203e06ab0a330d814aaa72e80f2a7c7f10.md).
- [ ]  Wompi y billing SaaS.
- [ ]  Customer payments + conciliación operativa aprobados y enlazados: [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).
- [ ]  Catálogo maestro, inventario por ubicación y dashboard comercial aprobados y enlazados: [Inventario y Dashboard Comercial v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Inventario%20y%20Dashboard%20Comercial%20v1%20%E2%80%94%20TallerMecari%203e06ab0a330d813baa30dbcff20a874b.md).
- [ ]  ADR-010 aceptado y enlazado para la enmienda estructural de inventario, cotización suplementaria y atribución comercial: [ADR-010 — Inventario transaccional, cotización suplementaria y atribución comercial](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/ADR-010%20%E2%80%94%20Inventario%20transaccional,%20cotizaci%C3%B3n%20sup%203e06ab0a330d8192ae92d938f0d3ab3c.md).
- [ ]  WhatsApp.
- [ ]  Auditoría/cumplimiento aprobados y enlazados: [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).
- [ ]  Backups/restore/RPO/RTO aprobados y enlazados: RPO ≤15 min, RTO ≤4 h, PITR 14 días baseline.
- [ ]  Observabilidad/errores/SLO aprobados y enlazados: [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).
- [ ]  CI/CD, ambientes y estrategia de migraciones/rollback aprobados; expand/migrate/contract y recovery documentados en [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](../Arquitectura%20T%C3%A9cnica%20v1%20%E2%80%94%20TallerMecario/Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).
- [ ]  Testing strategy.
- [ ]  ADRs críticos cerrados.
- [ ]  Risk Register actualizado.
- [ ]  Security Baseline — Aplicación y Plataforma documentado y enlazado.
- [ ]  Protección de Datos Personales Colombia documentada y enlazada.
- [ ]  Matriz Responsable/Encargado definida para taller, ILVOX y subencargados.
- [ ]  Matriz dato × finalidad × autorización × retención definida.
- [ ]  Política de fotos/video/firma y datos sensibles definida.
- [ ]  Flujo de derechos del titular y plazos legales definido.
- [ ]  Estrategia RNBD evaluada.
- [ ]  Transferencias/transmisiones internacionales inventariadas.
- [ ]  Runbook de incidentes de datos personales definido.

**Regla de trabajo actual:** completar primero esta documentación antes de crear scripts SQL, `schema.ts`, migraciones, seeds o triggers ejecutables.

## Pruebas técnicas obligatorias del mismo Gate

- [ ]  Proyecto/base reproducible.
- [ ]  PostgreSQL levanta desde cero.
- [ ]  Migraciones reproducibles desde DB vacía y como upgrade desde la versión anterior/clone de staging.
- [ ]  Solo un runner puede migrar por ambiente; concurrencia de runners es rechazada/bloqueada.
- [ ]  Runtime API/worker no tiene DDL ni ejecuta migraciones.
- [ ]  Cambio incompatible demuestra expand → deploy compatible → backfill/verify → contract en release posterior.
- [ ]  Backfill interrumpido puede reanudarse sin duplicar/corromper datos.
- [ ]  Rollback de app funciona mientras schema expandido conserva compatibilidad; contract destructivo exige backup/checkpoint + plan forward-fix/restore.
- [ ]  Staging desplegado.
- [ ]  CI ejecuta typecheck/lint/tests/build.
- [ ]  Un INSERT/UPDATE directo que intente relacionar Tenant A con Tenant B es rechazado por PostgreSQL.
- [ ]  El aislamiento multitenant también es rechazado correctamente por la API.
- [ ]  Runtime no puede UPDATE/DELETE/TRUNCATE históricos append-only.
- [ ]  FKs de históricos críticos no provocan borrado en cascada indebido.
- [ ]  Upload firmado a R2 probado.
- [ ]  Outbox/worker PoC probado.
- [ ]  Backup + restore básico probado.
- [ ]  Health/readiness funcionando.
- [ ]  Smoke test post-deploy pasa.
- [ ]  No existen secretos en bundle frontend, Git o logs.
- [ ]  Credenciales PostgreSQL no están expuestas públicamente.
- [ ]  Toda tabla tenant-owned existente en el schema en ese sprint tiene `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; CI/Gate detecta automáticamente una tabla nueva con `tenant_id` sin cobertura.
- [ ]  `tallermecario_api` y `tallermecario_worker` son `NOBYPASSRLS`, no propietarios y no pueden `SET ROLE` a owner/migrator/bootstrap.
- [ ]  Sin `app.tenant_id`, SELECT tenant-owned devuelve 0 filas y INSERT/UPDATE son rechazados.
- [ ]  Tenant A no puede SELECT/UPDATE/DELETE filas de Tenant B mediante SQL directo con rol runtime.
- [ ]  Tenant A no puede INSERT con `tenant_id=B` ni UPDATE `tenant_id A→B`; `WITH CHECK` lo rechaza.
- [ ]  Contexto RLS es transaction-local y desaparece al COMMIT/ROLLBACK; una conexión pooled reutilizada no hereda el tenant anterior.
- [ ]  `workshops` aplica policy especial por `id = current_tenant_id()`.
- [ ]  `pg_policies`, `relrowsecurity`, `relforcerowsecurity`, ownership y atributos de roles coinciden con ADR-009.
- [ ]  Flujos bootstrap (memberships, tokens públicos, webhooks, outbox claim) usan resolvers allowlisted; runtime no recibe SELECT cross-tenant general.
- [ ]  Funciones `SECURITY DEFINER` bootstrap tienen `EXECUTE` revocado de `PUBLIC`, owner NOLOGIN/privilegio mínimo y `search_path` seguro.
- [ ]  Worker reclama job global de forma controlada y procesa cada job en transacción tenant-scoped bajo RLS.
- [ ]  Manipulación de `tenant_id`, roles, permisos, status y campos server-owned desde payload es rechazada.
- [ ]  Consultas usan parámetros/bindings; no concatenación de input.
- [ ]  Validación de entrada rechaza payloads inválidos/inesperados.
- [ ]  Uploads fuera de allowlist o límites son rechazados.
- [ ]  API no filtra campos internos/sensibles innecesarios.
- [ ]  Security headers y HTTPS están presentes según ambiente.
- [ ]  Dependency/secret scanning sin hallazgos críticos abiertos.
- [ ]  Consentimiento/autorización queda versionado y auditable cuando aplica.
- [ ]  Un usuario sin permiso no puede consultar PII/media de otro tenant.
- [ ]  Solicitud de consulta/rectificación/supresión puede trazarse de extremo a extremo.
- [ ]  Retención/supresión no rompe históricos que deban conservarse.
- [ ]  Flujo de incidente de datos personales puede ejecutarse y dejar evidencia.

**Salida obligatoria:** documentación aprobada + base técnica demostrablemente segura, reproducible y compatible con los requisitos de protección de datos definidos. Solo entonces Sprint 0 = PASSED y puede habilitar Sprint 1.

# 4. Sprint 1 — Multiempresa + autenticación

- [ ]  Crear/activar taller.
- [ ]  Onboarding crea `workshop` + exactamente una `workshop_location.is_primary=true` en la misma transacción.
- [ ]  Partial unique impide dos ubicaciones principales del mismo tenant.
- [ ]  Constraint trigger diferido impide COMMIT de un workshop sin ubicación principal.
- [ ]  Cambiar ubicación principal exige demover/promover atómicamente; eliminar la principal sin reemplazo falla.
- [ ]  Crear usuario y membership.
- [ ]  Owner/admin puede crear `membership_invitations` solo para roles permitidos por RBAC.
- [ ]  Invitación usa token aleatorio almacenado únicamente como hash y tiene expiración.
- [ ]  Aceptación exige token vigente + email Clerk verificado coincidente.
- [ ]  `invited_by_membership_id`, `accepted_membership_id` y `revoked_by_membership_id` no pueden cruzar tenants.
- [ ]  Tenant y rol de la membership aceptada provienen de la invitación, no del payload.
- [ ]  Una invitación solo se acepta una vez; dos aceptaciones concurrentes no duplican membership/rol.
- [ ]  Invitación expirada/revocada/usada es rechazada.
- [ ]  Admin no puede invitar owner/admin.
- [ ]  Crear/revocar/aceptar invitación genera auditoría.
- [ ]  Primer login antes de `user.created` provisiona `users` local mediante JIT seguro.
- [ ]  Carrera JIT/webhook no duplica usuarios.
- [ ]  JIT nunca crea workshop, membership, rol ni permiso implícito.
- [ ]  JIT registra `identity.user_provisioned_jit` en audit_logs sin JWT ni payload sensible.
- [ ]  Usuario autenticado sin membership queda en 403/onboarding.
- [ ]  Login válido.
- [ ]  Login inválido rechazado.
- [ ]  Usuario sin membership no accede.
- [ ]  Usuario con varios talleres selecciona tenant válido.
- [ ]  TenantContext no proviene de body arbitrario.
- [ ]  `role_permissions` coincide con la matriz RBAC aprobada.
- [ ]  Owner cumple permisos owner-only y no puede eliminar/degradar al último owner.
- [ ]  Admin no puede asignar/revocar owner/admin ni transferir propiedad.
- [ ]  Advisor no puede gestionar memberships/roles/billing SaaS.
- [ ]  Technician solo accede recursos asignados y recibe PII mínima necesaria.
- [ ]  Cambios de roles/membership generan audit log y toman efecto sin depender de claims de Clerk.
- [ ]  Acceso Taller A → Taller B rechazado por API.
- [ ]  Relación cruzada rechazada por DB donde aplique.
- [ ]  Sesión expirada/revocada manejada.
- [ ]  Audit log de cambios sensibles.
- [ ]  E2E login → tenant → dashboard.

**FAIL crítico:** fuga entre tenants o bypass de permisos.

# 5. Sprint 2 — Clientes + vehículos

- [ ]  CRUD cliente.
- [ ]  CRUD vehículo.
- [ ]  Buscar por placa.
- [ ]  Misma placa permitida en dos talleres distintos.
- [ ]  Duplicado de placa en mismo tenant rechazado.
- [ ]  customer ↔ vehicle mismo tenant.
- [ ]  Relación cruzada rechazada por PostgreSQL.
- [ ]  Cambio de propietario conserva historia.
- [ ]  Validaciones negativas.
- [ ]  Paginación/búsqueda.
- [ ]  E2E cliente → vehículo.

# 6. Sprint 3 — Recepción

- [ ]  Buscar placa.
- [ ]  Crear cliente/vehículo si no existe.
- [ ]  Kilometraje.
- [ ]  Combustible 0–100.
- [ ]  Checklist.
- [ ]  Daños existentes.
- [ ]  Observaciones.
- [ ]  Firma.
- [ ]  CHECK XOR de firma.
- [ ]  Cerrar recepción.
- [ ]  Crear orden una sola vez.
- [ ]  Historial.
- [ ]  Tenant isolation.
- [ ]  Idempotencia de cierre.
- [ ]  E2E desde móvil.

# 7. Sprint 4 — Video 360° + evidencias

- [ ]  `media_assets` conserva retention_class/retention_until/policy_version y estado de deletion/purge.
- [ ]  Upload incompleto expira/purga según baseline 24 h.
- [ ]  Media operacional calcula 12 meses desde orden terminal; warranty extiende hasta `warranty_expires_at + 90 días` cuando sea mayor.
- [ ]  Firma/PDF/evidencia usa default de producto 36 meses salvo policy/hold superior.
- [ ]  Legal hold evita purge automático.
- [ ]  `deleted_at` bloquea nuevas signed URLs antes de `purged_at`.
- [ ]  Worker de retención no borra media con vínculo/hold vigente y deja audit event.
- [ ]  Scan detecta objeto R2 faltante y objeto huérfano sin metadata.
- [ ]  Upload session.
- [ ]  URL firmada temporal.
- [ ]  Video cliente → R2 directo.
- [ ]  Fotos.
- [ ]  Reintento.
- [ ]  Upload interrumpido.
- [ ]  Archivo inválido rechazado.
- [ ]  Metadata persistida.
- [ ]  Checksum/tamaño cuando aplique.
- [ ]  Enlaces media específicos por dominio.
- [ ]  No media_links polimórfico en escritura.
- [ ]  Media A no puede enlazar entidad B.
- [ ]  URL de descarga expira.
- [ ]  R2 caído no destruye recepción.
- [ ]  Consulta/vista media por orden.
- [ ]  E2E recepción + video + fotos.

# 8. Sprint 5 — Órdenes

- [ ]  Orden desde recepción.
- [ ]  order_number único por tenant.
- [ ]  Transiciones válidas aceptadas.
- [ ]  Transiciones inválidas rechazadas.
- [ ]  Sin endpoint de estado arbitrario.
- [ ]  order_status_history append-only.
- [ ]  UPDATE/DELETE/TRUNCATE rechazado.
- [ ]  Asignación de personal.
- [ ]  `assignment_type` solo acepta `lead_technician | support_technician | quality_control`.
- [ ]  Assignment de orden y membership cruzando tenants es rechazado por PostgreSQL mediante FKs compuestas.
- [ ]  Asignación activa duplicada del mismo tipo/orden/miembro es rechazada.
- [ ]  RBAC.
- [ ]  Concurrencia/versionado.
- [ ]  E2E recepción → orden → transición.

# 9. Sprint 6 — Diagnóstico

- [ ]  `diagnostics.status` solo acepta `draft | in_progress | completed | cancelled`.
- [ ]  `draft → in_progress → completed` funciona únicamente mediante comandos válidos.
- [ ]  `draft/in_progress → cancelled` exige motivo.
- [ ]  `completed` y `cancelled` son terminales; no existe reapertura directa.
- [ ]  `completed` exige `completed_at`; `cancelled` exige `cancelled_at + cancel_reason`; estados no terminales no cargan timestamps terminales.
- [ ]  Re-diagnóstico posterior crea un nuevo `diagnostics` sin alterar el anterior.
- [ ]  Máximo un diagnóstico activo (`draft/in_progress`) por orden.
- [ ]  Crear diagnóstico.
- [ ]  Crear hallazgo.
- [ ]  Severidad/recomendación.
- [ ]  Evidencia del hallazgo.
- [ ]  Media FK multitenant.
- [ ]  Técnico autorizado.
- [ ]  Usuario no autorizado rechazado.
- [ ]  Cierre de diagnóstico protegido.
- [ ]  Hallazgo convertible a cotización.
- [ ]  Auditoría.
- [ ]  E2E orden → diagnóstico → hallazgo.

# 10. Sprint 7 — Cotizaciones + catálogo

- [ ]  `quotes.status` solo acepta `draft | awaiting_authorization | approved | partially_approved | rejected | cancelled`.
- [ ]  `sendQuote` solo permite `draft → awaiting_authorization` con versión actual válida.
- [ ]  Crear revisión desde `awaiting_authorization/rejected` vuelve a `draft` creando nueva versión; nunca modifica la versión enviada.
- [ ]  Si se revisa una cotización rechazada, la orden coordina `rejected → quote_pending` sin borrar la autorización/rechazo histórico.
- [ ]  Versión anterior deja de ser autorizable al dejar de ser `current_version_id` y conserva historia.
- [ ]  `approved`, `partially_approved` y `cancelled` son terminales para ese quote.
- [ ]  Quote `cancelled` conserva `cancelled_at`, actor y motivo.
- [ ]  Catálogo por taller permite servicios, mano de obra, repuestos y otros; owner/admin pueden administrar el maestro.
- [ ]  `catalog_items.track_inventory=true` solo se permite para `item_type=part`; service/labor/other son rechazados.
- [ ]  Barcode/código no se duplican dentro del mismo tenant cuando están informados.
- [ ]  Ítem de catálogo de Tenant A no puede usarse en cotización de Tenant B.
- [ ]  Crear cotización.
- [ ]  Servicios/mano de obra/repuestos.
- [ ]  Subtotal/impuestos/descuentos/total.
- [ ]  Dinero sin float.
- [ ]  Versionamiento.
- [ ]  Líneas copian snapshot de nombre/descripción/precio/impuesto/garantía; cambios posteriores del catálogo no alteran versiones históricas.
- [ ]  La garantía ofrecida en cotización queda visible y congelada por línea.
- [ ]  Versión enviada inmutable.
- [ ]  PDF.
- [ ]  PDF coincide con versión exacta.
- [ ]  Tenant isolation.
- [ ]  Generación idempotente.
- [ ]  Auditoría de precio.
- [ ]  E2E diagnóstico → v1 → v2 → PDF.

# 11. Sprint 8 — Autorización cliente

- [ ]  `quote_authorization_tokens` existe antes de la decisión y guarda solo `token_hash`.
- [ ]  Estados del token limitados a `active | consumed | expired | revoked | superseded`.
- [ ]  Token público de autorización de cotización aleatorio, temporal y de propósito específico.
- [ ]  Token de autorización no es intercambiable con `customer_order_access_tokens` de seguimiento.
- [ ]  Token autorizable exige `active`, `expires_at > now()`, quote `awaiting_authorization` y `quote_version_id = current_version_id`.
- [ ]  `quote_authorization_challenges` modela OTP on-demand separado del token principal.
- [ ]  Link puede consultar la cotización sin OTP; cualquier decisión pública exige challenge `verified` vigente del mismo token.
- [ ]  OTP baseline: 6 dígitos CSPRNG, TTL 5 min, máximo 5 intentos, cooldown 60 s.
- [ ]  Código OTP crudo nunca persiste en DB/outbox/logs; solo `code_hash` HMAC-SHA256 con pepper secreto/versionado; una fuga solo de DB no permite comparar hashes simples del espacio de 1.000.000 códigos.
- [ ]  Nuevo challenge supersede el anterior utilizable y challenge expirado/locked/superseded no autoriza.
- [ ]  En Sprint 8 el lifecycle OTP se prueba con adapter/fake provider; la entrega real por Meta se valida en Sprint 9.
- [ ]  Token expirado/revocado/superseded/consumed rechazado.
- [ ]  El token no se consume al abrir el enlace; solo al registrar una decisión final válida.
- [ ]  Pueden coexistir varios tokens activos de una misma versión para reenvíos/retries.
- [ ]  Aprobar versión exacta transiciona `awaiting_authorization → approved`.
- [ ]  Rechazar versión exacta transiciona `awaiting_authorization → rejected`.
- [ ]  Aprobación parcial transiciona `awaiting_authorization → partially_approved`.
- [ ]  Token/version anterior supersedida no puede autorizarse.
- [ ]  Crear revisión supersede todos los tokens activos de la versión anterior.
- [ ]  FK compuesta impide que `quote_authorizations.authorization_token_id` apunte a un token de otra `quote_version` o tenant.
- [ ]  FK compuesta impide que `authorization_challenge_id` pertenezca a otro token/tenant; la autorización pública conserva evidencia exacta de token + challenge consumidos.
- [ ]  Consumir challenge OTP verificado + token + crear `quote_authorizations`/items + transicionar quote/order + superseder tokens hermanos ocurre atómicamente.
- [ ]  Dos tokens activos concurrentes no pueden producir dos autorizaciones finales; solo una transacción gana.
- [ ]  `authorization_token_id` no nulo solo puede aparecer en una autorización.
- [ ]  Flujo manual no inventa token/challenge: `authorization_token_id IS NULL` y `authorization_challenge_id IS NULL`, actor interno autorizado y evidencia/canal obligatorios.
- [ ]  Flujo público exige ambos IDs no nulos; CHECK impide token sin challenge o challenge sin token.
- [ ]  Aprobación parcial.
- [ ]  Aprobación parcial identifica exactamente qué `quote_items` y cantidades fueron aprobados/rechazados.
- [ ]  Solo líneas autorizadas pueden materializarse para ejecución.
- [ ]  FK DB rechaza `service_order_items.quote_item_id` si el `quote_item` pertenece a otra orden, incluso dentro del mismo tenant.
- [ ]  Para `source='quote'`, `service_order_items.catalog_item_id` copia `quote_items.catalog_item_id` cuando exista; snapshots siguen preservando precio/nombre/garantía históricos y el FK permite inventario estable.
- [ ]  `quote_authorization_items` de otra `quote_version` es rechazado por FK aunque tenant/autorización sean válidos.
- [ ]  `UNIQUE(tenant_id, quote_version_id)` impide dos decisiones finales concurrentes para la misma versión.
- [ ]  `quantity_actual` no incrementa automáticamente `quantity_billed`; cualquier exceso sobre lo autorizado exige ajuste/autorización antes de facturarse.
- [ ]  Cantidades `<=0` y tasas fuera de `0..100` son rechazadas donde corresponda.
- [ ]  `quote_authorizations` append-only y ya no almacena `token_hash`; enlaza opcionalmente `authorization_token_id`.
- [ ]  UPDATE/DELETE/TRUNCATE rechazado.
- [ ]  Evidencia fecha/canal/contexto.
- [ ]  Tenant isolation.
- [ ]  Estado cambia solo por comando válido.
- [ ]  E2E cotización → autorización → orden.

# 12. Sprint 9 — WhatsApp

- [ ]  `tenant_whatsapp_accounts` permite que cada taller conecte su propia WABA/número.
- [ ]  Baseline `billing_mode='tenant_direct'`: Meta factura al taller; ILVOX/Wompi no registra ese consumo como billing SaaS.
- [ ]  Dos tenants no pueden compartir `phone_number_id` y cada outbound resuelve la cuenta desde TenantContext.
- [ ]  Credencial/material de acceso real vive en secret store; PostgreSQL conserva solo `credential_secret_ref`/metadata permitida.
- [ ]  Webhook de `phone_number_id` A resuelve únicamente Tenant A; manipulación/cross-tenant es rechazada.
- [ ]  Desconectar la integración de Tenant A no altera la de Tenant B ni implica propiedad de ILVOX sobre su número/WABA.
- [ ]  Payload outbound interno cumple contrato versionado y no contiene token público crudo en outbox.
- [ ]  Worker materializa `quote_authorization_tokens` solo desde solicitud previamente autorizada y guarda únicamente hash persistente.
- [ ]  Worker materializa OTP en memoria para `quote_authorization_challenges`, persiste solo `code_hash` y envía plantilla Authentication mediante la WABA del tenant.
- [ ]  OTP real por Meta respeta TTL/intentos/cooldown y el costo pertenece a la cuenta Meta del taller.
- [ ]  Timeout/fallo ambiguo de Meta no revoca a ciegas el token recién creado; un retry puede emitir otro token activo para la misma versión.
- [ ]  Cuando un token es consumido, cualquier token hermano activo queda superseded.
- [ ]  Payload template hacia Meta cumple contrato del adapter y Graph API version queda fijada por configuración.
- [ ]  Respuesta `200` de envío persiste `wamid` pero no se interpreta como delivery.
- [ ]  Envío por worker/outbox.
- [ ]  Falla externa no revierte transacción interna.
- [ ]  Reintentos/backoff; 429/5xx/timeout clasificados.
- [ ]  Idempotencia.
- [ ]  GET de verificación responde `hub.challenge` solo con verify token válido.
- [ ]  POST webhook valida `X-Hub-Signature-256` sobre raw body.
- [ ]  Firma inválida rechazada.
- [ ]  webhook_events inmutable.
- [ ]  webhook_processing_attempts por intento.
- [ ]  Duplicado de `wamid` no duplica mensaje/efecto.
- [ ]  Mensajes en tenant correcto resuelto por configuración server-side (`phone_number_id`).
- [ ]  Estados `sent/delivered/read/failed` procesados sin regresiones aunque lleguen fuera de orden.
- [ ]  Plantillas sandbox/real controlado.
- [ ]  Mensaje entrante de texto libre no autoriza cotización ni otra acción sensible.
- [ ]  E2E cotización → WhatsApp → evento.

# 13. Sprint 10 — Reparación + estados + inventario

- [ ]  Líneas autorizadas se materializan en `service_order_items` del mismo tenant/orden.
- [ ]  `service_order_items` conserva snapshot histórico aunque cambie `catalog_items`.
- [ ]  Garantía por línea puede heredar el default del catálogo o ajustarse antes de completar el trabajo.
- [ ]  Al completar el trabajo se fijan `warranty_start_at` y `warranty_expires_at`.
- [ ]  Garantía completada no cambia retroactivamente si cambia el catálogo.
- [ ]  Inicio solo desde estado permitido.
- [ ]  Asignar técnico.
- [ ]  Actividades.
- [ ]  Evidencias.
- [ ]  Logs técnicos.
- [ ]  Cerrar actividad.
- [ ]  Actividades requeridas completas antes de QC.
- [ ]  QC PASS/FAIL.
- [ ]  FAIL de QC vuelve a reparación.
- [ ]  Evidencia QC.
- [ ]  Tenant isolation.
- [ ]  Auditoría.
- [ ]  `inventory_balances` mantiene stock independiente por producto + ubicación.
- [ ]  `inventory_movements` es append-only y cada receipt/adjust/consumption/return/transfer actualiza balance en la misma transacción.
- [ ]  Dos consumos concurrentes no pueden dejar stock negativo.
- [ ]  Transferencia genera `transfer_out + transfer_in` atómicos, mismo item/grupo y magnitud opuesta.
- [ ]  Owner/admin pueden receipt/adjust/transfer; advisor/technician no.
- [ ]  `adjustment_out` exige motivo no vacío y genera `inventory.adjustment_out_recorded` con actor, producto, ubicación, cantidad, balance before/after, movement id y request_id.
- [ ]  Toda mutación de inventario tiene audit event correlacionado; transfer usa `transfer_group_id`.
- [ ]  Technician con assignment puede consumir/retornar únicamente `part` de su propia orden; technician no asignado es rechazado.
- [ ]  Technician puede crear `quote_type=supplemental` solo con líneas `labor` mediante `quotes.propose_labor_adjustment`.
- [ ]  Technician no puede enviar ni autorizar la cotización supplemental; labor no autorizado nunca se materializa como billable.
- [ ]  `sales_originator_membership_id` se conserva desde quote item a service order item.
- [ ]  E2E approved → consume part/labor adjustment → in_progress → QC.

# 14. Sprint 11 — Entrega + historial + pagos operativos + dashboard

- [ ]  `deliveries.status` solo acepta `pending | completed`.
- [ ]  La entrega se prepara únicamente cuando la orden está `ready_for_delivery`.
- [ ]  `completeDelivery` ejecuta `pending → completed` y `service_order → delivered` atómicamente.
- [ ]  Si falla cualquier guard/efecto de `completeDelivery`, ninguna de las dos entidades queda parcialmente cerrada.
- [ ]  `completed` es terminal; entrega aplazada permanece `pending`.
- [ ]  `pending` mantiene `delivered_at=NULL`; `completed` exige `delivered_at`.
- [ ]  Resumen final.
- [ ]  Entrega solo desde ready_for_delivery.
- [ ]  Firma entrega XOR.
- [ ]  customer_payments.
- [ ]  Métodos de pago.
- [ ]  `amount > 0`, moneda MVP COP y receipt/idempotency constraints.
- [ ]  Pago parcial.
- [ ]  Múltiples pagos.
- [ ]  Pago `confirmed` congela monto/moneda/método/reference/paid_at.
- [ ]  Reverso exige actor + razón y mantiene histórico; corrección usa nuevo payment enlazado.
- [ ]  Allocation pago → orden.
- [ ]  Allocation inmutable en MVP.
- [ ]  No sobreasignar pago; suma allocations ≤ amount.
- [ ]  Payment reversed aporta 0 al saldo efectivo.
- [ ]  `order_paid/outstanding` se deriva del ledger confirmado, no de un campo editable.
- [ ]  `payment_status/outstanding_balance` de delivery concuerda con ledger.
- [ ]  `customer_payment_reconciliation_runs` diario detecta drift/inconsistencias y nunca corrige silenciosamente.
- [ ]  Consistencia protegida en PostgreSQL.
- [ ]  Historial completo vehículo.
- [ ]  Historial del vehículo muestra servicios, mano de obra y repuestos realmente asociados a cada orden mediante `service_order_items`.
- [ ]  Historial muestra garantía por trabajo como `none | active | expired`, con fecha de vencimiento y términos cuando existan.
- [ ]  Owner/admin/advisor pueden crear/revocar token de seguimiento según RBAC; technician no.
- [ ]  `created_by_membership_id` del token pertenece al mismo tenant que la orden; el worker solo entrega el enlace y no crea autoridad autónoma.
- [ ]  Cliente externo puede consultar una orden mediante `customer_order_access_tokens` sin crear user/membership.
- [ ]  Token de seguimiento solo abre la orden asociada, expira y puede revocarse.
- [ ]  No es posible acceder por enumeración de `order_number`, UUID, placa u otro identificador visible.
- [ ]  DTO público excluye PII innecesaria, notas internas, auditoría, billing SaaS y datos de otras órdenes/tenants.
- [ ]  Token inválido/expirado/revocado responde de forma genérica sin confirmar existencia de la orden.
- [ ]  Cierre de orden.
- [ ]  Dashboard business owner/admin calcula ventas únicamente con órdenes entregadas y `delivered_at` del periodo.
- [ ]  Recaudo usa `customer_payments confirmed`; venta y recaudo no se confunden.
- [ ]  Cartera/ticket promedio concuerdan con ledger/órdenes entregadas.
- [ ]  Ranking de participación agrupa `service_order_items.line_total` por `sales_originator_membership_id`; líneas sin originador quedan `Sin atribuir`.
- [ ]  Advisor/technician no acceden a `dashboard.business.read`; technician solo dashboard operacional asignado.
- [ ]  Dashboard muestra top productos/servicios/labor y low/out-of-stock derivados de `inventory_balances`.
- [ ]  E2E reparación → QC → abonos → entrega → dashboard.

# 15. Sprint 12 — Wompi + suscripciones SaaS

- [ ]  Payload `POST /v1/transactions` incluye parámetros obligatorios del contrato (`acceptance_token`, monto, moneda, email, método, referencia única y firma de integridad) y fuente de pago cuando aplique.
- [ ]  `reference` local es única, server-owned y correlaciona a un `payment_id`; nunca se correlaciona por email/monto.
- [ ]  Webhook `transaction.updated` valida checksum usando `signature.properties` dinámicas + timestamp + event secret.
- [ ]  `environment` test/prod incompatible no modifica datos.
- [ ]  Dedupe de transporte + idempotencia de negocio por `transaction.id + status` impiden doble efecto.
- [ ]  Reconciliación server-side `GET /v1/transactions/{id}` funciona ante incidente/evento dudoso.
- [ ]  `subscriptions.status` solo acepta `trialing | active | past_due | suspended | cancelled`.
- [ ]  Transiciones válidas de suscripción coinciden con la máquina documentada.
- [ ]  Transiciones inválidas se rechazan aunque el proveedor/webhook envíe un evento inesperado.
- [ ]  `cancel_at_period_end=true` mantiene `active` hasta `current_period_end`; no se usa como estado alternativo.
- [ ]  `past_due → suspended` solo después de vencer `grace_until` sin recuperación.
- [ ]  `past_due/suspended → active` exige pago/reconciliación confirmada.
- [ ]  `cancelled` es terminal para ese registro y conserva `cancelled_at`.
- [ ]  Crear suscripción.
- [ ]  Sandbox Wompi.
- [ ]  Pago exitoso/fallido.
- [ ]  Webhook válido/inválido.
- [ ]  Duplicado idempotente.
- [ ]  Cobro duplicado impedido.
- [ ]  Estado local sincronizado.
- [ ]  Gracia.
- [ ]  Cancelación.
- [ ]  Mora no elimina datos.
- [ ]  Billing SaaS separado de customer payments.
- [ ]  Reconciliación.
- [ ]  Outage Wompi tolerado.
- [ ]  E2E plan → suscripción → pago → entitlement.

# 16. Sprint 13 — Offline + sincronización

- [ ]  Operación offline conforme ADR-005.
- [ ]  Recepción/drafts estructurados viven en IndexedDB; PostgreSQL sigue siendo source of truth.
- [ ]  Background Sync no es requisito: sin soporte, sync foreground al abrir/focus/online funciona.
- [ ]  Storage quota se estima y `QuotaExceededError` no corrompe ni elimina silenciosamente recepción pendiente.
- [ ]  `navigator.storage.persist()` se solicita/usa donde esté soportado, sin asumir que siempre será concedido.
- [ ]  Media grande offline verifica cuota; si no hay espacio suficiente, UI no afirma que el video quedó guardado y permite conservar la recepción.
- [ ]  Operaciones sensibles server-authoritative no se completan offline.
- [ ]  IDs cliente cuando aplique.
- [ ]  Cola IndexedDB.
- [ ]  Reconexión sincroniza.
- [ ]  operation_id/idempotency evita duplicados.
- [ ]  Retry/backoff.
- [ ]  Conflictos detectados por versión/base_version cuando corresponda.
- [ ]  Conflicto no usa last-write-wins silencioso; operaciones terminales/pagos/autorizaciones nunca se sobrescriben automáticamente.
- [ ]  Resolución aplicada y visible al usuario.
- [ ]  Estados de sync visibles.
- [ ]  Media pendiente no pierde recepción.
- [ ]  Tenant isolation tras sync.
- [ ]  Cerrar/reabrir app conserva cola.
- [ ]  Pérdida real de red durante recepción.
- [ ]  E2E offline → online → consistencia.

# 17. Sprint 14 — Seguridad + hardening

- [ ]  Security Baseline completo revalidado.
- [ ]  `feature_flags` deriva estado efectivo `disabled | scheduled | active | expired` sin `status` redundante.
- [ ]  `feature_flags.value_json` usa reemplazo completo de la fila ganadora; no existe deep-merge accidental entre tenant/plan/global.
- [ ]  Ventanas inválidas (`enabled_until <= enabled_from`) son rechazadas.
- [ ]  Precedencia de flags probada: `tenant > plan > global > default de código`.
- [ ]  `enabled=false` específico bloquea fallback; `scheduled/expired` continúa al siguiente scope aplicable.
- [ ]  Flag inactivo no habilita la capacidad desde backend aunque el frontend intente invocarla.
- [ ]  RBAC completo.
- [ ]  Modelo de acceso interno ILVOX separado del RBAC de talleres; nunca reutiliza `owner/admin` de un tenant.
- [ ]  Para piloto, soporte al taller se limita a enlace externo directo a WhatsApp normal; no se implementa aún mesa de ayuda, WhatsApp API de soporte ni impersonation.
- [ ]  Impersonation/support grants quedan diferidos hasta una fase futura y requerirán diseño explícito + auditoría antes de habilitarse.
- [ ]  Cross-tenant tests automáticos.
- [ ]  Pruebas directas PostgreSQL de FK multitenant.
- [ ]  Append-only DB protections.
- [ ]  REVOKE TRUNCATE.
- [ ]  Secret scanning.
- [ ]  Dependency scan.
- [ ]  Rate limiting.
- [ ]  CORS/CSP.
- [ ]  Signed URLs.
- [ ]  Webhook signatures.
- [ ]  Secretos seguros.
- [ ]  Logs sin secretos y redaction tests cubren Authorization/Cookie/token/OTP/payment instrument data.
- [ ]  `audit_logs` append-only para runtime, before/after minimizados, actor/outcome/request/trace correlacionables.
- [ ]  Purge de audit/retention usa proceso privilegiado separado, respeta legal hold y deja auditoría.
- [ ]  Backup restaurado desde PITR en ambiente aislado.
- [ ]  RPO observado ≤15 min y RTO observado ≤4 h.
- [ ]  Restore valida schema/RLS/FKs/append-only y no redespacha outbox/payment effects.
- [ ]  Load test baseline.
- [ ]  Disponibilidad/latencia/error rate/queue age observables contra SLO baseline.
- [ ]  Alertas 5xx, readiness, DB pool, outbox, webhooks, R2 upload y backup configuradas/probadas.
- [ ]  `/health/live` y `/health/ready` tienen semántica distinta; caída de proveedor async no tumba readiness.
- [ ]  Runbooks.
- [ ]  Regresión login → entrega.
- [ ]  Vulnerabilidades críticas = 0.

# 18. Sprint 15 — Piloto real

**Objetivo:** 3–5 talleres reales durante aproximadamente 30 días.

- [ ]  Talleres configurados.
- [ ]  Feature flags.
- [ ]  Onboarding.
- [ ]  Recepciones reales.
- [ ]  Video/fotos reales.
- [ ]  Cotizaciones/autorizaciones.
- [ ]  Reparaciones/entregas.
- [ ]  WhatsApp real controlado con WABA/número propio por taller piloto.
- [ ]  Facturación Meta directa al taller verificada según alcance; ILVOX no centraliza/refactura consumo WhatsApp en piloto.
- [ ]  OTP on-demand real probado en autorización de cotización.
- [ ]  Billing SaaS Wompi permanece separado del consumo Meta.
- [ ]  Billing según alcance.
- [ ]  Incidentes registrados.
- [ ]  P0/P1 gestionados.
- [ ]  Métricas de disponibilidad calculan SLI contra objetivo 99.0% mensual.
- [ ]  Latencia p95 reads/writes y webhook ACK visibles.
- [ ]  Upload failure rate.
- [ ]  Outbox oldest age/provider failures visibles.
- [ ]  Sync failure rate.
- [ ]  Restore drill mensual programado y backup freshness monitorizado.
- [ ]  Feedback de campo.
- [ ]  Problemas UX documentados.
- [ ]  Recuperación ante fallo controlado.
- [ ]  Cero fugas tenant.
- [ ]  Regresión tras correcciones.

**FAIL crítico:** pérdida de datos, fuga tenant, cobro duplicado, autorización incorrecta o imposibilidad recurrente de recepción.

# 19. Sprint 16 — Release comercial

- [ ]  Gates 0–15 PASSED.
- [ ]  P0 = 0.
- [ ]  P1 = 0 o excepción formal.
- [ ]  SLA/SLO inicial basado en baseline operativo aprobado.
- [ ]  Disponibilidad 99% medible.
- [ ]  Backups automáticos + PITR 14 días.
- [ ]  Restore probado con RPO ≤15 min / RTO ≤4 h.
- [ ]  Monitoring/alertas y retenciones de telemetría en producción.
- [ ]  Runbooks.
- [ ]  Soporte/incidentes.
- [ ]  Planes/precios/entitlements.
- [ ]  Wompi producción.
- [ ]  WhatsApp producción.
- [ ]  Retención media.
- [ ]  Seguridad revisada.
- [ ]  Regresión completa.
- [ ]  Smoke production.
- [ ]  Rollback release.
- [ ]  Feature flags mitigación.
- [ ]  Documentación operativa.
- [ ]  Aprobación formal release.

# 20. Regresión acumulativa

Antes del release se debe volver a probar: login, tenant, clientes, vehículos, recepción, firma, video, fotos, orden, diagnóstico, cotización, versiones, PDF, autorización, WhatsApp, reparación, QC, catálogo/inventario y consumo de repuestos, cotización suplementaria de mano de obra, customer payments, entrega, historial, dashboard comercial, billing SaaS, offline/sync, permisos, rechazo cross-tenant y backup/restore.

# 21. Política PASS / FAIL

| Situación | Resultado |
| --- | --- |
| Falla criterio crítico | FAIL |
| Fuga entre tenants | FAIL inmediato |
| Pérdida/corrupción de datos | FAIL inmediato |
| Pago/cobro duplicado | FAIL inmediato |
| Autorización incorrecta | FAIL inmediato |
| Test obligatorio no ejecutado | NOT READY |
| Solo funciona local | FAIL |
| Staging falla | FAIL |
| Regresión rompe sprint anterior | FAIL |
| Todos los criterios con evidencia | PASS |

# 22. Flujo obligatorio de sprint

**Product Backlog → Planning → Desarrollo/Documentación → Code Review → Unit/Integration/E2E → Staging → QA → Quality Gate.**

Si falla: corrección y nueva ejecución.  

Si pasa: Sprint Review → Retrospectiva → Release/control de feature flag → siguiente sprint.

<aside>
🏁

**Ninguna fecha, presión comercial o “ya funciona” sustituye un Gate.** Una dependencia funcional no queda habilitada hasta que el Gate anterior tenga estado PASSED y evidencia.

</aside>