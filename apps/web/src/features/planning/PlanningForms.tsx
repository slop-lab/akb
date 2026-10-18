import { FloppyDisk, Plus } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { Button, Field } from "../../components/primitives.tsx"

export function PlanningList({
  records,
}: {
  readonly records: readonly {
    readonly id: string
    readonly name: string
    readonly revision: number
  }[]
}) {
  return records.length === 0 ? (
    <p className="panel__meta">No records</p>
  ) : (
    <div className="data-list">
      {records.map((record) => (
        <div className="record-row" key={record.id}>
          <strong>{record.name}</strong>
          <span className="mono">rev {record.revision}</span>
        </div>
      ))}
    </div>
  )
}

export function CreateNamedForm({
  label,
  onSubmit,
}: {
  readonly label: string
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form className="inline-form" onSubmit={onSubmit}>
      <Field label={label} name="name" required />
      <Button type="submit">
        <Plus size={16} aria-hidden="true" /> Add
      </Button>
    </form>
  )
}

export function EditablePlanningList({
  records,
  onSave,
}: {
  readonly records: readonly {
    readonly id: string
    readonly name: string
    readonly revision: number
  }[]
  readonly onSave: (
    record: { readonly id: string; readonly revision: number },
    name: string,
  ) => void
}) {
  return records.length === 0 ? (
    <p className="panel__meta">No records</p>
  ) : (
    <div className="data-list">
      {records.map((record) => (
        <EditablePlanningRow key={record.id} record={record} onSave={onSave} />
      ))}
    </div>
  )
}

function EditablePlanningRow({
  record,
  onSave,
}: {
  readonly record: { readonly id: string; readonly name: string; readonly revision: number }
  readonly onSave: (
    record: { readonly id: string; readonly revision: number },
    name: string,
  ) => void
}) {
  const [name, setName] = useState(record.name)
  return (
    <div className="record-row">
      <Field
        label={`Name, revision ${record.revision}`}
        name={`planning-name-${record.id}`}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <Button
        disabled={name.trim().length === 0 || name === record.name}
        onClick={() => onSave(record, name)}
      >
        <FloppyDisk size={16} aria-hidden="true" /> Save
      </Button>
    </div>
  )
}
