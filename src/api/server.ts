import { buildApi, getTenantRequestContext } from './app.js';
import { runtimeDatabase } from '../platform/runtime-database.js';
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
import { invitationsConfigured, loadInvitationApiConfig } from '../invitations/config.js';
import { registerInvitationAcceptRoute, registerInvitationRoutes } from '../invitations/routes.js';
import { registerMemberLifecycleRoutes } from '../memberships/lifecycle-routes.js';
import { registerMemberRoleRoutes } from '../memberships/roles-routes.js';
import { registerCustomerRoutes } from '../customers/routes.js';
import { registerVehicleRoutes } from '../vehicles/routes.js';
import { registerReceptionRoutes } from '../receptions/routes.js';

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
  // S1-04: any invitation variable present => token secret + accept URL + sender are mandatory.
  const invitationConfig = invitationsConfigured() ? loadInvitationApiConfig() : null;
  const port =Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  const database = await runtimeDatabase('api', Number(process.env.DB_POOL_MAX ?? 10));

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
      if (invitationConfig) registerInvitationRoutes(server, { config: invitationConfig });
      registerMemberRoleRoutes(server);
      registerMemberLifecycleRoutes(server);
      registerCustomerRoutes(server);
      registerVehicleRoutes(server);
      registerReceptionRoutes(server);
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
