'use strict';

/**
 * Shared S1-03 test harness. MUST be the first module a suite requires:
 *
 *   1. Installs a global `fetch` trap BEFORE any compiled module loads
 *      `@clerk/backend` (the SDK binds `fetch` at module load). Every network
 *      attempt is counted and fails — the suites are hermetic, and "0 calls"
 *      assertions are made against this trap.
 *   2. Per-run RSA keys (Clerk instance key + a foreign "other instance" key)
 *      and a per-run Svix signing secret: nothing is a literal secret.
 *   3. A fake Clerk Backend Users API with call counting and scripted
 *      failures (404, 429, 5xx, network, timeout, deferred).
 *   4. PostgreSQL pools: admin (fixtures/inspection only) and the two runtime
 *      roles (NOBYPASSRLS logins via tallermecario_api / tallermecario_worker).
 */

const network = { calls: 0 };
globalThis.fetch = async () => {
  network.calls += 1;
  throw new Error('NETWORK_FORBIDDEN_IN_HERMETIC_TESTS');
};

const assert = require('node:assert/strict');
const { createHash, createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID } = require('node:crypto');
const { join } = require('node:path');
const postgres = require('postgres');

const root = process.env.TEST_MODULE_ROOT;
const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
if (!root || !adminUrl) throw new Error('TEST_MODULE_ROOT and TEST_DATABASE_URL_ADMIN are required');
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(adminUrl).hostname)) {
  throw new Error('Refusing to run identity tests against a non-local host');
}
for (const name of Object.keys(process.env)) {
  if (/CLERK/iu.test(name)) throw new Error('Hermetic identity tests must not see real Clerk variables');
}

const load = (relative) => require(join(root, relative));

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                 */
/* -------------------------------------------------------------------------- */

const admin = postgres(adminUrl, { max: 4, onnotice: () => {} });

function runtimePool(kind, max = 6) {
  const login = kind === 'api' ? process.env.TEST_API_LOGIN : process.env.TEST_WORKER_LOGIN;
  const password = kind === 'api' ? process.env.TEST_API_PASSWORD : process.env.TEST_WORKER_PASSWORD;
  if (!login || !password) throw new Error('runtime logins are required');
  const url = new URL(adminUrl);
  url.username = login;
  url.password = password;
  return postgres(url.toString(), {
    max,
    onnotice: () => {},
    connection: { role: kind === 'api' ? 'tallermecario_api' : 'tallermecario_worker' },
  });
}

/* -------------------------------------------------------------------------- */
/* Clerk session JWTs (RS256, per-run keys)                                   */
/* -------------------------------------------------------------------------- */

function rsaKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

const clerkKeys = rsaKeys();
const foreignKeys = rsaKeys();
const FRONTEND_API_HOST = 'tallermecario-test.clerk.accounts.dev';
const ISSUER = `https://${FRONTEND_API_HOST}`;
const FOREIGN_ISSUER = 'https://other-instance.clerk.accounts.dev';
const PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString('base64')}`;
const AUTHORIZED_PARTY = 'http://localhost:5173';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt({ privateKey = clerkKeys.privateKey, header = {}, claims }) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'ins_test_kid', ...header });
  const body = b64url(claims);
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function sessionClaims(sub, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub,
    iss: ISSUER,
    azp: AUTHORIZED_PARTY,
    sid: `sess_${randomUUID().replaceAll('-', '')}`,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 120,
    v: 2,
    ...overrides,
  };
}

function sessionToken(sub, overrides = {}, options = {}) {
  return signJwt({ ...options, claims: sessionClaims(sub, overrides) });
}

function clerkAuthenticationConfig(overrides = {}) {
  return {
    secretKey: 'sk_test_hermetic',
    publishableKey: PUBLISHABLE_KEY,
    jwtKey: clerkKeys.publicPem,
    authorizedParties: [AUTHORIZED_PARTY],
    issuer: ISSUER,
    backendApiTimeoutMs: 200,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Fake Clerk Backend Users API                                               */
/* -------------------------------------------------------------------------- */

const newSubject = (label = 'u') => `user_${label.replace(/[^A-Za-z0-9]/g, '')}${randomUUID().replaceAll('-', '')}`;

function clerkUser(id, options = {}) {
  const primaryId = `idn_${randomUUID().replaceAll('-', '')}`;
  const emails = [];
  if (options.decoyFirst) {
    emails.push({ id: `idn_decoy${randomUUID().slice(0, 8)}`, emailAddress: options.decoyFirst, verification: { status: 'verified' } });
  }
  if (options.email !== null) {
    emails.push({
      id: primaryId,
      emailAddress: options.email ?? `${id.toLowerCase()}@example.test`,
      verification: { status: options.verified === false ? 'unverified' : 'verified' },
    });
  }
  return {
    id,
    primaryEmailAddressId: options.email === null ? null : primaryId,
    emailAddresses: emails,
    firstName: options.firstName === undefined ? 'Ana' : options.firstName,
    lastName: options.lastName === undefined ? 'Gómez' : options.lastName,
    banned: options.banned === true,
    locked: options.locked === true,
    // Fields a real SDK User carries that must never be consumed:
    publicMetadata: { tenantId: randomUUID(), role: 'owner', permissions: ['*'] },
    privateMetadata: { roles: ['admin'] },
    unsafeMetadata: { membershipId: randomUUID() },
    phoneNumbers: [{ phoneNumber: '+573001234567' }],
    imageUrl: 'https://img.example.test/avatar.png',
    externalAccounts: options.externalAccounts ?? [],
    organizationMemberships: [{ role: 'org:admin' }],
  };
}

class FakeClerkUsers {
  constructor() {
    this.users = new Map();
    this.scripts = new Map();
    this.calls = [];
  }

  put(user) {
    this.users.set(user.id, user);
    return user;
  }

  /** One-shot scripted behavior for the next getUser(id). */
  script(id, behavior) {
    const queue = this.scripts.get(id) ?? [];
    queue.push(behavior);
    this.scripts.set(id, queue);
  }

  async getUser(id) {
    this.calls.push(id);
    const queue = this.scripts.get(id);
    if (queue && queue.length > 0) return queue.shift()();
    const user = this.users.get(id);
    if (!user) throw httpError(404);
    return user;
  }
}

function httpError(status) {
  return Object.assign(new Error(`Clerk API ${status}`), { status, clerkError: true });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* -------------------------------------------------------------------------- */
/* Svix / Standard Webhooks signing (independent of the SDK under test)       */
/* -------------------------------------------------------------------------- */

function newWebhookSecret() {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function svixSignature(secret, id, timestamp, body) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function signedDelivery(secret, body, options = {}) {
  const id = options.id ?? `msg_${randomUUID().replaceAll('-', '')}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    id,
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': svixSignature(options.signWith ?? secret, id, timestamp, body),
    },
  };
}

/** A realistic Clerk user.* envelope carrying PII that must never be stored. */
function clerkEventBody(type, subject, timestampMs, options = {}) {
  const data = type === 'user.deleted'
    ? { id: subject, object: 'user', deleted: true }
    : {
      id: subject,
      object: 'user',
      email_addresses: [{ id: 'idn_1', email_address: options.email ?? 'payload-pii@example.test', verification: { status: 'verified' } }],
      primary_email_address_id: 'idn_1',
      first_name: 'Payload',
      last_name: 'Person',
      phone_numbers: [{ phone_number: '+573009998877' }],
      image_url: 'https://img.example.test/p.png',
      public_metadata: { role: 'owner', tenantId: randomUUID() },
      private_metadata: { permissions: ['*'] },
      unsafe_metadata: { admin: true },
      external_accounts: [{ provider: 'oauth_google', email_address: 'g@example.test' }],
      banned: options.banned ?? false,
      locked: options.locked ?? false,
    };
  return JSON.stringify({
    data,
    event_attributes: { http_request: { client_ip: '203.0.113.9', user_agent: 'pii-agent' } },
    instance_id: 'ins_test',
    object: 'event',
    timestamp: timestampMs,
    type,
  });
}

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/* -------------------------------------------------------------------------- */
/* Fixtures (admin connection; triggers off inside the seeding transaction)   */
/* -------------------------------------------------------------------------- */

let roleIds;
async function roleId(code) {
  if (!roleIds) roleIds = Object.fromEntries((await admin`SELECT id, code FROM public.roles`).map((row) => [row.code, row.id]));
  return roleIds[code];
}

async function createUser({ subject = newSubject(), status = 'active', email } = {}) {
  const id = randomUUID();
  await admin`INSERT INTO public.users ${admin({
    id, identity_provider: 'clerk', external_subject: subject,
    email: email ?? `${id}@fixture.test`, status,
  })}`;
  return { id, subject };
}

/** A workshop with the given members: [{ user, roles: [...], status }]. */
async function createWorkshop(members) {
  const tenantId = randomUUID();
  const memberships = [];
  const roleMap = {};
  for (const code of ['owner', 'admin', 'service_advisor', 'technician']) roleMap[code] = await roleId(code);
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO public.workshops ${tx({ id: tenantId, slug: `id-${tenantId}`, legal_name: 'Legal', display_name: 'Taller' })}`;
    for (const member of members) {
      const membershipId = randomUUID();
      const status = member.status ?? 'active';
      await tx`INSERT INTO public.memberships ${tx({
        id: membershipId, tenant_id: tenantId, user_id: member.user.id, status,
        suspended_at: status === 'suspended' ? new Date() : null,
        revoked_at: status === 'revoked' ? new Date() : null,
      })}`;
      for (const role of member.roles ?? []) {
        await tx`INSERT INTO public.membership_roles ${tx({
          tenant_id: tenantId, membership_id: membershipId, role_id: roleMap[role], assigned_by_membership_id: membershipId,
        })}`;
      }
      memberships.push(membershipId);
    }
  });
  return { tenantId, memberships };
}

/* -------------------------------------------------------------------------- */
/* Worker                                                                     */
/* -------------------------------------------------------------------------- */

/** Claims and processes until nothing claimable is left; returns every result. */
async function drainOutbox(workerModule, options, maxRounds = 20) {
  const results = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const jobs = await workerModule.claimBatch(options.database, 20);
    if (jobs.length === 0) return results;
    for (const job of jobs) results.push(await workerModule.processClaimedJob(options, job));
  }
  throw new Error('OUTBOX_DID_NOT_DRAIN');
}

module.exports = {
  assert,
  admin,
  runtimePool,
  load,
  network,
  clerkKeys,
  foreignKeys,
  ISSUER,
  FOREIGN_ISSUER,
  PUBLISHABLE_KEY,
  AUTHORIZED_PARTY,
  signJwt,
  sessionClaims,
  sessionToken,
  clerkAuthenticationConfig,
  newSubject,
  clerkUser,
  FakeClerkUsers,
  httpError,
  deferred,
  newWebhookSecret,
  svixSignature,
  signedDelivery,
  clerkEventBody,
  sha256Hex,
  roleId,
  createUser,
  createWorkshop,
  drainOutbox,
};
