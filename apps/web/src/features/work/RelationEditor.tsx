import type { FormEvent } from "react"
import type { Relation } from "../../../../../src/contracts/r4/index.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"

type RelationEditorProps = {
  readonly itemId: string
  readonly relations: readonly Relation[]
  readonly onAdd: (event: FormEvent<HTMLFormElement>) => void
  readonly onAddParent: (event: FormEvent<HTMLFormElement>) => void
  readonly onRemove: (relation: Relation) => void
}

export function RelationEditor({
  itemId,
  relations,
  onAdd,
  onAddParent,
  onRemove,
}: RelationEditorProps) {
  const parentRelations = relations.filter(
    (relation) => relation.relationType === "parent_of" && relation.to.id === itemId,
  )
  return (
    <section className="section-stack">
      <div>
        <h3>Parent</h3>
        {parentRelations.length === 0 ? <p>No parent set.</p> : null}
        {parentRelations.map((relation) => (
          <div className="panel" key={relation.id}>
            <strong>{relation.from.name}</strong>
            <Button variant="quiet" onClick={() => onRemove(relation)}>
              Remove parent
            </Button>
          </div>
        ))}
        <form className="inline-form" onSubmit={onAddParent}>
          <Field label="Parent entity ID" name="parent" required />
          <Button type="submit" variant="primary">
            Add parent
          </Button>
        </form>
      </div>
      <form className="inline-form" onSubmit={onAdd}>
        <Field label="Target entity ID" name="target" required />
        <SelectField
          label="Type"
          name="type"
          defaultValue="related_to"
          options={[
            "blocks",
            "related_to",
            "duplicates",
            "implements",
            "verifies",
            "supports",
            "contradicts",
            "supersedes",
            "generated_by",
          ].map((value) => ({ value, label: value }))}
        />
        <Button type="submit" variant="primary">
          Add relation
        </Button>
      </form>
      {relations.map((relation) => (
        <div className="panel" key={relation.id}>
          <strong>
            {relation.from.name} {relation.relationType.replaceAll("_", " ")} {relation.to.name}
          </strong>
          <span className="mono">rev {relation.revision}</span>
        </div>
      ))}
    </section>
  )
}
