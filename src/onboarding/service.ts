import type postgres from 'postgres';
import { ApiError } from '../api/app.js';
import type { VerifiedIdentity } from '../identity/identity-provider.js';
import { uuidV7 } from '../platform/uuid-v7.js';
import { createWorkshopSlug } from './slug.js';
import type { OnboardingRequest, VerifiedProfileInput } from './validation.js';

interface ProvisionedUserRow {
  user_id: string;
  user_status: 'active' | 'disabled';
  created: boolean;
}

interface ActiveMembershipRow {
  user_id: string;
  membership_id: string;
  tenant_id: string;
}

interface OwnerRoleRow {
  id: string;
}

export interface OnboardingResult {
  request_id: string;
  workshop: { id: string; slug: string; status: 'trialing' };
  primaryLocation: { id: string; isPrimary: true };
  membership: { id: string; status: 'active'; role: 'owner' };
}

export interface CreateWorkshopInput {
  database: postgres.Sql;
  identity: VerifiedIdentity;
  profile: VerifiedProfileInput;
  payload: OnboardingRequest;
  requestId: string;
  slugFactory?: (displayName: string) => string;
}

interface DatabaseError {
  code?: string;
  constraint_name?: string;
}

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
    const sql = await input.database.reserve();
    const tenantId = uuidV7();
    const locationId = uuidV7();
    const membershipId = uuidV7();
    const proposedUserId = uuidV7();
    const slug = slugFactory(input.payload.workshop.displayName);

    try {
      await sql.unsafe('BEGIN');
      await sql`
        SELECT
          set_config('lock_timeout', '1500ms', true),
          set_config('statement_timeout', '10s', true),
          set_config('idle_in_transaction_session_timeout', '10s', true)
      `;

      const users = await sql<ProvisionedUserRow[]>`
        SELECT user_id, user_status, created
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

      await sql`
        INSERT INTO public.workshops (
          id, slug, legal_name, display_name, tax_id, phone, email,
          timezone, currency, status
        ) VALUES (
          ${tenantId}, ${slug}, ${input.payload.workshop.legalName},
          ${input.payload.workshop.displayName}, ${input.payload.workshop.taxId ?? null},
          ${input.payload.workshop.phone ?? null}, ${input.payload.workshop.email ?? null},
          ${input.payload.workshop.timezone}, ${input.payload.workshop.currency}, 'trialing'
        )
      `;

      await sql`
        INSERT INTO public.workshop_locations (
          id, tenant_id, name, address_line, city, department,
          country_code, phone, is_primary
        ) VALUES (
          ${locationId}, ${tenantId}, ${input.payload.primaryLocation.name},
          ${input.payload.primaryLocation.addressLine}, ${input.payload.primaryLocation.city},
          ${input.payload.primaryLocation.department}, ${input.payload.primaryLocation.countryCode},
          ${input.payload.primaryLocation.phone ?? null}, true
        )
      `;

      await sql`
        INSERT INTO public.memberships (id, tenant_id, user_id, status)
        VALUES (${membershipId}, ${tenantId}, ${user.user_id}, 'active')
      `;

      await sql`
        INSERT INTO public.membership_roles (
          tenant_id, membership_id, role_id, assigned_by_membership_id
        ) VALUES (${tenantId}, ${membershipId}, ${ownerRoleId}, ${membershipId})
      `;

      await sql`
        INSERT INTO public.audit_logs (
          id, tenant_id, actor_type, actor_user_id, actor_membership_id,
          action, outcome, entity_type, entity_id, after_json, request_id
        ) VALUES
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'workshop.created', 'success', 'workshop', ${tenantId},
            ${JSON.stringify({ status: 'trialing' })}::jsonb, ${input.requestId}
          ),
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'membership.activated', 'success', 'membership', ${membershipId},
            ${JSON.stringify({ status: 'active' })}::jsonb, ${input.requestId}
          ),
          (
            ${uuidV7()}, ${tenantId}, 'user', ${user.user_id}, ${membershipId},
            'role.assigned', 'success', 'membership_role', ${membershipId},
            ${JSON.stringify({ role_code: 'owner' })}::jsonb, ${input.requestId}
          )
      `;

      await sql.unsafe('COMMIT');
      sql.release();

      return {
        request_id: input.requestId,
        workshop: { id: tenantId, slug, status: 'trialing' },
        primaryLocation: { id: locationId, isPrimary: true },
        membership: { id: membershipId, status: 'active', role: 'owner' },
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
