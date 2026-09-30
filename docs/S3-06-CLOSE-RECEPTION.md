# S3-06 — Close Reception + Exactly-One Service Order

## API contract

`POST /api/v1/receptions/:receptionId/close` is a bodyless command. An absent
body needs no Content-Type. A nonempty body returns 400
`REQUEST_VALIDATION_FAILED`. The tenant and actor come from the authenticated
TenantContext; the client supplies only the reception ID. Authorization uses
`receptions.close`: owner, admin, and service advisor have a tenant grant;
technician is denied. An absent or foreign reception returns the same 404
`RECEPTION_NOT_FOUND`.

The first successful call returns 200 with a closed reception and its newly
created service order. The response contains only IDs, status, timestamps,
version, and the tenant-local `orderNumber` as a decimal string. It does not
serialize a JavaScript BigInt. The order starts at `reception`, version 1,
priority `normal`, with no promised or closed timestamp. The server chooses
all IDs, timestamps, and the actor membership.

## Transaction and locks

The tenant request lifecycle binds one PostgreSQL transaction and RLS context
before the route runs. The command locks the tenant-scoped reception
`FOR NO KEY UPDATE`. A closed reception loads its existing order and returns
its persisted values without any writes, vehicle lock, number lock, or second
audit. If the order is missing or has mismatched lineage, the command returns
a sanitized internal error and does not attempt repair.

For an open reception the sequence is:

1. Confirm that a signature row exists. Its media may now be quarantined;
   close makes no R2 call and does not revalidate media, privacy consent, or
   current primary ownership.
2. Lock the tenant-scoped vehicle `FOR NO KEY UPDATE` and compare its current
   mileage with the reception mileage. A lower reception mileage returns 409
   `RECEPTION_MILEAGE_CONFLICT`; a missing signature returns 409
   `RECEPTION_SIGNATURE_REQUIRED` before the vehicle lock.
3. Acquire a transaction-level advisory lock for the namespace
   `service_order_number:` plus tenant UUID. Under that lock, allocate
   `COALESCE(MAX(order_number), 0) + 1` for that tenant. Gaps are not reused;
   two tenants may each have number 1.
4. Update vehicle mileage only if changed, with monotonic `updated_at`. Set
   reception status to `closed`, `closed_at` to server time, and monotonic
   `updated_at`.
5. Insert the service order, one `NULL → reception` status history row carrying
   the request ID, and one `reception.closed` success audit. Audit metadata
   contains only the order ID and number. Commit all changes together.

The lock graph is **reception → vehicle → advisory number lock**. Existing
PATCH and signature commands also lock reception first. CREATE locks vehicle
first and its open-reception unique check resolves the same-vehicle race.
An audit, history, or deferred commit failure rolls back the reception, vehicle,
order, history, and success audit together. A retry never changes timestamps,
mileage, history, order number, or audit count.

## Database authority

No S3-06 migration is needed. Published migration 0019 already enforces the
open-to-closed lifecycle, signature prerequisite, order lineage and initial
state, one order per reception, tenant-local order number uniqueness, deferred
closed-reception/order and order/initial-history requirements, unique initial
history, and append-only history. Composite tenant foreign keys and FORCE RLS
remain in place. Migrations 0020–0022 preserve the historical consent and
signed-media behavior needed here. No published migration or snapshot changed.

## Verification and scope

`tests/reception-api/close.test.cjs` uses a real PostgreSQL runtime login to
check success, idempotency, authorization, tenant isolation, signature, stale
mileage, media quarantine, consent revocation, allocation, rollback, and
observable lock overlap for close/close, close/signature, close/PATCH, and
close/CREATE. The existing direct DB suite covers the 0019 constraints. The
close mutation runner injects ten defects into compiled code and requires the
normal tests to detect each one. This feature ends with the order in
`reception`; order queries, transitions, diagnosis, and later lifecycle work
are outside S3-06.
