# Agent-First Workspace

This repository is the greenfield home for a planned self-hostable collaboration,
knowledge, and small-project management system designed for people and software agents
working in the same typed, revisioned graph.

## Current Status

The product is **not complete**. R1 and R2 are in progress through a deliberately bounded,
in-memory Work Item HTTP slice. The repository currently contains:

- the canonical English v1 design specification;
- a strict TypeScript Node.js server at [`src/server.ts`](src/server.ts), launched by [`app/server.mjs`](app/server.mjs);
- Zod-validated Work Item create, read, patch, and workspace-list routes;
- an in-memory adapter behind the application-owned `WorkItemStore`, with optimistic revisions,
  command idempotency, immutable revision history, append-only semantic events, hard defaults of
  10,000 current Work Items and 100,000 audit records, and a separate 100-item list limit;
- a 64 KiB JSON request limit and abort-safe HTTP request handling;
- an OpenAPI 3.1 contract at [`docs/openapi.json`](docs/openapi.json); and
- preserved Dev Infra Manager (DIM) environment infrastructure under [`.dim/`](.dim/).

The server preserves `GET /health` and exposes the current R2 routes:

- `POST /api/workspaces/:workspaceId/work-items`;
- `GET /api/work-items/:id`;
- `PATCH /api/work-items/:id`; and
- `GET /api/workspaces/:workspaceId/work-items`.

Each effective create or patch consumes one immutable revision/event record pair. History is never
evicted to admit another command. When an applicable item or audit-record budget is exhausted, the
adapter rejects the command before changing current state, history, events, idempotency records, the
clock, or generated IDs. HTTP reports `507 budget_exceeded` with the truthful `resource` (`items` or
`audit_records`) and configured `capacity`. The current in-memory adapter performs each command
all-or-nothing, but durable repository, unit-of-work, database transaction, and outbox semantics
remain R3 work.

Exact OpenAPI constraints are structurally tied to the shared Zod schemas, and stable documented
HTTP statuses are behaviorally contract-tested. This contract covers only the current HTTP surface;
agent retrieval remains future work.

This is not the full planned API or first canonical vertical slice. Data is process-local and lost
on restart. PostgreSQL, authentication, ACL enforcement, UI, worker/outbox delivery, full R6
snapshot/receipt retrieval, runtime execution, proposal/review, Project and Space administration,
search, human board/list views, comments, and all other v1 completeness behavior remain
unimplemented. The R2 list envelope therefore reports only bounded current-process cards,
completeness, omissions, a null cursor, and an estimate; it does not invent snapshot or receipt
identifiers. R1 and R2 remain in progress; no behavioral phase gate is complete.

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

It listens on `0.0.0.0:3000`. DIM starts that command through
[`.dim/agent/start.sh`](.dim/agent/start.sh). The DIM Compose environment mounts this repository
at `/workspace`, runs the agent container as the workspace owner, and provides a private Docker
sidecar; see [`.dim/docker-compose.yml`](.dim/docker-compose.yml).

The [public DIM upstream mirror](https://github.com/slop-lab/dev-infra-manager) documents the
external infrastructure manager and its environment model. In this repository, `.dim/` is the
only DIM-specific project infrastructure. It is intentionally preserved and is not application
source, a product module, or evidence that the planned system has been implemented. The application
entrypoint may evolve with the architecture without treating `.dim/` as code to migrate or
redesign.

## Development Commands

Use Node 24 and npm:

```sh
npm ci
npm run check
npm run build
npm run test:unit
npm run test:integration
npm start
```
