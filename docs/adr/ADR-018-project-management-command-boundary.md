# ADR-018: Project-Management Command Boundary

- Status: proposed
- Date: 2026-10-11
- Owners: repository maintainers
- Reviewers: domain, API, and security reviewers

## Context

R4 introduces Space configuration, workflows/states, labels, Projects, richer Work Items, relations,
comments, Saved Views, and object ACL. Allowing each UI or importer to mutate tables directly would
split revision, authorization, idempotency, and event semantics.

## Considered options

- Resource-specific unversioned CRUD. Rejected because archive, restore, stale writes, and replay
  require explicit command semantics.
- A single untyped command payload. Rejected because unknown fields and cross-resource shapes would
  escape boundary validation.
- A versioned command namespace with one strict envelope and route-specific Zod payloads. Proposed
  because it centralizes transaction semantics without erasing domain-specific contracts.

## Proposed decision

Expose PM writes below `/api/commands/v1/workspaces/:workspaceId`. Every request contains only
`commandId`, `idempotencyKey`, `baseRevision`, and a route-specific `payload`. Create commands require
`baseRevision: null`; later mutations require the current revision. The authenticated Principal
context is the sole actor source, and `actorId` is never accepted in the envelope or payload.

`COMMAND_ROUTES` is the operation registry. Effective mutations append current state, immutable
revision, generic event, and outbox in one transaction. Exact replay returns the original identity;
changed reuse, stale revisions, and invariant violations conflict rather than overwrite.

## Scope and non-goals

This proposal covers the 27 R4 PM/access commands and import command dispatch. It does not approve
R5 planning/documents, R6 runtime/retrieval, client-side authorization, or generic metadata storage.

## Consequences and verification

OpenAPI generation must consume `COMMAND_ROUTES` and each route's `.payload` Zod schema. Tests must
prove strict envelopes, actor exclusion, route coverage, rollback, idempotency, revision conflicts,
ACL non-disclosure, and legacy Work Item compatibility. Passing these local tests does not pass R4.

## Related decisions

ADR-002 and ADR-017 define the revision/event foundation. ADR-019 defines the separate human query
boundary. All remain subject to maintainer review.
