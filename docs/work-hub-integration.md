# Work Hub connector contract

This contract covers the bounded AKB half of the integration. Work Hub owns tasks, attempts, and
results. AKB owns Pages, Knowledge proposals, human review, and accepted Knowledge revisions. A
reference between them is provenance only: it does not mirror Work Hub state, fetch a permalink,
complete a task, or grant authority in either service.

## Installation mapping and authentication

Each connector installation must configure an explicit tuple of AKB origin, AKB workspace ID,
Work Hub service-instance ID, Work Hub workspace ID, and (when applicable) Work Hub project ID.
Names and titles are display data, never identity.

Human deep links encode that workspace identity explicitly:

- `/workspaces/:workspaceId/pages/:pageId?revision=:revision`
- `/workspaces/:workspaceId/knowledge/:knowledgeId?revision=:revision`
- `/workspaces/:workspaceId/proposals/:proposalId` and `/workspaces/:workspaceId/proposals`

Percent-encode identifiers as path segments. Login preserves the selected item and revision and
locks the workspace to the qualified link. Invalid revision parameters render an error, never
latest content. Tokens are never part of these links.

All routes below require `Authorization: Bearer <token>`. Keep credentials outside URLs, proposal
payloads, logs, and source control. The Work Hub service principal needs only:

- `content.read` to read Page context;
- `knowledge.read` to read accepted Knowledge context; and
- `knowledge.propose` to submit a result proposal.

Do not grant the connector `knowledge.accept`, `review.read`, `review.decide`, `run.delegate`, or
`run.inspect`. Human reviewers retain their normal `review.read`, `review.decide`, and (for an
accept decision) `knowledge.accept` grants plus read access to every AKB provenance dependency.

## Exact context reads

Paths are workspace scoped and return `404 not_found` for a wrong workspace, missing revision,
missing grant, or revoked entity dependency.

| Purpose | Route | Response |
| --- | --- | --- |
| Current Page | `GET /api/content/v1/workspaces/:workspaceId/pages/:pageId` | `{ "page": Page, "projection": object }` |
| Exact Page revision | `GET /api/content/v1/workspaces/:workspaceId/pages/:pageId/revisions/:revision` | `{ "page": Page }` with the requested positive revision |
| Current Knowledge | `GET /api/knowledge/v1/workspaces/:workspaceId/objects/:knowledgeId` | `KnowledgeObject` |
| Exact Knowledge revision | `GET /api/knowledge/v1/workspaces/:workspaceId/objects/:knowledgeId/revisions/:revision` | `KnowledgeObject` with the requested positive revision and its accepted provenance |

Exact reads use direct `(entity ID, revision)` database predicates; they do not scan history or
substitute the latest revision. Page and Knowledge history endpoints remain reviewer/user aids and
are bounded to 500 newest revisions.

## Submit a Knowledge proposal

`POST /api/knowledge/v1/workspaces/:workspaceId/proposals` uses the standard strict command
envelope:

```json
{
  "commandId": "caller-generated-id",
  "idempotencyKey": "stable-per-logical-submit",
  "baseRevision": null,
  "payload": {
    "targetId": "knowledge-id",
    "action": "knowledge.create",
    "baseRevision": null,
    "candidate": {
      "type": "claim",
      "title": "Connector result",
      "statement": "The requested connector change passed its acceptance checks.",
      "status": "proposed",
      "confidence": 0.9,
      "validityScope": "work-hub result result-42"
    },
    "sources": [],
    "relations": [],
    "profileId": null,
    "profileRevision": null,
    "inputRevision": null
  }
}
```

The complete JSON command envelope is limited to 64 KiB. The boundary is strict: unknown fields,
invalid candidate variants, more than 100 sources or relations, unpaired profile ID/revision,
unsafe external permalinks, and create/revise base-revision mismatches return
`400 invalid_argument` with field errors. Candidate text fields also have their schema-specific
length limits; connectors should submit a concise captured excerpt and keep large artifacts in the
authoritative source service.

For `knowledge.revise`, the payload `baseRevision` pins the current Knowledge revision. The command
envelope remains `baseRevision: null` because the command creates a new proposal entity. Reusing an
idempotency key with the same parsed command fields returns the recorded result with
`replayed: true`; reusing it for changed command, route, target, or payload fields returns
`409 idempotency_conflict`. Stale Knowledge acceptance returns `409 revision_conflict`. Submission
never accepts the proposal.

### External Work Hub provenance

An external source has this strict shape:

```json
{
  "kind": "external",
  "serviceInstanceId": "work-hub:local",
  "resourceKind": "result",
  "resourceId": "result-42",
  "version": {
    "kind": "digest",
    "algorithm": "sha256",
    "value": "64-lowercase-hex-characters"
  },
  "permalink": "https://work-hub.example/results/result-42",
  "excerpt": "Optional captured result excerpt",
  "role": "supporting"
}
```

`version` is either `{ "kind": "revision", "value": "exact-revision" }` or the SHA-256 form
above. Permalinks must be HTTP(S), at most 2048 characters, and contain no username or password.
AKB stores but never dereferences them. `resourceKind` is normally `task`, `attempt`, or `result`;
the connector must use the authoritative Work Hub ID and exact version/digest, not a title.

AKB persists external entries in the proposal JSON payload, carries them into the human review
evidence, and writes the full typed source into the immutable accepted Knowledge revision snapshot.
Existing migrations `001` through `016` remain unchanged.

## Human proposal inbox and decision

These routes are for the AKB review UI, not the Work Hub connector:

- `GET /api/knowledge/v1/workspaces/:workspaceId/proposals?status=pending&limit=50` returns
  `{ "proposals": KnowledgeProposalSummary[] }`; status is one of `pending`, `accepted`,
  `rejected`, or `changes_requested`, and limit is 1–100.
- `GET /api/knowledge/v1/workspaces/:workspaceId/proposals/:proposalId` returns
  `{ "proposal": KnowledgeProposal }`, including candidate, ordered sources, relations,
  proposer ID, creation time, status, and proposal revision.
- `POST /api/knowledge/v1/workspaces/:workspaceId/proposals/:proposalId/reviews` uses a command
  envelope with proposal `baseRevision` and the built-in `{ "policyId": "human-review",
  "policyRevision": 1 }` decision payload.

Proposal creation and review decisions have independent idempotency keys. Retrying the exact same
decision envelope returns the original receipt with `replayed: true` and does not create a second
review or Knowledge revision. Reusing the decision key with changed fields returns
`409 idempotency_conflict`. Replay rechecks the caller's current grants and entity dependencies;
after permission or source-access revocation, the same retry returns `404 not_found` rather than
revealing or reapplying the recorded result.

Inbox/detail queries require `review.read` and apply the proposal entity ACL plus every linked AKB
source/target dependency. Revoking source access removes the proposal from reads and prevents an
accept decision from laundering previously visible context. Reject and changes-requested decisions
do not mutate canonical Knowledge.

## Connector failure handling

- `400 invalid_argument`: reject the local request; the submitted schema or path is invalid.
- `401`: refresh or replace the AKB credential out of band.
- `403 permission_denied`: the principal cannot perform the requested action; do not broaden a
  connector's grants to bypass a human decision. A connector review attempt is denied this way.
- `404 not_found`: treat as unavailable context/authority, including revocation and wrong mapping;
  do not retry with broader grants.
- `409 revision_conflict`: refresh the explicitly selected context or ask the human to rebase.
- `409 idempotency_conflict`: allocate a new key only for a genuinely different logical command.
- Network/service unavailable: retain the Work Hub result and retry the same idempotent submit;
  never create fake AKB Work Items/Runs or mark knowledge accepted locally.
