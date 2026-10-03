# ADR-002: Current State Plus Revision and Event

- Status: accepted
- Date: 2026-10-03
- Owners: repository maintainers
- Reviewers: Work Item checkpoint reviewers

## Context

The first Work Item slice must reject stale writes, preserve inspectable history, and describe each
semantic mutation without requiring full event sourcing. Storage adapters must remain substitutable.

## Decision

Keep a current Work Item value for reads. Each effective create or patch consumes exactly one
immutable revision/event record pair, and revision history is never evicted. A patch requires a
base revision. A patch whose requested values already equal current state is successful but
unchanged: it returns the current value and creates no clock, identifier, revision, history, or
event activity. Creation idempotency is scoped by the tuple of workspace ID and idempotency key,
not by a concatenated string.

The application owns the `WorkItemStore` port. The current in-memory adapter implements it with a
hard default capacity of 10,000 current Work Items and a separate hard default capacity of 100,000
audit records. A create is admitted only when both its item and audit-record budgets are available;
an effective patch is admitted only when its audit-record budget is available. An exhausted
applicable budget rejects the command before any current-state, history, event, idempotency, clock,
or ID mutation. HTTP maps the result to `507 budget_exceeded` with a truthful `resource` of `items`
or `audit_records` and the configured `capacity`.

The current adapter performs each command all-or-nothing in memory behind `WorkItemStore`.
PostgreSQL-backed repository and unit-of-work ports, database transactions, and outbox atomicity
remain R3 work.

## Alternatives Considered

- Full event sourcing was rejected because the first slice needs current reads and audit evidence,
  not event replay as the sole source of state.
- Current-state-only storage was rejected because it cannot prove revision history or event
  semantics.
- Adapter-owned interfaces were rejected because they reverse the intended dependency direction.

## Scope and Non-Goals

This decision covers the Work Item store contract and in-memory behavior. It does not accept a
PostgreSQL schema, outbox, authentication, ACL model, distributed transaction, or production
durability claim.

## Consequences

- Command results are exhaustive typed variants, including unchanged and capacity failure.
- Effective mutations update current state, history, and events as one in-memory operation.
- Capacity rejection does not evict history, reserve an idempotency key, advance the clock, or
  allocate an item or event ID.
- A future durable adapter must commit current state, revision, event, and outbox atomically.
- Process restart intentionally loses all current in-memory state.

## Verification

Store and black-box HTTP tests cover stale writes, semantic no-ops, idempotency tuple collisions,
both finite capacities, pre-mutation rejection, truthful HTTP capacity details, adapter
substitution, event/history behavior, and restart loss.

## Related Decisions

ADR-004 defines the current HTTP/OpenAPI contract. ADR-001 and ADR-005 remain proposed.
