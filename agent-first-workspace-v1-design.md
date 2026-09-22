# Agent-First Collaboration, Knowledge, and Small-Project Management System

> Status: canonical English v1 design baseline; planned, not implemented.
> Original design date: 2026-09-01. Repository transcription: 2026-09-22.
> Source: the full plan supplied by the project owner.
> This document preserves the requirements in sections 0-28 of the condensed Korean
> transcription. Repeated explanation and illustrative TypeScript/SQL from the original
> plan remain intentionally condensed. A design statement is not evidence of working code.
> Decisions that refine the schema or resolve open questions must be recorded separately;
> this draft must not be treated as an approved ADR.

## 0. Decision Summary

The product is not an issue tracker with AI attached. It combines four layers:

```text
Typed work graph
+ versioned knowledge
+ human/agent collaboration
+ progressive retrieval and runtime control
```

| Area | Decision |
| --- | --- |
| Central unit | Entity + Revision + Relation + Thread + Run |
| Project management | Support a small team's daily work without an external tracker |
| Knowledge | Model Page, Claim, Decision, Evidence, and other structured objects |
| Agent reads | Use explicit budget, omission, and snapshot semantics, separate from the human UI API |
| Writes | Route important agent changes through Proposals and reject stale writes with revision preconditions |
| Storage | Use a shared Entity registry plus normalized tables for core domains |
| History | Record current state plus append-only revisions/events in the same transaction; do not require full event sourcing |
| Documents | Make a Markdown-compatible block tree with stable block IDs canonical |
| Execution | Connect an independent runtime through run-scoped capabilities |
| Extensibility | Prefer declarative schemas/views/actions and out-of-process extensions; defer a stable internal ABI |
| Deployment | Use a PostgreSQL-centered modular monolith, worker, and object storage |

Linear informs the team/workflow/cycle/project/view hierarchy, fast list/board/peek
interaction, separation of human assignee and agent delegate, application actors, structured
activity, cursor pagination, server-side filters, and webhooks. Plane informs work-item
types/properties, cycles/modules/milestones, Pages/Wiki, intake, roles and permissions, and
extension surfaces.

Out of scope for v1: enterprise portfolio/budget/capacity management, CRM/helpdesk/SLA,
complex approval builders, complete Jira compatibility, native mobile applications,
built-in chat or video, GitHub-class code review, general-purpose BI builders, and making
real-time collaborative editing a release prerequisite.

## 1. Product Definition

The planned product is a self-hostable collaboration space in which people and agents read
and modify the same work and knowledge graph. Agents retrieve only what they need while the
system tracks execution, evidence, and proposed changes.

- The primary agent user can discover the system without UI automation; bootstrap a task;
  progressively expand refs, cards, sections, and raw content; traverse relations; record
  plans, activity, questions, artifacts, and verification; propose changes; participate in
  review and handoff; record read revisions/snapshots; and resolve stale conflicts by rebase.
- A human can create, classify, and plan work; use list, board, and timeline layouts; discover
  documents and evidence; delegate execution; inspect execution input; answer questions;
  approve or reject proposals and artifacts; and preview search results.
- Extension developers and operators can manage types, relations, fields, lenses, runtimes,
  webhooks, automations, permissions, retention, model providers, secret capabilities, and
  schema/protocol upgrades.
- The product addresses oversized context, hidden omission, stale overwrites, confusion of
  comments with canonical truth, raw-log pollution of activity feeds, ambiguous agent
  responsibility/authority/version/retry semantics, and disconnected decisions and execution.

## 2. v1 Scope and Completeness

The v1 goal is to complete intake -> work organization -> project/cycle planning ->
delegation -> execution/discussion/documentation -> review/completion -> retrospective
without an external issue tracker. It does not aim for feature-count parity with Linear or
Plane.

| Area | Core | Complete | Later |
| --- | --- | --- | --- |
| Workspace | Invitations, roles | Private scopes, agent/service principals, audit | SSO, SCIM, custom roles |
| Space | Members, identifier, workflow | Simple hierarchy, project groups | Multi-level organization |
| Project | Owner, state, dates, participating spaces | Health, updates, milestones, progress, templates | Portfolio, capacity |
| Work | CRUD, state, priority, owner, label, date | Type, estimate, parent, relation, attachment, draft, archive | Billing, SLA |
| Planning | Cycle | Rollover, milestone, module, timeline | Capacity, release trains |
| Views | List, board, filter, sort, group | Saved views, timeline, visible fields, sharing | Formula, dashboard |
| Intake | Manual inbox | External/agent submissions, accept/decline/defer/duplicate | Public form, email portal |
| Knowledge | Pages and blocks | Nested pages, inline comments, Claim, Decision, Evidence, relations | Office suite, whiteboard |
| Collaboration | Comments, mentions, activity | Subscribers, reactions, review, presence | Chat, video |
| Search | Title, body, property | Lexical + semantic + graph search and expansion | Federation |
| Agent | Actor, delegate, run, activity | Snapshot, receipt, proposal, review, cancel, artifact | Marketplace |
| Notifications | In-app | Grouping, preferences, email, webhook | Mobile push |
| Analytics | Count, progress | Trend, throughput, lead time | Arbitrary BI |
| Automation | Webhook | Trigger-condition-action, schedules, run agent | Visual builder |
| Integration | Generic API/webhook | GitHub, import, export | GitLab, Slack, Sentry |
| Operations | Compose, backup | Migration, observability, retention | HA, multi-region |

Required end-to-end scenarios:

- **A. Ordinary project:** Set owner, objective, and target date -> add work from multiple
  spaces -> place backlog work in a cycle and move it on a board -> inspect milestone progress
  and blockers -> publish an update with a metric snapshot -> archive while preserving links.
- **B. Delegation:** Keep a human owner and add a delegate -> provide a small bootstrap and
  handle -> read only required sections -> record plan/activity -> enter `awaiting_input`,
  answer, and resume -> publish artifact/proposal -> review receipt/evidence -> verify base
  revision conflicts before approval.
- **C. Knowledge promotion:** Turn an observation into a Claim/Decision proposal carrying
  evidence and target revision -> review -> update the canonical revision and relations ->
  include accepted knowledge in default search -> retain the superseded conclusion and reason.
- **D. Retrieval:** Return a blocker card within budget -> disclose matched/omitted/cursor/
  snapshot/receipt -> expand selected relations or sections -> paginate a stable snapshot
  without duplicates or omissions -> retrieve only the delta after a receipt in a later run.

## 3. Core Principles and Invariants

1. Human and agent surfaces share canonical domain, authorization, and query semantics, but
   use separate human projections and agent budget/projection contracts.
2. Every first-class object has a stable ID and revision. Display keys are aliases. Every
   write supplies `baseRevision` or `If-Match`. Blocks, comments, relations, plan steps, and
   activities also have independent IDs.
3. Every agent list, search, or context response reports returned count, matched or estimated
   total, truncation, omitted categories, next cursor, snapshot, estimated size, and receipt.
   A summary must never masquerade as the complete source.
4. Mutable current state is distinct from immutable `ContextSnapshot` and `InputSnapshot`.
5. Accountable owner (human), delegate (installation), executing actor (agent revision/runtime),
   and requester are distinct roles.
6. Comments and activities are conversation; artifacts are outputs; proposals are candidates.
   Only an accepted revision is canonical.
7. Generic JSON/EAV must not replace core work, project, cycle, assignment, or workflow constraints.
8. Current-state mutation, revision, event, and outbox record are committed in one transaction.
9. ACL checks precede candidate generation, graph expansion, summarization, embedding, and ranking.
   Existence, titles, and counts must not leak. Summary caches include scope and ACL fingerprints.
10. Title-only creation, inline editing, peek, keyboard operation, and command APIs come first;
    advanced features use progressive disclosure.

## 4. Conceptual Model

A Workspace contains Spaces (workflows, types, items, cycles), Projects (spaces, milestones,
modules, pages, updates, items), Knowledge, Collaboration, Agents, and Views/Lenses.

| Object | Responsibility and constraint |
| --- | --- |
| Workspace | The sole tenant boundary for every object |
| Space | Persistent team/work area with workflow and identifier; each item belongs to exactly one Space |
| Project | Finite outcome that can include items from multiple Spaces |
| WorkItem | Executable work with workflow state, human owner, and optional project |
| Cycle | Space-owned timebox; an item has at most one cycle in its Space |
| Milestone | Ordered, dated, project-local stage |
| Module | Non-exclusive, many-to-many, project-local grouping |
| Page | Long-form context with a stable block tree and revisions |
| KnowledgeObject | Structured knowledge with schema version and provenance |
| Relation | Typed edge with actor, revision, and optional evidence |
| Thread | Durable discussion represented by a comment sequence |
| Session / Run | Collaboration goal / one execution with fixed lease, policy, and context |
| Activity / Artifact | Semantic progress / digest-addressed output with provenance |
| Proposal / Review | Candidate change against a base revision / decision pinned to subject revision and evidence |
| View / Lens | Saved query + layout / query + projection + budget |

Responsibility cardinalities are: `accountableOwner` 0..1 human; `participants` 0..N human or
service principals; `delegations` 0..N installations; `reviewers` 0..N humans or agents; and
`subscribers` 0..N principals. Space and Project remain separate because a Space represents
persistent responsibility while a Project represents a finite cross-functional outcome.

## 5. Project Management Requirements

### 5.1 Workspace and Membership

Support workspace creation, update, and archive; invite/join/leave/deactivate; timezone,
locale, and notification preferences; workspace search, views, knowledge, and agent registry;
and activity/audit history. Principal kinds are `human`, `agent`, `service`, and `runtime`.
Roles are Workspace owner/admin/member/guest, Space admin/member/viewer, Project
lead/member/viewer, plus object inheritance and explicit sharing. An installation declares
allowed scopes, spaces, projects, and actions. A custom-role builder is deferred.

Permission atoms include `project.read`, `project.manage`, `work.read`, `work.create`,
`work.update`, `work.assign`, `knowledge.read`, `knowledge.propose`, `knowledge.accept`,
`run.delegate`, `run.inspect`, `review.decide`, and `admin.integrations`.

### 5.2 Space

A Space has name, key, icon, description, public/private visibility, lead, members, workflow,
allowed types, cycle configuration, templates, and guidance. Its home surfaces pinned pages,
views and projects; active/backlog/completed work; current cycle; recent updates; blockers;
and agent instructions.

### 5.3 Project

Project fields are `id`, `workspace`, `name`, `slug`, `summary`, `descriptionContentId`, `owner`,
`leadIds`, `participatingSpaceIds`, `state`, `health`, `priority`, `start`, `target`, `completed`,
`archived`, and `revision`.

- `state`: `planned | active | paused | completed | canceled`
- `health`: `on_track | at_risk | off_track`
- `priority`: `none | low | medium | high | urgent`

The overview includes description, owner, spaces, status, health, dates, priority, progress,
scope changes, milestones, documents, links, updates, blocked/high-priority work, runs, reviews,
and work list/board/timeline. `ProjectUpdate` stores health, body, author, time, and a snapshot of
total/completed/estimated/blocked metrics at publication time. Progress is estimate-weighted
only when every included item has an estimate; otherwise it is count-based. Canceled work is
excluded from the denominator. Leaf-only or an explicit rollup policy prevents parent/child
double counting, and scope changes are displayed separately.

### 5.4 Work Item

A WorkItem contains workspace, space, optional project, key, type, title, description, state,
category, priority, owner, participants, delegates, labels, estimate, start/due dates, cycle,
milestone, modules, parent, relations, links, attachments, artifacts, subscribers, comments,
activity, and created/updated/completed/archived timestamps.

Default types are `Task`, `Bug`, `Feature`, `Research`, `Decision task`, and `Maintenance`.
A type definition contains key, name, icon, schema version, allowed workflows, default workflow,
field definitions, required fields, template, and retrieval profile. Supported custom fields are
short/long text, number, boolean, date/datetime, single/multi-select, principal/entity reference,
and URL. Formula, script, and cross-record rollup fields are excluded from v1.

Creation supports title-only input, defaults inferred from the current filter, `C`, quick
composer, and API. Drafts and templates autosave. Duplicate detection makes suggestions only.
A parent must be in the same workspace; matching projects are recommended, not required.
Inheritance is field-specific; child completion changes a parent only through automation;
rollup policy is explicit.

Relation types and inverses are `parent_of/child_of`, `blocks/blocked_by`, `related_to`,
`duplicates/duplicated_by`, `implements/implemented_by`, `verifies/verified_by`,
`supports/supported_by`, `contradicts/contradicted_by`, `supersedes/superseded_by`, and
`generated_by/generated`. Workflow categories are `backlog | unstarted | started | completed |
canceled`; a workflow defines ordered states, a default, optional transitions, and hooks. WIP
limits are deferred. Priority uses the five values and ordering defined for Project.

Archive is not completion: links, revisions, and searchability remain. Deletion is soft delete,
then retention, then purge. Relation tombstones remain, and agent reads explicitly state whether
archived and deleted objects are included.

### 5.5 Cycle

A Space-owned Cycle has name, sequence, start, end, status (`upcoming | active | completed |
archived`), goal, capacity hint, and rollover policy. The default permits one active cycle,
creates an upcoming cycle, and supports automatic or reviewed rollover of incomplete work,
optional automatic inclusion of started work, an end-of-cycle metric snapshot, board/list and
burn-up or burndown, and a policy for work removed from the cycle. Metrics distinguish committed,
added, and removed scope; completed count/estimate; carry-over; average lead time; and blocked duration.

### 5.6 Milestone and Module

A Milestone has project-local order, name, description, target date, progress, overdue state,
and timeline; each item has at most one milestone. A Module is a project-local many-to-many
group with owner, date, and status and can span cycles. These concepts must not collapse into
one tag.

### 5.7 Intake

An intake record contains `source` (`human | agent | integration | import`), `sourceRef`,
`submitter`, `targetSpace`, `title`, `body`, `state` (`new | clarifying | accepted | declined |
deferred | duplicate`), `suggestedDestination`, `convertedWorkItem`, `duplicateOf`, and `revision`.
Accept converts to work or a knowledge proposal; decline requires a reason; defer supports a
snooze date/event; duplicate links to the original; clarification permits follow-up questions.
Agents can submit bugs, contradictions, and omissions. Owner rotation is deferred to later or
implemented by automation.

### 5.8 Views and Lenses

`SavedView` stores scope, object kinds, filter AST, sort, group, layout, visible fields, access
(`private | space | workspace`), owner, and revision. List supports inline fields, tree display,
column show/hide/reorder, keyboard/bulk actions, and virtualization. Board supports grouping by
state, priority, owner, cycle, milestone, or select field; drag mutation; collapsed groups; and
count/estimate totals. Timeline shows project/milestone/module/item dates, dependencies, zoom,
an unscheduled tray, and date dragging. Calendar follows timeline at lower priority; table remains
part of the layout contract. A Lens combines the same query with projection (`ref | card | detail |
custom`), expansions, `maxItems`, `maxTokens`, `maxDepth`, summary policy, and freshness
(`latest | snapshot`).

### 5.9 Templates and Recurring Work

Project, work, page, and agent-task templates include type, fields, labels, relations, checklist,
and guidance, not only body text. Created objects reference the exact template revision used.
Recurrence supports daily, weekly, monthly, and cron schedules; advance creation; template-based
instances; `skip | create | merge` handling of prior incomplete work; and explicit timezone.
Complex calendar rules are excluded.

### 5.10 Analytics

Humans and agents use the same aggregate query semantics. Metrics include project/cycle
completion, committed/added scope, throughput, lead/cycle time, carry-over, overdue/blocked work,
owner/type/label/project distributions, run success/failure/`awaiting_input`, and proposal
acceptance. Fixed metrics and view-sidebar insights precede arbitrary analytics.

## 6. Document and Knowledge System

`ContentDocument` contains `id`, `rootBlockIds`, `schemaVersion`, and `currentRevision`.
`ContentBlock` contains `id`, `type`, `attrs`, `inline`, and `children`. Block types are
`paragraph`, `heading`, `list`, `list_item`, `code`, `quote`, `table`, `callout`, `entity_embed`,
and `artifact_embed`. A Markdown-compatible subset supports lossless import/export. Stable block
IDs remain in storage and are not exposed as HTML comments. Reads and patches can target blocks
or sections. The UI offers WYSIWYG and Markdown source views; rich embeds export with stable
directive syntax.

A Page is a wiki or project page with nested parent, title, icon, labels, content revision,
owner, access, inline comments, backlinks, and archive state. Use optimistic concurrency, block
patches, and visible conflicts. Implement presence, autosave, history, and restore first; add
Yjs/CRDT only if needed, and do not make every object a CRDT.

| Type | Required semantics |
| --- | --- |
| Claim | Statement; `proposed | accepted | disputed | rejected | superseded`; confidence; validity scope; supporting/contradicting evidence; reviewed at/by |
| Decision | Decision, context, alternatives, rationale, consequences; `proposed | accepted | superseded | reversed`; owner, review date, applies-to |
| Evidence | Source type/ref/artifact, observation, captured at/by, reliability, validity |
| Question | Question; `open | investigating | answered | abandoned`; owner, delegates, accepted answer |
| Experiment | Hypothesis, method, inputs, runs, results, conclusion |

Use a generic schema registry with default UI and retrieval profiles. Promotion flows from
observation/conversation/run -> `KnowledgeProposal` -> accept as a new revision, request changes,
or reject. Policy may auto-accept typo, link, keyword, and derived-summary changes. Accepted
claims, superseding decisions, security/permission/guidance changes, and multi-relation changes
require review.

`DerivedSummary` contains `subject`, `sourceRevision`, `profileId`, `profileRevision`, `generator`,
`content`, `tokenCount`, `createdAt`, and `staleAt`. Source changes mark it stale and trigger
regeneration. It is distinct from user-authored summaries and must never be a source of truth.

## 7. Human-Agent Collaboration

Every Principal has common `id`, `workspace`, `displayName`, and active/disabled state.
`AgentDefinition` is a logical kind with immutable revisions, roles, lenses, and required
capabilities. `Installation` pins a definition revision and records workspace, runtime endpoint,
scopes, grants, mentionable/delegatable flags, and enabled state. Runtime is the execution
implementation and remains independent of definition.

Thread (discussion), Session (goal), Run (orchestration), and Attempt (retry/branch) are distinct.
v1 starts with Run plus `parentRunId`; every retry is an explicit separate run.

```text
queued -> preparing -> running <-> awaiting_input
running -> verifying -> review_required -> completed
running/verifying -> failed
active -> cancel_requested -> canceled
lease expiry -> stale -> valid resume -> running
```

Activity kinds are `progress`, `observation`, `action.started`, `action.completed`, `question`,
`input.received`, `plan.changed`, `artifact.produced`, `verification`, `proposal.created`,
`handoff`, `warning`, `response`, and `error`. The envelope is `id`, `runId`, `sequence`, `kind`,
`actorId`, `durable`, `createdAt`, `body`, `references`, `rawTraceRefs`, and `idempotencyKey`.
Ephemeral progress can be replaced, compacted, or retained as short-lived trace. Durable facts,
choices, questions, outputs, verification, errors, and outcomes are retained.

A Plan is a shared commitment, not private chain-of-thought. Each step has `id`, `runId`,
`parent`, `title`, `status`, `dependsOn`, `resultRefs`, and `revision`. Status is `proposed |
ready | running | blocked | completed | failed | canceled`, and each step has command/event semantics.

Signals are `stop`, `confirm`, `select`, `authenticate`, `authorize_capability`, `upload`, `review`,
`resolve_conflict`, and `handoff`. Stop propagates a cancellation token, blocks new capabilities,
terminates the process after a grace period, propagates to children, and records canceled activity.

Artifact fields are `id`, `workspace`, `mediaType`, `kind` (`file | diff | report | log |
test_result | screenshot | dataset`), `digest`, `byteSize`, `storageRef`, `run`, `sourceRefs`,
`summary`, `retentionClass` (`durable | run_trace | temporary`), and `createdAt`. Large raw logs
are chunked artifacts. Review subjects can be proposals, artifacts, runs, update drafts, or
knowledge revisions. A Review records reviewer, state (`pending | approved | rejected |
changes_requested | dismissed`), evidence, `subjectRevision`, comment, and `decidedAt`. A review
becomes stale when its subject revision changes.

## 8. Progressive Retrieval

The system must explain what was searched, how many objects matched, what was omitted, which
snapshot/revisions were read, how to expand the result, and when it becomes stale.

- Level 0, ref: `id`, `kind`, `title`, `revision`, `state`, `estimatedTokens`.
- Level 1, card: summary, properties, relation preview, freshness, selectors.
- Level 2, structured detail: selected fields, sections, relations, changes, provenance.
- Level 3, raw: block tree/Markdown, evidence, activity range, artifact chunks.

Every response includes:

```text
snapshotId
items
completeness { returned, matched: number | unknown, truncated }
omitted [{ category, count: number | unknown,
           reason: budget | projection | permission | filter | too_large,
           expansionHandle? }]
nextCursor?
estimatedTokens
receiptId
warnings
```

Permission-sensitive counts are `unknown` when a number would leak information. Bootstrap returns
the subject/directive objective and constraints, relevant cards and reasons, guidance revisions
and precedence, expansion handles, omitted counts, and snapshot. It must not inject an entire
workspace prompt.

Read tools are `resolve_refs`, `search_entities`, `read_entities`, `expand_entity`,
`traverse_relations`, `query_view`, `read_changes`, `read_activity`, `read_artifact`, and
`get_run_context`. Write tools are `create_work_item`, `patch_entity`, `append_comment`,
`append_activity`, `update_plan_step`, `create_proposal`, `request_review`, `publish_artifact`,
`delegate_run`, `answer_signal`, and `complete_run`. Query accepts scope, kinds, filter,
projection, and budget. Traverse accepts source, type, direction, depth, and snapshot.

Search matches expose lexical/semantic/relation methods, matched blocks, relation path, score,
and expansion selectors. A cursor is opaque and signed, bound to snapshot, query hash, order,
last key, and expiry; one cursor chain is stable. Expiry returns `snapshot_expired` and a restart
handle; requesting latest creates a new snapshot.

A Receipt contains `id`, optional run, principal, snapshot, query hash, objects read
(`ref/revision/projection/blockIds`), summaries read (`summaryId/sourceRevision/profileRevision`),
`createdAt`, and retention policy. Delta accepts scope, `sinceReceipt`, kinds, and projection,
and returns changed (`from/to/fields/summary`), created, deleted, new relations, and `nextReceipt`.

A write includes target, `baseRevision`, and operations. A conflict returns expected and actual
revisions, change summary, and recovery options: `reload_and_rebase`,
`create_conflicting_proposal`, or `cancel`. Anchors use entity revision + block ID + inline range
or block revision; code symbol/ref; activity sequence; or artifact byte/chunk range. They do not
depend on unstable line numbers.

## 9. Human UX

Navigation: Home, Inbox, My Work, Reviews, Runs, Projects, Spaces, Knowledge, Views, Search,
Settings, pinned/favorites, stable entity URLs, context-preserving peek, and command palette.

- Home separates human responsibility, agent execution, and review needs and shows owned active
  work, reviews, `awaiting_input`, overdue/high-priority work, cycle, pinned knowledge, and updates.
- Project has a header and metric row, description, milestones, updates, docs, reviews; a side
  rail for spaces, modules, links, runs, subscribers; and Overview/Work/Board/Timeline/Docs/
  Updates/Runs/Activity tabs.
- Work list has virtualization, focus and multi-select, inline create/edit, tree, filter chips,
  group metrics, peek, saved state, and bulk move/assign/label/cycle/archive. Work detail shows
  key, type, title, state, priority, owner, delegates, breadcrumb, description, properties,
  sub-items, relations, knowledge, artifacts, and comments.
- Agent tab shows sessions, activity, plan, signals, what this run saw, and a trace link. Review
  tab shows proposal, diff, evidence, staleness, approve, reject, and request changes.
- Cycle shows goal, dates, progress, committed/added/removed scope, board/list, burn chart,
  blockers, carry-over, and rollover preview.
- Knowledge supports browsing collections/nesting/type/project and a local relation graph. Mixed
  search preview includes status, summary, revision, supporting/contradicting evidence, linked
  project/work/run, and changed blocks.
- Reviews filters assigned, requested-by-agent, knowledge, artifact, stale, and high-risk work;
  it connects directive, context, changes, evidence, verification, discussion, and decision.
- Run shows revision, runtime, state, requester, owner, duration, plan, activity, artifacts,
  verification, questions, context, receipts, raw trace link, policy, capabilities, and children.
  Raw token streams are not shown by default.
- Search covers projects, work, pages, knowledge, comments, views, agents, runs, and artifacts,
  with tabs, ranking context, and explicit filters.
- Palette covers create, state, priority, owner, move, delegate, view, copy, archive, delete, and
  custom actions.

Keyboard contract: `C` create; `Cmd/Ctrl+K` palette; `/` search; `F` filter; `B` list/board;
`Enter` peek; `Shift+Enter` full view; `Esc` close; `X` select; `Shift+X` range; `E` edit;
`A` owner; `S` state; `P` priority; `M` cycle/milestone; `Cmd/Ctrl+Enter` submit. Bindings are
configurable, but the initial defaults form a stable contract.

## 10. API

Separate Command, Human Query, Agent Retrieval, Event, Artifact, and Runtime Protocol layers.
Use JSON HTTP with OpenAPI/JSON Schema, signed webhooks plus SSE/WebSocket, and curated MCP/CLI
adapters over the same internal command DTOs. GraphQL is not the primary agent contract.

`CommandEnvelope` contains `commandId`, `actorId`, `idempotencyKey`, optional target,
optional `baseRevision`, payload, and cause (run/event/external ref). `CommandResult` contains
`commandId`, `eventId`, result, optional revision, and warnings.

Error codes are `invalid_argument`, `not_found`, `permission_denied`, `revision_conflict`,
`idempotency_conflict`, `invalid_transition`, `policy_denied`, `rate_limited`, `snapshot_expired`,
`cursor_invalid`, `budget_exceeded`, `capability_unavailable`, `run_not_active`,
`artifact_too_large`, `dependency_unavailable`, and `internal`. Errors carry retryability,
field errors, and recovery handles.

The filter AST supports `and`, `or`, `not`, `eq`, `in`, `contains`, `range`, `is_null`, and
`relation`; textual syntax can compile into this later. Offset pagination is forbidden. Cursors
are signed, opaque, expiring, and supply restart behavior.

An Event contains `id`, `workspace`, `sequence`, `type`, `time`, `actor`, `subject`,
`subjectRevision`, `data`, and `deliveryAttempt`. Delivery supports HMAC or asymmetric signature,
idempotent handling, retry/backoff, dead-lettering, replay, and scope/event filters.

## 11. Data Model

Use UUIDv7 or an equivalent time-sortable internal ID, `SPACE-sequence` display keys, bigint
entity revisions, workspace-monotonic event sequence or sortable event IDs, SHA-256 digests,
and resolution by either ID or key.

`entity`: id, workspace, kind, creator, timestamps, current revision, archived, deleted.
`entity_revision`: `(entity, revision)` primary key, schema version, canonical snapshot, actor,
cause event, time, digest. Large bodies/artifacts are referenced; derived counters and search
vectors are excluded from revisions.

Core tables: workspace, principal, membership, space, project, project_space, workflow, state,
type, field_definition, work_item, field_value, label, item_label, cycle, cycle_work_item,
milestone, module, module_work_item, relation, page, knowledge_object, thread, comment,
subscription, project_update, saved_view, retrieval_lens, intake, template, recurrence.

`work_item` uses the entity ID as primary key and stores space + unique sequence, type, project,
title, content, state, priority, owner, estimate, start, due, cycle, milestone, parent, and
completion. Hot indexes cover workspace+kind+updated, space/project+state, owner+state+due,
cycle/milestone+state, and parent. Custom field values use JSONB plus generated/index columns;
a registry promotes frequent filters.

`relation` stores entity, workspace, from, type, to, properties, assertedBy, evidenceRefs, and
validity, with a unique `(from, type, to)` constraint. Inverses are calculated or derived-indexed,
never duplicated as two canonical edges.

Content tables are content_document, revision, block, block_revision, and inline_comment. Begin
with whole-tree revision JSON plus a block index; optimize to deltas later. `domain_event` has a
unique workspace+sequence. `outbox` stores topic, payload, available time, attempts, and delivery.

Agent tables: definition, revision, installation, runtime_endpoint, session, run, lease, activity,
plan_step, input_snapshot, context_snapshot and entry, retrieval_receipt and entry, artifact,
proposal, review, capability, policy_snapshot.

ACL uses scope inheritance plus private overrides. Work inherits primarily from its owning Space;
Project participation does not grant access to an item in a private Space. Page and Knowledge
use explicit scope and `acl_subject_set`/policy caches. Notification, group, delivery, preference,
and inbox cursor are derived from events. Never perform external delivery inside a domain transaction.

## 12. Search and Indexing

PostgreSQL is canonical for entities, relations, revisions, ACLs, full-text search, and metadata.
Object storage holds artifacts, traces, and attachments. Derived search projections contain
lexical, embedding, relation, and summary data. Start with PostgreSQL FTS + vector; move to
Tantivy/OpenSearch only if needed. A search index is never a source of truth.

Pipeline: outbox -> worker -> canonical text/block index -> embedding/features -> summary
invalidation -> checkpoint. Results report source and index revision and either a lag warning or
transactionally coupled metadata.

Query pipeline: intent/filter -> authorization -> exact/lexical/semantic/graph/context candidates
-> merge/rank -> diversity/deduplication -> projection -> item/token/depth budget -> omission/
handles -> receipt. Ranking signals include exact key, title, heading, body, semantics, graph
distance, type, accepted status, freshness, scope, history, pin, evidence, and duplicate status.
Features must be debuggable; an optional reranker may follow. Distinguish `estimatedTokens` from
serialized bytes, permit provider-tokenizer registration, and cut only at item/block boundaries.

A Work card contains objective, state, owner/delegate, blockers, latest decision, and next action.
A Decision card contains decision, status, rationale, applies-to, superseded-by, and review
freshness. Receipts record profile revision. Apply ACLs before retrieval; key caches by workspace/
access fingerprint; never reuse private summaries publicly; limit count side channels; and use
the run-scoped principal.

## 13. Runtime Protocol

A runtime endpoint advertises protocol version, push/pull mode, agents/roles, activity types,
concurrency, heartbeat, upload, authentication, and health. Delegation creates a Session and
queued Run, issues a scoped credential and small `RunStart`, waits for lease acknowledgment,
then supplies bootstrap context and accepts plan/progress.

`RunStart`: `runId`, `installationId`, `subjectRef`, `directiveRef`, `bootstrapHandle`,
`callbackBaseUrl`, `runToken`, `leaseExpiresAt`, `protocolVersion`. Support push webhooks and
pull long-poll/stream with identical semantics, including local and air-gapped operation.

A run token permits authorized context reads, the run's own activity/artifacts, proposals and
input, and explicit capabilities only. Additional authority requires approval of an
`authorize_capability` signal. Never issue a long-lived workspace write token.

Secret broker flow: capability request -> run/project/repository/branch policy -> brokered
operation or constrained short-lived token -> audit. Raw secrets are not placed in context or
environment by default; exceptional tools require a risk level and explicit policy.

Heartbeat and lease track owner and generation. Resume increments generation; writes from an old
generation are rejected. Raw provider transcript, tool I/O, stdout/stderr, terminal output, and
usage are chunked artifacts with separate retention and permissions. Children do not automatically
inherit authority; context may be shared or reduced, outputs connect through artifact/response/
handoff, and cycles/fan-out are bounded. Usage captures provider, model, input/output/cache tokens,
compute, tool calls, bytes, failures, and retries. Record cost only when supplied by the provider;
do not hard-code price tables in core.

## 14. Automation and Extensibility

Automation is trigger + conditions + ordered actions and records owner, version, enabled state,
last run, and failures. Event ID provides idempotency; recursion and rate limits are mandatory.
Triggers include entity, field, state, comment, mention, cycle, due date, schedule, run, proposal,
review, and webhook. Actions include patch, comment, label, subscribe, create work/intake, move,
review, delegate, webhook, and archive.

- Tier 1: declarative types, fields, relations, workflows, views, lenses, templates, actions,
  and renderer metadata.
- Tier 2: out-of-process webhook/action/retrieval/indexer/runtime/integration with service or
  OAuth identity and signed installation.
- Tier 3: trusted UI sandbox through iframe or web-component bridge contributing entity tabs,
  cards, artifacts, and palette actions. Do not freeze an internal React ABI early.
- Tier 4: build-time trusted server packages for internal use, without public stability promises.

A manifest contains `id`, `version`, `protocolVersion`, permissions, entity types, relation types,
views, retrieval profiles, commands, event subscriptions, UI contributions, and migrations.
Type revisions are immutable and objects pin a schema version. Reads may upcast. Destructive
migrations require export and dry-run, and historical snapshots are interpreted with their
contemporary schema.

## 15. Real-Time Behavior, Concurrency, and Consistency

Do not replicate a full local-first engine. Use HTTP query/mutation, optimistic UI, SSE/WebSocket
events, cache invalidation/small patches, and event-cursor replay after reconnect. Speed comes from
optimistic inline actions, prefetch, progressive peek, local drafts, and keyboard interaction.

Reconcile `baseRevision` and `clientMutationId` against events; roll back and resolve only the
conflicting field/block. Presence for viewing/editing/active agents is a Complete requirement;
real-time cursor/character editing is later. A command transaction performs authorization/policy
-> current revision check -> mutation -> revision -> event -> outbox -> commit. External API calls
occur outside the transaction.

## 16. Security

Threats include malicious agents, prompt injection, over-broad tokens, private-search leakage,
webhook spoofing/replay, artifact traversal/malware, trace secrets, stale writes, extension supply
chain compromise, and automation loops. Controls include scoped short-lived tokens, allowlists and
policy, ACL-before-retrieval, log redaction, CSP/sanitization, signed webhooks + nonce, media
validation and isolated preview, lease generation, depth/rate limits, manifest/admin approval,
and permission audits.

Trust precedence is platform policy -> workspace guidance -> project/object guidance -> directive
-> retrieved untrusted data. Instructions found in searched documents never become higher-level
guidance. Each run stores a policy snapshot: agent revision, runtime version, guidance revisions,
grants, network/tool policy, approval policy, and secret-broker policy. Do not interpret historical
runs using current settings.

## 17. Architecture

Planned components: Web, API, worker, PostgreSQL, S3-compatible object storage, optional model/
embedding services, and external runtimes. Modules: identity, workspace, project, work, planning,
content, knowledge, relations, collaboration, agent-control, retrieval, search, notifications,
automation, integrations, artifacts, and audit. Modules communicate through public commands,
queries, and events; one module must not mutate another module's tables directly.

Recommended stack: React + strict TypeScript, ProseMirror custom blocks, a TypeScript modular
monolith, PostgreSQL FTS/vector/jobs/outbox, SSE/WebSocket, OpenTelemetry, and Compose-first
deployment. Runtime protocol is language-independent; Rust is an option for isolation, PTY, or
sandboxing. A Rust server is appropriate only when a single binary/efficiency and team skill plus
UI code-generation boundaries justify it. Do not begin with microservices or Kubernetes.

Candidate monorepo layout: `apps/` (`web`, `api`, `worker`, `cli`), `packages/` (`domain`,
`schemas`, `client-sdk`, `agent-sdk`, `ui`, `editor`, `retrieval`, `plugin-sdk`, `test-fixtures`),
`runtimes/` (`reference`, `sandbox`), `plugins/` (`github`, `knowledge`, `code-artifacts`), and
`deploy/`. One operation/schema should generate HTTP validation, OpenAPI, TypeScript SDK, other-
language models, MCP descriptors, CLI, and contract checks. Do not automatically expose every UI
query as an agent tool.

## 18. Operations and Performance

Target deployment: 1-100 workspaces, each with 1-50 humans, hundreds of installations, up to
200 projects, and 500,000 entities; tens of millions of events may be partitioned, with raw traces
in object storage. Initial releases need not load-test the absolute maximum.

Product targets under normal load, not hard alpha gates: p95 peek <=200 ms, first list page
<=300 ms, mutation <=250 ms, lexical search <=400 ms, hybrid search <=800 ms, UI event within
commit +1 s, and activity append <=300 ms.

Operations require PostgreSQL backup/PITR, object versioning/backup, digest integrity checks,
restore rehearsals, workspace JSON/Markdown export, and backup/dry-run before migration. Retention:
canonical data and revisions are permanent unless purged; domain/audit/semantic events are long-
lived; raw traces follow policy; ephemeral/temporary data is short-lived; receipt provenance is
retained medium- or long-term as needed.

## 19. Test Strategy

- Domain tests: workflow, rollover, progress, scope, rollup, inverse relations, cycle behavior,
  archive/retention, revisions, and stale reviews.
- Property tests: invariants under arbitrary commands, idempotency, pagination without duplicate/
  missing items, snapshot stability, traversal budgets, permission-change leaks, automation termination.
- ACL matrix: entity x operation x role/principal/scope, including agent/runtime/service as first-class cases.
- Retrieval fixtures: known-item recall, relation path, accepted/superseded, private isolation,
  omission, budget, summary staleness, and delta, using expected refs and structural assertions,
  not only an LLM judge.
- Runtime simulator: acknowledgment, duplicate message, heartbeat loss, generation, cancellation,
  input/resume, child runs, artifact chunks, activity idempotency, and capability denial.
- E2E: project -> cycle; delegate -> question -> answer -> proposal -> approve; document stale
  write; private search; import -> links -> export; automation -> run-failure notification.

## 20. Implementation Sequence

| Phase | Planned implementation | Exit gate |
| --- | --- | --- |
| 0. Contracts | Terms, kinds, IDs, revisions, events, errors, principals, permissions, content, runtime, retrieval | Draft schema/OpenAPI; core ADRs approved; fixtures and scenarios; migration strategy |
| 1. Foundation | Auth, workspace, membership, entity, revision, relation, event, outbox, storage, ACL, SDK, bootstrap | Create/update/history; idempotency; concurrency; event replay; private workspace |
| 2. PM slice | Space, workflow, Project, Work, labels, owner, dates, parent/relation, list, peek, board, comments, views, search, archive | Run a real project; keyboard flow; 100k-item paged query; minimal import/export |
| 3. Planning and docs | Cycle/rollover, milestone, module, progress, update, Pages/editor/nesting/inline comment, inbox, timeline, templates | Replace the core external-tracker path; metric snapshots; restore; notification dedup/preferences |
| 4. Agent retrieval | Registry, runtime, run, lease, activity, plan, signal, projection, snapshot, traverse, context, receipt, delta, artifact | API-only reference runtime; omissions; what-the-run-saw; cancellation and generation safety |
| 5. Knowledge | Claim, Decision, Evidence, Question, proposal, patch viewer, reviews, lifecycle, summary, graph | Canonical promotion; stale review/conflict handling; current state vs immutable input |
| 6. Completeness | Intake, recurrence, automation, GitHub, analytics, plugin, operations, accessibility, responsive UI, performance | v1 DoD; no dogfood blockers; upgrade/restore; security and ACL review |

Phase 0 is mandatory. Documentation or schema artifacts for a phase do not satisfy that phase's
behavioral exit gate.

## 21. Estimated Scale of Work

Estimated developer-months: domain/permissions/event/API 3-5; PM/web 5-8; docs/knowledge/review
3-5; retrieval/search 3-5; runtime 3-5; notification/automation/integration 2-4; operations/
security/migration/quality 3-5; total approximately 22-37. This is not a schedule commitment and
depends on reuse.

Major cost drivers are fast inline UX, ACL-aware search, block revisions and anchors, runtime
failure/retry/cancellation, notification/replay, schema/plugin evolution, and import/export/
restore. A small slice and a polished v1 are materially different scopes.

## 22. v1 Definition of Done

- **Product:** A 5-20-person team runs a real project for two months without an external tracker.
  Project/work/cycle/milestone/view/page/comment/search/notification have no blocking gaps;
  repeated work is fast through inline/keyboard flows; an API-only agent can discover through
  proposal; a human sees directive, context, activity, artifacts, and review in one flow.
- **Data:** Stable IDs/revisions; actor, cause, event, and revision traceability for important
  changes; verified archive/export/restore; document and relation links survive import/export.
- **Retrieval:** Every list has cursor/completeness; agent reads have snapshot, omission, size,
  and receipt; major types support card/detail/raw; delta works; ACL leakage regressions pass.
- **Runtime:** Installation and runtime are separate; scoped token, lease, heartbeat, and cancel
  work; duplicates/retries are safe; semantic activity and raw traces are separate; proposals
  and reviews are pinned to revisions.
- **Operations:** Clear Compose or single-command self-hosting; migration and rollback/restore;
  structured logs, metrics, and traces; verified backup restore; secure defaults.

## 23. Priority Backlog

- **P0:** Entity/Revision/Relation; Space/Project/Work; list/board/peek; filters/views; block model;
  agent/delegate; run/activity/signal; retrieval envelope/context/receipt; proposal/review; ACL first.
- **P1:** Cycle/milestone/module; inbox; project overview/update/progress; timeline/templates/intake;
  search quality; archive/import/export; GitHub; analytics.
- **P2:** Recurrence; automation; project templates; custom fields; plugin SDK; email; advanced
  query; semantic duplicates.
- **Later:** Initiative/portfolio; CRM/SLA/time tracking; all-CRDT; mobile; dashboards; full
  workflow/approval designer; public marketplace; multi-region/federation.

## 24. ADR Candidates

- ADR-001: Entity registry plus specialized tables.
- ADR-002: Current state plus revision/event.
- ADR-003: Stable blocks plus Markdown.
- ADR-004: JSON Schema/OpenAPI plus agent retrieval protocol.
- ADR-005: Optimistic HTTP plus events.
- ADR-006: PostgreSQL-first search.
- ADR-007: Scoped, out-of-process runtime.
- ADR-008: Declarative and out-of-process plugins.
- ADR-009: Proposals for high-risk changes.
- ADR-010: One accountable human owner plus delegates.
- ADR-011: Space-owned cycles and cross-Space Projects.
- ADR-012: Inherited/private ACL evaluated before retrieval.

Candidate status is not approval. Record accepted ADRs separately.

## 25. Designs to Avoid

Avoid over-generic JSON/EAV, complete event sourcing, treating comments as knowledge, treating raw
logs as activity, treating summaries as canonical, hidden omission, prematurely stable UI ABIs,
long-lived agent workspace tokens, and placing every feature into the first slice. Counter these
risks with normalized hot domains, explicit promotion, semantic/raw separation, source/profile
freshness, explicit completeness, bridges instead of frozen internals, scoped capabilities, and a
small end-to-end vertical flow.

## 26. First Vertical Slice

Flow: a human manages one Project's Work through list/board -> delegates to an agent -> the agent
retrieves progressive context -> records plan/activity -> proposes a change -> a human reviews and
applies it.

Minimum objects: Workspace, Human, Installation, Space, State, Project, Work, Revision, Relation,
Comment, Run, Activity, ContextSnapshot, Receipt, Proposal, Review, and View.

Minimum screens: project list/board, work peek, run/review panel, global search/palette.

Minimum APIs: work create/read/patch; view query; search/read/expand/traverse; run start/heartbeat/
cancel; activity; proposal/review/apply; event subscription.

Verification: revision-safe writes; no automatic injection of full context; explicit omissions;
immutable input; separate owner and delegate; canonical mutation only after approval; fast list/board.

## 27. Product Direction

The differentiator is not the number of PM features. An agent need not consume the whole workspace;
the system can reproduce what it read, disclose incompleteness, separate human accountability from
agent execution and review, and connect reviewed knowledge to a typed graph.

Build in this order: PM core -> revision/relation -> progressive retrieval -> runtime/activity ->
proposal/review/knowledge -> automation/plugin/integration. Connect the minimum vertical flow first,
then deepen both sides. Avoid both failure modes: a PM core so weak that users must retain an external
tracker, and a PM clone that delays the agent-specific core.

## 28. Sources

These are the references cited by the original design as of 2026-09-01. Their latest feature sets
were not re-researched for this repository transcription.

- Linear: [Conceptual model](https://linear.app/docs/conceptual-model),
  [Projects](https://linear.app/docs/projects), [Overview](https://linear.app/docs/project-overview),
  [Views](https://linear.app/docs/custom-views), [Board](https://linear.app/docs/board-layout),
  [Cycles](https://linear.app/docs/use-cycles), [Triage](https://linear.app/docs/triage),
  [Assign and delegate](https://linear.app/docs/assigning-issues).
- Linear agents: [Agents](https://linear.app/developers/agents),
  [Interaction](https://linear.app/developers/agent-interaction),
  [Best practices](https://linear.app/developers/agent-best-practices),
  [Pagination](https://linear.app/developers/pagination),
  [Filtering](https://linear.app/developers/filtering),
  [Rate limits](https://linear.app/developers/rate-limiting).
- Plane: [Concepts](https://docs.plane.so/introduction/core-concepts),
  [Projects](https://docs.plane.so/core-concepts/projects/overview),
  [Properties](https://docs.plane.so/core-concepts/issues/properties),
  [Types](https://docs.plane.so/work-items/project-work-item-types),
  [Cycles](https://docs.plane.so/core-concepts/cycles),
  [Modules](https://docs.plane.so/core-concepts/modules),
  [Milestones](https://docs.plane.so/core-concepts/projects/milestones),
  [Views](https://docs.plane.so/core-concepts/views),
  [Filters](https://docs.plane.so/core-concepts/issues/visualise_filter).
- Plane knowledge and access: [Wiki](https://docs.plane.so/core-concepts/pages/wiki),
  [Collections](https://docs.plane.so/pages/collections),
  [Nested pages](https://docs.plane.so/pages/nested-pages),
  [Roles](https://docs.plane.so/roles-and-permissions/overview),
  [Permission matrix](https://docs.plane.so/roles-and-permissions/permissions-matrix),
  [Growing teams](https://docs.plane.so/introduction/quickstart/growing-teams),
  [Enterprise teams](https://docs.plane.so/introduction/quickstart/enterprise-teams),
  [AGPL repository](https://github.com/makeplane/plane).
