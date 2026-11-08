# ADR-021: pnpm Workspace and QG Quality Gate

- Status: accepted
- Date: 2026-10-29
- Owners: repository maintainers
- Reviewers: tooling, package, and quality reviewers

## Context

The repository began with npm as an accepted bootstrap constraint. It now contains a root workspace,
a separately packable public library, and a QG policy that must run consistently across both. Keeping
npm as the active package manager would conflict with the committed pnpm lockfile, workspace layout,
package scripts, and supported developer workflow.

Historical delivery records and the canonical design baseline contain npm commands that were true for
their recorded revisions. Rewriting those commands would falsify evidence rather than migrate the
current workflow.

## Considered options

- Retain npm for the root and use pnpm only for external Blocks setup. Rejected because it preserves
  two package-manager authorities and cannot use the committed pnpm workspace as the sole install
  contract.
- Allow either npm or pnpm. Rejected because competing lockfiles and workspace resolution make clean
  installs and package verification non-deterministic.
- Adopt pnpm 10.17.1 for the current workspace and preserve old npm commands only in clearly historical
  records. Accepted because it provides one lockfile, one workspace model, and truthful evidence.

## Decision

pnpm `10.17.1` is the package manager for the root `@this-project/akb` workspace. A clean install uses
`pnpm install --frozen-lockfile` with `pnpm-lock.yaml` and `pnpm-workspace.yaml`. The public package is
`@slop-lab/akb-project-kb`; its name describes the package boundary and does not claim that a public
registry publication has occurred.

QG is the top-level quality gate. The CLI applies its `recommendedRules` base automatically. The root
`.qg.yaml` enables the installed optional `js` preset and enforces public package names matching
`@slop-lab/akb(-.*)?` and private names matching `@this-project/.*`. The `package-scopes` check
inventories pnpm workspace packages and cross-checks their `private` flags, so a publishable
`@this-project` package or private `@slop-lab` package fails even though both patterns are generally
allowlisted. The code tools gate runs `pnpm run check:code`; the recommended base does not imply that
every formatter or ecosystem tool is enabled.

`pnpm run check` invokes the full QG gate. Individual scripts remain available for focused local
diagnosis, but they do not replace the full gate when full verification is required.

## Scope and non-goals

This decision supersedes the accepted npm bootstrap decision for current development, packaging, and
quality instructions. It does not rewrite the canonical `agent-first-workspace-v1-design.md`, frozen
migrations, archived commands, or delivery evidence recorded against older revisions. It does not
claim that hosted CI ran, that a roadmap phase passed, or that the public package was published.

The native `node` executable and Node test runner remain unchanged. Blocks continues to use the exact
bootstrap-pinned pnpm version inside its ignored checkout; that external checkout is not a root
workspace package.

## Consequences and verification

Current operator and developer documentation uses pnpm commands without npm's script-argument `--`
separator. Package verification builds and packs `@slop-lab/akb-project-kb` through the workspace
filter. QG configuration is responsible for package-name enforcement and for invoking the repository's
code gate.

Verification requires a frozen-lockfile install and the applicable local commands. A successful local
run is evidence only for those commands; it is not CI, publication, or release evidence.

## Superseded and related decisions

This ADR supersedes the npm row in the accepted bootstrap decisions registry. The historical row
remains in the registry with `superseded` status so the original constraint is not erased.
