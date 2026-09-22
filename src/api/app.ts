import fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import type postgres from 'postgres';
import type { IdentityProvider } from '../identity/identity-provider.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  membershipId: string;
  requestId: string;
}

export interface TenantRequestContext {
  tenant: TenantContext;
  sql: postgres.ReservedSql;
}

interface ActiveMembershipRow {
  tenant_id: string;
  user_id: string;
  membership_id: string;
}

interface RequestState extends TenantRequestContext {
  transactionOpen: boolean;
}

export interface BuildApiOptions {
  database: postgres.Sql;
  identityProvider: IdentityProvider;
  registerRoutes?: (app: FastifyInstance) => void | Promise<void>;
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const requestStates = new WeakMap<FastifyRequest, RequestState>();

async function finishTransaction(
  request: FastifyRequest,
  action: 'COMMIT' | 'ROLLBACK',
): Promise<void> {
  const state = requestStates.get(request);
  if (!state?.transactionOpen) return;

  state.transactionOpen = false;
  try {
    await state.sql.unsafe(action);
  } finally {
    state.sql.release();
  }
}

export function getTenantRequestContext(request: FastifyRequest): TenantRequestContext {
  const state = requestStates.get(request);
  if (!state?.transactionOpen) {
    throw new ApiError(500, 'TENANT_CONTEXT_UNAVAILABLE', 'Tenant context is unavailable.');
  }
  return state;
}

export async function buildApi(options: BuildApiOptions): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  app.setErrorHandler(async (error, request, reply) => {
    const known = error instanceof ApiError;
    const statusCode = known ? error.statusCode : 500;
    const code = known ? error.code : 'INTERNAL_ERROR';
    const message = known ? error.message : 'The request could not be completed.';

    await reply.code(statusCode).send({
      error: { code, message, request_id: request.id },
    });
  });

  app.addHook('onRequest', async (request) => {
    let identity;
    try {
      identity = await options.identityProvider.verifyRequest(request);
    } catch {
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    }

    if (!identity) {
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    }

    const memberships = await options.database<ActiveMembershipRow[]>`
      SELECT user_id, membership_id, tenant_id
      FROM app.bootstrap_list_active_memberships(
        ${identity.identityProvider},
        ${identity.externalSubject}
      )
    `;

    if (memberships.length === 0) {
      throw new ApiError(403, 'ACTIVE_MEMBERSHIP_REQUIRED', 'An active membership is required.');
    }
    if (memberships.length !== 1) {
      throw new ApiError(409, 'TENANT_SELECTION_REQUIRED', 'A workshop must be selected.');
    }

    const membership = memberships[0];
    const sql = await options.database.reserve();
    try {
      await sql.unsafe('BEGIN');
      await sql`
        SELECT
          set_config('app.tenant_id', ${membership.tenant_id}, true),
          set_config('app.user_id', ${membership.user_id}, true),
          set_config('app.membership_id', ${membership.membership_id}, true),
          set_config('app.request_id', ${request.id}, true)
      `;
    } catch (error) {
      await sql.unsafe('ROLLBACK').catch(() => undefined);
      sql.release();
      throw error;
    }

    requestStates.set(request, {
      sql,
      transactionOpen: true,
      tenant: {
        tenantId: membership.tenant_id,
        userId: membership.user_id,
        membershipId: membership.membership_id,
        requestId: request.id,
      },
    });
  });

  app.addHook('onSend', async (request, _reply, payload) => {
    await finishTransaction(request, 'COMMIT');
    return payload;
  });

  app.addHook('onError', async (request) => {
    await finishTransaction(request, 'ROLLBACK');
  });

  app.addHook('onResponse', async (request) => {
    await finishTransaction(request, 'ROLLBACK');
  });

  if (options.registerRoutes) await options.registerRoutes(app);
  return app;
}
