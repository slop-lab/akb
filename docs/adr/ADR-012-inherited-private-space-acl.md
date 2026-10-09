# ADR-012: Inherited and Private Space ACL Before Retrieval

- Status: `proposed`
- Date: 2026-10-09
- Owners: Agent-First Workspace maintainers
- Reviewers: pending

## Context

The authenticated PostgreSQL Work Item slice already requires active identity, active Workspace
membership, and explicit Workspace Work permissions. It needs a bounded Space scope without
claiming the full entity, Project, custom-role, search, or retrieval architecture from the canonical
v1 design.

## Proposed decision

For the current Work Item operations, authorization is:

`active identity AND Workspace permission for the operation AND (unscoped OR public Space OR private Space with an explicit matching Space permission)`.

Space permissions only narrow existing Workspace authority. They never supply a missing Workspace
permission. Workspace owner/admin roles and accountable ownership do not imply private-Space
access. A scoped create additionally requires `work.create` and `work.assign` at both applicable
levels. Its accountable owner must be an active human member with Workspace `work.read` and, for a
private Space, explicit Space `work.read` at creation time.

Current-state reads, lists, counts, and patches apply the Space predicate in SQL before candidate
selection, counting, ordering, and limiting. Inaccessible item reads and patches use the existing
generic Work Item `404`. A create targeting a missing or inaccessible private Space uses a generic
scope `404` without returning a Space identifier.

Workspace event replay keeps its numeric global sequence. Because filtered gaps cannot be exposed
as a stable page contract, replay requires `work.read` for every current private Space before it
returns a page. It then applies the current Work Item scope predicate before `limit + 1` as a
defense-in-depth check. A future restricted-Space replay route needs its own accepted contract; this
proposal does not invent opaque cursors, snapshots, or false completeness.

## Data and compatibility

Migration 004 adds Workspace-scoped Spaces, explicit Space permission rows, and nullable immutable
`space_id` columns for current Work Items, revisions, domain events, outbox events, and delivery
inbox records. Existing rows remain `NULL`; no synthetic Space, grant, or identity is created.
Unscoped JSON continues to omit `spaceId`, and the persisted unscoped create fingerprint remains
byte-for-byte compatible. Scoped commands append `spaceId` to the fingerprint.

Normal authorized operations and Space administration lock the Workspace first. This deliberately
preserves the correctness-first serialization from ADR-014 so a visibility or grant change cannot
race a create or retrieval decision.

## Security and operations

Database-inbox destinations are trusted operator infrastructure, not an end-user retrieval API.
They can receive private-Space events after registration. Revoking a grant cannot retract a copy
already delivered outside the domain transaction. Any future user-facing sink must define and
enforce its own principal-bound authorization contract before registration and delivery.

## Non-goals

- Project participation or object-specific overrides;
- Space leads, Space roles, custom roles, or implicit role grants;
- HTTP Space administration or self-provisioning;
- UI authorization claims, search, graph expansion, summaries, snapshots, receipts, or cursors;
- a restricted-Space event replay route;
- acceptance of this ADR or completion of R3.

## Alternatives considered

Granting owners/admins implicit private access was rejected because it defeats explicit private
isolation. Treating Space grants as additive authority was rejected because a narrow scope must not
create missing Workspace authority. Filtering global event pages was rejected because it leaks gaps
and cannot truthfully preserve the current numeric checkpoint contract.

## Verification conditions

Real PostgreSQL tests must cover legacy `NULL` scope, public and private matrices, role non-bypass,
grant and visibility revocation, SQL-before-limit list/count behavior, replay fail-closed behavior,
idempotent retry authorization, immutable scope, cross-Workspace constraints, and scope propagation
through revisions, events, outbox, and inbox. Native HTTP and administrator CLI paths must also be
exercised against a migrated database.

## Related decisions

ADR-002 remains accepted. ADR-004's current HTTP contract remains accepted. ADR-013, ADR-014,
ADR-015, and this ADR remain proposed.
