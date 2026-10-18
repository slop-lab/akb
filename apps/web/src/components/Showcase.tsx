import { useState } from "react"
import type { ContentDocument } from "../../../../src/contracts/content/model.ts"
import { BlocksEditor, BlocksViewer } from "../vendor/blocks/index.ts"
import { Badge, Button, Dialog, EmptyState, ErrorPanel, Field, SelectField } from "./primitives.tsx"

const BLOCKS_DOCUMENT: ContentDocument = {
  version: 1,
  blocks: [
    { id: "showcase-heading", type: "heading", text: "Working brief", level: 2, children: [] },
    {
      id: "showcase-body",
      type: "paragraph",
      text: "Shape this document in edit mode, then inspect the same block tree in read mode.",
      children: [],
    },
  ],
}

export function Showcase() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [choice, setChoice] = useState("active")
  const [blocksMode, setBlocksMode] = useState<"edit" | "read">("edit")
  const [blocksDocument, setBlocksDocument] = useState(BLOCKS_DOCUMENT)
  return (
    <main className="showcase">
      <header>
        <p className="eyebrow">Development surface</p>
        <h1>Primitive showcase</h1>
        <p>Token-backed states before product composition.</p>
      </header>
      <section className="showcase__section">
        <h2>Actions</h2>
        <div className="cluster">
          <Button variant="primary">Primary action</Button>
          <Button>Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="danger">Archive</Button>
          <Button busy>Saving</Button>
          <Button disabled>Unavailable</Button>
        </div>
      </section>
      <section className="showcase__section">
        <h2>Fields</h2>
        <div className="form-stack">
          <Field
            label="Project name"
            name="showcase-name"
            defaultValue="Release readiness"
            help="A concise working name."
          />
          <Field label="Invalid field" name="showcase-error" error="This value is required." />
          <SelectField
            label="Lifecycle"
            name="showcase-state"
            value={choice}
            onChange={setChoice}
            options={[
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
            ]}
          />
        </div>
      </section>
      <section className="showcase__section">
        <div className="blocks-heading">
          <div>
            <h2>Block editor and viewer</h2>
            <p>Real upstream Blocks model, viewer, and ProseMirror profile.</p>
          </div>
          <fieldset className="segmented">
            <legend className="visually-hidden">Document mode</legend>
            <button
              type="button"
              aria-pressed={blocksMode === "edit"}
              onClick={() => setBlocksMode("edit")}
            >
              Edit
            </button>
            <button
              type="button"
              aria-pressed={blocksMode === "read"}
              onClick={() => setBlocksMode("read")}
            >
              Read
            </button>
          </fieldset>
        </div>
        <div className="blocks-surface">
          {blocksMode === "edit" ? (
            <BlocksEditor
              value={blocksDocument}
              onChange={setBlocksDocument}
              label="Showcase block document editor"
            />
          ) : (
            <BlocksViewer value={blocksDocument} label="Showcase block document preview" />
          )}
        </div>
        <p className="blocks-caption" aria-live="polite">
          {blocksMode === "edit" ? "Editing" : "Reading"} · {blocksDocument.blocks.length} blocks
        </p>
      </section>
      <section className="showcase__section">
        <h2>Status</h2>
        <div className="cluster">
          <Badge>Backlog</Badge>
          <Badge tone="info">In progress</Badge>
          <Badge tone="success">Completed</Badge>
          <Badge tone="warning">At risk</Badge>
          <Badge tone="danger">Conflict</Badge>
        </div>
        <ErrorPanel
          title="This item changed on the server"
          message="Reload the latest revision before applying this edit."
        />
      </section>
      <section className="showcase__section">
        <h2>Empty and overlay</h2>
        <EmptyState
          title="No work items yet"
          body="Create the first item in this Space when you are ready."
          action={
            <Button variant="primary" onClick={() => setDialogOpen(true)}>
              Open dialog
            </Button>
          }
        />
      </section>
      <Dialog title="Create work item" open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <div className="form-stack">
          <Field label="Title" name="dialog-title-field" autoFocus />
          <div className="dialog-actions">
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary">Create item</Button>
          </div>
        </div>
      </Dialog>
    </main>
  )
}
