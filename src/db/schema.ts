/**
 * TallerMecario — schema.ts (baseline v1)
 *
 * Fuente canónica: exportación local en /docs.
 *   - Modelo de Datos / ERD v1 — PostgreSQL
 *   - Diccionario de Datos v1 — PostgreSQL (páginas 01..05)
 *
 * Motor objetivo: PostgreSQL 18.x. El inventario se deriva de los documentos.
 *
 * Convenciones del diccionario aplicadas aquí:
 *   - PK `uuid NOT NULL` generado por aplicación (UUIDv7). No hay `serial` como autoridad.
 *   - Toda tabla tenant-owned lleva `tenant_id uuid NOT NULL` + `UNIQUE(tenant_id,id)`
 *     cuando necesita ser padre de una FK compuesta.
 *   - Fechas `timestamptz` en UTC. Dinero `bigint` en unidad mínima + `currency char(3)`.
 *   - Cantidades `numeric(14,4)`; tasas `numeric(7,4)` en puntos porcentuales (0..100).
 *   - Estados cerrados: `varchar` + CHECK explícito (no enums nativos de PostgreSQL).
 *   - FKs tenant-owned usan `(tenant_id, fk_id)` con índice equivalente en la hija.
 *
 * Protecciones pendientes de migración SQL (no implementadas en este archivo):
 *   - RLS (ENABLE + FORCE), policies y roles runtime NOBYPASSRLS — ADR-009.
 *   - REVOKE UPDATE/DELETE/TRUNCATE + triggers defensivos sobre tablas append-only.
 *   - Constraint trigger diferido: ubicación principal "exactamente una".
 *   - Integridad entre filas: separación QC/técnico, SUM(allocations) <= payment.amount,
 *     coherencia stock/ledger y transferencias,
 *     `partially_approved` exige una línea aprobada y una rechazada/ajustada.
 * Estas protecciones requieren migraciones SQL; este archivo no las implementa.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** PK uuid estándar. Se genera en aplicación (UUIDv7), no en la base. */
const pk = () => uuid('id').primaryKey().notNull();

/** `tenant_id` de una tabla tenant-owned. */
const tenantId = () => uuid('tenant_id').notNull().references(() => workshops.id);

/** `tenant_id` opcional: tablas mixed-scope / globales (plataforma, privacidad). */
const tenantIdNullable = () => uuid('tenant_id').references(() => workshops.id);

/** timestamptz UTC. */
const ts = (name: string) => timestamp(name, { withTimezone: true });

const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

/** Dinero: unidad monetaria mínima. `mode: 'bigint'` evita cualquier paso por float. */
const money = (name: string) => bigint(name, { mode: 'bigint' });

/** Moneda ISO-4217. */
const currency = (name = 'currency') => char(name, { length: 3 }).notNull().default('COP');

/** Cantidad real. Se lee/escribe como string para no perder precisión decimal. */
const qty = (name: string) => numeric(name, { precision: 14, scale: 4 });

/** Tasa porcentual en puntos (19.0000 = 19%). */
const rate = (name: string) => numeric(name, { precision: 7, scale: 4 });

/** CHECK de conjunto cerrado: `"col" IN ('a','b',...)`. */
const enumCheck = (name: string, col: { name: string }, values: readonly string[]) =>
  check(name, sql.raw(`"${col.name}" IN (${values.map((v) => `'${v}'`).join(', ')})`));

/** CHECK arbitrario expresado en SQL literal. */
const rawCheck = (name: string, expr: string) => check(name, sql.raw(expr));

/* -------------------------------------------------------------------------- */
/* Conjuntos de valores reutilizados                                          */
/* -------------------------------------------------------------------------- */

export const SERVICE_ORDER_STATUSES = [
  'reception',
  'diagnosis',
  'quote_pending',
  'approved',
  'partially_approved',
  'rejected',
  'in_progress',
  'quality_control',
  'ready_for_delivery',
  'delivered',
  'cancelled',
] as const;

export const ITEM_TYPES = ['service', 'labor', 'part', 'other'] as const;
export const WARRANTY_UNITS = ['day', 'month', 'year'] as const;
export const MEDIA_TYPES = [
  'photo',
  'video360',
  'video',
  'signature',
  'quote_pdf',
  'document',
] as const;

/* ========================================================================== */
/* 1. Catálogos globales: RBAC y planes                                       */
/* ========================================================================== */

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    scope: varchar('scope', { length: 16 }).notNull().default('tenant'),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('roles_code_key').on(t.code),
    enumCheck('roles_code_check', t.code, ['owner', 'admin', 'service_advisor', 'technician']),
    enumCheck('roles_scope_check', t.scope, ['tenant']),
  ],
);

export const permissions = pgTable(
  'permissions',
  {
    id: pk(),
    code: varchar('code', { length: 120 }).notNull(),
    description: text('description').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('permissions_code_key').on(t.code)],
);

/** Semilla idempotente desde la matriz RBAC aprobada. Read-only en runtime. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id),
    permissionId: uuid('permission_id').notNull().references(() => permissions.id),
    /** Scope de la celda role×permission. Ver RBAC_MATRIX_V1 (src/authz/rbac-matrix.ts). */
    resourceScope: varchar('resource_scope', { length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionId] }),
    enumCheck('role_permissions_resource_scope_check', t.resourceScope, [
      'tenant',
      'assigned',
      'quality_control',
    ]),
  ],
);

/** Planes SaaS. Tabla global sin `tenant_id`; read-only para el runtime de tenant. */
export const plans = pgTable(
  'plans',
  {
    id: pk(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    billingPeriod: varchar('billing_period', { length: 16 }).notNull(),
    priceAmount: money('price_amount').notNull(),
    currency: currency(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('plans_code_key').on(t.code),
    enumCheck('plans_billing_period_check', t.billingPeriod, ['monthly', 'yearly']),
    rawCheck('plans_price_amount_check', '"price_amount" >= 0'),
  ],
);

/* ========================================================================== */
/* 2. Tenancy e identidad                                                     */
/* ========================================================================== */

/** El tenant. `workshops.id` ES el `tenant_id` del resto del modelo. */
export const workshops = pgTable(
  'workshops',
  {
    id: pk(),
    slug: varchar('slug', { length: 80 }).notNull(),
    legalName: varchar('legal_name', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    taxId: varchar('tax_id', { length: 40 }),
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 320 }),
    timezone: varchar('timezone', { length: 64 }).notNull().default('America/Bogota'),
    currency: currency(),
    status: varchar('status', { length: 16 }).notNull().default('trialing'),
    ...timestamps(),
  },
  (t) => [
    unique('workshops_slug_key').on(t.slug),
    enumCheck('workshops_status_check', t.status, [
      'trialing',
      'active',
      'suspended',
      'cancelled',
    ]),
    rawCheck(
      'workshops_currency_check',
      `"currency" = upper("currency") AND char_length("currency") = 3`,
    ),
  ],
);

/**
 * Invariante: cada workshop conserva EXACTAMENTE una ubicación principal.
 * El partial unique de abajo impide dos; el "al menos una" exige un constraint
 * trigger diferido al COMMIT que se añade en la migración SQL.
 */
export const workshopLocations = pgTable(
  'workshop_locations',
  {
    id: pk(),
    tenantId: tenantId(),
    name: varchar('name', { length: 160 }).notNull(),
    addressLine: text('address_line').notNull(),
    city: varchar('city', { length: 120 }).notNull(),
    department: varchar('department', { length: 120 }).notNull(),
    countryCode: char('country_code', { length: 2 }).notNull().default('CO'),
    phone: varchar('phone', { length: 32 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('workshop_locations_tenant_id_key').on(t.tenantId, t.id),
    index('workshop_locations_tenant_idx').on(t.tenantId),
    uniqueIndex('workshop_locations_one_primary_uq')
      .on(t.tenantId)
      .where(sql`is_primary = true`),
  ],
);

/** Usuario global de plataforma. La pertenencia a un taller la define `memberships`. */
export const users = pgTable(
  'users',
  {
    id: pk(),
    identityProvider: varchar('identity_provider', { length: 32 }).notNull().default('clerk'),
    externalSubject: varchar('external_subject', { length: 255 }).notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    fullName: varchar('full_name', { length: 200 }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    unique('users_identity_key').on(t.identityProvider, t.externalSubject),
    enumCheck('users_status_check', t.status, ['active', 'disabled']),
  ],
);

/**
 * S1-03 — estado técnico de sincronización de identidad por sujeto externo
 * (global, sin tenant_id). Guarda solo la posición del último evento del
 * proveedor aplicado (monotonicidad), el ciclo de vida local derivado y el
 * tombstone; nunca el perfil ni el payload del proveedor. Sin grants runtime:
 * solo funciones SECURITY DEFINER allowlisted (migración 0007).
 */
export const identitySyncStates = pgTable(
  'identity_sync_states',
  {
    id: pk(),
    identityProvider: varchar('identity_provider', { length: 32 }).notNull(),
    externalSubject: varchar('external_subject', { length: 255 }).notNull(),
    userId: uuid('user_id').references(() => users.id),
    lifecycleState: varchar('lifecycle_state', { length: 16 }).notNull().default('active'),
    lastEventId: varchar('last_event_id', { length: 128 }).notNull(),
    lastEventType: varchar('last_event_type', { length: 64 }).notNull(),
    lastEventOccurredAt: ts('last_event_occurred_at').notNull(),
    lastEventRank: smallint('last_event_rank').notNull(),
    deletedAt: ts('deleted_at'),
    ...timestamps(),
  },
  (t) => [
    unique('identity_sync_states_identity_key').on(t.identityProvider, t.externalSubject),
    index('identity_sync_states_user_idx').on(t.userId),
    enumCheck('identity_sync_states_provider_check', t.identityProvider, ['clerk']),
    enumCheck('identity_sync_states_lifecycle_check', t.lifecycleState, ['active', 'blocked', 'deleted']),
    rawCheck('identity_sync_states_rank_check', 'last_event_rank IN (0, 1)'),
    rawCheck(
      'identity_sync_states_tombstone_check',
      "(lifecycle_state = 'deleted') = (deleted_at IS NOT NULL)",
    ),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull().references(() => users.id),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    suspendedAt: ts('suspended_at'),
    revokedAt: ts('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    unique('memberships_tenant_id_key').on(t.tenantId, t.id),
    unique('memberships_tenant_user_key').on(t.tenantId, t.userId),
    enumCheck('memberships_status_check', t.status, ['active', 'suspended', 'revoked']),
    rawCheck(
      'memberships_status_coherence_check',
      `("status" <> 'active' OR "revoked_at" IS NULL)
       AND ("status" <> 'suspended' OR "suspended_at" IS NOT NULL)
       AND ("status" <> 'revoked' OR "revoked_at" IS NOT NULL)`,
    ),
  ],
);

/**
 * Asignación de rol. No se hace UPDATE del rol: se inserta/elimina la fila mediante
 * comando autorizado + auditoría. El guard de "último owner" es transaccional.
 */
export const membershipRoles = pgTable(
  'membership_roles',
  {
    tenantId: tenantId(),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull().references(() => roles.id),
    assignedByMembershipId: uuid('assigned_by_membership_id').notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'membership_roles_pk', columns: [t.tenantId, t.membershipId, t.roleId] }),
    foreignKey({
      name: 'membership_roles_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'membership_roles_assigned_by_fk',
      columns: [t.tenantId, t.assignedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('membership_roles_assigned_by_idx').on(t.tenantId, t.assignedByMembershipId),
  ],
);

/**
 * Invitación de un único usuario interno. El token crudo nunca se persiste.
 * La seguridad SIEMPRE compara `expires_at`, aunque el cleanup no haya
 * materializado todavía `expired`.
 */
export const membershipInvitations = pgTable(
  'membership_invitations',
  {
    id: pk(),
    tenantId: tenantId(),
    email: varchar('email', { length: 320 }).notNull(),
    emailNormalized: varchar('email_normalized', { length: 320 }).notNull(),
    targetRoleId: uuid('target_role_id').notNull().references(() => roles.id),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    acceptedAt: ts('accepted_at'),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    acceptedMembershipId: uuid('accepted_membership_id'),
    invitedByMembershipId: uuid('invited_by_membership_id').notNull(),
    revokedAt: ts('revoked_at'),
    revokedByMembershipId: uuid('revoked_by_membership_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('mi_tenant_id_key').on(t.tenantId, t.id),
    unique('mi_token_hash_key').on(t.tokenHash),
    enumCheck('mi_status_check', t.status, ['pending', 'accepted', 'expired', 'revoked']),
    foreignKey({
      name: 'mi_invited_by_fk',
      columns: [t.tenantId, t.invitedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'mi_accepted_membership_fk',
      columns: [t.tenantId, t.acceptedMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('mi_accepted_membership_idx').on(t.tenantId, t.acceptedMembershipId),
    foreignKey({
      name: 'mi_revoked_by_fk',
      columns: [t.tenantId, t.revokedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('mi_revoked_by_idx').on(t.tenantId, t.revokedByMembershipId),
    index('mi_tenant_status_expires_idx').on(t.tenantId, t.status, t.expiresAt),
    index('mi_tenant_email_idx').on(t.tenantId, t.emailNormalized),
    index('mi_invited_by_idx').on(t.tenantId, t.invitedByMembershipId),
    uniqueIndex('mi_one_pending_per_email_uq')
      .on(t.tenantId, t.emailNormalized)
      .where(sql`status = 'pending'`),
  ],
);

/* ========================================================================== */
/* 3. CRM: clientes y vehículos                                               */
/* ========================================================================== */

/**
 * `whatsapp_opt_in` NO existe por decisión canónica: la autorización por finalidad
 * vive en `privacy_consents`, versionada y evidenciable.
 */
export const customers = pgTable(
  'customers',
  {
    id: pk(),
    tenantId: tenantId(),
    documentType: varchar('document_type', { length: 24 }),
    documentNumber: varchar('document_number', { length: 40 }),
    firstName: varchar('first_name', { length: 120 }).notNull(),
    lastName: varchar('last_name', { length: 120 }).notNull(),
    phone: varchar('phone', { length: 32 }).notNull(),
    email: varchar('email', { length: 320 }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    unique('customers_tenant_id_key').on(t.tenantId, t.id),
    index('customers_tenant_phone_idx').on(t.tenantId, t.phone),
    index('customers_tenant_document_idx').on(t.tenantId, t.documentNumber),
  ],
);

/** La placa es única POR TENANT, nunca global: dos talleres pueden atender el mismo vehículo. */
export const vehicles = pgTable(
  'vehicles',
  {
    id: pk(),
    tenantId: tenantId(),
    plate: varchar('plate', { length: 16 }).notNull(),
    vin: varchar('vin', { length: 32 }),
    vehicleType: varchar('vehicle_type', { length: 24 }).notNull(),
    brand: varchar('brand', { length: 80 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    modelYear: smallint('model_year'),
    color: varchar('color', { length: 60 }),
    engineNumber: varchar('engine_number', { length: 80 }),
    currentMileageKm: integer('current_mileage_km'),
    ...timestamps(),
  },
  (t) => [
    unique('vehicles_tenant_id_key').on(t.tenantId, t.id),
    unique('vehicles_tenant_plate_key').on(t.tenantId, t.plate),
    enumCheck('vehicles_type_check', t.vehicleType, ['car', 'motorcycle', 'other']),
    rawCheck('vehicles_model_year_check', '"model_year" BETWEEN 1886 AND 2200'),
    rawCheck('vehicles_mileage_check', '"current_mileage_km" >= 0'),
  ],
);

/** Historial de propiedad: permite cambiar de dueño sin destruir la historia. */
export const vehicleOwners = pgTable(
  'vehicle_owners',
  {
    id: pk(),
    tenantId: tenantId(),
    vehicleId: uuid('vehicle_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    relationshipType: varchar('relationship_type', { length: 24 }).notNull().default('owner'),
    isPrimary: boolean('is_primary').notNull().default(true),
    validFrom: ts('valid_from').notNull().defaultNow(),
    validTo: ts('valid_to'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('vehicle_owners_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'vehicle_owners_vehicle_fk',
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [vehicles.tenantId, vehicles.id],
    }),
    foreignKey({
      name: 'vehicle_owners_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    enumCheck('vehicle_owners_relationship_check', t.relationshipType, [
      'owner',
      'authorized_driver',
      'company_contact',
      'other',
    ]),
    rawCheck('vehicle_owners_validity_check', '"valid_to" IS NULL OR "valid_to" > "valid_from"'),
    index('vehicle_owners_vehicle_idx').on(t.tenantId, t.vehicleId, t.validTo),
    index('vehicle_owners_customer_idx').on(t.tenantId, t.customerId),
    uniqueIndex('vehicle_owners_one_primary_uq')
      .on(t.tenantId, t.vehicleId)
      .where(sql`is_primary = true AND valid_to IS NULL`),
  ],
);

/* ========================================================================== */
/* 4. Agenda                                                                  */
/* ========================================================================== */

export const appointments = pgTable(
  'appointments',
  {
    id: pk(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    vehicleId: uuid('vehicle_id'),
    locationId: uuid('location_id'),
    scheduledStart: ts('scheduled_start').notNull(),
    scheduledEnd: ts('scheduled_end').notNull(),
    reason: text('reason').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('scheduled'),
    source: varchar('source', { length: 24 }).notNull().default('staff'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
  },
  (t) => [
    unique('appointments_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'appointments_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'appointments_vehicle_fk',
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [vehicles.tenantId, vehicles.id],
    }),
    foreignKey({
      name: 'appointments_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [workshopLocations.tenantId, workshopLocations.id],
    }),
    foreignKey({
      name: 'appointments_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('appointments_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    enumCheck('appointments_status_check', t.status, [
      'scheduled',
      'confirmed',
      'arrived',
      'cancelled',
      'no_show',
      'completed',
    ]),
    enumCheck('appointments_source_check', t.source, ['staff', 'customer', 'import', 'other']),
    rawCheck('appointments_window_check', '"scheduled_end" > "scheduled_start"'),
    index('appointments_tenant_start_idx').on(t.tenantId, t.scheduledStart),
    index('appointments_customer_idx').on(t.tenantId, t.customerId),
    index('appointments_vehicle_idx').on(t.tenantId, t.vehicleId),
    index('appointments_location_idx').on(t.tenantId, t.locationId),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: pk(),
    tenantId: tenantId(),
    appointmentId: uuid('appointment_id'),
    customerId: uuid('customer_id').notNull(),
    channel: varchar('channel', { length: 16 }).notNull(),
    scheduledFor: ts('scheduled_for').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('reminders_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'reminders_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    foreignKey({
      name: 'reminders_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    enumCheck('reminders_channel_check', t.channel, ['whatsapp', 'email', 'sms', 'other']),
    enumCheck('reminders_status_check', t.status, [
      'pending',
      'queued',
      'sent',
      'failed',
      'cancelled',
    ]),
    index('reminders_appointment_idx').on(t.tenantId, t.appointmentId),
    index('reminders_customer_idx').on(t.tenantId, t.customerId),
  ],
);

/* ========================================================================== */
/* 5. Archivos (metadata; el binario vive en Cloudflare R2)                   */
/* ========================================================================== */

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: pk(),
    tenantId: tenantId(),
    storageProvider: varchar('storage_provider', { length: 24 })
      .notNull()
      .default('cloudflare_r2'),
    bucket: varchar('bucket', { length: 120 }).notNull(),
    objectKey: varchar('object_key', { length: 512 }).notNull(),
    mediaType: varchar('media_type', { length: 24 }).notNull(),
    mimeType: varchar('mime_type', { length: 160 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    checksumSha256: char('checksum_sha256', { length: 64 }),
    status: varchar('status', { length: 24 }).notNull().default('pending_upload'),
    retentionClass: varchar('retention_class', { length: 32 }).notNull(),
    retentionUntil: ts('retention_until'),
    retentionPolicyVersion: varchar('retention_policy_version', { length: 32 }).notNull(),
    legalHoldUntil: ts('legal_hold_until'),
    deletionRequestedAt: ts('deletion_requested_at'),
    deletedAt: ts('deleted_at'),
    purgedAt: ts('purged_at'),
    deleteReason: varchar('delete_reason', { length: 160 }),
    capturedAt: ts('captured_at'),
    uploadedAt: ts('uploaded_at'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
  },
  (t) => [
    unique('media_assets_tenant_id_key').on(t.tenantId, t.id),
    unique('media_assets_object_key').on(t.storageProvider, t.bucket, t.objectKey),
    foreignKey({
      name: 'media_assets_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('media_assets_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    enumCheck('media_assets_media_type_check', t.mediaType, MEDIA_TYPES),
    enumCheck('media_assets_status_check', t.status, [
      'pending_upload',
      'uploaded',
      'active',
      'quarantined',
      'deleted',
    ]),
    enumCheck('media_assets_retention_class_check', t.retentionClass, [
      'ephemeral_upload',
      'operational',
      'warranty_evidence',
      'authorization_evidence',
      'delivery_evidence',
      'document',
    ]),
    rawCheck('media_assets_size_check', '"size_bytes" >= 0'),
    // `deleted_at` precede siempre a `purged_at`.
    rawCheck(
      'media_assets_purge_order_check',
      '"purged_at" IS NULL OR ("deleted_at" IS NOT NULL AND "purged_at" >= "deleted_at")',
    ),
    index('media_assets_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
  ],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: pk(),
    tenantId: tenantId(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    completedAt: ts('completed_at'),
    createdByMembershipId: uuid('created_by_membership_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('upload_sessions_tenant_id_key').on(t.tenantId, t.id),
    unique('upload_sessions_idempotency_key').on(t.tenantId, t.idempotencyKey),
    foreignKey({
      name: 'upload_sessions_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    foreignKey({
      name: 'upload_sessions_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('upload_sessions_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    enumCheck('upload_sessions_status_check', t.status, [
      'pending',
      'completed',
      'expired',
      'failed',
    ]),
    rawCheck(
      'upload_sessions_completed_check',
      `"status" <> 'completed' OR "completed_at" IS NOT NULL`,
    ),
    index('upload_sessions_media_idx').on(t.tenantId, t.mediaAssetId),
  ],
);

/* ========================================================================== */
/* 6. Recepción                                                               */
/* ========================================================================== */

/**
 * `UNIQUE(tenant_id, id, vehicle_id, customer_id)` existe para que `service_orders`
 * pruebe por FK que recepción, vehículo y cliente coinciden.
 */
export const receptions = pgTable(
  'receptions',
  {
    id: pk(),
    tenantId: tenantId(),
    vehicleId: uuid('vehicle_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    appointmentId: uuid('appointment_id'),
    locationId: uuid('location_id'),
    receivedByMembershipId: uuid('received_by_membership_id').notNull(),
    mileageKm: integer('mileage_km').notNull(),
    fuelLevelPct: smallint('fuel_level_pct'),
    customerNotes: text('customer_notes'),
    advisorNotes: text('advisor_notes'),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    closedAt: ts('closed_at'),
    ...timestamps(),
  },
  (t) => [
    unique('receptions_tenant_id_key').on(t.tenantId, t.id),
    unique('receptions_lineage_key').on(t.tenantId, t.id, t.vehicleId, t.customerId),
    foreignKey({
      name: 'receptions_vehicle_fk',
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [vehicles.tenantId, vehicles.id],
    }),
    foreignKey({
      name: 'receptions_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'receptions_appointment_fk',
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    foreignKey({
      name: 'receptions_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [workshopLocations.tenantId, workshopLocations.id],
    }),
    foreignKey({
      name: 'receptions_received_by_fk',
      columns: [t.tenantId, t.receivedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('receptions_status_check', t.status, ['open', 'closed', 'cancelled']),
    rawCheck('receptions_mileage_check', '"mileage_km" >= 0'),
    rawCheck('receptions_fuel_check', '"fuel_level_pct" BETWEEN 0 AND 100'),
    rawCheck(
      'receptions_closed_at_check',
      `("status" = 'open' AND "closed_at" IS NULL)
       OR ("status" IN ('closed','cancelled') AND "closed_at" IS NOT NULL)`,
    ),
    index('receptions_vehicle_received_idx').on(
      t.tenantId,
      t.vehicleId,
      t.receivedAt.desc(),
    ),
    index('receptions_customer_idx').on(t.tenantId, t.customerId),
    index('receptions_appointment_idx').on(t.tenantId, t.appointmentId),
    index('receptions_location_idx').on(t.tenantId, t.locationId),
    index('receptions_received_by_idx').on(t.tenantId, t.receivedByMembershipId),
  ],
);

export const receptionCheckItems = pgTable(
  'reception_check_items',
  {
    id: pk(),
    tenantId: tenantId(),
    receptionId: uuid('reception_id').notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    label: varchar('label', { length: 160 }).notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('rci_tenant_id_key').on(t.tenantId, t.id),
    unique('rci_reception_code_key').on(t.tenantId, t.receptionId, t.code),
    foreignKey({
      name: 'rci_reception_fk',
      columns: [t.tenantId, t.receptionId],
      foreignColumns: [receptions.tenantId, receptions.id],
    }),
    enumCheck('rci_status_check', t.status, ['ok', 'issue', 'not_checked', 'not_applicable']),
  ],
);

export const vehicleDamages = pgTable(
  'vehicle_damages',
  {
    id: pk(),
    tenantId: tenantId(),
    receptionId: uuid('reception_id').notNull(),
    zoneCode: varchar('zone_code', { length: 64 }).notNull(),
    damageType: varchar('damage_type', { length: 64 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('minor'),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('vehicle_damages_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'vehicle_damages_reception_fk',
      columns: [t.tenantId, t.receptionId],
      foreignColumns: [receptions.tenantId, receptions.id],
    }),
    enumCheck('vehicle_damages_severity_check', t.severity, ['minor', 'moderate', 'severe']),
    index('vehicle_damages_reception_idx').on(t.tenantId, t.receptionId),
  ],
);

/* ========================================================================== */
/* 7. Órdenes de trabajo                                                      */
/* ========================================================================== */

/**
 * FK de linaje `(tenant_id, reception_id, vehicle_id, customer_id)` ->
 * `receptions(tenant_id, id, vehicle_id, customer_id)`: una orden no puede cambiar
 * de vehículo o cliente respecto de su recepción.
 */
export const serviceOrders = pgTable(
  'service_orders',
  {
    id: pk(),
    tenantId: tenantId(),
    receptionId: uuid('reception_id').notNull(),
    vehicleId: uuid('vehicle_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    orderNumber: bigint('order_number', { mode: 'bigint' }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('reception'),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    openedAt: ts('opened_at').notNull().defaultNow(),
    promisedAt: ts('promised_at'),
    closedAt: ts('closed_at'),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique('service_orders_tenant_id_key').on(t.tenantId, t.id),
    unique('service_orders_lineage_key').on(t.tenantId, t.id, t.vehicleId, t.customerId),
    unique('service_orders_reception_key').on(t.tenantId, t.receptionId),
    unique('service_orders_number_key').on(t.tenantId, t.orderNumber),
    foreignKey({
      name: 'service_orders_reception_lineage_fk',
      columns: [t.tenantId, t.receptionId, t.vehicleId, t.customerId],
      foreignColumns: [receptions.tenantId, receptions.id, receptions.vehicleId, receptions.customerId],
    }),
    foreignKey({
      name: 'service_orders_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'service_orders_vehicle_fk',
      columns: [t.tenantId, t.vehicleId],
      foreignColumns: [vehicles.tenantId, vehicles.id],
    }),
    foreignKey({
      name: 'service_orders_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    enumCheck('service_orders_status_check', t.status, SERVICE_ORDER_STATUSES),
    enumCheck('service_orders_priority_check', t.priority, ['low', 'normal', 'high', 'urgent']),
    rawCheck('service_orders_version_check', '"version" > 0'),
    rawCheck(
      'service_orders_closed_at_check',
      `("status" IN ('delivered','cancelled')) = ("closed_at" IS NOT NULL)`,
    ),
    index('service_orders_status_opened_idx').on(t.tenantId, t.status, t.openedAt.desc()),
    index('service_orders_vehicle_idx').on(t.tenantId, t.vehicleId),
    index('service_orders_customer_idx').on(t.tenantId, t.customerId),
    index('service_orders_created_by_idx').on(t.tenantId, t.createdByMembershipId),
  ],
);

/** Append-only: REVOKE UPDATE/DELETE/TRUNCATE en la migración de seguridad. */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    fromStatus: varchar('from_status', { length: 32 }),
    toStatus: varchar('to_status', { length: 32 }).notNull(),
    reason: text('reason'),
    changedByMembershipId: uuid('changed_by_membership_id'),
    changedAt: ts('changed_at').notNull().defaultNow(),
    requestId: varchar('request_id', { length: 128 }).notNull(),
  },
  (t) => [
    unique('osh_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'osh_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'osh_changed_by_fk',
      columns: [t.tenantId, t.changedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('osh_changed_by_idx').on(t.tenantId, t.changedByMembershipId),
    enumCheck('osh_from_status_check', t.fromStatus, SERVICE_ORDER_STATUSES),
    enumCheck('osh_to_status_check', t.toStatus, SERVICE_ORDER_STATUSES),
    index('osh_order_changed_idx').on(t.tenantId, t.orderId, t.changedAt.desc()),
  ],
);

/**
 * La semántica `Q` de RBAC exige una asignación `quality_control` activa para
 * ejecutar `quality_checks.perform`. La separación de funciones (no ser técnico y QC
 * de la misma orden) requiere constraint trigger: no se expresa con un CHECK de fila.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    assignmentType: varchar('assignment_type', { length: 24 }).notNull(),
    assignedByMembershipId: uuid('assigned_by_membership_id').notNull(),
    assignedAt: ts('assigned_at').notNull().defaultNow(),
    releasedAt: ts('released_at'),
  },
  (t) => [
    unique('assignments_tenant_id_key').on(t.tenantId, t.id),
    unique('assignments_scope_key').on(t.tenantId, t.id, t.orderId, t.membershipId),
    foreignKey({
      name: 'assignments_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'assignments_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'assignments_assigned_by_fk',
      columns: [t.tenantId, t.assignedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('assignments_assigned_by_idx').on(t.tenantId, t.assignedByMembershipId),
    enumCheck('assignments_type_check', t.assignmentType, [
      'lead_technician',
      'support_technician',
      'quality_control',
    ]),
    rawCheck('assignments_released_check', '"released_at" IS NULL OR "released_at" > "assigned_at"'),
    index('assignments_lookup_idx').on(t.tenantId, t.orderId, t.membershipId, t.assignmentType),
    index('assignments_membership_idx').on(t.tenantId, t.membershipId),
    uniqueIndex('assignments_active_uq')
      .on(t.tenantId, t.orderId, t.membershipId, t.assignmentType)
      .where(sql`released_at IS NULL`),
  ],
);

/* ========================================================================== */
/* 8. Diagnóstico                                                             */
/* ========================================================================== */

export const diagnostics = pgTable(
  'diagnostics',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    diagnosedByMembershipId: uuid('diagnosed_by_membership_id').notNull(),
    summary: text('summary'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('diagnostics_tenant_id_key').on(t.tenantId, t.id),
    unique('diagnostics_order_scope_key').on(t.tenantId, t.id, t.orderId),
    foreignKey({
      name: 'diagnostics_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'diagnostics_diagnosed_by_fk',
      columns: [t.tenantId, t.diagnosedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('diagnostics_diagnosed_by_idx').on(t.tenantId, t.diagnosedByMembershipId),
    enumCheck('diagnostics_status_check', t.status, [
      'draft',
      'in_progress',
      'completed',
      'cancelled',
    ]),
    rawCheck(
      'diagnostics_terminal_coherence_check',
      `(("status" = 'completed') = ("completed_at" IS NOT NULL))
       AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL))
       AND ("status" <> 'cancelled' OR "cancel_reason" IS NOT NULL)`,
    ),
    index('diagnostics_order_idx').on(t.tenantId, t.orderId),
    // Máximo un diagnóstico activo por orden; un re-diagnóstico crea una fila nueva.
    uniqueIndex('diagnostics_one_active_uq')
      .on(t.tenantId, t.orderId)
      .where(sql`status IN ('draft','in_progress')`),
  ],
);

/** `order_id` es denormalizado e inmutable: permite probar por FK "misma orden". */
export const findings = pgTable(
  'findings',
  {
    id: pk(),
    tenantId: tenantId(),
    diagnosticId: uuid('diagnostic_id').notNull(),
    orderId: uuid('order_id').notNull(),
    category: varchar('category', { length: 64 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description').notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('medium'),
    requiresAction: boolean('requires_action').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique('findings_tenant_id_key').on(t.tenantId, t.id),
    unique('findings_order_scope_key').on(t.tenantId, t.id, t.orderId),
    foreignKey({
      name: 'findings_diagnostic_fk',
      columns: [t.tenantId, t.diagnosticId, t.orderId],
      foreignColumns: [diagnostics.tenantId, diagnostics.id, diagnostics.orderId],
    }),
    enumCheck('findings_severity_check', t.severity, ['low', 'medium', 'high', 'critical']),
    index('findings_diagnostic_idx').on(t.tenantId, t.diagnosticId),
    index('findings_order_idx').on(t.tenantId, t.orderId),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: pk(),
    tenantId: tenantId(),
    findingId: uuid('finding_id').notNull(),
    description: text('description').notNull(),
    recommendedAction: text('recommended_action'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('recommendations_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'recommendations_finding_fk',
      columns: [t.tenantId, t.findingId],
      foreignColumns: [findings.tenantId, findings.id],
    }),
    index('recommendations_finding_idx').on(t.tenantId, t.findingId),
  ],
);

/* ========================================================================== */
/* 9. Catálogo maestro por taller                                             */
/* ========================================================================== */

export const catalogItems = pgTable(
  'catalog_items',
  {
    id: pk(),
    tenantId: tenantId(),
    itemType: varchar('item_type', { length: 16 }).notNull(),
    code: varchar('code', { length: 80 }),
    barcode: varchar('barcode', { length: 120 }),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    defaultUnitPrice: money('default_unit_price').notNull(),
    currency: currency(),
    taxRate: rate('tax_rate'),
    unit: varchar('unit', { length: 40 }),
    defaultWarrantyDurationValue: integer('default_warranty_duration_value'),
    defaultWarrantyDurationUnit: varchar('default_warranty_duration_unit', { length: 8 }),
    defaultWarrantyTerms: text('default_warranty_terms'),
    trackInventory: boolean('track_inventory').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('catalog_items_tenant_id_key').on(t.tenantId, t.id),
    enumCheck('catalog_items_type_check', t.itemType, ITEM_TYPES),
    enumCheck('catalog_items_warranty_unit_check', t.defaultWarrantyDurationUnit, WARRANTY_UNITS),
    rawCheck('catalog_items_price_check', '"default_unit_price" >= 0'),
    rawCheck('catalog_items_tax_rate_check', '"tax_rate" BETWEEN 0 AND 100'),
    rawCheck('catalog_items_warranty_value_check', '"default_warranty_duration_value" > 0'),
    // Duración y unidad de garantía son ambas NULL o ambas NOT NULL.
    rawCheck(
      'catalog_items_warranty_pair_check',
      '("default_warranty_duration_value" IS NULL) = ("default_warranty_duration_unit" IS NULL)',
    ),
    // El stock solo aplica a repuestos/productos físicos.
    rawCheck(
      'catalog_items_track_inventory_check',
      `NOT "track_inventory" OR "item_type" = 'part'`,
    ),
    index('catalog_items_tenant_active_idx').on(t.tenantId, t.isActive),
    uniqueIndex('catalog_items_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`code IS NOT NULL`),
    uniqueIndex('catalog_items_barcode_uq')
      .on(t.tenantId, t.barcode)
      .where(sql`barcode IS NOT NULL`),
  ],
);

/* ========================================================================== */
/* 10. WhatsApp y comunicaciones                                              */
/* ========================================================================== */

/**
 * Baseline MVP: cada taller conserva su propia WABA/número y Meta le factura
 * directamente (`billing_mode = 'tenant_direct'`). El access token real NO se
 * guarda en PostgreSQL: solo una referencia opaca al secret store.
 */
export const tenantWhatsappAccounts = pgTable(
  'tenant_whatsapp_accounts',
  {
    id: pk(),
    tenantId: tenantId(),
    provider: varchar('provider', { length: 32 }).notNull().default('meta_whatsapp'),
    metaBusinessId: varchar('meta_business_id', { length: 160 }),
    wabaId: varchar('waba_id', { length: 160 }).notNull(),
    phoneNumberId: varchar('phone_number_id', { length: 160 }).notNull(),
    displayPhoneNumber: varchar('display_phone_number', { length: 32 }),
    verifiedName: varchar('verified_name', { length: 200 }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    connectionMode: varchar('connection_mode', { length: 32 }).notNull().default('embedded_signup'),
    billingMode: varchar('billing_mode', { length: 24 }).notNull().default('tenant_direct'),
    credentialSecretRef: varchar('credential_secret_ref', { length: 255 }),
    connectedByMembershipId: uuid('connected_by_membership_id').notNull(),
    connectedAt: ts('connected_at'),
    disconnectedAt: ts('disconnected_at'),
    lastWebhookAt: ts('last_webhook_at'),
    ...timestamps(),
  },
  (t) => [
    unique('twa_tenant_id_key').on(t.tenantId, t.id),
    // Un webhook entrante debe resolver un único tenant por `phone_number_id`.
    unique('twa_phone_number_id_key').on(t.phoneNumberId),
    foreignKey({
      name: 'twa_connected_by_fk',
      columns: [t.tenantId, t.connectedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('twa_connected_by_idx').on(t.tenantId, t.connectedByMembershipId),
    enumCheck('twa_provider_check', t.provider, ['meta_whatsapp']),
    enumCheck('twa_status_check', t.status, ['pending', 'active', 'disconnected', 'error']),
    enumCheck('twa_connection_mode_check', t.connectionMode, ['embedded_signup']),
    enumCheck('twa_billing_mode_check', t.billingMode, ['tenant_direct']),
    index('twa_tenant_status_idx').on(t.tenantId, t.status),
    uniqueIndex('twa_one_active_uq')
      .on(t.tenantId)
      .where(sql`status = 'active'`),
  ],
);

export const messageThreads = pgTable(
  'message_threads',
  {
    id: pk(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    orderId: uuid('order_id'),
    channel: varchar('channel', { length: 16 }).notNull(),
    externalThreadRef: varchar('external_thread_ref', { length: 255 }),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    ...timestamps(),
  },
  (t) => [
    unique('message_threads_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'message_threads_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'message_threads_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    enumCheck('message_threads_channel_check', t.channel, ['whatsapp', 'email', 'sms', 'other']),
    enumCheck('message_threads_status_check', t.status, ['open', 'closed']),
    index('message_threads_customer_idx').on(t.tenantId, t.customerId),
    index('message_threads_order_idx').on(t.tenantId, t.orderId),
    uniqueIndex('message_threads_external_ref_uq')
      .on(t.tenantId, t.channel, t.externalThreadRef)
      .where(sql`external_thread_ref IS NOT NULL`),
  ],
);

/**
 * Progresión outbound monotónica: `queued|accepted -> sent -> delivered -> read`,
 * con salida a `failed`. Un webhook atrasado NO retrocede el estado: la transición
 * se decide comparando `provider_status_at`.
 */
export const messages = pgTable(
  'messages',
  {
    id: pk(),
    tenantId: tenantId(),
    threadId: uuid('thread_id').notNull(),
    whatsappAccountId: uuid('whatsapp_account_id'),
    direction: varchar('direction', { length: 12 }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    messageType: varchar('message_type', { length: 20 }).notNull(),
    body: text('body'),
    status: varchar('status', { length: 16 }).notNull(),
    providerStatusAt: ts('provider_status_at'),
    sentAt: ts('sent_at'),
    deliveredAt: ts('delivered_at'),
    readAt: ts('read_at'),
    failedAt: ts('failed_at'),
    failureCode: varchar('failure_code', { length: 120 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('messages_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'messages_thread_fk',
      columns: [t.tenantId, t.threadId],
      foreignColumns: [messageThreads.tenantId, messageThreads.id],
    }),
    foreignKey({
      name: 'messages_whatsapp_account_fk',
      columns: [t.tenantId, t.whatsappAccountId],
      foreignColumns: [tenantWhatsappAccounts.tenantId, tenantWhatsappAccounts.id],
    }),
    enumCheck('messages_direction_check', t.direction, ['inbound', 'outbound']),
    enumCheck('messages_provider_check', t.provider, [
      'meta_whatsapp',
      'email',
      'sms',
      'internal',
    ]),
    enumCheck('messages_type_check', t.messageType, ['text', 'template', 'media', 'system']),
    enumCheck('messages_status_check', t.status, [
      'received',
      'queued',
      'accepted',
      'sent',
      'delivered',
      'read',
      'failed',
    ]),
    rawCheck(
      'messages_whatsapp_account_required_check',
      `"provider" <> 'meta_whatsapp' OR "whatsapp_account_id" IS NOT NULL`,
    ),
    index('messages_thread_created_idx').on(t.tenantId, t.threadId, t.createdAt),
    index('messages_account_created_idx').on(t.tenantId, t.whatsappAccountId, t.createdAt),
    uniqueIndex('messages_provider_message_uq')
      .on(t.provider, t.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
  ],
);

/* ========================================================================== */
/* 11. Cotizaciones y autorización del cliente                                */
/* ========================================================================== */

/**
 * NOTA (ciclo de FKs): `quotes.current_version_id` debe tener la FK compuesta
 * `(tenant_id, current_version_id, id, order_id) -> quote_versions(tenant_id, id, quote_id, order_id)`.
 * El retorno explícito del callback rompe la inferencia circular de TypeScript.
 * La migración debe añadir las FKs después de crear ambas tablas. Para crear una
 * cotización: INSERT quote sin current, INSERT versión y UPDATE current, todo en
 * una transacción. Si se requiere diferir la FK, se configura en migration SQL.
 */
export const quotes = pgTable(
  'quotes',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    quoteType: varchar('quote_type', { length: 16 }).notNull().default('initial'),
    status: varchar('status', { length: 24 }).notNull().default('draft'),
    currentVersionId: uuid('current_version_id'),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    cancelledAt: ts('cancelled_at'),
    cancelledByMembershipId: uuid('cancelled_by_membership_id'),
    cancelReason: text('cancel_reason'),
    ...timestamps(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('quotes_tenant_id_key').on(t.tenantId, t.id),
    unique('quotes_order_scope_key').on(t.tenantId, t.id, t.orderId),
    foreignKey({
      name: 'quotes_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'quotes_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('quotes_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    foreignKey({
      name: 'quotes_cancelled_by_fk',
      columns: [t.tenantId, t.cancelledByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('quotes_cancelled_by_idx').on(t.tenantId, t.cancelledByMembershipId),
    foreignKey({
      name: 'quotes_current_version_fk',
      columns: [t.tenantId, t.currentVersionId, t.id, t.orderId],
      foreignColumns: [
        quoteVersions.tenantId,
        quoteVersions.id,
        quoteVersions.quoteId,
        quoteVersions.orderId,
      ],
    }),
    enumCheck('quotes_type_check', t.quoteType, ['initial', 'supplemental']),
    enumCheck('quotes_status_check', t.status, [
      'draft',
      'awaiting_authorization',
      'approved',
      'partially_approved',
      'rejected',
      'cancelled',
    ]),
    rawCheck(
      'quotes_cancelled_coherence_check',
      `("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
       AND ("status" <> 'cancelled'
            OR ("cancelled_by_membership_id" IS NOT NULL AND "cancel_reason" IS NOT NULL))`,
    ),
    index('quotes_order_idx').on(t.tenantId, t.orderId),
    index('quotes_current_version_idx').on(t.tenantId, t.currentVersionId),
  ],
);

/** Una versión enviada (`sent_at IS NOT NULL`) queda frozen para runtime. */
export const quoteVersions = pgTable(
  'quote_versions',
  {
    id: pk(),
    tenantId: tenantId(),
    quoteId: uuid('quote_id').notNull(),
    orderId: uuid('order_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    subtotalAmount: money('subtotal_amount').notNull(),
    taxAmount: money('tax_amount').notNull().default(sql`0`),
    discountAmount: money('discount_amount').notNull().default(sql`0`),
    totalAmount: money('total_amount').notNull(),
    currency: currency(),
    notes: text('notes'),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    unique('qv_tenant_id_key').on(t.tenantId, t.id),
    unique('qv_order_scope_key').on(t.tenantId, t.id, t.orderId),
    unique('qv_quote_order_scope_key').on(t.tenantId, t.id, t.quoteId, t.orderId),
    unique('qv_version_number_key').on(t.tenantId, t.quoteId, t.versionNumber),
    foreignKey({
      name: 'qv_quote_fk',
      columns: [t.tenantId, t.quoteId, t.orderId],
      foreignColumns: [quotes.tenantId, quotes.id, quotes.orderId],
    }),
    foreignKey({
      name: 'qv_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('qv_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    rawCheck('qv_version_number_check', '"version_number" > 0'),
    rawCheck(
      'qv_amounts_check',
      '"subtotal_amount" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "total_amount" >= 0',
    ),
    index('qv_quote_idx').on(t.tenantId, t.quoteId),
  ],
);

/**
 * `sales_originator_membership_id` es atribución COMERCIAL (dashboard), distinta de
 * quien creó técnicamente la fila. Se congela al enviar la versión.
 */
export const quoteItems = pgTable(
  'quote_items',
  {
    id: pk(),
    tenantId: tenantId(),
    quoteVersionId: uuid('quote_version_id').notNull(),
    orderId: uuid('order_id').notNull(),
    findingId: uuid('finding_id'),
    catalogItemId: uuid('catalog_item_id'),
    salesOriginatorMembershipId: uuid('sales_originator_membership_id').notNull(),
    itemType: varchar('item_type', { length: 16 }).notNull(),
    codeSnapshot: varchar('code_snapshot', { length: 80 }),
    nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
    descriptionSnapshot: text('description_snapshot'),
    unit: varchar('unit', { length: 40 }),
    quantity: qty('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    taxRateSnapshot: rate('tax_rate_snapshot'),
    warrantyDurationValueSnapshot: integer('warranty_duration_value_snapshot'),
    warrantyDurationUnitSnapshot: varchar('warranty_duration_unit_snapshot', { length: 8 }),
    warrantyTermsSnapshot: text('warranty_terms_snapshot'),
    taxAmount: money('tax_amount').notNull().default(sql`0`),
    discountAmount: money('discount_amount').notNull().default(sql`0`),
    lineTotal: money('line_total').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qi_tenant_id_key').on(t.tenantId, t.id),
    unique('qi_order_scope_key').on(t.tenantId, t.id, t.orderId),
    unique('qi_version_scope_key').on(t.tenantId, t.id, t.quoteVersionId),
    foreignKey({
      name: 'qi_version_fk',
      columns: [t.tenantId, t.quoteVersionId, t.orderId],
      foreignColumns: [quoteVersions.tenantId, quoteVersions.id, quoteVersions.orderId],
    }),
    foreignKey({
      name: 'qi_finding_fk',
      columns: [t.tenantId, t.findingId, t.orderId],
      foreignColumns: [findings.tenantId, findings.id, findings.orderId],
    }),
    foreignKey({
      name: 'qi_catalog_item_fk',
      columns: [t.tenantId, t.catalogItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
    foreignKey({
      name: 'qi_sales_originator_fk',
      columns: [t.tenantId, t.salesOriginatorMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('qi_item_type_check', t.itemType, ITEM_TYPES),
    enumCheck('qi_warranty_unit_check', t.warrantyDurationUnitSnapshot, WARRANTY_UNITS),
    rawCheck('qi_quantity_check', '"quantity" > 0'),
    rawCheck(
      'qi_amounts_check',
      '"unit_price" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0 AND "sort_order" >= 0',
    ),
    rawCheck('qi_tax_rate_check', '"tax_rate_snapshot" BETWEEN 0 AND 100'),
    rawCheck('qi_warranty_value_check', '"warranty_duration_value_snapshot" > 0'),
    rawCheck(
      'qi_warranty_pair_check',
      '("warranty_duration_value_snapshot" IS NULL) = ("warranty_duration_unit_snapshot" IS NULL)',
    ),
    index('qi_version_idx').on(t.tenantId, t.quoteVersionId),
    index('qi_catalog_item_idx').on(t.tenantId, t.catalogItemId),
    index('qi_finding_idx').on(t.tenantId, t.findingId),
    index('qi_sales_originator_idx').on(t.tenantId, t.salesOriginatorMembershipId),
  ],
);

/**
 * Credencial temporal ligada a UNA versión exacta de cotización. El token crudo nunca
 * se persiste. Abrir el enlace no consume el token: solo lo consume una decisión final.
 * Pueden coexistir varios `active` de la misma versión (reenvíos); cuando uno se consume,
 * el resto pasa a `superseded` con `supersede_reason = 'sibling_consumed'`.
 */
export const quoteAuthorizationTokens = pgTable(
  'quote_authorization_tokens',
  {
    id: pk(),
    tenantId: tenantId(),
    quoteVersionId: uuid('quote_version_id').notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    issuedForMessageId: uuid('issued_for_message_id'),
    expiresAt: ts('expires_at').notNull(),
    lastAccessedAt: ts('last_accessed_at'),
    consumedAt: ts('consumed_at'),
    revokedAt: ts('revoked_at'),
    revokedByMembershipId: uuid('revoked_by_membership_id'),
    revokeReason: text('revoke_reason'),
    supersededAt: ts('superseded_at'),
    supersedeReason: varchar('supersede_reason', { length: 24 }),
    supersededByTokenId: uuid('superseded_by_token_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qat_tenant_id_key').on(t.tenantId, t.id),
    unique('qat_version_scope_key').on(t.tenantId, t.id, t.quoteVersionId),
    unique('qat_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'qat_version_fk',
      columns: [t.tenantId, t.quoteVersionId],
      foreignColumns: [quoteVersions.tenantId, quoteVersions.id],
    }),
    foreignKey({
      name: 'qat_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'qat_revoked_by_fk',
      columns: [t.tenantId, t.revokedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('qat_revoked_by_idx').on(t.tenantId, t.revokedByMembershipId),
    foreignKey({
      name: 'qat_issued_for_message_fk',
      columns: [t.tenantId, t.issuedForMessageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    // Self-FK: un `sibling_consumed` siempre refiere un token ganador de la misma versión.
    foreignKey({
      name: 'qat_superseded_by_fk',
      columns: [t.tenantId, t.supersededByTokenId, t.quoteVersionId],
      foreignColumns: [t.tenantId, t.id, t.quoteVersionId],
    }),
    index('qat_superseded_by_idx').on(t.tenantId, t.supersededByTokenId),
    enumCheck('qat_status_check', t.status, [
      'active',
      'consumed',
      'expired',
      'revoked',
      'superseded',
    ]),
    enumCheck('qat_supersede_reason_check', t.supersedeReason, [
      'quote_revised',
      'sibling_consumed',
    ]),
    index('qat_version_status_idx').on(t.tenantId, t.quoteVersionId, t.status, t.expiresAt),
    index('qat_issued_for_message_idx').on(t.tenantId, t.issuedForMessageId),
    index('qat_created_by_idx').on(t.tenantId, t.createdByMembershipId),
  ],
);

/**
 * Step-up OTP antes de una decisión pública. `code_hash` es HMAC-SHA256 con pepper
 * versionado (`hash_key_version`), no un hash simple de 6 dígitos: un volcado de la
 * base no debe permitir fuerza bruta offline del espacio de 1M de códigos.
 * El código crudo nunca se persiste en DB, outbox ni logs.
 */
export const quoteAuthorizationChallenges = pgTable(
  'quote_authorization_challenges',
  {
    id: pk(),
    tenantId: tenantId(),
    authorizationTokenId: uuid('authorization_token_id').notNull(),
    codeHash: varchar('code_hash', { length: 128 }),
    hashKeyVersion: smallint('hash_key_version'),
    status: varchar('status', { length: 20 }).notNull().default('requested'),
    deliveryChannel: varchar('delivery_channel', { length: 16 }).notNull().default('whatsapp'),
    destinationMasked: varchar('destination_masked', { length: 160 }),
    deliveryMessageId: uuid('delivery_message_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    verifiedAt: ts('verified_at'),
    verificationExpiresAt: ts('verification_expires_at'),
    consumedAt: ts('consumed_at'),
    lockedAt: ts('locked_at'),
    supersededAt: ts('superseded_at'),
    ...timestamps(),
  },
  (t) => [
    unique('qac_tenant_id_key').on(t.tenantId, t.id),
    unique('qac_token_scope_key').on(t.tenantId, t.id, t.authorizationTokenId),
    foreignKey({
      name: 'qac_token_fk',
      columns: [t.tenantId, t.authorizationTokenId],
      foreignColumns: [quoteAuthorizationTokens.tenantId, quoteAuthorizationTokens.id],
    }),
    foreignKey({
      name: 'qac_delivery_message_fk',
      columns: [t.tenantId, t.deliveryMessageId],
      foreignColumns: [messages.tenantId, messages.id],
    }),
    enumCheck('qac_status_check', t.status, [
      'requested',
      'active',
      'verified',
      'consumed',
      'expired',
      'locked',
      'superseded',
      'delivery_failed',
    ]),
    enumCheck('qac_delivery_channel_check', t.deliveryChannel, ['whatsapp', 'email', 'sms']),
    rawCheck('qac_max_attempts_check', '"max_attempts" BETWEEN 1 AND 10'),
    rawCheck('qac_attempt_count_check', '"attempt_count" BETWEEN 0 AND "max_attempts"'),
    rawCheck('qac_hash_key_version_check', '"hash_key_version" > 0'),
    index('qac_token_status_idx').on(t.tenantId, t.authorizationTokenId, t.status, t.expiresAt),
    index('qac_delivery_message_idx').on(t.tenantId, t.deliveryMessageId),
    // Máximo un challenge utilizable por token; un nuevo challenge supersede al anterior.
    uniqueIndex('qac_one_usable_uq')
      .on(t.tenantId, t.authorizationTokenId)
      .where(sql`status IN ('requested','active','verified')`),
  ],
);

/**
 * Append-only. Registra la DECISIÓN FINAL, no la credencial previa (`token_hash` no
 * vive aquí). `UNIQUE(tenant_id, quote_version_id)` es la barrera de base de datos
 * contra carreras entre tokens distintos de la misma versión.
 */
export const quoteAuthorizations = pgTable(
  'quote_authorizations',
  {
    id: pk(),
    tenantId: tenantId(),
    quoteVersionId: uuid('quote_version_id').notNull(),
    authorizationTokenId: uuid('authorization_token_id'),
    authorizationChallengeId: uuid('authorization_challenge_id'),
    decision: varchar('decision', { length: 24 }).notNull(),
    authorizedAmount: money('authorized_amount'),
    customerName: varchar('customer_name', { length: 200 }).notNull(),
    customerDocument: varchar('customer_document', { length: 60 }),
    channel: varchar('channel', { length: 32 }).notNull(),
    recordedByMembershipId: uuid('recorded_by_membership_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    authorizedAt: ts('authorized_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qa_tenant_id_key').on(t.tenantId, t.id),
    unique('qa_version_scope_key').on(t.tenantId, t.id, t.quoteVersionId),
    unique('qa_one_per_version_key').on(t.tenantId, t.quoteVersionId),
    foreignKey({
      name: 'qa_version_fk',
      columns: [t.tenantId, t.quoteVersionId],
      foreignColumns: [quoteVersions.tenantId, quoteVersions.id],
    }),
    foreignKey({
      name: 'qa_token_fk',
      columns: [t.tenantId, t.authorizationTokenId, t.quoteVersionId],
      foreignColumns: [
        quoteAuthorizationTokens.tenantId,
        quoteAuthorizationTokens.id,
        quoteAuthorizationTokens.quoteVersionId,
      ],
    }),
    foreignKey({
      name: 'qa_challenge_fk',
      columns: [t.tenantId, t.authorizationChallengeId, t.authorizationTokenId],
      foreignColumns: [
        quoteAuthorizationChallenges.tenantId,
        quoteAuthorizationChallenges.id,
        quoteAuthorizationChallenges.authorizationTokenId,
      ],
    }),
    index('qa_challenge_idx').on(t.tenantId, t.authorizationChallengeId),
    foreignKey({
      name: 'qa_recorded_by_fk',
      columns: [t.tenantId, t.recordedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('qa_recorded_by_idx').on(t.tenantId, t.recordedByMembershipId),
    enumCheck('qa_decision_check', t.decision, ['approved', 'partially_approved', 'rejected']),
    enumCheck('qa_channel_check', t.channel, [
      'public_whatsapp_otp',
      'manual_in_person',
      'manual_phone',
      'other_manual',
    ]),
    rawCheck(
      'qa_authorized_amount_check',
      `"authorized_amount" >= 0
       AND ("decision" = 'rejected' OR "authorized_amount" IS NOT NULL)`,
    ),
    // Flujo público: token + challenge presentes y sin actor interno.
    // Flujo manual: ni token ni challenge, y `recorded_by` obligatorio.
    rawCheck(
      'qa_flow_check',
      `(
         "channel" = 'public_whatsapp_otp'
         AND "authorization_token_id" IS NOT NULL
         AND "authorization_challenge_id" IS NOT NULL
         AND "recorded_by_membership_id" IS NULL
       ) OR (
         "channel" <> 'public_whatsapp_otp'
         AND "authorization_token_id" IS NULL
         AND "authorization_challenge_id" IS NULL
         AND "recorded_by_membership_id" IS NOT NULL
       )`,
    ),
    // Un token solo puede producir una autorización.
    uniqueIndex('qa_one_per_token_uq')
      .on(t.tenantId, t.authorizationTokenId)
      .where(sql`authorization_token_id IS NOT NULL`),
  ],
);

/** Append-only. Indica qué líneas concretas se aprobaron o rechazaron. */
export const quoteAuthorizationItems = pgTable(
  'quote_authorization_items',
  {
    id: pk(),
    tenantId: tenantId(),
    authorizationId: uuid('authorization_id').notNull(),
    quoteVersionId: uuid('quote_version_id').notNull(),
    quoteItemId: uuid('quote_item_id').notNull(),
    decision: varchar('decision', { length: 16 }).notNull(),
    authorizedQuantity: qty('authorized_quantity'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qai_tenant_id_key').on(t.tenantId, t.id),
    unique('qai_item_decision_key').on(t.tenantId, t.authorizationId, t.quoteItemId),
    foreignKey({
      name: 'qai_authorization_fk',
      columns: [t.tenantId, t.authorizationId, t.quoteVersionId],
      foreignColumns: [
        quoteAuthorizations.tenantId,
        quoteAuthorizations.id,
        quoteAuthorizations.quoteVersionId,
      ],
    }),
    foreignKey({
      name: 'qai_quote_item_fk',
      columns: [t.tenantId, t.quoteItemId, t.quoteVersionId],
      foreignColumns: [quoteItems.tenantId, quoteItems.id, quoteItems.quoteVersionId],
    }),
    index('qai_quote_item_idx').on(t.tenantId, t.quoteItemId),
    enumCheck('qai_decision_check', t.decision, ['approved', 'rejected']),
    rawCheck(
      'qai_authorized_quantity_check',
      `"decision" <> 'approved'
       OR ("authorized_quantity" IS NOT NULL AND "authorized_quantity" > 0)`,
    ),
    index('qai_authorization_idx').on(t.tenantId, t.authorizationId),
  ],
);

/* ========================================================================== */
/* 12. Líneas de la orden (lo realmente autorizado/ejecutado)                  */
/* ========================================================================== */

/**
 * Distinto de `catalog_items` (maestro reusable) y de `quote_items` (propuesta
 * comercial versionada). El historial de un vehículo se reconstruye por
 * `vehicle -> service_orders -> service_order_items`.
 *
 * `quantity_actual` es lo realmente ejecutado; `quantity_billed` lo finalmente
 * cobrable y nunca puede exceder lo autorizado sin un ajuste autorizado que suba
 * `quantity_authorized`. El estado de garantía NO se persiste como booleano: se
 * deriva comparando `now()` con `warranty_start_at`/`warranty_expires_at`.
 */
export const serviceOrderItems = pgTable(
  'service_order_items',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    quoteItemId: uuid('quote_item_id'),
    catalogItemId: uuid('catalog_item_id'),
    salesOriginatorMembershipId: uuid('sales_originator_membership_id').notNull(),
    itemType: varchar('item_type', { length: 16 }).notNull(),
    codeSnapshot: varchar('code_snapshot', { length: 80 }),
    nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
    descriptionSnapshot: text('description_snapshot'),
    unit: varchar('unit', { length: 40 }),
    quantityAuthorized: qty('quantity_authorized').notNull(),
    quantityActual: qty('quantity_actual'),
    quantityBilled: qty('quantity_billed'),
    unitPrice: money('unit_price').notNull(),
    currency: currency(),
    taxRateSnapshot: rate('tax_rate_snapshot'),
    taxAmount: money('tax_amount').notNull().default(sql`0`),
    discountAmount: money('discount_amount').notNull().default(sql`0`),
    lineTotal: money('line_total').notNull().default(sql`0`),
    warrantyDurationValueSnapshot: integer('warranty_duration_value_snapshot'),
    warrantyDurationUnitSnapshot: varchar('warranty_duration_unit_snapshot', { length: 8 }),
    warrantyTermsSnapshot: text('warranty_terms_snapshot'),
    warrantyOrigin: varchar('warranty_origin', { length: 24 }).notNull().default('none'),
    warrantyStartAt: ts('warranty_start_at'),
    warrantyExpiresAt: ts('warranty_expires_at'),
    status: varchar('status', { length: 20 }).notNull().default('authorized'),
    source: varchar('source', { length: 24 }).notNull(),
    adjustmentReason: text('adjustment_reason'),
    cancelReason: text('cancel_reason'),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    unique('soi_tenant_id_key').on(t.tenantId, t.id),
    unique('soi_order_scope_key').on(t.tenantId, t.id, t.orderId),
    // Permite que `inventory_movements` pruebe por FK que el consumo corresponde
    // al producto real de la línea.
    unique('soi_catalog_scope_key').on(t.tenantId, t.id, t.catalogItemId),
    foreignKey({
      name: 'soi_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'soi_quote_item_fk',
      columns: [t.tenantId, t.quoteItemId, t.orderId],
      foreignColumns: [quoteItems.tenantId, quoteItems.id, quoteItems.orderId],
    }),
    foreignKey({
      name: 'soi_catalog_item_fk',
      columns: [t.tenantId, t.catalogItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
    foreignKey({
      name: 'soi_sales_originator_fk',
      columns: [t.tenantId, t.salesOriginatorMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'soi_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('soi_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    enumCheck('soi_item_type_check', t.itemType, ITEM_TYPES),
    enumCheck('soi_status_check', t.status, [
      'authorized',
      'in_progress',
      'completed',
      'cancelled',
    ]),
    enumCheck('soi_source_check', t.source, ['quote', 'manual_adjustment', 'warranty', 'other']),
    enumCheck('soi_warranty_origin_check', t.warrantyOrigin, [
      'none',
      'catalog_default',
      'quote_override',
      'order_override',
    ]),
    enumCheck('soi_warranty_unit_check', t.warrantyDurationUnitSnapshot, WARRANTY_UNITS),
    rawCheck('soi_quantity_authorized_check', '"quantity_authorized" > 0'),
    rawCheck('soi_quantity_actual_check', '"quantity_actual" >= 0'),
    // Se puede ejecutar de más, pero no facturar de más sin subir lo autorizado.
    rawCheck(
      'soi_quantity_billed_check',
      '"quantity_billed" >= 0 AND "quantity_billed" <= "quantity_authorized"',
    ),
    rawCheck(
      'soi_amounts_check',
      '"unit_price" >= 0 AND "tax_amount" >= 0 AND "discount_amount" >= 0 AND "line_total" >= 0',
    ),
    rawCheck('soi_tax_rate_check', '"tax_rate_snapshot" BETWEEN 0 AND 100'),
    rawCheck('soi_warranty_value_check', '"warranty_duration_value_snapshot" > 0'),
    rawCheck(
      'soi_warranty_window_check',
      '"warranty_expires_at" IS NULL OR "warranty_start_at" IS NULL OR "warranty_expires_at" > "warranty_start_at"',
    ),
    rawCheck(
      'soi_source_quote_check',
      `"source" <> 'quote' OR "quote_item_id" IS NOT NULL`,
    ),
    rawCheck(
      'soi_completed_check',
      `"status" <> 'completed'
       OR ("completed_at" IS NOT NULL AND "quantity_billed" IS NOT NULL)`,
    ),
    rawCheck(
      'soi_cancelled_check',
      `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`,
    ),
    rawCheck(
      'soi_adjustment_reason_check',
      `("source" <> 'manual_adjustment' AND "warranty_origin" <> 'order_override')
       OR ("adjustment_reason" IS NOT NULL AND btrim("adjustment_reason") <> '')`,
    ),
    index('soi_order_idx').on(t.tenantId, t.orderId),
    index('soi_catalog_item_idx').on(t.tenantId, t.catalogItemId),
    index('soi_quote_item_idx').on(t.tenantId, t.quoteItemId),
    index('soi_sales_attribution_idx').on(
      t.tenantId,
      t.salesOriginatorMembershipId,
      t.completedAt,
    ),
  ],
);

/* ========================================================================== */
/* 13. Inventario                                                             */
/* ========================================================================== */

/**
 * Read model transaccional, NO historial. `quantity_on_hand` solo cambia dentro del
 * servicio de inventario, en la misma transacción que inserta `inventory_movements`.
 */
export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    id: pk(),
    tenantId: tenantId(),
    catalogItemId: uuid('catalog_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    quantityOnHand: qty('quantity_on_hand').notNull().default('0'),
    lowStockThreshold: qty('low_stock_threshold').notNull().default('0'),
    version: integer('version').notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('ib_tenant_id_key').on(t.tenantId, t.id),
    unique('ib_item_location_key').on(t.tenantId, t.catalogItemId, t.locationId),
    foreignKey({
      name: 'ib_catalog_item_fk',
      columns: [t.tenantId, t.catalogItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
    foreignKey({
      name: 'ib_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [workshopLocations.tenantId, workshopLocations.id],
    }),
    rawCheck('ib_quantity_check', '"quantity_on_hand" >= 0 AND "low_stock_threshold" >= 0'),
    rawCheck('ib_version_check', '"version" > 0'),
    index('ib_location_quantity_idx').on(t.tenantId, t.locationId, t.quantityOnHand),
  ],
);

/**
 * Append-only. Signos: `initial|receipt|return|adjustment_in|transfer_in > 0`;
 * `consumption|adjustment_out|transfer_out < 0`. Una transferencia válida es
 * exactamente un `transfer_out` y un `transfer_in` de igual magnitud, mismo
 * `transfer_group_id`, ubicaciones distintas y una sola transacción.
 * Las correcciones no editan movimientos: crean un movimiento compensatorio.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: pk(),
    tenantId: tenantId(),
    catalogItemId: uuid('catalog_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    serviceOrderItemId: uuid('service_order_item_id'),
    movementType: varchar('movement_type', { length: 24 }).notNull(),
    quantityDelta: qty('quantity_delta').notNull(),
    transferGroupId: uuid('transfer_group_id'),
    reason: text('reason'),
    performedByMembershipId: uuid('performed_by_membership_id').notNull(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('im_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'im_catalog_item_fk',
      columns: [t.tenantId, t.catalogItemId],
      foreignColumns: [catalogItems.tenantId, catalogItems.id],
    }),
    foreignKey({
      name: 'im_location_fk',
      columns: [t.tenantId, t.locationId],
      foreignColumns: [workshopLocations.tenantId, workshopLocations.id],
    }),
    // Prueba por FK que el consumo/retorno corresponde al producto real de la línea.
    foreignKey({
      name: 'im_service_order_item_fk',
      columns: [t.tenantId, t.serviceOrderItemId, t.catalogItemId],
      foreignColumns: [
        serviceOrderItems.tenantId,
        serviceOrderItems.id,
        serviceOrderItems.catalogItemId,
      ],
    }),
    foreignKey({
      name: 'im_performed_by_fk',
      columns: [t.tenantId, t.performedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('im_performed_by_idx').on(t.tenantId, t.performedByMembershipId),
    enumCheck('im_movement_type_check', t.movementType, [
      'initial',
      'receipt',
      'consumption',
      'return',
      'adjustment_in',
      'adjustment_out',
      'transfer_in',
      'transfer_out',
    ]),
    rawCheck('im_quantity_delta_check', '"quantity_delta" <> 0'),
    rawCheck(
      'im_sign_check',
      `(
         "movement_type" IN ('initial','receipt','return','adjustment_in','transfer_in')
         AND "quantity_delta" > 0
       ) OR (
         "movement_type" IN ('consumption','adjustment_out','transfer_out')
         AND "quantity_delta" < 0
       )`,
    ),
    rawCheck(
      'im_transfer_group_check',
      `("movement_type" IN ('transfer_in','transfer_out')) = ("transfer_group_id" IS NOT NULL)`,
    ),
    rawCheck(
      'im_adjustment_reason_check',
      `"movement_type" NOT IN ('adjustment_in','adjustment_out')
       OR ("reason" IS NOT NULL AND btrim("reason") <> '')`,
    ),
    rawCheck(
      'im_order_link_check',
      `"movement_type" NOT IN ('consumption','return') OR "service_order_item_id" IS NOT NULL`,
    ),
    index('im_item_occurred_idx').on(t.tenantId, t.catalogItemId, t.occurredAt.desc()),
    index('im_location_occurred_idx').on(t.tenantId, t.locationId, t.occurredAt.desc()),
    index('im_service_order_item_idx').on(t.tenantId, t.serviceOrderItemId),
    index('im_transfer_group_idx').on(t.tenantId, t.transferGroupId),
  ],
);

/* ========================================================================== */
/* 14. Reparación, calidad y entrega                                          */
/* ========================================================================== */

export const workActivities = pgTable(
  'work_activities',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    serviceOrderItemId: uuid('service_order_item_id'),
    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    assignedMembershipId: uuid('assigned_membership_id'),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
    cancelReason: text('cancel_reason'),
    ...timestamps(),
  },
  (t) => [
    unique('wa_tenant_id_key').on(t.tenantId, t.id),
    unique('wa_order_scope_key').on(t.tenantId, t.id, t.orderId),
    foreignKey({
      name: 'wa_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'wa_service_order_item_fk',
      columns: [t.tenantId, t.serviceOrderItemId, t.orderId],
      foreignColumns: [serviceOrderItems.tenantId, serviceOrderItems.id, serviceOrderItems.orderId],
    }),
    foreignKey({
      name: 'wa_assigned_membership_fk',
      columns: [t.tenantId, t.assignedMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('wa_status_check', t.status, [
      'pending',
      'in_progress',
      'paused',
      'completed',
      'cancelled',
    ]),
    rawCheck('wa_cancelled_check', `"status" <> 'cancelled' OR "cancel_reason" IS NOT NULL`),
    index('wa_order_idx').on(t.tenantId, t.orderId),
    index('wa_service_order_item_idx').on(t.tenantId, t.serviceOrderItemId),
    index('wa_assigned_idx').on(t.tenantId, t.assignedMembershipId),
  ],
);

/** Append-oriented: sin UPDATE/DELETE en operación normal. */
export const technicianLogs = pgTable(
  'technician_logs',
  {
    id: pk(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    eventType: varchar('event_type', { length: 20 }).notNull(),
    notes: text('notes'),
    loggedAt: ts('logged_at').notNull().defaultNow(),
  },
  (t) => [
    unique('tl_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'tl_activity_fk',
      columns: [t.tenantId, t.activityId],
      foreignColumns: [workActivities.tenantId, workActivities.id],
    }),
    foreignKey({
      name: 'tl_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('tl_event_type_check', t.eventType, [
      'started',
      'paused',
      'resumed',
      'note',
      'completed',
      'cancelled',
    ]),
    index('tl_activity_idx').on(t.tenantId, t.activityId),
    index('tl_membership_idx').on(t.tenantId, t.membershipId),
  ],
);

export const qualityChecks = pgTable(
  'quality_checks',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    checkedByMembershipId: uuid('checked_by_membership_id').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    notes: text('notes'),
    checkedAt: ts('checked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('qc_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'qc_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'qc_checked_by_fk',
      columns: [t.tenantId, t.checkedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('qc_status_check', t.status, ['pending', 'passed', 'failed']),
    rawCheck(
      'qc_checked_at_check',
      `("status" IN ('passed','failed')) = ("checked_at" IS NOT NULL)`,
    ),
    index('qc_order_idx').on(t.tenantId, t.orderId),
    index('qc_checked_by_idx').on(t.tenantId, t.checkedByMembershipId),
  ],
);

/**
 * Una entrega por orden. `payment_status` y `outstanding_balance` son cache DERIVADA
 * del ledger de `customer_payments`, nunca la fuente de verdad.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    deliveredToName: varchar('delivered_to_name', { length: 200 }),
    deliveredByMembershipId: uuid('delivered_by_membership_id'),
    finalAmount: money('final_amount'),
    currency: currency(),
    paymentStatus: varchar('payment_status', { length: 16 }).notNull().default('unpaid'),
    outstandingBalance: money('outstanding_balance').notNull().default(sql`0`),
    notes: text('notes'),
    deliveredAt: ts('delivered_at'),
    ...timestamps(),
  },
  (t) => [
    unique('deliveries_tenant_id_key').on(t.tenantId, t.id),
    unique('deliveries_order_key').on(t.tenantId, t.orderId),
    foreignKey({
      name: 'deliveries_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'deliveries_delivered_by_fk',
      columns: [t.tenantId, t.deliveredByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('deliveries_delivered_by_idx').on(t.tenantId, t.deliveredByMembershipId),
    enumCheck('deliveries_status_check', t.status, ['pending', 'completed']),
    enumCheck('deliveries_payment_status_check', t.paymentStatus, ['unpaid', 'partial', 'paid']),
    rawCheck('deliveries_amount_check', '"final_amount" >= 0 AND "outstanding_balance" >= 0'),
    rawCheck(
      'deliveries_completed_check',
      `("status" = 'completed') = ("delivered_at" IS NOT NULL)
       AND ("status" <> 'completed'
            OR ("delivered_to_name" IS NOT NULL AND "delivered_by_membership_id" IS NOT NULL))`,
    ),
  ],
);

/** La firma pertenece a EXACTAMENTE una recepción o una entrega: nunca a ambas ni a ninguna. */
export const signatures = pgTable(
  'signatures',
  {
    id: pk(),
    tenantId: tenantId(),
    receptionId: uuid('reception_id'),
    deliveryId: uuid('delivery_id'),
    signedByName: varchar('signed_by_name', { length: 200 }).notNull(),
    signedByDocument: varchar('signed_by_document', { length: 60 }),
    signatureMediaId: uuid('signature_media_id').notNull(),
    signedAt: ts('signed_at').notNull(),
    ipAddress: inet('ip_address'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('signatures_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'signatures_reception_fk',
      columns: [t.tenantId, t.receptionId],
      foreignColumns: [receptions.tenantId, receptions.id],
    }),
    foreignKey({
      name: 'signatures_delivery_fk',
      columns: [t.tenantId, t.deliveryId],
      foreignColumns: [deliveries.tenantId, deliveries.id],
    }),
    foreignKey({
      name: 'signatures_media_fk',
      columns: [t.tenantId, t.signatureMediaId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck(
      'signatures_parent_xor_check',
      `("reception_id" IS NOT NULL AND "delivery_id" IS NULL)
       OR ("reception_id" IS NULL AND "delivery_id" IS NOT NULL)`,
    ),
    index('signatures_reception_idx').on(t.tenantId, t.receptionId),
    index('signatures_delivery_idx').on(t.tenantId, t.deliveryId),
    index('signatures_media_idx').on(t.tenantId, t.signatureMediaId),
  ],
);

/* ========================================================================== */
/* 15. Enlaces de media por dominio                                           */
/* ========================================================================== */

/**
 * No existe `media_links` polimórfica: cada enlace tiene FK real tenant-safe hacia
 * su entidad destino, de forma que PostgreSQL valide tenant + entidad. Si se necesita
 * "todo el media de una orden", se define una vista de lectura `v_media_by_order`
 * con UNION — sin reintroducir polimorfismo en escritura.
 */
export const receptionMedia = pgTable(
  'reception_media',
  {
    tenantId: tenantId(),
    receptionId: uuid('reception_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'reception_media_pk',
      columns: [t.tenantId, t.receptionId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'reception_media_reception_fk',
      columns: [t.tenantId, t.receptionId],
      foreignColumns: [receptions.tenantId, receptions.id],
    }),
    foreignKey({
      name: 'reception_media_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('reception_media_sort_order_check', '"sort_order" >= 0'),
    index('reception_media_media_idx').on(t.tenantId, t.mediaAssetId),
    index('reception_media_sort_idx').on(t.tenantId, t.receptionId, t.sortOrder),
  ],
);

export const damageMedia = pgTable(
  'damage_media',
  {
    tenantId: tenantId(),
    damageId: uuid('damage_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'damage_media_pk',
      columns: [t.tenantId, t.damageId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'damage_media_damage_fk',
      columns: [t.tenantId, t.damageId],
      foreignColumns: [vehicleDamages.tenantId, vehicleDamages.id],
    }),
    foreignKey({
      name: 'damage_media_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('damage_media_sort_order_check', '"sort_order" >= 0'),
    index('damage_media_media_idx').on(t.tenantId, t.mediaAssetId),
    index('damage_media_sort_idx').on(t.tenantId, t.damageId, t.sortOrder),
  ],
);

export const findingMedia = pgTable(
  'finding_media',
  {
    tenantId: tenantId(),
    findingId: uuid('finding_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'finding_media_pk',
      columns: [t.tenantId, t.findingId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'finding_media_finding_fk',
      columns: [t.tenantId, t.findingId],
      foreignColumns: [findings.tenantId, findings.id],
    }),
    foreignKey({
      name: 'finding_media_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('finding_media_sort_order_check', '"sort_order" >= 0'),
    index('finding_media_media_idx').on(t.tenantId, t.mediaAssetId),
    index('finding_media_sort_idx').on(t.tenantId, t.findingId, t.sortOrder),
  ],
);

export const workActivityMedia = pgTable(
  'work_activity_media',
  {
    tenantId: tenantId(),
    workActivityId: uuid('work_activity_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'work_activity_media_pk',
      columns: [t.tenantId, t.workActivityId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'wam_activity_fk',
      columns: [t.tenantId, t.workActivityId],
      foreignColumns: [workActivities.tenantId, workActivities.id],
    }),
    foreignKey({
      name: 'wam_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('wam_sort_order_check', '"sort_order" >= 0'),
    index('wam_media_idx').on(t.tenantId, t.mediaAssetId),
    index('wam_sort_idx').on(t.tenantId, t.workActivityId, t.sortOrder),
  ],
);

export const qualityCheckMedia = pgTable(
  'quality_check_media',
  {
    tenantId: tenantId(),
    qualityCheckId: uuid('quality_check_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'quality_check_media_pk',
      columns: [t.tenantId, t.qualityCheckId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'qcm_quality_check_fk',
      columns: [t.tenantId, t.qualityCheckId],
      foreignColumns: [qualityChecks.tenantId, qualityChecks.id],
    }),
    foreignKey({
      name: 'qcm_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('qcm_sort_order_check', '"sort_order" >= 0'),
    index('qcm_media_idx').on(t.tenantId, t.mediaAssetId),
    index('qcm_sort_idx').on(t.tenantId, t.qualityCheckId, t.sortOrder),
  ],
);

export const deliveryMedia = pgTable(
  'delivery_media',
  {
    tenantId: tenantId(),
    deliveryId: uuid('delivery_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'delivery_media_pk',
      columns: [t.tenantId, t.deliveryId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'delivery_media_delivery_fk',
      columns: [t.tenantId, t.deliveryId],
      foreignColumns: [deliveries.tenantId, deliveries.id],
    }),
    foreignKey({
      name: 'delivery_media_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('delivery_media_sort_order_check', '"sort_order" >= 0'),
    index('delivery_media_media_idx').on(t.tenantId, t.mediaAssetId),
    index('delivery_media_sort_idx').on(t.tenantId, t.deliveryId, t.sortOrder),
  ],
);

/** Se enlaza a la VERSIÓN exacta de cotización, no al quote lógico. */
export const quoteMedia = pgTable(
  'quote_media',
  {
    tenantId: tenantId(),
    quoteVersionId: uuid('quote_version_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'quote_media_pk',
      columns: [t.tenantId, t.quoteVersionId, t.mediaAssetId, t.purpose],
    }),
    foreignKey({
      name: 'quote_media_version_fk',
      columns: [t.tenantId, t.quoteVersionId],
      foreignColumns: [quoteVersions.tenantId, quoteVersions.id],
    }),
    foreignKey({
      name: 'quote_media_media_fk',
      columns: [t.tenantId, t.mediaAssetId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    rawCheck('quote_media_sort_order_check', '"sort_order" >= 0'),
    index('quote_media_media_idx').on(t.tenantId, t.mediaAssetId),
    index('quote_media_sort_idx').on(t.tenantId, t.quoteVersionId, t.sortOrder),
  ],
);

/* ========================================================================== */
/* 16. Acceso público del cliente final                                       */
/* ========================================================================== */

/**
 * Acceso limitado a UNA orden, sin convertir al cliente en `user` ni crear membership.
 * NO reutiliza el token de autorización de cotización: son credenciales separadas para
 * evitar ampliación accidental de privilegios. El endpoint público resuelve primero el
 * token y solo después conoce tenant/orden; nunca acepta `tenant_id` del cliente.
 * `last_accessed_at` es telemetría, no prueba de identidad del titular.
 */
export const customerOrderAccessTokens = pgTable(
  'customer_order_access_tokens',
  {
    id: pk(),
    tenantId: tenantId(),
    orderId: uuid('order_id').notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    accessScope: varchar('access_scope', { length: 24 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    expiresAt: ts('expires_at').notNull(),
    createdByMembershipId: uuid('created_by_membership_id').notNull(),
    revokedAt: ts('revoked_at'),
    revokedByMembershipId: uuid('revoked_by_membership_id'),
    revokeReason: text('revoke_reason'),
    lastAccessedAt: ts('last_accessed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('coat_tenant_id_key').on(t.tenantId, t.id),
    unique('coat_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'coat_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    foreignKey({
      name: 'coat_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('coat_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    foreignKey({
      name: 'coat_revoked_by_fk',
      columns: [t.tenantId, t.revokedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('coat_revoked_by_idx').on(t.tenantId, t.revokedByMembershipId),
    enumCheck('coat_access_scope_check', t.accessScope, ['order_tracking', 'delivery_summary']),
    enumCheck('coat_status_check', t.status, ['active', 'revoked']),
    rawCheck(
      'coat_revoked_check',
      `("status" = 'revoked') = ("revoked_at" IS NOT NULL)`,
    ),
    index('coat_order_idx').on(t.tenantId, t.orderId),
    index('coat_expiry_idx').on(t.expiresAt, t.status),
  ],
);

/* ========================================================================== */
/* 17. Billing SaaS — taller → ILVOX                                          */
/* ========================================================================== */

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: pk(),
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    provider: varchar('provider', { length: 32 }).notNull().default('wompi'),
    providerRef: varchar('provider_ref', { length: 255 }),
    providerPaymentSourceId: varchar('provider_payment_source_id', { length: 255 }),
    status: varchar('status', { length: 16 }).notNull(),
    currentPeriodStart: ts('current_period_start').notNull(),
    currentPeriodEnd: ts('current_period_end').notNull(),
    graceUntil: ts('grace_until'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    cancelledAt: ts('cancelled_at'),
    ...timestamps(),
  },
  (t) => [
    unique('subscriptions_tenant_id_key').on(t.tenantId, t.id),
    enumCheck('subscriptions_provider_check', t.provider, ['wompi', 'manual']),
    enumCheck('subscriptions_status_check', t.status, [
      'trialing',
      'active',
      'past_due',
      'suspended',
      'cancelled',
    ]),
    rawCheck('subscriptions_period_check', '"current_period_end" > "current_period_start"'),
    rawCheck(
      'subscriptions_cancelled_check',
      `("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)`,
    ),
    index('subscriptions_tenant_status_idx').on(t.tenantId, t.status),
    uniqueIndex('subscriptions_provider_ref_uq')
      .on(t.provider, t.providerRef)
      .where(sql`provider_ref IS NOT NULL`),
    // Máximo una suscripción no cancelada por tenant.
    uniqueIndex('subscriptions_one_active_uq')
      .on(t.tenantId)
      .where(sql`status <> 'cancelled'`),
  ],
);

/** Append-only. `UNIQUE(provider, provider_event_id)` da la idempotencia. */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: pk(),
    tenantId: tenantId(),
    subscriptionId: uuid('subscription_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('billing_events_tenant_id_key').on(t.tenantId, t.id),
    unique('billing_events_provider_event_key').on(t.provider, t.providerEventId),
    foreignKey({
      name: 'billing_events_subscription_fk',
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [subscriptions.tenantId, subscriptions.id],
    }),
    index('billing_events_subscription_idx').on(t.tenantId, t.subscriptionId),
  ],
);

/**
 * Pagos del TALLER hacia ILVOX por la suscripción SaaS.
 * `reference` la genera ILVOX server-side y es la correlación primaria con el
 * proveedor: nunca se correlaciona por email ni por monto. Test y producción no se cruzan.
 */
export const payments = pgTable(
  'payments',
  {
    id: pk(),
    tenantId: tenantId(),
    subscriptionId: uuid('subscription_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull().default('wompi'),
    environment: varchar('environment', { length: 16 }).notNull(),
    reference: varchar('reference', { length: 160 }).notNull(),
    providerTransactionId: varchar('provider_transaction_id', { length: 255 }),
    amount: money('amount').notNull(),
    currency: currency(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    paidAt: ts('paid_at'),
    ...timestamps(),
  },
  (t) => [
    unique('payments_tenant_id_key').on(t.tenantId, t.id),
    unique('payments_reference_key').on(t.reference),
    foreignKey({
      name: 'payments_subscription_fk',
      columns: [t.tenantId, t.subscriptionId],
      foreignColumns: [subscriptions.tenantId, subscriptions.id],
    }),
    enumCheck('payments_environment_check', t.environment, ['test', 'production']),
    enumCheck('payments_status_check', t.status, [
      'pending',
      'approved',
      'declined',
      'error',
      'voided',
    ]),
    rawCheck('payments_amount_check', '"amount" > 0'),
    index('payments_subscription_idx').on(t.tenantId, t.subscriptionId),
    uniqueIndex('payments_provider_tx_uq')
      .on(t.provider, t.environment, t.providerTransactionId)
      .where(sql`provider_transaction_id IS NOT NULL`),
  ],
);

/* ========================================================================== */
/* 18. Pagos operativos — cliente final → taller                              */
/* ========================================================================== */

/**
 * Ledger independiente del billing SaaS. Tras `confirmed`, monto/moneda/método/
 * reference/paid_at quedan frozen. Una corrección es `reversed` + nueva fila:
 * nunca un DELETE ni una edición silenciosa. Un pago `reversed` aporta 0 al saldo
 * efectivo aunque sus allocations históricas permanezcan.
 */
export const customerPayments = pgTable(
  'customer_payments',
  {
    id: pk(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    paymentMethod: varchar('payment_method', { length: 24 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    amount: money('amount').notNull(),
    currency: currency(),
    reference: varchar('reference', { length: 160 }),
    receiptNumber: varchar('receipt_number', { length: 80 }),
    idempotencyKey: uuid('idempotency_key'),
    paidAt: ts('paid_at'),
    confirmedAt: ts('confirmed_at'),
    confirmedByMembershipId: uuid('confirmed_by_membership_id'),
    reversedAt: ts('reversed_at'),
    reversedByMembershipId: uuid('reversed_by_membership_id'),
    reversalReason: text('reversal_reason'),
    correctionOfPaymentId: uuid('correction_of_payment_id'),
    recordedByMembershipId: uuid('recorded_by_membership_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('customer_payments_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'customer_payments_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'customer_payments_confirmed_by_fk',
      columns: [t.tenantId, t.confirmedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('customer_payments_confirmed_by_idx').on(t.tenantId, t.confirmedByMembershipId),
    foreignKey({
      name: 'customer_payments_reversed_by_fk',
      columns: [t.tenantId, t.reversedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('customer_payments_reversed_by_idx').on(t.tenantId, t.reversedByMembershipId),
    foreignKey({
      name: 'customer_payments_recorded_by_fk',
      columns: [t.tenantId, t.recordedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('customer_payments_recorded_by_idx').on(t.tenantId, t.recordedByMembershipId),
    // Self-FK tenant-safe: el pago corregido pertenece al mismo taller.
    foreignKey({
      name: 'customer_payments_correction_fk',
      columns: [t.tenantId, t.correctionOfPaymentId],
      foreignColumns: [t.tenantId, t.id],
    }),
    index('customer_payments_correction_idx').on(t.tenantId, t.correctionOfPaymentId),
    enumCheck('customer_payments_method_check', t.paymentMethod, [
      'cash',
      'card',
      'bank_transfer',
      'nequi',
      'daviplata',
      'other',
    ]),
    enumCheck('customer_payments_status_check', t.status, ['pending', 'confirmed', 'reversed']),
    rawCheck('customer_payments_amount_check', '"amount" > 0'),
    // MVP: únicamente COP.
    rawCheck('customer_payments_currency_check', `"currency" = 'COP'`),
    rawCheck(
      'customer_payments_reversed_check',
      `"status" <> 'reversed'
       OR ("reversed_at" IS NOT NULL
           AND "reversed_by_membership_id" IS NOT NULL
           AND "reversal_reason" IS NOT NULL)`,
    ),
    rawCheck(
      'customer_payments_confirmed_check',
      `"status" NOT IN ('confirmed','reversed') OR "confirmed_at" IS NOT NULL`,
    ),
    index('customer_payments_customer_idx').on(t.tenantId, t.customerId),
    uniqueIndex('customer_payments_receipt_uq')
      .on(t.tenantId, t.receiptNumber)
      .where(sql`receipt_number IS NOT NULL`),
    uniqueIndex('customer_payments_idempotency_uq')
      .on(t.tenantId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

/**
 * Append-only e inmutable en MVP: una asignación incorrecta se corrige con
 * reversal + pago corregido. `SUM(allocated_amount) <= customer_payments.amount`
 * se serializa por payment mediante constraint trigger/transacción.
 */
export const customerPaymentAllocations = pgTable(
  'customer_payment_allocations',
  {
    id: pk(),
    tenantId: tenantId(),
    customerPaymentId: uuid('customer_payment_id').notNull(),
    orderId: uuid('order_id').notNull(),
    allocatedAmount: money('allocated_amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cpa_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'cpa_payment_fk',
      columns: [t.tenantId, t.customerPaymentId],
      foreignColumns: [customerPayments.tenantId, customerPayments.id],
    }),
    foreignKey({
      name: 'cpa_order_fk',
      columns: [t.tenantId, t.orderId],
      foreignColumns: [serviceOrders.tenantId, serviceOrders.id],
    }),
    rawCheck('cpa_allocated_amount_check', '"allocated_amount" > 0'),
    index('cpa_payment_idx').on(t.tenantId, t.customerPaymentId),
    index('cpa_order_idx').on(t.tenantId, t.orderId),
  ],
);

/**
 * Evidencia de conciliación INTERNA del ledger, no certificación de settlement
 * bancario externo. Detecta drift y JAMÁS corrige automáticamente: emite issue
 * y exige un comando autorizado.
 */
export const customerPaymentReconciliationRuns = pgTable(
  'customer_payment_reconciliation_runs',
  {
    id: pk(),
    tenantId: tenantId(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    runSource: varchar('run_source', { length: 16 }).notNull(),
    initiatedByMembershipId: uuid('initiated_by_membership_id'),
    status: varchar('status', { length: 16 }).notNull(),
    confirmedTotal: money('confirmed_total').notNull().default(sql`0`),
    allocatedTotal: money('allocated_total').notNull().default(sql`0`),
    unallocatedTotal: money('unallocated_total').notNull().default(sql`0`),
    reversedTotal: money('reversed_total').notNull().default(sql`0`),
    discrepancyCount: integer('discrepancy_count').notNull().default(0),
    detailsJson: jsonb('details_json'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('cprr_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'cprr_initiated_by_fk',
      columns: [t.tenantId, t.initiatedByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('cprr_initiated_by_idx').on(t.tenantId, t.initiatedByMembershipId),
    enumCheck('cprr_run_source_check', t.runSource, ['scheduled', 'manual']),
    enumCheck('cprr_status_check', t.status, ['ok', 'issues']),
    rawCheck('cprr_period_check', '"period_end" > "period_start"'),
    rawCheck('cprr_window_check', '"finished_at" >= "started_at"'),
    rawCheck(
      'cprr_totals_check',
      '"confirmed_total" >= 0 AND "allocated_total" >= 0 AND "unallocated_total" >= 0 AND "reversed_total" >= 0 AND "discrepancy_count" >= 0',
    ),
    rawCheck(
      'cprr_manual_actor_check',
      `"run_source" <> 'manual' OR "initiated_by_membership_id" IS NOT NULL`,
    ),
    index('cprr_period_idx').on(t.tenantId, t.periodEnd.desc()),
  ],
);

/* ========================================================================== */
/* 19. Privacidad / Habeas Data                                               */
/* ========================================================================== */

/**
 * Fuente de verdad de la autorización por finalidad (reemplaza cualquier booleano
 * CRM tipo `whatsapp_opt_in`). Revocar exige `revoked_at`; reautorizar crea una
 * NUEVA fila, no reactiva la antigua.
 */
export const privacyConsents = pgTable(
  'privacy_consents',
  {
    id: pk(),
    tenantId: tenantId(),
    customerId: uuid('customer_id').notNull(),
    purposeCode: varchar('purpose_code', { length: 80 }).notNull(),
    privacyNoticeVersion: varchar('privacy_notice_version', { length: 40 }).notNull(),
    authorizationTextVersion: varchar('authorization_text_version', { length: 40 }).notNull(),
    channel: varchar('channel', { length: 24 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('granted'),
    capturedAt: ts('captured_at').notNull(),
    revokedAt: ts('revoked_at'),
    evidenceHash: varchar('evidence_hash', { length: 128 }),
    evidenceMediaId: uuid('evidence_media_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdByMembershipId: uuid('created_by_membership_id'),
    ...timestamps(),
  },
  (t) => [
    unique('privacy_consents_tenant_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'privacy_consents_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'privacy_consents_evidence_media_fk',
      columns: [t.tenantId, t.evidenceMediaId],
      foreignColumns: [mediaAssets.tenantId, mediaAssets.id],
    }),
    foreignKey({
      name: 'privacy_consents_created_by_fk',
      columns: [t.tenantId, t.createdByMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('privacy_consents_created_by_idx').on(t.tenantId, t.createdByMembershipId),
    enumCheck('privacy_consents_channel_check', t.channel, [
      'web',
      'in_person',
      'whatsapp',
      'email',
      'phone',
      'import',
      'other',
    ]),
    enumCheck('privacy_consents_status_check', t.status, ['granted', 'revoked']),
    rawCheck(
      'privacy_consents_revoked_check',
      `("status" = 'revoked') = ("revoked_at" IS NOT NULL)`,
    ),
    index('privacy_consents_lookup_idx').on(
      t.tenantId,
      t.customerId,
      t.purposeCode,
      t.status,
    ),
    index('privacy_consents_evidence_media_idx').on(t.tenantId, t.evidenceMediaId),
    uniqueIndex('privacy_consents_one_granted_uq')
      .on(t.tenantId, t.customerId, t.purposeCode)
      .where(sql`status = 'granted'`),
  ],
);

/**
 * MIXED-SCOPE: ILVOX también puede actuar como Responsable propio. No recibe una
 * policy RLS ciega `tenant_id = current_tenant`; el acceso pasa por un resolver
 * mixed-scope.
 */
export const dataSubjectRequests = pgTable(
  'data_subject_requests',
  {
    id: pk(),
    controllerScope: varchar('controller_scope', { length: 16 }).notNull(),
    tenantId: tenantIdNullable(),
    customerId: uuid('customer_id'),
    userId: uuid('user_id').references(() => users.id),
    subjectReference: varchar('subject_reference', { length: 255 }),
    requestType: varchar('request_type', { length: 16 }).notNull(),
    status: varchar('status', { length: 24 }).notNull().default('received'),
    receivedAt: ts('received_at').notNull(),
    dueAt: ts('due_at').notNull(),
    resolvedAt: ts('resolved_at'),
    resolution: text('resolution'),
    evidenceReference: text('evidence_reference'),
    assignedToReference: varchar('assigned_to_reference', { length: 160 }),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'dsr_customer_fk',
      columns: [t.tenantId, t.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    enumCheck('dsr_controller_scope_check', t.controllerScope, ['tenant', 'ilvox']),
    enumCheck('dsr_request_type_check', t.requestType, [
      'consult',
      'update',
      'correct',
      'delete',
      'revoke',
    ]),
    enumCheck('dsr_status_check', t.status, [
      'received',
      'in_review',
      'awaiting_information',
      'resolved',
      'rejected',
    ]),
    rawCheck(
      'dsr_scope_check',
      `("controller_scope" = 'tenant') = ("tenant_id" IS NOT NULL)`,
    ),
    // `customer_id` solo tiene sentido en scope tenant.
    rawCheck(
      'dsr_customer_scope_check',
      `"customer_id" IS NULL OR "controller_scope" = 'tenant'`,
    ),
    // Debe existir al menos un identificador del titular/caso.
    rawCheck(
      'dsr_subject_identifier_check',
      '"customer_id" IS NOT NULL OR "user_id" IS NOT NULL OR "subject_reference" IS NOT NULL',
    ),
    rawCheck(
      'dsr_resolution_check',
      `(("status" IN ('resolved','rejected')) = ("resolved_at" IS NOT NULL))
       AND ("status" NOT IN ('resolved','rejected') OR "resolution" IS NOT NULL)`,
    ),
    index('dsr_scope_status_idx').on(t.controllerScope, t.status),
    index('dsr_tenant_idx').on(t.tenantId),
    index('dsr_customer_idx').on(t.tenantId, t.customerId),
  ],
);

/** MIXED-SCOPE. Un incidente de scope ILVOX nunca se expone al tenant por RLS genérica. */
export const privacySecurityIncidents = pgTable(
  'privacy_security_incidents',
  {
    id: pk(),
    controllerScope: varchar('controller_scope', { length: 16 }).notNull(),
    tenantId: tenantIdNullable(),
    detectedAt: ts('detected_at').notNull(),
    reportedInternallyAt: ts('reported_internally_at').notNull(),
    systemsAffected: text('systems_affected').array().notNull(),
    categoriesOfData: text('categories_of_data').array().notNull(),
    estimatedRecords: integer('estimated_records'),
    riskLevel: varchar('risk_level', { length: 16 }).notNull(),
    containmentActions: text('containment_actions'),
    sicReportRequired: boolean('sic_report_required').notNull().default(false),
    sicReportedAt: ts('sic_reported_at'),
    status: varchar('status', { length: 20 }).notNull().default('open'),
    postmortemReference: text('postmortem_reference'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('psi_controller_scope_check', t.controllerScope, ['tenant', 'ilvox']),
    enumCheck('psi_risk_level_check', t.riskLevel, ['low', 'medium', 'high', 'critical']),
    enumCheck('psi_status_check', t.status, [
      'open',
      'investigating',
      'contained',
      'resolved',
      'closed',
    ]),
    rawCheck(
      'psi_scope_check',
      `("controller_scope" = 'tenant') = ("tenant_id" IS NOT NULL)`,
    ),
    rawCheck('psi_estimated_records_check', '"estimated_records" >= 0'),
    // Si se reportó a la SIC, el reporte era obligatorio.
    rawCheck(
      'psi_sic_report_check',
      '"sic_reported_at" IS NULL OR "sic_report_required" = true',
    ),
    index('psi_scope_status_idx').on(t.controllerScope, t.status),
    index('psi_tenant_idx').on(t.tenantId),
  ],
);

/**
 * Append-only. NO se persiste un `superseded` mutable: el estado efectivo se deriva
 * de la existencia de una aceptación posterior aplicable del mismo `document_type`.
 * Es distinta de `privacy_consents`: aquí se aceptan documentos jurídicos.
 */
export const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    id: pk(),
    acceptanceScope: varchar('acceptance_scope', { length: 16 }).notNull(),
    tenantId: tenantIdNullable(),
    acceptedByUserId: uuid('accepted_by_user_id').notNull().references(() => users.id),
    documentType: varchar('document_type', { length: 32 }).notNull(),
    documentVersion: varchar('document_version', { length: 40 }).notNull(),
    documentHash: varchar('document_hash', { length: 128 }).notNull(),
    acceptedAt: ts('accepted_at').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    channel: varchar('channel', { length: 24 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck('legal_acceptances_scope_check', t.acceptanceScope, ['global_user', 'tenant']),
    enumCheck('legal_acceptances_document_type_check', t.documentType, [
      'terms',
      'privacy_policy',
      'dpa',
      'commercial_terms',
      'other',
    ]),
    enumCheck('legal_acceptances_channel_check', t.channel, ['web', 'admin', 'import', 'other']),
    rawCheck(
      'legal_acceptances_scope_tenant_check',
      `("acceptance_scope" = 'tenant') = ("tenant_id" IS NOT NULL)`,
    ),
    index('legal_acceptances_user_idx').on(t.acceptedByUserId, t.documentType),
    index('legal_acceptances_tenant_idx').on(t.tenantId),
    uniqueIndex('legal_acceptances_tenant_uq')
      .on(t.tenantId, t.acceptedByUserId, t.documentType, t.documentVersion)
      .where(sql`tenant_id IS NOT NULL`),
    uniqueIndex('legal_acceptances_global_uq')
      .on(t.acceptedByUserId, t.documentType, t.documentVersion)
      .where(sql`tenant_id IS NULL`),
  ],
);

/* ========================================================================== */
/* 20. Plataforma                                                             */
/* ========================================================================== */

/**
 * Envelope externo 100% inmutable. No lleva contadores ni estado mutable de
 * procesamiento: eso vive en `webhook_processing_attempts`.
 * `payload_hash = sha256(raw_body_bytes)`.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: pk(),
    provider: varchar('provider', { length: 32 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 128 }).notNull(),
    tenantId: tenantIdNullable(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    payloadJson: jsonb('payload_json').notNull(),
    headersJson: jsonb('headers_json'),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [
    unique('webhook_events_provider_event_key').on(t.provider, t.providerEventId),
    index('webhook_events_tenant_idx').on(t.tenantId),
    index('webhook_events_received_idx').on(t.receivedAt.desc()),
  ],
);

/** Los reintentos se registran aquí; `webhook_events` nunca se modifica para reintentar. */
export const webhookProcessingAttempts = pgTable(
  'webhook_processing_attempts',
  {
    id: pk(),
    webhookEventId: uuid('webhook_event_id').notNull().references(() => webhookEvents.id),
    attemptNumber: integer('attempt_number').notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    lastErrorCode: varchar('last_error_code', { length: 120 }),
    lastErrorMessage: text('last_error_message'),
    workerId: varchar('worker_id', { length: 160 }),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('wpa_event_attempt_key').on(t.webhookEventId, t.attemptNumber),
    enumCheck('wpa_status_check', t.status, [
      'processing',
      'succeeded',
      'retryable_error',
      'permanent_error',
    ]),
    rawCheck('wpa_attempt_number_check', '"attempt_number" > 0'),
    index('wpa_event_idx').on(t.webhookEventId),
  ],
);

/**
 * `idempotency_key` es obligatorio para eventos que despachan un efecto externo
 * sensible a duplicados (p. ej. `communication.whatsapp_template_requested`).
 * `payload_json` es contrato interno: nunca token público crudo ni OTP.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: pk(),
    tenantId: tenantIdNullable(),
    aggregateType: varchar('aggregate_type', { length: 80 }).notNull(),
    aggregateId: uuid('aggregate_id'),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    eventVersion: smallint('event_version').notNull().default(1),
    payloadJson: jsonb('payload_json').notNull(),
    idempotencyKey: uuid('idempotency_key'),
    status: varchar('status', { length: 24 }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('outbox_events_status_check', t.status, [
      'pending',
      'processing',
      'processed',
      'failed',
      'dead_letter',
    ]),
    rawCheck('outbox_events_event_version_check', '"event_version" > 0'),
    rawCheck('outbox_events_attempts_check', '"attempts" >= 0'),
    // Índice de claim del worker.
    index('outbox_events_worker_idx').on(t.status, t.availableAt),
    index('outbox_events_tenant_idx').on(t.tenantId),
    uniqueIndex('outbox_events_idempotency_uq')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);

/**
 * El actor canónico es `membership_id`, no un `user_id` suelto. Toda operación
 * sincronizada vuelve a pasar RBAC, TenantContext, RLS y guards de dominio:
 * el cliente offline nunca se convierte en autoridad. `client_created_at` es
 * informativo y no decide ordering ni autorización.
 */
export const syncOperations = pgTable(
  'sync_operations',
  {
    id: pk(),
    tenantId: tenantId(),
    operationId: uuid('operation_id').notNull(),
    deviceId: varchar('device_id', { length: 160 }),
    membershipId: uuid('membership_id').notNull(),
    operationType: varchar('operation_type', { length: 80 }).notNull(),
    entityType: varchar('entity_type', { length: 80 }).notNull(),
    entityId: uuid('entity_id'),
    baseVersion: integer('base_version'),
    status: varchar('status', { length: 24 }).notNull(),
    resultJson: jsonb('result_json'),
    clientCreatedAt: ts('client_created_at'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [
    unique('sync_operations_tenant_id_key').on(t.tenantId, t.id),
    unique('sync_operations_operation_key').on(t.tenantId, t.operationId),
    foreignKey({
      name: 'sync_operations_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    enumCheck('sync_operations_status_check', t.status, [
      'queued',
      'syncing',
      'applied',
      'conflict',
      'retryable_error',
      'permanent_error',
    ]),
    rawCheck('sync_operations_base_version_check', '"base_version" > 0'),
    index('sync_operations_membership_idx').on(t.tenantId, t.membershipId),
  ],
);

/**
 * Append-only. `before/after/metadata` son allowlisted y minimizados: sin secretos,
 * sin token hashes/OTP/JWT, sin PAN/CVV, sin blobs ni media.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    tenantId: tenantIdNullable(),
    actorType: varchar('actor_type', { length: 16 }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    actorMembershipId: uuid('actor_membership_id'),
    action: varchar('action', { length: 120 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    entityType: varchar('entity_type', { length: 80 }).notNull(),
    entityId: uuid('entity_id'),
    reasonCode: varchar('reason_code', { length: 120 }),
    beforeJson: jsonb('before_json'),
    afterJson: jsonb('after_json'),
    metadataJson: jsonb('metadata_json'),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    traceId: varchar('trace_id', { length: 64 }),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'audit_logs_actor_membership_fk',
      columns: [t.tenantId, t.actorMembershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    index('audit_logs_actor_membership_idx').on(t.tenantId, t.actorMembershipId),
    enumCheck('audit_logs_actor_type_check', t.actorType, [
      'user',
      'system',
      'provider',
      'platform',
    ]),
    enumCheck('audit_logs_outcome_check', t.outcome, ['success', 'denied', 'failed']),
    index('audit_logs_tenant_created_idx').on(t.tenantId, t.createdAt.desc()),
    index('audit_logs_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt.desc(),
    ),
    index('audit_logs_request_idx').on(t.requestId),
    index('audit_logs_trace_idx').on(t.traceId),
  ],
);

/**
 * Lifecycle EFECTIVO derivado (`disabled | scheduled | active | expired`) desde
 * `enabled`, `enabled_from` y `enabled_until`: no se persiste un `status` adicional.
 * Precedencia `tenant > plan > global > default de código`; un `enabled=false` más
 * específico es override OFF y bloquea el fallback. `value_json` usa semántica
 * REPLACE de la fila ganadora: no hay deep-merge entre scopes.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: pk(),
    tenantId: tenantIdNullable(),
    planId: uuid('plan_id').references(() => plans.id),
    featureKey: varchar('feature_key', { length: 120 }).notNull(),
    scope: varchar('scope', { length: 16 }).notNull(),
    enabled: boolean('enabled').notNull(),
    valueJson: jsonb('value_json'),
    enabledFrom: ts('enabled_from'),
    enabledUntil: ts('enabled_until'),
    ...timestamps(),
  },
  (t) => [
    enumCheck('feature_flags_scope_check', t.scope, ['global', 'plan', 'tenant']),
    rawCheck(
      'feature_flags_scope_semantics_check',
      `("scope" = 'global' AND "tenant_id" IS NULL AND "plan_id" IS NULL)
       OR ("scope" = 'plan' AND "tenant_id" IS NULL AND "plan_id" IS NOT NULL)
       OR ("scope" = 'tenant' AND "tenant_id" IS NOT NULL AND "plan_id" IS NULL)`,
    ),
    rawCheck(
      'feature_flags_window_check',
      '"enabled_until" IS NULL OR "enabled_from" IS NULL OR "enabled_until" > "enabled_from"',
    ),
    uniqueIndex('feature_flags_global_uq')
      .on(t.featureKey)
      .where(sql`scope = 'global'`),
    uniqueIndex('feature_flags_plan_uq')
      .on(t.planId, t.featureKey)
      .where(sql`scope = 'plan'`),
    uniqueIndex('feature_flags_tenant_uq')
      .on(t.tenantId, t.featureKey)
      .where(sql`scope = 'tenant'`),
  ],
);
