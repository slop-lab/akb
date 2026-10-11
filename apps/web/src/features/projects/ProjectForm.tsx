import { type FormEvent, useState } from "react"
import { type Project, ProjectSchema } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"

type Props = {
  readonly session: Session
  readonly project?: Project
  readonly onCancel: () => void
  readonly onSaved: (id: string) => void
  readonly onError: (message: string) => void
}

export function ProjectForm({ session, project, onCancel, onSaved, onError }: Props) {
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(project?.name ?? "")
  const [slug, setSlug] = useState(project?.slug ?? "")
  const [summary, setSummary] = useState(project?.summary ?? "")
  const [ownerId, setOwnerId] = useState(project?.owner.id ?? session.bootstrap.principal.id)
  const [spaceIds, setSpaceIds] = useState(
    () => project?.participatingSpaceIds.join(",") ?? session.bootstrap.currentSpaceId ?? "",
  )
  const [leadIds, setLeadIds] = useState(() => project?.leadIds.join(",") ?? "")
  const [state, setState] = useState(project?.state ?? "planned")
  const [health, setHealth] = useState(project?.health ?? "on_track")
  const [priority, setPriority] = useState(project?.priority ?? "none")
  const [startDate, setStartDate] = useState(project?.startDate ?? "")
  const [targetDate, setTargetDate] = useState(project?.targetDate ?? "")

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const payload = {
        name,
        slug,
        summary,
        ownerId,
        leadIds: leadIds
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        participatingSpaceIds: spaceIds
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        state,
        health,
        priority,
        startDate: startDate || null,
        targetDate: targetDate || null,
      }
      const result = await session.api.command({
        method: project === undefined ? "post" : "patch",
        path: project === undefined ? "/projects" : `/projects/${encodeURIComponent(project.id)}`,
        baseRevision: project?.revision ?? null,
        payload,
      })
      onSaved(result.result.id)
    } catch (error) {
      onError(error instanceof Error ? error.message : "Project could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form-stack" onSubmit={(event) => void submit(event)}>
      <Field
        label="Name"
        name="project-name"
        required
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <Field
        label="Slug"
        name="project-slug"
        required
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        value={slug}
        onChange={(event) => setSlug(event.currentTarget.value)}
      />
      <label className="field" htmlFor="project-summary">
        <span className="field__label">Summary</span>
        <textarea
          id="project-summary"
          rows={4}
          value={summary}
          onChange={(event) => setSummary(event.currentTarget.value)}
        />
      </label>
      <SelectField
        label="Owner"
        name="project-owner"
        value={ownerId}
        onChange={setOwnerId}
        options={session.bootstrap.principals.map((principal) => ({
          value: principal.id,
          label: principal.name,
        }))}
      />
      <Field
        label="Participating Space IDs"
        name="project-spaces"
        required
        value={spaceIds}
        onChange={(event) => setSpaceIds(event.currentTarget.value)}
        help="Comma-separated. Participation does not grant private Space access."
      />
      <Field
        label="Lead IDs"
        name="project-leads"
        value={leadIds}
        onChange={(event) => setLeadIds(event.currentTarget.value)}
        help="Comma-separated Principal IDs."
      />
      <div className="form-columns">
        <SelectField
          label="Lifecycle"
          name="project-state"
          value={state}
          onChange={(value) => setState(ProjectSchema.shape.state.parse(value))}
          options={["planned", "active", "paused", "completed", "canceled"].map((value) => ({
            value,
            label: value.replace("_", " "),
          }))}
        />
        <SelectField
          label="Health"
          name="project-health"
          value={health}
          onChange={(value) => setHealth(ProjectSchema.shape.health.parse(value))}
          options={["on_track", "at_risk", "off_track"].map((value) => ({
            value,
            label: value.replace("_", " "),
          }))}
        />
        <SelectField
          label="Priority"
          name="project-priority"
          value={priority}
          onChange={(value) => setPriority(ProjectSchema.shape.priority.parse(value))}
          options={["none", "low", "medium", "high", "urgent"].map((value) => ({
            value,
            label: value,
          }))}
        />
      </div>
      <div className="form-columns">
        <Field
          label="Start date"
          name="project-start"
          type="date"
          value={startDate}
          onChange={(event) => setStartDate(event.currentTarget.value)}
        />
        <Field
          label="Target date"
          name="project-target"
          type="date"
          value={targetDate}
          onChange={(event) => setTargetDate(event.currentTarget.value)}
        />
      </div>
      <div className="dialog-actions">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {project === undefined ? "Create project" : "Save changes"}
        </Button>
      </div>
    </form>
  )
}
