# ADR-017: Entity Registry and Versioned Generic Stream

- Status: proposed
- Date: 2026-10-11
- Owners: repository maintainers
- Reviewers: persistence, security, and event reviewers

## Context

The shipped Work Item tables and `work-item-v1` event/outbox contracts cannot represent every PM
entity without widening an existing compatibility surface. A generic JSON/EAV model would weaken
domain constraints, while replacing the old stream would invalidate existing consumers.

## Considered options

- Widen the legacy Work Item stream for every entity kind. Rejected because it changes shipped DTO
  and consumer expectations.
- Store all entities as untyped JSON. Rejected because Project, workflow, relation, and ACL
  invariants require normalized constraints and indexed columns.
- Add a registry plus specialized tables and an independent versioned stream. Proposed because it
  preserves compatibility and keeps one stable identity/revision spine.

## Proposed decision

Use a Workspace-scoped `entities` registry for stable identity, kind, optional Space scope,
lifecycle, and current revision. Store immutable versioned snapshots in `entity_revisions`, while
specialized normalized tables own domain state. Restrictive entity ACL narrows Workspace and Space
authority; it never grants authority absent from those scopes.

Publish generic mutations through the independent `entity-v1` event, outbox, job, and inbox tables.
New Work Item commands maintain both streams atomically. Historical events create no delivery jobs,
and the existing `work-item-v1` route, DTO, sequence, and worker remain unchanged.

## Scope and non-goals

This proposal covers the R3/R4 registry, revisions, ACL, event replay, outbox, and compatibility
boundary. It does not approve full event sourcing, network webhooks, agent retrieval, documents,
runtime control, or a phase gate.

## Consequences and verification

Commands must atomically commit current state, revision, event, outbox, and idempotency. Consumers
select a stream version explicitly and remain idempotent. Global replay fails closed unless current
effective authority is complete. Migration, command atomicity, replay, outbox interruption, ACL
non-disclosure, and legacy compatibility tests are required before acceptance.

## Related decisions

ADR-002, ADR-012, ADR-013, ADR-014, and ADR-015 remain independently proposed or accepted as listed
in the registry. Implementation evidence does not change this proposal's status.
