/**
 * Modelo puro de combinación de scopes de permiso.
 *
 * Prepara el terreno para la fase de integración de TenantContext (S1-02
 * principal): dado el conjunto de scopes que los roles ACTIVOS de una
 * membership conceden para un mismo permission code, calcula el grant
 * efectivo. No depende de Fastify, PostgreSQL, TenantContext ni de ningún
 * estado de request — es una función pura sobre `ResourceScope[]`.
 *
 * "Los permisos efectivos son la unión de los roles activos de una
 * membership; no habrá 'deny overrides' en MVP." (RBAC — Matriz completa de
 * roles y permisos v1, §1).
 */

import type { ResourceScope } from './rbac-matrix';

/** Scopes no-tenant que sobreviven cuando ningún rol concede 'tenant'. */
export type RestrictedScope = Exclude<ResourceScope, 'tenant'>;

/** Grant efectivo para un permission code, tras combinar todos los roles activos. */
export type PermissionGrant =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'restricted'; readonly scopes: ReadonlySet<RestrictedScope> };

function isRestrictedScope(scope: ResourceScope): scope is RestrictedScope {
  return scope === 'assigned' || scope === 'quality_control';
}

/**
 * Combina los scopes concedidos por los roles activos de una membership para
 * un mismo permission code.
 *
 * Reglas:
 *  - si algún rol concede `'tenant'`, el grant efectivo es `{ kind: 'tenant' }`
 *    (tenant domina sobre assigned/quality_control);
 *  - si no, el grant efectivo es `{ kind: 'restricted', scopes }` con la unión
 *    (sin duplicados) de `'assigned'` / `'quality_control'` presentes;
 *  - lista vacía (sin ningún rol concede el permiso) → `undefined`.
 *
 * El orden y los duplicados de la entrada no afectan el resultado.
 */
export function combinePermissionScopes(
  scopes: readonly ResourceScope[],
): PermissionGrant | undefined {
  if (scopes.length === 0) return undefined;

  if (scopes.some((scope) => scope === 'tenant')) {
    return { kind: 'tenant' };
  }

  const restricted = new Set<RestrictedScope>();
  for (const scope of scopes) {
    if (isRestrictedScope(scope)) {
      restricted.add(scope);
    }
  }
  return { kind: 'restricted', scopes: restricted };
}
