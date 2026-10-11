# R4 Human Search Reference

## Endpoint

`POST /api/human/v1/workspaces/{workspaceId}/search`

The endpoint requires the normal workspace bearer credential. The authenticated credential's
workspace must equal `workspaceId`. Search is lexical PostgreSQL full-text search only; it does not
perform embeddings, agent retrieval, remote requests, or URL fetching.

The router factory is:

```ts
createR4SearchRouter(sql, signingKey)
```

`signingKey` must contain at least 32 bytes and must come from server-side secret configuration. It
must not be persisted in application tables, returned by an API, logged, or exposed to browser code.
Compose this route before the historical human router while the old limit-only search branch exists.

## Request

```json
{
  "text": "release blocker",
  "kinds": ["project", "work_item", "comment"],
  "limit": 50,
  "cursor": null
}
```

The body is strict; unknown fields are rejected.

| Field | Contract |
| --- | --- |
| `text` | String, 1 to 500 characters after trimming. Whitespace is canonicalized. |
| `kinds` | One to three values from `project`, `work_item`, and `comment`. Duplicate values are removed and values are canonically ordered. |
| `limit` | Integer from 1 through 100. A continuation must use the same value. |
| `cursor` | Signed opaque string or `null`. It currently defaults to `null` when omitted; clients should send it explicitly before this prototype becomes a shipped compatibility contract. |

## Response

```json
{
  "snapshot": {
    "id": "4b45f490-d435-4f7a-bc44-3477d9023398",
    "expiresAt": "2026-10-11T16:45:00.000Z"
  },
  "results": [
    {
      "id": "work:example",
      "kind": "work_item",
      "title": "Resolve release blocker",
      "sourceRevision": 3
    }
  ],
  "matched": 1,
  "nextCursor": null
}
```

The response is strictly parsed by `SearchPageSchema`. No space identifiers, object-policy data,
comment subjects, references, author names, raw snapshots, or other metadata are returned.

Titles are safe projections from the immutable revision pinned when the snapshot was created:

- Project: revision `name`.
- Work Item: revision `title`.
- Comment: first 100 characters of revision `body`; author and subject data are not included.

`sourceRevision` is the frozen revision represented by the result, not necessarily the entity's
current revision. `matched` counts only authorized candidates. If 100,001 authorized documents
match, the request fails before persisting the snapshot rather than returning a truncated result.

## Ordering And Snapshot Lifetime

The first request performs `websearch_to_tsquery('simple', text)` against authorized
`search_documents`. Results are ordered by `ts_rank_cd` descending and entity ID ascending. The
ordered IDs, kinds, and source revisions are materialized in `human_query_snapshot_items`; moving
rank or mutable current-state ordering is never used for continuation.

Snapshots expire after 15 minutes. Existing database budgets apply: at most eight active snapshots
per principal and 250,000 active snapshot rows per workspace. Each snapshot contains at most
100,000 rows. Expired snapshots are incrementally removed when a new snapshot is created.

Entity edits after materialization do not change IDs, order, titles, or `sourceRevision` in later
pages. A new request with `cursor: null` observes the latest command-maintained search documents.

## Authorization And Cursor Security

Authorization is applied in a materialized CTE before text matching, ranking, counting, or title
projection:

- Projects require `project.read` on the Project entity.
- Work Items require `work.read` on the Work Item entity.
- Comments require `work.read` on the Comment entity. Their current thread subject requires
  `project.read` when it is a Project or `work.read` when it is a Work Item; other subject kinds
  fail closed.
- Private Space grants and restricted entity-policy allowances are enforced by
  `entity_access_allowed`; owner and admin roles do not bypass them.
- Workspace, Principal, Membership, and Credential rows are locked and revalidated in the query
  transaction. Disabled identities, deactivated memberships, revoked credentials, and expired
  credentials fail closed even when the request waited for a lock.

Every continuation rechecks current identity validity, the workspace authority epoch, snapshot
ownership and database expiry, and each page entity's current ACL. The HMAC cursor binds snapshot,
ordinal, search protocol, Principal, Credential, Workspace, canonical text, canonical kinds,
limit, authority epoch/hash, and expiry. A cursor cannot be reused by another actor, credential,
workspace, query, kind set, or page size.

## Errors

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_argument` | Invalid strict body, malformed path encoding, or malformed/forged cursor. |
| `401` | `unauthenticated` | Credential is missing, revoked, expired, or no longer active. |
| `404` | `not_found` | Workspace path does not match the authenticated workspace. |
| `409` | `snapshot_stale` | Query binding, credential, authority epoch, or stored snapshot binding changed. |
| `410` | `snapshot_expired` | Signed or stored snapshot lifetime elapsed. |
| `507` | `query_budget_exceeded` | More than 100,000 authorized documents matched; no snapshot was created. |

## Verification Commands

The focused tests require a disposable PostgreSQL database through `DATABASE_URL`:

```sh
npm run typecheck
npm run build
node --test --test-concurrency=1 \
  build/test/postgres-r4-search-security.test.js \
  build/test/postgres-r4-search-http.test.js
```

The HTTP test composes `createR4CommandRouter` and `createR4SearchRouter` through
`createAuthenticatedPostgresServer`. It proves that real Work Item command updates feed a new
search snapshot while an existing continuation retains its original immutable title and revision.
