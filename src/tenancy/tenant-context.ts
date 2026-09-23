/**
 * Modelo de TenantContext (S1-02).
 *
 * `tenantId` proviene EXCLUSIVAMENTE de la resolución server-side (membership
 * activa seleccionada); nunca de body/params/query ni de un proveedor externo.
 *
 * `createTenantContext` es la única forma soportada de construirlo: valida lo
 * que entregue la futura capa DB y falla cerrado ante cualquier valor fuera de
 * la matriz RBAC conocida (role, permission o resource scope desconocidos).
 * El resultado es inmutable en runtime: objeto congelado, `roles` y
 * `permissions` son `FrozenSet`/`FrozenMap` (sin add/set/delete/clear) y
 * copias independientes de los arrays de entrada.
 *
 * `roles` es informativo (UI, diagnóstico, /me). La autorización depende solo
 * de `permissions` (ver src/authz/authorize.ts).
 */

import {
  buildPermissionGrantMap,
  parseRoleCode,
  type PermissionGrantRowInput,
} from '../authz/authorize';
import type { PermissionGrant } from '../authz/permission-grants';
import { ROLE_CODES, type PermissionCode, type RoleCode } from '../authz/rbac-matrix';
import { FrozenSet } from '../platform/readonly-collections';
import { parseCanonicalUuid } from './tenant-selection';

export interface TenantContext {
  /** UUID canónico (minúsculas) de `workshops.id`. */
  readonly tenantId: string;
  /** UUID canónico de `users.id`. */
  readonly userId: string;
  /** UUID canónico de `memberships.id`. */
  readonly membershipId: string;
  /** Roles activos de la membership. Informativo: NO usar para autorizar. */
  readonly roles: ReadonlySet<RoleCode>;
  /** Grant efectivo por permission code (unión de roles activos; tenant domina). */
  readonly permissions: ReadonlyMap<PermissionCode, PermissionGrant>;
  readonly requestId: string;
}

/** Datos crudos tal como los entregará la capa DB / request pipeline. */
export interface TenantContextInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly roleCodes: readonly string[];
  readonly permissionRows: readonly PermissionGrantRowInput[];
  readonly requestId: string;
}

export type TenantContextField = 'tenantId' | 'userId' | 'membershipId' | 'roleCodes' | 'requestId';

/** Entrada estructuralmente inválida (UUID malformado, requestId inválido...). */
export class TenantContextInvalidError extends Error {
  readonly code = 'TENANT_CONTEXT_INVALID';
  constructor(readonly field: TenantContextField) {
    super('Tenant context input is invalid.');
    this.name = 'TenantContextInvalidError';
  }
}

// requestId lo genera el servidor (uuidV7); se acepta cualquier token ASCII
// imprimible corto sin espacios para no acoplarse al generador concreto.
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

function requireUuid(value: unknown, field: TenantContextField): string {
  const uuid = parseCanonicalUuid(value);
  if (uuid === undefined) throw new TenantContextInvalidError(field);
  return uuid;
}

function parseRoles(roleCodes: readonly string[]): ReadonlySet<RoleCode> {
  if (!Array.isArray(roleCodes)) throw new TenantContextInvalidError('roleCodes');
  const parsed = new Set<RoleCode>();
  for (const roleCode of roleCodes) parsed.add(parseRoleCode(roleCode));
  // Orden canónico: independiente del orden devuelto por la DB.
  return new FrozenSet(ROLE_CODES.filter((code) => parsed.has(code)));
}

export function createTenantContext(input: TenantContextInput): TenantContext {
  const tenantId = requireUuid(input.tenantId, 'tenantId');
  const userId = requireUuid(input.userId, 'userId');
  const membershipId = requireUuid(input.membershipId, 'membershipId');
  if (typeof input.requestId !== 'string' || !REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new TenantContextInvalidError('requestId');
  }
  const roles = parseRoles(input.roleCodes);
  const permissions = buildPermissionGrantMap(input.permissionRows);

  return Object.freeze({
    tenantId,
    userId,
    membershipId,
    roles,
    permissions,
    requestId: input.requestId,
  });
}
