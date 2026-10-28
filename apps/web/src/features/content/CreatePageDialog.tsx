import { FilePlus } from "@phosphor-icons/react"
import { type FormEvent, useEffect, useState } from "react"
import { z } from "zod"
import { ContentPageTemplateSchema } from "../../../../../src/contracts/content/templates.ts"
import type { Session } from "../../app/types.ts"
import { Button, Dialog, ErrorPanel, Field, SelectField } from "../../components/primitives.tsx"
import {
  EntityFeatureMutationSchema,
  featureCommand,
  workspaceFeaturePath,
} from "../feature-api.ts"

const TemplatesResponseSchema = z.strictObject({
  templates: z.array(ContentPageTemplateSchema).readonly(),
})

type CreatePageDialogProps = {
  readonly session: Session
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreated: (pageId: string, title: string) => Promise<void>
}

export function CreatePageDialog({ session, open, onClose, onCreated }: CreatePageDialogProps) {
  const [templates, setTemplates] = useState<z.infer<typeof TemplatesResponseSchema>["templates"]>(
    [],
  )
  const [templateId, setTemplateId] = useState("blank")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    void session.api
      .feature(workspaceFeaturePath(session, "content", "/templates"), TemplatesResponseSchema)
      .then((response) => setTemplates(response.templates))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Page templates could not be loaded.")
      })
  }, [open, session])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const title = String(data.get("title"))
    const template = templates.find((candidate) => candidate.id === templateId)
    if (template === undefined) {
      setError("Select an available Page template.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = EntityFeatureMutationSchema.parse(
        await featureCommand(session, "content", "/pages", "POST", null, {
          spaceId: null,
          parentPageId: null,
          title,
          document: template.document,
        }),
      )
      form.reset()
      setTemplateId("blank")
      await onCreated(result.result.id, title)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Page could not be created.")
    } finally {
      setBusy(false)
    }
  }

  const selected = templates.find((template) => template.id === templateId)
  return (
    <Dialog title="Create Page" open={open} onClose={onClose}>
      <form className="form-stack" onSubmit={(event) => void create(event)}>
        {error === null ? null : <ErrorPanel message={error} />}
        <Field label="Page title" name="title" required autoFocus />
        <SelectField
          label="Template"
          name="template"
          value={templateId}
          disabled={templates.length === 0}
          options={templates.map((template) => ({ value: template.id, label: template.name }))}
          onChange={setTemplateId}
        />
        {selected === undefined ? null : <p className="field__help">{selected.description}</p>}
        <div className="dialog-actions">
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={templates.length === 0}>
            <FilePlus size={16} aria-hidden="true" /> Create Page
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
