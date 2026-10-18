import { type FormEvent, useCallback, useEffect, useState } from "react"
import type { z } from "zod"
import type { Session } from "../../app/types.ts"
import {
  Badge,
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  SelectField,
} from "../../components/primitives.tsx"
import { featureCommand, workspaceFeaturePath } from "../feature-api.ts"
import { type CycleSchema, CyclesResponseSchema } from "./planning-schemas.ts"

export function CycleSection({
  session,
  announce,
}: {
  readonly session: Session
  readonly announce: (message: string) => void
}) {
  const [spaceId, setSpaceId] = useState(
    session.bootstrap.currentSpaceId ?? session.bootstrap.spaces[0]?.id ?? "",
  )
  const [cycles, setCycles] = useState<readonly z.infer<typeof CycleSchema>[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (spaceId === "") return
    try {
      const path = workspaceFeaturePath(
        session,
        "planning",
        `/spaces/${encodeURIComponent(spaceId)}/cycles`,
      )
      setCycles((await session.api.feature(path, CyclesResponseSchema)).cycles)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cycles could not be loaded.")
    }
  }, [session, spaceId])
  useEffect(() => void load(), [load])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await featureCommand(
        session,
        "planning",
        `/spaces/${encodeURIComponent(spaceId)}/cycles`,
        "POST",
        null,
        {
          name: String(data.get("name")),
          startDate: String(data.get("startDate")),
          endDate: String(data.get("endDate")),
          goal: String(data.get("goal")),
          capacityHint: null,
          rolloverPolicy: "reviewed",
        },
      )
      form.reset()
      await load()
      announce("Cycle created")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cycle could not be created.")
    }
  }

  async function activate(cycle: z.infer<typeof CycleSchema>) {
    try {
      await featureCommand(
        session,
        "planning",
        `/cycles/${encodeURIComponent(cycle.id)}/activate`,
        "POST",
        cycle.revision,
        {},
      )
      await load()
      announce(`${cycle.name} activated`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cycle could not be activated.")
    }
  }

  async function rollover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const source = cycles.find((cycle) => cycle.id === String(data.get("sourceCycleId")))
    const target = cycles.find((cycle) => cycle.id === String(data.get("targetCycleId")))
    if (source === undefined || target === undefined) return
    try {
      await featureCommand(
        session,
        "planning",
        `/cycles/${encodeURIComponent(source.id)}/rollover`,
        "POST",
        source.revision,
        {
          targetCycleId: target.id,
          targetCycleRevision: target.revision,
          workItems: [
            { id: String(data.get("workItemId")), revision: Number(data.get("workRevision")) },
          ],
        },
      )
      await load()
      announce(`${source.name} rolled over`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cycle could not be rolled over.")
    }
  }

  return (
    <section className="section-stack">
      <h2>Cycles</h2>
      <SelectField
        label="Space"
        name="cycle-space"
        value={spaceId}
        onChange={setSpaceId}
        options={session.bootstrap.spaces.map((space) => ({
          value: space.id,
          label: `${space.key} · ${space.name}`,
        }))}
      />
      {error === null ? null : <ErrorPanel message={error} />}
      {cycles.length === 0 ? (
        <EmptyState title="No cycles" body="Create the first planning cycle for this Space." />
      ) : (
        <div className="data-list">
          {cycles.map((cycle) => (
            <div className="record-row" key={cycle.id}>
              <strong>{cycle.name}</strong>
              <Badge tone={cycle.status === "active" ? "success" : "neutral"}>{cycle.status}</Badge>
              <span className="mono">
                {cycle.startDate} - {cycle.endDate}
              </span>
              <Button disabled={cycle.status !== "upcoming"} onClick={() => void activate(cycle)}>
                Activate
              </Button>
            </div>
          ))}
        </div>
      )}
      <form className="form-columns" onSubmit={(event) => void create(event)}>
        <Field label="Cycle name" name="name" required />
        <Field label="Start date" name="startDate" type="date" required />
        <Field label="End date" name="endDate" type="date" required />
        <Field label="Goal" name="goal" />
        <Button type="submit" variant="primary" disabled={spaceId === ""}>
          Create cycle
        </Button>
      </form>
      {cycles.length < 2 ? null : (
        <form className="form-columns" onSubmit={(event) => void rollover(event)}>
          <SelectField
            label="Source cycle"
            name="sourceCycleId"
            options={cycles.map((cycle) => ({ value: cycle.id, label: cycle.name }))}
          />
          <SelectField
            label="Target cycle"
            name="targetCycleId"
            options={cycles.map((cycle) => ({ value: cycle.id, label: cycle.name }))}
          />
          <Field label="Work item ID" name="workItemId" required />
          <Field label="Work revision" name="workRevision" type="number" min="1" required />
          <Button type="submit">Rollover work</Button>
        </form>
      )}
    </section>
  )
}
