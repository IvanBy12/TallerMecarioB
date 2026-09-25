# Sprint 1 — Final Quality Gate (2026-09-25)

Rama aislada: `task/sprint-1-final-quality-gate`. Base: `task/s1-08-cross-tenant-final` en `e6e3200`. No se modifica `main`, no se hace push, squash, rebase ni reset.

## Evidencia local

- Migración limpia PostgreSQL 18: `0000→0017`, exactamente 18 entradas; `test:db:sprint0` 59/59 y `test:db:migration-lock` PASS. Las suites usan bases desechables y se ejecutaron en serie; no dependen de fixtures históricos.
- Typecheck, build, secret scan y `npm audit --omit=dev`: PASS; 0 vulnerabilidades de producción.
- Regresión funcional: 17 suites con conteo, **679/679 tests**, 0 fallos, 0 skipped, 0 todo. Incluye onboarding, TenantContext core/DB/API, RBAC/DB, API multitenant/security, identity, invitations, roles, memberships, audit, cross-tenant, outbox y Wompi. Identity, invitations, roles, memberships y audit también pasaron sus upgrades; migration-lock pasó por separado.
- S1-08 cubre aislamiento API/DB/funciones, JWT/TenantContext, locks, GUC/pool, auditoría, outbox normal y phased, recovery y enumeración. S1-07 cubre actor/tenant de auditoría, append-only y grants por columnas. La DB limpia confirma RLS `ENABLE + FORCE`, roles runtime `NOBYPASSRLS`, privilegios PUBLIC y la allowlist de funciones.
- El workflow CI añade `build`, auditoría de dependencias sin umbral, suites S1-04…S1-08, identity, `authz:db` y `tenant-context:db`; preserva las suites previas y ejecuta migraciones en pasos seriales. Se verificó que sus 27 comandos `npm run` corresponden a scripts reales, sin `continue-on-error`. La ejecución remota de GitHub Actions sigue pendiente: no se hizo push.

## Mutaciones

Gate manual/pre-release, en serie contra PostgreSQL local o CI con `DATABASE_URL`:

**Resultado local:** S1-05 13/13, S1-06 15/15, S1-07 15/15 y S1-08 9/9: **52/52 KILLED**. Las mutaciones se aplicaron en DB desechable o JS compilado temporal y se limpiaron al terminar.

```text
npm run test:member-roles:mutations:ci
npm run test:member-lifecycle:mutations:ci
npm run test:audit:mutations:ci
npm run test:cross-tenant:mutations:ci
```

S1-04 tiene dos sondas de mutación con rollback dentro de `test:invitations`: quitar el índice parcial permite dos invitaciones pendientes para el mismo email; desactivar el trigger permite reabrir una invitación revocada. Se comprobó que ambos objetos siguen activos tras el rollback. No hay runner de mutación S1-04 separado.

## DOC_CONFLICT y decisiones abiertas

- **DOC_CONFLICT: CLOSED (2026-09-25).** Quality Gates Sprint 1 §4 exigía `E2E login → tenant → dashboard`, mientras el roadmap canónico ubica el dashboard en Sprint 11 (“Ciclo cerrado + métricas owner/admin”) y el Sprint 1 en “Taller puede ingresar”. Se corrigió solo la documentación: §4 ahora exige `login Clerk válido → identidad Clerk válida → TenantContext resuelto → acceso autorizado al workshop → shell/home protegida`, y aclara que no exige dashboard de métricas, KPIs ni widgets owner/admin (Sprint 11, §14). No se implementó dashboard ni ruta nueva. El export de Quality Gates se versiona en esta rama (`docs/` está en `.gitignore`); la página Notion canónica debe recibir el mismo cambio de una línea.
- **Auth real: PASS** (ver “E2E Clerk en navegador real”). El smoke anterior contra Backend API sigue válido: ese token no tiene `azp` y la API lo rechaza.
- **DECISION_REQUIRED D1–D6:** permanecen abiertas según Operación §5.2; no se cambian reglas de producto.
- **INFO:** una credencial PostgreSQL runtime comprometida puede establecer GUC arbitrarios o tomar advisory locks deterministas por SQL raw. Es la frontera confiada documentada en ADR-009, no un bypass de los flujos soportados. Los residuos locales `tm_test_ml*` anteriores no son migraciones.

El E2E real de Resend S1-04 se documentó como ejecutado en su cierre y no se repitió. Los archivos de documentación anteriores conservan el estado histórico de sus ramas; Operación §5.2 y S1-08 registran la actualización de deuda CI de este Gate.

## E2E Clerk en navegador real (2026-09-25)

Cierre del requisito “Taller puede ingresar”. Sin cambios de código: API compilada del mismo árbol (`dist` de 4b3c605; ningún `src` más nuevo que el build), configuración Clerk existente (`.env` del checkout principal), sin worker ni Resend.

- **Navegador:** Chrome 154 real (headless, conducido por CDP), origen `http://localhost:5173`, que coincide con `CLERK_AUTHORIZED_PARTIES`. Clerk JS se cargó desde el Frontend API de la instancia. La página es un harness temporal fuera del repo (HTML estático + proxy same-origin `/api/*` → API `127.0.0.1:3100`), no un frontend de producto. Su “home protegida” se renderiza solo si `GET /api/v1/__whoami` (permiso `workshop.read`, ruta smoke ya existente) resuelve TenantContext.
- **Clerk:** entorno **Development** (publishable key `pk_test_`, `instance_environment_type=development`). Hubo 4 usuarios desechables `+clerk_test` creados por Backend API y eliminados al terminar; se verificó que quedan 0. El login fue email + password en el navegador; Clerk pidió verificación de nuevo dispositivo (`needs_second_factor`) y se completó con el código de prueba de Development.
- **Base de datos:** PostgreSQL 18.4, base desechable `tm_e2e_s1gate_browser` migrada limpia `0000→0017` (18 entradas) y eliminada al terminar. La API se conectó con `SET ROLE tallermecario_api` (NOBYPASSRLS, no owner). No se tocó la base local `TallerMecario`.
- **Fixture:** solo las memberships `active` (rol `service_advisor`) del usuario bajo prueba en los talleres S y R de otros owners, insertadas como superusuario en la base desechable, porque onboarding permite un solo taller por usuario. La suspensión y la revocación se ejecutaron por la API real con la sesión Clerk del owner de cada taller.

| Check | Resultado |
|---|---|
| A. Login Clerk en navegador → sesión creada | PASS (`session.status=active`) |
| B. JWT real | PASS: `azp=http://localhost:5173`, `sid` presente e igual a la sesión, RS256, header `cat`, TTL 60 s, sin claims org/metadata |
| Sin token | 401 |
| C. `GET /api/v1/me` | **200** (antes de membership: `unavailable`; con 1: `automatic`; con 3: `required`) |
| Sin membership → home protegida | 403 `ACTIVE_MEMBERSHIP_REQUIRED` |
| D. Workshop propio con membership `active` | **200**, TenantContext = A (con y sin `X-Tenant-Id`), home renderizada |
| N memberships sin `X-Tenant-Id` | 409 `TENANT_SELECTION_REQUIRED` |
| E. Tenant ajeno B (y `GET /memberships` en B) | **403** `TENANT_ACCESS_DENIED`; tenant inexistente también 403 (sin oráculo) |
| Control S y R con membership `active` | 200 / 200 |
| F. Membership suspendida (S), misma sesión Clerk viva | **403** `TENANT_ACCESS_DENIED` |
| G. Membership revocada (R), misma sesión Clerk viva | **403** `TENANT_ACCESS_DENIED`; `/me` vuelve a listar solo A; A sigue en 200 |
| H1. JWT alterado con `org_id/org_role/org_permissions/o/metadata/public_metadata/tenant_id` | 401 (`/me` y B) |
| H2. JWT válido tras forjar `unsafeMetadata` (navegador) y `publicMetadata` (Backend API) como owner de B, más headers `x-org-role`/`x-org-permissions`/`x-clerk-org-id`/`x-user-role` y `?tenant_id=B` | B/S/R siguen en 403; `POST .../suspend` en B da 403; la selección automática sigue en A |
| Estado DB final | S=`suspended`, R=`revoked` |
| Sign-out | La sesión del navegador queda eliminada |

Total: 26/26 checks PASS. Organizations está deshabilitado en la instancia, por lo que un token real no puede traer `org_role`. H1 cubre la inyección de claims en el token y H2 la manipulación de metadata real de Clerk. Ninguno concede acceso: la autorización sale de PostgreSQL (memberships/roles bajo RLS), no de claims.

**Evidencia sin secretos:** el proxy registró solo método, ruta y status, y no se imprimieron tokens, passwords ni llaves. El escaneo de `api.log`, `harness.log` y del JSON de evidencia encontró 0 coincidencias de `eyJ`, `Bearer `, `sk_`, `pk_test_`, `whsec_` y del prefijo de password. Los artefactos del harness quedaron en el scratch del job, fuera del repo.

## CI

- CI CONFIGURATION: PASS. CI LOCAL COMMAND PARITY: PASS (27 comandos `npm run` existentes, sin `continue-on-error`).
- CI REMOTE EXECUTION: PENDING PUSH. No es un defecto de código: la rama no se ha publicado. GitHub Actions debe ejecutarse en verde antes del merge a `main`.
- No se repitieron las 679 pruebas ni las 52 mutaciones: este cierre no cambia código, solo documentación y evidencia del Gate.

## Residuos

Tras todas las suites y mutaciones quedaron 0 bases locales `tm_test_*`. Permanecen dos roles `tm_test_ml*` de una corrida S1-06 anterior; este Gate no los creó ni los borra. Se retiró el junction temporal `node_modules` usado para las dependencias y el script local de inspección del catálogo. No se borraron worktrees ajenos.

Cierre browser: la API, el harness y Chrome se detuvieron. Quedaron 0 bases `tm_e2e_*`/`tm_test_*`, 0 usuarios Clerk `tm-s1gate-*`, perfiles de Chrome eliminados y los puertos 3100, 5173 y 9333 libres.

**Estado:**

- SPRINT 1 LOCAL FINAL QUALITY GATE: PASS
- SPRINT 1 — MULTIEMPRESA + AUTENTICACIÓN: READY FOR REMOTE CI + INTEGRATION

No se declara CLOSED hasta que GitHub Actions pase en remoto.
