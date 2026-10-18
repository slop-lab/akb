import type { FormEvent } from "react"
import type { ScreenProps } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"
import type { EntityFeatureMutation } from "../feature-api.ts"
import { featureCommand } from "../feature-api.ts"

type Props = ScreenProps & {
  readonly mutation: EntityFeatureMutation
  readonly busy: boolean
  readonly execute: (action: () => Promise<void>) => Promise<void>
  readonly onAccepted: () => void
}

export function AcceptIntakeForm({
  mutation,
  session,
  announce,
  busy,
  execute,
  onAccepted,
}: Props) {
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await featureCommand(
      session,
      "automation",
      `/intake/${encodeURIComponent(mutation.result.id)}/accept`,
      "POST",
      mutation.revision,
      {
        ownerId: String(data.get("ownerId")),
        workflowStateId: String(data.get("workflowStateId")),
        projectId: String(data.get("projectId")) || null,
        itemType: String(data.get("itemType")),
        priority: String(data.get("priority")),
      },
    )
    onAccepted()
    announce("Intake accepted into work")
  }

  return (
    <details>
      <summary>Accept this intake</summary>
      <form className="form-stack" onSubmit={(event) => void execute(() => accept(event))}>
        <Field label="Owner ID" name="ownerId" required />
        <Field label="Workflow state ID" name="workflowStateId" required />
        <Field label="Project ID" name="projectId" />
        <Field label="Item type" name="itemType" defaultValue="Task" required />
        <SelectField
          label="Priority"
          name="priority"
          defaultValue="none"
          options={["none", "low", "medium", "high", "urgent"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <Button type="submit" busy={busy}>
          Accept into work
        </Button>
      </form>
    </details>
  )
}
