# ADR-013: PostgreSQL Work Item Persistence

- Status: proposed
- Date: 2026-10-09
- Owners: repository maintainers
- Reviewers: persistence checkpoint reviewers

## Context

ADR-002 accepts current state plus immutable revisions and semantic events, but its first adapter is
process-local. R3 needs an incremental durable adapter without implying that identity, ACL, outbox
delivery, backup/restore, or the full canonical entity model is complete.

## Decision

Add an opt-in PostgreSQL implementation of the application-owned `WorkItemStore`. A versioned,
explicit migration creates normalized tables for current Work Items, immutable Work Item revisions,
semantic domain events, workspace event sequences, and create-idempotency records.

Each effective create or patch runs in one PostgreSQL transaction. Creation serializes only commands
with the same `(workspaceId, idempotencyKey)` through a transaction advisory lock derived from an
unambiguous JSON tuple. The tuple remains protected by a composite primary key. Patch locks only the
target Work Item row before checking `baseRevision`. Event sequence allocation locks the sequence row
for that workspace. The adapter does not use a global application lock.

Current state, immutable revision, semantic event, and create-idempotency records commit or roll back
together. A semantic no-op patch writes nothing. Events have a unique workspace sequence. All query
results are parsed through Zod before entering the application model.

The PostgreSQL adapter does not preserve the finite capacities of the bounded development-memory
adapter. Those limits protect process memory and are not a durable-domain quota. Removing those
adapter-specific limits avoids globally serializing every durable mutation on one quota counter.

Migrations run only through `npm run migrate:postgres`; application startup never mutates schema.
`DATABASE_URL` is mandatory for migration, administration, and PostgreSQL server commands. Committed
migration files are immutable and migration tracking verifies SHA-256 checksums. Legacy metadata may
backfill only migration 001 at its pinned known digest. ADR-014 proposes the subsequently implemented
authenticated PostgreSQL HTTP composition.

## Alternatives Considered

- A singleton capacity-counter lock was rejected because it would globally serialize all durable
  mutations to retain limits whose purpose is specific to the in-memory adapter.
- Process-wide serialization was rejected because row and transaction advisory locks provide the
  required conflict behavior at narrower scopes.
- Automatic migration on HTTP startup was rejected because schema change must be an explicit
  operator action and startup must fail rather than silently fall back.
- An ORM was rejected for this first adapter because parameterized Postgres.js statements and Zod
  result parsing provide the required boundary with less migration and runtime surface.

## Scope and Non-Goals

This decision covers only current Work Item persistence, complete Work Item revision history,
semantic events, create idempotency, optimistic patch concurrency, list scoping, and migration
execution. Identity and bounded Work authorization are proposed separately by ADR-014. Neither
decision implements the canonical entity registry, private ACL inheritance, relations, outbox
delivery, replay APIs, retention, telemetry, backup/restore, or full R3.

## Consequences

- The `WorkItemStore` port permits synchronous or asynchronous results, preserving the synchronous
  in-memory adapter while allowing database I/O.
- HTTP routes await every store operation; rejected adapter operations reach the existing stable
  internal-error boundary.
- Concurrent same-base patches produce one winner through the target row lock.
- Concurrent duplicate creates replay one durable result through tuple-scoped locking and uniqueness.
- Workspace sequence rows are a deliberate per-workspace serialization point for semantic events.
- The initial migration is additive and forward-only. Future destructive migrations require the
  backup, dry-run, rollback, and restore work already assigned to R3.

## Verification

`npm run test:postgres` requires a real `DATABASE_URL` and never skips. It proves restart persistence,
same-base patch concurrency, duplicate-create replay, transaction rollback across current/history/
event/idempotency records, workspace list scoping, and the asynchronous HTTP surface. Default
`npm run check` continues to cover the in-memory adapter; PostgreSQL verification remains an explicit
separate gate while CI runner availability is deferred.

## Related Decisions

ADR-002 remains accepted for current-state, revision, and event semantics. ADR-001, ADR-005, and
ADR-012 remain proposed for the broader entity, event/outbox, and ACL architecture.
