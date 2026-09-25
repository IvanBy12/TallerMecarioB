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

- **DOC_CONFLICT / BLOCKER:** Quality Gates Sprint 1 §4 exige `E2E login → tenant → dashboard`; el mismo documento ubica el dashboard funcional en Sprint 11. El backend Sprint 1 no define endpoint de dashboard. Se necesita precisar el alcance del smoke sin inventar una ruta o función de producto.
- **Auth real / BLOCKER:** Clerk Development respondió; se verificaron JWKS, firma de JWT real, perfil, rechazo de issuer y `azp` incorrectos. El token emitido por Backend API carece de `azp` y es rechazado correctamente por la API. No se ejecutó login en navegador, `/me`, tenant permitido/ajeno ni suspensión/revocación con sesión real porque no se proporcionó URL de PWA/Clerk sign-in ni cuenta de prueba. El smoke obligatorio permanece `NOT_RUN`.
- **DECISION_REQUIRED D1–D6:** permanecen abiertas según Operación §5.2; no se cambian reglas de producto.
- **INFO:** una credencial PostgreSQL runtime comprometida puede establecer GUC arbitrarios o tomar advisory locks deterministas por SQL raw. Es la frontera confiada documentada en ADR-009, no un bypass de los flujos soportados. Los residuos locales `tm_test_ml*` anteriores no son migraciones.

El E2E real de Resend S1-04 se documentó como ejecutado en su cierre y no se repitió. Los archivos de documentación anteriores conservan el estado histórico de sus ramas; Operación §5.2 y S1-08 registran la actualización de deuda CI de este Gate.

## Residuos

Tras todas las suites y mutaciones: 0 bases locales `tm_test_*`. Permanecen dos roles `tm_test_ml*` de una corrida S1-06 anterior; este Gate no los creó ni los borra. No se iniciaron procesos API/worker. Se retiró el junction temporal `node_modules` usado para las dependencias y el script local de inspección del catálogo. No se borraron worktrees ajenos.

**Estado:** FIXES REQUIRED hasta resolver el conflicto documental y ejecutar el smoke browser real obligatorio.
