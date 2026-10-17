# Agent-First Workspace

This repository is the greenfield home for a planned self-hostable collaboration, knowledge, and
small-project management system for people and software agents working in the same typed,
revisioned graph.

## Current Status

The product is **not complete**. R1, R2, R3, and R4 are all **In progress**: substantial local
runtime behavior exists, but dependency-ordered phase gates, CI evidence, and the full canonical
exit scenarios have not passed. No canonical product section is marked `Implemented`.

Two application generations coexist intentionally:

- `npm start` runs the historical unauthenticated in-memory demo on `127.0.0.1:3000`.
- `npm run start:postgres` runs the authenticated legacy PostgreSQL Work Item surface.
- `npm run start:r4` runs the authenticated R3/R4 PostgreSQL application and same-origin web build
  on `127.0.0.1:3001` by default.

The locally delivered R3/R4 checkpoint includes:

- checksum-verified additive migrations `005` through `010` over the compatible `001`-`004`
  baseline;
- a Workspace-scoped entity/revision registry, restrictive entity ACL, 15 permission atoms, and
  authority epochs;
- an independent versioned `entity-v1` event/outbox/replay stream while the legacy
  `work-item-v1` stream remains unchanged;
- 27 strict command routes for Space/workflow/state/label administration, Projects, Work Items,
  relations, comments, Saved Views, and entity access;
- bearer-derived actors for every new command: the strict command envelope never accepts
  `actorId`;
- human bootstrap/read, Project and Work queries, board, paged lexical search, transient signed
  snapshots, explicit snapshot release, and ACL-first counts and projections;
- bounded portable NDJSON export plus validate/commit import with signed byte-bound validation
  tokens, typed reference normalization, and ACL-safe Saved View transfer;
- complete or additive workflow interchange, deterministic legacy workflow history, and frozen
  legacy Work Item PM projections without rewriting prior revisions or events;
- bounded retention inspection, structured request telemetry, and generic outbox/replay behavior;
- a React/Vite human surface that consumes server-authoritative projections; and
- immutable PostgreSQL 17 backup profiles for schemas 004, 008, 009, and 010, including registered
  upgrades from every older profile to 010 and authority/lease/transient-state quarantine.

This is local functional evidence, not a phase-completion claim. Independent acceptance at source
commit `260812d` passed 66 unit, 40 integration, 71 PostgreSQL, 15 R4 contract and 164 R4 PostgreSQL,
and 28 backup/restore tests. Web and browser TypeScript checks, the production web build, and all
11 real-Chrome scenarios also passed. All five review lanes reported no blocking findings. An earlier native Node 24 live
exercise returned `200` for archived-inclusive export and Project query, completed
export -> validate -> commit -> replay -> re-export, rejected malformed import, exercised
archive/restore queries, and released snapshots. A separate legacy SDK driver exercised a
schema-004 database upgraded through 010, detail/list/continuation reads, and unchanged history.
The named local gates passed at that reviewed source commit. CI and the complete
dependency-ordered formal exit scenarios remain open; this README does not mark any
R1-R4 phase as passing.

Later work still includes R5 planning/documents/collaboration, R6 progressive agent retrieval and
runtime control, R7 knowledge/proposals/review, and R8 release completeness. Network webhooks,
OIDC, rich documents, PITR, encrypted backup storage, scheduling, full accessibility/release proof,
and production operations are not delivered by this checkpoint.

## API Contracts

A bounded [Part-based agent runtime](docs/agent-runtime.md) is available through
`npm run agent -- help`, with read-only Workspace tools by default and ACP stdio support.
It requires Node.js 24.22.0 or newer. It is a trusted local adapter over existing R4 authority,
not completion of the planned R6 identity, persistence, or progressive-retrieval protocol.

- [`docs/openapi.json`](docs/openapi.json) is the byte-preserved legacy R2 OpenAPI contract.
- [`docs/openapi-r4.json`](docs/openapi-r4.json) is the generated R3/R4 machine inventory.
- [`script/generate-api-r4.mjs`](script/generate-api-r4.mjs) generates the R3/R4 document from
  `COMMAND_ROUTES` and the pure Zod request schemas.
- [`test/r4-route-inventory.test.ts`](test/r4-route-inventory.test.ts) checks all 27 command routes,
  17 special R3/R4 routes, strict actor-free envelopes, request-schema equality, generation
  freshness, and preservation of the legacy OpenAPI bytes.

The R3/R4 API requires bearer authentication for every `/api` request and leaves only
`GET /health` public. Command paths begin `/api/commands/v1/workspaces/:workspaceId`; human paths
begin `/api/human/v1/workspaces/:workspaceId`; generic replay is
`GET /api/events/v1/workspaces/:workspaceId/events`. Exact route and payload details are in the
[R4 API reference](docs/r4-api-reference.md) and
[Human Query reference](docs/r4-query-reference.md).

## Documentation

- [`agent-first-workspace-v1-design.md`](agent-first-workspace-v1-design.md) is the canonical
  product and engineering design baseline. Requirements there are not completion claims.
- [`docs/roadmap.md`](docs/roadmap.md) defines dependency-ordered phases and exit gates.
- [`docs/implementation-status.md`](docs/implementation-status.md) maps canonical sections to
  evidence-based status.
- [`docs/r3-r4-foundation.md`](docs/r3-r4-foundation.md) inventories the entity foundation,
  versioned stream, PM/query snapshots, retention, and backup profiles.
- [`docs/r4-local-runbook.md`](docs/r4-local-runbook.md) gives the supported local setup and named
  verification gates without embedding secrets.
- [`docs/backup-recovery.md`](docs/backup-recovery.md) defines profile-aware backup and recovery.
- [`docs/adr/README.md`](docs/adr/README.md) registers accepted and proposed decisions.

## Local R4 Startup

Use Node.js 24, npm, a PostgreSQL 17 database, and PostgreSQL 17 backup clients when exercising the
backup gate. The complete sequence, including operator grants and secret handling, is in the
[local runbook](docs/r4-local-runbook.md). The abbreviated flow is:

```sh
npm ci
DATABASE_URL='postgres://operator@host/database' npm run migrate:postgres
npm run build:r4
DATABASE_URL='postgres://operator@host/database' \
R4_CURSOR_SIGNING_KEY="$R4_CURSOR_SIGNING_KEY" \
npm run start:r4
```

Generate `R4_CURSOR_SIGNING_KEY` as at least 32 random bytes encoded with base64url, keep it outside
the repository, and do not print it into logs or documentation. The R4 server defaults to
`127.0.0.1:3001` and serves the built web assets and API from the same origin.

The administrator CLI bootstraps the first human credential, adds the R4 permission bundle for an
existing member, and manages private-Space grants. Tokens are printed once; only SHA-256 digests are
stored. Do not place bearer tokens in URLs, browser storage, fixtures, or documentation.

The historical `npm start` demo remains unchanged and process-local. `.dim/` remains preserved
development infrastructure, not application source or evidence of product completion.

## Development and Evidence Gates

```sh
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:postgres   # requires DATABASE_URL and never skips
npm run test:r4         # requires DATABASE_URL and never skips
npm run test:commands   # requires DATABASE_URL and never skips
npm run test:backup     # requires PostgreSQL 17 tools and database creation authority
node --test build/test/r4-route-inventory.test.js
node script/generate-api-r4.mjs --check
```

These are named local gates. A local exit code of zero is evidence for that command only. Prior
recorded runs reported 71 `test:postgres`, 28 `test:backup`, and 141 `test:r4` tests on an older
revision; they are historical evidence, not current-HEAD totals. Final named-gate reruns remain
pending. GitHub Actions/CI remains deferred, and no document may translate local checks into a
passing formal phase gate.
