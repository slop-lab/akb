# R5-R8 Local Delivery and Evidence

## Status boundary

Implementation now extends through the R8 feature and operations layers. The application mounts
the new authenticated route factories in `src/postgres/r4-application.ts`; the web application
consumes these routes rather than fabricating local canonical data. All formal phase gates remain
**In progress**, not passed: hosted CI, release infrastructure, normal-load release measurements,
and the two-month team dogfood requirement have not been completed. These unavailable proofs do
not block independent implementation work and must not be recorded as successful checks.

This inventory describes the implemented paths, not a declaration that every Core/Complete cell
of the canonical design or every deployment/provider combination has been accepted.

## Implemented application surfaces

| Layer | Runtime behavior | Primary source and executable evidence |
| --- | --- | --- |
| Shared foundation | Registered entity kinds, dependency ACLs, serialized dependency-cycle rejection, multi-target atomic commands, reauthorized idempotent replay | `src/entities/command-unit-of-work.ts`; `test/postgres-command-unit-of-work.test.ts`; `test/postgres-feature-foundation-registry.test.ts` |
| Planning | Space Cycles and rollover; Project-local Milestones and many-to-many Modules; work estimates/assignments; leaf-only progress; immutable update metrics; timeline; revision-pinned templates; deduplicated notification inbox/preferences | `src/planning/`; `src/http/planning/`; `test/postgres-planning-http.test.ts` |
| Documents | Nested Pages and stable block trees, Markdown transfer, revision-safe partial edits, history/restore, inline comments, backlinks, presence, archive, stable-link import/export | `src/content/`; `src/http/content/`; `test/content-domain.test.ts`; `test/content-postgres.test.ts` |
| Runtime | Definition revisions, installations/endpoints, Run-scoped credentials, leases/generation fences, cancellation/resume, immutable input/context, semantic activity/plans, bounded artifact chunks | `src/runtime/`; `src/http/runtime/`; `test/postgres-runtime-http.test.ts`; `test/postgres-runtime-revocation.test.ts` |
| Retrieval | ACL-first projections, bounded stable pagination, signed cursors, receipts, and budget-aware delta receipt chains | `src/retrieval/`; `test/postgres-retrieval-budget.test.ts` |
| Human Run inspection | Subject-authorized bounded activity, receipt, and artifact reads without runtime credentials | `src/runtime/reads.ts`; `test/postgres-runtime-human-reads.test.ts` |
| Knowledge | Normalized Claim/Decision/Evidence/Question/Experiment data, noncanonical proposals, revision-pinned decisions, immutable registered review policy, atomic approval, accepted-current search, history and summary freshness | `src/knowledge/`; `test/postgres-knowledge-domain.test.ts`; `test/postgres-knowledge-policy.test.ts` |
| Automation | Intake conversion/disposition; timezone recurrence and DST-gap policy; isolated failed rules; ascending event checkpoints; canonical actions; leased outgoing delivery with stable idempotency | `src/automation/`; `test/testsautomation-r8-http.test.ts`; `test/testsautomation-recurrence-isolation.test.ts` |
| Integrations | Signed/replay-protected GitHub ingestion and mapped canonical updates; immutable extension manifests/approval; pinned-DNS HTTPS delivery rejecting private addresses | `src/http/automation/`; `test/testsautomation-security.test.ts` |
| Analytics | Fixed SQL metrics with relation and Run-subject ACL checks before aggregation | `src/automation/analytics.ts`; `test/testsautomation-analytics.test.ts` |
| Operations | Non-root Node 24.22/PostgreSQL 17 image, explicit migration startup gate, bounded worker, encrypted authenticated backups, retention, immutable profile 016, restore quarantine and forward upgrades | `compose.yaml`; `Dockerfile`; `docs/r8-operations.md`; `test/postgres-r8-operations.test.ts` |

Planning changes preserve the complete `work-item.r4.v1` snapshot and legacy revision/event bridge,
so assignment and rollover do not remove existing Work Items from R4 detail, list, or board queries.
Migration files 001-010 and legacy backup-profile pins remain unchanged. Migration 016 is frozen at
SHA-256 `d4381bb1fcda3ccee51d4b058c017830386b6a7e5509996d7b60b3e6dae1e24d`.

## Blocks and Part boundaries

Blocks is checked out locally at commit `c2eb16e929a99a9d9660900ea5c669b0daa2a167` under ignored
`.deps/blocks`. Only `apps/web/src/vendor/blocks/` imports its unstable packages. Canonical content
contracts stay application-owned. See [Blocks setup](blocks-integration.md); setup refuses dirty
checkouts rather than overwriting local changes.

Part packages remain pinned to `0.1.0`. The existing trusted-host CLI is separate from the durable
Run protocol. `app/runtime-worker.mjs` and `src/runtime/adapters/part/` connect Part execution to
Run-scoped callbacks; Workspace credentials must never be substituted for Run credentials.

The web shell provides Planning, Pages, Runs, Knowledge, and Automation. Blocks editing, conflict
recovery, revision history, proposal decisions, and integration forms use server contracts.
Pages and the authenticated shell are lazy-loaded so the editor is not part of login first paint.

## Setup and operator authority

```sh
npm ci
npm run setup:blocks
npm run migrate:postgres
npm run build:r4
npm run start:r4
```

Use Node.js 24.22.0 or newer. Supply database/signing secrets privately as described in the
[R4 runbook](r4-local-runbook.md) and [R8 operations runbook](r8-operations.md).

Existing owners retain their prior grants after upgrade. Operators explicitly assign feature
permissions through `npm run admin -- set-permissions`, `provision-principal`,
`set-space-permissions`, and `set-entity-access`. These commands accept all registered permission
atoms. `set-permissions` replaces the full grant set; include every permission to retain.
`grant-r4-permissions` intentionally remains the original 15-permission bundle. No migration
silently grants newly introduced authority.

## Reproducible verification

```sh
npm run check
npm run web:typecheck
npm run web:test
npm run web:build
npm run test:features:postgres  # requires DATABASE_URL; isolated disposable schemas
npm run test:postgres
npm run test:r4
npm run test:backup            # requires PostgreSQL 17 clients and database creation authority
docker compose config --quiet
```

Local evidence captured during implementation includes:

- full format/lint/strict compile/build and the existing 66 unit, 40 integration, and 30 Part tests;
- independent real-PostgreSQL cross-feature runs, including 40 foundation/planning/content/runtime/
  retrieval/knowledge tests before the later focused security regressions;
- 9 automation tests including real HTTP, concurrency, recurrence failure isolation, DNS policy,
  webhook ingestion, canonical effects, and ACL-filtered analytics;
- 14 operations checks, profile-016 encrypted restore, active-authority quarantine, exhaustive table
  catalog comparison, and legacy restore compatibility against PostgreSQL 17;
- real Chrome feature workflows and responsive captures at 375, 768, and 1280 pixels; and
- a parent-driven browser Page create/edit/save that advanced revision 1 to 2 while keeping browser
  local/session storage empty.

Counts belong to those named runs and must not be summed as a distinct-test release total.
LSP installation was previously declined; compiler and CLI Biome checks supply static evidence.

The final named local runs passed: `check` (66 unit, 40 integration, 30 Part, and 26 feature
tests), `test:features:postgres` (44), `test:postgres` (72), and `test:r4` (15 contract plus 165
PostgreSQL tests). The R4 scale run initially exposed excessive per-row recursive ACL work;
set-based dependency authorization repaired the regression without changing migrations, ACL
semantics, budgets, or timeouts. The complete R4 PostgreSQL rerun passed in 244.8 seconds.
This is a large-fixture regression result, not proof of production latency targets.

The final UI gate reviewed all 25 fresh PNGs independently in two passes: fifteen route frames
across the three exact viewports, six mutation-state frames, and four declared detail crops.
Both returned PASS after fixing tablet navigation, Page geometry/CJK wrapping, revision-conflict
context, independent Run pagination, and pending intake submission guards. Four Playwright
scenarios exercise real feature workflows and the pagination contract; endpoint interception in
the pagination fixture is not substituted for the separate live PostgreSQL API tests.

## Open external acceptance gates

| Gate | Current disposition |
| --- | --- |
| Hosted CI and release signing | Incomplete; do not block independent local implementation |
| Live hosted model and GitHub account compatibility | Local wire/provider fixtures verified; external credentials/account acceptance incomplete |
| Full bind-mounted Compose deployment on the remote daemon | Image build, non-root runtime, and config verified; daemon cannot resolve local secret mounts |
| Off-host encrypted/versioned backup and WAL shipping | Configuration and local recovery verified; independent storage/infrastructure rehearsal incomplete |
| PITR RPO/RTO and production normal-load targets | Not established by logical backup or local browser tests |
| Two-month 5-20-person dogfood | Requires elapsed real team usage; not simulated |
| Full release accessibility/security program | Targeted browser and security regressions exist; these are not an independent release certification |

These are acceptance gaps, not permission to waive authorization, revision, tenant-isolation,
artifact-integrity, or worker-progress defects. Such defects were corrected before delivery.
