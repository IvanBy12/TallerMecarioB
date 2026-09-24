import postgres from 'postgres';
import {
  claimBatch,
  processClaimedJob,
  requeueStalled,
  type OutboxHandler,
  type PhasedOutboxHandler,
  PermanentDispatchError,
} from './outbox-worker.js';
import { ClerkIdentitySnapshotSource } from '../identity/clerk/clerk-identity-provider.js';
import { clerkConfigured, loadClerkBackendConfig } from '../identity/clerk/config.js';
import { createIdentityLifecycleHandler, IDENTITY_LIFECYCLE_EVENT_TYPE } from '../identity/sync/lifecycle-sync.js';
import {
  createMembershipRevocationHandler,
  MEMBERSHIP_REVOCATION_EVENT_TYPE,
} from '../identity/sync/membership-revocation.js';
import { invitationsConfigured, loadInvitationEmailConfig } from '../invitations/config.js';
import {
  createInvitationEmailHandler,
  INVITATION_EMAIL_EVENT_TYPE,
  ResendEmailSender,
} from '../invitations/email.js';
import { WompiAdapter } from '../integrations/wompi/adapter.js';
import { PostgresWompiBillingRepository } from '../integrations/wompi/billing-repository.js';
import { loadWompiConfig, type WompiRuntimeConfig } from '../integrations/wompi/config.js';
import { WompiAdapterError } from '../integrations/wompi/errors.js';
import { handleSubscriptionChargeRequested } from '../integrations/wompi/outbox-handler.js';
import {
  PostgresWompiWebhookAttemptRepository,
  processWompiWebhookOutbox,
} from '../integrations/wompi/webhook-processor.js';

/**
 * ADR-007: API and worker ship from the same image, started with a
 * different command. This is that worker command. No WhatsApp/Wompi/email
 * dispatch handlers are wired in yet (out of scope here) -- an empty
 * registry is a safe, correct starting state: `processClaimedJob` already
 * treats an unregistered `event_type` as a permanent failure (dead_letter),
 * never a crash, so the process stays up either way.
 */
function rethrowClassifiedWompiError(error: unknown): never {
  const permanentMessage = error instanceof Error && [
    'WOMPI_TRANSACTION_CORRELATION_MISMATCH',
    'WOMPI_NORMALIZED_EVENT_INVALID',
    'WOMPI_WEBHOOK_EVENT_ID_MISSING',
  ].includes(error.message);
  if ((error instanceof WompiAdapterError && !error.retryable) || permanentMessage
    || (error instanceof Error && error.name === 'ZodError')) {
    throw new PermanentDispatchError(error instanceof Error ? error.message : 'WOMPI_PERMANENT_ERROR');
  }
  throw error;
}

function createWompiHandlers(
  config: Extract<WompiRuntimeConfig, { enabled: true }>,
  database: postgres.Sql,
): Record<string, OutboxHandler> {
  const adapter = new WompiAdapter({
    environment: config.environment,
    baseUrl: config.baseUrl,
    publicKey: config.publicKey,
    privateKey: config.privateKey,
    integritySecret: config.integritySecret,
  });
  const attempts = new PostgresWompiWebhookAttemptRepository(database);
  return {
    'billing.subscription_charge_requested': async (event, tx) => {
      try {
        await handleSubscriptionChargeRequested({
          payload: event.payload,
          adapter,
          repository: new PostgresWompiBillingRepository(tx),
        });
      } catch (error) {
        rethrowClassifiedWompiError(error);
      }
    },
    'billing.provider_transaction_status_changed': async (event, tx) => {
      try {
        await processWompiWebhookOutbox({
          payload: event.payload,
          tenantSql: tx,
          attempts,
          attemptNumber: event.attempts,
          workerId: `worker-${process.pid}`,
        });
      } catch (error) {
        rethrowClassifiedWompiError(error);
      }
    },
  };
}

function databaseUrlFromEnv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  if (!host || !database || !user || !password) throw new Error('DATABASE_CONFIGURATION_REQUIRED');
  const port = process.env.PGPORT ?? '5432';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

async function main(): Promise<void> {
  const wompi = loadWompiConfig();
  const runtimeRole = process.env.DB_RUNTIME_ROLE ?? 'tallermecario_worker';
  const database = postgres(databaseUrlFromEnv(), {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    connection: { role: runtimeRole },
  });

  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000);
  const batchSize = Number(process.env.WORKER_BATCH_SIZE ?? 10);
  const stallSeconds = Number(process.env.WORKER_STALL_SECONDS ?? 300);
  const handlers: Record<string, OutboxHandler> = {
    ...(wompi.enabled ? createWompiHandlers(wompi, database) : {}),
    // S1-03: per-tenant membership revocation after a provider deletion (no network).
    [MEMBERSHIP_REVOCATION_EVENT_TYPE]: createMembershipRevocationHandler(),
  };
  // S1-03: Clerk lifecycle sync calls the Backend API, so it runs phased
  // (network strictly outside any DB transaction).
  const phasedHandlers: Record<string, PhasedOutboxHandler<any>> = clerkConfigured()
    ? {
      [IDENTITY_LIFECYCLE_EVENT_TYPE]: createIdentityLifecycleHandler({
        source: new ClerkIdentitySnapshotSource(loadClerkBackendConfig()),
        workerId: `worker-${process.pid}`,
      }),
    }
    : {};
  // S1-04: invitation emails call Resend, so they run phased too. Any
  // invitation variable present => the full email configuration is mandatory.
  if (invitationsConfigured()) {
    const invitationEmail = loadInvitationEmailConfig();
    phasedHandlers[INVITATION_EMAIL_EVENT_TYPE] = createInvitationEmailHandler({
      config: invitationEmail,
      sender: new ResendEmailSender(invitationEmail),
    });
  }

  let running = true;
  const shutdown = async (signal: string) => {
    if (!running) return;
    running = false;
    process.stdout.write(`worker: received ${signal}, finishing current cycle\n`);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.stdout.write('worker started\n');

  while (running) {
    try {
      await requeueStalled(database, stallSeconds, batchSize);
      const jobs = await claimBatch(database, batchSize);
      for (const job of jobs) {
        if (!running) break;
        await processClaimedJob({ database, handlers, phasedHandlers }, job);
      }
    } catch (error) {
      process.stderr.write(`worker cycle error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    if (running) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  await database.end({ timeout: 5 });
  process.stdout.write('worker stopped\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
