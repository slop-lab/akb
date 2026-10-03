# ADR-004: OpenAPI Now, Agent Retrieval Protocol Later

- Status: accepted
- Date: 2026-10-03
- Owners: repository maintainers
- Reviewers: Work Item checkpoint reviewers

## Context

The current Work Item HTTP slice needs a reviewable machine contract. The canonical design also
calls for an agent retrieval protocol, but its snapshots, receipts, cursors, ACL behavior, and
runtime identity dependencies are not implemented in R2.

## Decision

Publish OpenAPI 3.1 for the HTTP surface that exists now: health, Work Item create, read, patch, and
workspace list. Keep runtime schemas in shared Zod definitions. Contract tests structurally compare
the exact representable OpenAPI component and parameter constraints with JSON Schema derived from
those Zod definitions; the patch cross-field requirement is checked explicitly. Stable documented
HTTP statuses and typed envelopes are behaviorally contract-tested against current routes. The
request body is limited to 65,536 bytes. The R2 list is limited to 100 workspace matches and reports
returned, matched, truncation, and budget omissions.

Do not describe the R2 list as the agent retrieval protocol. It has no snapshot or receipt, returns
no continuation cursor, and provides only current-process cards. Agent retrieval remains future R6
work and requires a later compatible expansion of this decision before implementation.

## Alternatives Considered

- Waiting for the complete retrieval protocol was rejected because the current HTTP API still
  needs an accurate contract.
- Inventing snapshot and receipt identifiers for an in-memory list was rejected because it would
  imply provenance and stability that do not exist.
- GraphQL as the primary contract was rejected in favor of the canonical JSON HTTP direction.

## Scope and Non-Goals

This decision does not implement agent retrieval, an automated OpenAPI publishing pipeline from
Zod, authentication, ACLs, pagination, durable snapshots, receipts, delta reads, runtime operations,
or proposals.

## Consequences

- `docs/openapi.json` is reviewed and contract-tested with the current routes and shared Zod
  constraints.
- HTTP errors use canonical codes and documented statuses, including 413 for body budget, 507 for
  in-memory capacity, and 500 for unexpected writable failures.
- Any new route or stable error must update the OpenAPI contract and contract tests.

## Verification

Integration tests exercise current methods, statuses, and errors. The OpenAPI contract test checks
every current path/method/status set, response-schema reference, and exact representable shared Zod
constraint without asserting explanatory prose.

## Related Decisions

ADR-002 defines Work Item revision and store semantics. The retrieval portions of canonical ADR-004
remain deliberately unimplemented until R6 dependencies exist.
