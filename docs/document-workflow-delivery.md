# Practical document workflow: local delivery evidence

This records local verification on 2026-10-28 for product source `7c32a1f`, on
`feat/practical-document-workflow`, based on `9c43114`. It is not a formal R1-R8 phase
completion, hosted-CI result, production audit, or two-service Work Hub acceptance claim.

## Try the delivered workflow

- Application: <https://akb--akb-app.mj-y.com/>, workspace `akb-dev`.
- [Example shared guidance, revision 2](https://akb--akb-app.mj-y.com/workspaces/akb-dev/pages/page%3A83158c96-28e8-4608-ba54-613f99b8553c?revision=2).
- [Example saved task selection, revision 1](https://akb--akb-app.mj-y.com/workspaces/akb-dev/pages/page%3A61777f55-9c19-447e-8ce9-aa2b191a25bf?revision=1).

These are development records, not portable fixtures. A fresh deployment must create its own
workspace, principals, and documents. The local development credentials are kept only in the ignored
`secrets/workflow-principals.json` file, mode `0600`, and expire at
`2026-10-29T09:08:25.003Z`. Do not commit or paste that file. Use the existing administrator CLI
to issue replacement credentials when necessary; application login keeps tokens in memory only.

In **Pages**, create an ordinary Page from a template, edit and save it, then expand **Task context**.
Search for sources, select their exact saved revisions, and save the selection as a Page.
A separately authenticated reader can reopen that selection and choose **Load read-only context**.
Copy credential-free agent request JSON or exact proposal sources from the panel. Results still
require an explicit Knowledge proposal and human review; this workflow never accepts them itself.

See [document-workflow.md](document-workflow.md) for permissions, API shapes, byte limits, selection
representation, and the read-only `document_templates`, `documents_find`, and `document_context`
Part tools. Shared rules are documents, not inferred inheritance or an automatically complete baseline.

## Verification performed

The npm command spellings below are preserved as historical evidence for the recorded 2026-10-28
run. Current development uses the pnpm workflow in [local-development.md](local-development.md).

| Gate | Observed result |
|---|---|
| `npm run check` | Passed formatting, lint, native types, build, unit/integration/agent/feature gates |
| `npm run test:features:postgres` | 68 passed, zero failures |
| `npm run web:typecheck` | Passed |
| `npm exec tsc -- --noEmit -p tsconfig.browser.json` | Passed |
| `npm run web:test` | 18 passed |
| `npm run web:build` | Passed production build |
| `node script/generate-api-r4.mjs --check` | Passed |
| Focused authenticated HTTPS Playwright run | 11 passed, zero failures |
| Production Docker build and authenticated API driver | Health/templates/discovery/context `200`; budget rejection `422`; exact sources and `no-store` checked |
| Separate author/reviewer manual browser flow | Created and edited templates, saved exact selection, reopened after fresh login, loaded context, and exercised connector API |
| Responsive evidence and independent visual review | Nine fresh 375/768/1280 captures; zero horizontal overflow or runtime errors; both reviewers passed |

The 11 browser scenarios cover template-to-proposal human review, the existing Work Hub-shaped
workflow and explicit outage handling, obsolete discovery/Page/context responses, byte-budget
invalidation, commit-time modal/shortcut locking, and delayed save/restore/conflict responses after
Page navigation. The delayed save and restore cases failed before mutation fencing and passed after
it; a successful server mutation is not canceled merely because its originating Page is no longer
selected.

The full `check` and PostgreSQL runs passed before the final three-line redundant-state cleanup.
After that cleanup, affected-file formatting/lint, web types, all 18 web tests, the production web
and Docker builds, all 11 browser scenarios, the API driver, and the manual captures passed again.
No backend behavior changed in that cleanup.

## Local evidence and limits

Local, ignored evidence is under `.omo/evidence/practical-documents/`: `manual-result.json` and
`{guide-editor,template-dialog,saved-context}-{375,768,1280}.png`. Command logs are under
`/home/dim/tmp/akb-final-{check,postgres,docker-build}.log`; final Playwright artifacts are under
`/home/dim/tmp/akb-final-browser-qa`. These paths are evidence on the development machine, not
artifacts bundled into the Git branch.

Five independent review lanes covered goal/constraints, code quality, security, caller/gate context,
and hands-on QA. Review findings were fixed and rechecked; the final code and both fresh visual
passes reported no blockers. Existing migrations, legacy `docs/openapi.json`, and the ignored pinned
Blocks checkout were not changed.

TypeScript LSP was unavailable and installation had previously been declined, so native `tsc` and
Biome were used instead. No Lighthouse score, pixel-reference fidelity, or CJK precision result is
claimed. An early Chromium run hit tab/compositor failures with Docker's default 64 MiB shared
memory; a fresh QA browser with 1 GiB shared memory completed the final serial runs without changing
product assertions. Hosted CI, external-account deployment, and formal release gates remain open.

For independent reproduction, follow [local-development.md](local-development.md), provide the
Playwright fixture environment described in `test/browser/fixtures.ts`, and run the five browser
suites `operational-pages`, `document-navigation-races`, `document-workflow-races`,
`document-mutation-races`, and `work-hub-flow`. Review and run the appropriate CI/release gates before
merging; these local results are not approval to bypass them.
