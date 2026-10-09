# ADR-014: Workspace Identity and Authenticated Work Item Boundary

- Status: proposed
- Date: 2026-10-09
- Owners: repository maintainers
- Reviewers: security and persistence checkpoint reviewers

## Context

The durable Work Item slice previously trusted caller-supplied actor IDs and exposed PostgreSQL HTTP
without authentication. R3 requires persistent Workspace identity and a deny-by-default tenant
boundary without claiming the future Space/private-object ACL or OIDC surface.

## Proposed decision

Store normalized Workspaces, global Principals, Workspace Memberships, explicit Work permission
grants, and expiring credentials. Credentials are `afw_` plus 32 random base64url bytes; PostgreSQL
stores only the SHA-256 digest of the complete token. An administrator-only database CLI provisions
identity and prints newly issued tokens once. Runtime Principals cannot receive these general tokens.

Every PostgreSQL `/api` request authenticates before route or body validation. The production store
then revalidates and locks credential, Principal, Workspace, Membership, and required grants inside
the operation transaction. Cross-tenant item access is the same `404` as absence, and list counts
occur only after authorization. The legacy `actorId` field remains required and deprecated; it must
match the authenticated Principal.

Migration tracking records SHA-256 checksums. Legacy checksum backfill is limited to migration 001
at its pinned digest. Migration 002 creates identity data without fabricating legacy memberships.

## Scope and non-goals

This proposal covers the four current Work Item permissions and authenticated PostgreSQL HTTP. It
does not provide OIDC, public token creation, custom roles, Space/private-object ACL inheritance,
Run-scoped runtime credentials, outbox delivery, rate limiting, UI, or full R3 completion.

## Consequences and verification

Credential revocation and permission replacement share a consistent lock order with Work Item
operations. The low-level `PostgresWorkItemStore` remains for persistence tests; PostgreSQL HTTP
always uses the authorized store. Real-database tests cover migration integrity, hash-only tokens,
revocation and disable behavior, grant denial, actor and owner policy, tenant non-disclosure,
rollback, and HTTP authentication ordering.

Authority locking currently serializes authorized operations within one Workspace, including reads,
so page and count remain consistent under READ COMMITTED while administration waits for the same
locks. This is a deliberate correctness-first throughput limitation, not a scalable ACL design.
Credential expiry is checked against the database clock after acquiring those locks. Narrower
locking requires equivalent revocation and snapshot guarantees before replacing this boundary.

## Related decisions

ADR-002 remains accepted. ADR-012 and ADR-013 remain proposed. Full inherited and private ACL work
must preserve this tenant boundary without treating this bounded implementation as that future model.
