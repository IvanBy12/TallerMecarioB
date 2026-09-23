/**
 * Núcleo puro de autorización por permission code (S1-02).
 *
 * Toda decisión depende EXCLUSIVAMENTE de `ctx.permissions` (grant efectivo
 * por permission code). `ctx.roles` es informativo (UI, diagnóstico, /me) y
 * este módulo no lo lee: ninguna rama compara nombres de rol.
 *
 * Grant restringido (assigned / quality_control) NUNCA equivale a grant de
 * tenant: un technician con `orders.read = assigned` no puede leer todas las
 * órdenes del tenant; solo puede pasar un requisito de scope 'resource', que
 * además exige el check de recurso (ver resource-authorization.ts).
 *
 * Sin Fastify, sin PostgreSQL. El mapeo HTTP se hace en integración.
 */

import { FrozenMap, FrozenSet } from '../platform/readonly-collections';
import { combinePermissionScopes, type PermissionGrant, type RestrictedScope } from './permission-grants';
import {
  PERMISSION_CODES,
  RESOURCE_SCOPES,
  ROLE_CODES,
  type PermissionCode,
  type ResourceScope,
  type RoleCode,
} from './rbac-matrix';
import type { TenantContext } from '../tenancy/tenant-context';

/* -------------------------------------------------------------------------- */
/* Errores                                                                    */
/* -------------------------------------------------------------------------- */

export type AuthzErrorCode =
  | 'PERMISSION_DENIED'
  | 'AUTHZ_UNKNOWN_PERMISSION'
  | 'AUTHZ_UNKNOWN_RESOURCE_SCOPE'
  | 'AUTHZ_UNKNOWN_ROLE'
  | 'AUTHZ_INVALID_REQUIREMENT';

export abstract class AuthzError extends Error {
  abstract readonly code: AuthzErrorCode;
}

/** El contexto no tiene el grant exigido (o solo tiene uno restringido donde se exige tenant). */
export class PermissionDeniedError extends AuthzError {
  readonly code = 'PERMISSION_DENIED';
  constructor(readonly permission: PermissionCode) {
    super('Permission denied.');
    this.name = 'PermissionDeniedError';
  }
}

/** Un boundary dinámico (DB, config) entregó un permission code fuera de la matriz. */
export class AuthzUnknownPermissionError extends AuthzError {
  readonly code = 'AUTHZ_UNKNOWN_PERMISSION';
  constructor() {
    super('Unknown permission code.');
    this.name = 'AuthzUnknownPermissionError';
  }
}

/** Un boundary dinámico entregó un resource scope fuera de tenant|assigned|quality_control. */
export class AuthzUnknownResourceScopeError extends AuthzError {
  readonly code = 'AUTHZ_UNKNOWN_RESOURCE_SCOPE';
  constructor() {
    super('Unknown resource scope.');
    this.name = 'AuthzUnknownResourceScopeError';
  }
}

/** Un boundary dinámico entregó un role code fuera de la matriz. */
export class AuthzUnknownRoleError extends AuthzError {
  readonly code = 'AUTHZ_UNKNOWN_ROLE';
  constructor() {
    super('Unknown role code.');
    this.name = 'AuthzUnknownRoleError';
  }
}

/** Requisito de ruta mal formado (scope distinto de 'tenant' | 'resource'). */
export class AuthzInvalidRequirementError extends AuthzError {
  readonly code = 'AUTHZ_INVALID_REQUIREMENT';
  constructor() {
    super('Invalid permission requirement.');
    this.name = 'AuthzInvalidRequirementError';
  }
}

/* -------------------------------------------------------------------------- */
/* Validación de valores dinámicos (fail closed, sin `as PermissionCode`)     */
/* -------------------------------------------------------------------------- */

const PERMISSION_CODE_SET: ReadonlySet<string> = new FrozenSet<string>(PERMISSION_CODES);
const RESOURCE_SCOPE_SET: ReadonlySet<string> = new FrozenSet<string>(RESOURCE_SCOPES);
const ROLE_CODE_SET: ReadonlySet<string> = new FrozenSet<string>(ROLE_CODES);

export function isPermissionCode(value: unknown): value is PermissionCode {
  return typeof value === 'string' && PERMISSION_CODE_SET.has(value);
}

export function isResourceScope(value: unknown): value is ResourceScope {
  return typeof value === 'string' && RESOURCE_SCOPE_SET.has(value);
}

export function isRoleCode(value: unknown): value is RoleCode {
  return typeof value === 'string' && ROLE_CODE_SET.has(value);
}

/** string desconocido → `AuthzUnknownPermissionError`. */
export function parsePermissionCode(value: unknown): PermissionCode {
  if (!isPermissionCode(value)) throw new AuthzUnknownPermissionError();
  return value;
}

/** string desconocido → `AuthzUnknownResourceScopeError`. */
export function parseResourceScope(value: unknown): ResourceScope {
  if (!isResourceScope(value)) throw new AuthzUnknownResourceScopeError();
  return value;
}

/** string desconocido → `AuthzUnknownRoleError`. */
export function parseRoleCode(value: unknown): RoleCode {
  if (!isRoleCode(value)) throw new AuthzUnknownRoleError();
  return value;
}

/* -------------------------------------------------------------------------- */
/* Mapa efectivo de grants                                                    */
/* -------------------------------------------------------------------------- */

/** Fila `role_permissions` (ya unida con roles activos de la membership) tal como la devuelva la DB. */
export interface PermissionGrantRowInput {
  readonly permissionCode: string;
  readonly resourceScope: string;
}

const TENANT_GRANT: PermissionGrant = Object.freeze({ kind: 'tenant' });

/** Congela un grant; los scopes restringidos se copian en orden canónico. */
function freezeGrant(grant: PermissionGrant): PermissionGrant {
  if (grant.kind === 'tenant') return TENANT_GRANT;
  const scopes = RESOURCE_SCOPES.filter((scope): scope is RestrictedScope =>
    scope !== 'tenant' && grant.scopes.has(scope));
  return Object.freeze({ kind: 'restricted', scopes: new FrozenSet(scopes) });
}

/**
 * Construye el mapa efectivo `permission → grant` desde filas
 * `{ permissionCode, resourceScope }` de todos los roles activos.
 *
 *  - valida cada permission code y scope; uno desconocido invalida TODO el
 *    mapa (fail closed, nunca un mapa parcial);
 *  - agrupa por permission y combina con `combinePermissionScopes`
 *    (tenant domina; si no, unión de assigned/quality_control);
 *  - duplicados y orden de entrada no afectan el resultado; el mapa se emite
 *    en el orden canónico de la matriz;
 *  - devuelve un `ReadonlyMap` inmutable en runtime.
 *
 * No recibe ni usa role codes: el grant depende solo de las filas.
 */
export function buildPermissionGrantMap(
  rows: readonly PermissionGrantRowInput[],
): ReadonlyMap<PermissionCode, PermissionGrant> {
  if (!Array.isArray(rows)) throw new AuthzUnknownPermissionError();

  const scopesByPermission = new Map<PermissionCode, ResourceScope[]>();
  for (const row of rows) {
    const permissionCode = parsePermissionCode(row?.permissionCode);
    const resourceScope = parseResourceScope(row?.resourceScope);
    const scopes = scopesByPermission.get(permissionCode);
    if (scopes === undefined) scopesByPermission.set(permissionCode, [resourceScope]);
    else scopes.push(resourceScope);
  }

  const entries: [PermissionCode, PermissionGrant][] = [];
  for (const permissionCode of PERMISSION_CODES) {
    const scopes = scopesByPermission.get(permissionCode);
    if (scopes === undefined) continue;
    const grant = combinePermissionScopes(scopes);
    if (grant !== undefined) entries.push([permissionCode, freezeGrant(grant)]);
  }
  return new FrozenMap(entries);
}

/* -------------------------------------------------------------------------- */
/* Decisión por permiso                                                       */
/* -------------------------------------------------------------------------- */

export type PermissionDecision =
  | { readonly kind: 'denied' }
  | { readonly kind: 'tenant' }
  | { readonly kind: 'resource'; readonly scopes: ReadonlySet<RestrictedScope> };

const DENIED_DECISION: PermissionDecision = Object.freeze({ kind: 'denied' });
const TENANT_DECISION: PermissionDecision = Object.freeze({ kind: 'tenant' });

/**
 * Decisión pura para un permission code:
 *  - sin grant → denied
 *  - grant tenant → tenant
 *  - grant restringido → resource { scopes } (requiere check de recurso)
 *
 * Un code desconocido lanza `AuthzUnknownPermissionError`. Un grant con forma
 * inesperada o con scopes vacíos se trata como denied (fail closed).
 */
export function resolvePermissionDecision(ctx: TenantContext, code: PermissionCode): PermissionDecision {
  const permission = parsePermissionCode(code);
  const grant = ctx.permissions.get(permission);
  if (grant?.kind === 'tenant') return TENANT_DECISION;
  if (grant?.kind === 'restricted' && grant.scopes.size > 0) {
    // Los grants de createTenantContext ya son FrozenSet; se copia si no, para
    // que la decisión nunca exponga una colección mutable.
    const scopes = grant.scopes instanceof FrozenSet ? grant.scopes : new FrozenSet(grant.scopes);
    return Object.freeze({ kind: 'resource', scopes });
  }
  return DENIED_DECISION;
}

/**
 * Exige grant de TENANT para `code`. Un grant restringido NO basta: lanza
 * `PermissionDeniedError` igual que la ausencia de grant.
 */
export function requireTenantPermission(ctx: TenantContext, code: PermissionCode): void {
  if (resolvePermissionDecision(ctx, code).kind !== 'tenant') throw new PermissionDeniedError(code);
}

/* -------------------------------------------------------------------------- */
/* Requisito declarativo de ruta                                              */
/* -------------------------------------------------------------------------- */

/**
 * 'tenant'   → la ruta opera sobre el tenant completo; solo grant tenant pasa.
 * 'resource' → la ruta opera sobre un recurso concreto; grant tenant pasa y
 *              grant restringido pasa condicionado al check de recurso.
 */
export type PermissionScopeRequirement = 'tenant' | 'resource';

export interface PermissionRequirement {
  readonly permission: PermissionCode;
  readonly scope: PermissionScopeRequirement;
}

/**
 * Factory validada para requisitos construidos desde valores dinámicos.
 * `scope` por defecto 'tenant' (estricto).
 */
export function definePermissionRequirement(
  permission: unknown,
  scope: unknown = 'tenant',
): PermissionRequirement {
  const code = parsePermissionCode(permission);
  if (scope !== 'tenant' && scope !== 'resource') throw new AuthzInvalidRequirementError();
  return Object.freeze({ permission: code, scope });
}

export type PermissionRequirementDecision =
  | { readonly kind: 'denied'; readonly permission: PermissionCode }
  | { readonly kind: 'allowed'; readonly permission: PermissionCode }
  | {
      readonly kind: 'resource_check_required';
      readonly permission: PermissionCode;
      readonly scopes: ReadonlySet<RestrictedScope>;
    };

/**
 * Decisión pura de un requisito de ruta:
 *
 * | requirement | grant tenant | grant restringido          | sin grant |
 * |-------------|--------------|----------------------------|-----------|
 * | tenant      | allowed      | denied                     | denied    |
 * | resource    | allowed      | resource_check_required    | denied    |
 */
export function authorizePermissionRequirement(
  ctx: TenantContext,
  requirement: PermissionRequirement,
): PermissionRequirementDecision {
  const scope = requirement?.scope;
  if (scope !== 'tenant' && scope !== 'resource') throw new AuthzInvalidRequirementError();
  const permission = parsePermissionCode(requirement.permission);
  const decision = resolvePermissionDecision(ctx, permission);

  switch (decision.kind) {
    case 'tenant':
      return Object.freeze({ kind: 'allowed', permission });
    case 'resource':
      if (scope === 'resource') {
        return Object.freeze({ kind: 'resource_check_required', permission, scopes: decision.scopes });
      }
      return Object.freeze({ kind: 'denied', permission });
    case 'denied':
      return Object.freeze({ kind: 'denied', permission });
  }
}
