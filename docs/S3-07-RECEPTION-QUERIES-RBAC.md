# S3-07 — Reception Queries + RBAC

## Endpoints and authorization

`GET /api/v1/receptions` requires a tenant grant for `receptions.read`. Owner,
admin, and service advisor can list within their tenant. A technician receives
403 even with an active assignment. The list does not support an assigned view.

`GET /api/v1/receptions/:receptionId` uses `permissionScope: resource` for
`receptions.read`. A tenant grant reads that tenant's reception. An assigned
grant requires an active `lead_technician` or `support_technician` assignment for
the caller's membership on the service order linked to this reception. All
links carry the same tenant ID, and the SQL predicates explicitly bind the
authenticated tenant. A `quality_control` assignment does not qualify.

The effective grant determines the response: a membership with technician and
service advisor roles has the tenant grant and receives the staff DTO. The
handler marks `resourceAuthorization` satisfied via `assigned` only after the
PostgreSQL `EXISTS` predicate proves the assignment. The request lifecycle
rejects a successful restricted response without that mark.

For a restricted caller, malformed, nonexistent, foreign, unassigned,
released, QC-only, and wrong-order reception IDs all return 404
`RECEPTION_NOT_FOUND`. A tenant-grant caller also receives this 404 for
malformed, nonexistent, and foreign IDs. The response does not disclose whether
a hidden reception exists.

## List query and pagination

The only accepted query keys are `limit`, `cursor`, `status`, `vehicleId`, and
`customerId`; duplicates, arrays, and unknown keys return 400
`REQUEST_VALIDATION_FAILED`. Limit defaults to 25 and accepts integers 1–100.
Status accepts `open` or `closed`. Vehicle and customer filters require
canonical UUIDs. The historical schema value `cancelled` is not an S3 filter.

Rows sort by server-generated UUIDv7 reception ID descending. The opaque,
versioned base64url cursor holds the last returned ID. PostgreSQL applies
`id < cursor` and `LIMIT limit + 1`; the extra row determines `nextCursor`.
The final page returns `nextCursor: null`. A newly inserted reception between
pages does not duplicate an earlier item. Pagination does not promise a global
snapshot across requests.

## Exact response fields

The list response is `{ receptions, nextCursor }`. Each summary has:

`receptionId`, `vehicleId`, `customerId`, `mileageKm`, `fuelLevelPct`,
`status`, `receivedAt`, `closedAt`, `updatedAt`.

The detail response is `{ reception }`. A tenant-grant staff reception has:

`receptionId`, `vehicleId`, `customerId`, `appointmentId`, `locationId`,
`receivedByMembershipId`, `mileageKm`, `fuelLevelPct`, `customerNotes`,
`advisorNotes`, `status`, `receivedAt`, `closedAt`, `createdAt`, `updatedAt`,
`checklist`, `damages`.

An assigned-grant reception has only:

`receptionId`, `vehicleId`, `mileageKm`, `fuelLevelPct`, `status`,
`receivedAt`, `closedAt`, `checklist`, `damages`.

Each checklist entry has `checkItemId`, `code`, `label`, `status`, `notes`,
`createdAt`, ordered by code then ID ascending. Each damage entry has
`damageId`, `zoneCode`, `damageType`, `severity`, `description`, `createdAt`,
ordered by creation time then ID ascending. Both child queries include tenant
and reception predicates.

`receptions.read` does not grant `customers.read`, `vehicles.read`,
`signatures.read`, or `orders.read`. No customer CRM fields, embedded vehicle,
privacy consent or snapshot, signature, signer, media, service order, order
number, or audit data appears in either response. The assigned DTO also omits
customer ID and notes. Existing separate permissions and endpoints remain the
authority for those resources.

## Query bound, read-only behavior, and database

List executes one parameterized reception query. Successful detail executes
one reception query with the assignment `EXISTS` when required, one checklist
query, and one damage query. An absent or unauthorized detail stops after the
reception query. No per-child query, offset, write, success audit, row write
lock, external I/O, or timestamp change is used. The tenant request transaction
sets RLS context; every tenant-owned query also has an explicit tenant filter.

Migration: **NO**. Existing tables, tenant foreign keys, FORCE RLS, assignment
scope and indexes support these reads. Migrations 0000–0022 and Drizzle
snapshots remain unchanged.

## Verification

`tests/reception-api/queries.test.cjs` exercises RBAC, effective multi-role
grants, assigned lead/support, released/QC/wrong-order exclusions, anti-oracle
404s, exact DTO keys, stable child ordering, cross-tenant isolation, filters,
strict query validation, keyset pagination including an intervening insert,
and the real request lifecycle tripwire. The S3-07 mutation runner injects
12 high-value defects into compiled output and requires each to fail the
reception API tests. The explicit tenant predicates are also checked in the
compiled SQL source because FORCE RLS independently masks their removal in
behavioral cross-tenant tests. Gate results are recorded in the handoff.

DOC_CONFLICT-01 remains INFO / pre-existing: S3 operational lifecycle is
`open → closed`. The historical `cancelled` schema value does not add an S3
cancel or reopen transition. Migration 0019 is unchanged.
