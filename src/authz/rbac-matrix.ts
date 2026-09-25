/**
 * RBAC_MATRIX_V1 — representación canónica en código de la matriz RBAC.
 *
 * Fuente canónica (no editar sin actualizar la fuente primero):
 *   docs/.../Arquitectura Técnica v1 — TallerMecario/
 *     "RBAC — Matriz completa de roles y permisos v1"
 *
 * Este archivo es la ÚNICA fuente de verdad en código para:
 *   - el catálogo de `permission_codes` (103, Sprint 1);
 *   - los cuatro `role_codes` baseline (owner, admin, service_advisor, technician);
 *   - la celda role×permission: 'tenant' | 'assigned' | 'quality_control' | denegado.
 *
 * `scripts/generate-rbac-seed-sql.cjs` deriva el SQL de seed determinista desde
 * este archivo. `scripts/check-rbac-matrix-doc.cjs` compara este archivo contra
 * el documento canónico. Ningún otro archivo debe declarar permission codes,
 * role codes o resource scopes de forma independiente.
 *
 * No implementa TenantContext, Fastify, ni integración de request pipeline.
 * Ver src/authz/permission-grants.ts para el modelo puro de combinación de
 * scopes que consumirá la fase de integración (S1-02 principal).
 */

/* -------------------------------------------------------------------------- */
/* Resource scopes y roles                                                    */
/* -------------------------------------------------------------------------- */

/** Leyenda de la matriz: ✅ = tenant, A = assigned, Q = quality_control, — = deny. */
export const RESOURCE_SCOPES = ['tenant', 'assigned', 'quality_control'] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

/** Orden canónico de columnas de la matriz (coincide con el documento). */
export const ROLE_CODES = ['owner', 'admin', 'service_advisor', 'technician'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_NAMES_ES: Readonly<Record<RoleCode, string>> = {
  owner: 'Owner',
  admin: 'Administrador',
  service_advisor: 'Asesor de servicio',
  technician: 'Técnico',
};

/** Una celda de la matriz: concede un scope, o deniega. */
export type MatrixCell =
  | { readonly grant: 'tenant' }
  | { readonly grant: 'assigned' }
  | { readonly grant: 'quality_control' }
  | { readonly grant: 'deny' };

/* -------------------------------------------------------------------------- */
/* Datos crudos de la matriz                                                  */
/*                                                                             */
/* Cada fila corresponde 1:1 a una fila del documento canónico. `section` es  */
/* el número de sección del documento (metadato de trazabilidad, no forma     */
/* parte del contrato de tipos). Las marcas siguen la leyenda del documento:  */
/*   T = ✅ (tenant) · A = A (assigned) · Q = Q (quality_control) · D = — (deny) */
/* -------------------------------------------------------------------------- */

type Mark = 'T' | 'A' | 'Q' | 'D';

interface RawRow {
  readonly section: number;
  readonly code: string;
  readonly description: string;
  readonly owner: Mark;
  readonly admin: Mark;
  readonly serviceAdvisor: Mark;
  readonly technician: Mark;
}

const RAW_MATRIX = [
  // 4. Tenant, membresías y administración
  { section: 4, code: 'workshop.read', description: 'Leer datos del taller (tenant).', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 4, code: 'workshop.profile.update', description: 'Actualizar perfil del taller.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'workshop.legal.update', description: 'Actualizar datos legales del taller.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'locations.read', description: 'Leer ubicaciones del taller.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 4, code: 'locations.manage', description: 'Gestionar ubicaciones del taller.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'memberships.read', description: 'Leer memberships del taller.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'memberships.invite_staff', description: 'Invitar personal (membership_invitations).', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'memberships.manage_staff', description: 'Gestionar/revocar memberships de personal.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'roles.assign_staff', description: 'Asignar roles service_advisor/technician.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'roles.assign_admin', description: 'Asignar/revocar rol admin.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'roles.assign_owner', description: 'Asignar/revocar rol owner.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'ownership.transfer', description: 'Transferir propiedad del taller.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },
  { section: 4, code: 'audit.read', description: 'Leer audit_logs del tenant.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },

  // 5. CRM y agenda
  { section: 5, code: 'customers.read', description: 'Leer clientes.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'customers.create', description: 'Crear clientes.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'customers.update', description: 'Actualizar clientes.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'customers.archive', description: 'Archivar clientes.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 5, code: 'vehicles.read', description: 'Leer vehículos.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 5, code: 'vehicles.create', description: 'Crear vehículos.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'vehicles.update', description: 'Actualizar vehículos.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'vehicle_owners.manage', description: 'Gestionar relación vehículo-propietario.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'appointments.read', description: 'Leer citas de agenda.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 5, code: 'appointments.manage', description: 'Gestionar citas de agenda.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },

  // 6. Recepción, firmas y media
  { section: 6, code: 'receptions.read', description: 'Leer recepciones.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 6, code: 'receptions.create', description: 'Crear recepciones.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 6, code: 'receptions.update_open', description: 'Actualizar recepción abierta.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 6, code: 'receptions.close', description: 'Cerrar recepción.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 6, code: 'receptions.reopen', description: 'Reabrir recepción.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 6, code: 'signatures.capture', description: 'Capturar firmas.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 6, code: 'signatures.read', description: 'Leer firmas.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 6, code: 'media.read', description: 'Leer media.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 6, code: 'media.upload', description: 'Subir media.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 6, code: 'media.remove_unattached', description: 'Eliminar media no adjunta.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },

  // 7. Órdenes de trabajo
  { section: 7, code: 'orders.read', description: 'Leer órdenes de trabajo.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 7, code: 'orders.create', description: 'Crear órdenes de trabajo.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'orders.transition', description: 'Transicionar estado de orden.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'orders.assign', description: 'Asignar orden a membership.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'orders.cancel', description: 'Cancelar orden.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'orders.reopen', description: 'Reabrir orden.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 7, code: 'order_items.read', description: 'Leer líneas de orden.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 7, code: 'order_items.adjust_before_completion', description: 'Ajustar líneas antes de finalización.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'warranty.override_before_completion', description: 'Anular garantía antes de finalización.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 7, code: 'warranty.correct_after_completion', description: 'Corregir garantía tras finalización.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },

  // 8. Diagnóstico
  { section: 8, code: 'diagnostics.read', description: 'Leer diagnóstico.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 8, code: 'diagnostics.write', description: 'Escribir diagnóstico.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 8, code: 'diagnostics.close', description: 'Cerrar diagnóstico.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },

  // 9. Catálogo y cotizaciones
  { section: 9, code: 'catalog.read', description: 'Leer catálogo.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 9, code: 'catalog.manage', description: 'Gestionar catálogo.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 9, code: 'inventory.read', description: 'Leer inventario.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 9, code: 'inventory.movements.read', description: 'Leer movimientos de inventario.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 9, code: 'inventory.receive', description: 'Registrar recepción de inventario.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 9, code: 'inventory.adjust', description: 'Ajustar inventario.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 9, code: 'inventory.transfer', description: 'Transferir inventario entre ubicaciones.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 9, code: 'inventory.consume_assigned', description: 'Consumir/retornar repuestos de orden asignada.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 9, code: 'quotes.propose_labor_adjustment', description: 'Proponer cotización supplemental de labor.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 9, code: 'quotes.read', description: 'Leer cotizaciones.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quotes.create', description: 'Crear cotizaciones.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quotes.update_draft', description: 'Actualizar cotización en borrador.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quotes.override_price', description: 'Anular precio de cotización.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quotes.send', description: 'Enviar cotización.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quote_authorizations.read', description: 'Leer autorizaciones de cotización.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 9, code: 'quote_authorizations.record_manual', description: 'Registrar autorización manual/presencial.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },

  // 10. Reparación, actividad técnica y calidad
  { section: 10, code: 'work_activities.read', description: 'Leer actividades de reparación.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 10, code: 'work_activities.manage', description: 'Gestionar actividades de reparación.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 10, code: 'technician_logs.read', description: 'Leer bitácora técnica.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 10, code: 'technician_logs.create', description: 'Crear entrada de bitácora técnica.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'A' },
  { section: 10, code: 'quality_checks.read', description: 'Leer controles de calidad.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 10, code: 'quality_checks.perform', description: 'Ejecutar control de calidad.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'Q' },

  // 11. Entrega y pagos del cliente final
  { section: 11, code: 'deliveries.read', description: 'Leer entregas.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 11, code: 'deliveries.complete', description: 'Completar entrega.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 11, code: 'customer_payments.read', description: 'Leer pagos del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 11, code: 'customer_payments.record', description: 'Registrar pago del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 11, code: 'customer_payments.allocate', description: 'Asignar (allocate) pago del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 11, code: 'customer_payments.reverse', description: 'Reversar pago del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 11, code: 'customer_payment_reconciliation.read', description: 'Leer conciliación de pagos.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 11, code: 'customer_payment_reconciliation.run', description: 'Ejecutar conciliación de pagos.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },

  // 12. Comunicaciones
  { section: 12, code: 'customer_access_tokens.read', description: 'Leer tokens de acceso público del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 12, code: 'customer_access_tokens.create', description: 'Emitir token de acceso público del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 12, code: 'customer_access_tokens.revoke', description: 'Revocar token de acceso público del cliente.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 12, code: 'messages.read', description: 'Leer mensajes.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 12, code: 'messages.send', description: 'Enviar mensajes.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 12, code: 'reminders.manage', description: 'Gestionar recordatorios.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },

  // 13. Privacidad y derechos de titulares
  { section: 13, code: 'privacy_consents.read', description: 'Leer consentimientos de privacidad.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 13, code: 'privacy_consents.capture', description: 'Capturar consentimiento de privacidad.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 13, code: 'data_subject_requests.create', description: 'Crear solicitud de titular de datos.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 13, code: 'data_subject_requests.read', description: 'Leer solicitudes de titular de datos.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 13, code: 'data_subject_requests.resolve', description: 'Resolver solicitud de titular de datos.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 13, code: 'privacy_data.export', description: 'Exportar datos personales.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 13, code: 'privacy_data.anonymize_or_delete', description: 'Anonimizar/eliminar datos personales.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 13, code: 'privacy_incidents.manage', description: 'Gestionar incidentes de privacidad/seguridad.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },

  // 14. Suscripción SaaS y documentos legales
  { section: 14, code: 'subscription.read', description: 'Leer suscripción SaaS.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 14, code: 'subscription.manage', description: 'Gestionar suscripción SaaS.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },
  { section: 14, code: 'legal_acceptances.read', description: 'Leer aceptaciones legales.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 14, code: 'legal_acceptances.accept_for_tenant', description: 'Aceptar documentos legales por el tenant.', owner: 'T', admin: 'D', serviceAdvisor: 'D', technician: 'D' },

  // 15. Dashboard, reportes, notificaciones e integraciones
  { section: 15, code: 'dashboard.operational.read', description: 'Leer dashboard operacional.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'A' },
  { section: 15, code: 'dashboard.business.read', description: 'Leer dashboard comercial/financiero.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 15, code: 'reports.operational.read', description: 'Leer reportes operativos.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'D' },
  { section: 15, code: 'reports.financial.read', description: 'Leer reportes financieros.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 15, code: 'exports.operational.create', description: 'Crear exports operativos.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 15, code: 'notifications.read', description: 'Leer notificaciones propias.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 15, code: 'notifications.preferences.update_self', description: 'Actualizar preferencias propias de notificación.', owner: 'T', admin: 'T', serviceAdvisor: 'T', technician: 'T' },
  { section: 15, code: 'integrations.read', description: 'Leer integraciones del tenant.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
  { section: 15, code: 'integrations.manage', description: 'Gestionar integraciones del tenant.', owner: 'T', admin: 'T', serviceAdvisor: 'D', technician: 'D' },
] as const satisfies readonly RawRow[];

/* -------------------------------------------------------------------------- */
/* Tipos derivados (no duplicar manualmente)                                  */
/* -------------------------------------------------------------------------- */

/** Catálogo de permission codes, derivado de RAW_MATRIX. Orden determinista = orden del documento. */
export type PermissionCode = (typeof RAW_MATRIX)[number]['code'];

export const PERMISSION_CODES: readonly PermissionCode[] = RAW_MATRIX.map((row) => row.code);

function cellFromMark(mark: Mark): MatrixCell {
  switch (mark) {
    case 'T':
      return { grant: 'tenant' };
    case 'A':
      return { grant: 'assigned' };
    case 'Q':
      return { grant: 'quality_control' };
    case 'D':
      return { grant: 'deny' };
  }
}

type MatrixRoleCells = Readonly<Record<RoleCode, MatrixCell>>;

/** RBAC_MATRIX_V1[permissionCode][roleCode] → MatrixCell. Fuente canónica en código. */
export const RBAC_MATRIX_V1: Readonly<Record<PermissionCode, MatrixRoleCells>> = Object.fromEntries(
  RAW_MATRIX.map((row) => [
    row.code,
    {
      owner: cellFromMark(row.owner),
      admin: cellFromMark(row.admin),
      service_advisor: cellFromMark(row.serviceAdvisor),
      technician: cellFromMark(row.technician),
    } satisfies MatrixRoleCells,
  ]),
) as Readonly<Record<PermissionCode, MatrixRoleCells>>;

/** Descripción humana por permission code, derivada de RAW_MATRIX (usada para seed de `permissions`). */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<PermissionCode, string>> = Object.fromEntries(
  RAW_MATRIX.map((row) => [row.code, row.description]),
) as Readonly<Record<PermissionCode, string>>;

/** Sección del documento canónico por permission code (trazabilidad, no forma parte del contrato RBAC). */
export const PERMISSION_DOC_SECTIONS: Readonly<Record<PermissionCode, number>> = Object.fromEntries(
  RAW_MATRIX.map((row) => [row.code, row.section]),
) as Readonly<Record<PermissionCode, number>>;

/* -------------------------------------------------------------------------- */
/* Helpers de consulta                                                        */
/* -------------------------------------------------------------------------- */

/** Devuelve la celda concedida (grant tenant/assigned/quality_control), o undefined si es deny. */
export function grantedCell(permissionCode: PermissionCode, role: RoleCode): MatrixCell | undefined {
  const cell = RBAC_MATRIX_V1[permissionCode][role];
  return cell.grant === 'deny' ? undefined : cell;
}

/** true si la celda role×permission está concedida (cualquier scope). */
export function isGranted(permissionCode: PermissionCode, role: RoleCode): boolean {
  return RBAC_MATRIX_V1[permissionCode][role].grant !== 'deny';
}

/**
 * Todas las filas `role_permissions` implicadas por la matriz (celdas concedidas),
 * en orden determinista: permission code (orden del documento) → role code
 * (orden canónico ROLE_CODES). 290 filas esperadas para RBAC v1.
 */
export interface RolePermissionRow {
  readonly permissionCode: PermissionCode;
  readonly roleCode: RoleCode;
  readonly resourceScope: ResourceScope;
}

export function listRolePermissionRows(): readonly RolePermissionRow[] {
  const rows: RolePermissionRow[] = [];
  for (const permissionCode of PERMISSION_CODES) {
    for (const roleCode of ROLE_CODES) {
      const cell = RBAC_MATRIX_V1[permissionCode][roleCode];
      if (cell.grant === 'deny') continue;
      rows.push({ permissionCode, roleCode, resourceScope: cell.grant });
    }
  }
  return rows;
}
