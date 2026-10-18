import { Play, Stop, Wrench } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import {
  RunInspectionResponseSchema,
  RunStartResponseSchema,
  RuntimeActivityPageResponseSchema,
  RuntimeArtifactPageResponseSchema,
  RuntimeReceiptPageResponseSchema,
} from "../../../../../src/contracts/runtime/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, Field } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { workspaceFeaturePath } from "../feature-api.ts"
import { RuntimeCollections } from "./RuntimeCollections.tsx"

const CanceledSchema = z.object({ state: z.literal("canceled") })

export function RuntimeScreen({ session, announce }: ScreenProps) {
  const [runId, setRunId] = useState("")
  const [run, setRun] = useState<z.infer<typeof RunInspectionResponseSchema> | null>(null)
  const [collections, setCollections] = useState<{
    readonly activity: z.infer<typeof RuntimeActivityPageResponseSchema>
    readonly receipts: z.infer<typeof RuntimeReceiptPageResponseSchema>
    readonly artifacts: z.infer<typeof RuntimeArtifactPageResponseSchema>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = workspaceFeaturePath(session, "runtime", "/runs")

  async function inspect(id = runId) {
    if (id === "") return
    try {
      const runRoot = `${root}/${encodeURIComponent(id)}`
      const [nextRun, nextActivity, nextReceipts, nextArtifacts] = await Promise.all([
        session.api.feature(runRoot, RunInspectionResponseSchema),
        session.api.feature(`${runRoot}/activity`, RuntimeActivityPageResponseSchema),
        session.api.feature(`${runRoot}/receipts`, RuntimeReceiptPageResponseSchema),
        session.api.feature(`${runRoot}/artifacts`, RuntimeArtifactPageResponseSchema),
      ])
      setRun(nextRun)
      setCollections({ activity: nextActivity, receipts: nextReceipts, artifacts: nextArtifacts })
      setRunId(id)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Run is unavailable.")
    }
  }

  async function delegate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    try {
      const result = await session.api.feature(root, RunStartResponseSchema, {
        method: "POST",
        body: {
          installationId: String(data.get("installationId")),
          subjectRef: String(data.get("subjectRef")),
          directiveRef: String(data.get("directiveRef")),
          idempotencyKey: `web-${crypto.randomUUID()}`,
          parentRunId: null,
          requestedCapabilities: [],
        },
      })
      await inspect(result.runId)
      announce(`Run ${result.runId} delegated`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Run could not be delegated.")
    } finally {
      setBusy(false)
    }
  }

  async function control(action: "cancel" | "resume") {
    if (run === null) return
    setBusy(true)
    try {
      if (action === "cancel")
        await session.api.feature(`${root}/${encodeURIComponent(run.id)}/cancel`, CanceledSchema, {
          method: "POST",
          body: {},
        })
      else
        await session.api.feature(
          `${root}/${encodeURIComponent(run.id)}/resume`,
          RunStartResponseSchema,
          { method: "POST", body: { idempotencyKey: `web-${crypto.randomUUID()}` } },
        )
      await inspect(run.id)
      announce(`Run ${action === "cancel" ? "canceled" : "resumed"}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Run could not be ${action}ed.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenLayout
      eyebrow="Agent runtime"
      title="Runs"
      description="Delegate, inspect, cancel, and resume authenticated agent runs."
    >
      <form className="form-columns" onSubmit={(event) => void delegate(event)}>
        <Field label="Installation ID" name="installationId" required />
        <Field label="Subject reference" name="subjectRef" required />
        <Field label="Directive reference" name="directiveRef" required />
        <Button type="submit" variant="primary" busy={busy}>
          <Play size={16} aria-hidden="true" /> Delegate run
        </Button>
      </form>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          void inspect().finally(() => setBusy(false))
        }}
      >
        <Field
          label="Run ID"
          name="runId"
          value={runId}
          onChange={(event) => setRunId(event.currentTarget.value)}
        />
        <Button type="submit" busy={busy}>
          <Wrench size={16} aria-hidden="true" /> Inspect
        </Button>
      </form>
      {error === null ? null : <ErrorPanel message={error} />}
      {run === null ? (
        <EmptyState title="No run selected" body="Delegate a run or inspect a known run ID." />
      ) : (
        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="mono">{run.id}</p>
              <h2>{run.directive_ref}</h2>
            </div>
            <Badge
              tone={
                run.state === "completed"
                  ? "success"
                  : run.state === "failed" || run.state === "canceled"
                    ? "danger"
                    : "info"
              }
            >
              {run.state.replace("_", " ")}
            </Badge>
          </div>
          <div className="metadata-grid">
            <span>Subject</span>
            <strong>{run.subject_ref}</strong>
            <span>Installation</span>
            <strong>{run.installation_id}</strong>
            <span>Generation</span>
            <strong>{run.generation}</strong>
            <span>Depth</span>
            <strong>{run.depth}</strong>
          </div>
          <div className="cluster">
            <Button
              variant="danger"
              busy={busy}
              disabled={["completed", "failed", "canceled"].includes(run.state)}
              onClick={() => void control("cancel")}
            >
              <Stop size={16} aria-hidden="true" /> Cancel run
            </Button>
            <Button
              busy={busy}
              disabled={!["awaiting_input", "stale"].includes(run.state)}
              onClick={() => void control("resume")}
            >
              Resume
            </Button>
          </div>
          {collections === null ? null : (
            <RuntimeCollections
              key={`${run.id}:${run.updated_at}`}
              session={session}
              runId={run.id}
              root={root}
              initialActivity={collections.activity}
              initialReceipts={collections.receipts}
              initialArtifacts={collections.artifacts}
            />
          )}
        </section>
      )}
    </ScreenLayout>
  )
}
