# Delivery Roadmap

This roadmap turns the canonical [v1 implementation sequence](../agent-first-workspace-v1-design.md#20-implementation-sequence)
into executable repository phases. The [canonical design](../agent-first-workspace-v1-design.md)
remains authoritative for product requirements. Current evidence is recorded in the
[implementation status matrix](implementation-status.md).

## Status and Gate Rules

- Exploratory implementation for a phase may begin while dependency work is still in progress.
- A phase cannot pass its exit gate, or claim completion, before every dependency phase passes.
- An exit gate passes only with executable evidence committed at the listed evidence paths.
- Documentation, schemas, generated specifications, mocks, and test plans do not satisfy a
  behavioral gate by themselves.
- A narrower phase may intentionally defer canonical behavior, but its exclusions must remain
  explicit and scheduled.
- Security, revision safety, and tenant isolation are gates, not cleanup work.

This exploratory allowance lets work begin early enough to expose interface and integration risks;
it does not relax dependency ordering. No phase can pass or claim completion before every dependency
phase passes.

At present, a bounded Work Item HTTP slice provides exploratory R1/R2 evidence, and an opt-in
PostgreSQL Work Item adapter provides the first partial R3 persistence evidence. **No behavioral
phase gate has passed**. Passing local or database tests does not complete R1, R2, or R3.

## Dependency Sequence

```text
R0 Baseline documentation
  -> R1 Strict TypeScript contracts and test foundation
  -> R2 Revision-safe Work Item API slice
  -> R3 Persistent tenant, identity, event, and ACL foundation
  -> R4 Project-management core
  -> R5 Planning, documents, and collaboration
  -> R6 Progressive retrieval and runtime control
  -> R7 Knowledge promotion, proposals, and review
  -> R8 v1 completeness, operations, and release proof
```

R2 proves a deliberately narrow command path before infrastructure breadth. R3 replaces its
in-memory adapter with canonical persistence and adds the security and transaction guarantees on
which every later phase depends. R6 depends on ACL-complete R3 because authorization must precede
retrieval. R7 depends on revisions from R3, source content from R5, and snapshots/receipts from R6.
R8 integrates and validates the full v1 scenarios rather than adding an unrelated feature tier.

## R0: Baseline Documentation

**Depends on:** none.

**Deliverables**

- Maintain the canonical design as the requirement baseline.
- Publish the product/domain summary, dependency-ordered roadmap, and section-level status matrix.
- Define evidence vocabulary so plans and documents cannot be mistaken for running behavior.

**Exit gate**

- [Product and domain](product-and-domain.md), this roadmap, and
  [implementation status](implementation-status.md) exist, use local evidence links, cover
  canonical sections 0-28, and state the greenfield baseline and first-slice exclusions.
- This is a documentation gate only. Passing it does not pass any product behavioral gate.

## R1: Strict TypeScript Contracts and Test Foundation

**Depends on:** R0.

**Deliverables**

- Establish a strict TypeScript workspace with deterministic format, lint, type-check, unit-test,
  integration-test, and build commands.
- Define branded identifiers, revision values, Work Item command/query DTOs, typed errors, and
  schema validation at HTTP boundaries.
- Record and approve the minimum ADRs needed for entity/revision storage boundaries, command
  semantics, error envelopes, and the temporary repository adapter.
- Add test fixtures for create, read, patch, duplicate idempotency keys, stale revisions, and
  invalid input.

**Exit gate**

- A clean checkout installs reproducibly and all quality commands return exit code 0.
- Strict compilation rejects unvalidated boundary data and invalid identifier/revision mixing.
- Contract fixtures execute in CI and generated API documentation matches the runtime schemas.
- Evidence paths: root toolchain manifests, `apps/api/`, `packages/domain/`, `packages/schemas/`,
  and CI configuration when those paths are created.

## R2: Revision-Safe Work Item API Slice

**Depends on:** R1.

**Deliverables**

- Implement create, read, and patch HTTP operations for the minimal Work Item fields needed to
  prove identity, title, state, and revision behavior.
- Use a replaceable in-memory repository adapter; keep domain commands independent of transport
  and storage.
- Require idempotency on creation and `baseRevision` or `If-Match` on patch.
- Return typed invalid-input, not-found, idempotency-conflict, and revision-conflict responses.
- Record enough in-memory revision history to prove monotonic revisions and stale-write rejection.
- Bound the development adapter explicitly and reject exhausted item or audit-record admission
  budgets without partial mutation.

**Explicit exclusions**

This first API slice is narrower than v1. It excludes PostgreSQL, UI, authentication, ACL
enforcement, full progressive expansion, runtime execution, and proposal/review. It also excludes
Project, Space administration, search, board/list views, comments, events/outbox delivery, and all
other v1 completeness behavior unless strictly required by the minimal Work Item contract.

The current adapter defaults to 10,000 current Work Items and 100,000 audit records. Each effective
create or patch consumes one immutable revision/event record pair; history is not evicted. An
exhausted applicable budget rejects the command before state, history, events, idempotency records,
clock, or ID mutation and maps to `507 budget_exceeded` with truthful resource and capacity details.
These process-local all-or-nothing semantics do not provide the durable repository, unit-of-work,
transaction, or outbox guarantees assigned to R3.

**Exit gate**

- Black-box API tests prove create -> read -> patch -> read with a monotonic revision.
- Repeating the same create idempotency key produces the same result; reusing it with different
  input produces an idempotency conflict.
- Two patches from the same base revision cause exactly one success and one revision conflict,
  with no lost update.
- Process restart is documented and tested to lose data, confirming that persistence is deferred
  rather than implied.
- API help/specification and error examples match observed responses.

## R3: Persistent Tenant, Identity, Event, and ACL Foundation

**Depends on:** R2.

**Deliverables**

Current partial evidence is limited to versioned Work Item persistence, transaction rollback,
optimistic concurrency, scoped idempotency, durable history/events, and a local opt-in HTTP
entrypoint. Authentication, ACLs, entity/relation breadth, outbox delivery, replay, retention,
telemetry, and backup/restore remain outstanding.

- Introduce PostgreSQL migrations for Workspace, Principal, Membership, Entity, Revision,
  Relation, domain event, outbox, and persisted Work Item state.
- Add authentication, permission atoms, scope inheritance, private overrides, and first-class
  human, agent, service, and runtime principals.
- Commit mutation, revision, event, and outbox atomically; process external delivery outside the
  transaction.
- Add cursor/event replay, archive/retention foundations, structured telemetry, and migration
  rollback/restore procedures.

**Exit gate**

- Restart and migration tests preserve Work Items and complete revision history.
- Concurrency and idempotency tests pass against PostgreSQL, including transaction rollback under
  injected failure.
- The ACL matrix proves allowed operations and indistinguishable not-found/denied behavior where
  existence would leak.
- Event replay is ordered and duplicate-safe; the outbox resumes after worker interruption.
- Backup and restore rehearsal recovers the tested fixture with matching revisions and digests.

## R4: Project-Management Core

**Depends on:** R3.

**Deliverables**

- Add Space, Workflow, State, Project, labels, owners, dates, parent/typed relations, comments,
  archive, and Saved Views.
- Build human list, board, and peek surfaces with server-side filters, signed cursor pagination,
  keyboard paths, and optimistic conflict handling.
- Add basic lexical search and minimal import/export for core PM entities.

**Exit gate**

- A team runs a real Project through create, organize, assign, relate, comment, move, complete,
  archive, export, and re-import without an external tracker for the exercised path.
- A 100,000-item fixture pages without duplicates or omissions under a stable query order.
- Keyboard-only create, edit, filter, board move, peek, and archive flows pass browser tests.
- Private-Space data remains absent from query, count, board, search, and export results.

## R5: Planning, Documents, and Collaboration

**Depends on:** R4.

**Deliverables**

- Add Cycle and rollover, Milestone, Module, project progress/update snapshots, timeline, inbox,
  templates, and notifications.
- Add Page and Markdown-compatible stable block storage, nesting, inline comments, autosave,
  history, restore, and visible revision conflicts.
- Preserve stable links and block identities across archive and import/export.

**Exit gate**

- The ordinary-project scenario in
  [design section 2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness) passes end to
  end, including cycle scope changes, blocker visibility, metric snapshot, and archive.
- Cycle rollover and progress formulas pass domain/property tests for canceled, parent/child,
  estimated, and unestimated work.
- Page edit conflict, history restore, Markdown round trip, and stable block-link tests pass.
- Notification delivery is duplicate-safe and honors user preferences.

## R6: Progressive Retrieval and Runtime Control

**Depends on:** R3 and R5.

**Deliverables**

- Add agent registry/installations, runtime endpoints, Runs, leases, generation, heartbeat,
  cancellation, activity, plans, signals, artifacts, and immutable input/context snapshots.
- Implement ref/card/detail/raw projections, search/read/expand/traverse, signed snapshot-bound
  cursors, explicit omissions, receipts, and delta reads.
- Add an API-only reference runtime and runtime simulator; preserve semantic activity separately
  from raw traces.

**Exit gate**

- The retrieval scenario in
  [design section 2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness) passes with
  stable pagination, reproducible receipts, explicit omissions, and delta reads.
- ACL checks execute before every retrieval candidate, expansion, summary, embedding, and count;
  private-leak regression fixtures pass.
- Lease loss, stale generation, duplicate activity, cancellation, input/resume, child-run bounds,
  and artifact chunk tests pass in the runtime simulator.
- An API-only runtime completes bootstrap -> selective expansion -> plan/activity -> artifact, and
  the human surface shows exactly what the run saw.

## R7: Knowledge Promotion, Proposals, and Review

**Depends on:** R5 and R6.

**Deliverables**

- Add Claim, Decision, Evidence, Question, Experiment, provenance, lifecycle, and relation graph.
- Add proposal creation, patch/diff presentation, review decisions pinned to subject revisions,
  stale-review handling, conflict recovery, and accepted canonical mutation.
- Add derived-summary freshness and promotion policy while keeping generated content noncanonical.

**Exit gate**

- Delegation and knowledge-promotion scenarios in
  [design section 2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness) pass end to
  end.
- Canonical state changes only after an authorized approval; rejected, stale, and
  changes-requested proposals leave canonical state unchanged.
- Review evidence pins exact subject, source, summary-profile, and input revisions.
- Superseded knowledge remains discoverable as history while default search favors accepted,
  current knowledge.

## R8: v1 Completeness, Operations, and Release Proof

**Depends on:** R7.

**Deliverables**

- Complete intake, recurrence, automation, GitHub integration, analytics, extension surfaces,
  accessibility, responsive UI, retention, observability, performance, and secure operations.
- Close all Core and Complete v1 scope gaps identified by the status matrix.
- Exercise upgrades, rollback, backup/restore, import/export, threat controls, and self-hosting.

**Exit gate**

- Every criterion in [design section 22](../agent-first-workspace-v1-design.md#22-v1-definition-of-done)
  has a linked executable proof and no open release-blocking gap.
- A 5-20-person team completes a two-month dogfood period without an external tracker and without
  a documented blocker in the required product path.
- Security review, ACL matrix, accessibility audit, upgrade/rollback, backup restore, and required
  E2E suites pass against the release candidate.
- Normal-load measurements meet or explicitly disposition the targets in
  [design section 18](../agent-first-workspace-v1-design.md#18-operations-and-performance).

## Evidence Promotion

When work begins, update the [status matrix](implementation-status.md) only after checking evidence:

1. `Documented` when only the canonical requirement or explanatory document exists.
2. `Planned` when this roadmap assigns executable work, dependencies, and a gate.
3. `In progress` when implementation artifacts exist but the relevant exit gate has not passed.
4. `Implemented` only when runtime code exists and the linked behavioral gate has passed.

Partial delivery remains `In progress`; generated contracts or passing unit tests alone never
promote an end-to-end requirement to `Implemented`.
