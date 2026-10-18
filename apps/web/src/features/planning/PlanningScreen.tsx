import { CalendarDots } from "@phosphor-icons/react"
import { type FormEvent, useEffect, useState } from "react"
import type { z } from "zod"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, SelectField } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { featureCommand, workspaceFeaturePath } from "../feature-api.ts"
import { ProjectSelect } from "../projects/ProjectSelect.tsx"
import { CycleSection } from "./CycleSection.tsx"
import { CreateNamedForm, EditablePlanningList, PlanningList } from "./PlanningForms.tsx"
import { PlanningNotifications } from "./PlanningNotifications.tsx"
import {
  InboxSchema,
  type MilestoneSchema,
  MilestonesResponseSchema,
  type ModuleSchema,
  ModulesResponseSchema,
  PlanningBundleSchema,
  ProgressSchema,
  TimelineResponseSchema,
  type TimelineSchema,
  type UpdateSchema,
  UpdatesResponseSchema,
} from "./planning-schemas.ts"
import { WorkPlanningSection } from "./WorkPlanningSection.tsx"

export function PlanningScreen({ session, announce }: ScreenProps) {
  const [projectId, setProjectId] = useState("")
  const [milestones, setMilestones] = useState<readonly z.infer<typeof MilestoneSchema>[]>([])
  const [modules, setModules] = useState<readonly z.infer<typeof ModuleSchema>[]>([])
  const [updates, setUpdates] = useState<readonly z.infer<typeof UpdateSchema>[]>([])
  const [timeline, setTimeline] = useState<readonly z.infer<typeof TimelineSchema>[]>([])
  const [progress, setProgress] = useState<z.infer<typeof ProgressSchema> | null>(null)
  const [inbox, setInbox] = useState<z.infer<typeof InboxSchema> | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadProject(selectedProjectId: string) {
    if (selectedProjectId === "") return
    setError(null)
    try {
      const root = workspaceFeaturePath(
        session,
        "planning",
        `/projects/${encodeURIComponent(selectedProjectId)}`,
      )
      const result = PlanningBundleSchema.parse(
        await Promise.all([
          session.api.feature(`${root}/milestones`, MilestonesResponseSchema),
          session.api.feature(`${root}/modules`, ModulesResponseSchema),
          session.api.feature(`${root}/progress`, ProgressSchema),
          session.api.feature(`${root}/timeline`, TimelineResponseSchema),
          session.api.feature(`${root}/updates`, UpdatesResponseSchema),
        ]),
      )
      setMilestones(result[0].milestones)
      setModules(result[1].modules)
      setProgress(result[2])
      setTimeline(result[3].entries)
      setUpdates(result[4].updates)
      announce(`Planning data loaded for ${selectedProjectId}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Planning data could not be loaded.")
    }
  }
  useEffect(() => {
    const path = `${workspaceFeaturePath(session, "planning", "/inbox")}?after=0&limit=50`
    void session.api
      .feature(path, InboxSchema)
      .then(setInbox, (caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Inbox could not be loaded."),
      )
  }, [session])

  async function create(
    event: FormEvent<HTMLFormElement>,
    kind: "milestone" | "module" | "update",
  ) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    if (projectId === "") return
    try {
      const payload =
        kind === "milestone"
          ? {
              name: String(data.get("name")),
              description: "",
              targetDate: null,
              position: milestones.length,
            }
          : kind === "module"
            ? {
                name: String(data.get("name")),
                description: "",
                ownerId: null,
                startDate: null,
                targetDate: null,
                status: "planned",
              }
            : { health: String(data.get("health")), body: String(data.get("body")) }
      const path =
        kind === "milestone"
          ? `/projects/${encodeURIComponent(projectId)}/milestones`
          : kind === "module"
            ? `/projects/${encodeURIComponent(projectId)}/modules`
            : `/projects/${encodeURIComponent(projectId)}/updates`
      await featureCommand(session, "planning", path, "POST", null, payload)
      form.reset()
      await loadProject(projectId)
      announce(`${kind} created`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${kind} could not be created.`)
    }
  }

  async function rename(
    kind: "milestone" | "module",
    record: { readonly id: string; readonly revision: number },
    name: string,
  ) {
    try {
      await featureCommand(
        session,
        "planning",
        `/${kind}s/${encodeURIComponent(record.id)}`,
        "PATCH",
        record.revision,
        { name },
      )
      await loadProject(projectId)
      announce(`${kind} updated`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${kind} could not be updated.`)
    }
  }

  return (
    <ScreenLayout
      eyebrow="Planning"
      title="Cycles and outcomes"
      description="Project progress, milestones, modules, updates, timeline, and notifications from server truth."
    >
      <ProjectSelect
        session={session}
        label="Project"
        name="planning-project"
        value={projectId}
        emptyLabel="Select a project"
        onChange={(selectedProjectId) => {
          setProjectId(selectedProjectId)
          void loadProject(selectedProjectId)
        }}
        onError={setError}
      />
      {error === null ? null : (
        <ErrorPanel
          message={error}
          actions={<Button onClick={() => void loadProject(projectId)}>Reload</Button>}
        />
      )}
      <CycleSection session={session} announce={announce} />
      <WorkPlanningSection session={session} announce={announce} />
      {progress === null ? (
        <EmptyState
          title="Select a project"
          body="Choose a visible project to load its planning record."
        />
      ) : (
        <>
          <section className="panel" aria-label="Project progress">
            <div className="panel__header">
              <h2>Progress</h2>
              <Badge tone={progress.blocked > 0 ? "warning" : "success"}>
                {progress.percent}% complete
              </Badge>
            </div>
            <div className="panel__meta">
              <span>
                {progress.completed} of {progress.total} {progress.mode}
              </span>
              <span>{progress.blocked} blocked</span>
            </div>
          </section>
          <div className="feature-columns">
            <section className="section-stack">
              <h2>Milestones</h2>
              <EditablePlanningList
                records={milestones}
                onSave={(record, name) => void rename("milestone", record, name)}
              />
              <CreateNamedForm
                label="Milestone name"
                onSubmit={(event) => void create(event, "milestone")}
              />
            </section>
            <section className="section-stack">
              <h2>Modules</h2>
              <EditablePlanningList
                records={modules}
                onSave={(record, name) => void rename("module", record, name)}
              />
              <CreateNamedForm
                label="Module name"
                onSubmit={(event) => void create(event, "module")}
              />
            </section>
          </div>
          <section className="section-stack">
            <h2>Publish update</h2>
            <form className="form-stack" onSubmit={(event) => void create(event, "update")}>
              <SelectField
                label="Health"
                name="health"
                defaultValue="on_track"
                options={[
                  { value: "on_track", label: "On track" },
                  { value: "at_risk", label: "At risk" },
                  { value: "off_track", label: "Off track" },
                ]}
              />
              <label className="field">
                <span className="field__label">Update</span>
                <textarea name="body" required rows={4} />
              </label>
              <Button type="submit" variant="primary">
                Publish update
              </Button>
            </form>
            <PlanningList records={updates.map((update) => ({ ...update, name: update.body }))} />
          </section>
          <section className="section-stack">
            <h2>Timeline</h2>
            <div className="data-list">
              {timeline.map((entry) => (
                <div className="record-row" key={`${entry.kind}:${entry.id}`}>
                  <CalendarDots size={16} aria-hidden="true" />
                  <strong>{entry.name}</strong>
                  <Badge>{entry.kind}</Badge>
                  <span className="mono">
                    {entry.startDate ?? "Not set"} - {entry.targetDate ?? "Not set"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      <PlanningNotifications inbox={inbox} />
    </ScreenLayout>
  )
}
