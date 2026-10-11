import { useState } from "react"
import type { SpaceConfig } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"

type MutationFeedback = { readonly onDone: () => void; readonly onError: (message: string) => void }

export function WorkflowStateRow({
  session,
  spaceId,
  state,
  canManage,
  feedback,
}: {
  readonly session: Session
  readonly spaceId: string
  readonly state: SpaceConfig["workflow"]["states"][number]
  readonly canManage: boolean
  readonly feedback: MutationFeedback
}) {
  const [name, setName] = useState(state.name)
  const [color, setColor] = useState(state.color)
  const [position, setPosition] = useState(String(state.position))
  const [isDefault, setIsDefault] = useState(state.isDefault)
  async function update() {
    try {
      await session.api.command({
        method: "patch",
        path: `/spaces/${encodeURIComponent(spaceId)}/workflow/states/${encodeURIComponent(state.id)}`,
        baseRevision: state.revision,
        payload: { name, color, position: Number(position), isDefault },
      })
      feedback.onDone()
    } catch (error) {
      feedback.onError(
        error instanceof Error ? error.message : "Workflow state could not be saved.",
      )
    }
  }
  async function archive() {
    try {
      await session.api.command({
        method: "post",
        path: `/spaces/${encodeURIComponent(spaceId)}/workflow/states/${encodeURIComponent(state.id)}/archive`,
        baseRevision: state.revision,
        payload: {},
      })
      feedback.onDone()
    } catch (error) {
      feedback.onError(
        error instanceof Error ? error.message : "Workflow state could not be archived.",
      )
    }
  }
  return (
    <div className="config-row">
      <span className="color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
      <Field
        label="State name"
        name={`state-name-${state.id}`}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        disabled={!canManage}
      />
      <Field
        label="Color"
        name={`state-color-${state.id}`}
        value={color}
        onChange={(event) => setColor(event.currentTarget.value)}
        disabled={!canManage}
      />
      <Field
        label="Order"
        name={`state-position-${state.id}`}
        type="number"
        min="0"
        max="19"
        value={position}
        onChange={(event) => setPosition(event.currentTarget.value)}
        disabled={!canManage}
      />
      <span>{state.category}</span>
      <label className="check-row">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(event) => setIsDefault(event.currentTarget.checked)}
          disabled={!canManage}
        />
        Default
      </label>
      <div className="cluster">
        <Button disabled={!canManage} onClick={() => void update()}>
          Save
        </Button>
        <Button variant="quiet" disabled={!canManage} onClick={() => void archive()}>
          Archive
        </Button>
      </div>
    </div>
  )
}

export function NewStateForm({
  session,
  config,
  canManage,
  feedback,
}: {
  readonly session: Session
  readonly config: SpaceConfig
  readonly canManage: boolean
  readonly feedback: MutationFeedback
}) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState("backlog")
  const [color, setColor] = useState("#626970")
  async function create() {
    try {
      await session.api.command({
        method: "post",
        path: `/spaces/${encodeURIComponent(config.space.id)}/workflow/states`,
        baseRevision: null,
        payload: {
          name,
          category,
          color,
          position: config.workflow.states.length,
          isDefault: config.workflow.states.length === 0,
        },
      })
      setName("")
      feedback.onDone()
    } catch (error) {
      feedback.onError(
        error instanceof Error ? error.message : "Workflow state could not be created.",
      )
    }
  }
  return (
    <div className="inline-form">
      <Field
        label="New state"
        name="new-state-name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        disabled={!canManage}
      />
      <SelectField
        label="Category"
        name="new-state-category"
        value={category}
        onChange={setCategory}
        options={["backlog", "unstarted", "started", "completed", "canceled"].map((value) => ({
          value,
          label: value,
        }))}
        disabled={!canManage}
      />
      <Field
        label="Color"
        name="new-state-color"
        value={color}
        onChange={(event) => setColor(event.currentTarget.value)}
        disabled={!canManage}
      />
      <Button
        variant="primary"
        disabled={!canManage || name.length === 0 || config.workflow.states.length >= 20}
        onClick={() => void create()}
      >
        Add state
      </Button>
    </div>
  )
}

export function LabelRow({
  session,
  label,
  canManage,
  feedback,
}: {
  readonly session: Session
  readonly label: SpaceConfig["labels"][number]
  readonly canManage: boolean
  readonly feedback: MutationFeedback
}) {
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState(label.color)
  async function execute(action: "save" | "archive") {
    try {
      await session.api.command({
        method: action === "save" ? "patch" : "post",
        path: `/labels/${encodeURIComponent(label.id)}${action === "archive" ? "/archive" : ""}`,
        baseRevision: label.revision,
        payload: action === "save" ? { name, color } : {},
      })
      feedback.onDone()
    } catch (error) {
      feedback.onError(error instanceof Error ? error.message : "Label could not be updated.")
    }
  }
  return (
    <div className="config-row config-row--label">
      <span className="color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
      <Field
        label="Label name"
        name={`label-name-${label.id}`}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        disabled={!canManage}
      />
      <Field
        label="Color"
        name={`label-color-${label.id}`}
        value={color}
        onChange={(event) => setColor(event.currentTarget.value)}
        disabled={!canManage}
      />
      <div className="cluster">
        <Button disabled={!canManage} onClick={() => void execute("save")}>
          Save
        </Button>
        <Button variant="quiet" disabled={!canManage} onClick={() => void execute("archive")}>
          Archive
        </Button>
      </div>
    </div>
  )
}
