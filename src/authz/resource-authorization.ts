/**
 * Tripwire de autorización por recurso (S1-02).
 *
 * Bug que evita: ruta con `permissionScope = 'resource'`, usuario con grant
 * restringido (assigned / quality_control), handler que olvida comprobar el
 * assignment/QC → 200 accidental.
 *
 * Máquina de estados por request:
 *
 *   grant tenant       → not_required
 *   grant restringido  → required_pending ──mark(via ∈ scopes)──▶ satisfied
 *
 * `assertResourceAuthorizationComplete` (p.ej. en onSend, fase de
 * integración) lanza `ResourceAuthorizationCheckMissingError` si el estado
 * sigue en required_pending: fail closed.
 *
 * Cada `createResourceAuthorizationState` devuelve un handle nuevo y opaco; el
 * estado vive en un WeakMap privado de este módulo, así que no hay estado
 * compartido entre requests ni forma de fijar `satisfied` sin pasar por
 * `markResourceAuthorizationSatisfied`.
 *
 * Esta fase NO implementa resolvers reales (assignments, service_orders,
 * vehicles, quality_checks): quien los implemente llamará a `mark...` solo
 * tras verificar el recurso concreto.
 */

import { FrozenSet } from '../platform/readonly-collections';
import { PermissionDeniedError, type PermissionDecision } from './authorize';
import type { RestrictedScope } from './permission-grants';
import type { PermissionCode } from './rbac-matrix';

export type ResourceAuthorizationStatus = 'not_required' | 'required_pending' | 'satisfied';

/** Handle opaco e inmutable; el estado mutable no es accesible desde fuera. */
export interface ResourceAuthorizationState {
  readonly permission: PermissionCode;
  /** Scopes restringidos que pueden satisfacer el check (vacío si not_required). */
  readonly grantedScopes: ReadonlySet<RestrictedScope>;
}

export type ResourceAuthorizationErrorCode =
  | 'RESOURCE_AUTHORIZATION_CHECK_MISSING'
  | 'RESOURCE_AUTHORIZATION_STATE_INVALID';

/** El request terminó sin completar el check de recurso exigido. */
export class ResourceAuthorizationCheckMissingError extends Error {
  readonly code: ResourceAuthorizationErrorCode = 'RESOURCE_AUTHORIZATION_CHECK_MISSING';
  constructor(readonly permission: PermissionCode) {
    super('Resource authorization check is missing.');
    this.name = 'ResourceAuthorizationCheckMissingError';
  }
}

/** Uso incorrecto del tripwire (handle desconocido o scope no concedido). */
export class ResourceAuthorizationStateError extends Error {
  readonly code: ResourceAuthorizationErrorCode = 'RESOURCE_AUTHORIZATION_STATE_INVALID';
  constructor() {
    super('Resource authorization state is invalid.');
    this.name = 'ResourceAuthorizationStateError';
  }
}

const statuses = new WeakMap<ResourceAuthorizationState, ResourceAuthorizationStatus>();

/**
 * Crea el estado del tripwire a partir de la decisión del permiso:
 *  - tenant   → not_required
 *  - resource → required_pending
 *  - denied   → lanza `PermissionDeniedError` (un request denegado nunca
 *               debe llegar al handler).
 */
export function createResourceAuthorizationState(
  permission: PermissionCode,
  decision: PermissionDecision,
): ResourceAuthorizationState {
  let status: ResourceAuthorizationStatus;
  let grantedScopes: ReadonlySet<RestrictedScope>;
  switch (decision?.kind) {
    case 'tenant':
      status = 'not_required';
      grantedScopes = new FrozenSet();
      break;
    case 'resource':
      if (decision.scopes.size === 0) throw new PermissionDeniedError(permission);
      status = 'required_pending';
      grantedScopes = new FrozenSet(decision.scopes);
      break;
    default:
      throw new PermissionDeniedError(permission);
  }
  const state: ResourceAuthorizationState = Object.freeze({ permission, grantedScopes });
  statuses.set(state, status);
  return state;
}

function currentStatus(state: ResourceAuthorizationState): ResourceAuthorizationStatus {
  const status = statuses.get(state);
  if (status === undefined) throw new ResourceAuthorizationStateError();
  return status;
}

export function getResourceAuthorizationStatus(state: ResourceAuthorizationState): ResourceAuthorizationStatus {
  return currentStatus(state);
}

/**
 * Registra que el recurso concreto fue verificado vía `via` (p.ej. el
 * assignment existe → 'assigned'; el usuario es QC de la orden →
 * 'quality_control').
 *
 *  - required_pending + via ∈ grantedScopes → satisfied
 *  - required_pending + via ∉ grantedScopes → `ResourceAuthorizationStateError`
 *    (sigue pending: no se puede satisfacer con un scope no concedido)
 *  - satisfied      → sin cambios (idempotente)
 *  - not_required   → sin cambios (el grant tenant ya autoriza)
 */
export function markResourceAuthorizationSatisfied(
  state: ResourceAuthorizationState,
  via: RestrictedScope,
): ResourceAuthorizationStatus {
  const status = currentStatus(state);
  if (status !== 'required_pending') return status;
  if (!state.grantedScopes.has(via)) throw new ResourceAuthorizationStateError();
  statuses.set(state, 'satisfied');
  return 'satisfied';
}

/** Lanza `ResourceAuthorizationCheckMissingError` si el check sigue pendiente. */
export function assertResourceAuthorizationComplete(state: ResourceAuthorizationState): void {
  if (currentStatus(state) === 'required_pending') {
    throw new ResourceAuthorizationCheckMissingError(state.permission);
  }
}
