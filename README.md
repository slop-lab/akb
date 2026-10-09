# Agent-First Workspace

This repository is the greenfield home for a planned self-hostable collaboration,
knowledge, and small-project management system designed for people and software agents
working in the same typed, revisioned graph.

## Current Status

The product is **not complete**. R1 and R2 remain in progress through a deliberately bounded Work
Item HTTP slice, and the first PostgreSQL persistence work leaves R3 in progress. The repository
currently contains:

- the canonical English v1 design specification;
- a strict TypeScript Node.js server at [`src/server.ts`](src/server.ts), launched by [`app/server.mjs`](app/server.mjs);
- Zod-validated Work Item create, read, patch, and workspace-list routes;
- an in-memory adapter behind the application-owned `WorkItemStore`, with optimistic revisions,
  command idempotency, immutable revision history, append-only semantic events, hard defaults of
  10,000 current Work Items and 100,000 audit records, and a separate 100-item list limit;
- an authenticated PostgreSQL adapter with checksum-verified migrations, durable Work Item records,
  Workspace/Principal/Membership identity, explicit Work permissions, and real-database tests;
- an administrator CLI for identity provisioning, permission replacement, one-time bearer-token
  issuance, and credential-ID revocation;
- transactional Work Item event outbox fanout, an ordered interruption-safe database-inbox worker,
  and authenticated bounded workspace event replay;
- a bounded PostgreSQL Space scope with public inheritance, explicit private Work grants, ACL-filtered
  Work Item reads/lists/counts, and fail-closed complete-authority workspace event replay;
- a 64 KiB JSON request limit and abort-safe HTTP request handling;
- an OpenAPI 3.1 contract at [`docs/openapi.json`](docs/openapi.json); and
- preserved Dev Infra Manager (DIM) environment infrastructure under [`.dim/`](.dim/).

The server preserves `GET /health` and exposes the current R2 routes:

- `POST /api/workspaces/:workspaceId/work-items`;
- `GET /api/work-items/:id`;
- `PATCH /api/work-items/:id`; and
- `GET /api/workspaces/:workspaceId/work-items`.
- `GET /api/workspaces/:workspaceId/events?after=N&limit=N` on the authenticated PostgreSQL server.

Each effective create or patch consumes one immutable revision/event record pair. History is never
evicted to admit another command. When an applicable item or audit-record budget is exhausted, the
adapter rejects the command before changing current state, history, events, idempotency records, the
clock, or generated IDs. HTTP reports `507 budget_exceeded` with the truthful `resource` (`items` or
`audit_records`) and configured `capacity`. The current in-memory adapter performs each command
all-or-nothing. The PostgreSQL adapter transactionally persists current state, revision, semantic
event, idempotency, the bounded immutable outbox projection, and active destination jobs. Full R3
semantics remain future work.

Exact OpenAPI constraints are structurally tied to the shared Zod schemas, and stable documented
HTTP statuses are behaviorally contract-tested. This contract covers only the current HTTP surface;
agent retrieval remains future work.

This is not the full planned API or first canonical vertical slice. The default in-memory entrypoint
still loses data on restart; the opt-in PostgreSQL entrypoint preserves the tested Work Item slice.
The broader entity/object ACL architecture, UI, network outbox delivery, full R6
snapshot/receipt retrieval, runtime execution, proposal/review, public Project and Space administration APIs,
search, human board/list views, comments, and all other v1 completeness behavior remain
unimplemented. The R2 list envelope therefore reports only bounded current-state cards,
completeness, omissions, a null cursor, and an estimate; it does not invent snapshot or receipt
identifiers. R1, R2, and R3 remain in progress; no behavioral phase gate is complete.

## Documentation

- [`agent-first-workspace-v1-design.md`](agent-first-workspace-v1-design.md) is the canonical
  product and engineering design baseline. It defines planned contracts, invariants, scope,
  phase gates, Definition of Done, backlog, risks, and the first vertical slice. Statements in
  that document describe requirements and decisions, not completed functionality.
- [`docs/product-and-domain.md`](docs/product-and-domain.md) summarizes the intended product and
  domain boundaries.
- [`docs/roadmap.md`](docs/roadmap.md) defines dependency-ordered delivery phases and exit gates.
- [`docs/implementation-status.md`](docs/implementation-status.md) maps every canonical design
  section to its current evidence-based delivery status.
- [`docs/architecture.md`](docs/architecture.md),
  [`docs/agent-protocol.md`](docs/agent-protocol.md), and
  [`docs/security-and-quality.md`](docs/security-and-quality.md) define the engineering contracts
  that future implementation must satisfy.
- [`docs/adr/README.md`](docs/adr/README.md) registers accepted and proposed architecture decisions.
- This README describes only the repository as it exists now and is the source of truth for its
  current implementation status.

## Entrypoints and Environment

The current application entrypoint is:

```sh
node app/server.mjs
```

It is an unauthenticated historical demo listening on `127.0.0.1:3000`. DIM starts that command through
[`.dim/agent/start.sh`](.dim/agent/start.sh). The DIM Compose environment mounts this repository
at `/workspace`, runs the agent container as the workspace owner, and provides a private Docker
sidecar; see [`.dim/docker-compose.yml`](.dim/docker-compose.yml).

The [public DIM upstream mirror](https://github.com/slop-lab/dev-infra-manager) documents the
external infrastructure manager and its environment model. In this repository, `.dim/` is the
only DIM-specific project infrastructure. It is intentionally preserved and is not application
source, a product module, or evidence that the planned system has been implemented. The application
entrypoint may evolve with the architecture without treating `.dim/` as code to migrate or
redesign.

The PostgreSQL application requires bearer authentication for every `/api` request and leaves only
`GET /health` public. It requires a migrated database and defaults to `127.0.0.1:3000`:

```sh
DATABASE_URL=postgres://user:password@host:5432/database npm run migrate:postgres
DATABASE_URL=postgres://user:password@host:5432/database npm run start:postgres
```

Startup checks that the migrated Work Item table is reachable and never falls back to memory.
Provision the first workspace and short-lived token through the administrator CLI. The token is
printed once and only its SHA-256 digest is persisted:

```sh
DATABASE_URL=postgres://user:password@host:5432/database npm run admin -- bootstrap-workspace \
  --workspace-id example --workspace-name "Example" --principal-id admin \
  --principal-name "Example Admin"
DATABASE_URL=postgres://user:password@host:5432/database npm run admin -- issue-token \
  --workspace-id example --principal-id admin
DATABASE_URL=postgres://user:password@host:5432/database npm run admin -- revoke-token \
  --credential-id 00000000-0000-0000-0000-000000000000
DATABASE_URL=postgres://user:password@host:5432/database npm run admin -- create-space \
  --workspace-id example --space-id private --space-name "Private" --visibility private
DATABASE_URL=postgres://user:password@host:5432/database npm run admin -- set-space-permissions \
  --workspace-id example --space-id private --principal-id admin \
  --permissions work.read,work.create,work.update,work.assign
```

Register and run the only current outbox sink with the bounded worker:

```sh
DATABASE_URL=postgres://user:password@host:5432/database npm run outbox -- register \
  --workspace-id example --destination-id local-inbox --sink database-inbox
DATABASE_URL=postgres://user:password@host:5432/database npm run outbox -- run \
  --workspace-id example --destination-id local-inbox --sink database-inbox --drain
```

Registration starts after the current maximum event sequence and does not backfill history.
Delivery is ordered and at-least-once with durable inbox deduplication; it is not exactly-once. A
dead-lettered head blocks later events until `retry-dead` is given its job ID. One `--drain` run
claims at most 100 jobs, leaving additional work for a later run. Every `run` prints a JSON summary;
the process exits nonzero when any claimed delivery failed or was not acknowledged.

Pass optional `spaceId` on PostgreSQL creates to select an immutable owning Space. Public Spaces
inherit Workspace grants; private Spaces additionally require matching explicit Space grants.
Owner/admin roles do not bypass this rule. Existing unscoped records omit `spaceId`, and the
in-memory HTTP demo rejects scoped creates. Workspace event replay requires read authority for
every private Space and otherwise returns `403` without a page or checkpoint.

`actorId` remains required for compatibility but is deprecated and must equal the authenticated
Principal. Runtime Principals cannot receive general workspace bearer credentials.

## Development Commands

Use Node 24 and npm:

```sh
npm ci
npm run check
npm run build
npm run test:unit
npm run test:integration
npm run test:postgres # requires DATABASE_URL and never skips
npm start
```

`npm run check` remains the deterministic default in-memory gate. Real PostgreSQL behavior is a
separate required persistence gate because it needs an external database fixture; CI execution is
still deferred rather than reported as passing.
