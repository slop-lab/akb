# R4 Human Query and Interchange Reference

## Integration

The authenticated server composes two factories after bearer authentication:

```ts
const human = createR4HumanRouter(sql, signingKey)
const imports = createR4ImportRouter(sql, signingKey, commandDispatcher)
await human(request, response, principal)
await imports(request, response, principal)
```

Each returned function has the type
`(request, response, principal) => Promise<boolean>`. `true` means that the route was handled.
The signing key is required and must contain at least 32 bytes of entropy. Load it from a secret
environment variable and decode it before constructing either router; never persist or log it.

The parent contract barrel must export the new browser-safe modules `human.ts` and
`interchange.ts`. This branch already exports them from `src/contracts/r4/index.ts`.

## Human routes

All routes are authenticated and begin `/api/human/v1/workspaces/:workspaceId`.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/bootstrap` | Workspace, active human principal, permissions, human directory, readable Spaces |
| `GET` | `/spaces` | Readable Spaces |
| `GET` | `/spaces/:spaceId/config` | Space, active workflow/states, readable labels |
| `GET` | `/projects/:projectId` | Project detail |
| `GET` | `/work-items/:workItemId` | R4 Work Item detail |
| `GET` | `/entities/:entityId/history` | Authorized immutable revisions |
| `GET` | `/entities/:entityId/relations` | Relations whose relation and both endpoints are readable |
| `GET` | `/entities/:entityId/comments` | Comments whose comment and subject are readable |
| `GET` | `/saved-views` | Readable Saved Views |
| `POST` | `/projects/query` | Project query page |
| `POST` | `/work-items/query` | Stable Work Item query page |
| `POST` | `/work-items/board` | Workflow columns and authorized card totals |
| `POST` | `/search` | ACL-first PostgreSQL FTS results |
| `DELETE` | `/query-snapshots/:snapshotId` | Idempotently release an owned transient query snapshot (`204`) |
| `POST` | `/export` | Bounded NDJSON interchange stream |

By-ID denial is returned as `404`. Collection authorization is evaluated before matching,
ranking, counting, grouping, or limiting. R4 Work Item responses exclude legacy records without a
Space. Project participation, ownership, accountability, authorship, and Workspace role never
bypass private-Space or restricted-entity ACL.

Work projections require effective read authority for the Work Item, its Space, and its workflow
state because these metadata fields are non-null in the DTO. Unreadable nullable references are
treated as absent before filtering, including `is_null` and negation. Reference IDs (`spaceId`,
`projectId`, `workflowStateId`, and `labelId`) do not support `range`; such input returns `400`.
Comment/thread history also requires subject access, relation history requires both endpoints,
and historical Saved View definitions are omitted when their own filter references are unreadable.

### Work query example

```http
POST /api/human/v1/workspaces/acme/work-items/query
Authorization: Bearer <token>
Content-Type: application/json

{"model":"r4","filter":null,"search":"release blocker","sort":[{"field":"createdAt","direction":"asc"}],"includeArchived":false,"page":{"size":100,"cursor":null}}
```

The response contains `snapshot { id, expiresAt }`, `items`, `completeness`, and `nextCursor`.
Cursors are HMAC authenticated and bind the snapshot, ordinal/group, Principal, credential,
Workspace, canonical query, sort, page size, authority epoch/hash, and expiry. Restart after
`409 snapshot_stale`; restart after `410 snapshot_expired`. Page size is 1-100 and board size is
1-25. Snapshots expire after 15 minutes and materialize at most 100,000 authorized members.

Continuation validates and locks the stored snapshot, not only its signed cursor. A released or
missing snapshot returns `409 snapshot_stale`; database expiry returns `410 snapshot_expired`.
Allocation is serialized per Workspace across all query surfaces: each Principal can retain at
most eight active snapshots and a Workspace at most 250,000 materialized rows. Exhaustion returns
`507 query_budget_exceeded`; releasing an owned snapshot restores capacity. Board column metadata
is read from immutable state revisions at snapshot creation, so later state archival does not
remove frozen column members from an existing traversal.

Work, Project, board, and paged search snapshots are transient. A client that replaces or abandons
a query should call `R4Api.releaseSnapshot(snapshotId)`, which sends
`DELETE /api/human/v1/workspaces/:workspaceId/query-snapshots/:snapshotId`. The snapshot ID path
segment must be a UUID. The endpoint returns an empty `204` for an owned, absent, or foreign-owned
ID so ownership is not disclosed. It deletes only a snapshot bound to the authenticated Principal,
credential, and Workspace; member rows cascade. Snapshot release does not require current read
permission, but it does require the credential to remain active. Revoked-credential snapshots
remain unavailable and expire normally. A different Workspace namespace returns `404`.

### Search example

```json
{"text":"release blocker","kinds":["project","work_item","comment"],"limit":25,"cursor":null}
```

Search text is limited to 500 characters and is passed as a PostgreSQL parameter to
`websearch_to_tsquery('simple', ...)`. Command transactions maintain documents with
`updateSearchDocument(transaction, { id, workspaceId, kind, revision, text })`.

## Export

`POST /api/human/v1/workspaces/:workspaceId/export` accepts a JSON query/scope body and returns
`application/x-ndjson`. The manifest is first. Records are ordered by dependency and stable ID.
The server rejects an export above 100,000 records or 100 MiB before returning the body. It never
exports memberships, grants, credentials, bearer tokens, or unauthorized relation endpoints.

```http
POST /api/human/v1/workspaces/acme/export
Authorization: Bearer <token>
Content-Type: application/json

{"includeArchived":false}
```

## Import

Import uses the command namespace and sends the exact same NDJSON bytes to validation and commit.
Files are limited to 10 MiB and 10,000 records. Remote URL fetching is not supported.

Validation performs no database writes:

```http
POST /api/commands/v1/workspaces/acme/imports?mode=validate
Authorization: Bearer <token>
Content-Type: application/x-ndjson
Command-ID: 4f25b570-2613-4f43-9644-b22a90aa4230
Idempotency-Key: import-2026-10-11

{"kind":"manifest","version":1,"importId":"3fd993bc-2e72-4340-91fc-69c3490d8058","workspaceId":"acme"}
{"kind":"space","externalId":"space-1","key":"ENG","name":"Engineering"}
```

The response supplies `contentDigest`, `recordCount`, `expiresAt`, and `validationToken`. Commit
passes that token in `Validation-Token` and invokes the injected command dispatcher inside one
transaction; the dispatcher must create canonical revisions/events/outbox records and stable import
ID mappings without opening a nested transaction.

```http
POST /api/commands/v1/workspaces/acme/imports?mode=commit
Authorization: Bearer <token>
Content-Type: application/x-ndjson
Validation-Token: <validation-token>
Command-ID: 4f25b570-2613-4f43-9644-b22a90aa4230
Idempotency-Key: import-2026-10-11

<the exact validated bytes>
```

The token binds the byte digest, import ID, Workspace, Principal, credential, authority epoch, and
expiry. A changed byte, actor, credential, Workspace, authority epoch, or expired token is rejected.
An identical committed `importId` and digest replays; a changed digest conflicts. Cross-Workspace
owner changes require an explicit owner map in the command dispatcher and never transfer authority.

Workflow-state records include `active`; older files that omit it default to `true`. Archived
states remain inactive through commit, replay, and re-export, including imports into a workflow
already holding 20 active states. Inactive states cannot be defaults. Positions are nonnegative
PostgreSQL integers; inaccessible or incompatible reusable-state/label collisions return typed
`400 invalid_import` without canonical writes or collision metadata.

## Evidence boundary

The route implementations and PostgreSQL tests are local functional evidence. A native Node 24 live
exercise returned `200` for `includeArchived: true` export (44,441 NDJSON bytes) and Project query
(8,699 response bytes), completed export -> validate -> commit -> replay -> re-export with `200`
responses, rejected malformed import with `400`, returned `200` for archive/restore queries, and
released snapshots with `204`. The 10-scenario real-browser suite passed without mocks or skips.
These results do not mark the R4 phase gate or CI complete, and the aggregate `npm run test:r4`
command is not reported as passing.
