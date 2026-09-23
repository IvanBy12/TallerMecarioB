'use strict';

/**
 * S1-02 TenantContext + RBAC — Fastify request lifecycle, against a real
 * migrated PostgreSQL (scripts/test-tenant-context-api.cjs).
 *
 * Every request runs as the `tallermecario_api` RUNTIME role (NOBYPASSRLS,
 * non-owner, NOINHERIT login). The admin (superuser) connection only seeds
 * fixtures, flips membership/user state from "another session" (TOCTOU),
 * simulates catalog drift in this disposable database, and reads
 * pg_stat_activity.
 *
 * The runtime pool is wrapped in a recording Proxy: every pool statement,
 * every reserve()/release(), and every statement (+ result rows) of each
 * reserved connection. That makes the single-connection / single-transaction
 * contract observable and lets TOCTOU changes be injected at exact points.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { after, before, describe, test } = require('node:test');
const postgres = require('postgres');

const root = process.env.TEST_API_MODULE_ROOT;
if (!root) throw new Error('TEST_API_MODULE_ROOT is required');
const {
  buildApi,
  getIdentityOnlyRequestContext,
  getTenantRequestContext,
  markDurableTenantOutcome,
  markResourceAuthorizationSatisfied,
  TenantRouteConfigurationError,
} = require(join(root, 'api', 'app.js'));
const { getResourceAuthorizationStatus } = require(join(root, 'authz', 'resource-authorization.js'));
const { TenantContextDbError } = require(join(root, 'tenancy', 'tenant-context-db.js'));
const { registerMediaRoutes } = require(join(root, 'media', 'routes.js'));

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
const runtimeLogin = process.env.TEST_RUNTIME_LOGIN;
const runtimePassword = process.env.TEST_RUNTIME_PASSWORD;
if (!adminUrl || !runtimeLogin || !runtimePassword) {
  throw new Error('Disposable database and runtime login are required');
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(adminUrl).hostname)) {
  throw new Error('Refusing to run tenant-context API tests against a non-local host');
}

const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });

function runtimePool(max) {
  const url = new URL(adminUrl);
  url.username = runtimeLogin;
  url.password = runtimePassword;
  return postgres(url.toString(), { max, onnotice: () => {}, connection: { role: 'tallermecario_api' } });
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERIC_500 = 'The request could not be completed.';
const testR2 = {
  endpoint: 'http://127.0.0.1:1', region: 'auto', bucket: 'tenant-audit',
  accessKeyId: 'test-only', secretAccessKey: 'test-only',
};

/* -------------------------------------------------------------------------- */
/* Fixture ids                                                                */
/* -------------------------------------------------------------------------- */

const id = () => randomUUID();
const T = { A: id(), B: id(), C: id() };
const U = {
  ownerA: id(), ownerB: id(), multi: id(), tech: id(), none: id(),
  disabled: id(), inactive: id(), toctou: id(), ghost: id(),
};
const M = {
  ownerA: id(), ownerB: id(), multiA: id(), multiB: id(), techA: id(),
  disabledA: id(), inactiveA: id(), inactiveB: id(), toctouA: id(), ghostC: id(),
};
const C = { A: id(), B: id() };
const UNKNOWN_SUBJECT = `subject-unknown-${id()}`;
const subjectOf = (userKey) => `subject-${U[userKey]}`;

/* -------------------------------------------------------------------------- */
/* Identity provider: identity only; everything else it returns is ignored    */
/* -------------------------------------------------------------------------- */

const providerCalls = { verify: 0, profile: 0 };
const identityProvider = {
  async verifyRequest(request) {
    providerCalls.verify += 1;
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
    const token = authorization.slice(7);
    let externalSubject = null;
    if (token === 'unknown') externalSubject = UNKNOWN_SUBJECT;
    else if (Object.hasOwn(U, token)) externalSubject = subjectOf(token);
    if (externalSubject === null) return null;
    // Provider-side claims (Clerk metadata-like). The backend must never use them.
    return {
      identityProvider: 'clerk',
      externalSubject,
      tenantId: T.B,
      roles: ['owner'],
      publicMetadata: { tenantId: T.B, roles: ['owner'], permissions: ['*'] },
      privateMetadata: { membershipId: M.ownerB },
    };
  },
  async getIdentityProfile() {
    providerCalls.profile += 1;
    throw new Error('PROFILE_MUST_NOT_BE_FETCHED');
  },
};

const auth = (userKey, extra = {}) => ({ authorization: `Bearer ${userKey}`, ...extra });
const withTenant = (userKey, tenantHeader) => auth(userKey, { 'x-tenant-id': tenantHeader });

/* -------------------------------------------------------------------------- */
/* Recording pool                                                             */
/* -------------------------------------------------------------------------- */

const isTemplate = (args) => Array.isArray(args[0]) && Array.isArray(args[0].raw);
const templateText = (args) => args[0].join('$?');

function instrument(pool) {
  const probe = { hooks: {}, poolStatements: [], transactions: [] };

  function wrapReserved(conn, tx) {
    return new Proxy(conn, {
      apply(target, thisArg, args) {
        if (!isTemplate(args)) return Reflect.apply(target, thisArg, args);
        const entry = { text: templateText(args), rows: undefined };
        tx.statements.push(entry);
        return (async () => {
          const hook = probe.hooks.beforeReservedStatement?.(entry.text);
          if (hook) await hook();
          entry.rows = await Reflect.apply(target, thisArg, args);
          return entry.rows;
        })();
      },
      get(target, prop) {
        if (prop === 'unsafe') {
          return async (query, ...rest) => {
            const entry = { text: query, rows: undefined };
            tx.statements.push(entry);
            entry.rows = await target.unsafe(query, ...rest);
            return entry.rows;
          };
        }
        if (prop === 'release') {
          return () => {
            tx.releases += 1;
            return target.release();
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const sql = new Proxy(pool, {
    apply(target, thisArg, args) {
      if (isTemplate(args)) probe.poolStatements.push(templateText(args));
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      if (prop === 'reserve') {
        return async () => {
          if (probe.hooks.beforeReserve) await probe.hooks.beforeReserve();
          const tx = { statements: [], releases: 0 };
          probe.transactions.push(tx);
          return wrapReserved(await target.reserve(), tx);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { sql, pool, probe };
}

function statementKind(text) {
  const trimmed = text.trim();
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(trimmed)) return trimmed;
  if (text.includes('bootstrap_list_active_memberships')) return 'discover';
  if (text.includes('bootstrap_validate_active_membership')) return 'validate';
  if (text.includes("set_config('app.tenant_id'")) return 'bind';
  if (text.includes('FROM public.memberships AS m')) return 'load';
  if (text.includes('__it_handler')) return 'handler';
  return 'other';
}

const checkpoint = (db) => ({ pool: db.probe.poolStatements.length, tx: db.probe.transactions.length });
function since(db, mark) {
  return {
    pool: db.probe.poolStatements.slice(mark.pool).map(statementKind),
    transactions: db.probe.transactions.slice(mark.tx),
  };
}
const kinds = (tx) => tx.statements.map((entry) => statementKind(entry.text));

/**
 * The S1-02 contract for one successful tenant request: the pool served only
 * discovery; ONE reserved connection ran BEGIN → validate → bind → load →
 * handler → COMMIT and was released once; validate/bind/load/handler all
 * report the same backend pid and transaction marker; the handler saw this
 * request's GUCs.
 */
function assertSingleTransaction(db, mark, response) {
  const { pool, transactions } = since(db, mark);
  assert.deepEqual(pool, ['discover'], 'the pool serves only pre-transaction discovery');
  assert.equal(transactions.length, 1, 'exactly one reserved connection per tenant request');
  const [tx] = transactions;
  assert.equal(tx.releases, 1, 'reserved connection released exactly once');
  assert.deepEqual(kinds(tx), ['BEGIN', 'validate', 'bind', 'load', 'handler', 'COMMIT']);

  const [validate, bind, load, handler] = [1, 2, 3, 4].map((index) => tx.statements[index].rows[0]);
  for (const [label, row] of [['bind', bind], ['load', load], ['handler', handler]]) {
    assert.equal(row.backend_pid, validate.backend_pid, `${label} ran on the validation backend`);
    assert.equal(row.transaction_marker, validate.transaction_marker, `${label} ran in the validation transaction`);
  }
  const body = response.json();
  assert.equal(handler.request_id, body.context.requestId, 'handler saw this request id GUC');
  assert.equal(handler.tenant_id, body.context.tenantId);
  assert.equal(handler.user_id, body.context.userId);
  assert.equal(handler.membership_id, body.context.membershipId);
}

/* -------------------------------------------------------------------------- */
/* Test routes                                                                */
/* -------------------------------------------------------------------------- */

const handlerRuns = new Map();
const ran = (name) => handlerRuns.set(name, (handlerRuns.get(name) ?? 0) + 1);
const runsOf = (name) => handlerRuns.get(name) ?? 0;

const slowGate = { onStart: () => {}, release: Promise.resolve() };

async function transactionProbe(sql) {
  const [row] = await sql`
    SELECT /* __it_handler */
      pg_catalog.pg_backend_pid() AS backend_pid,
      ((EXTRACT(EPOCH FROM pg_catalog.transaction_timestamp()) * 1000000)::bigint)::text AS transaction_marker,
      COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant_id,
      COALESCE(pg_catalog.current_setting('app.user_id', true), '') AS user_id,
      COALESCE(pg_catalog.current_setting('app.membership_id', true), '') AS membership_id,
      COALESCE(pg_catalog.current_setting('app.request_id', true), '') AS request_id,
      ARRAY(SELECT w.id::text FROM public.workshops AS w ORDER BY w.id) AS visible_workshops,
      ARRAY(SELECT c.id::text FROM public.customers AS c ORDER BY c.id) AS visible_customers
  `;
  return { ...row };
}

async function touchCustomerA(sql, notes) {
  // No tenant predicate on purpose: RLS is the boundary, not a WHERE clause.
  await sql`UPDATE public.customers SET notes = ${notes}, updated_at = now() WHERE id = ${C.A}`;
}

function contextView(context) {
  return {
    tenantId: context.tenant.tenantId,
    userId: context.tenant.userId,
    membershipId: context.tenant.membershipId,
    requestId: context.tenant.requestId,
    roles: [...context.tenant.roles],
    permissionCount: context.tenant.permissions.size,
    frozen: Object.isFrozen(context.tenant),
  };
}

function registerTestRoutes(server, db) {
  registerMediaRoutes(server, testR2);
  server.get('/api/v1/__it/context', { config: { permission: 'workshop.read' } }, async (request) => {
    ran('context');
    const context = getTenantRequestContext(request);
    return {
      context: contextView(context),
      resource: getResourceAuthorizationStatus(context.resourceAuthorization),
      db: await transactionProbe(context.sql),
    };
  });

  // Deliberately BROKEN handler: tenant query through the pool, not context.sql.
  server.get('/api/v1/__it/pool-bug', { config: { permission: 'workshop.read' } }, async (request) => {
    ran('pool-bug');
    const context = getTenantRequestContext(request);
    return { context: contextView(context), db: await transactionProbe(db.sql) };
  });

  server.get('/api/v1/__it/customers', { config: { permission: 'customers.read' } }, async (request) => {
    ran('customers');
    const { sql } = getTenantRequestContext(request);
    const rows = await sql`SELECT c.id::text AS id FROM public.customers AS c ORDER BY c.id`;
    return { customers: rows.map((row) => row.id) };
  });

  server.get('/api/v1/__it/orders', { config: { permission: 'orders.read' } }, async () => {
    ran('orders-tenant');
    return { ok: true };
  });

  server.post('/api/v1/__it/orders/:mode', {
    config: { permission: 'orders.read', permissionScope: 'resource' },
  }, async (request, reply) => {
    ran('orders-resource');
    const context = getTenantRequestContext(request);
    const statusBefore = getResourceAuthorizationStatus(context.resourceAuthorization);
    const { mode } = request.params;
    if (mode === 'omit' || mode === 'not-found') await touchCustomerA(context.sql, `resource-${mode}-${request.id}`);
    if (mode === 'not-found') {
      return reply.code(404).send({ error: { code: 'ORDER_NOT_FOUND', request_id: request.id } });
    }
    // Test stand-in for a real Sprint 2+ resolver that verified the assignment.
    if (mode === 'mark') markResourceAuthorizationSatisfied(context.resourceAuthorization, 'assigned');
    if (mode === 'wrong-scope') markResourceAuthorizationSatisfied(context.resourceAuthorization, 'quality_control');
    return { before: statusBefore, after: getResourceAuthorizationStatus(context.resourceAuthorization) };
  });

  server.post('/api/v1/__it/quality-checks', {
    config: { permission: 'quality_checks.perform', permissionScope: 'resource' },
  }, async (request) => {
    const context = getTenantRequestContext(request);
    const statusBefore = getResourceAuthorizationStatus(context.resourceAuthorization);
    markResourceAuthorizationSatisfied(context.resourceAuthorization, 'quality_control');
    return { before: statusBefore, after: getResourceAuthorizationStatus(context.resourceAuthorization) };
  });

  server.post('/api/v1/__it/durable-pending', {
    config: {
      permission: 'orders.read',
      permissionScope: 'resource',
      durableErrorCodes: ['UPLOAD_SESSION_EXPIRED'],
    },
  }, async (request, reply) => {
    await touchCustomerA(getTenantRequestContext(request).sql, `pending-${request.id}`);
    markDurableTenantOutcome(request, 'UPLOAD_SESSION_EXPIRED');
    return reply.code(409).send({ error: { code: 'UPLOAD_SESSION_EXPIRED', request_id: request.id } });
  });

  server.post('/api/v1/__it/customers/notes', {
    config: { permission: 'customers.update' },
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { fail: { type: 'string', enum: ['throw', 'serialize', 'onsend', 'reply-400', 'reply-403', 'reply-409', 'reply-500'] } },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    onSend: async (request, reply, payload) => {
      if (request.query.fail === 'onsend' && reply.statusCode < 400) throw new Error('route onSend failure');
      return payload;
    },
  }, async (request, reply) => {
    ran('notes');
    const { sql } = getTenantRequestContext(request);
    await touchCustomerA(sql, `notes-${request.id}`);
    switch (request.query.fail) {
      case 'throw': throw new Error('handler failure after a write');
      case 'serialize': return { unexpected: true };
      case 'reply-400': return reply.code(400).send({ error: { code: 'TEST_BAD_REQUEST', request_id: request.id } });
      case 'reply-403': return reply.code(403).send({ error: { code: 'TEST_FORBIDDEN', request_id: request.id } });
      case 'reply-409': return reply.code(409).send({ error: { code: 'TEST_CONFLICT', request_id: request.id } });
      case 'reply-500': return reply.code(500).send({ error: { code: 'TEST_INTERNAL', request_id: request.id } });
      default: return { id: C.A };
    }
  });

  server.post('/api/v1/__it/on-send-error', {
    config: { permission: 'customers.update' },
    onSend: async () => {
      const error = new TenantContextDbError('TENANT_CONTEXT_CLIENT_MISMATCH');
      error.message = 'constraint users_external_identity_key internal-user-uuid INTERNAL_SQL_SENTINEL';
      throw error;
    },
  }, async (request, reply) => {
    await touchCustomerA(getTenantRequestContext(request).sql, `leak-${request.id}`);
    return reply.code(409).send({ error: { code: 'TEST_CONFLICT', request_id: request.id } });
  });

  server.get('/api/v1/__it/slow', { config: { permission: 'workshop.read' } }, async (request) => {
    ran('slow');
    const { sql } = getTenantRequestContext(request);
    slowGate.onStart();
    await slowGate.release;
    return { db: await transactionProbe(sql) };
  });
}

function registerIdentityTestRoutes(server, db) {
  // A request WITHOUT tenant context that reuses the same pool.
  server.get('/api/v1/__it/no-context', async (request) => {
    getIdentityOnlyRequestContext(request);
    const [row] = await db.sql`
      SELECT
        pg_catalog.pg_backend_pid() AS backend_pid,
        COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant_id,
        COALESCE(pg_catalog.current_setting('app.user_id', true), '') AS user_id,
        COALESCE(pg_catalog.current_setting('app.membership_id', true), '') AS membership_id,
        COALESCE(pg_catalog.current_setting('app.request_id', true), '') AS request_id,
        ARRAY(SELECT w.id::text FROM public.workshops AS w) AS visible_workshops
    `;
    return { ...row };
  });
}

function appOptions(db) {
  return {
    database: db.sql,
    identityProvider,
    rateLimit: { max: 100000, timeWindow: '1 minute' },
    registerIdentityOnlyRoutes: (server) => registerIdentityTestRoutes(server, db),
    registerRoutes: (server) => registerTestRoutes(server, db),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function assertError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode, `expected ${statusCode} ${code}, got ${response.statusCode}: ${response.body}`);
  const body = response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'request_id']);
  assert.equal(body.error.code, code);
  assert.match(body.error.request_id, UUID_V7);
  return body.error;
}

function assertSanitized500(response, code = 'INTERNAL_ERROR') {
  const error = assertError(response, 500, code);
  assert.equal(error.message, GENERIC_500);
  for (const leak of ['ghost', 'AUTHZ_', 'TENANT_CONTEXT', 'RESOURCE_AUTHORIZATION_STATE', 'stack', 'SQL', 'constraint']) {
    assert.equal(response.body.includes(leak), false, `500 body leaked "${leak}"`);
  }
}

async function customerNotes(customerId) {
  const [row] = await admin`SELECT notes FROM public.customers WHERE id = ${customerId}`;
  return row.notes;
}

async function idleInTransaction() {
  const [row] = await admin`
    SELECT count(*)::int AS count
    FROM pg_catalog.pg_stat_activity
    WHERE usename = ${runtimeLogin} AND state LIKE 'idle in transaction%'
  `;
  return row.count;
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function httpRequest(port, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function setMembershipStatus(membershipId, status) {
  if (status === 'active') {
    await admin`UPDATE public.memberships SET status = 'active', suspended_at = NULL, revoked_at = NULL WHERE id = ${membershipId}`;
  } else {
    await admin`UPDATE public.memberships SET status = 'suspended', suspended_at = now() WHERE id = ${membershipId}`;
  }
}

async function setUserStatus(userId, status) {
  await admin`UPDATE public.users SET status = ${status} WHERE id = ${userId}`;
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

let roleId;
let main;
let app;
let leak;
let leakApp;
let aborts;
let abortApp;
let abortPort;

before(async () => {
  const [who] = await admin`
    SELECT rolsuper, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname = ${runtimeLogin}
  `;
  assert.deepEqual({ ...who }, { rolsuper: false, rolbypassrls: false, rolinherit: false });

  roleId = Object.fromEntries((await admin`SELECT id, code FROM public.roles`).map((row) => [row.code, row.id]));
  const now = new Date();

  // membership key: [user key, tenant key, status, roles]
  const memberships = {
    ownerA: ['ownerA', 'A', 'active', ['owner']],
    ownerB: ['ownerB', 'B', 'active', ['owner']],
    multiA: ['multi', 'A', 'active', ['owner']],
    multiB: ['multi', 'B', 'active', ['admin']],
    techA: ['tech', 'A', 'active', ['technician']],
    disabledA: ['disabled', 'A', 'active', ['owner']],
    inactiveA: ['inactive', 'A', 'suspended', ['owner']],
    inactiveB: ['inactive', 'B', 'revoked', ['owner']],
    toctouA: ['toctou', 'A', 'active', ['owner']],
    ghostC: ['ghost', 'C', 'active', []],
  };

  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const key of Object.keys(T)) {
      await tx`INSERT INTO workshops ${tx({ id: T[key], slug: `it-${T[key]}`, legal_name: `Legal ${key}`, display_name: `Taller ${key}` })}`;
    }
    for (const key of Object.keys(U)) {
      await tx`INSERT INTO users ${tx({
        id: U[key],
        external_subject: subjectOf(key),
        email: `${U[key]}@tenant-api.test`,
        status: key === 'disabled' ? 'disabled' : 'active',
      })}`;
    }
    for (const [key, [userKey, tenantKey, status, roles]] of Object.entries(memberships)) {
      await tx`INSERT INTO memberships ${tx({
        id: M[key],
        tenant_id: T[tenantKey],
        user_id: U[userKey],
        status,
        suspended_at: status === 'suspended' ? now : null,
        revoked_at: status === 'revoked' ? now : null,
      })}`;
      for (const role of roles) {
        await tx`INSERT INTO membership_roles ${tx({
          tenant_id: T[tenantKey],
          membership_id: M[key],
          role_id: roleId[role],
          assigned_by_membership_id: M[key],
        })}`;
      }
    }
    await tx`INSERT INTO customers ${tx([
      { id: C.A, tenant_id: T.A, first_name: 'Cliente', last_name: 'A', phone: '3000000001', notes: 'initial-a' },
      { id: C.B, tenant_id: T.B, first_name: 'Cliente', last_name: 'B', phone: '3000000002', notes: 'initial-b' },
    ])}`;
  });

  main = instrument(runtimePool(4));
  app = await buildApi(appOptions(main));
  leak = instrument(runtimePool(1));
  leakApp = await buildApi(appOptions(leak));
  aborts = instrument(runtimePool(2));
  abortApp = await buildApi(appOptions(aborts));
  await abortApp.listen({ port: 0, host: '127.0.0.1' });
  abortPort = abortApp.server.address().port;
});

after(async () => {
  for (const instance of [app, leakApp, abortApp]) if (instance) await instance.close();
  for (const db of [main, leak, aborts]) if (db) await db.pool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

const get = (url, headers) => app.inject({ method: 'GET', url, headers });

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('X-Tenant-Id selection', () => {
  test('no header: 0 memberships → 403 ACTIVE_MEMBERSHIP_REQUIRED, handler not run', async () => {
    const runs = runsOf('context');
    assertError(await get('/api/v1/__it/context', auth('none')), 403, 'ACTIVE_MEMBERSHIP_REQUIRED');
    assertError(await get('/api/v1/__it/context', auth('unknown')), 403, 'ACTIVE_MEMBERSHIP_REQUIRED');
    assert.equal(runsOf('context'), runs);
  });

  test('no header: exactly 1 membership → auto-selected', async () => {
    const response = await get('/api/v1/__it/context', auth('ownerA'));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().context.tenantId, T.A);
    assert.equal(response.json().context.membershipId, M.ownerA);
  });

  test('no header: N memberships → 409 TENANT_SELECTION_REQUIRED, handler not run', async () => {
    const runs = runsOf('context');
    assertError(await get('/api/v1/__it/context', auth('multi')), 409, 'TENANT_SELECTION_REQUIRED');
    assert.equal(runsOf('context'), runs);
  });

  test('valid explicit tenant → that tenant (uppercase accepted by the parser, no manual lowercase)', async () => {
    const explicit = await get('/api/v1/__it/context', withTenant('multi', T.B));
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(explicit.json().context.tenantId, T.B);

    const upper = await get('/api/v1/__it/context', withTenant('multi', T.A.toUpperCase()));
    assert.equal(upper.statusCode, 200, upper.body);
    assert.equal(upper.json().context.tenantId, T.A);
  });

  test('forged / foreign / unknown tenant → 403 TENANT_ACCESS_DENIED, never a fallback', async () => {
    const runs = runsOf('context');
    for (const [userKey, tenant] of [
      ['ownerA', id()], // nonexistent
      ['ownerA', T.C], // exists, no membership
      ['ownerA', T.B], // membership belongs to another user
      ['multi', T.C], // multi-tenant user must not fall back to A or B
      ['none', T.A], // explicit selection with 0 memberships is still access denied
    ]) {
      assertError(await get('/api/v1/__it/context', withTenant(userKey, tenant)), 403, 'TENANT_ACCESS_DENIED');
    }
    assert.equal(runsOf('context'), runs);
  });

  test('malformed header → 400 TENANT_SELECTION_INVALID (no trimming, no normalization)', async () => {
    const runs = runsOf('context');
    for (const value of [
      '', ' ', 'not-a-uuid', ` ${T.A}`, `${T.A} `, `${T.A},${T.B}`, `${T.A}, ${T.A}`,
      T.A.replaceAll('-', ''), `{${T.A}}`, `urn:uuid:${T.A}`,
      '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'x'.repeat(37),
    ]) {
      assertError(await get('/api/v1/__it/context', withTenant('ownerA', value)), 400, 'TENANT_SELECTION_INVALID');
    }
    assert.equal(runsOf('context'), runs);
  });

  test('duplicate X-Tenant-Id → 400 (inject array and real duplicated header lines)', async () => {
    assertError(await get('/api/v1/__it/context', withTenant('ownerA', [T.A, T.A])), 400, 'TENANT_SELECTION_INVALID');

    for (const values of [[T.A, T.A], [T.A, T.B]]) {
      const response = await httpRequest(abortPort, {
        path: '/api/v1/__it/context',
        headers: { authorization: 'Bearer multi', 'x-tenant-id': values },
      });
      assertError(response, 400, 'TENANT_SELECTION_INVALID');
    }
    const single = await httpRequest(abortPort, {
      path: '/api/v1/__it/context',
      headers: { authorization: 'Bearer multi', 'x-tenant-id': T.B },
    });
    assert.equal(single.statusCode, 200, single.body);
    assert.equal(single.json().context.tenantId, T.B);
  });

  test('tenant_id in query/params/provider claims is ignored: TenantContext comes only from PostgreSQL', async () => {
    const response = await get(`/api/v1/__it/context?tenant_id=${T.B}&x-tenant-id=${T.B}`, auth('ownerA'));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().context.tenantId, T.A); // provider claimed T.B / owner of B
    assert.equal(response.json().context.membershipId, M.ownerA);
  });
});

describe('TenantContext through the API', () => {
  test('tenant A identity → context A; tenant B identity → context B; built by createTenantContext', async () => {
    const a = (await get('/api/v1/__it/context', auth('ownerA'))).json();
    assert.deepEqual(a.context, {
      tenantId: T.A, userId: U.ownerA, membershipId: M.ownerA, requestId: a.context.requestId,
      roles: ['owner'], permissionCount: 103, frozen: true,
    });
    assert.match(a.context.requestId, UUID_V7);
    assert.equal(a.resource, 'not_required');

    const b = (await get('/api/v1/__it/context', auth('ownerB'))).json();
    assert.equal(b.context.tenantId, T.B);
    assert.equal(b.context.userId, U.ownerB);
    assert.equal(b.context.membershipId, M.ownerB);
  });

  test('multi-tenant user selecting A → A, selecting B → B (roles are per membership)', async () => {
    const a = (await get('/api/v1/__it/context', withTenant('multi', T.A))).json();
    assert.deepEqual([a.context.tenantId, a.context.membershipId, a.context.roles], [T.A, M.multiA, ['owner']]);
    const b = (await get('/api/v1/__it/context', withTenant('multi', T.B))).json();
    assert.deepEqual([b.context.tenantId, b.context.membershipId, b.context.roles], [T.B, M.multiB, ['admin']]);
    assert.equal(b.context.permissionCount, 97);
  });

  test('RLS stays the boundary: handler queries have no tenant WHERE and see only their tenant', async () => {
    const a = (await get('/api/v1/__it/context', withTenant('multi', T.A))).json();
    assert.deepEqual(a.db.visible_workshops, [T.A]);
    assert.deepEqual(a.db.visible_customers, [C.A]);
    const b = (await get('/api/v1/__it/context', withTenant('multi', T.B))).json();
    assert.deepEqual(b.db.visible_workshops, [T.B]);
    assert.deepEqual(b.db.visible_customers, [C.B]);
  });
});

describe('no enumeration', () => {
  test('403 TENANT_ACCESS_DENIED is identical for nonexistent, foreign, other-user, suspended, revoked, disabled and forged', async () => {
    const cases = [
      ['nonexistent tenant', 'ownerA', id()],
      ['tenant without membership', 'ownerA', T.C],
      ["other user's membership tenant", 'ownerA', T.B],
      ['suspended membership', 'inactive', T.A],
      ['revoked membership', 'inactive', T.B],
      ['disabled user', 'disabled', T.A],
      ['no local user', 'unknown', T.A],
      ['forged random uuid', 'multi', id()],
    ];
    const shapes = [];
    for (const [label, userKey, tenant] of cases) {
      const response = await get('/api/v1/__it/context', withTenant(userKey, tenant));
      const error = assertError(response, 403, 'TENANT_ACCESS_DENIED');
      shapes.push({
        label,
        shape: {
          message: error.message,
          contentType: response.headers['content-type'],
          contentLength: response.headers['content-length'],
          headerNames: Object.keys(response.headers).filter((name) => name !== 'date').sort(),
        },
      });
    }
    for (const { label, shape } of shapes.slice(1)) {
      assert.deepEqual(shape, shapes[0].shape, `${label} is distinguishable`);
    }
  });
});

describe('TOCTOU: discovery is never proof', () => {
  const scenarios = [
    ['membership suspended between discovery and BEGIN', 'beforeReserve', () => setMembershipStatus(M.toctouA, 'suspended'), ['BEGIN', 'validate', 'ROLLBACK']],
    ['membership suspended inside the transaction, before revalidation', 'validate', () => setMembershipStatus(M.toctouA, 'suspended'), ['BEGIN', 'validate', 'ROLLBACK']],
    ['membership suspended after bind, before the authorization load', 'load', () => setMembershipStatus(M.toctouA, 'suspended'), ['BEGIN', 'validate', 'bind', 'load', 'ROLLBACK']],
    ['user disabled between discovery and BEGIN', 'beforeReserve', () => setUserStatus(U.toctou, 'disabled'), ['BEGIN', 'validate', 'ROLLBACK']],
  ];

  for (const [label, point, change, expectedStatements] of scenarios) {
    for (const explicit of [false, true]) {
      test(`${label} (${explicit ? 'explicit X-Tenant-Id' : 'auto-selected'}) → 403 TENANT_ACCESS_DENIED, handler not run`, async () => {
        const runs = runsOf('context');
        const mark = checkpoint(main);
        let fired = false;
        const once = async () => { if (!fired) { fired = true; await change(); } };
        if (point === 'beforeReserve') main.probe.hooks.beforeReserve = once;
        else main.probe.hooks.beforeReservedStatement = (text) => (statementKind(text) === point ? once : undefined);
        try {
          const response = await get('/api/v1/__it/context', explicit ? withTenant('toctou', T.A) : auth('toctou'));
          const error = assertError(response, 403, 'TENANT_ACCESS_DENIED');
          assert.equal(error.message, 'Access to the requested workshop is denied.');
        } finally {
          main.probe.hooks = {};
          await setMembershipStatus(M.toctouA, 'active');
          await setUserStatus(U.toctou, 'active');
        }
        assert.equal(fired, true);
        assert.equal(runsOf('context'), runs, 'tenant-owned handler must not run');
        const { pool, transactions } = since(main, mark);
        assert.deepEqual(pool, ['discover'], 'discovery still saw the membership as active');
        assert.equal(transactions.length, 1);
        assert.deepEqual(kinds(transactions[0]), expectedStatements);
        assert.equal(transactions[0].releases, 1);

        // Control: once restored, the same identity works again.
        assert.equal((await get('/api/v1/__it/context', auth('toctou'))).statusCode, 200);
      });
    }
  }
});

describe('one connection, one transaction', () => {
  test('discovery on the pool; revalidation, GUC binding, authorization and handler share one backend and transaction', async () => {
    for (const headers of [auth('ownerA'), withTenant('multi', T.B), auth('tech')]) {
      const mark = checkpoint(main);
      const response = await get('/api/v1/__it/context', headers);
      assert.equal(response.statusCode, 200, response.body);
      assertSingleTransaction(main, mark, response);
    }
  });

  test('the check detects a handler that queries through the pool instead of context.sql', async () => {
    const mark = checkpoint(main);
    const response = await get('/api/v1/__it/pool-bug', auth('ownerA'));
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    // Outside the request transaction: no GUCs, and RLS shows nothing.
    assert.equal(body.db.request_id, '');
    assert.equal(body.db.tenant_id, '');
    assert.deepEqual(body.db.visible_workshops, []);
    assert.deepEqual(since(main, mark).pool, ['discover', 'handler']);
    assert.throws(() => assertSingleTransaction(main, mark, response), assert.AssertionError);
  });
});

describe('GUCs never leak through the pool', () => {
  async function noContext() {
    const response = await leakApp.inject({ method: 'GET', url: '/api/v1/__it/no-context', headers: auth('ownerA') });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  const EMPTY = { tenant_id: '', user_id: '', membership_id: '', request_id: '' };
  const gucs = (row) => ({ tenant_id: row.tenant_id, user_id: row.user_id, membership_id: row.membership_id, request_id: row.request_id });

  test('after COMMIT, ROLLBACK and a post-bind denial, the reused backend carries no tenant context', async () => {
    const committed = await leakApp.inject({ method: 'GET', url: '/api/v1/__it/context', headers: auth('ownerA') });
    assert.equal(committed.statusCode, 200, committed.body);
    const pid = committed.json().db.backend_pid;
    assert.equal(committed.json().db.tenant_id, T.A);

    let after = await noContext();
    assert.equal(after.backend_pid, pid, 'pool of 1: the same backend is reused');
    assert.deepEqual(gucs(after), EMPTY);
    assert.deepEqual(after.visible_workshops, []);

    const rolledBack = await leakApp.inject({ method: 'POST', url: '/api/v1/__it/customers/notes?fail=throw', headers: auth('ownerA') });
    assertSanitized500(rolledBack);
    after = await noContext();
    assert.equal(after.backend_pid, pid);
    assert.deepEqual(gucs(after), EMPTY);

    // Denied after BEGIN/bind/load (technician lacks customers.read).
    assertError(await leakApp.inject({ method: 'GET', url: '/api/v1/__it/customers', headers: auth('tech') }), 403, 'PERMISSION_DENIED');
    after = await noContext();
    assert.deepEqual(gucs(after), EMPTY);

    const [direct] = await leak.pool`
      SELECT pg_catalog.pg_backend_pid() AS backend_pid,
        COALESCE(pg_catalog.current_setting('app.tenant_id', true), '') AS tenant_id,
        COALESCE(pg_catalog.current_setting('app.request_id', true), '') AS request_id
    `;
    assert.deepEqual({ ...direct }, { backend_pid: pid, tenant_id: '', request_id: '' });

    const b = await leakApp.inject({ method: 'GET', url: '/api/v1/__it/context', headers: auth('ownerB') });
    assert.equal(b.json().db.backend_pid, pid);
    assert.deepEqual(gucs(b.json().db), {
      tenant_id: T.B, user_id: U.ownerB, membership_id: M.ownerB, request_id: b.json().context.requestId,
    });
    assert.equal(leak.probe.transactions.every((tx) => tx.releases === 1), true);
  });
});

describe('RBAC route guard', () => {
  test('owner with a tenant grant → allowed', async () => {
    const response = await get('/api/v1/__it/customers', auth('ownerA'));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().customers, [C.A]);
  });

  test('technician: restricted grant on a tenant-scope route → 403; no grant → 403; tenant grant → 200', async () => {
    const orders = runsOf('orders-tenant');
    assertError(await get('/api/v1/__it/orders', auth('tech')), 403, 'PERMISSION_DENIED'); // orders.read = assigned
    assert.equal(runsOf('orders-tenant'), orders);
    assertError(await get('/api/v1/__it/customers', auth('tech')), 403, 'PERMISSION_DENIED'); // customers.read = —
    const context = await get('/api/v1/__it/context', auth('tech')); // workshop.read = tenant
    assert.equal(context.statusCode, 200, context.body);
    assert.deepEqual(context.json().context.roles, ['technician']); // provider claimed owner: ignored
    assert.equal((await get('/api/v1/__it/orders', auth('ownerA'))).statusCode, 200);
  });

  test('resource route + restricted grant: handler must mark; missing mark → 500 RESOURCE_AUTHORIZATION_CHECK_MISSING and ROLLBACK', async () => {
    const before = await customerNotes(C.A);
    const mark = checkpoint(main);
    const response = await app.inject({ method: 'POST', url: '/api/v1/__it/orders/omit', headers: auth('tech') });
    assertSanitized500(response, 'RESOURCE_AUTHORIZATION_CHECK_MISSING');
    assert.equal(await customerNotes(C.A), before, 'the unverified write was rolled back');
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).at(-1), 'ROLLBACK');
    assert.equal(tx.releases, 1);
  });

  test('resource route + restricted grant + correct mark → success', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/__it/orders/mark', headers: auth('tech') });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { before: 'required_pending', after: 'satisfied' });

    const qc = await app.inject({ method: 'POST', url: '/api/v1/__it/quality-checks', headers: auth('tech') });
    assert.equal(qc.statusCode, 200, qc.body);
    assert.deepEqual(qc.json(), { before: 'required_pending', after: 'satisfied' });
  });

  test('resource route: marking with a scope that was not granted → sanitized 500; pending + error reply → ROLLBACK', async () => {
    assertSanitized500(await app.inject({ method: 'POST', url: '/api/v1/__it/orders/wrong-scope', headers: auth('tech') }));

    const before = await customerNotes(C.A);
    const notFound = await app.inject({ method: 'POST', url: '/api/v1/__it/orders/not-found', headers: auth('tech') });
    assert.equal(notFound.statusCode, 404, notFound.body);
    assert.equal(await customerNotes(C.A), before, 'nothing written without a resource check survives');
  });

  test('a declared durable 409 cannot bypass a pending resource check', async () => {
    const before = await customerNotes(C.A);
    const mark = checkpoint(main);
    const response = await app.inject({ method: 'POST', url: '/api/v1/__it/durable-pending', headers: auth('tech') });
    assertSanitized500(response, 'RESOURCE_AUTHORIZATION_CHECK_MISSING');
    assert.equal(await customerNotes(C.A), before, 'pending resource write must roll back');
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'ROLLBACK').length, 1);
    assert.equal(kinds(tx).includes('COMMIT'), false);
    assert.equal(tx.releases, 1);
  });

  test('resource route + tenant grant → no resource check required', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/__it/orders/omit', headers: auth('ownerA') });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { before: 'not_required', after: 'not_required' });
    assert.match(await customerNotes(C.A), /^resource-omit-/);
  });
});

describe('unknown authorization data in PostgreSQL fails closed', () => {
  async function constraintDefinition(table, name) {
    const [row] = await admin`
      SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition
      FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = ${`public.${table}`}::regclass AND c.conname = ${name}
    `;
    assert.ok(row, `${table}.${name} exists`);
    return row.definition;
  }

  // Simulated catalog drift in THIS disposable database only.
  async function withoutConstraint(table, name, fn) {
    const definition = await constraintDefinition(table, name);
    await admin.unsafe(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}`);
    try {
      await fn();
    } finally {
      await admin.unsafe(`ALTER TABLE public.${table} ADD CONSTRAINT ${name} ${definition}`);
    }
  }

  async function assertFailsClosed() {
    const runs = runsOf('context');
    const mark = checkpoint(main);
    const response = await get('/api/v1/__it/context', auth('ghost'));
    assertSanitized500(response);
    assert.equal(runsOf('context'), runs);
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).at(-1), 'ROLLBACK');
    assert.equal(tx.releases, 1);
  }

  test('unknown role code → sanitized 500 (no row is ignored)', async () => {
    const ghostRole = id();
    await withoutConstraint('roles', 'roles_code_check', async () => {
      await admin`INSERT INTO public.roles ${admin({ id: ghostRole, code: 'ghost_role', name: 'Ghost', scope: 'tenant', is_system: true })}`;
      await admin`INSERT INTO public.membership_roles ${admin({ tenant_id: T.C, membership_id: M.ghostC, role_id: ghostRole, assigned_by_membership_id: M.ghostC })}`;
      try {
        await assertFailsClosed();
      } finally {
        await admin`DELETE FROM public.membership_roles WHERE membership_id = ${M.ghostC}`;
        await admin`DELETE FROM public.roles WHERE id = ${ghostRole}`;
      }
    });
  });

  test('unknown permission code and unknown resource scope → sanitized 500', async () => {
    await admin`INSERT INTO public.membership_roles ${admin({ tenant_id: T.C, membership_id: M.ghostC, role_id: roleId.service_advisor, assigned_by_membership_id: M.ghostC })}`;
    try {
      const control = await get('/api/v1/__it/context', auth('ghost'));
      assert.equal(control.statusCode, 200, control.body);
      assert.deepEqual(control.json().context.roles, ['service_advisor']);

      const ghostPermission = id();
      await admin`INSERT INTO public.permissions ${admin({ id: ghostPermission, code: 'ghost.permission', description: 'Ghost' })}`;
      await admin`INSERT INTO public.role_permissions ${admin({ role_id: roleId.service_advisor, permission_id: ghostPermission, resource_scope: 'tenant' })}`;
      try {
        await assertFailsClosed();
      } finally {
        await admin`DELETE FROM public.role_permissions WHERE permission_id = ${ghostPermission}`;
        await admin`DELETE FROM public.permissions WHERE id = ${ghostPermission}`;
      }

      await withoutConstraint('role_permissions', 'role_permissions_resource_scope_check', async () => {
        await admin`
          INSERT INTO public.role_permissions (role_id, permission_id, resource_scope)
          SELECT ${roleId.service_advisor}, p.id, 'ghost_scope' FROM public.permissions AS p WHERE p.code = 'memberships.read'
        `;
        try {
          await assertFailsClosed();
        } finally {
          await admin`DELETE FROM public.role_permissions WHERE resource_scope = 'ghost_scope'`;
        }
      });

      assert.equal((await get('/api/v1/__it/context', auth('ghost'))).statusCode, 200, 'catalog restored');
    } finally {
      await admin`DELETE FROM public.membership_roles WHERE membership_id = ${M.ghostC}`;
    }
  });
});

describe('transaction lifetime and connection release', () => {
  test('success commits; generic 400, 403, 409 and 500 after a real write roll back', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/v1/__it/customers/notes', headers: auth('ownerA') });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(await customerNotes(C.A), /^notes-/);
    const before = await customerNotes(C.A);
    for (const status of [400, 403, 409, 500]) {
      const mark = checkpoint(main);
      const response = await app.inject({
        method: 'POST', url: `/api/v1/__it/customers/notes?fail=reply-${status}`, headers: auth('ownerA'),
      });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(await customerNotes(C.A), before, `${status} must roll back the write`);
      const [tx] = since(main, mark).transactions;
      assert.equal(kinds(tx).at(-1), 'ROLLBACK');
      assert.equal(kinds(tx).filter((kind) => kind === 'ROLLBACK').length, 1);
      assert.equal(kinds(tx).includes('COMMIT'), false);
      assert.equal(tx.releases, 1);
    }
  });

  test('a real internal onSend error over a 409 is a sanitized 500 and rolls back once', async () => {
    const before = await customerNotes(C.A);
    const mark = checkpoint(main);
    const response = await app.inject({ method: 'POST', url: '/api/v1/__it/on-send-error', headers: auth('ownerA') });
    assertSanitized500(response);
    for (const sentinel of ['TENANT_CONTEXT_CLIENT_MISMATCH', 'users_external_identity_key', 'internal-user-uuid', 'INTERNAL_SQL_SENTINEL']) {
      assert.equal(response.body.includes(sentinel), false, sentinel);
    }
    assert.equal(await customerNotes(C.A), before);
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'ROLLBACK').length, 1);
    assert.equal(kinds(tx).includes('COMMIT'), false);
    assert.equal(tx.releases, 1);
    assert.equal(await idleInTransaction(), 0);
  });

  test('permission denial before the handler leaves the customer unchanged', async () => {
    const before = await customerNotes(C.A);
    const mark = checkpoint(main);
    assertError(await app.inject({ method: 'POST', url: '/api/v1/__it/customers/notes', headers: auth('tech') }), 403, 'PERMISSION_DENIED');
    assert.equal(await customerNotes(C.A), before);
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'ROLLBACK').length, 1);
    assert.equal(tx.releases, 1);
  });

  for (const fail of ['throw', 'serialize', 'onsend']) {
    test(`${fail} failure after a write → sanitized 500, ROLLBACK, connection released`, async () => {
      const before = await customerNotes(C.A);
      const mark = checkpoint(main);
      const response = await app.inject({ method: 'POST', url: `/api/v1/__it/customers/notes?fail=${fail}`, headers: auth('ownerA') });
      assertSanitized500(response);
      assert.equal(await customerNotes(C.A), before, 'write rolled back');
      const [tx] = since(main, mark).transactions;
      assert.deepEqual(kinds(tx).slice(-2), ['other', 'ROLLBACK']);
      assert.equal(tx.releases, 1);
    });
  }

  test('client aborts while the handler runs: handler completes, transaction ends, connection released', async () => {
    const mark = checkpoint(aborts);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let started;
      let release;
      const handlerStarted = new Promise((resolve) => { started = resolve; });
      slowGate.onStart = started;
      slowGate.release = new Promise((resolve) => { release = resolve; });

      const request = http.request({ host: '127.0.0.1', port: abortPort, path: '/api/v1/__it/slow', headers: auth('ownerA'), agent: false });
      request.on('error', () => {});
      request.end();
      await handlerStarted;
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const tx = aborts.probe.transactions.at(-1);
      await waitFor(() => tx.releases === 1, 'aborted request release');
      assert.equal(kinds(tx).at(-1), 'COMMIT');
    }
    slowGate.onStart = () => {};
    slowGate.release = Promise.resolve();
    // Pool of 2 after 3 aborted requests: nothing leaked.
    const response = await httpRequest(abortPort, { path: '/api/v1/__it/context', headers: auth('ownerA') });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(since(aborts, mark).transactions.every((tx) => tx.releases === 1), true);
    assert.equal(await idleInTransaction(), 0);
  });

  test('client aborts while uploading the body: transaction rolled back, handler never runs', async () => {
    const runs = runsOf('notes');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const mark = checkpoint(aborts);
      const request = http.request({
        host: '127.0.0.1',
        port: abortPort,
        method: 'POST',
        path: '/api/v1/__it/customers/notes',
        headers: { ...auth('ownerA'), 'content-type': 'application/json', 'content-length': '4096' },
        agent: false,
      });
      request.on('error', () => {});
      request.write('{"partial":');
      await waitFor(() => {
        const tx = aborts.probe.transactions[mark.tx];
        return tx !== undefined && kinds(tx).includes('load');
      }, 'tenant transaction opened');
      request.destroy();
      const tx = aborts.probe.transactions[mark.tx];
      await waitFor(() => tx.releases === 1, 'body-abort release');
      assert.equal(kinds(tx).at(-1), 'ROLLBACK');
    }
    assert.equal(runsOf('notes'), runs);
    await waitFor(async () => (await idleInTransaction()) === 0, 'no idle-in-transaction session');
    const response = await httpRequest(abortPort, { path: '/api/v1/__it/context', headers: auth('ownerA') });
    assert.equal(response.statusCode, 200, response.body);
  });
});

describe('media durable 4xx outcomes', () => {
  async function createSession() {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('ownerA'),
      payload: {
        mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational',
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  }

  test('retry creation of an expired session commits only its explicit 409 outcome', async () => {
    const idempotencyKey = randomUUID();
    const payload = { mediaType: 'photo', mimeType: 'image/png', retentionClass: 'operational', idempotencyKey };
    const created = await app.inject({ method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('ownerA'), payload });
    assert.equal(created.statusCode, 201, created.body);
    const sessionId = created.json().uploadSessionId;
    await admin`UPDATE upload_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${sessionId}`;

    const mark = checkpoint(main);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/media/upload-sessions', headers: auth('ownerA'), payload });
    assertError(retry, 409, 'UPLOAD_SESSION_EXPIRED');
    const [stored] = await admin`SELECT status FROM upload_sessions WHERE id = ${sessionId}`;
    assert.equal(stored.status, 'expired');
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'COMMIT').length, 1);
    assert.equal(kinds(tx).includes('ROLLBACK'), false);
    assert.equal(tx.releases, 1);
  });

  test('completion of an expired session commits its explicit 409 outcome', async () => {
    const created = await createSession();
    await admin`UPDATE upload_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${created.uploadSessionId}`;
    const mark = checkpoint(main);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
      headers: auth('ownerA'), payload: {},
    });
    assertError(response, 409, 'UPLOAD_SESSION_EXPIRED');
    const [stored] = await admin`SELECT status FROM upload_sessions WHERE id = ${created.uploadSessionId}`;
    assert.equal(stored.status, 'expired');
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'COMMIT').length, 1);
    assert.equal(kinds(tx).includes('ROLLBACK'), false);
    assert.equal(tx.releases, 1);
  });

  test('invalid stored object size commits quarantine and failed session on explicit 422', async () => {
    const created = await createSession();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'HEAD');
      return new Response(null, { status: 200, headers: { 'content-length': String(21 * 1024 * 1024) } });
    };
    const mark = checkpoint(main);
    let response;
    try {
      response = await app.inject({
        method: 'POST', url: `/api/v1/media/upload-sessions/${created.uploadSessionId}/complete`,
        headers: auth('ownerA'), payload: {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assertError(response, 422, 'MEDIA_SIZE_INVALID');
    const [stored] = await admin`
      SELECT ma.status AS asset_status, us.status AS session_status
      FROM media_assets AS ma JOIN upload_sessions AS us
        ON us.tenant_id = ma.tenant_id AND us.media_asset_id = ma.id
      WHERE ma.id = ${created.mediaAssetId}
    `;
    assert.deepEqual({ ...stored }, { asset_status: 'quarantined', session_status: 'failed' });
    const [tx] = since(main, mark).transactions;
    assert.equal(kinds(tx).filter((kind) => kind === 'COMMIT').length, 1);
    assert.equal(kinds(tx).includes('ROLLBACK'), false);
    assert.equal(tx.releases, 1);
  });
});

describe('GET /api/v1/me', () => {
  const EMPTY_ME = { user: null, memberships: [], tenantSelection: { mode: 'unavailable', tenantId: null } };
  const me = (headers) => app.inject({ method: 'GET', url: '/api/v1/me', headers });

  test('unauthenticated → 401', async () => {
    assertError(await me({}), 401, 'AUTHENTICATION_REQUIRED');
  });

  test('no local user, user without memberships, disabled user, only inactive memberships: indistinguishable', async () => {
    for (const userKey of ['unknown', 'none', 'disabled', 'inactive']) {
      const response = await me(auth(userKey));
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), EMPTY_ME, userKey);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  test('1 membership → automatic selection; only the caller\'s own membership, no roles/permissions', async () => {
    const response = await me(auth('ownerA'));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      user: { id: U.ownerA },
      memberships: [{ membershipId: M.ownerA, tenantId: T.A }],
      tenantSelection: { mode: 'automatic', tenantId: T.A },
    });
  });

  test('N memberships → selection required, all own active memberships listed', async () => {
    const response = await me(auth('multi'));
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.deepEqual(body.user, { id: U.multi });
    assert.deepEqual(
      [...body.memberships].sort((x, y) => (x.tenantId < y.tenantId ? -1 : 1)),
      [{ membershipId: M.multiA, tenantId: T.A }, { membershipId: M.multiB, tenantId: T.B }]
        .sort((x, y) => (x.tenantId < y.tenantId ? -1 : 1)),
    );
    assert.deepEqual(body.tenantSelection, { mode: 'required', tenantId: null });
  });

  test('/me is identity-only: no tenant transaction, X-Tenant-Id not interpreted, never creates rows', async () => {
    const mark = checkpoint(main);
    const response = await me(withTenant('none', 'not-a-uuid'));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), EMPTY_ME);
    assert.deepEqual(since(main, mark), { pool: ['discover'], transactions: [] });
    const [counts] = await admin`
      SELECT
        (SELECT count(*)::int FROM public.users WHERE external_subject = ${UNKNOWN_SUBJECT}) AS users,
        (SELECT count(*)::int FROM public.memberships WHERE user_id = ${U.none}) AS memberships
    `;
    assert.deepEqual({ ...counts }, { users: 0, memberships: 0 });
  });
});

describe('route contract', () => {
  const boot = (registerRoutes, registerIdentityOnlyRoutes) => buildApi({
    database: main.sql,
    identityProvider,
    ...(registerRoutes ? { registerRoutes } : {}),
    ...(registerIdentityOnlyRoutes ? { registerIdentityOnlyRoutes } : {}),
  });

  test('tenant routes without a valid permission contract fail at registration', async () => {
    const invalid = [
      {},
      { permission: 'orders.fly' },
      { permission: 'orders.read', permissionScope: 'global' },
      { permissionScope: 'resource' },
      { permission: 'workshop.read', identityProfile: 'required' },
    ];
    for (const config of invalid) {
      await assert.rejects(
        boot((server) => { server.get('/api/v1/__it/invalid', { config }, async () => ({})); }),
        (error) => error instanceof TenantRouteConfigurationError,
        JSON.stringify(config),
      );
    }
  });

  test('identity-only routes cannot declare a permission', async () => {
    await assert.rejects(
      boot(undefined, (server) => {
        server.get('/api/v1/__it/identity-invalid', { config: { permission: 'workshop.read' } }, async () => ({}));
      }),
      /IDENTITY_ROUTE_CONFIGURATION_INVALID/,
    );
  });
});

describe('identity boundary', () => {
  test('the provider profile was never fetched by /me or any tenant route', () => {
    assert.ok(providerCalls.verify > 50);
    assert.equal(providerCalls.profile, 0);
  });
});
