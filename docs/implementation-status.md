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
satisfy behavioral gates. The [README](../README.md#current-status) establishes that the repository
currently has only a plain-text bootstrap. Therefore **no product behavior is implemented yet**,
and no canonical section is currently `In progress` or `Implemented`.

## Canonical Section Matrix

The phase shown is the earliest accountable target; broad concerns continue through later phases.
Each evidence link currently proves only the `Documented` or `Planned` classification shown.

| Section | Canonical subject | Status | Target phase | Current evidence path |
| ---: | --- | --- | --- | --- |
| 0 | Decision Summary | Planned | R1 contracts; architecture completed through R8 | [Design §0](../agent-first-workspace-v1-design.md#0-decision-summary); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 1 | Product Definition | Planned | R8 release proof | [Design §1](../agent-first-workspace-v1-design.md#1-product-definition); [R8](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 2 | v1 Scope and Completeness | Planned | R4-R8, completed at R8 | [Design §2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness); [R8 gate](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 3 | Core Principles and Invariants | Planned | R1 contracts; enforced incrementally through R8 | [Design §3](../agent-first-workspace-v1-design.md#3-core-principles-and-invariants); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 4 | Conceptual Model | Planned | R1 contracts and R3 persisted foundation | [Design §4](../agent-first-workspace-v1-design.md#4-conceptual-model); [R3](roadmap.md#r3-persistent-tenant-identity-event-and-acl-foundation) |
| 5 | Project Management Requirements | Planned | R4, extended in R5 and R8 | [Design §5](../agent-first-workspace-v1-design.md#5-project-management-requirements); [R4](roadmap.md#r4-project-management-core) |
| 6 | Document and Knowledge System | Planned | R5 documents and R7 knowledge | [Design §6](../agent-first-workspace-v1-design.md#6-document-and-knowledge-system); [R5](roadmap.md#r5-planning-documents-and-collaboration); [R7](roadmap.md#r7-knowledge-promotion-proposals-and-review) |
| 7 | Human-Agent Collaboration | Planned | R6 runtime; R7 review completion | [Design §7](../agent-first-workspace-v1-design.md#7-human-agent-collaboration); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 8 | Progressive Retrieval | Planned | R6 | [Design §8](../agent-first-workspace-v1-design.md#8-progressive-retrieval); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 9 | Human UX | Planned | R4-R8 | [Design §9](../agent-first-workspace-v1-design.md#9-human-ux); [R4](roadmap.md#r4-project-management-core) |
| 10 | API | Planned | R1 contracts, R2 narrow API, completed through R7 | [Design §10](../agent-first-workspace-v1-design.md#10-api); [R2](roadmap.md#r2-revision-safe-work-item-api-slice) |
| 11 | Data Model | Planned | R3 | [Design §11](../agent-first-workspace-v1-design.md#11-data-model); [R3](roadmap.md#r3-persistent-tenant-identity-event-and-acl-foundation) |
| 12 | Search and Indexing | Planned | R4 lexical baseline; R6 full retrieval pipeline | [Design §12](../agent-first-workspace-v1-design.md#12-search-and-indexing); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 13 | Runtime Protocol | Planned | R6 | [Design §13](../agent-first-workspace-v1-design.md#13-runtime-protocol); [R6](roadmap.md#r6-progressive-retrieval-and-runtime-control) |
| 14 | Automation and Extensibility | Planned | R8 | [Design §14](../agent-first-workspace-v1-design.md#14-automation-and-extensibility); [R8](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 15 | Real-Time Behavior, Concurrency, and Consistency | Planned | R2 revision conflict baseline; R3-R6 completion | [Design §15](../agent-first-workspace-v1-design.md#15-real-time-behavior-concurrency-and-consistency); [R2 gate](roadmap.md#r2-revision-safe-work-item-api-slice) |
| 16 | Security | Planned | R3 foundation; verified through R8 | [Design §16](../agent-first-workspace-v1-design.md#16-security); [R3](roadmap.md#r3-persistent-tenant-identity-event-and-acl-foundation) |
| 17 | Architecture | Planned | R1 workspace foundation; R3-R8 components | [Design §17](../agent-first-workspace-v1-design.md#17-architecture); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 18 | Operations and Performance | Planned | R3 operational baseline; R8 release proof | [Design §18](../agent-first-workspace-v1-design.md#18-operations-and-performance); [R8 gate](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 19 | Test Strategy | Planned | R1 harness; expanded as a gate in every phase | [Design §19](../agent-first-workspace-v1-design.md#19-test-strategy); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 20 | Implementation Sequence | Planned | R0 roadmap; behavioral phases R1-R8 remain unpassed | [Design §20](../agent-first-workspace-v1-design.md#20-implementation-sequence); [Dependency sequence](roadmap.md#dependency-sequence) |
| 21 | Estimated Scale of Work | Documented | Reassess at every phase boundary; not a behavior gate | [Design §21](../agent-first-workspace-v1-design.md#21-estimated-scale-of-work) |
| 22 | v1 Definition of Done | Planned | R8 | [Design §22](../agent-first-workspace-v1-design.md#22-v1-definition-of-done); [R8 gate](roadmap.md#r8-v1-completeness-operations-and-release-proof) |
| 23 | Priority Backlog | Planned | Scheduled across R1-R8 | [Design §23](../agent-first-workspace-v1-design.md#23-priority-backlog); [Dependency sequence](roadmap.md#dependency-sequence) |
| 24 | ADR Candidates | Planned | R1 minimum decisions; remaining decisions before dependent work | [Design §24](../agent-first-workspace-v1-design.md#24-adr-candidates); [R1](roadmap.md#r1-strict-typescript-contracts-and-test-foundation) |
| 25 | Designs to Avoid | Planned | Enforced in reviews and gates R1-R8 | [Design §25](../agent-first-workspace-v1-design.md#25-designs-to-avoid); [Gate rules](roadmap.md#status-and-gate-rules) |
| 26 | First Vertical Slice | Planned | R2 proves only Work Item API mechanics; full slice completes in R7 | [Design §26](../agent-first-workspace-v1-design.md#26-first-vertical-slice); [R2 exclusions](roadmap.md#r2-revision-safe-work-item-api-slice); [R7](roadmap.md#r7-knowledge-promotion-proposals-and-review) |
| 27 | Product Direction | Planned | Dependency order R2-R8 | [Design §27](../agent-first-workspace-v1-design.md#27-product-direction); [Dependency sequence](roadmap.md#dependency-sequence) |
| 28 | Sources | Documented | Maintain as design provenance; no product implementation phase | [Design §28](../agent-first-workspace-v1-design.md#28-sources) |

## Current Delivery Summary

| Classification | Canonical sections | Behavioral meaning |
| --- | --- | --- |
| Documented | 21, 28 | Reference material exists; neither section is itself a product behavior. |
| Planned | 0-20, 22-27 | Roadmap ownership and gates exist; implementation has not started. |
| In progress | None | No product implementation evidence exists. |
| Implemented | None | No behavioral gate has passed. |

## First API Slice Status Boundary

R2 will not represent v1 completion or the full first vertical slice in canonical section 26. It
is limited to a revision-safe Work Item API and excludes PostgreSQL, UI, authentication, ACL
enforcement, full progressive expansion, runtime execution, and proposal/review. Until later gates
pass, those capabilities remain `Planned`, even if R2 itself eventually becomes `Implemented`.

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
