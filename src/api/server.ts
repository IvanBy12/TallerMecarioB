import postgres from 'postgres';
import { buildApi, getTenantRequestContext } from './app.js';
import type {
  IdentityProvider,
  VerifiedIdentity,
  VerifiedIdentityProfile,
} from '../identity/identity-provider.js';
import { ClerkIdentityProvider } from '../identity/clerk/clerk-identity-provider.js';
import {
  clerkConfigured,
  loadClerkAuthenticationConfig,
  loadClerkWebhookSigningSecret,
} from '../identity/clerk/config.js';
import { PostgresClerkWebhookRepository, registerClerkWebhookRoute } from '../identity/webhook-routes.js';
import { loadWompiConfig } from '../integrations/wompi/config.js';
import { PostgresWompiWebhookRepository } from '../integrations/wompi/repository.js';
import { registerWompiWebhookRoute } from '../integrations/wompi/routes.js';
import { registerOnboardingRoutes } from '../onboarding/routes.js';
import { invitationsConfigured, loadInvitationTokenKey } from '../invitations/config.js';
import { registerInvitationAcceptRoute, registerInvitationRoutes } from '../invitations/routes.js';

/**
 * Used ONLY when no Clerk variable is configured at all (e.g. the local
 * docker "staging" drill, which exercises health/readiness/CORS/DB): it
 * always denies, so every protected route 401s. As soon as any CLERK_*
 * variable is present the full Clerk configuration is mandatory and the real
 * ClerkIdentityProvider is used (fail closed on partial configuration).
 */
class UnimplementedIdentityProvider implements IdentityProvider {
  async verifyRequest(): Promise<VerifiedIdentity | null> {
    return null;
  }

  async getIdentityProfile(): Promise<VerifiedIdentityProfile> {
    throw new Error('IDENTITY_PROVIDER_NOT_IMPLEMENTED');
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function databaseUrlFromEnv(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = requiredEnv('PGHOST');
  const port = process.env.PGPORT ?? '5432';
  const database = requiredEnv('PGDATABASE');
  const user = requiredEnv('PGUSER');
  const password = requiredEnv('PGPASSWORD');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function parseCorsAllowedOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const wompi = loadWompiConfig();
  const clerk = clerkConfigured()
    ? { config: loadClerkAuthenticationConfig(), webhookSigningSecret: loadClerkWebhookSigningSecret() }
    : null;
  // S1-04: any invitation variable present => the token secret is mandatory.
  const invitationTokenKey = invitationsConfigured() ? loadInvitationTokenKey() : null;
  const port =Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  // ADR-009: runtime connects NOBYPASSRLS, never as owner/migrator. The
  // login role authenticates; `connection.role` then `SET ROLE`s into the
  // actual runtime role for every session this pool opens.
  const runtimeRole = process.env.DB_RUNTIME_ROLE ?? 'tallermecario_api';
  const database = postgres(databaseUrlFromEnv(), {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    connection: { role: runtimeRole },
  });

  const app = await buildApi({
    database,
    identityProvider: clerk ? new ClerkIdentityProvider(clerk.config) : new UnimplementedIdentityProvider(),
    corsAllowedOrigins: parseCorsAllowedOrigins(),
    registerPublicRoutes(server) {
      if (wompi.enabled) {
        registerWompiWebhookRoute(server, {
          eventSecret: wompi.eventsSecret,
          environment: wompi.environment,
          repository: new PostgresWompiWebhookRepository(database),
        });
      }
      if (clerk) {
        registerClerkWebhookRoute(server, {
          signingSecret: clerk.webhookSigningSecret,
          repository: new PostgresClerkWebhookRepository(database),
        });
      }
    },
    registerIdentityOnlyRoutes(server) {
      registerOnboardingRoutes(server, { database });
      // Needs no secret: acceptance only hashes the presented token.
      registerInvitationAcceptRoute(server, { database });
    },
    async registerRoutes(server) {
      if (invitationTokenKey) registerInvitationRoutes(server, { tokenKey: invitationTokenKey });
      // Deploy-smoke-test only: proves the full protected-route pipeline
      // (rate limit -> auth -> TenantContext transaction -> RBAC) is wired
      // end to end in the deployed artifact. Not a product endpoint.
      server.get('/api/v1/__whoami', { config: { permission: 'workshop.read' } }, async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId };
      });
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log?.info?.(`received ${signal}, shutting down`);
    try {
      await app.close();
    } finally {
      await database.end({ timeout: 5 });
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });
  process.stdout.write(`api listening on ${host}:${port}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
