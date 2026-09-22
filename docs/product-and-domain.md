# Product and Domain Summary

This document is a reader-oriented summary of the canonical
[v1 design](../agent-first-workspace-v1-design.md). The canonical design remains authoritative
when this summary is incomplete or ambiguous. Delivery state and evidence are tracked in the
[implementation status](implementation-status.md), and delivery order is defined by the
[roadmap](roadmap.md).

## Current Reality

The repository is a greenfield DIM sample. As recorded in the
[README](../README.md#current-status), the only executable application is a plain-text Node.js
bootstrap. **No product behavior is implemented yet.** In particular, design text, this summary,
roadmap entries, schemas, and test plans are not evidence that a behavioral exit gate has passed.

## Product Definition

Agent-First Workspace is a planned self-hostable collaboration, knowledge, and small-project
management system for people and software agents operating on the same typed, revisioned graph.
It is not an issue tracker with an AI feature attached. It combines:

- a typed work graph for projects, work, planning, and relations;
- versioned documents and structured knowledge;
- explicit human and agent responsibility, execution, evidence, and review; and
- progressive, budgeted retrieval with reproducible snapshots and disclosed omissions.

The v1 outcome is a complete path from intake through organization, planning, delegation,
execution, discussion, documentation, review, completion, and retrospective without requiring
an external issue tracker. The detailed scope and required end-to-end scenarios are in
[design section 2](../agent-first-workspace-v1-design.md#2-v1-scope-and-completeness).

## Users and Outcomes

| User | Intended outcome |
| --- | --- |
| Team member | Create, classify, plan, discuss, and complete work; connect decisions and evidence; inspect and review agent output. |
| Agent | Discover work through APIs, read only necessary context, disclose what was omitted, record activity and artifacts, and propose revision-safe changes. |
| Reviewer | Compare a proposal with its base revision and evidence, detect staleness, and explicitly approve, reject, or request changes. |
| Operator | Self-host, upgrade, observe, back up, restore, audit, and enforce retention and security policy. |
| Extension developer | Add declarative schemas and out-of-process integrations without depending on an unstable internal ABI. |

## Domain Model

The central composition is `Entity + Revision + Relation + Thread + Run`. The main bounded areas
and their responsibilities are:

| Area | Core concepts | Responsibility |
| --- | --- | --- |
| Tenancy and identity | Workspace, Principal, Membership, Installation | Establish tenant boundaries, identity kinds, membership, and delegated authority. |
| Work management | Space, Project, WorkItem, Workflow, Cycle, Milestone, Module, View | Organize accountable work, finite outcomes, workflow state, planning, and projections. |
| Content and knowledge | ContentDocument, ContentBlock, Page, Claim, Decision, Evidence, Question | Preserve revisioned source content and distinguish canonical knowledge from discussion or generated summaries. |
| Graph and collaboration | Entity, Revision, Relation, Thread, Comment, Activity | Give objects stable identity, history, typed edges, and durable collaboration records. |
| Agent control | AgentDefinition, Run, Lease, Plan, Signal, ContextSnapshot, Receipt | Pin agent/runtime identity, govern execution, and reproduce what a run was allowed to read and do. |
| Change governance | Artifact, Proposal, Review | Separate outputs and candidate changes from accepted canonical state. |
| Retrieval | Lens, projection, snapshot, cursor, omission, receipt | Return bounded context with explicit completeness, provenance, and stable pagination. |

Important boundaries include:

- A Workspace is the sole tenant boundary.
- A Space is a persistent responsibility and workflow boundary; a Project is a finite outcome
  that may span Spaces.
- A WorkItem has one owning Space and at most one accountable human owner. Agent delegates and
  executing actors are separate roles.
- Comments and activities are conversation and progress, artifacts are outputs, proposals are
  candidates, and only accepted revisions are canonical.
- Mutable current state is separate from immutable input and context snapshots.
- Search indexes, generated summaries, and raw traces are never canonical sources of truth.

The complete object definitions and cardinalities are in
[design section 4](../agent-first-workspace-v1-design.md#4-conceptual-model).

## Non-Negotiable Invariants

The implementation must preserve the invariants in
[design section 3](../agent-first-workspace-v1-design.md#3-core-principles-and-invariants),
including:

1. Stable IDs and monotonically checked revisions for first-class objects.
2. Revision preconditions for writes, with explicit conflicts rather than silent overwrites.
3. Separate human and agent projections over shared canonical domain and authorization semantics.
4. Explicit completeness, omission, snapshot, cursor, estimated size, and receipt metadata for
   agent list, search, and context reads.
5. ACL evaluation before candidate generation, graph expansion, summarization, embedding, or
   ranking.
6. Atomic current-state mutation, revision, event, and outbox recording.
7. Clear separation of accountable owner, delegate, executing actor, and requester.
8. Normalized constraints for core work domains instead of a generic JSON/EAV replacement.

## Surfaces and Architecture

The planned system separates Command, Human Query, Agent Retrieval, Event, Artifact, and Runtime
Protocol surfaces. The target architecture is a strict TypeScript modular monolith with a web
application and worker, PostgreSQL as the canonical store, S3-compatible object storage, and
independent runtimes. Module interaction occurs through public commands, queries, and events.
See [design section 10](../agent-first-workspace-v1-design.md#10-api) and
[design section 17](../agent-first-workspace-v1-design.md#17-architecture).

The target architecture is a v1 direction, not the scope of the first API delivery.

## First API Slice Versus v1

The first delivery slice in the [roadmap](roadmap.md#r2-revision-safe-work-item-api-slice) is an
intentionally narrow foundation exercise: a strict TypeScript HTTP API for creating, reading, and
revision-safe patching of a minimal Work Item representation, backed by a replaceable in-memory
adapter and verified through automated API tests.

That first API slice is **narrower than v1** and explicitly excludes:

- PostgreSQL and production persistence;
- the web UI or any other human interface;
- authentication;
- ACL enforcement;
- full progressive expansion, snapshot, omission, receipt, and delta retrieval;
- runtime execution, leases, heartbeat, cancellation, and capabilities; and
- proposal and review workflows.

Those exclusions are sequencing boundaries, not changes to the canonical v1 requirements. They
must be delivered in later phases and cannot be represented as implemented by the first slice.

## v1 Boundaries

v1 intentionally does not include enterprise portfolio, budget, or capacity management; CRM,
helpdesk, or SLA features; complex approval builders; complete Jira compatibility; native mobile
applications; built-in chat or video; GitHub-class code review; general-purpose BI builders; or a
real-time collaborative editor as a release prerequisite. The authoritative exclusions are in
[design section 0](../agent-first-workspace-v1-design.md#0-decision-summary).

## Reading Guide

- Use the [canonical design](../agent-first-workspace-v1-design.md) for requirements and decisions.
- Use the [roadmap](roadmap.md) for dependency order, deliverables, and exit gates.
- Use the [implementation status](implementation-status.md) for current evidence by canonical
  section.
- Use the [README](../README.md) for the repository's current bootstrap state.
