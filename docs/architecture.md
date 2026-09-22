# Architecture Contract

## Status and authority

This document governs the intended engineering architecture. The
[canonical v1 design](../agent-first-workspace-v1-design.md) remains the product and engineering
baseline, and the [repository README](../README.md) remains authoritative for what exists today.
Where this document describes future behavior, it is a contract to implement, not evidence that
the behavior is available.

## Repository reality and the first slice

The repository currently runs an untyped `app/server.mjs` DIM sample that returns plain text. It
does not yet contain the product API, domain modules, retrieval service, runtime protocol, worker,
or persistence adapters.

The accepted first-slice persistence boundary is an in-memory adapter with no database. This is a
development adapter for the initial vertical slice, not the intended deployment architecture. It
must sit behind application-owned repository and unit-of-work ports so that domain and application
code do not depend on maps, process globals, or adapter-specific behavior. Its data is process-local
and disposable; it does not satisfy durability, migration, backup, concurrency, multi-process,
search, or production-readiness requirements. Until that adapter exists in code, "first-slice
in-memory adapter" names an accepted implementation constraint, not an implemented component.

The planned durable adapter is PostgreSQL. PostgreSQL will be canonical for entities, normalized
domain records, relations, revisions, ACL state, events, outbox records, full-text search, and
metadata. S3-compatible object storage is planned for large artifacts, attachments, and raw traces.
A search index, embedding service, summary cache, or object store must never become the canonical
source of domain truth.

The in-memory and PostgreSQL adapters must implement the same observable application contracts:
stable IDs, monotonic entity revisions, optimistic revision checks, command idempotency, atomic
command results, ordered events, and explicit authorization. Adapter substitution must not change
domain semantics. PostgreSQL-specific operational guarantees remain gated until the PostgreSQL
adapter is implemented and tested.

## System shape

The planned system is a PostgreSQL-centered modular monolith plus worker, web client, object
storage, and independent runtimes. Start with one deployable application boundary rather than
microservices or Kubernetes. Separate protocol layers expose commands, human queries, agent
retrieval, events, artifacts, and runtime control while reusing the same internal domain semantics.

The planned modules are:

- identity and workspace;
- project, work, and planning;
- content and knowledge;
- relations and collaboration;
- agent control and retrieval;
- search and notifications;
- automation and integrations;
- artifacts and audit.

Each module owns its model and persistence boundary. Cross-module interaction occurs only through
public commands, queries, and events. A module must not mutate another module's tables or reach into
another module's repository implementation. Shared types are contracts, not permission to bypass
the owning module.

The first vertical slice must preserve this shape even if several ports initially use in-memory
adapters. The slice is one end-to-end flow: a human manages Project Work, delegates a Run, the agent
retrieves bounded context, records plan and activity, creates a Proposal, and a human reviews and
applies it. Scope reduction may omit features, but it must not collapse architectural roles such as
owner versus delegate, current state versus revision, or proposal versus canonical state.

## Domain and storage contract

Every first-class object has a stable internal ID and revision. Human-readable keys are aliases.
The shared entity registry provides identity, tenancy, timestamps, current revision, and lifecycle
state. Specialized, normalized tables hold the constraints and query fields of hot domains.

Generic JSON or entity-attribute-value storage is prohibited as a replacement for core Project,
Work, Cycle, assignment, workflow, relation, or ACL structures. These domains require explicit
columns, foreign keys, uniqueness constraints, and indexes. JSONB is permitted for bounded extension
data, custom-field values, immutable snapshots, and versioned schema payloads, provided frequently
filtered fields can be promoted to indexed columns and domain invariants do not live only in
untyped payloads.

Canonical documents use a Markdown-compatible block tree with stable block IDs. Whole-tree revision
JSON plus a block index is an acceptable first durable representation; later delta optimization
must preserve IDs, revision history, import/export fidelity, and anchors.

## Command and transaction boundary

Every important write supplies `baseRevision` or an equivalent `If-Match` precondition. A command
must perform this sequence as one logical unit:

1. authenticate the actor and authorize policy;
2. verify idempotency and the current revision;
3. mutate current domain state;
4. append the immutable entity revision;
5. append the domain event;
6. append the outbox record;
7. commit.

In the planned PostgreSQL adapter, steps 3 through 6 must be committed in the same database
transaction. Authorization and revision failure must commit none of them. The in-memory adapter must
model the same all-or-nothing result so tests do not normalize partial writes. The command result
must identify the command, event, resulting value, and revision as applicable.

External delivery, webhooks, indexing, embedding, summary generation, and other remote calls occur
after commit through the outbox and worker. They must never run inside the domain transaction.
Consumers must be idempotent and support retry, dead-lettering, and replay. Current state plus
append-only revisions and events is the contract; full event sourcing is not required.

## Dependency direction

Domain code contains invariants and has no dependency on HTTP, PostgreSQL, DIM, object storage,
runtime vendors, or UI code. Application services orchestrate domain operations through declared
ports. Adapters implement those ports for HTTP, in-memory persistence, PostgreSQL, events, artifacts,
and external runtimes. Entrypoints compose adapters but do not contain domain rules.

DIM is development infrastructure only. Files under `.dim/` are not application modules, domain
contracts, or migration sources. The sample `app/server.mjs` also does not establish the future
module layout or technology boundaries.

## Evolution rules

- New protocol and schema decisions must be recorded in the ADR registry before they are treated as
  accepted architecture.
- Type and protocol revisions are immutable; persisted objects pin the schema revision used.
- Destructive migrations require export, backup, and dry-run paths, while historical snapshots are
  interpreted with their contemporary schema.
- Splitting a module into another process must follow measured scaling or isolation needs and must
  preserve its public commands, queries, events, authorization, and transaction semantics.
- Documentation, schemas, or adapters alone do not satisfy a behavioral phase gate; executable
  tests and end-to-end evidence are required.
