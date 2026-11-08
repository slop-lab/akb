# Document-based specifications

Use ordinary AKB Pages for shared guidance, feature briefs, deliberate exceptions, and decision
records. This workflow adds authoring and retrieval conveniences, not a separate SpecBase database,
semantic inheritance engine, schema platform, plugin runtime, or Git synchronization service.

For the live development example, verification results, and remaining evidence limits, see
[document-workflow-delivery.md](document-workflow-delivery.md).

## Human workflow

1. In **Pages**, choose a common-guidance, feature-brief, or decision-record template. The result is
   an ordinary editable Page; using a decision template does not create accepted Knowledge.
2. Keep shared guidance in one Page. A feature brief records intent, observable success, constraints,
   exceptions, exclusions, relevant decisions, and open questions instead of copying all guidance.
3. Discover existing Pages and Knowledge by title. Open their exact revisions before relying on them.
4. Explicitly select the saved Page/Knowledge revisions required for a task. Unsaved editor text is
   not part of that selection. The context reader neither follows links nor infers inherited rules.
5. Save a selection as an ordinary Page to share or revisit it. Reopening checks access to that Page
   and restores its selectors. **Load read-only context** separately checks every referenced source;
   the selection itself is not an access grant or an immutable semantic baseline.
6. Submit useful results through the existing Knowledge proposal API/inbox. A human explicitly
   accepts, rejects, or requests changes. Acceptance does not silently rewrite a source Page.

For a result proposal, cite every actual input returned in `context.references` as an entity source
with its exact revision and role `context`. The saved selection Page may be an additional source,
but citing only that Page does not establish source-access dependencies on the documents listed
inside it. This is explicit provenance, not automatic link traversal or inheritance.

A selected source may no longer be the latest revision. That is intentional: task inputs remain
exact. Selecting the latest revision for a new task is an explicit operation, not automatic sync.

## Agent access

All operations use bearer authentication and an explicit AKB workspace. They do not require an AKB
Run, a fake Work Item, or an agent runtime. Static templates are available with `content.read` or
`content.manage`; template access grants no access to existing document bodies. A context reader needs the read grants for its
selected sources: `content.read` for Pages and `knowledge.read` for Knowledge. Saving ordinary Pages
requires existing `content.manage`; submitting a result requires `knowledge.propose`. Neither read
access nor proposal submission grants `knowledge.accept`, `review.decide`, or `run.delegate`.

| Operation | Owned API |
|---|---|
| List copy-on-create Page templates | `GET /api/content/v1/workspaces/:workspaceId/templates` |
| Find active Page/Knowledge summaries | `GET /api/content/v1/workspaces/:workspaceId/documents` |
| Read explicitly pinned task inputs | `POST /api/content/v1/workspaces/:workspaceId/context` |
| Create/edit an ordinary Page | Existing `/pages` create and `/pages/:pageId` patch commands |
| Submit a result for human review | Existing `/api/knowledge/v1/workspaces/:workspaceId/proposals` |

Discovery takes `kind=page` or `kind=knowledge`, a title `query`, bounded `limit`, and optional
exclusive `afterId`. It is live, ACL-filtered discovery, not snapshot-pinned pagination. Results
contain summaries, not all document bodies. Use an exact context read after selecting a summary.

An explicit context request:

```json
{
  "references": [
    { "kind": "page", "id": "shared-guidance", "revision": 3 },
    { "kind": "page", "id": "feature-brief", "revision": 2 },
    { "kind": "knowledge", "id": "accepted-decision", "revision": 1 }
  ],
  "maxBytes": 65536
}
```

Or read a previously saved selection Page at an exact revision:

```json
{
  "selectionPage": { "id": "task-context-page", "revision": 1 },
  "maxBytes": 65536
}
```

The context contains immutable canonical revision payloads and their kind, ID, revision, schema
version, and revision creation time. It is an explicit selection, not a guarantee that all governing
rules or affected documents were found. `contentBytes` is the UTF-8 size of `JSON.stringify(items)`.
The default budget is 64 KiB; the maximum is 256 KiB. Select at most 25 unique references.

Missing revisions, wrong workspaces, and unreadable sources fail the entire context with a generic
`404 not_found`. The reader never substitutes latest or silently omits a selected source. Invalid
saved selections and exceeded context budgets return explicit `422` errors. Request JSON is limited
to 64 KiB. Authentication and authority locks use existing AKB transactions; a saved manifest does
not retain revoked access to its sources.

## Read-only Part tools

The existing workspace tool bundle exposes `document_templates`, `documents_find`, and
`document_context`. These tools are read-only, including the context tool's HTTP POST. Exact reads
use the bounded context contract rather than loading an unbounded document search result. Credentials
remain supplied by the trusted host transport, not tool arguments, URLs, or generated context.

Page creation/editing and result proposals remain explicit authenticated command APIs. Preserve the
logical command's `commandId`, `idempotencyKey`, payload, and base revision when retrying. For creation,
a caller can supply a stable `pageId`. A stale edit is a conflict, not a request to overwrite latest.

Construct result proposal sources from the exact context, rather than copying document bodies:

```js
const sources = context.references.map(({ id, revision }) => ({
  kind: "entity",
  entityId: id,
  revision,
  role: "context",
}))
```

Send these through the existing Knowledge proposal envelope with a concise candidate. The server
checks provenance again at submission and acceptance; later source-access revocation is not
bypassed by having saved a selection or an earlier context response.

## Native selection representation

A saved selection is a normal Page with exactly one top-level code block named
`akb-context-selection`, language `json`, without children. Its strict payload is:

```json
{
  "format": "akb-context-selection.v1",
  "workspaceId": "workspace-id",
  "references": [{ "kind": "page", "id": "shared-guidance", "revision": 3 }]
}
```

The rest of the Page remains ordinary content. Manual edits are allowed; malformed selection JSON
produces an explicit context error without destroying the Page. The stored workspace must match the
request workspace, and every source is independently authorized. No new entity type, migration,
approval policy, automatic dependency propagation, or acceptance is created by this representation.

For result proposal envelopes, external Work Hub provenance, and human-review authority, see
[work-hub-integration.md](work-hub-integration.md).
