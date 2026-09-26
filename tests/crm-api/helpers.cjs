'use strict';

/**
 * S2-04 test harness, layered on the S1-05 harness (itself on the S1-03 one,
 * which installs the hermetic fetch trap before any compiled module loads).
 * Real ClerkIdentityProvider (per-run RS256 keys), real PostgreSQL through the
 * NOBYPASSRLS api/worker runtime logins (ADR-009), and the production
 * registerCustomerRoutes.
 */

const h = require('../member-roles/helpers.cjs');
const { randomUUID } = require('node:crypto');

const { buildApi } = h.load('api/app.js');
const { ClerkIdentityProvider } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerCustomerRoutes } = h.load('customers/routes.js');

const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const BIG_LIMIT = { max: 100_000, timeWindow: '1 minute' };

/** Customer column names in the canonical audit order (DOC_GAP-05). */
const AUDIT_FIELD_ORDER = ['first_name', 'last_name', 'phone', 'email', 'document_type', 'document_number', 'notes'];
const DTO_KEYS = [
  'createdAt', 'customerId', 'documentNumber', 'documentType', 'email', 'firstName', 'lastName', 'notes', 'phone', 'updatedAt',
].sort();
const TOKEN_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

async function buildCustomersApp() {
  return buildApi({
    database: h.apiPool,
    identityProvider: provider,
    rateLimit: BIG_LIMIT,
    registerRoutes(server) {
      registerCustomerRoutes(server);
    },
  });
}

const createCustomer = (app, actor, tenantId, body, extra = {}) => h.call(app, {
  subject: actor.subject, method: 'POST', url: '/api/v1/customers', body, tenantId, ...extra,
});
const getCustomer = (app, actor, tenantId, customerId, extra = {}) => h.call(app, {
  subject: actor.subject, url: `/api/v1/customers/${customerId}`, tenantId, ...extra,
});
const patchCustomer = (app, actor, tenantId, customerId, body, extra = {}) => h.call(app, {
  subject: actor.subject, method: 'PATCH', url: `/api/v1/customers/${customerId}`, body, tenantId, ...extra,
});
/** `query` is a raw query string (without '?') so repeated/unknown keys can be sent verbatim. */
const listCustomers = (app, actor, tenantId, query = '', extra = {}) => h.call(app, {
  subject: actor.subject, url: `/api/v1/customers${query ? `?${query}` : ''}`, tenantId, ...extra,
});

function validCustomer(overrides = {}) {
  return { firstName: 'Ana', lastName: 'Gómez', phone: '3001234567', ...overrides };
}

/** Privileged fixture insert (bypasses the API; used for list/pagination volume and RLS probes). */
async function seedCustomer(tenantId, overrides = {}) {
  const row = {
    id: randomUUID(),
    tenant_id: tenantId,
    first_name: 'Seed',
    last_name: 'Customer',
    phone: '3000000000',
    email: null,
    document_type: null,
    document_number: null,
    notes: null,
    ...overrides,
  };
  await h.admin`INSERT INTO public.customers ${h.admin(row)}`;
  return row;
}

async function customerRow(customerId) {
  const [row] = await h.admin`
    SELECT id, tenant_id, first_name, last_name, phone, email, document_type, document_number, notes,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
      xmin::text AS xmin
    FROM public.customers WHERE id = ${customerId}
  `;
  return row ? { ...row } : null;
}

async function customerAudits(entityId) {
  const rows = await h.admin`
    SELECT action, outcome, tenant_id, actor_type, actor_user_id, actor_membership_id, entity_type, entity_id,
      reason_code, before_json, after_json, metadata_json, request_id, user_agent, host(ip_address) AS ip
    FROM public.audit_logs
    WHERE entity_id = ${entityId} AND action LIKE 'customer.%'
    ORDER BY created_at, id
  `;
  return rows.map((row) => ({ ...row }));
}

async function tenantAuditCount(tenantId) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.audit_logs WHERE tenant_id = ${tenantId}`;
  return row.n;
}

async function tenantCustomerCount(tenantId) {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.customers WHERE tenant_id = ${tenantId}`;
  return row.n;
}

/** Error body without the per-request id, for byte-identical anti-oracle comparisons. */
function errorShape(response) {
  const error = response.json?.error ?? {};
  return JSON.stringify({ status: response.status, code: error.code, message: error.message, keys: Object.keys(error).sort() });
}

/**
 * Captures everything written to stdout/stderr/console while `fn` runs, so a
 * suite can prove request handling emits no PII.
 */
async function captureOutput(fn) {
  const chunks = [];
  const originals = {
    out: process.stdout.write, err: process.stderr.write,
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
  };
  const sink = (chunk) => { chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; };
  process.stdout.write = sink;
  process.stderr.write = sink;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = (...args) => { chunks.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = originals[method];
  }
  return chunks.join('');
}

async function closeAll(app) {
  await app?.close();
  await h.apiPool.end({ timeout: 5 });
  await h.workerPool.end({ timeout: 5 });
  await h.admin.end({ timeout: 5 });
}

module.exports = {
  ...h,
  AUDIT_FIELD_ORDER,
  DTO_KEYS,
  TOKEN_FORMAT,
  buildCustomersApp,
  createCustomer,
  getCustomer,
  patchCustomer,
  listCustomers,
  validCustomer,
  seedCustomer,
  customerRow,
  customerAudits,
  tenantAuditCount,
  tenantCustomerCount,
  errorShape,
  captureOutput,
  closeAll,
};
