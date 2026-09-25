# Security Baseline — Aplicación y Plataforma

<aside>
🛡️

**Objetivo:** establecer controles obligatorios de seguridad para frontend, API, PostgreSQL, autenticación, archivos, CI/CD y operación. Estos controles forman parte de los Quality Gates y no son opcionales para producción.

</aside>

**Estado:** Baseline de seguridad — Sprint 0  

**Aplica a:** development, staging y production, con exigencia máxima antes de piloto/release.

# 1. Secretos y credenciales

- **Ocultar claves de API:** ninguna secret key puede llegar al bundle frontend, repositorio, logs o respuestas API.
- Secretos de Clerk, PostgreSQL, R2, Wompi, WhatsApp, correo y demás proveedores viven únicamente en variables/secret store del entorno.
- Para WhatsApp multi-tenant, PostgreSQL solo conserva `credential_secret_ref`/metadata no secreta en `tenant_whatsapp_accounts`; tokens/access material reales viven en secret store y se resuelven server-side por tenant.
- Ninguna credencial WhatsApp de Tenant A puede utilizarse para operar la WABA/phone_number_id de Tenant B; el scope y la asociación se validan antes de cada envío.
- Solo se permiten claves explícitamente diseñadas como **publishable/public** en frontend.
- **PostgreSQL no tendrá ninguna clave pública expuesta al navegador.** La PWA nunca se conecta directamente a la base; solo API/worker acceden con credenciales privadas y privilegios mínimos.
- Rotación documentada de secretos.
- Separación de secretos por development/staging/production.

# 2. Purgado y detección de secretos en Git

- Secret scanning obligatorio en CI.
- `.env`, certificados y archivos de credenciales fuera de Git.
- Si un secreto entra al historial: **rotar primero**, luego purgar historial con herramienta apropiada y volver a escanear.
- Nunca asumir que borrar el archivo en un commit elimina el secreto del historial.
- PR bloqueado si el escáner detecta credenciales de alta confianza.

# 3. PostgreSQL: mínimo privilegio + RLS

**Especificación canónica:** [ADR-009 — RLS y privilegios PostgreSQL por TenantContext](ADR-009%20%E2%80%94%20RLS%20y%20privilegios%20PostgreSQL%20por%20TenantC%203e06ab0a330d8162b0cfff78ad1cb9b1.md).

Baseline:

- roles físicos separados: `tallermecario_schema_owner` NOLOGIN, `tallermecario_migrator`, `tallermecario_api`, `tallermecario_worker` y resolver bootstrap NOLOGIN de privilegio excepcional;
- `tallermecario_api`/`tallermecario_worker`: `NOBYPASSRLS`, nunca propietarios, sin DDL/TRUNCATE/CREATE ROLE/CREATE DB ni capacidad de `SET ROLE` a roles privilegiados;
- cada tabla tenant-owned habilita **ENABLE + FORCE ROW LEVEL SECURITY** desde su migración;
- policies tenant comparan contra `app.current_tenant_id()` derivado de contexto transaction-local; sin contexto, deny-by-default;
- cada request/job tenant-owned usa transacción y `set_config(..., true)`; nunca contexto session-wide en conexiones pooled;
- `USING` protege las filas existentes y `WITH CHECK` impide INSERT/UPDATE hacia otro tenant;
- RLS baseline es aislamiento de tenant, no duplicación de RBAC/resource scopes;
- FKs compuestas `(tenant_id, id)` siguen siendo obligatorias;
- DELETE es deny-by-default y solo se habilita por tabla/caso aprobado;
- RLS no sustituye REVOKE append-only; runtime carece de UPDATE/DELETE/TRUNCATE sobre históricos críticos;
- flujos sin tenant inicial (login, tokens públicos, webhooks, claim de outbox) usan funciones `SECURITY DEFINER` allowlisted con owner NOLOGIN, privilegio mínimo y `search_path` fijo; nunca SELECT global directo del runtime;
- CI/Gate inspecciona `pg_policies`, `relrowsecurity`, `relforcerowsecurity`, ownership y atributos de roles.

# 4. Encriptación de datos sensibles

- TLS obligatorio en tránsito.
- Cifrado at-rest provisto por infraestructura para DB, backups y storage.
- Evaluar cifrado a nivel aplicación/campo para PII de mayor riesgo que no necesite búsquedas directas.
- Claves de cifrado separadas de los datos y fuera de la base.
- No cifrar “por cumplir” campos que requieran búsqueda sin diseñar previamente indexación/tokenización.
- Tokens públicos de aprobación/recuperación se almacenan como **hash**, no en texto plano.
- OTP de autorización de cotización también se almacena exclusivamente como `code_hash`; el código crudo no se persiste en PostgreSQL, outbox ni logs.

# 5. Autenticación server-side

- Toda ruta protegida verifica autenticación en Fastify.
- El frontend nunca decide si una sesión es válida.
- Clerk JWT se valida antes de provisioning JIT o construcción de TenantContext.
- Sesión inválida/expirada → 401.
- Usuario sin membership → 403/onboarding.
- Membership sin permiso → 403.
- Toda autorización de negocio se resuelve server-side.

**Verificación S1-08:** un JWT válido de A y un header que selecciona B no conceden acceso sin membership activa en B. `org_role`, `org_permissions` y metadata de Clerk no sustituyen las memberships/RBAC de PostgreSQL; suspensión, revocación o ausencia de membership deniegan el acceso. El backend establece `app.tenant_id`, `app.user_id`, `app.membership_id` y `app.request_id` como GUC transaction-local; COMMIT/ROLLBACK, error, retorno temprano y denegación no dejan contexto en la conexión reutilizada. Los GUC son contexto confiado por la aplicación, no prueba criptográfica; se presuponen credenciales runtime no comprometidas (ADR-009).

# 6. Acceso a registros

- Toda lectura/escritura tenant-owned exige TenantContext.
- Repositorios reciben tenant explícito desde contexto verificado, nunca desde payload arbitrario.
- RLS + FKs compuestas + autorización de aplicación forman capas independientes.
- Endpoints públicos usan tokens de un solo propósito, alta entropía, expiración, revocación y alcance mínimo.
- Los tokens públicos se almacenan únicamente como hash y nunca se reutilizan entre propósitos (p. ej. seguimiento de orden vs autorización de cotización).
- Para decisiones de cotización, conocer el link no basta: se exige `quote_authorization_challenge` OTP verificado y vigente antes del commit de aprobar/rechazar/parcial.
- El OTP enviado al mismo WhatsApp protege contra fuga aislada del URL, pero no contra compromiso total de la cuenta del cliente; esta limitación forma parte del threat model.
- Acceso público nunca se autoriza por IDs/tickets enumerables, placa, teléfono o documento.
- Acceso a media únicamente con autorización previa y URL firmada temporal.

# 7. Protección contra manipulación de campos

- DTOs de entrada con **allowlist explícita**.
- Zod rechaza campos inesperados cuando el contrato lo requiera.
- No hacer spread directo de `request.body` hacia INSERT/UPDATE.
- Campos como `tenant_id`, `created_by`, roles, permissions, status protegidos y derivados server-side.
- Transiciones de estado por comandos de dominio, no por PATCH genérico.

# 8. Cookies y sesión

- Cookies de sesión con `Secure` y `HttpOnly` cuando aplique.
- Política `SameSite` definida según flujo real.
- No persistir tokens sensibles en storage inseguro si puede evitarse.
- CSRF se evalúa según el mecanismo real de autenticación/cookie utilizado.
- Logout/revocación debe invalidar acceso conforme al proveedor y backend.

# 9. Contraseñas

- **ILVOX no almacenará contraseñas de usuarios mientras Clerk sea el IdP.**
- El hashing de contraseñas corresponde al proveedor de identidad.
- Si algún módulo futuro almacena credenciales propias, requerirá un ADR de seguridad y algoritmo de password hashing moderno con salt y parámetros revisados.
- API keys propias, magic tokens y approval tokens nunca se guardan como “contraseña reversible”; usar hash cuando solo se necesite comparación.

# 10. Rate limiting y protección contra bots

- Rate limiting por IP/identidad/ruta según riesgo.
- Límites especialmente estrictos en login, invitaciones, aceptación de invitaciones, enlaces públicos, OTP/challenges, uploads y webhooks.
- OTP baseline: TTL 5 minutos, máximo 5 intentos por challenge y cooldown de reenvío de 60 segundos; además debe existir rate limit configurable por token/IP/destino.
- Protección anti-bot/WAF/CAPTCHA o desafío administrado en superficies públicas de riesgo.
- Bloqueos no deben impedir operación legítima del taller; thresholds y excepciones deben medirse.
- Alertar sobre patrones de credential stuffing, scraping o abuso.

# 11. Consultas seguras

- Usar consultas parametrizadas/bind variables.
- Drizzle como ruta normal de persistencia.
- SQL raw solo con parámetros; prohibida concatenación de datos de usuario.
- Revisiones de código para queries dinámicas complejas.

# 12. Validación de entrada

- Toda entrada externa se valida: body, params, query, headers relevantes, webhooks, CSV/importaciones y metadata de archivos.
- Límites de longitud, tipos, formatos y rangos.
- Rechazar propiedades inesperadas en operaciones sensibles.
- No confiar en datos recibidos desde frontend aunque la UI ya los valide.

# 13. Escape y sanitización de contenido

- React mantiene escape por defecto; evitar `dangerouslySetInnerHTML` salvo caso documentado.
- Si se admite HTML/rich text, sanitizar con allowlist.
- Escapar contexto correcto en HTML, atributos, URLs y plantillas.
- Mensajes, notas y nombres de archivos no se interpolan sin tratamiento en HTML/SQL/shell.

# 14. Cargas de archivos

- Allowlist de MIME/extensiones por caso de uso.
- Validar tipo real/metadata y no solo extensión.
- Límite de tamaño y duración.
- Nombres/object keys generados internamente, sin PII necesaria.
- Upload mediante URL firmada de corta duración.
- Bucket privado.
- Estado pending/uploaded/active/quarantined.
- Posibilidad de cuarentena/escaneo según tipo de archivo y riesgo.
- Nunca ejecutar archivos cargados por usuarios.

# 15. Respuestas API mínimas

- **Data minimization por respuesta:** devolver solo campos necesarios.
- DTOs de salida, no serializar entidades completas automáticamente.
- Nunca devolver hashes, secrets, provider payloads internos o metadata operativa innecesaria.
- PII solo para roles y casos de uso autorizados.
- Errores de producción no exponen stack traces, SQL ni infraestructura.

# 16. Encabezados de seguridad

- CSP restrictiva.
- HSTS en producción.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy` definida.
- `Permissions-Policy` restrictiva.
- Protección clickjacking mediante CSP `frame-ancestors` y/o header compatible.
- CORS con orígenes explícitos; nunca `*` con credenciales.

# 17. HTTPS

- HTTPS obligatorio en producción y staging expuesto.
- Redirección HTTP → HTTPS cuando exista endpoint HTTP.
- Cookies Secure.
- Webhooks únicamente HTTPS.
- URLs firmadas y callbacks no usan HTTP.

# 18. Dependencias y supply chain

- Dependency scanning en CI.
- Lockfile versionado.
- Actualizaciones de seguridad priorizadas.
- Vulnerabilidades críticas bloquean release.
- Revisar paquetes nuevos antes de incorporarlos.
- Imágenes Docker con base mínima y scanning.
- SBOM/reporte de componentes antes de release comercial si la herramienta lo permite.

# 19. Auditoría de seguridad

**Baseline de auditoría/retención/observabilidad:** [Operación, Retención, Recuperación y Observabilidad v1 — TallerMecario](Operaci%C3%B3n,%20Retenci%C3%B3n,%20Recuperaci%C3%B3n%20y%20Observabilida%203e06ab0a330d819ea376f6f7628679f6.md).

`audit_logs` es append-only para runtime, pero no de retención infinita: baseline 24 meses y purge posterior únicamente mediante proceso privilegiado, separado y auditado cuando no exista hold/obligación superior. `before/after/metadata` se minimizan y redactan; application logs no sustituyen auditoría.

Eventos de seguridad/auditoría prioritarios:

- login/revocación cuando sea relevante;
- `identity.user_provisioned_jit` en la primera creación local vía JIT;
- reconciliación de identidad por webhook cuando cambie datos relevantes;
- creación/revocación de memberships;
- cambios de roles/permisos;
- intentos denegados críticos cuando aporten valor sin generar ruido excesivo;
- acceso/cambio de configuraciones sensibles;
- generación/revocación de credenciales propias;
- acciones administrativas;
- exportación o eliminación de datos;
- incidentes de privacidad.

Para `identity.user_provisioned_jit`, registrar: `user_id` interno (actor y entidad), `identity_provider`, `request_id`, timestamp (`created_at`) y resultado. **No registrar IP ni User-Agent:** la función JIT/bootstrap no los recibe y `user_agent` permanece NULL para toda fila nueva. Tampoco registrar JWT ni payload de Clerk. En auditoría escrita por la API, `ip_address` es solo la IP del peer TCP (`request.ip` sin `trustProxy`, sin `X-Forwarded-For`); worker y eventos de proveedor no llevan IP. Fuente detallada: Operación §5.1–§5.2. **DOC_CONFLICT Security Baseline §19 ↔ Operación §5.1 (S1-04): CLOSED** para los campos del evento JIT.

**Aislamiento de auditoría S1-08:** las rutas soportadas resuelven entidades bajo TenantContext/RLS; un UUID ajeno invisible no se registra como `entity_id` ni en metadata de A y las denegaciones de selección no contaminan B. `audit_logs` no valida universalmente la pertenencia de `entity_id` frente a SQL raw de una credencial runtime comprometida. El worker coteja claim y fila outbox durable antes de cualquier handler normal/phased, incluida `prepare` con posible red; tras mismatch el job puede recuperarse por stall/requeue y procesarse bajo el tenant correcto una sola vez. Este binding reside en el flujo worker, no en un supuesto `app.tenant_id` de los helpers globales por ID.

# 20. Quality Gate de seguridad

- [ ]  Secret scan pasa.
- [ ]  No existen secretos en bundle frontend.
- [ ]  Credenciales DB no están expuestas públicamente.
- [ ]  Roles DB de mínimo privilegio.
- [ ]  RLS probada en tablas sensibles tenant-owned.
- [ ]  Cross-tenant query devuelve 0/rechazo aun intentando saltar la API donde aplique.
- [ ]  Campos protegidos no pueden sobrescribirse desde payload.
- [ ]  JWT se verifica server-side.
- [ ]  Cookies/sesión cumplen flags definidos.
- [ ]  Rate limiting probado.
- [ ]  Anti-bot/WAF probado en superficie pública seleccionada.
- [ ]  Queries parametrizadas.
- [ ]  Payloads inválidos son rechazados.
- [ ]  XSS/rich text según alcance probado.
- [ ]  Uploads inválidos/sobredimensionados rechazados.
- [ ]  API no filtra campos internos.
- [ ]  Security headers presentes.
- [ ]  HTTPS/HSTS conforme al ambiente.
- [ ]  Dependency scan sin vulnerabilidades críticas abiertas.
- [ ]  JIT provisioning genera audit event sin secretos.
- [ ]  Credenciales WhatsApp quedan aisladas por tenant y solo se resuelven desde secret store.
- [ ]  `phone_number_id` de webhook resuelve exactamente un tenant; no puede forzarse Tenant A → Tenant B.
- [ ]  OTP de cotización nunca aparece en DB/outbox/logs en texto plano.
- [ ]  OTP expirado, bloqueado, superseded o incorrecto no permite decisión; límite de intentos/rate limit probado.
- [ ]  Audit log no contiene secretos/token/OTP/JWT/PAN-CVV y es append-only para runtime.
- [ ]  Proceso de retención/purge usa privilegio separado, respeta legal hold y genera audit event.
- [ ]  Restore drill demuestra que tombstones/supresiones pueden reaplicarse antes de reabrir producción.

<aside>
🚦

Este baseline es parte del Quality Gate. Sprint 14 hará hardening y pruebas ampliadas, pero los controles esenciales aplicables deben existir desde el sprint donde aparece cada superficie de ataque.

</aside>
