import { type FormEvent, useState } from "react"
import type { Space } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"

type SharedProps = {
  readonly session: Session
  readonly canManage: boolean
  readonly onSaved: (id: string) => void
  readonly onError: (message: string) => void
}

export function SpaceDetailsForm({
  session,
  space,
  canManage,
  onSaved,
  onError,
}: SharedProps & {
  readonly space: Space
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      await session.api.command({
        method: "patch",
        path: `/spaces/${encodeURIComponent(space.id)}`,
        baseRevision: space.revision,
        payload: {
          name: String(data.get("name")),
          visibility: String(data.get("visibility")),
          description: String(data.get("description")),
          icon: String(data.get("icon")) || null,
          leadId: String(data.get("leadId")) || null,
        },
      })
      onSaved(space.id)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Space details could not be saved.")
    }
  }
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <Field label="Name" name="name" defaultValue={space.name} required disabled={!canManage} />
      <SelectField
        label="Visibility"
        name="visibility"
        defaultValue={space.visibility}
        options={[
          { value: "public", label: "Public" },
          { value: "private", label: "Private" },
        ]}
        disabled={!canManage}
      />
      <Field
        label="Description"
        name="description"
        defaultValue={space.description}
        disabled={!canManage}
      />
      <Field label="Icon" name="icon" defaultValue={space.icon ?? ""} disabled={!canManage} />
      <SelectField
        label="Lead"
        name="leadId"
        defaultValue={space.lead?.id ?? ""}
        options={[
          { value: "", label: "No lead" },
          ...session.bootstrap.principals.map((principal) => ({
            value: principal.id,
            label: principal.name,
          })),
        ]}
        disabled={!canManage}
      />
      <Button type="submit" variant="primary" disabled={!canManage}>
        Save Space
      </Button>
    </form>
  )
}

export function CreateSpaceForm({ session, canManage, onSaved, onError }: SharedProps) {
  const [visibility, setVisibility] = useState<"public" | "private">("public")
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    try {
      const result = await session.api.command({
        method: "post",
        path: "/spaces",
        baseRevision: null,
        payload: {
          id: String(data.get("id")),
          key: String(data.get("key")),
          name: String(data.get("name")),
          visibility,
          description: String(data.get("description")),
          icon: null,
          leadId: null,
        },
      })
      onSaved(result.result.id)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Space could not be created.")
    }
  }
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <Field label="ID" name="id" required disabled={!canManage} />
      <Field label="Key" name="key" required pattern="[A-Z0-9]{2,10}" disabled={!canManage} />
      <Field label="Name" name="name" required disabled={!canManage} />
      <SelectField
        label="Visibility"
        name="visibility"
        value={visibility}
        onChange={(value) => setVisibility(value === "private" ? "private" : "public")}
        options={[
          { value: "public", label: "Public" },
          { value: "private", label: "Private" },
        ]}
        disabled={!canManage}
      />
      <Field label="Description" name="description" disabled={!canManage} />
      <Button type="submit" variant="primary" disabled={!canManage}>
        Create Space
      </Button>
    </form>
  )
}
