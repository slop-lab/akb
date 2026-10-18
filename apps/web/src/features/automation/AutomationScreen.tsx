import { ChartBar, FlowArrow } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import type { z } from "zod"
import { AnalyticsResponseSchema } from "../../../../../src/contracts/automation/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, ErrorPanel, Field, SelectField } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { workspaceFeaturePath } from "../feature-api.ts"
import { AutomationCreateForms } from "./AutomationCreateForms.tsx"
import { AutomationIntegrations } from "./AutomationIntegrations.tsx"

export function AutomationScreen(props: ScreenProps) {
  const [metric, setMetric] = useState<z.infer<typeof AnalyticsResponseSchema> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const onError = (caught: unknown) =>
    setError(caught instanceof Error ? caught.message : "Automation request failed.")

  async function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    try {
      const parameters = new URLSearchParams({
        metric: String(data.get("metric")),
        from: new Date(String(data.get("from"))).toISOString(),
        to: new Date(String(data.get("to"))).toISOString(),
      })
      setMetric(
        await props.session.api.feature(
          `${workspaceFeaturePath(props.session, "automation", "/analytics")}?${parameters}`,
          AnalyticsResponseSchema,
        ),
      )
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Automation request failed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenLayout
      eyebrow="Automation"
      title="Intake and automation"
      description="Create bounded automation records, connect integrations, and query authority-filtered analytics."
    >
      {error === null ? null : <ErrorPanel message={error} />}
      <section className="section-stack">
        <h2>
          <ChartBar size={20} aria-hidden="true" /> Analytics
        </h2>
        <form className="form-columns" onSubmit={(event) => void query(event)}>
          <SelectField
            label="Metric"
            name="metric"
            defaultValue="throughput"
            options={[
              "throughput",
              "overdue",
              "blocked",
              "run_outcomes",
              "proposal_acceptance",
            ].map((value) => ({ value, label: value.replace("_", " ") }))}
          />
          <Field label="From" name="from" type="datetime-local" required />
          <Field label="To" name="to" type="datetime-local" required />
          <Button type="submit" variant="primary" busy={busy}>
            Query metric
          </Button>
        </form>
        {metric === null ? null : (
          <article className="panel" aria-live="polite">
            <div className="panel__header">
              <h3>{metric.metric.replace("_", " ")}</h3>
              <Badge tone="info">{metric.value}</Badge>
            </div>
            <p className="panel__meta">
              {new Date(metric.from).toLocaleString()} to {new Date(metric.to).toLocaleString()}
            </p>
          </article>
        )}
      </section>
      <section className="section-stack" aria-label="Automation registry">
        <h2>
          <FlowArrow size={20} aria-hidden="true" /> Registry
        </h2>
        <AutomationCreateForms {...props} onError={onError} />
        <AutomationIntegrations {...props} onError={onError} />
      </section>
    </ScreenLayout>
  )
}
