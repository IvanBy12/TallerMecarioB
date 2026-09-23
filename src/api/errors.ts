import { AuthzError } from '../authz/authorize.js';
import {
  ResourceAuthorizationCheckMissingError,
  ResourceAuthorizationStateError,
} from '../authz/resource-authorization.js';
import { TenantContextInvalidError } from '../tenancy/tenant-context.js';
import { TenantContextDbError } from '../tenancy/tenant-context-db.js';
import { TenantResolutionError } from '../tenancy/tenant-selection.js';

/** Stable application error (Arquitectura Técnica v1 §13: code + request_id + safe message). */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
  }
}

const INTERNAL_ERROR_MESSAGE = 'The request could not be completed.';

/**
 * Tenant-resolution and authorization outcomes the client may act on. Every
 * other core error is an internal invariant/data failure (see below).
 *
 * TENANT_ACCESS_DENIED has ONE fixed body for every cause (nonexistent tenant,
 * foreign or inactive membership, forged id, TOCTOU revocation): no oracle.
 */
const CLIENT_ERRORS: Readonly<Record<string, { readonly statusCode: number; readonly message: string }>> = {
  TENANT_SELECTION_INVALID: { statusCode: 400, message: 'The X-Tenant-Id header is invalid.' },
  ACTIVE_MEMBERSHIP_REQUIRED: { statusCode: 403, message: 'An active membership is required.' },
  TENANT_SELECTION_REQUIRED: { statusCode: 409, message: 'A workshop must be selected.' },
  TENANT_ACCESS_DENIED: { statusCode: 403, message: 'Access to the requested workshop is denied.' },
  PERMISSION_DENIED: { statusCode: 403, message: 'Permission denied.' },
};

function internalError(): ApiError {
  return new ApiError(500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
}

/**
 * Central HTTP mapping for the S1-02 TenantContext/RBAC core. Returns null for
 * errors it does not own.
 *
 * Internal failures — TENANT_CANDIDATE_INVALID, TENANT_CONTEXT_INVALID,
 * AUTHZ_UNKNOWN_PERMISSION / _ROLE / _RESOURCE_SCOPE, AUTHZ_INVALID_REQUIREMENT,
 * RESOURCE_AUTHORIZATION_STATE_INVALID and every TenantContextDbError — become
 * a sanitized 500 INTERNAL_ERROR: they mean bad DB data or a server bug, never
 * a missing user permission, and their details stay server-side.
 *
 * RESOURCE_AUTHORIZATION_CHECK_MISSING keeps its own code (still 500, generic
 * message): a resource-scoped handler finished without recording its resource
 * check, which is a server bug the tripwire turned into a failure.
 */
export function mapDomainError(error: unknown): ApiError | null {
  if (error instanceof ResourceAuthorizationCheckMissingError) {
    return new ApiError(500, 'RESOURCE_AUTHORIZATION_CHECK_MISSING', INTERNAL_ERROR_MESSAGE);
  }
  if (error instanceof TenantResolutionError || error instanceof AuthzError) {
    const external = CLIENT_ERRORS[error.code];
    return external ? new ApiError(external.statusCode, error.code, external.message) : internalError();
  }
  if (error instanceof TenantContextInvalidError
    || error instanceof TenantContextDbError
    || error instanceof ResourceAuthorizationStateError) {
    return internalError();
  }
  return null;
}
