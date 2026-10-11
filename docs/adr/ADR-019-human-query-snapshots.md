# ADR-019: Human Query Materialized Snapshots

- Status: proposed
- Date: 2026-10-11
- Owners: repository maintainers
- Reviewers: query, security, and web reviewers

## Context

Mutable Project and Work ordering can create duplicates or omissions during long list, board, and
search traversal. Offset pagination cannot bind results to authority changes, and exposing database
positions would leak implementation details.

## Considered options

- Offset pagination over current rows. Rejected because concurrent edits move membership and order.
- Stateless keyset cursors only. Rejected because authorization and ranking changes can still alter
  later pages.
- Bounded materialized membership plus signed cursors and per-page reauthorization. Proposed because
  it freezes membership/order while preserving current denial semantics.

## Proposed decision

Materialize authorized entity IDs, source revisions, group keys, and ordinals in transient Human
Query snapshots. Limit snapshots to 100,000 members, 250,000 active rows per Workspace, eight active
snapshots per Principal, and 15 minutes. Query pages are 1-100; board columns are 1-25.

HMAC cursors bind snapshot position/group, Principal, credential, Workspace, normalized query and
sort, page size, authority hash/epoch, and expiry. Every continuation revalidates identity,
authority, snapshot ownership, expiry, and page entity ACL. Clients explicitly release abandoned
snapshots through the authenticated `DELETE .../query-snapshots/:snapshotId` route, which returns
`204` without disclosing ownership.

## Scope and non-goals

This proposal covers Project, Work Item, board, and paged lexical search snapshots. It is not the R6
agent snapshot/receipt protocol, a durable audit artifact, an authorization cache, or a phase gate.

## Consequences and verification

Transient rows require bounded cleanup and must be cleared during recovery quarantine. Tests must
cover 100,000-member traversal, concurrent updates, cursor tampering, credential and authority
changes, expiry, release ownership, ACL filtering before counts/ranking, and no persistence on
budget rejection. Parent-owned live/browser evidence remains separate.

## Related decisions

ADR-012 and ADR-017 define authorization and entity identity. ADR-018 owns writes. This proposal
remains unaccepted until reviewed.
