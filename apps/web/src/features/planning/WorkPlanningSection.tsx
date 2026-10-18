import { type FormEvent, useState } from "react"
import type { ScreenProps } from "../../app/types.ts"
import { Button, ErrorPanel, Field } from "../../components/primitives.tsx"
import { featureCommand } from "../feature-api.ts"

export function WorkPlanningSection({ session, announce }: ScreenProps) {
  const [error, setError] = useState<string | null>(null)
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await featureCommand(
        session,
        "planning",
        `/work-items/${encodeURIComponent(String(data.get("workItemId")))}/planning`,
        "PUT",
        Number(data.get("revision")),
        {
          estimate: String(data.get("estimate")) === "" ? null : Number(data.get("estimate")),
          cycleId: String(data.get("cycleId")) || null,
          milestoneId: String(data.get("milestoneId")) || null,
          moduleIds: String(data.get("moduleIds"))
            .split(/\s*,\s*/)
            .filter(Boolean),
        },
      )
      setError(null)
      announce("Work planning assignment saved")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Work planning could not be saved.")
    }
  }
  return (
    <section className="section-stack">
      <h2>Assign work to planning</h2>
      <p className="panel__meta">
        Apply server-revisioned cycle, milestone, module, and estimate metadata.
      </p>
      {error === null ? null : <ErrorPanel message={error} />}
      <form className="form-columns" onSubmit={(event) => void assign(event)}>
        <Field label="Work item ID" name="workItemId" required />
        <Field label="Work revision" name="revision" type="number" min="1" required />
        <Field label="Estimate" name="estimate" type="number" min="0.01" step="0.01" />
        <Field label="Cycle ID" name="cycleId" />
        <Field label="Milestone ID" name="milestoneId" />
        <Field label="Module IDs" name="moduleIds" help="Comma-separated" />
        <Button type="submit">Save assignment</Button>
      </form>
    </section>
  )
}
