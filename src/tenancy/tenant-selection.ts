/**
 * Núcleo puro de selección de tenant (S1-02).
 *
 * - `parseTenantSelection` interpreta el valor crudo de `X-Tenant-Id` tal como
 *   lo entregue el boundary HTTP (Fastify: `string | string[] | undefined`).
 * - `selectTenantCandidate` elige la membership activa a usar a partir de las
 *   memberships descubiertas y la selección explícita.
 *
 * Sin Fastify, sin PostgreSQL, sin estado de request. El mapeo HTTP de los
 * errores (400/403/409) se hace en la fase de integración.
 *
 * Política anti-enumeración: una selección explícita que no coincide con una
 * membership activa del usuario produce SIEMPRE `TenantAccessDeniedError`,
 * sin distinguir tenant inexistente / suspendido / membership revocada /
 * tenant de otro usuario. Nunca hay fallback a otra membership.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* UUID                                                                       */
/* -------------------------------------------------------------------------- */

/** Longitud exacta de un UUID en forma textual canónica (8-4-4-4-12). */
export const UUID_TEXT_LENGTH = 36;

// Convención UUID del proyecto: zod `.uuid()` (RFC 9562: versión 1-8 y
// variante 10xx). No acepta `urn:uuid:`, llaves ni forma compacta.
const uuidSchema = z.uuid();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * Valida un UUID textual exacto y devuelve su forma canónica en minúsculas
 * (RFC 9562 §4: entrada case-insensitive, salida en minúsculas; PostgreSQL y
 * `uuidV7()` emiten minúsculas). No hace trim: cualquier espacio lo invalida.
 * Rechaza los sentinelas nil/max, que nunca son IDs generados por la app.
 * Devuelve `undefined` si el valor no es válido.
 */
export function parseCanonicalUuid(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== UUID_TEXT_LENGTH) return undefined;
  if (!uuidSchema.safeParse(value).success) return undefined;
  const canonical = value.toLowerCase();
  if (canonical === NIL_UUID || canonical === MAX_UUID) return undefined;
  return canonical;
}

/* -------------------------------------------------------------------------- */
/* Errores de dominio                                                         */
/* -------------------------------------------------------------------------- */

export type TenantResolutionErrorCode =
  | 'TENANT_SELECTION_INVALID'
  | 'ACTIVE_MEMBERSHIP_REQUIRED'
  | 'TENANT_SELECTION_REQUIRED'
  | 'TENANT_ACCESS_DENIED'
  | 'TENANT_CANDIDATE_INVALID';

/**
 * Base de los errores de resolución de tenant. Solo llevan un `code` estable;
 * nunca el valor recibido ni el tenant solicitado (no filtrar a logs ni
 * permitir inferir existencia de tenants).
 */
export abstract class TenantResolutionError extends Error {
  abstract readonly code: TenantResolutionErrorCode;
}

/** `X-Tenant-Id` presente pero malformado (vacío, espacios, no-UUID, múltiple...). */
export class TenantSelectionInvalidError extends TenantResolutionError {
  readonly code = 'TENANT_SELECTION_INVALID';
  constructor() {
    super('Tenant selection is invalid.');
    this.name = 'TenantSelectionInvalidError';
  }
}

/** Sin selección y el usuario no tiene ninguna membership activa. */
export class ActiveMembershipRequiredError extends TenantResolutionError {
  readonly code = 'ACTIVE_MEMBERSHIP_REQUIRED';
  constructor() {
    super('An active membership is required.');
    this.name = 'ActiveMembershipRequiredError';
  }
}

/** Sin selección y el usuario tiene varias memberships activas. */
export class TenantSelectionRequiredError extends TenantResolutionError {
  readonly code = 'TENANT_SELECTION_REQUIRED';
  constructor() {
    super('A workshop must be selected.');
    this.name = 'TenantSelectionRequiredError';
  }
}

/**
 * Selección explícita sin membership activa coincidente. Único error para
 * todos los casos (inexistente, suspendido, revocado, ajeno): no-enumeración.
 */
export class TenantAccessDeniedError extends TenantResolutionError {
  readonly code = 'TENANT_ACCESS_DENIED';
  constructor() {
    super('Access to the requested workshop is denied.');
    this.name = 'TenantAccessDeniedError';
  }
}

/**
 * Invariante interna rota: la capa DB entregó candidatos malformados o
 * ambiguos (UUID inválido, tenant duplicado). Es un fallo del servidor, no
 * del cliente; se falla cerrado.
 */
export class TenantCandidateInvalidError extends TenantResolutionError {
  readonly code = 'TENANT_CANDIDATE_INVALID';
  constructor() {
    super('Active membership candidates are invalid.');
    this.name = 'TenantCandidateInvalidError';
  }
}

/* -------------------------------------------------------------------------- */
/* Selección                                                                  */
/* -------------------------------------------------------------------------- */

export type TenantSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'explicit'; readonly tenantId: string };

export const NO_TENANT_SELECTION: TenantSelection = Object.freeze({ kind: 'none' });

function explicitSelection(tenantId: string): TenantSelection {
  return Object.freeze({ kind: 'explicit', tenantId });
}

/**
 * Interpreta el valor crudo de `X-Tenant-Id`.
 *
 *  - `undefined` → sin selección (header ausente).
 *  - `null` → sin selección (boundaries tipo WHATWG `Headers.get()` representan
 *    así la ausencia).
 *  - string UUID exacto → selección explícita (canonicalizada a minúsculas).
 *  - `[valor]` (array de un único elemento, p.ej. `headersDistinct`) → igual
 *    que el string.
 *
 * Todo lo demás lanza `TenantSelectionInvalidError`: '' , solo espacios,
 * espacios alrededor, UUID inválido, >36 chars, arrays vacíos o con varios
 * valores (aunque sean idénticos), listas separadas por coma (Node une los
 * headers duplicados con ", ") y tipos no-string. Sin trim silencioso.
 */
export function parseTenantSelection(value: unknown): TenantSelection {
  if (value === undefined || value === null) return NO_TENANT_SELECTION;

  let raw: unknown = value;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TenantSelectionInvalidError();
    raw = value[0];
  }

  if (typeof raw !== 'string' || raw.length > UUID_TEXT_LENGTH) {
    throw new TenantSelectionInvalidError();
  }
  const tenantId = parseCanonicalUuid(raw);
  if (tenantId === undefined) throw new TenantSelectionInvalidError();
  return explicitSelection(tenantId);
}

/* -------------------------------------------------------------------------- */
/* Resolución contra memberships activas                                      */
/* -------------------------------------------------------------------------- */

/** Membership activa descubierta para el usuario autenticado (futura capa DB). */
export interface ActiveMembershipCandidate {
  readonly tenantId: string;
  readonly membershipId: string;
}

function normalizeCandidates(
  memberships: readonly ActiveMembershipCandidate[],
): readonly ActiveMembershipCandidate[] {
  if (!Array.isArray(memberships)) throw new TenantCandidateInvalidError();
  const seenTenants = new Set<string>();
  const normalized: ActiveMembershipCandidate[] = [];
  for (const candidate of memberships) {
    const tenantId = parseCanonicalUuid(candidate?.tenantId);
    const membershipId = parseCanonicalUuid(candidate?.membershipId);
    if (tenantId === undefined || membershipId === undefined) throw new TenantCandidateInvalidError();
    // Un usuario tiene como máximo una membership activa por tenant; si la DB
    // devuelve dos, la selección sería ambigua → fallar cerrado.
    if (seenTenants.has(tenantId)) throw new TenantCandidateInvalidError();
    seenTenants.add(tenantId);
    normalized.push(Object.freeze({ tenantId, membershipId }));
  }
  return normalized;
}

function explicitTenantId(selection: TenantSelection): string | undefined {
  if (selection?.kind === 'none') return undefined;
  if (selection?.kind === 'explicit') {
    const tenantId = parseCanonicalUuid(selection.tenantId);
    if (tenantId !== undefined) return tenantId;
  }
  throw new TenantSelectionInvalidError();
}

/**
 * Elige la membership activa a usar.
 *
 * Con selección explícita (cualquier número de memberships): coincidencia
 * exacta de `tenantId` o `TenantAccessDeniedError`. Nunca fallback.
 *
 * Sin selección:
 *  - 0 memberships → `ActiveMembershipRequiredError`
 *  - 1 membership  → esa membership
 *  - N memberships → `TenantSelectionRequiredError`
 *
 * Devuelve una copia congelada con IDs canónicos.
 */
export function selectTenantCandidate(
  memberships: readonly ActiveMembershipCandidate[],
  selection: TenantSelection,
): ActiveMembershipCandidate {
  const candidates = normalizeCandidates(memberships);
  const requestedTenantId = explicitTenantId(selection);

  if (requestedTenantId !== undefined) {
    const match = candidates.find((candidate) => candidate.tenantId === requestedTenantId);
    if (match === undefined) throw new TenantAccessDeniedError();
    return match;
  }

  if (candidates.length === 0) throw new ActiveMembershipRequiredError();
  if (candidates.length > 1) throw new TenantSelectionRequiredError();
  return candidates[0];
}
