# ADR-015: Transactional Outbox and Workspace Event Replay

- Status: proposed
- Date: 2026-10-09
- Owners: repository maintainers
- Reviewers: persistence and security checkpoint reviewers

## Context

The PostgreSQL Work Item slice already commits current state, revision history, and semantic events
atomically. R3 also requires interruption-safe post-commit delivery and authenticated event replay.

## Proposed decision

Migration 003 installs an `AFTER INSERT` trigger on `domain_events`. It copies only the bounded
semantic event projection into immutable outbox storage and creates jobs for active workspace-scoped
destinations in the same transaction. Destination registration and trigger fanout use the same
workspace advisory lock. Registration records the existing maximum sequence as its historical
cutoff; migration and registration do not backfill old events or invent identity.

The worker claims only the minimum undelivered sequence for one workspace and destination. It
commits a 30-second lease before sink I/O, writes the durable database inbox separately, and
acknowledges separately using owner, generation, and unexpired-lease fences. Inbox uniqueness makes
delivery at-least-once and duplicate-safe, not exactly-once. Retry uses bounded exponential delay,
five attempts, a blocking dead-letter head, and explicit scoped operator retry. A drain processes at
most 100 jobs and exits when the head is ineligible. The CLI always emits its JSON run summary and
exits nonzero if any claimed job failed or did not reach a fenced acknowledgement.

Authenticated replay uses a fresh READ COMMITTED transaction per page. It rechecks credential and
workspace authority and holds the `work.read` grant share lock before selecting candidates.

## Scope and non-goals

The only sink is the local durable database inbox. Arbitrary HTTP destinations, network webhooks,
exactly-once claims, historical backfill, UI, full production operations, and Space/private-object
ACL inheritance are excluded. Snapshot, receipt, and cursor objects are not introduced.

## Consequences and verification

A dead-lettered head blocks later delivery until explicit retry. Expired leases are reclaimable,
stale owners cannot finalize newer generations, and a committed inbox insert followed by a lost
acknowledgement is safe to repeat. Event payloads contain no tokens, credentials, or request bodies.
Real PostgreSQL tests cover cutoffs, ordering, fencing, lost fences, process exit status,
deduplication, pagination, and revocation.

## Related decisions

ADR-002 is accepted. ADR-012, ADR-013, and ADR-014 remain proposed. This checkpoint leaves R3 in
progress and does not establish the future webhook or full ACL architecture.
