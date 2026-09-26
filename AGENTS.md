\# TallerMecario Backend - AI Agent Instructions



You are an expert backend AI assistant working on the TallerMecario API.



\## Source of Truth \& Documentation

Product requirements, architecture decisions, ERD, RBAC, and state machines are maintained in Notion.

\*\*CRITICAL:\*\* You cannot browse Notion. If you need architectural or business logic context that is not in this codebase, \*\*STOP and ask the user\*\* to provide the relevant Notion documentation before making assumptions. Do not invent undocumented business requirements.



\## Technology Stack

\- TypeScript

\- Node.js

\- Fastify

\- Drizzle ORM

\- PostgreSQL



\## Architecture Principles

\- \*\*Multi-tenant isolation:\*\* This is mandatory. Always ensure tenant boundaries in queries.

\- \*\*Authorization:\*\* Must always be enforced server-side.

\- \*\*Database integrity:\*\* Enforce in PostgreSQL (prefer explicit constraints over application-only validation).

\- \*\*Schema changes:\*\* Require migrations. Do not modify `schema.ts` (or equivalent DB files) merely to make application code easier. The model must represent the domain correctly.

\- \*\*State \& Concurrency:\*\* Consider concurrency for mutable resources and idempotency for repeatable operations.

\- \*\*Auditing:\*\* All important mutations must be auditable.



\## Database Rules (Drizzle \& Postgres)

Before modifying the database schema:

1\. Understand the business invariant.

2\. Determine tenant ownership.

3\. Define primary keys, foreign keys, unique, and CHECK constraints.

4\. Define indexes and deletion behavior (e.g., cascading).

5\. Evaluate migration impact.



\## Definition of Done (Quality Gates)

Before considering an implementation complete, you MUST autonomously run the following checks if applicable:

1\. \*\*Types:\*\* Run `npm run build` (or your typecheck script) -> TypeScript must compile.

2\. \*\*Linting:\*\* Run `npm run lint` -> Lint must pass.

3\. \*\*Tests:\*\* Run `npm test` -> Tests must pass.

4\. \*\*Review:\*\* Double-check tenant isolation and database constraints in your written code.



\## Git worktrees and temporary artifacts



The repository tree must contain only project source and canonical project artifacts.



Never create Git worktrees, audit checkouts, nested repositories, mutation copies,

or agent temporary directories inside the repository root.



Repository root:



C:\\Users\\leopa\\OneDrive\\Documentos\\Proyectos\\TallerMecarioB



Git worktrees must be created outside the repository under:



C:\\Users\\leopa\\.tallermecario-worktrees\\<task-name>



Disposable audit artifacts must use:



C:\\Users\\leopa\\.tallermecario-audits\\<task-name>



or the operating-system temporary directory.



Before creating a worktree:

\- run `git worktree list`;

\- reuse an appropriate existing clean worktree when possible.



After a task is integrated:

\- remove disposable worktrees with `git worktree remove`;

\- run `git worktree prune`;

\- remove disposable audit artifacts;

\- never remove a worktree containing uncommitted work.



Do not create permanent repository copies or worktree directories per Sprint

unless explicitly requested.

