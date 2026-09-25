'use strict';

/**
 * S1-07 audit harness, layered on the S1-04 invitation harness (itself on the
 * S1-03 identity harness, which installs the hermetic fetch trap before any
 * compiled module loads). ONE app registers every Sprint 1 audited surface:
 *
 *   public         POST /api/v1/webhooks/clerk                 (S1-03)
 *   identity-only  POST /api/v1/onboarding/workshops           (S1-01 + JIT)
 *                  POST /api/v1/membership-invitations/accept  (S1-04 + JIT)
 *   tenant         membership-invitations (S1-04), memberships/:id/roles
 *                  (S1-05), memberships/:id/suspend|revoke (S1-06)
 *
 * and ONE worker option set runs every audited job: S1-03 lifecycle sync and
 * membership revocation, S1-04 invitation email (recording sender).
 *
 * The canonical event catalog (CATALOG) is the executable form of the S1-07
 * inventory (docs/S1-07-DOC-CHANGES.md §1): every audit row the database holds
 * must match one of its (actor_type, outcome, reason_code) tuples.
 */

const h = require('../invitations/helpers.cjs');
const { randomUUID } = require('node:crypto');

const { buildApi, getTenantRequestContext } = h.load('api/app.js');
const { ClerkIdentityProvider, ClerkIdentitySnapshotSource } = h.load('identity/clerk/clerk-identity-provider.js');
const { registerInvitationRoutes, registerInvitationAcceptRoute } = h.load('invitations/routes.js');
const { registerMemberRoleRoutes } = h.load('memberships/roles-routes.js');
const { registerMemberLifecycleRoutes } = h.load('memberships/lifecycle-routes.js');
const { registerOnboardingRoutes } = h.load('onboarding/routes.js');
const { PostgresClerkWebhookRepository, registerClerkWebhookRoute } = h.load('identity/webhook-routes.js');
const { createIdentityLifecycleHandler, IDENTITY_LIFECYCLE_EVENT_TYPE } = h.load('identity/sync/lifecycle-sync.js');
const { createMembershipRevocationHandler, MEMBERSHIP_REVOCATION_EVENT_TYPE } = h.load('identity/sync/membership-revocation.js');

const BIG_LIMIT = { max: 100_000, timeWindow: '1 minute' };
const provider = new ClerkIdentityProvider(h.clerkAuthenticationConfig(), { usersApi: h.clerkUsers });
const source = new ClerkIdentitySnapshotSource({ secretKey: 'sk_test_hermetic', backendApiTimeoutMs: 200 }, { usersApi: h.clerkUsers });
const webhookSecret = h.newWebhookSecret();
const repository = new PostgresClerkWebhookRepository(h.apiPool);
const REQUEST_ID_HEADER = 'x-s107-request-id';

/** Test-only: exposes the server-generated request id so audit rows can be matched exactly. */
function exposeRequestId(server) {
  server.addHook('onSend', async (request, reply, payload) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    return payload;
  });
}

async function buildAuditApp() {
  return buildApi({
    database: h.apiPool,
    identityProvider: provider,
    rateLimit: BIG_LIMIT,
    registerPublicRoutes(server) {
      exposeRequestId(server);
      registerClerkWebhookRoute(server, { signingSecret: webhookSecret, repository });
    },
    registerIdentityOnlyRoutes(server) {
      exposeRequestId(server);
      registerOnboardingRoutes(server, { database: h.apiPool, rateLimit: BIG_LIMIT });
      registerInvitationAcceptRoute(server, { database: h.apiPool, rateLimit: BIG_LIMIT });
    },
    registerRoutes(server) {
      exposeRequestId(server);
      registerInvitationRoutes(server, { config: h.apiConfig, rateLimit: BIG_LIMIT });
      registerMemberRoleRoutes(server, { rateLimit: BIG_LIMIT });
      registerMemberLifecycleRoutes(server, { rateLimit: BIG_LIMIT });
      server.get('/api/v1/__s107/whoami', { config: { permission: 'workshop.read' } }, async (request) => {
        const context = getTenantRequestContext(request);
        return { tenantId: context.tenant.tenantId, userId: context.tenant.userId, membershipId: context.tenant.membershipId };
      });
    },
  });
}

/** Records every provider request; never touches the network. */
class RecordingSender {
  constructor() {
    this.calls = [];
  }

  async send(message, idempotencyKey) {
    this.calls.push({ message, idempotencyKey });
    return { providerMessageId: `re_msg_${randomUUID()}` };
  }
}

function workerOptions(sender = new RecordingSender(), revocationOutcomes = []) {
  return {
    database: h.workerPool,
    handlers: {
      [MEMBERSHIP_REVOCATION_EVENT_TYPE]: createMembershipRevocationHandler({ onOutcome: (outcome) => revocationOutcomes.push(outcome) }),
    },
    phasedHandlers: {
      [IDENTITY_LIFECYCLE_EVENT_TYPE]: createIdentityLifecycleHandler({ source, workerId: 'worker-s107' }),
      [h.EMAIL_EVENT]: h.email.createInvitationEmailHandler({ config: { tokenKey: h.tokenKey }, sender }),
    },
    maxAttempts: 3,
    baseDelaySeconds: 1,
  };
}

const drain = (sender, outcomes) => h.drainOutbox(h.worker, workerOptions(sender, outcomes));

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** Like the S1-04 call helper, plus the exact request id of the response. */
async function call(app, { subject, method = 'GET', url, body, tenantId, headers = {}, rawBody, bearer }) {
  const requestHeaders = { ...headers };
  if (bearer) requestHeaders.authorization = `Bearer ${bearer}`;
  else if (subject) requestHeaders.authorization = `Bearer ${h.sessionToken(subject)}`;
  if (tenantId) requestHeaders['x-tenant-id'] = tenantId;
  if (body !== undefined || rawBody !== undefined) requestHeaders['content-type'] ??= 'application/json';
  const response = await app.inject({
    method,
    url,
    headers: requestHeaders,
    payload: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let json = null;
  try { json = response.json(); } catch { json = null; }
  return {
    status: response.statusCode,
    json,
    headers: response.headers,
    requestId: response.headers[REQUEST_ID_HEADER] ?? json?.error?.request_id ?? null,
  };
}

const onboard = (app, identity, label, extra = {}) => call(app, {
  subject: identity.subject,
  method: 'POST',
  url: '/api/v1/onboarding/workshops',
  body: {
    workshop: { legalName: `Taller ${label} S.A.S.`, displayName: `Taller ${label}` },
    primaryLocation: { name: 'Sede principal', addressLine: 'Calle 1 # 2-3', city: 'Bogotá', department: 'Cundinamarca' },
  },
  ...extra,
});
const invite = (app, actor, tenantId, body, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: '/api/v1/membership-invitations', body, tenantId, ...extra,
});
const revokeInvite = (app, actor, tenantId, invitationId, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/membership-invitations/${invitationId}/revoke`, tenantId, ...extra,
});
const accept = (app, identity, rawToken, extra = {}) => call(app, {
  subject: identity.subject, method: 'POST', url: '/api/v1/membership-invitations/accept', body: { token: rawToken }, ...extra,
});
const assignRole = (app, actor, tenantId, membershipId, role, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/memberships/${membershipId}/roles`, body: { role_code: role }, tenantId, ...extra,
});
const removeRole = (app, actor, tenantId, membershipId, role, extra = {}) => call(app, {
  subject: actor.subject, method: 'DELETE', url: `/api/v1/memberships/${membershipId}/roles/${role}`, tenantId, ...extra,
});
const suspend = (app, actor, tenantId, membershipId, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/memberships/${membershipId}/suspend`, tenantId, ...extra,
});
const revoke = (app, actor, tenantId, membershipId, extra = {}) => call(app, {
  subject: actor.subject, method: 'POST', url: `/api/v1/memberships/${membershipId}/revoke`, tenantId, ...extra,
});

/** Signed Clerk webhook delivery through the real route. */
async function webhook(app, type, subject, timestampMs, options = {}) {
  const delivery = h.signedDelivery(webhookSecret, options.body ?? h.clerkEventBody(type, subject, timestampMs, options), options);
  const result = await call(app, {
    method: 'POST', url: '/api/v1/webhooks/clerk', rawBody: delivery.body, headers: delivery.headers,
  });
  return { ...result, delivery };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tenant A: owner, admin, advisor, technician, plus extra technicians;
 * tenant B: owner + technician. Seeded with triggers off (fixtures).
 */
async function tenants({ extraTechnicians = 0, extraOwners = 0 } = {}) {
  const base = await h.twoTenants();
  const extras = [];
  for (let i = 0; i < extraTechnicians + extraOwners; i += 1) {
    const identity = await h.member(i < extraTechnicians ? `xtech${i}` : `xowner${i}`);
    extras.push({ identity, role: i < extraTechnicians ? 'technician' : 'owner' });
  }
  const roleIds = {};
  for (const code of ['owner', 'technician']) roleIds[code] = await h.roleId(code);
  const extraMembers = [];
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const extra of extras) {
      const membershipId = randomUUID();
      await tx`INSERT INTO public.memberships ${tx({ id: membershipId, tenant_id: base.a.tenantId, user_id: extra.identity.user.id, status: 'active' })}`;
      await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: base.a.tenantId, membership_id: membershipId, role_id: roleIds[extra.role], assigned_by_membership_id: base.a.owner.membershipId })}`;
      extraMembers.push({ ...extra.identity, membershipId });
    }
  });
  const techB = await h.member('techb');
  const techBMembership = randomUUID();
  await h.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.memberships ${tx({ id: techBMembership, tenant_id: base.b.tenantId, user_id: techB.user.id, status: 'active' })}`;
    await tx`INSERT INTO public.membership_roles ${tx({ tenant_id: base.b.tenantId, membership_id: techBMembership, role_id: roleIds.technician, assigned_by_membership_id: base.b.owner.membershipId })}`;
  });
  return {
    a: { ...base.a, extras: extraMembers },
    b: { ...base.b, technician: { ...techB, membershipId: techBMembership } },
  };
}

/** A Clerk identity only (no local users row). */
function identity(label, options = {}) {
  return h.invitee(label, options);
}

/* -------------------------------------------------------------------------- */
/* Audit inspection (admin connection: never a runtime role)                  */
/* -------------------------------------------------------------------------- */

const AUDIT_SELECT = `
  id, tenant_id, actor_type, actor_user_id, actor_membership_id, action, outcome, entity_type, entity_id,
  reason_code, before_json, after_json, metadata_json, request_id, trace_id, host(ip_address) AS ip_address,
  user_agent, created_at`;

const plain = (rows) => rows.map((row) => ({ ...row }));

async function auditsByRequest(requestId) {
  return plain(await h.admin.unsafe(`SELECT ${AUDIT_SELECT} FROM public.audit_logs WHERE request_id = $1 ORDER BY action, id`, [requestId]));
}

async function auditsForEntity(entityId, actionPrefix = '') {
  return plain(await h.admin.unsafe(
    `SELECT ${AUDIT_SELECT} FROM public.audit_logs WHERE entity_id = $1 AND action LIKE $2 ORDER BY id`,
    [entityId, `${actionPrefix}%`],
  ));
}

async function auditsForTenant(tenantId) {
  return plain(await h.admin.unsafe(`SELECT ${AUDIT_SELECT} FROM public.audit_logs WHERE tenant_id = $1 ORDER BY id`, [tenantId]));
}

async function allAudits() {
  return plain(await h.admin.unsafe(`SELECT ${AUDIT_SELECT} FROM public.audit_logs ORDER BY id`));
}

async function auditCount() {
  const [row] = await h.admin`SELECT count(*)::int AS n FROM public.audit_logs`;
  return row.n;
}

/** Audit rows that mention an id anywhere (entity, actor, JSON) — contamination probe. */
async function auditsMentioning(value) {
  return plain(await h.admin.unsafe(`
    SELECT ${AUDIT_SELECT} FROM public.audit_logs
    WHERE entity_id::text = $1 OR actor_user_id::text = $1 OR actor_membership_id::text = $1
      OR tenant_id::text = $1 OR request_id = $1
      OR coalesce(before_json::text, '') LIKE '%' || $1 || '%'
      OR coalesce(after_json::text, '') LIKE '%' || $1 || '%'
      OR coalesce(metadata_json::text, '') LIKE '%' || $1 || '%'`, [value]));
}

/* -------------------------------------------------------------------------- */
/* Canonical catalog (docs/S1-07-DOC-CHANGES.md §1)                           */
/* -------------------------------------------------------------------------- */

const T = (actor, outcome, reason) => `${actor}|${outcome}|${reason ?? '-'}`;

const CATALOG = Object.freeze({
  'workshop.created': { entity: 'workshop', tenant: true, tuples: [T('user', 'success', 'workshop_onboarding')] },
  'membership.activated': {
    entity: 'membership', tenant: true,
    tuples: [T('user', 'success', 'workshop_onboarding'), T('user', 'success', 'membership_invitation')],
  },
  'role.assigned': {
    entity: 'membership_role', tenant: true,
    tuples: [
      T('user', 'success', 'workshop_onboarding'), T('user', 'success', 'membership_invitation'),
      T('user', 'success', 'member_role_management'),
      T('user', 'denied', 'role_assignment_not_permitted'), T('user', 'denied', 'self_role_modification'),
    ],
  },
  'role.revoked': {
    entity: 'membership_role', tenant: true,
    tuples: [
      T('user', 'success', 'member_role_management'),
      T('user', 'denied', 'role_assignment_not_permitted'), T('user', 'denied', 'self_role_modification'),
    ],
  },
  'membership.invited': {
    entity: 'membership_invitation', tenant: true,
    tuples: [T('user', 'success', 'membership_invitation'), T('user', 'denied', 'role_assignment_not_permitted')],
  },
  'membership.invitation_revoked': {
    entity: 'membership_invitation', tenant: true,
    tuples: [T('user', 'success', 'membership_invitation'), T('user', 'denied', 'role_assignment_not_permitted')],
  },
  'membership.invitation_accepted': {
    entity: 'membership_invitation', tenant: true,
    tuples: [T('user', 'success', 'membership_invitation'), T('user', 'denied', 'invitation_email_mismatch')],
  },
  'membership.invitation_expired': { entity: 'membership_invitation', tenant: true, tuples: [T('system', 'success', 'membership_invitation')] },
  'membership.invitation_email_sent': { entity: 'membership_invitation', tenant: true, tuples: [T('system', 'success', 'membership_invitation')] },
  'membership.invitation_email_skipped': { entity: 'membership_invitation', tenant: true, tuples: [T('system', 'success', 'membership_invitation')] },
  'membership.suspended': {
    entity: 'membership', tenant: true,
    tuples: [
      T('user', 'success', 'member_status_management'),
      T('user', 'denied', 'membership_management_not_permitted'), T('user', 'denied', 'self_membership_modification'),
    ],
  },
  'membership.revoked': {
    entity: 'membership', tenant: true,
    tuples: [
      T('user', 'success', 'member_status_management'),
      T('user', 'denied', 'membership_management_not_permitted'), T('user', 'denied', 'self_membership_modification'),
      T('provider', 'success', 'identity_provider_user_deleted'), T('provider', 'denied', 'last_owner_invariant'),
    ],
  },
  'identity.user_provisioned_jit': { entity: 'user', tenant: false, tuples: [T('user', 'success', null)] },
  'identity.user_provisioned_webhook': { entity: 'user', tenant: false, tuples: [T('provider', 'success', null)] },
  'identity.user_profile_synced': { entity: 'user', tenant: false, tuples: [T('provider', 'success', null)] },
  'identity.user_disabled': { entity: 'user', tenant: false, tuples: [T('provider', 'success', null)] },
  'identity.user_deleted': { entity: 'user', tenant: false, tuples: [T('provider', 'success', null)] },
  'identity.webhook_event_conflict': { entity: 'webhook_event', tenant: false, tuples: [T('provider', 'denied', null)] },
});

/** Keys that must never appear anywhere in before/after/metadata (recursive). */
const FORBIDDEN_KEYS = /^(authorization|cookie|set-cookie|token|raw_token|token_hash|nonce|token_nonce|jwt|session|session_token|secret|password|api_key|apikey|signature|svix-signature|otp|email|email_normalized|full_name|name|phone|user_agent|user-agent|headers|payload|body|referer|ip)$/iu;
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/u;
const HEX64 = /\b[0-9a-f]{64}\b/iu;
const EMAIL = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/u;
const BEARER = /bearer\s/iu;

function* walk(value, path) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* walk(item, `${path}[${index}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      yield { kind: 'key', path: `${path}.${key}`, value: key };
      yield* walk(item, `${path}.${key}`);
    }
  } else if (typeof value === 'string') {
    yield { kind: 'string', path, value };
  }
}

/**
 * Every violation of the S1-07 data rules in `rows` (empty = clean): no
 * forbidden key, no JWT / bearer / 64-hex digest / email, none of the
 * `sensitive` literals (tokens, hashes, nonces, emails, names, the
 * User-Agent sent), user_agent always NULL.
 */
function scanAudits(rows, sensitive = []) {
  const literals = sensitive.filter((value) => typeof value === 'string' && value.length >= 6);
  const problems = [];
  for (const row of rows) {
    if (row.user_agent !== null) problems.push(`${row.id} user_agent present`);
    const fields = { before_json: row.before_json, after_json: row.after_json, metadata_json: row.metadata_json, request_id: row.request_id, reason_code: row.reason_code, trace_id: row.trace_id };
    for (const item of walk(fields, row.action)) {
      if (item.kind === 'key' && FORBIDDEN_KEYS.test(item.value)) problems.push(`${item.path} forbidden key`);
      if (item.kind !== 'string') continue;
      if (JWT.test(item.value) || BEARER.test(item.value)) problems.push(`${item.path} credential-like value`);
      if (HEX64.test(item.value)) problems.push(`${item.path} digest-like value`);
      if (EMAIL.test(item.value)) problems.push(`${item.path} email-like value`);
      for (const literal of literals) if (item.value.includes(literal)) problems.push(`${item.path} sensitive literal`);
    }
  }
  return problems;
}

/**
 * Structural invariants of every row (catalog + actor + tenant + entity
 * coherence), checked against the database itself.
 */
async function catalogViolations() {
  const rows = await allAudits();
  const problems = [];
  for (const row of rows) {
    const entry = CATALOG[row.action];
    if (!entry) { problems.push(`${row.id} unknown action ${row.action}`); continue; }
    if (row.entity_type !== entry.entity) problems.push(`${row.id} ${row.action} entity_type ${row.entity_type}`);
    if (!entry.tuples.includes(T(row.actor_type, row.outcome, row.reason_code))) {
      problems.push(`${row.id} ${row.action} tuple ${T(row.actor_type, row.outcome, row.reason_code)}`);
    }
    if (entry.tenant !== (row.tenant_id !== null)) problems.push(`${row.id} ${row.action} tenant scope`);
    // Only a denied invitation create has no entity: nothing was created.
    if (row.entity_id === null && !(row.action === 'membership.invited' && row.outcome === 'denied')) {
      problems.push(`${row.id} ${row.action} entity_id missing`);
    }
    if (row.actor_type === 'user' && row.actor_user_id === null) problems.push(`${row.id} ${row.action} user actor without user id`);
    if (row.actor_type !== 'user' && (row.actor_user_id !== null || row.actor_membership_id !== null)) {
      problems.push(`${row.id} ${row.action} ${row.actor_type} row attributed to a user`);
    }
    if (row.user_agent !== null) problems.push(`${row.id} ${row.action} user_agent`);
  }
  // Actor membership belongs to the actor user AND to the row's tenant.
  const actorMismatch = await h.admin`
    SELECT a.id, a.action FROM public.audit_logs a
    LEFT JOIN public.memberships m ON m.tenant_id = a.tenant_id AND m.id = a.actor_membership_id
    WHERE a.actor_membership_id IS NOT NULL AND (m.id IS NULL OR m.user_id IS DISTINCT FROM a.actor_user_id)
  `;
  for (const row of actorMismatch) problems.push(`${row.id} ${row.action} actor membership/user mismatch`);
  // The audited entity lives in the row's tenant (no resource id of another tenant).
  const entityMismatch = await h.admin`
    SELECT a.id, a.action FROM public.audit_logs a
    WHERE a.tenant_id IS NOT NULL AND a.entity_id IS NOT NULL AND NOT CASE a.entity_type
      WHEN 'workshop' THEN a.entity_id = a.tenant_id
      WHEN 'membership' THEN EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = a.tenant_id AND m.id = a.entity_id)
      WHEN 'membership_role' THEN EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = a.tenant_id AND m.id = a.entity_id)
      WHEN 'membership_invitation' THEN EXISTS (SELECT 1 FROM public.membership_invitations i WHERE i.tenant_id = a.tenant_id AND i.id = a.entity_id)
      ELSE false END
  `;
  for (const row of entityMismatch) problems.push(`${row.id} ${row.action} entity outside the row tenant`);
  // Identity rows point at a real local user / webhook event.
  const identityMismatch = await h.admin`
    SELECT a.id, a.action FROM public.audit_logs a
    WHERE a.tenant_id IS NULL AND NOT CASE a.entity_type
      WHEN 'user' THEN EXISTS (SELECT 1 FROM public.users u WHERE u.id = a.entity_id)
      WHEN 'webhook_event' THEN EXISTS (SELECT 1 FROM public.webhook_events w WHERE w.id = a.entity_id)
      ELSE false END
  `;
  for (const row of identityMismatch) problems.push(`${row.id} ${row.action} identity entity missing`);
  return problems;
}

/** Duplicate success rows for one logical event (same action + entity + request). */
async function duplicateSuccessRows() {
  return plain(await h.admin`
    SELECT action, entity_id, request_id, count(*)::int AS n FROM public.audit_logs
    WHERE outcome = 'success'
    GROUP BY action, entity_id, request_id HAVING count(*) > 1
  `);
}

/* -------------------------------------------------------------------------- */
/* Runtime SQL (NOBYPASSRLS logins, TenantContext GUCs bound)                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs `fn(conn)` as a runtime login inside one transaction with the given
 * GUCs (only the provided ones are bound). Rolls back unless `commit`.
 */
async function runtimeTx(pool, gucs, fn, { commit = false } = {}) {
  const conn = await pool.reserve();
  try {
    await conn.unsafe('BEGIN');
    for (const [name, value] of Object.entries(gucs)) {
      await conn`SELECT set_config(${`app.${name}`}, ${value}, true)`;
    }
    const result = await fn(conn);
    await conn.unsafe(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await conn.unsafe('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    conn.release();
  }
}

/** A minimal, valid API audit row for tenant/actor probes. */
function auditRow(overrides = {}) {
  return {
    id: randomUUID(), actor_type: 'user', action: 'membership.suspended', outcome: 'success',
    entity_type: 'membership', reason_code: 'member_status_management', ...overrides,
  };
}

/** Test-only failing trigger (admin DDL) on any table/timing; removed by the returned function. */
async function injectTrigger(table, { timing = 'BEFORE', event = 'INSERT', when = 'true', deferred = false } = {}) {
  const name = `s107_fail_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const body = `BEGIN IF ${when} THEN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END IF; RETURN NULL; END`;
  const rowBody = `BEGIN IF ${when} THEN RAISE EXCEPTION 'TEST_INJECTED_FAILURE'; END IF; RETURN ${event === 'DELETE' ? 'OLD' : 'NEW'}; END`;
  await h.admin.unsafe(`
    CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$ ${deferred ? body : rowBody} $f$;
    ${deferred
    ? `CREATE CONSTRAINT TRIGGER ${name} AFTER ${event} ON public.${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${name}();`
    : `CREATE TRIGGER ${name} ${timing} ${event} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}();`}
  `);
  return async () => {
    await h.admin.unsafe(`DROP TRIGGER IF EXISTS ${name} ON public.${table}; DROP FUNCTION IF EXISTS public.${name}();`);
  };
}

async function membershipStatus(membershipId) {
  const [row] = await h.admin`SELECT status FROM public.memberships WHERE id = ${membershipId}`;
  return row?.status ?? null;
}

async function roleCodes(membershipId) {
  const rows = await h.admin`
    SELECT r.code FROM public.membership_roles mr JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.membership_id = ${membershipId} ORDER BY r.code`;
  return rows.map((row) => row.code);
}

/** Waits until `count` backends of this database wait on a lock. */
async function waitForLockWaiters(count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await h.admin`
      SELECT count(DISTINCT l.pid)::int AS n FROM pg_catalog.pg_locks AS l
      JOIN pg_catalog.pg_stat_activity AS a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = pg_catalog.current_database()
    `;
    if (row.n >= count) return;
    if (Date.now() > deadline) throw new Error(`LOCK_WAITERS_NOT_REACHED ${row.n}/${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Admin transaction holding a tenant's owner-set lock exactly like a runtime holder (0013). */
async function holdTenantLock(tenantId) {
  const conn = await h.admin.reserve();
  await conn.unsafe('BEGIN');
  await conn`LOCK TABLE app.owner_mutation_gate IN ACCESS SHARE MODE`;
  await conn`SELECT id FROM public.workshops WHERE id = ${tenantId} FOR NO KEY UPDATE`;
  return {
    async release() {
      try { await conn.unsafe('COMMIT'); } finally { conn.release(); }
    },
  };
}

function revocationJob(tenantId, membershipId, userId) {
  return {
    id: randomUUID(),
    tenantId,
    aggregateId: membershipId,
    eventType: MEMBERSHIP_REVOCATION_EVENT_TYPE,
    attempts: 1,
    payload: {
      type: MEMBERSHIP_REVOCATION_EVENT_TYPE,
      version: 1,
      reason: 'identity_provider_user_deleted',
      user_id: userId,
      membership_id: membershipId,
      webhook_event_id: randomUUID(),
    },
  };
}

/** Runs the REAL S1-03 revocation handler as the worker runtime, tenant-bound exactly like the worker. */
async function runRevocation(job) {
  const outcomes = [];
  const handler = createMembershipRevocationHandler({ onOutcome: (outcome) => outcomes.push(outcome.outcome) });
  await runtimeTx(h.workerPool, { tenant_id: job.tenantId }, (tx) => handler(job, tx), { commit: true });
  return outcomes;
}

const settle = (promise) => promise.then((value) => value, (error) => error);

module.exports = {
  ...h,
  BIG_LIMIT,
  REQUEST_ID_HEADER,
  RecordingSender,
  webhookSecret,
  buildAuditApp,
  workerOptions,
  drain,
  call,
  onboard,
  invite,
  revokeInvite,
  accept,
  assignRole,
  removeRole,
  suspend,
  revoke,
  webhook,
  tenants,
  identity,
  auditsByRequest,
  auditsForEntity,
  auditsForTenant,
  allAudits,
  auditCount,
  auditsMentioning,
  CATALOG,
  scanAudits,
  catalogViolations,
  duplicateSuccessRows,
  runtimeTx,
  auditRow,
  injectTrigger,
  membershipStatus,
  roleCodes,
  waitForLockWaiters,
  holdTenantLock,
  revocationJob,
  runRevocation,
  settle,
  MEMBERSHIP_REVOCATION_EVENT_TYPE,
  IDENTITY_LIFECYCLE_EVENT_TYPE,
};
