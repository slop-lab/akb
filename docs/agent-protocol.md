# Agent Retrieval and Runtime Protocol Contract

## Status

This document defines planned contracts for agent retrieval, runtime control, proposals, and
reviews. None of these agent surfaces is implemented by the current bounded Work Item HTTP slice.
The current workspace list is not agent retrieval and intentionally has no snapshot or receipt.
Field names and transport schemas remain subject to approved ADRs, but implementations must preserve
the semantics below. The [canonical v1 design](../agent-first-workspace-v1-design.md) is authoritative
when this summary is incomplete.

Human and agent surfaces will share domain, authorization, and query semantics. They will not share
response projections: human APIs optimize for interaction, while agent APIs must make budget,
omission, snapshot, and provenance explicit.

## Identity and authority

The protocol keeps these identities distinct:

- the accountable owner, which is zero or one human;
- the installation delegated to the work;
- the immutable agent definition revision selected by that installation;
- the runtime executing a particular Run generation;
- the requester that initiated the Run.

A runtime acts as the Run-scoped principal, not as the owner or a workspace administrator. A Run
token conveys only the grants listed in its policy snapshot and capability set. A child Run receives
no authority merely because its parent has it.

## Progressive retrieval

Agent reads progress through four projections:

| Level | Projection | Contract |
| --- | --- | --- |
| 0 | `ref` | Stable ID, kind, title, revision, state, and estimated tokens. |
| 1 | `card` | Summary, selected properties, relation preview, freshness, and expansion selectors. |
| 2 | `detail` | Selected fields, sections, relations, changes, and provenance. |
| 3 | `raw` | Canonical block tree or Markdown, evidence, activity range, or artifact chunks. |

A summary, card, preview, or derived representation must identify its source revision and must not
claim to be the complete or canonical source. Expansion occurs through stable entity, block,
activity-sequence, symbol, or artifact-range anchors, never unstable rendered line numbers.

Every list, search, context, traversal, and expansion response must include this logical envelope:

```text
snapshotId
items
completeness { returned, matched: number | unknown, truncated }
omitted [{
  category,
  count: number | unknown,
  reason: budget | projection | permission | filter | too_large,
  expansionHandle?
}]
nextCursor?
estimatedTokens
receiptId
warnings
```

The envelope fields have mandatory semantics:

- `returned` is the number of serialized top-level items in this response.
- `matched` is the total number of authorized matches for the bound query when safely and
  efficiently knowable; it is `unknown` when calculation is unavailable or the count could reveal
  inaccessible data.
- `truncated` is true whenever more authorized material matched than this response returns because
  of pagination, projection, depth, item, token, or size constraints.
- `omitted` accounts for material excluded from the representation. Permission-sensitive entries
  use non-revealing categories and `unknown` counts; they must not disclose existence, titles, IDs,
  or cardinality. An expansion handle is returned only when the caller may use it.
- `nextCursor` continues the same ordered snapshot. Its absence means there is no next page for
  that response, not that a card or summary contains all underlying source content.
- `estimatedTokens` estimates the serialized response for the declared tokenizer/profile. It is
  distinct from byte size and must be calculated before crossing an item or block boundary.
- `receiptId` identifies the durable record of what revisions and projections were read.
- `warnings` reports conditions such as index lag, stale summaries, or degraded retrieval without
  hiding incompleteness.

Budget enforcement must cut only at item or block boundaries. Oversize objects are omitted with
`too_large` and a permitted expansion or chunk handle rather than silently truncated inside a
semantic unit. Bootstrap context returns the objective and constraints, relevant cards with
reasons, guidance revisions and precedence, expansion handles, omissions, and snapshot. It must not
inject an entire workspace prompt.

## Snapshot, cursor, and receipt semantics

A `snapshotId` binds a read to a stable authorized view and revision set. All pages in one cursor
chain use that snapshot so inserts, deletes, and reordering do not create duplicates or omissions.
Requesting `latest` starts a new snapshot; it never mutates an existing snapshot.

A cursor is opaque, signed, expiring, and bound to principal/access fingerprint, workspace,
snapshot, query hash, ordering, last key, and projection or budget constraints. Clients must not
construct or edit it. A mismatched cursor returns `cursor_invalid`. Expiry returns
`snapshot_expired` plus a safe restart handle; the server must not silently continue against current
state. Offset pagination is prohibited.

A receipt records the receipt ID, optional Run, principal, snapshot, query hash, objects read as
reference/revision/projection/block IDs, summaries read as summary/source/profile revisions,
creation time, and retention policy. Receipts establish provenance, not authorization: replay,
delta, and inspection re-evaluate current access. A delta request supplies scope, `sinceReceipt`,
kinds, and projection and returns changed objects with from/to revisions and changed fields,
created and deleted objects, new relations, and `nextReceipt`. Revoked access must not appear in a
delta, including through counts or tombstone details.

## Planned retrieval operations

The planned read surface includes `resolve_refs`, `search_entities`, `read_entities`,
`expand_entity`, `traverse_relations`, `query_view`, `read_changes`, `read_activity`,
`read_artifact`, and `get_run_context`. Query operations accept scope, kinds, filter, projection,
and budget. Traversal additionally binds source, relation type, direction, depth, and snapshot.

The authorization rule in [Security and Quality](security-and-quality.md) applies before candidate
generation, graph expansion, summarization, embedding, ranking, and counts. Search explanations may
report lexical, semantic, or relation match methods, matched blocks, relation paths, score, and
selectors only for authorized material.

## Runtime discovery and Run start

A future runtime endpoint advertises protocol version, push and/or pull mode, supported agent roles,
activity kinds, concurrency, heartbeat behavior, upload support, authentication method, and health.
Capability negotiation fails closed: an unknown protocol version, unsupported required activity,
or missing required capability prevents dispatch rather than degrading authority or semantics.

Delegation creates a Session and queued Run, issues a scoped credential, sends a small `RunStart`,
waits for lease acknowledgment, and only then provides bootstrap context. `RunStart` carries:

```text
runId
installationId
subjectRef
directiveRef
bootstrapHandle
callbackBaseUrl
runToken
leaseExpiresAt
protocolVersion
```

Push webhooks and pull long-poll or streaming transports must have identical message,
idempotency, ordering, acknowledgment, cancellation, and recovery semantics. Messages carry stable
IDs or idempotency keys; duplicate delivery must not duplicate activity, artifacts, proposals, or
state transitions.

## Lease and generation

A lease identifies its Run, owner, generation, issue and expiry times, and heartbeat deadline. The
runtime must acknowledge the lease before execution and heartbeat while active. Lease expiry moves
the Run to `stale`; it is not implicit authorization for another runtime to reuse the old token.

Resume or reassignment increments the lease generation and issues new credentials. Every runtime
write, heartbeat, upload completion, signal response, and state transition carries the active
generation. The server atomically rejects messages from an expired lease or older generation with
`run_not_active`, even if their idempotency key was not previously seen. Late messages may be
retained as restricted trace evidence but cannot mutate canonical Run or domain state.

Cancellation moves an active Run through `cancel_requested` to `canceled`, blocks issuance of new
capabilities, propagates a cancellation token to bounded child Runs, allows a policy-defined grace
period, and records durable canceled activity. Cancellation and lease loss must be safe under retry.

## Capabilities and secrets

The Run token permits only authorized context reads, the Run's own activity and artifacts,
proposal and input operations, and explicitly granted capabilities. It is short-lived and scoped to
the Run, installation, workspace, generation, actions, and resources. The system must never issue a
long-lived general workspace write token to a runtime.

Additional authority is requested through an `authorize_capability` signal and remains unavailable
until policy or an authorized reviewer approves it. Capability grants are least-privilege,
time-bounded, auditable, revocable, and generation-bound. Secret use follows capability request ->
run/project/resource policy -> brokered operation or constrained short-lived credential -> audit.
Raw secrets are not placed in retrieval context, prompts, activity, artifacts, or the runtime
environment by default.

Each Run pins a policy snapshot containing the agent definition revision, runtime version, guidance
revisions, grants, network and tool policy, approval policy, and secret-broker policy. Historical
Runs are interpreted using that snapshot, not current settings.

## Activity, artifacts, and plans

Semantic activity is distinct from raw provider transcripts, tool I/O, terminal output, and usage.
Durable facts, choices, questions, outputs, verification, errors, and outcomes remain semantic
activity. Raw material is stored as chunked artifacts with separate permissions and retention.

A Plan is a shared, revisioned commitment, not private chain-of-thought. Plan steps have stable IDs,
dependencies, statuses, result references, and command/event semantics. Runtime messages may report
plan and progress but may not use hidden reasoning as canonical evidence.

## Proposal and review semantics

The planned write surface includes `create_work_item`, `patch_entity`, `append_comment`,
`append_activity`, `update_plan_step`, `create_proposal`, `request_review`, `publish_artifact`,
`delegate_run`, `answer_signal`, and `complete_run`. Important writes carry `baseRevision` or
`If-Match`. A conflict returns expected and actual revisions, a change summary, and the recovery
choices `reload_and_rebase`, `create_conflicting_proposal`, or `cancel`.

A Proposal is a candidate change against an explicit target and base revision. Creating, editing,
or approving a Proposal does not by itself make its content canonical. Comments and activities are
conversation, artifacts are outputs, and proposals are candidates; only a successfully committed
entity revision is canonical.

High-risk agent changes must use a Proposal. This includes accepted Claims, superseding Decisions,
security, permission, and guidance changes, and multi-relation changes unless a later accepted
policy is stricter. Policies may explicitly auto-accept bounded low-risk changes such as typo,
link, keyword, or derived-summary updates, while preserving revision and audit records.

A Review is pinned to the exact Proposal, artifact, Run, update draft, or knowledge revision it
evaluates. It records reviewer, evidence, subject revision, comment, decision time, and one state:
`pending`, `approved`, `rejected`, `changes_requested`, or `dismissed`. A subject revision change
immediately makes prior approval stale; stale review cannot authorize application.

Approval authorizes an apply command but does not bypass current ACL, policy, base-revision, or
transaction checks. Apply rechecks the target revision and commits the canonical mutation,
revision, event, and outbox atomically. A changed target produces `revision_conflict`; it is never
silently overwritten. `changes_requested` returns the candidate for revision, `rejected` records a
negative decision, and `dismissed` closes a no-longer-applicable review. All retain evidence and
history according to policy.
