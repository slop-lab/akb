import { type FormEvent, useRef, useState } from "react"
import type { ScreenProps } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"
import type { EntityFeatureMutation } from "../feature-api.ts"
import { EntityFeatureMutationSchema, featureCommand } from "../feature-api.ts"
import { AcceptIntakeForm } from "./AcceptIntakeForm.tsx"

type Props = ScreenProps & { readonly onError: (error: unknown) => void }

export function AutomationCreateForms({ session, announce, onError }: Props) {
  const [createdIntake, setCreatedIntake] = useState<EntityFeatureMutation | null>(null)
  const [outcome, setOutcome] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  async function execute(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await action()
    } catch (error) {
      onError(error)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function createIntake(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const result = EntityFeatureMutationSchema.parse(
      await featureCommand(session, "automation", "/intake", "POST", null, {
        source: String(data.get("source")),
        sourceRef: String(data.get("sourceRef")),
        targetSpaceId: String(data.get("targetSpaceId")),
        title: String(data.get("title")),
        body: String(data.get("body")),
        suggestedDestination: String(data.get("suggestedDestination")) || null,
      }),
    )
    setCreatedIntake(result)
    setOutcome(`Intake ${result.result.id} created`)
    announce("Intake item created")
    form.reset()
  }

  async function createRecurrence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const result = EntityFeatureMutationSchema.parse(
      await featureCommand(session, "automation", "/recurrences", "POST", null, {
        templateId: String(data.get("templateId")),
        templateRevision: Number(data.get("templateRevision")),
        targetSpaceId: String(data.get("targetSpaceId")),
        schedule: { kind: "daily", interval: Number(data.get("interval")) },
        timezone: String(data.get("timezone")),
        incompletePolicy: String(data.get("incompletePolicy")),
        nextRunAt: new Date(String(data.get("nextRunAt"))).toISOString(),
        title: String(data.get("title")),
      }),
    )
    setOutcome(`Recurrence ${result.result.id} created`)
    announce("Recurrence created")
    form.reset()
  }

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const result = EntityFeatureMutationSchema.parse(
      await featureCommand(session, "automation", "/rules", "POST", null, {
        name: String(data.get("name")),
        enabled: true,
        trigger: { eventType: String(data.get("eventType")) },
        conditions: [],
        actions: [
          {
            kind: "create_intake",
            title: String(data.get("intakeTitle")),
            body: String(data.get("body")),
            targetSpaceId: String(data.get("targetSpaceId")),
          },
        ],
        maxRunsPerMinute: Number(data.get("maxRunsPerMinute")),
      }),
    )
    setOutcome(`Automation rule ${result.result.id} created`)
    announce("Automation rule created")
    form.reset()
  }

  return (
    <section className="section-stack">
      <div className="panel__header">
        <div>
          <h2>Create automation</h2>
          <p className="panel__meta">Create intake, recurrence, and event rule records.</p>
        </div>
        {outcome === "" ? null : (
          <span className="mono" role="status">
            {outcome}
          </span>
        )}
      </div>
      <div className="feature-columns">
        <div className="form-stack panel">
          <form
            className="form-stack"
            onSubmit={(event) => void execute(() => createIntake(event))}
          >
            <h3>New intake</h3>
            <SelectField
              label="Source"
              name="source"
              defaultValue="human"
              options={["human", "agent", "integration", "import"].map((value) => ({
                value,
                label: value,
              }))}
            />
            <Field label="Source reference" name="sourceRef" />
            <Field label="Target Space ID" name="targetSpaceId" required />
            <Field label="Title" name="title" required />
            <label className="field">
              <span className="field__label">Body</span>
              <textarea name="body" rows={4} />
            </label>
            <Field label="Suggested destination" name="suggestedDestination" />
            <Button type="submit" variant="primary" busy={busy}>
              Create intake
            </Button>
          </form>
          {createdIntake === null ? null : (
            <AcceptIntakeForm
              mutation={createdIntake}
              session={session}
              announce={announce}
              busy={busy}
              execute={execute}
              onAccepted={() => {
                setCreatedIntake(null)
                setOutcome("Intake accepted into work")
              }}
            />
          )}
        </div>
        <form
          className="form-stack panel"
          onSubmit={(event) => void execute(() => createRecurrence(event))}
        >
          <h3>Daily recurrence</h3>
          <Field label="Template ID" name="templateId" required />
          <Field label="Template revision" name="templateRevision" type="number" min="1" required />
          <Field label="Target Space ID" name="targetSpaceId" required />
          <Field
            label="Every N days"
            name="interval"
            type="number"
            min="1"
            max="365"
            defaultValue="1"
            required
          />
          <Field label="Timezone" name="timezone" defaultValue="UTC" required />
          <SelectField
            label="Incomplete item policy"
            name="incompletePolicy"
            defaultValue="skip"
            options={["skip", "create", "merge"].map((value) => ({ value, label: value }))}
          />
          <Field label="Next run" name="nextRunAt" type="datetime-local" required />
          <Field label="Title" name="title" required />
          <Button type="submit" busy={busy}>
            Create recurrence
          </Button>
        </form>
      </div>
      <form
        className="form-stack panel"
        onSubmit={(event) => void execute(() => createRule(event))}
      >
        <h3>Event rule</h3>
        <div className="form-columns">
          <Field label="Rule name" name="name" required />
          <Field label="Event type" name="eventType" required />
          <Field label="Target Space ID" name="targetSpaceId" required />
          <Field label="Intake title" name="intakeTitle" required />
          <Field
            label="Maximum runs per minute"
            name="maxRunsPerMinute"
            type="number"
            min="1"
            max="1000"
            defaultValue="60"
            required
          />
        </div>
        <label className="field">
          <span className="field__label">Intake body</span>
          <textarea name="body" rows={3} />
        </label>
        <Button type="submit" busy={busy}>
          Create rule
        </Button>
      </form>
    </section>
  )
}
