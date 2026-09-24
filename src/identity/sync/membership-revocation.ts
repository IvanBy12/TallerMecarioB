/**
 * Domain command `revokeMembershipForDeletedIdentity` (outbox job
 * `identity.membership_revocation_requested`, one per tenant, fanned out by
 * app.identity_sync_apply when a provider identity is tombstoned).
 *
 * Runs inside the worker's tenant-scoped transaction (app.tenant_id = the
 * job's tenant) as tallermecario_worker under RLS (ADR-009 §9): it can only
 * see and change memberships of that tenant.
 *
 * Last-owner invariant (RBAC §16: every workshop keeps at least one ACTIVE
 * owner membership): the tenant owner-set lock (0012) is taken first, then all
 * owner memberships of the tenant are locked in id order, so two concurrent
 * deletions of the only two owners serialize and the second one observes the
 * first revocation (the 0012 memberships trigger enforces it in PostgreSQL). The last active owner
 * membership is kept for structural integrity (audited as denied); the user
 * behind it is already `disabled`, so it grants no access.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { uuidV7 } from '../../platform/uuid-v7.js';
import { PermanentDispatchError, type OutboxHandler } from '../../worker/outbox-worker.js';

export const MEMBERSHIP_REVOCATION_EVENT_TYPE = 'identity.membership_revocation_requested';
const REASON = 'identity_provider_user_deleted';

const revocationPayloadSchema = z.object({
  type: z.literal(MEMBERSHIP_REVOCATION_EVENT_TYPE),
  version: z.literal(1),
  reason: z.literal(REASON),
  user_id: z.uuid(),
  membership_id: z.uuid(),
  webhook_event_id: z.uuid(),
}).strict();

export type MembershipRevocationOutcome = 'revoked' | 'kept_last_owner' | 'already_revoked' | 'not_found';

export interface MembershipRevocationOptions {
  readonly onOutcome?: (outcome: { membershipId: string; outcome: MembershipRevocationOutcome }) => void;
}

interface OwnerRow { id: string; status: string }
interface TargetRow { id: string; user_id: string; status: string }

async function audit(
  tx: postgres.ReservedSql,
  input: {
    tenantId: string;
    membershipId: string;
    outcome: 'success' | 'denied';
    reasonCode: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
    requestId: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO public.audit_logs (
      id, tenant_id, actor_type, actor_user_id, actor_membership_id,
      action, outcome, entity_type, entity_id, reason_code,
      before_json, after_json, metadata_json, request_id
    ) VALUES (
      ${uuidV7()}, ${input.tenantId}, 'provider', NULL, NULL,
      'membership.revoked', ${input.outcome}, 'membership', ${input.membershipId}, ${input.reasonCode},
      ${input.before ? tx.json(input.before as postgres.JSONValue) : null},
      ${input.after ? tx.json(input.after as postgres.JSONValue) : null},
      ${tx.json(input.metadata as postgres.JSONValue)},
      ${input.requestId}
    )
  `;
}

export function createMembershipRevocationHandler(options: MembershipRevocationOptions = {}): OutboxHandler {
  return async (event, tx) => {
    if (event.tenantId === null) throw new PermanentDispatchError('MEMBERSHIP_REVOCATION_TENANT_REQUIRED');
    const parsed = revocationPayloadSchema.safeParse(event.payload);
    if (!parsed.success || event.aggregateId !== parsed.data.membership_id) {
      throw new PermanentDispatchError('MEMBERSHIP_REVOCATION_PAYLOAD_INVALID');
    }
    const payload = parsed.data;
    const report = (outcome: MembershipRevocationOutcome) =>
      options.onOutcome?.({ membershipId: payload.membership_id, outcome });

    // S1-05 audit fix: take the tenant owner-set lock (0012) BEFORE any row
    // lock, in the same order as the role commands (no lock-order deadlock).
    // The owner list below is then read on a snapshot taken after the wait,
    // so a concurrent owner-role removal that committed meanwhile is seen.
    // The 0012 memberships trigger re-checks the invariant in PostgreSQL.
    await tx`SELECT app.lock_tenant_owner_set(app.current_tenant_id())`;

    const owners = await tx<OwnerRow[]>`
      SELECT m.id, m.status
      FROM public.memberships AS m
      JOIN public.membership_roles AS mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
      JOIN public.roles AS r ON r.id = mr.role_id
      WHERE m.tenant_id = app.current_tenant_id() AND r.code = 'owner'
      ORDER BY m.id
      FOR UPDATE OF m
    `;

    const [target] = await tx<TargetRow[]>`
      SELECT id, user_id, status
      FROM public.memberships
      WHERE tenant_id = app.current_tenant_id() AND id = ${payload.membership_id}
      FOR UPDATE
    `;
    if (!target || target.user_id !== payload.user_id) {
      report('not_found');
      return;
    }
    if (target.status === 'revoked') {
      report('already_revoked');
      return;
    }

    const targetIsOwner = owners.some((owner) => owner.id === target.id);
    const otherActiveOwners = owners.filter((owner) => owner.id !== target.id && owner.status === 'active').length;
    const metadata = { reason: REASON, user_id: payload.user_id, webhook_event_id: payload.webhook_event_id };

    if (targetIsOwner && target.status === 'active' && otherActiveOwners === 0) {
      await audit(tx, {
        tenantId: event.tenantId,
        membershipId: target.id,
        outcome: 'denied',
        reasonCode: 'last_owner_invariant',
        before: { status: target.status },
        after: { status: target.status },
        metadata,
        requestId: event.id,
      });
      report('kept_last_owner');
      return;
    }

    const updated = await tx`
      UPDATE public.memberships
      SET status = 'revoked', revoked_at = now(), updated_at = now()
      WHERE tenant_id = app.current_tenant_id() AND id = ${target.id} AND status = ${target.status}
    `;
    if (updated.count !== 1) throw new Error('MEMBERSHIP_REVOCATION_UPDATE_FAILED');

    await audit(tx, {
      tenantId: event.tenantId,
      membershipId: target.id,
      outcome: 'success',
      reasonCode: REASON,
      before: { status: target.status },
      after: { status: 'revoked' },
      metadata,
      requestId: event.id,
    });
    report('revoked');
  };
}
