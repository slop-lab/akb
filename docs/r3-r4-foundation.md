# R3/R4 Foundation Inventory

## Status boundary

This document records locally implemented source and executable evidence. It does not mark R1, R2,
R3, or R4 complete. CI is deferred and the canonical phase gates remain open. Recorded native Node
24 live export/import/archive checks and all 11 Chrome scenarios pass their bounded paths.
Independent named local gates and all five review lanes passed at source commit `260812d`.

## Additive storage foundation

| Migration | Delivered responsibility | Primary evidence |
| --- | --- | --- |
| `005_entity_registry_acl.sql` | Entity/revision registry, permission atoms, restrictive ACL, authority epochs, legacy backfill | [`migrations/005_entity_registry_acl.sql`](../migrations/005_entity_registry_acl.sql), [`test/postgres-r4-foundation.test.ts`](../test/postgres-r4-foundation.test.ts) |
| `006_entity_event_outbox.sql` | Versioned generic event, outbox, jobs, inbox, and command idempotency | [`migrations/006_entity_event_outbox.sql`](../migrations/006_entity_event_outbox.sql), [`test/postgres-r4-operations-outbox.test.ts`](../test/postgres-r4-operations-outbox.test.ts) |
| `007_r4_pm_core.sql` | Space configuration, workflows/states, Projects, Work metadata, labels, relations, comments, Saved Views, search documents | [`migrations/007_r4_pm_core.sql`](../migrations/007_r4_pm_core.sql), [`test/postgres-r4-commands.test.ts`](../test/postgres-r4-commands.test.ts) |
| `008_human_query_import_retention.sql` | Human Query snapshots, stable import IDs, import batches, and retention policy data | [`migrations/008_human_query_import_retention.sql`](../migrations/008_human_query_import_retention.sql), [`test/postgres-r4-query-security.test.ts`](../test/postgres-r4-query-security.test.ts) |
| `009_legacy_workflow_revision_history.sql` | Deterministic revision-1 workflow/state history for legacy Spaces; unresolved actors stay null and later history is untouched | [`migrations/009_legacy_workflow_revision_history.sql`](../migrations/009_legacy_workflow_revision_history.sql), [`test/postgres-r4-legacy-workflow-history.test.ts`](../test/postgres-r4-legacy-workflow-history.test.ts) |
| `010_legacy_work_query_projection.sql` | Nullable schema-tagged snapshot-item sidecar for frozen legacy PM query projections; incompatible transient snapshots are discarded | [`migrations/010_legacy_work_query_projection.sql`](../migrations/010_legacy_work_query_projection.sql), [`test/postgres-r4-legacy-work-projection-migration.test.ts`](../test/postgres-r4-legacy-work-projection-migration.test.ts) |

The registry gives each first-class object a stable ID, kind, Workspace, optional Space scope,
lifecycle, current revision, and timestamps. Specialized tables remain canonical for domain
constraints. JSON snapshots are versioned revision evidence, not a generic metadata replacement for
Project, workflow, relation, ACL, or PM state.

## Versioned streams and operations

The shipped `work-item-v1` tables, DTOs, and replay route remain compatible. R4 uses independent
`entity_events_v1`, `entity_outbox_events_v1`, `entity_outbox_destinations_v1`,
`entity_outbox_jobs_v1`, and `delivery_inbox_v1` resources. Historical rows do not create delivery
jobs. New command transactions append current state, immutable revision, generic event, and generic
outbox atomically. Legacy Work Item mutations continue to maintain their old stream as well.

Generic replay is `GET /api/events/v1/workspaces/:workspaceId/events`. It is ordered, bounded, and
fails closed unless the Principal has complete effective authority for the returned scope. The
retention command is read-only: canonical entities, revisions, events, and comments are configured
`keep_forever`; only transient query snapshots and validated import bookkeeping can be reported as
eligible by a `purge_after` policy.

The generic worker CLI accepts `--stream entity-v1`, defaults to the compatible `work-item-v1`
stream, and emits a machine-readable summary. See [`src/outbox/cli.ts`](../src/outbox/cli.ts) and
[`test/postgres-r4-operations-outbox.test.ts`](../test/postgres-r4-operations-outbox.test.ts).

## PM and Human Query registry

`COMMAND_ROUTES` in [`src/http/command-v1/routes.ts`](../src/http/command-v1/routes.ts) is the
27-operation command registry. Every request uses a strict envelope with `commandId`,
`idempotencyKey`, `baseRevision`, and route-specific `payload`. Actor identity comes only from the
authenticated Principal context; outer and payload `actorId` fields are rejected.

Human Query covers Project pages, Work Item pages, board columns, and paged lexical search.
Snapshots materialize authorized IDs, ordinals/group keys, and source revisions. Limits are 100,000
members per snapshot, 250,000 active rows per Workspace, eight active snapshots per Principal, and
a 15-minute lifetime. Signed cursors bind Principal, credential, Workspace, query/sort/page size,
authority state, expiry, and snapshot position. Clients release abandoned snapshots through
`DELETE /api/human/v1/workspaces/:workspaceId/query-snapshots/:snapshotId`, which returns `204`
without disclosing ownership.

Current read and interchange hardening includes effective-authority checks for assignment; typed
metadata, counts, history, and frozen current/list/continuation projections; ACL-safe reference-ID
ranges; and Saved View current-scope enforcement. Portable NDJSON normalizes relevant reference
ranges to at most 50 explicit typed references while preserving null, negation, and query-result
semantics. Unauthorized and scope-irrelevant views are omitted before output; duplicate IDs,
out-of-scope relevant views, unresolved references, AST-budget overflow, and nonportable graphs fail
with typed errors. Primary evidence includes
[`test/postgres-r4-command-assignment-authorization.test.ts`](../test/postgres-r4-command-assignment-authorization.test.ts),
[`test/postgres-r4-saved-view-transfer-results.test.ts`](../test/postgres-r4-saved-view-transfer-results.test.ts),
[`test/postgres-r4-saved-view-scope-export.test.ts`](../test/postgres-r4-saved-view-scope-export.test.ts),
and [`test/postgres-r4-legacy-work-query.test.ts`](../test/postgres-r4-legacy-work-query.test.ts).

Workflow interchange distinguishes markerless partial additive files from complete
`workflowStateScope: "active" | "all"` files. Complete workflows require exactly one active default
in any canonical category and at least one active state in every canonical category. Default
handover emits a canonical revision/event for the former state and rolls back atomically. See
[`test/r4-import-workflow-validation.test.ts`](../test/r4-import-workflow-validation.test.ts),
[`test/postgres-r4-workflow-default-handover.test.ts`](../test/postgres-r4-workflow-default-handover.test.ts),
and [`test/postgres-r4-workflow-partial-default.test.ts`](../test/postgres-r4-workflow-partial-default.test.ts).

## Backup profile registry

| Profile | Artifact format | Migration ledger | Catalog | Restore behavior |
| --- | ---: | --- | --- | --- |
| `r3-schema-004-public` | 1 | `001`-`004` | schema-004 public resources | Validate/quarantine source, then registered forward upgrade to 010 |
| `r4-schema-008-public-v1` | 2 | `001`-`008` | 48-table schema-008 public resources, including trusted `pgcrypto` in `public` | Validate source, then registered forward upgrade to 010 |
| `r4-schema-009-public-v1` | 2 | `001`-`009` | Same resources and fingerprint as 008; deterministic legacy history is data-only | Validate source, then registered forward upgrade to 010 |
| `r4-schema-010-public-v1` | 2 | `001`-`010` | Current 48-table catalog with nullable frozen legacy projection sidecar | Validate 010 directly and quarantine authority, leases, and transient state |

The source of truth is [`src/operations/backup/profiles.ts`](../src/operations/backup/profiles.ts)
and [`src/operations/backup/resources.ts`](../src/operations/backup/resources.ts). Profile checks pin
migration checksums, ordered resources, public-schema ownership semantics, PostgreSQL 17, and the
schema fingerprint. Restore revokes active credentials, fences legacy and generic leases, clears
Human Query snapshots and validated import bookkeeping, and preserves canonical history, ACL, and
committed import identity mappings.

Profiles do not provide PITR, encryption, authenticity signatures, scheduling, replication,
object-storage lifecycle, or full R8 release operations.

Backup tests cover restore under an ordinary database owner, every older registered profile upgraded
to `r4-schema-010-public-v1`, catalog equivalence, and preservation of existing grant boundaries.
The 009 and 010 migration checksums and schema fingerprints are pinned in
[`src/operations/backup/profiles.ts`](../src/operations/backup/profiles.ts). Evidence is in
[`test/postgres-backup.test.ts`](../test/postgres-backup.test.ts),
[`test/postgres-backup-legacy.test.ts`](../test/postgres-backup-legacy.test.ts), and
[`test/postgres-backup-profile-009.test.ts`](../test/postgres-backup-profile-009.test.ts).

## Runtime and scale evidence

[`test/r4-native-runtime.test.ts`](../test/r4-native-runtime.test.ts) imports production TypeScript
through native Node 24 strip-only loading. [`test/utc-datetime.test.ts`](../test/utc-datetime.test.ts)
checks UTC normalization. The public 100,000-item snapshot boundary and list/board traversal are
covered by [`test/postgres-r4-scale.test.ts`](../test/postgres-r4-scale.test.ts) and
[`test/postgres-r4-query-scale.test.ts`](../test/postgres-r4-query-scale.test.ts); both passed in
individual recorded runs.

Independent acceptance at source commit `260812d` passed `npm run check` (66 unit and 40
integration tests), `test:postgres` (71), `test:r4` (15 contract and 164 PostgreSQL), and
`test:backup` (28, including registered 004/008/009/010 recovery). Web/browser TypeScript and
the production web build passed; the real-Chrome suite passed all 11 scenarios in approximately
one minute, with no mocks or skips. All five review lanes returned PASS without blockers.
The live API matrix observed 36 expected outcomes, and fresh responsive captures covered
375, 768, and 1280 px. These local results do not substitute for deferred CI or a formal phase
gate. A legacy SDK driver separately
observed a schema-004 -> schema-010 database upgrade, detail/list/continuation behavior, and unchanged history.

The latest browser coverage includes 101-Project pagination, searchable Project selectors with
latest-response-wins ordering, selection retention across later pages and reloads, empty browser
credential storage, keyboard paths, and maximum-length Space keys. Evidence is in
[`test/browser/project-pagination.spec.ts`](../test/browser/project-pagination.spec.ts),
[`test/browser/security.spec.ts`](../test/browser/security.spec.ts),
[`test/browser/quality.spec.ts`](../test/browser/quality.spec.ts), and
[`test/browser/transfer.spec.ts`](../test/browser/transfer.spec.ts).

Known low-severity residuals remain around private-Project slug warning metadata and deployment
hardening for static dotfiles and an operator-controlled secure asset root. They are not production
release, PITR, encryption, scheduling, OIDC, or R5 completion claims.

## Machine contract evidence

[`docs/openapi-r4.json`](openapi-r4.json) is generated from the runtime command registry and pure Zod
request schemas. [`test/r4-route-inventory.test.ts`](../test/r4-route-inventory.test.ts) checks the
route count, methods, route-specific nested payloads, actor exclusion, special human/event/import
inventory, snapshot `204`, generation freshness, and byte preservation of [`openapi.json`](openapi.json).
