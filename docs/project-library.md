# Project library

**Project library** is an independent area of AKB for lightweight project knowledge: musical intent,
map design, production constraints, references, experiments, decisions, and next steps. It is not
the Pages specification/Task context screen and does not create a separate SpecBase service.

## Start using it

1. Create a Project in **Projects**, or use an existing Project you can read.
2. Open **Project library** and choose the Project. Initialize its notebook if it does not have one.
3. Create a document from **Composition brief**, **Game map brief**, **Project overview**,
   **Experiment log**, **Creative decision**, or **Blank note**.
4. Edit the title and document, then save. Changes are ordinary revisioned Pages; a stale write is
   rejected, retains the local draft, and requires an explicit reload before trying again.
5. Reopen the Project library to continue. Other Projects have their own notebooks and document lists.

For music, keep the album/cue direction, tempo/key/meter, arrangement, instrumentation, sound/mix
intent, listening feedback, and DAW file references. For game maps, keep intended player experience,
critical routes, traversal/scale rules, encounter pacing, visual language, engine file references,
and playtest observations. Templates are editable starting points, not rigid domain schemas.

Audio, DAW sessions, engine scenes, and map binaries remain in the application's chosen asset store.
Record their paths or links in the notebook; the library does not edit, synchronize, or preview them.
Saving a note or decision does not submit or accept canonical Knowledge.

## UI and package separation

The library has its own navigation entry, URL area, project selection, and notebook/document UI.
It does not embed specification templates or the Task context tray. The existing Pages and Knowledge
surfaces remain available independently.

The UI is exported by the separate public `@slop-lab/akb-project-kb` workspace package; AKB itself
consumes that package. External productivity applications can import:

```ts
// Shared contracts and starting documents:
import { documentFromTemplate } from "@slop-lab/akb-project-kb/contracts"
// Browser-safe authenticated transport integration:
import { createProjectKbClient } from "@slop-lab/akb-project-kb/client"
// Trusted server/BFF only:
import { createServerProjectKbClient } from "@slop-lab/akb-project-kb/server"
// Embeddable React UI and its optional standalone styling:
import { ProjectNotebook } from "@slop-lab/akb-project-kb/react"
import "@slop-lab/akb-project-kb/styles.css"
```

Do not import a server token provider into browser code. External applications supply their own
authentication and Project picker; AKB remains the authority for every request. See the
[package integration guide](../packages/project-kb/README.md) for working server/client examples,
local tarball installation, retry identity, and deployment/security boundaries. The package is not
published to a public registry by this change.

## Storage, access, and APIs

Migration `017_project_notebooks.sql` adds the one-to-one Project-to-notebook association, and
`018_project_notebook_retention.sql` prevents deleting that assignment to bypass immutability.
The notebook and its children are ordinary Pages, so existing content editing, revision history,
exact context reads, and access checks remain applicable. A dependency from the notebook to its
Project prevents generic Page APIs from bypassing Project read access. The association itself is
not stored in editable Page text and survives ordinary edits and historical restores.

| Operation | API |
|---|---|
| Find the Project's notebook | `GET /api/project-kb/v1/workspaces/:workspaceId/projects/:projectId/notebook` |
| Initialize its notebook | `POST /api/project-kb/v1/workspaces/:workspaceId/projects/:projectId/notebook` |
| List direct documents | Existing `GET /api/content/v1/workspaces/:workspaceId/pages?parentPageId=:notebookId` |
| Create/edit/read documents | Existing ordinary Page command and read APIs |

GET returns `{projectId, notebook}` with `notebook: null` when a visible Project has no notebook.
POST uses the standard actor-free command envelope with `baseRevision: null` and
`payload: {title}`. The notebook Page, association, authorization dependency, event, and command
receipt are committed together. Preserve the logical command's ID/key for retry; do not issue a new
initialization command to retry an uncertain result.

Notebook reads require `project.read` and `content.read`. Initialization requires `project.manage`
and `content.manage`. Editing child Pages uses existing `content.manage`; it does not grant Project
administration. Project read restrictions continue through the notebook and its descendants. Read
and write capabilities are not inferred from an external application's project membership.

No notebook reassignment or deletion operation is introduced. Explicitly reparenting an ordinary
child Page through the generic Page API changes its notebook membership. Direct lists use the
existing bounded Page read (up to 500 ACL-visible entries); this is not full-text project search.
Backup profile 018 includes the new association and retention guard while preserving older immutable profiles and
registered upgrade recovery paths.

## Developer verification

```sh
pnpm run package:test
pnpm run web:typecheck
pnpm run web:test
pnpm run check
DATABASE_URL=... pnpm run test:features:postgres
DATABASE_URL=... pnpm run test:backup
```

Use the Node/PostgreSQL versions and setup in [local-development.md](local-development.md).
Package verification packs a tarball, installs it in an isolated consumer, imports server/client
contracts without React, and checks the optional React entrypoint independently of AKB source paths.
Authenticated browser scenarios are in `test/browser/project-library.spec.ts`.

## Development examples and delivery evidence

The running development application at <https://akb--akb-app.mj-y.com/> has editable examples in
workspace `akb-dev`:

- [Composition studio](https://akb--akb-app.mj-y.com/workspaces/akb-dev/library?projectId=project%3A33130237-862e-42a4-9edd-104e6c92ee04&pageId=page%3A724fa679-0c46-4c51-9ee9-5ed63edf4c51).
- [Game map workshop](https://akb--akb-app.mj-y.com/workspaces/akb-dev/library?projectId=project%3Aa0ab0b3d-72a3-47b2-8282-f4eff3822ac2&pageId=page%3A5b8a3a6a-614a-409f-978b-ee4c68ae1c30).

These are development records, not portable seed IDs. Local development credentials are in the ignored
`secrets/project-kb-principals.json`, mode `0600`, expiring `2026-10-30T09:27:35.115Z`. Existing
credentials and grants were preserved. Never commit that file or copy a server credential into a
browser bundle.

Local verification on 2026-10-29 passed the full `check` gate, 73 PostgreSQL feature tests,
34 backup/recovery tests, eight migration tests, 29 web tests, web/browser TypeScript checks, production
web and Docker builds, and isolated tarball-consumer imports. Fifteen authenticated HTTPS browser
scenarios passed, including server-committed notebook/create/save operations whose first response
was deliberately disconnected: retries reused the same command without duplicate documents or
extra revisions. Older backup profiles recover through 018 with preserved document mappings and
accurate quarantine reports.

Eighteen fresh screenshots cover the project picker, empty library, composition overview/editor,
map editor, and conflict recovery at 375/768/1280. All report zero horizontal overflow and runtime
errors. Enabled primary-button text measured 7.28:1 contrast. Independent integration and visual
reviews passed after their findings were fixed. Local evidence is under
`.omo/evidence/project-kb/`; command logs are `/home/dim/tmp/akb-project-kb-*.log` and browser results
are `/home/dim/tmp/akb-project-kb-final-browser`. These ignored machine-local paths are not part of
the package or a portable Git checkout.

TypeScript LSP was unavailable because installation had previously been declined; native `tsc` and
Biome were used. No hosted-CI, public package publication, Lighthouse score, pixel-reference
fidelity, CJK precision, or formal product-phase completion is claimed.
