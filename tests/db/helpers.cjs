'use strict';

// Test-only helpers. Connects to a LOCAL/CI throwaway PostgreSQL only.
//   TEST_DATABASE_URL_ADMIN = admin URL of the temporary database
//   TEST_RUNTIME_LOGIN      = throwaway, non-superuser login created by the harness
//   TEST_RUNTIME_PASSWORD   = password for that throwaway login
// The login is a NOINHERIT member of the canonical runtime role. PostgreSQL sets
// ROLE at connection startup, so every assertion runs with current_user equal to
// tallermecario_api without changing a persistent runtime-role password.
const { randomUUID } = require('node:crypto');
const postgres = require('postgres');

const adminUrl = process.env.TEST_DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('TEST_DATABASE_URL_ADMIN is required (throwaway local/CI database)');
const runtimeLogin = process.env.TEST_RUNTIME_LOGIN;
const runtimePassword = process.env.TEST_RUNTIME_PASSWORD;
if (!runtimeLogin || !runtimePassword) {
  throw new Error('TEST_RUNTIME_LOGIN and TEST_RUNTIME_PASSWORD are required');
}
const parsed = new URL(adminUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('Refusing to run DB tests against a non-local host');
}
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} });

function runtime(role) {
  if (!['tallermecario_api', 'tallermecario_worker'].includes(role)) {
    throw new Error('Unsupported runtime role');
  }
  const runtimeUrl = new URL(adminUrl);
  runtimeUrl.username = runtimeLogin;
  runtimeUrl.password = runtimePassword;
  return postgres(runtimeUrl.toString(), {
    max: 4,
    onnotice: () => {},
    connection: { role },
  });
}

async function setupRoles() {
  const roles = await admin`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('tallermecario_api', 'tallermecario_worker')
  `;
  if (roles.length !== 2 || roles.some((role) => role.rolsuper || role.rolbypassrls)) {
    throw new Error('Canonical runtime roles must exist with NOSUPERUSER NOBYPASSRLS');
  }
}

const id = () => randomUUID();

// Explicit BEGIN / COMMIT on a reserved connection so a test can tell which
// statement (or the COMMIT itself) raised.
async function begin(sql, tenantId) {
  const conn = await sql.reserve();
  await conn.unsafe('BEGIN');
  if (tenantId) await conn`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  return conn;
}
async function commit(conn) {
  try { await conn.unsafe('COMMIT'); } finally { conn.release(); }
}
async function rollback(conn) {
  try { await conn.unsafe('ROLLBACK'); } catch { /* already ended */ } finally { conn.release(); }
}
// Runs fn in a tenant-scoped transaction and commits.
async function inTx(sql, tenantId, fn) {
  const conn = await begin(sql, tenantId);
  try { await fn(conn); } catch (e) { await rollback(conn); throw e; }
  await commit(conn);
}

// Fixture inserts run as superuser with FK/trigger machinery off so parent rows can be
// built without the whole upstream chain. Rows UNDER TEST are always written through the
// runtime roles with every constraint and trigger enabled.
async function fixture(fn) {
  await admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await fn(tx);
  });
}

async function makeTenant({ members = 2, withOrder = false } = {}) {
  const t = { tenant: id(), location: id(), members: [] };
  await fixture(async (tx) => {
    await tx`INSERT INTO workshops ${tx({ id: t.tenant, slug: `w-${t.tenant}`, legal_name: 'T', display_name: 'T' })}`;
    await tx`INSERT INTO workshop_locations ${tx({ id: t.location, tenant_id: t.tenant, name: 'HQ', address_line: 'x', city: 'Bogota', department: 'Bogota', is_primary: true })}`;
    for (let i = 0; i < members; i++) {
      const user = id();
      const m = id();
      await tx`INSERT INTO users ${tx({ id: user, external_subject: `sub-${user}`, email: `${user}@t.test` })}`;
      await tx`INSERT INTO memberships ${tx({ id: m, tenant_id: t.tenant, user_id: user })}`;
      t.members.push(m);
    }
    t.customer = id();
    await tx`INSERT INTO customers ${tx({ id: t.customer, tenant_id: t.tenant, first_name: 'A', last_name: 'B', phone: '3000000000' })}`;
    if (withOrder) {
      t.vehicle = id();
      t.reception = id();
      t.order = id();
      await tx`INSERT INTO vehicles ${tx({ id: t.vehicle, tenant_id: t.tenant, plate: `P${t.vehicle.slice(0, 6).toUpperCase()}`, vehicle_type: 'car', brand: 'b', model: 'm' })}`;
      await tx`INSERT INTO receptions ${tx({ id: t.reception, tenant_id: t.tenant, vehicle_id: t.vehicle, customer_id: t.customer, received_by_membership_id: t.members[0], mileage_km: 1 })}`;
      await tx`INSERT INTO service_orders ${tx({ id: t.order, tenant_id: t.tenant, reception_id: t.reception, vehicle_id: t.vehicle, customer_id: t.customer, order_number: 1, created_by_membership_id: t.members[0] })}`;
    }
  });
  return t;
}

module.exports = { admin, runtime, setupRoles, id, begin, commit, rollback, inTx, fixture, makeTenant };
