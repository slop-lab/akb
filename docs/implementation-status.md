# Implementation Status

This matrix maps every numbered section of the canonical
[v1 design](../agent-first-workspace-v1-design.md) to delivery status, target roadmap phase, and
current evidence. It must be updated when evidence changes, not when intent changes.

## Status Vocabulary

| Status | Meaning |
| --- | --- |
| **Documented** | A requirement, decision, reference, or explanation exists, but no dependency-ordered implementation commitment is applicable or recorded. |
| **Planned** | An executable roadmap phase, dependency sequence, and exit gate are recorded; implementation evidence has not started. |
| **In progress** | Product implementation evidence exists, but the applicable phase or behavioral gate has not passed. Partial behavior stays in this state. |
| **Implemented** | Runtime product behavior exists and the linked behavioral exit gate has passed with executable evidence. |

Statuses describe product delivery, not document completion. Documentation and schemas do not
satisfy behavioral gates. The [README](../README.md#current-status) records the bounded in-memory
Work Item API and opt-in PostgreSQL adapters now present. R1, R2, R3, and R4 are `In progress`:
executable evidence exists, including passing native Node 24 live export/import/archive and
real-browser exercises, but their full dependency-ordered exit gates and deferred CI have not
passed. No canonical section is `Implemented`, and the aggregate `npm run test:r4` command has not
been recorded as passing.

The [R1/R2 verification and CI deferral record](r1-r2-verification.md) distinguishes
clean-checkout and pinned-container results from the still-unexecuted Actions gate.
The user authorized skipping the unavailable CI infrastructure check for continued
work; this is not a passing gate or permission to misreport completion.

## Canonical Section Matrix

The phase shown is the earliest accountable target; broad concerns continue through later phases.
Evidence links prove only the classification shown; narrow R1/R2 behavior does not complete a
canonical section.

| Section | Canonical subject | Status | Target phase | Current evidence path |
| ---: | --- | --- | --- | --- |
| 0 | Decision Summary | Planned | R1 contracts; architecture completed through R8 | [Design §0](../agent-first-workspace-v1-design.md#0-decision-summary); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 1 | Product Definition | Planned | R8 release proof | [Design §1](../agent-first-workspace-v1-design.md#1-product-definition); [R8](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 2 | v1 Scope and Completeness | Planned | R4-R8, completed at R8 | [Design §2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness); [R8 gate](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 3 | Core Principles and Invariants | In progress | R1 contracts; enforced incrementally through R8 | [Work Item model](../src/work-items/model.ts); [store tests](../test/work-item-store.test.ts) |
| 4 | Conceptual Model | In progress | R1 contracts and R3 persisted foundation | [Work Item model](../src/work-items/model.ts); [entity registry](../migrations/005_entity_registry_acl.sql); [foundation inventory](r3-r4-foundation.md) |
| 5 | Project Management Requirements | In progress | R4, extended in R5 and R8 | [command registry](../src/http/command-v1/routes.ts); [PM migration](../migrations/007_r4_pm_core.sql); [R4 command tests](../test/postgres-r4-command-lifecycle.test.ts) |
| 6 | Document and Knowledge System | Planned | R5 documents and R7 knowledge | [Design §6](../agent-first-workspace-v1-design.md#6-document-and-knowledge-system); [R5](roadmap.md#r5-planning-documents-and-collaboration); [R7](roadmap.md#r7-knowledge-promotion-proposals-and-review) |
| 7 | Human-Agent Collaboration | Planned | R6 runtime; R7 review completion | [Design §7](../agent-first-workspace-v1-design.md#7-human-agent-collaboration); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 8 | Progressive Retrieval | Planned | R6 | [Design §8](../agent-first-workspace-v1-design.md#8-progressive-retrieval); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 9 | Human UX | In progress | R4-R8 | [web source](../apps/web/src); [browser scenarios](../test/browser); 10 real-browser scenarios passed locally while the formal phase gate remains open |
| 10 | API | In progress | R1 contracts, R2 narrow API, completed through R7 | [legacy OpenAPI](openapi.json); [R4 OpenAPI](openapi-r4.json); [route inventory test](../test/r4-route-inventory.test.ts) |
| 11 | Data Model | In progress | R3 | [entity registry](../migrations/005_entity_registry_acl.sql); [generic stream](../migrations/006_entity_event_outbox.sql); [PM model](../migrations/007_r4_pm_core.sql); [query/import model](../migrations/008_human_query_import_retention.sql) |
| 12 | Search and Indexing | In progress | R4 lexical baseline; R6 full retrieval pipeline | [paged search schema](../src/contracts/r4/search.ts); [search router](../src/http/human-v1/search-router.ts); [security tests](../test/postgres-r4-search-security.test.ts); embeddings and R6 retrieval remain planned |
| 13 | Runtime Protocol | Planned | R6 | [Design §13](../agent-first-workspace-v1-design.md#13-runtime-protocol); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 14 | Automation and Extensibility | Planned | R8 | [Design §14](../agent-first-workspace-v1-design.md#14-automation-and-extensibility); [R8](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 15 | Real-Time Behavior, Concurrency, and Consistency | In progress | R2 revision conflict baseline; R3-R6 completion | [stale-write tests](../test/work-item-store.test.ts); [concurrent HTTP PATCH](../test/work-item-concurrency-http.test.ts); durable concurrency remains planned |
| 16 | Security | In progress | R3 foundation; verified through R8 | [identity tests](../test/postgres-identity.test.ts); [Space ACL tests](../test/postgres-space-acl.test.ts); bounded Work Item Space inheritance is implemented while the broader private-object and retrieval ACL remains planned |
| 17 | Architecture | In progress | R1 workspace foundation; R3-R8 components | [R4 composition](../src/postgres/r4-application.ts); [foundation inventory](r3-r4-foundation.md); [ADR registry](adr/README.md) |
| 18 | Operations and Performance | In progress | R3 operational baseline; R8 release proof | [backup runbook](backup-recovery.md); [profile source](../src/operations/backup/profiles.ts); schema-004/008 profiles exist while PITR, encryption, scheduling, and release operations remain planned |
| 19 | Test Strategy | In progress | R1 harness; expanded as a gate in every phase | [domain tests](../test/work-item-store.test.ts); [HTTP tests](../test/work-item-http.test.ts) |
| 20 | Implementation Sequence | In progress | R0 roadmap; R1-R4 underway and all behavioral phases remain unpassed | [Dependency sequence](roadmap.md#dependency-sequence); [current tests](../test/) |
| 21 | Estimated Scale of Work | Documented | Reassess at every phase boundary; not a behavior gate | [Design §21](../agent-first-workspace-v1-design.md#21-estimated-scale-of-work) |
| 22 | v1 Definition of Done | Planned | R8 | [Design §22](../agent-first-workspace-v1-design.md#22-v1-definition-of-done); [R8 gate](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 23 | Priority Backlog | Planned | Scheduled across R1-R8 | [Design §23](../agent-first-workspace-v1-design.md#23-priority-backlog); [Dependency sequence](roadmap.md#dependency-sequence) |
| 24 | ADR Candidates | In progress | R1 minimum decisions; remaining decisions before dependent work | [ADR registry](adr/README.md); ADR-002 and current-HTTP ADR-004 accepted, remaining candidates proposed |
| 25 | Designs to Avoid | Planned | Enforced in reviews and gates R1-R8 | [Design §25](../agent-first-workspace-v1-design.md#25-designs-to-avoid); [Gate rules](roadmap.md#status-and-gate-rules) |
| 26 | First Vertical Slice | In progress | R2 proves only Work Item API mechanics; full slice completes in R7 | [R2 HTTP tests](../test/work-item-http.test.ts); [restart limitation test](../test/work-item-list-restart.test.ts); full slice remains planned |
| 27 | Product Direction | Planned | Dependency order R2-R8 | [Design §27](../agent-first-workspace-v1-design.md#27-product-direction); [Dependency sequence](roadmap.md#dependency-sequence) |
| 28 | Sources | Documented | Maintain as design provenance; no product implementation phase | [Design §28](../agent-first-workspace-v1-design.md#28-sources) |

## Current Delivery Summary

| Classification | Canonical sections | Behavioral meaning |
| --- | --- | --- |
| Documented | 21, 28 | Reference material exists; neither section is itself a product behavior. |
| Planned | 0-2, 6-8, 13-14, 22-23, 25, 27 | Roadmap ownership and gates exist; implementation evidence has not started for these sections. |
| In progress | 3-5, 9-12, 15-20, 24, 26 | R1-R4 runtime evidence exists; each canonical section retains open gate or later-phase scope. |
| Implemented | None | No behavioral gate has passed. |

## First API Slice Status Boundary

R1, R2, R3, and R4 are in progress, not complete phase gates. The loopback default remains a revision-safe
in-memory demo. PostgreSQL HTTP now authenticates opaque expiring credentials and revalidates active
Workspace membership plus explicit Work grants inside operation transactions. The bounded R3
checkpoint adds transactional Work Item outbox fanout, a durable database-inbox worker, and
authenticated event replay. Worker drains are capped at 100 claims and report unsuccessful summaries
with a nonzero exit status. A bounded Work Item Space ACL now protects current reads, SQL-filtered
lists/counts, writes, idempotent retries, and workspace replay. UI, network webhooks, the broader
entity/private-object ACL architecture, progressive expansion, Run credentials, and
proposal/review remain planned. The additive R3/R4 application supplies the broader entity ACL,
PM commands, Human Query snapshots, lexical search, import/export, and web checkpoint documented in
[the foundation inventory](r3-r4-foundation.md). Recorded live and browser exercises pass the
bounded paths described there, but do not promote the formal gate.

The current `WorkItemStore` adapter executes commands all-or-nothing in memory. Its hard defaults
are 10,000 current Work Items and 100,000 audit records, with one immutable revision/event record
pair for every effective create or patch and no history eviction. Exhausting an applicable budget
causes a pre-mutation `507 budget_exceeded` response with truthful resource and capacity details.
The PostgreSQL adapters provide durable Work Item and generic entity transactions plus normalized
Workspace, Principal, Membership, ACL, hash-only credential storage, and schema-004/schema-008
backup profiles. PITR, encrypted backup storage, network delivery, full production operations, and
the remaining formal R3/R4 gates remain planned.
Exact OpenAPI constraints are structurally checked against shared Zod schemas, stable statuses are
behaviorally contract-tested, and agent retrieval remains future R6 work.

The [observed error-example tests](../test/openapi-examples.test.ts) and
[same-base concurrent PATCH test](../test/work-item-concurrency-http.test.ts)
provide additional R2 evidence. The Actions job remains unassigned, and the
protected DIM QEMU service socket is unavailable in this workspace. CI is
explicitly deferred; exploratory follow-on work does not close the dependency gate.

## Update Rules

1. Link concrete evidence before changing a status.
2. Use `In progress` for partial behavior, even when its local tests pass, until the stated gate
   for the mapped capability passes.
3. Use `Implemented` only for observed runtime behavior with passing automated or manual evidence;
   never infer it from design text, types, schemas, mocks, or generated documentation.
4. If an implementation deliberately narrows a requirement, keep the canonical section at
   `In progress` and record the remaining gap.
5. Keep the [README](../README.md), this matrix, and phase evidence consistent without treating
   one document's existence as proof of another document's behavioral claims.
