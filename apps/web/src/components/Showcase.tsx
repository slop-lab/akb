import { useState } from "react"
import { Badge, Button, Dialog, EmptyState, ErrorPanel, Field, SelectField } from "./primitives.tsx"

export function Showcase() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [choice, setChoice] = useState("active")
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
