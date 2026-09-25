import type postgres from 'postgres';
import { ApiError } from '../api/app.js';
import type { VerifiedIdentity } from '../identity/identity-provider.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { createWorkshopSlug } from './slug.js';
import type { OnboardingRequest, VerifiedProfileInput } from './validation.js';

interface ProvisionedUserRow {
  user_id: string;
  user_status: 'active' | 'disabled';
  provisioned: boolean;
}

interface ActiveMembershipRow {
  user_id: string;
  membership_id: string;
  tenant_id: string;
}

interface OwnerRoleRow {
  id: string;
}

interface WorkshopRow {
  id: string;
  slug: string;
  legal_name: string;
  display_name: string;
  status: string;
  timezone: string;
  currency: string;
}

interface WorkshopLocationRow {
  id: string;
  name: string;
  city: string;
  department: string;
  country_code: string;
  is_primary: boolean;
}

interface MembershipRow {
  id: string;
  status: string;
}

export interface OnboardingResult {
  workshop: {
    id: string;
    slug: string;
    legalName: string;
    displayName: string;
    status: string;
    timezone: string;
    currency: string;
  };
  primaryLocation: {
    id: string;
    name: string;
    city: string;
    department: string;
    countryCode: string;
    isPrimary: true;
  };
  membership: { id: string; status: string; roles: ['owner'] };
}

export interface CreateWorkshopInput {
  database: postgres.Sql;
  identity: VerifiedIdentity;
  profile: VerifiedProfileInput;
  payload: OnboardingRequest;
  requestId: string;
  /** Socket-derived. Client free-form headers (User-Agent, ...) are never audited. */
  ipAddress: string;
  slugFactory?: (displayName: string) => string;
}

interface DatabaseError {
  code?: string;
  constraint_name?: string;
}

/** Audit contract for the onboarding domain commands (LOW-02): every event carries this reason. */
const REASON_CODE_WORKSHOP_ONBOARDING = 'workshop_onboarding';

function isDatabaseError(error: unknown, code: string, constraint?: string): boolean {
  const candidate = error as DatabaseError;
  return candidate?.code === code && (!constraint || candidate.constraint_name === constraint);
}

async function rollbackAndRelease(sql: postgres.ReservedSql): Promise<void> {
  try {
    await sql.unsafe('ROLLBACK');
  } catch {
    // PostgreSQL may already have ended the transaction after a failed COMMIT.
  } finally {
    sql.release();
  }
}

export async function createWorkshopForIdentity(input: CreateWorkshopInput): Promise<OnboardingResult> {
  const slugFactory = input.slugFactory ?? createWorkshopSlug;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // LOW-01: every value below is pure/local and can throw (slugFactory is
    // caller-injectable) or is otherwise fallible without touching the
    // database. All of it must be resolved BEFORE `reserve()` so that a
    // connection is never acquired without an immediately-following `try`
    // that guarantees its release.
    const tenantId = uuidV7();
    const locationId = uuidV7();
    const membershipId = uuidV7();
    const proposedUserId = uuidV7();
    const slug = slugFactory(input.payload.workshop.displayName);

    const sql = await input.database.reserve();
    try {
      await sql.unsafe('BEGIN');
      await sql`
        SELECT
          set_config('lock_timeout', '1500ms', true),
          set_config('statement_timeout', '10s', true),
          set_config('idle_in_transaction_session_timeout', '10s', true)
      `;

      const users = await sql<ProvisionedUserRow[]>`
        SELECT user_id, user_status, provisioned
        FROM app.bootstrap_provision_user(
          ${input.identity.identityProvider},
          ${input.identity.externalSubject},
          ${proposedUserId}::uuid,
          ${input.profile.email},
          ${input.profile.fullName},
          ${input.requestId}
        )
      `;
      const user = users[0];
      if (!user) throw new Error('BOOTSTRAP_USER_RESULT_MISSING');
      if (user.user_status === 'disabled') {
        throw new ApiError(403, 'USER_DISABLED', 'The user is disabled.');
      }

      // Separate statements are intentional: acquire serialization first,
      // then take a fresh READ COMMITTED snapshot for the membership re-check.
      await sql`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${'tallermecario:onboarding:user:' + user.user_id}, 0)
        )
      `;

      const memberships = await sql<ActiveMembershipRow[]>`
        SELECT user_id, membership_id, tenant_id
        FROM app.bootstrap_list_active_memberships(
          ${input.identity.identityProvider},
          ${input.identity.externalSubject}
        )
      `;
      if (memberships.length > 0) {
        throw new ApiError(409, 'ONBOARDING_ALREADY_COMPLETED', 'Onboarding has already been completed.');
      }

      const ownerRoles = await sql<OwnerRoleRow[]>`
        SELECT id
        FROM public.roles
        WHERE code = 'owner' AND scope = 'tenant' AND is_system = true
      `;
      if (ownerRoles.length !== 1) throw new Error('OWNER_ROLE_NOT_CONFIGURED');
      const ownerRoleId = ownerRoles[0].id;

      await sql`
        SELECT
          set_config('app.tenant_id', ${tenantId}, true),
          set_config('app.user_id', ${user.user_id}, true),
          set_config('app.membership_id', ${membershipId}, true),
          set_config('app.request_id', ${input.requestId}, true)
      `;

      const [workshop] = await sql<WorkshopRow[]>`
        INSERT INTO public.workshops (
          id, slug, legal_name, display_name, tax_id, phone, email, status
        ) VALUES (
          ${tenantId}, ${slug}, ${input.payload.workshop.legalName},
          ${input.payload.workshop.displayName}, ${input.payload.workshop.taxId ?? null},
          ${input.payload.workshop.phone ?? null}, ${input.payload.workshop.email ?? null},
          'trialing'
        )
        RETURNING id, slug, legal_name, display_name, status, timezone, currency
      `;
      if (!workshop) throw new Error('WORKSHOP_INSERT_RESULT_MISSING');

      const [location] = await sql<WorkshopLocationRow[]>`
        INSERT INTO public.workshop_locations (
          id, tenant_id, name, address_line, city, department,
          phone, is_primary
        ) VALUES (
          ${locationId}, ${tenantId}, ${input.payload.primaryLocation.name},
          ${input.payload.primaryLocation.addressLine}, ${input.payload.primaryLocation.city},
          ${input.payload.primaryLocation.department},
          ${input.payload.primaryLocation.phone ?? null}, true
        )
        RETURNING id, name, city, department, country_code, is_primary
      `;
      if (!location) throw new Error('WORKSHOP_LOCATION_INSERT_RESULT_MISSING');

      const [membership] = await sql<MembershipRow[]>`
        INSERT INTO public.memberships (id, tenant_id, user_id, status)
        VALUES (${membershipId}, ${tenantId}, ${user.user_id}, 'active')
        RETURNING id, status
      `;
      if (!membership) throw new Error('MEMBERSHIP_INSERT_RESULT_MISSING');

      await sql`
        INSERT INTO public.membership_roles (
          tenant_id, membership_id, role_id, assigned_by_membership_id
        ) VALUES (${tenantId}, ${membershipId}, ${ownerRoleId}, ${membershipId})
      `;

      // LOW-02: exact allowlisted keys per event, plus the shared
      // reason_code -- see the S1-01 audit's approved audit contract.
      //
      // `sql.json(...)`, not `${JSON.stringify(...)}::jsonb`: postgres.js
      // tags a `sql.json()` parameter with the jsonb OID end-to-end, so the
      // driver both serializes it correctly and parses the column back into
      // an object on every future read. A plain string parameter cast with
      // `::jsonb` in SQL text serializes fine on write, but the driver then
      // reads that column back as a raw JSON *string*, not an object --
      // silently wrong for every consumer of these audit rows.
      await sql`
        INSERT INTO public.audit_logs (
          id, tenant_id, actor_type, actor_user_id, actor_membership_id,
          action, outcome, entity_type, entity_id, reason_code,
          before_json, after_json, metadata_json, request_id,
          ip_address
        ) VALUES
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'workshop.created', 'success', 'workshop', ${tenantId},
            ${REASON_CODE_WORKSHOP_ONBOARDING},
            NULL,
            ${sql.json({
              status: workshop.status,
              timezone: workshop.timezone,
              currency: workshop.currency,
              primary_location_id: location.id,
            })},
            NULL,
            ${input.requestId}, ${input.ipAddress}::inet
          ),
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'membership.activated', 'success', 'membership', ${membershipId},
            ${REASON_CODE_WORKSHOP_ONBOARDING},
            NULL,
            ${sql.json({ status: membership.status, user_id: user.user_id })},
            NULL,
            ${input.requestId}, ${input.ipAddress}::inet
          ),
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'role.assigned', 'success', 'membership_role', ${membershipId},
            ${REASON_CODE_WORKSHOP_ONBOARDING},
            ${sql.json({ roles: [] })},
            ${sql.json({ roles: ['owner'] })},
            ${sql.json({ assigned_by_membership_id: membershipId, bootstrap: true })},
            ${input.requestId}, ${input.ipAddress}::inet
          )
      `;

      await sql.unsafe('COMMIT');
      sql.release();

      return {
        workshop: {
          id: workshop.id,
          slug: workshop.slug,
          legalName: workshop.legal_name,
          displayName: workshop.display_name,
          status: workshop.status,
          timezone: workshop.timezone,
          currency: workshop.currency,
        },
        primaryLocation: {
          id: location.id,
          name: location.name,
          city: location.city,
          department: location.department,
          countryCode: location.country_code,
          isPrimary: true,
        },
        membership: { id: membership.id, status: membership.status, roles: ['owner'] },
      };
    } catch (error) {
      await rollbackAndRelease(sql);

      if (isDatabaseError(error, '55P03')) {
        throw new ApiError(409, 'ONBOARDING_IN_PROGRESS', 'Onboarding is already in progress.');
      }
      if (isDatabaseError(error, '23505', 'workshops_slug_key') && attempt < 3) {
        continue;
      }
      throw error;
    }
  }

  throw new Error('ONBOARDING_SLUG_RETRY_EXHAUSTED');
}
