# Blocks integration

The web application consumes a pinned local checkout of
[`slop-lab/blocks`](https://github.com/slop-lab/blocks) at
`c2eb16e929a99a9d9660900ea5c669b0daa2a167`. The checkout is development input, not vendored
source: it lives under ignored `.deps/blocks`, and generated package output stays there.

## Bootstrap

Run the bootstrap before web typechecking, testing, or building:

```sh
npm run setup:blocks
```

`script/setup-blocks.mjs` clones only when `.deps/blocks` is absent, verifies the expected origin,
and refuses to touch an existing non-Git path or a checkout with tracked or untracked changes. When
the checkout already has the pinned commit, it does not fetch or checkout again. Otherwise it
fetches the exact commit only when the object is unavailable locally and checks it out detached
without force or reset. Installation uses the checkout's pinned pnpm version with lifecycle scripts
disabled; package builds then run explicitly.

The root installation is independent of this checkout. TypeScript and Vite aliases resolve the
generated `@block-editor/model`, `@block-editor/prosemirror`, and ProseMirror files directly from
`.deps/blocks`. A fresh `npm ci` therefore does not attempt to install an unavailable workspace
package; Blocks-dependent web commands intentionally require the bootstrap first.

## Project-owned boundary

Downstream UI imports only from `apps/web/src/vendor/blocks/index.ts`:

```tsx
<BlocksEditor value={document} onChange={setDocument} label="Page editor" />
<BlocksViewer value={document} label="Page preview" />
```

Both components accept the canonical `ContentDocument` from `src/contracts/content/model.ts`.
Product code does not import Blocks or ProseMirror types. `BlocksEditor` owns one upstream
`EditorState` and `EditorView`, destroys the view on unmount, and emits a canonical document only
for document-changing transactions. `BlocksViewer` renders the same canonical tree through the
upstream `BlockViewer`.

The adapter maps project IDs, text, children, heading level, language, entity ID, and artifact ID.
The pinned profile edits its supported paragraph, heading, quote, and code shapes. Other canonical
types pass through the upstream opaque-node path and render as named read-only content, preserving
their project data rather than inventing an editable approximation.

This integration provides rendering and local editing only. Persistence, collaboration,
authorization, revision conflict handling, and product routes remain owned by their later-phase
contracts.

## Verification

```sh
npm run setup:blocks
npm run web:test
npm run web:typecheck
npm run web:build
```

The development showcase is available at `/?showcase`. Its block section must be exercised in a
real browser by editing text, switching to Read, and observing the edited canonical content in the
upstream viewer.
