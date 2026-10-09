# Security and Quality Contract

## Status

This document defines mandatory security invariants and quality gates. PostgreSQL Work Item HTTP now
has mandatory bearer authentication, active Workspace membership, explicit Workspace Work permission
enforcement, and bounded public/private Space inheritance for Work Items. This is partial R3, not the
full private-object or retrieval ACL architecture. A documented control does not satisfy a
phase gate; executable end-to-end evidence is required. The
[canonical v1 design](../agent-first-workspace-v1-design.md) remains authoritative.

The current process-local adapter defaults to 10,000 current Work Items and 100,000 audit records.
Each effective create or patch consumes one immutable revision/event record pair; history is not
evicted. If an applicable admission budget is exhausted, the command fails before state, history,
events, idempotency records, clock, or ID mutation. HTTP returns `507 budget_exceeded` with the
truthful resource and configured capacity. This is an in-memory all-or-nothing guarantee behind the
application-owned `WorkItemStore`. The PostgreSQL adapter separately commits Work Item state,
revision, semantic event, bounded outbox projection, and destination jobs atomically. Its current
worker delivers only to the durable database inbox with generation fencing and contains no network
sink or full production outbox operations. A worker process reports all claimed, delivered, and
failed counts and exits nonzero whenever a claimed delivery is not durably acknowledged.

## Security invariants

1. The Workspace is the tenant boundary for every object, event, artifact, index entry, cache key,
   receipt, token, and operation.
2. Authentication identifies a Principal; authorization evaluates the Principal kind, membership,
   object scope, inherited grants, private overrides, Run policy snapshot, and requested operation.
3. Authorization is deny-by-default. Missing, stale, unknown, or ambiguous policy data denies the
   operation.
4. Every read and write uses the effective Principal. Runtimes use the Run-scoped Principal and may
   not borrow the requester's, owner's, or installation administrator's authority.
5. Every important write enforces authorization, policy, idempotency, and revision preconditions
   before mutation, then records actor, cause, revision, and event.
6. Secret values, raw credentials, and privileged trace data are never copied into normal context,
   summaries, activity, errors, analytics, or logs.

The implemented PostgreSQL boundary stores only SHA-256 digests of 256-bit opaque tokens, requires
expiry, and maps revoked, expired, unknown, disabled, or deactivated identity to one generic `401`.
It rechecks identity, membership, and grants while holding transaction locks. Runtime Principals
remain ineligible for general workspace tokens until Run-scoped credentials exist.

## ACL before retrieval

ACL evaluation must occur before exact, lexical, semantic, graph, history, or contextual candidate
generation. The same rule applies before relation expansion, summarization, embedding, reranking,
projection, aggregate counting, snippets, and expansion-handle creation. Filtering forbidden items
after search or ranking is not acceptable.

The retrieval pipeline is therefore:

```text
intent and filter
-> authenticated scope and ACL
-> authorized candidates
-> merge, rank, and deduplicate
-> projection
-> item, token, and depth budget
-> omissions and permitted handles
-> receipt
```

Existence, IDs, titles, snippets, relation paths, revisions, timestamps, scores, and counts for
unauthorized objects must not leak. Permission-sensitive totals and omission counts are `unknown`.
Errors must not distinguish an inaccessible object from an absent object unless policy explicitly
permits that disclosure.

ACL and scope apply to source objects before derived work. Embeddings, summaries, search documents,
previews, and caches carry workspace, source revision, and access fingerprints. They are invalidated
when source or access changes and must never be reused across a broader audience. Project
participation does not grant access to Work in a private Space. Receipts, snapshots, cursors, and
expansion handles are provenance or continuation mechanisms, not enduring authorization; every use
rechecks current access.

## Trust and threat boundaries

Instruction precedence is:

```text
platform policy
-> workspace guidance
-> project or object guidance
-> Run directive
-> retrieved untrusted data
```

Retrieved documents, comments, artifacts, search results, tool output, web content, and model output
are untrusted data. Text inside them cannot grant capabilities, change policy, override higher-level
guidance, approve a proposal, or authorize a secret. The boundary is semantic, not formatting-based:
quoted or embedded "instructions" remain data.

The required threat boundaries and controls are:

| Boundary | Primary threats | Mandatory controls |
| --- | --- | --- |
| Client or runtime -> API | Impersonation, malicious agents, stale writes, replay, over-broad tokens | Authenticated Principals, scoped short-lived tokens, operation allowlists, revision checks, idempotency keys, rate limits, and audit events. |
| Run -> capability or secret broker | Privilege escalation and secret exfiltration | Generation-bound capability grants, explicit approval where required, resource policy, brokered operations or constrained credentials, redaction, revocation, and audit. |
| Retrieval -> canonical and derived data | Private-search leakage, prompt injection, count and cache side channels | ACL-before-retrieval, trust precedence, access-fingerprinted caches, non-revealing errors/counts, bounded traversal, and receipts. |
| Webhook or integration -> system | Spoofing, replay, recursion, and supply-chain compromise | Signature verification, nonce/timestamp window, idempotency, scope/event allowlists, retry/dead-letter policy, recursion limits, manifest review, and administrator approval. |
| Artifact upload -> storage or preview | Path traversal, active content, malware, decompression bombs, and cross-tenant access | Server-generated storage keys, digest and size checks, media validation, limits, malware scanning policy, isolated preview, download disposition, and ACL checks on every access. |
| Browser -> rendered content | Stored or reflected script, token theft, and unsafe embeds | Contextual sanitization, CSP, safe URL handling, isolated untrusted content, secure cookies, CSRF protection where applicable, and no secret-bearing client logs. |
| Worker -> external service | Partial delivery, confused deputy, and transaction coupling | Outbox after commit, least-privilege service identity, idempotent consumers, bounded retry, dead-lettering, timeouts, and observable correlation IDs. |
| Extension -> host | Untrusted code, excessive permissions, and unstable internal access | Declarative or out-of-process default, signed versioned manifest, explicit permissions, isolation, network/tool limits, and no stable internal server or React ABI. |
| Model provider -> Run data | Retention, training, region, and accidental disclosure | Provider policy in the Run snapshot, minimum necessary context, secret removal, tenant configuration, auditable model/version, and no authority from model output. |
| Operator -> deployment and backups | Cross-tenant access, data loss, and undetected tampering | Least-privilege operational roles, encrypted transport/storage, structured audit, PostgreSQL PITR, object versioning, digest verification, restore rehearsal, and controlled purge. |

Raw provider transcripts, tool I/O, stdout/stderr, terminal output, and usage are restricted
artifacts with independent ACL and retention. They are not normal activity and are not displayed by
default. Durable semantic activity contains only the minimum reviewed facts needed for collaboration.

## Security behavior by failure mode

- Expired or mismatched cursor, snapshot, lease, token, generation, signature, or capability fails
  closed and returns the corresponding stable error without partial results or mutation.
- An old lease generation cannot write after resume or reassignment, even if its message arrives
  first or carries a new idempotency key.
- Cancellation blocks new capabilities and propagates through bounded child Runs.
- Webhook and automation retries are idempotent; recursion and fan-out are bounded.
- Artifact and attachment paths never derive directly from user-controlled filenames.
- Logs use structured fields and redact authorization headers, cookies, tokens, secrets, sensitive
  query text, and protected content. Correlation IDs must not encode tenant or object secrets.
- Permission changes invalidate affected search projections, summaries, snapshots or continuation
  paths as required to prevent post-revocation access.

## Exact change gates

Once the strict TypeScript product scaffold exists, CI must expose and run these stable npm
entrypoints in this order on a clean checkout using Node.js 24 and the committed lockfile:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` must use Node's native test runner (`node --test`) directly or through an npm script.
Product execution uses the native `node` executable; alternative runtimes are not a hidden CI or
production requirement. `typecheck` runs strict TypeScript with no emitted output. Every command
must exit zero with no ignored type errors, lint errors, focused tests, or silently skipped required
suites. The repository exposes these entrypoints plus `test:unit` and `test:integration`. Their
current success is evidence for the bounded slice, not a claim that R1 or R2 has passed.

The current OpenAPI contract is checked structurally against the exact representable constraints of
the shared Zod input and response schemas. Integration tests exercise stable HTTP statuses and
typed envelopes. These checks cover the current HTTP surface only; agent retrieval and its
snapshot, receipt, cursor, ACL, and runtime contracts remain future work.

The current workspace event route intentionally fails with `403` before reading a page when the
Principal lacks `work.read` in any current private Space. Numeric global sequences cannot safely
represent filtered gaps. Outbox database-inbox delivery is a privileged operator boundary rather
than an end-user API; revocation cannot retract already delivered copies.

Every change must also satisfy these review gates:

- changed behavior has deterministic tests at the lowest useful layer;
- public command, retrieval, event, runtime, artifact, and error shapes have contract fixtures;
- migrations include forward verification and rollback or restore instructions;
- authorization-sensitive changes include positive and negative cases for human, agent, service,
  and runtime Principals as applicable;
- no test assertion depends only on an LLM judgment when a reference, revision, event, omission, or
  structural assertion is possible;
- generated artifacts and vendored output are reproducible and reviewed at their source;
- documentation states planned versus implemented status accurately.

## Required test suites and pass criteria

| Gate | Required coverage | Pass criterion |
| --- | --- | --- |
| Domain | Workflow, rollover, progress, scope, rollup, inverse relations, cycle behavior, archive/retention, revisions, and stale reviews | All invariants hold and rejected commands leave no partial current state, revision, event, or outbox record. |
| Property | Arbitrary command sequences, idempotency, cursor pagination, snapshot stability, traversal budgets, permission changes, and automation termination | No duplicate/missing page items within a snapshot; retries converge; bounds terminate; revoked data never appears. |
| ACL matrix | Entity x operation x role/Principal/scope, including inherited and private overrides and human/agent/service/runtime identities | Every matrix cell has an explicit allow/deny expectation; denial leaks no existence, title, snippet, relation, count, cache, or timing detail beyond the documented envelope. |
| Retrieval fixtures | Known-item recall, relation paths, accepted/superseded knowledge, private isolation, omission, budgets, oversize handling, stale summaries, cursor expiry, receipts, and delta | Expected refs/revisions and structural envelopes match; completeness, omission, cursor, snapshot, size, warnings, and receipt are asserted. |
| Runtime simulator | Lease acknowledgment, duplicate messages, heartbeat loss, generation, cancellation, input/resume, child Runs, artifact chunks, activity idempotency, and capability denial | Old-generation writes and ungranted capabilities are rejected; duplicate delivery has one effect; cancellation and resume reach valid audited states. |
| Transaction integration | Current mutation, revision, event, and outbox under success, conflict, denial, and injected failure | Success commits all four records once; every failure commits none. External delivery occurs only after commit. |
| End to end | Project -> Cycle; delegate -> question -> answer -> Proposal -> review -> apply; document stale write; private search; import -> links -> export; automation -> Run-failure notification | Each scenario completes through the public surface and preserves IDs, revisions, ACLs, provenance, and expected events. |
| Build and packaging | Production compilation, clean install, startup, health, migration, export, and restore artifacts for the implemented phase | Reproducible build from lockfile; supported startup succeeds; artifacts contain no development secrets; phase-specific operational check passes. |

Required suites may be introduced with the phase that implements their surface, but an implemented
surface cannot declare its phase exit gate complete while its corresponding suite is absent,
skipped, flaky, or failing.

## Security and release gates

A release candidate is blocked unless all applicable change gates and test suites pass and the
following evidence exists:

1. threat-model review covers every changed trust boundary and records residual risk;
2. ACL matrix and private-search leakage regressions pass;
3. dependency and container scans have no untriaged critical or high-severity finding;
4. secret scanning finds no credential in source, history under release review, build output, logs,
   fixtures, or artifacts;
5. webhook signature/replay, token expiry/scope, capability denial, lease generation, artifact
   isolation, sanitization/CSP, and rate/depth limit tests pass when those surfaces exist;
6. migration dry-run, backup, restore, and digest-integrity checks pass for a release that changes
   durable schema or storage;
7. structured logs, metrics, traces, audit records, and redaction are manually inspected on the
   end-to-end path;
8. all exceptions have an owner, rationale, expiry, and explicit release approval; exceptions may
   not waive tenant isolation, ACL-before-retrieval, revision safety, or secret handling.

Performance targets are measured under a documented normal-load profile and are not early alpha
release blockers unless a phase gate says otherwise. Security and correctness gates are blockers at
every phase in which their surface exists.
