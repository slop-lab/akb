import { useState } from "react"
import type { SpaceConfig, WorkItemDetail } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Badge, Button, Field, SelectField } from "../../components/primitives.tsx"
import { ProjectSelect } from "../projects/ProjectSelect.tsx"

type Props = {
  readonly session: Session
  readonly item: WorkItemDetail
  readonly config: SpaceConfig | null
  readonly onUpdate: (field: string, value: unknown) => void
  readonly onLifecycle: (action: "archive" | "restore") => void
  readonly onError: (message: string) => void
}

export function WorkDetails({ session, item, config, onUpdate, onLifecycle, onError }: Props) {
  const labelIds = new Set(item.labels.map((label) => label.id))
  const [title, setTitle] = useState(item.title)
  const [type, setType] = useState(item.type)
  const [startDate, setStartDate] = useState(item.startDate ?? "")
  const [dueDate, setDueDate] = useState(item.dueDate ?? "")
  return (
    <div className="metadata-grid">
      <span>Title</span>
      <Field
        label="Title"
        name="peek-title"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onBlur={(event) => {
          if (event.currentTarget.value !== item.title) onUpdate("title", event.currentTarget.value)
        }}
      />
      <span>Description</span>
      <label className="field">
        <span className="field__label">Description</span>
        <textarea
          defaultValue={item.description}
          rows={5}
          onBlur={(event) => {
            if (event.currentTarget.value !== item.description)
              onUpdate("description", event.currentTarget.value)
          }}
        />
      </label>
      <span>State</span>
      <SelectField
        label="State"
        name="peek-state"
        value={item.workflowState.id}
        onChange={(value) => onUpdate("workflowStateId", value)}
        options={(config?.workflow.states ?? []).map((state) => ({
          value: state.id,
          label: state.name,
        }))}
      />
      <span>Priority</span>
      <SelectField
        label="Priority"
        name="peek-priority"
        value={item.priority}
        onChange={(value) => onUpdate("priority", value)}
        options={["none", "low", "medium", "high", "urgent"].map((value) => ({
          value,
          label: value,
        }))}
      />
      <span>Owner</span>
      <SelectField
        label="Owner"
        name="peek-owner"
        value={item.accountableOwner.id}
        onChange={(value) => onUpdate("accountableOwnerId", value)}
        options={session.bootstrap.principals.map((principal) => ({
          value: principal.id,
          label: principal.name,
        }))}
      />
      <span>Project</span>
      <ProjectSelect
        session={session}
        label="Project"
        name="peek-project"
        value={item.project?.id ?? ""}
        onChange={(value) => onUpdate("projectId", value || null)}
        emptyLabel="No project"
        onError={onError}
      />
      <span>Type</span>
      <Field
        label="Type"
        name="peek-type"
        value={type}
        onChange={(event) => setType(event.currentTarget.value)}
        onBlur={(event) => {
          if (event.currentTarget.value !== item.type) onUpdate("type", event.currentTarget.value)
        }}
      />
      <span>Start date</span>
      <DateField
        name="peek-start"
        value={startDate}
        onChange={setStartDate}
        onUpdate={() => {
          const next = startDate || null
          if (next !== item.startDate) onUpdate("startDate", next)
        }}
      />
      <span>Due date</span>
      <DateField
        name="peek-due"
        value={dueDate}
        onChange={setDueDate}
        onUpdate={() => {
          const next = dueDate || null
          if (next !== item.dueDate) onUpdate("dueDate", next)
        }}
      />
      <span>Parent</span>
      <strong>{item.parentId ?? "Not set"}</strong>
      <span>Labels</span>
      <div className="check-list">
        {(config?.labels ?? []).map((label) => (
          <label key={label.id}>
            <input
              type="checkbox"
              checked={labelIds.has(label.id)}
              onChange={(event) =>
                onUpdate(
                  "labelIds",
                  event.currentTarget.checked
                    ? [...labelIds, label.id]
                    : [...labelIds].filter((id) => id !== label.id),
                )
              }
            />
            <Badge>{label.name}</Badge>
          </label>
        ))}
      </div>
      <span>Lifecycle</span>
      <Button
        variant="quiet"
        onClick={() => onLifecycle(item.archivedAt === null ? "archive" : "restore")}
      >
        {item.archivedAt === null ? "Archive work item" : "Restore work item"}
      </Button>
    </div>
  )
}

function DateField({
  name,
  value,
  onChange,
  onUpdate,
}: {
  readonly name: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onUpdate: () => void
}) {
  return (
    <Field
      label={name.endsWith("start") ? "Start date" : "Due date"}
      name={name}
      type="date"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onUpdate}
    />
  )
}
