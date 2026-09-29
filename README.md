# TallerMecarioB

## Runtime database connection

API and worker receive the **same** `DATABASE_URL`, authenticated as the
`tallermecario_runtime` login (`LOGIN`, `NOINHERIT`, `NOBYPASSRLS`). The login
has no direct privileges on business tables. It can `SET ROLE` to
`tallermecario_api` and `tallermecario_worker` with membership
`INHERIT FALSE, SET TRUE`.

The API and worker run in separate PostgreSQL pools. Postgres.js sends their
fixed `role` at connection startup, before pre-transaction bootstrap reads or
worker autocommit statements. Thus each API connection has
`session_user=tallermecario_runtime` and `current_user=tallermecario_api`, and
each worker connection has `session_user=tallermecario_runtime` and
`current_user=tallermecario_worker`; connections never move between the two
pools. Tenant context remains scoped
to each request/job transaction. A failed role selection rejects the connection.

This gives effective separation during normal execution through `NOINHERIT`,
the absence of direct grants to the login, and RLS and permissions of the
effective `current_user`. A single shared credential does **not** isolate API
credentials from worker credentials. Anyone able to execute arbitrary SQL as
`tallermecario_runtime` has membership sufficient to attempt `SET ROLE` to
either authorized runtime role. This design does not protect against compromise
of the shared credential.

The staging drill provisions the login with a per-run password using
`scripts/provision-staging-runtime-login.cjs`. Other environments must provision
the same role hierarchy and supply one shared runtime URL from their secret
store. Migration tooling keeps its separate privileged database credentials;
never use the runtime login for migrations or the migrator login for API/worker.
