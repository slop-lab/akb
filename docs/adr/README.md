# Architecture Decision Record Registry

## Purpose and authority

This directory is the registry for architecture decisions. The
[canonical v1 design](../../agent-first-workspace-v1-design.md) identifies candidate decisions but
explicitly does not approve them. A candidate becomes an accepted architecture decision only when
its dedicated ADR is reviewed, records consequences and alternatives, and changes status to
`accepted` in this registry.

Dedicated records now accept ADR-002 and the current-HTTP portion of ADR-004. Their scope is the
bounded in-memory Work Item command model and its current HTTP contract. Acceptance is a binding
design decision, not a claim that R1, R2, or any future roadmap gate is complete.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `proposed` | Under consideration; informative for design work but not approved. |
| `accepted` | Approved and binding for new work until superseded. |
| `rejected` | Considered and declined; retained with rationale. |
| `deprecated` | Previously accepted but no longer recommended for new work. |
| `superseded` | Replaced by a named later ADR. |

Changing a status requires review and a recorded rationale. Editing a title in this index does not
approve a proposal. Implementation does not silently create an architecture decision; if shipped
behavior conflicts with an accepted ADR, the code or the decision must be reconciled explicitly.

## ADR Registry

| ADR | Title | Status |
| --- | --- | --- |
| ADR-001 | Entity registry plus specialized tables | `proposed` |
| [ADR-002](ADR-002-current-state-revision-event.md) | Current state plus revision and event | `accepted` |
| ADR-003 | Stable blocks plus Markdown | `proposed` |
| [ADR-004](ADR-004-openapi-and-agent-retrieval.md) | OpenAPI now, agent retrieval protocol later | `accepted` |
| ADR-005 | Optimistic HTTP plus events | `proposed` |
| ADR-006 | PostgreSQL-first search | `proposed` |
| ADR-007 | Scoped, out-of-process runtime | `proposed` |
| ADR-008 | Declarative and out-of-process plugins | `proposed` |
| ADR-009 | Proposals for high-risk changes | `proposed` |
| ADR-010 | One accountable human owner plus delegates | `proposed` |
| ADR-011 | Space-owned Cycles and cross-Space Projects | `proposed` |
| ADR-012 | Inherited and private ACL evaluated before retrieval | `proposed` |

The accepted ADR-004 scope is intentionally partial: current HTTP OpenAPI is accepted and present;
agent retrieval remains future R6 work. The other entries preserve their proposed status.

## Accepted bootstrap decisions

The following repository bootstrap decisions are accepted constraints recorded separately from the
numbered ADRs.

| Decision | Status | Scope and consequence |
| --- | --- | --- |
| Node.js 24 | `accepted` | Node.js 24 is the supported execution and CI major version for product work. Pinning and upgrade policy must preserve this major-version contract. |
| npm | `accepted` | npm is the package manager. Dependency installation uses the committed npm lockfile and `npm ci` in CI; another package manager must not create a competing lockfile. |
| Native Node.js execution | `accepted` | Product entrypoints run with the native `node` executable. `app/server.mjs` composes the current TypeScript server but does not define the future product architecture. |
| Native Node.js tests | `accepted` | The test harness uses Node's native test runner, `node --test`, directly or behind `npm test`. Introducing another test runner requires a decision change. |
| Strict TypeScript | `accepted` | Product source and tests use strict TypeScript; the small `.mjs` entrypoint only composes the server. |
| No database in the first slice | `accepted` | The first vertical slice uses an in-memory persistence adapter behind application ports. Data is disposable and this does not satisfy durability or production-readiness requirements. PostgreSQL remains the planned durable adapter. |

The accepted bootstrap decisions define toolchain and initial-slice constraints only. Current
artifacts are listed in the repository README; PostgreSQL and later product surfaces remain future.

## ADR file requirements

A future ADR file must include:

- title, status, date, owners, and reviewers;
- context and the decision to be made;
- considered options and reasons for rejection;
- decision, scope, and explicit non-goals;
- security, data, operational, migration, and compatibility consequences;
- implementation and verification conditions;
- superseded or related decisions.

Use immutable numeric identifiers. Never reuse a rejected or superseded number. A replacement links
both directions and updates this registry in the same change.
