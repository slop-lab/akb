# @slop-lab/akb-project-kb

A lightweight project notebook UI and typed AKB client for music, game maps, and other creative or
production work. This is independent of the specification/Task context UI. It reuses ordinary AKB
Pages, revisions, and authority; it is not another database, a DAW, a map editor, or an inheritance engine.

## Install and import boundaries

Build and pack from this repository:

```sh
pnpm install --frozen-lockfile
pnpm run package:build
pnpm --filter @slop-lab/akb-project-kb pack
# In the consuming application:
pnpm add /path/to/slop-lab-akb-project-kb-0.1.0.tgz
```

The package is locally packable, not published to a public registry by this delivery. It ships ESM
JavaScript and TypeScript declarations, with React 19 as a peer dependency for the UI.

| Import | Intended consumer |
|---|---|
| `@slop-lab/akb-project-kb/contracts` | Shared schemas, document types, creative templates and URL builder |
| `@slop-lab/akb-project-kb/client` | Browser-safe client and transport; no environment or token persistence |
| `@slop-lab/akb-project-kb/server` | Trusted Node server/BFF; caller-supplied per-request credential provider |
| `@slop-lab/akb-project-kb/react` | Embeddable project notebook UI |
| `@slop-lab/akb-project-kb/styles.css` | Namespaced standalone component styles, overridable with host tokens |

Server credentials must never be imported into client code. A BFF must authenticate its own caller
and enforce workspace/project scope before forwarding requests. Do not expose an unrestricted proxy
using an administrator token. AKB authorizes each operation; an external app's login is not itself
an AKB grant. Cross-origin browser deployment requires an appropriately secured same-origin proxy
or operator-managed CORS; the package does not weaken AKB's origin policy.

## Server integration

```ts
import { createServerProjectKbClient } from "@slop-lab/akb-project-kb/server"

const kb = createServerProjectKbClient({
  baseUrl: "https://your-akb.example",
  workspaceId: "studio",
  token: async () => credentialsForAuthenticatedCaller(),
})
const { notebook } = await kb.getNotebook("album-project")
if (notebook !== null) {
  const documents = await kb.listPages(notebook.id)
}
```

AKB must run the project-KB routes and migrations through 018. The SDK is not a storage server or migration
runner. It can read existing notebooks or initialize one with
`kb.createNotebook(projectId, { title: "Album notebook" })`.

## Browser integration

Use the application's authenticated HTTP transport, or the provided bounded HTTP transport with
an in-memory, user-scoped token provider:

```ts
import { createProjectKbClient, createHttpTransport } from "@slop-lab/akb-project-kb/client"

const kb = createProjectKbClient({
  workspaceId: "studio",
  transport: createHttpTransport({
    baseUrl: window.location.origin,
    token: () => currentSessionToken(),
    onUnauthorized: () => signOut(),
  }),
})
const page = await kb.createPage({
  parentPageId: notebook.id,
  title: "Opening cue",
  templateId: "music-brief",
})
await kb.savePage({ ...page, title: "Opening cue: second pass" })
```

`getPage(id, revision)` reads an exact saved revision. Mutations fetch their committed revision,
not whatever happens to be latest after the command completes. Save requires the original revision;
a concurrent edit returns a conflict instead of silently overwriting it. The optional command identity
argument preserves `commandId` and `idempotencyKey` for a deliberate retry of the same logical write.
Transports disable automatic retries and redirects. Tokens are not put in paths, document bodies,
storage, or generated template content.

## React integration

Import `ProjectNotebook` from `@slop-lab/akb-project-kb/react` and the stylesheet, then supply `client`,
`projectId`, and `projectName`. The component can use its data-preserving block-text editor, or a
host-supplied `renderEditor` for richer editing. AKB's host uses its existing Blocks editor. Project
selection and authentication belong to the host so external apps can use their own project picker.

Templates: `blank`, `project-overview`, `music-brief`, `map-brief`, `experiment-log`, and `decision`.
They are editable starting points, not accepted Knowledge or executable domain schemas. Record paths
or URLs to DAW/engine assets in the document; this package does not upload or edit those binary files.

## Scope and authority

Each AKB Project has at most one notebook root. Its durable association is independent of editable
Page text. The root depends on Project read access; child Pages inherit access through their parent.
Creating the root requires `project.manage` and `content.manage`; reading requires `project.read`
and `content.read`. Ordinary document writes require `content.manage`. The SDK's create helpers also
read the resulting Page, so callers using those helpers need the corresponding read grants.

The library lists direct child Pages using the existing ACL-filtered, bounded Page API (up to 500).
It is not full-text search, automatic Knowledge acceptance, file synchronization, or a second
project-permission system. Explicitly reparenting a child with the generic Page API changes its
membership in the notebook; a notebook root's Project association itself is immutable.
