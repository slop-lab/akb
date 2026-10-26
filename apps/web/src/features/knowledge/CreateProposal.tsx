import { NotePencil } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import type { ScreenProps } from "../../app/types.ts"
import { Button, ErrorPanel, Field } from "../../components/primitives.tsx"
import { featureCommand } from "../feature-api.ts"

const ProposalMutationSchema = z.object({
  result: z.object({ proposalId: z.string() }).passthrough(),
  revision: z.number().int().positive(),
})

export function CreateProposal({
  session,
  announce,
  onCreated,
}: ScreenProps & { readonly onCreated: (id: string) => void }) {
  const [error, setError] = useState<string | null>(null)
  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const result = ProposalMutationSchema.parse(
        await featureCommand(session, "knowledge", "/proposals", "POST", null, {
          targetId: String(data.get("targetId")),
          action: "knowledge.create",
          baseRevision: null,
          candidate: {
            type: "claim",
            title: String(data.get("title")),
            statement: String(data.get("statement")),
            status: "proposed",
            confidence: 0.8,
            validityScope: "",
          },
          sources: [],
          relations: [],
          profileId: null,
          profileRevision: null,
          inputRevision: null,
        }),
      )
      setError(null)
      announce("Knowledge proposal created")
      form.reset()
      onCreated(result.result.proposalId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Proposal could not be created.")
    }
  }
  return (
    <details className="filter-panel">
      <summary>
        <NotePencil size={16} aria-hidden="true" /> Create proposal
      </summary>
      <form className="form-stack" onSubmit={(event) => void propose(event)}>
        {error === null ? null : <ErrorPanel message={error} />}
        <Field label="Target ID" name="targetId" required />
        <Field label="Title" name="title" required />
        <label className="field">
          <span className="field__label">Statement</span>
          <textarea name="statement" required rows={3} />
        </label>
        <Button type="submit">Create proposal</Button>
      </form>
    </details>
  )
}
