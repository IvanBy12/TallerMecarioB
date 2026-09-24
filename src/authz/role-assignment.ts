/**
 * Permission that authorizes assigning OR removing each baseline role
 * (RBAC v1 §4 + §16): only owner holds roles.assign_owner / roles.assign_admin;
 * roles.assign_staff covers service_advisor and technician only.
 *
 * Shared by membership invitations (S1-04: the invited role) and member role
 * management (S1-05: the role being assigned or removed). Pure data over the
 * canonical codes of ./rbac-matrix.ts; no role name is ever used as an
 * authorization shortcut — callers check these permission codes.
 */

import type { PermissionCode, RoleCode } from './rbac-matrix.js';

export const ROLE_ASSIGNMENT_PERMISSION: Readonly<Record<RoleCode, PermissionCode>> = Object.freeze({
  owner: 'roles.assign_owner',
  admin: 'roles.assign_admin',
  service_advisor: 'roles.assign_staff',
  technician: 'roles.assign_staff',
});
