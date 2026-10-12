# R3/R4 Delivery Contract

## Authority and boundary

This execution contract implements the existing roadmap through R4. It does not add R5+ product
scope or mark deferred CI as successful. The canonical design remains authoritative. Existing
migrations 001-004, Work Item routes and DTOs, and schema-004 backup artifacts remain compatible.
Architecture records for new boundaries remain proposed until maintainer acceptance.

The runtime sources now implement the bounded R3/R4 checkpoint described here, but this remains an
execution contract rather than a phase-completion record. R1-R4 are `In progress`, CI is deferred,
and no formal exit gate is reported as passing by this document. Recorded native Node 24 live
export/import/archive evidence and 11 of 11 Chrome scenarios pass their bounded paths; final
current-HEAD named PostgreSQL, backup, and aggregate R4 reruns remain pending.

R3 prerequisite work includes a normalized Entity/Revision/Relation foundation, restrictive
object ACL, a versioned generic event/outbox stream, archive/retention foundations, structured
request telemetry, and restore-based migration rollback procedures. R4 includes the full Project
lifecycle, Space workflow/state/label administration, Work metadata, comments, typed relations,
Saved Views, lexical search, import/export, and human list/board/peek surfaces.

PITR, encrypted backup storage, OIDC, network webhooks, rich documents, planning, runtimes,
proposals, and review remain later work. CI is explicitly deferred rather than an execution blocker.

## Additive migrations

- `005_entity_registry_acl.sql`: permission atoms, normalized entities/revisions, restrictive entity
  ACL policies/allowances, workspace authority epochs, and legacy Work Item/Space backfill.
- `006_entity_event_outbox.sql`: independent generic event sequence, event/outbox/job/inbox tables,
  generic command idempotency, and legacy Work Item event mirroring.
- `007_r4_pm_core.sql`: Space details and keys, workflows/states, Projects and participating Spaces,
  normalized Work Item metadata/labels, typed relations, threads/comments, Saved Views, and search.
- `008_human_query_import_retention.sql`: bounded materialized Human Query snapshots, import identity
  mappings, retention policy, and non-destructive retention dry-run.
- `009_legacy_workflow_revision_history.sql`: deterministic missing revision-1 snapshots for legacy
  workflows and canonical states without rewriting later history.
- `010_legacy_work_query_projection.sql`: nullable transient snapshot-item projection for frozen
  legacy PM reads without rewriting legacy fingerprints, events, or revisions.

Legacy Work Items retain their exact scope and revision, including NULL Space scope. Backfill
must not fabricate Workspaces, Spaces, Principals, grants, or historical delivery jobs. Historical
actors that do not resolve to real Principals remain NULL in the new registry. Canonical revisions
and events remain append-only. Existing Work Item table column order must remain intact; R4 metadata
belongs in a separate normalized table.

## Authorization

Effective access is active identity and membership, matching explicit Workspace permission, matching
private Space permission when applicable, and matching entity allowance when its policy is
`restricted`. Restricted allowances only narrow authority. Roles, accountability, comment authorship,
and Project participation do not bypass private or object ACL.

Permission atoms are `work.read`, `work.create`, `work.update`, `work.assign`, `space.read`,
`space.manage`, `project.read`, `project.manage`, `comment.create`, `comment.update`,
`relation.manage`, `view.read`, `view.manage`, `history.read`, and `acl.manage`.

Existing grants are not widened by migration. Fresh bootstrap grants the known R4 bundle; existing
members require an explicit additive operator command. Object access replacement must preserve the
HTTP caller's effective `acl.manage`; a separate database-operator recovery path handles self-lockout.
All authority changes increment a Workspace epoch, and all operations retain Workspace-first lock
ordering. By-ID denial is indistinguishable from absence. Collections may use generic 403.

Comments require subject access. Relations require both endpoints and relation access. Search,
counts, board columns, snapshots, and export filter authorized candidates before matching, ranking,
limits, and aggregation. Global event replay requires complete effective read authority before
returning any sequence or checkpoint.

## PM invariants

Each R4 Space has one active workflow, at most 20 active states, and an immutable unique uppercase
2-10 character alphanumeric key. State category uses the five existing canonical categories and is
immutable; state name, color, order, and default status are editable. Transitions are permitted only
within the owning workflow. A Work Item retains its immutable Space, derives a display key from its
Space sequence, and has one accountable active human owner. Completion timestamps follow category.

Labels belong to a Space, with at most 50 per Work Item. Projects have unique case-insensitive slugs,
owner/leads, participating Spaces, lifecycle/health/priority/dates, and optimistic revisions. Project
participation grants no private Work access. A child has at most one active parent; recursive checks
reject parent cycles. Related endpoints are canonically ordered. Relation archives preserve history.
Comments are bounded plain Markdown-compatible text. Saved View definitions use the server query
schema. Archive and restore are revision-safe mutations, not deletes.

Workflow imports without a scope marker remain partial and additive. A declared
`workflowStateScope` of `active` or `all` is complete and must contain exactly one active default in
any canonical category plus at least one active state in every canonical category. Changing the
default records the former state's canonical event/revision and rolls back both sides on failure.

## Versioned command and query surfaces

New commands are under `/api/commands/v1/workspaces/:w`. Their strict envelope has `commandId`,
`idempotencyKey`, `baseRevision` (NULL on creation), and typed `payload`. Actor is derived only from
authentication. Results include command/event identity, result, revision, replay status, and warnings.
All effective mutations atomically commit current state, revision, event, and outbox. Conflicts
offer reload/rebase or cancel; they never silently overwrite.

Command resources cover Spaces/access/workflows/states/labels, Projects, Work Items, relations,
subject comments, Saved Views, entity access, and import validation/commit. New Work Item mutations
also preserve the old Work Item revision/event/outbox stream. Metadata-only old events use an empty
changed-field list rather than widening the shipped union.

Human reads are under `/api/human/v1/workspaces/:w`, including bootstrap, Spaces/config, Projects,
Work Item detail, entity history/relations/comments, Saved Views, Project/Work queries, board, search,
and export. A Work card/detail includes scope/key, revision, title/description/type, workflow state,
category/priority, accountable owner, Project, labels, dates, parent, and lifecycle timestamps. New
DTOs use explicit NULL for absent values; old DTOs retain their existing property-omission rules.

Work queries contain `model`, strict bounded filter AST, search text, 1-3 sort entries,
`includeArchived`, and `page { size, cursor }`. Allowed filters cover Space, Project, workflow state,
category, priority, owner, type, label, dates, timestamps, archive, and typed relations. AST depth is
at most 5 and node count at most 50. Sorts include creation/update time, title, priority, due date,
and workflow position with ID as final tie-breaker.

Assignment requires effective `work.assign` authority. Saved View reads, mutations, history, and
export recheck the current Space scope. Reference-ID ranges compare only authorized references;
portable interchange normalizes relevant ranges to no more than 50 typed IDs while preserving null,
negation, and result equivalence. Unauthorized or irrelevant views are omitted before output;
duplicate IDs, unresolved relevant references, and nonportable graphs fail with typed errors.

## Stable pagination

Human Query snapshots materialize authorized entity IDs, source revisions, group keys, and ordinal
in a consistent transaction. They are bounded to 100,000 results, 250,000 unexpired rows per
Workspace, eight active snapshots per Principal, and a 15-minute TTL. Pages are 1-100; board columns
use 1-25 cards and independent cursors. Snapshot expiry cleanup is bounded and opportunistic.

HMAC-signed cursors bind snapshot/ordinal/column, Principal, credential, Workspace, normalized query,
sort, page size, authority hash, and expiry. Every continuation reauthenticates and rechecks ACL.
Tampering or changed binding rejects the cursor; expired or changed authority requires query restart.
Membership and ordering remain snapshot-stable through concurrent inserts, updates, and archive.
No agent snapshot/receipt or R6 retrieval completion claim follows from these human-query snapshots.

## Search and interchange

Lexical search uses PostgreSQL FTS only after a materialized authorized-candidate CTE. R4 kinds are
Project, Work Item, and comment. Export includes only authorized objects and endpoints.

NDJSON interchange version 1 contains a manifest and Space, workflow-state, Project, label,
Work Item, relation, comment, and Saved View records. Import is limited to 10 MiB/10,000 records,
validates references/cycles/uniqueness and authority without writes, and commits the exact validated
bytes atomically through a signed validation token and stable external-ID mappings. Repeated identical
imports replay; changed content conflicts. No memberships, credentials, tokens, or grants transfer.
Export is bounded to 100,000 records/100 MiB and rejects excess before streaming.

## Operations compatibility

Generic events and delivery use separate versioned tables and an explicit `entity-v1` worker stream;
the default `work-item-v1` stream and DTOs remain unchanged. Retention dry-run never deletes canonical
entities, revisions, events, or comments. Request telemetry contains only correlation ID, route
template, method/status, duration/bytes, and error code, never IDs, queries, bodies, or credentials.

Backup uses explicit trusted profiles for schemas 004, 008, 009, and 010. Every profile retains its
pinned migration/catalog policy; 008 and 009 share the unchanged schema fingerprint, while 010 pins
the sidecar catalog. Restoring any older profile validates and quarantines that source before the
registered forward upgrade to 010, validates the final profile, clears transient query/import state,
and reasserts zero restored authority/leases. Rollback is fresh-target restore, never editing applied
migration files or destructive down migration.

## Browser boundary and required evidence

The web application uses React/Vite with a separate strict DOM TypeScript configuration. It renders
real server responses, not client-side authorization/search/count corrections. Bearer login uses
React memory only; refresh/logout/401 clear tokens and caches. No token is bundled, logged, placed
in a URL, or persisted in browser storage. Production deployment is same-origin.

Screens cover login, Projects, Space/workflow/labels, list/board/peek, Work metadata and relations,
comments, Saved Views, search, import validation/commit, and export. Keyboard bindings follow the
canonical design; inputs/editors are guarded. Revision conflict rolls back only optimistic edits
while retaining unsent text and offering reload. Board movement supports keyboard alternatives.
Project lists page beyond 100 records; searchable selectors retain later-page selections and use
latest-response-wins ordering. Browser credential storage remains empty, and maximum-length Space
keys remain intact across supported QA widths.

Required local exit evidence includes old API compatibility, every older profile upgraded to 010, ACL non-disclosure on every
surface, mutation rollback, 100,000-item list/board traversal through concurrent changes, cursor
binding/expiry/revocation, relation-cycle constraints, complete import/export round trip, all four backup
profiles, and real-browser keyboard-only create/edit/filter/move/peek/comment/archive flows. R5+
features and deferred CI remain explicitly outside the implemented checkpoint. This list states the
gate, not that every item has passed. Recorded live and browser exercises cover the bounded R4 paths,
but do not complete the dependency-ordered phase gate.
