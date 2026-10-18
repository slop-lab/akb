import { CheckCircle, MagnifyingGlass, NotePencil } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import { BUILT_IN_KNOWLEDGE_REVIEW_POLICY } from "../../../../../src/contracts/knowledge/proposals.ts"
import { KnowledgeObjectSchema } from "../../../../../src/contracts/knowledge/reads.ts"
import type { ScreenProps } from "../../app/types.ts"
import {
  Badge,
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  SelectField,
} from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { featureCommand, workspaceFeaturePath } from "../feature-api.ts"

const SearchSchema = z.array(KnowledgeObjectSchema).readonly()
const ProposalMutationSchema = z.object({
  result: z.object({ proposalId: z.string() }).passthrough(),
  revision: z.number().int().positive(),
})

export function KnowledgeScreen({ session, announce }: ScreenProps) {
  const [query, setQuery] = useState("")
  const [objects, setObjects] = useState<z.infer<typeof SearchSchema>>([])
  const [proposal, setProposal] = useState<{
    readonly id: string
    readonly revision: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = workspaceFeaturePath(session, "knowledge", "")

  async function search(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    try {
      const path = `${root}/objects?query=${encodeURIComponent(query)}&includeSuperseded=false&limit=50`
      setObjects(await session.api.feature(path, SearchSchema))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Knowledge search failed.")
    }
  }

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
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
            confidence: Number(data.get("confidence")),
            validityScope: "",
          },
          sources: [],
          relations: [],
          profileId: null,
          profileRevision: null,
          inputRevision: null,
        }),
      )
      setProposal({ id: result.result.proposalId, revision: result.revision })
      announce("Knowledge proposal created")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Proposal could not be created.")
    }
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (proposal === null) return
    const data = new FormData(event.currentTarget)
    try {
      await featureCommand(
        session,
        "knowledge",
        `/proposals/${encodeURIComponent(proposal.id)}/reviews`,
        "POST",
        proposal.revision,
        {
          decision: String(data.get("decision")),
          rationale: String(data.get("rationale")),
          policyId: String(data.get("policyId")),
          policyRevision: Number(data.get("policyRevision")),
        },
      )
      setProposal(null)
      await search()
      announce("Knowledge review recorded")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be recorded.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Knowledge"
      title="Proposals and review"
      description="Search canonical knowledge, propose typed claims, and record explicit review decisions."
    >
      <form className="search-form" onSubmit={(event) => void search(event)}>
        <Field
          label="Search knowledge"
          name="knowledge-search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary">
          <MagnifyingGlass size={16} aria-hidden="true" /> Search
        </Button>
      </form>
      {error === null ? null : <ErrorPanel message={error} />}
      {objects.length === 0 ? (
        <EmptyState
          title="No canonical knowledge loaded"
          body="Search by title or content, or create a proposal below."
        />
      ) : (
        <div className="content-grid">
          {objects.map((object) => (
            <article className="panel" key={object.id}>
              <div className="panel__header">
                <h3>{object.candidate.title}</h3>
                <div className="cluster">
                  <Badge tone="success">{object.candidate.type}</Badge>
                  <Badge tone="success">accepted</Badge>
                </div>
              </div>
              <p className="panel__meta">Reviewed {new Date(object.reviewedAt).toLocaleString()}</p>
              <span className="mono">rev {object.revision}</span>
            </article>
          ))}
        </div>
      )}
      <div className="feature-columns">
        <section className="section-stack">
          <h2>
            <NotePencil size={20} aria-hidden="true" /> Propose a claim
          </h2>
          <form className="form-stack" onSubmit={(event) => void propose(event)}>
            <Field
              label="Target ID"
              name="targetId"
              required
              help="A new stable knowledge object ID."
            />
            <Field label="Title" name="title" required />
            <label className="field">
              <span className="field__label">Statement</span>
              <textarea name="statement" required rows={4} />
            </label>
            <Field
              label="Confidence"
              name="confidence"
              type="number"
              min="0"
              max="1"
              step="0.01"
              defaultValue="0.8"
              required
            />
            <Button type="submit">Create proposal</Button>
          </form>
        </section>
        <section className="section-stack">
          <h2>
            <CheckCircle size={20} aria-hidden="true" /> Review proposal
          </h2>
          {proposal === null ? (
            <EmptyState
              title="No pending proposal"
              body="Create a proposal in this session to review it."
            />
          ) : (
            <form className="form-stack" onSubmit={(event) => void review(event)}>
              <p className="mono">
                {proposal.id} · rev {proposal.revision}
              </p>
              <SelectField
                label="Decision"
                name="decision"
                defaultValue="accepted"
                options={[
                  { value: "accepted", label: "Accept" },
                  { value: "rejected", label: "Reject" },
                  { value: "changes_requested", label: "Request changes" },
                ]}
              />
              <Field
                label="Policy ID"
                name="policyId"
                value={BUILT_IN_KNOWLEDGE_REVIEW_POLICY.id}
                readOnly
                required
              />
              <Field
                label="Policy revision"
                name="policyRevision"
                type="number"
                min="1"
                value={BUILT_IN_KNOWLEDGE_REVIEW_POLICY.revision}
                readOnly
                required
              />
              <label className="field">
                <span className="field__label">Rationale</span>
                <textarea name="rationale" rows={3} />
              </label>
              <Button type="submit" variant="primary">
                Record review
              </Button>
            </form>
          )}
        </section>
      </div>
    </ScreenLayout>
  )
}
