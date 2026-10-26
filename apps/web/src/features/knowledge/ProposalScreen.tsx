import { CheckCircle } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { z } from "zod"
import { BUILT_IN_KNOWLEDGE_REVIEW_POLICY } from "../../../../../src/contracts/knowledge/proposals.ts"
import {
  type KnowledgeProposal,
  KnowledgeProposalSchema,
  type KnowledgeProposalSummary,
  KnowledgeProposalSummarySchema,
} from "../../../../../src/contracts/knowledge/reads.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, SelectField } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { featureCommand, workspaceFeaturePath } from "../feature-api.ts"
import { CreateProposal } from "./CreateProposal.tsx"
import { CandidateDetails, candidateText, SourceList } from "./KnowledgeDetails.tsx"

const ProposalListSchema = z.strictObject({
  proposals: z.array(KnowledgeProposalSummarySchema).readonly(),
})
const ProposalResponseSchema = z.strictObject({ proposal: KnowledgeProposalSchema })

type ProposalScreenProps = ScreenProps & {
  readonly initialProposalId?: string
  readonly onLocationChange: (proposalId?: string) => void
}

export function ProposalScreen({
  session,
  announce,
  initialProposalId,
  onLocationChange,
}: ProposalScreenProps) {
  const [proposals, setProposals] = useState<readonly KnowledgeProposalSummary[]>([])
  const [selected, setSelected] = useState<KnowledgeProposal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const root = workspaceFeaturePath(session, "knowledge", "")

  const loadInbox = useCallback(async () => {
    try {
      setProposals(
        (await session.api.feature(`${root}/proposals?status=pending&limit=50`, ProposalListSchema))
          .proposals,
      )
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Proposal inbox could not be loaded.")
    }
  }, [root, session])

  const openProposal = useCallback(
    async (proposalId: string) => {
      try {
        setSelected(null)
        setSelected(
          (
            await session.api.feature(
              `${root}/proposals/${encodeURIComponent(proposalId)}`,
              ProposalResponseSchema,
            )
          ).proposal,
        )
        setError(null)
      } catch (caught) {
        setSelected(null)
        setError(caught instanceof Error ? caught.message : "Proposal could not be loaded.")
      }
    },
    [root, session],
  )

  useEffect(() => void loadInbox(), [loadInbox])
  useEffect(() => {
    if (initialProposalId !== undefined) void openProposal(initialProposalId)
  }, [initialProposalId, openProposal])

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selected === null) return
    if (selected.status !== "pending") {
      setError("Only pending proposals can be reviewed.")
      return
    }
    const data = new FormData(event.currentTarget)
    try {
      await featureCommand(
        session,
        "knowledge",
        `/proposals/${encodeURIComponent(selected.proposalId)}/reviews`,
        "POST",
        selected.revision,
        {
          decision: String(data.get("decision")),
          rationale: String(data.get("rationale")),
          policyId: BUILT_IN_KNOWLEDGE_REVIEW_POLICY.id,
          policyRevision: BUILT_IN_KNOWLEDGE_REVIEW_POLICY.revision,
        },
      )
      announce("Knowledge review recorded")
      setSelected(null)
      onLocationChange()
      await loadInbox()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be recorded.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Knowledge review"
      title="Proposal inbox"
      description="Review durable pending proposals from Work Hub or other authorized integrations."
      actions={
        <CreateProposal
          session={session}
          announce={announce}
          onCreated={(id) => {
            onLocationChange(id)
            void openProposal(id)
            void loadInbox()
          }}
        />
      }
    >
      {error === null ? null : <ErrorPanel message={error} />}
      <div className="master-detail">
        <nav className="data-list" aria-label="Pending proposals">
          {proposals.length === 0 ? (
            <EmptyState
              title="No pending proposals"
              body="New submissions appear here after reload."
            />
          ) : (
            proposals.map((proposal) => (
              <button
                type="button"
                className="search-result"
                aria-current={selected?.proposalId === proposal.proposalId ? "page" : undefined}
                key={proposal.proposalId}
                onClick={() => {
                  onLocationChange(proposal.proposalId)
                  void openProposal(proposal.proposalId)
                }}
              >
                <Badge tone="warning">pending</Badge>
                <strong>{proposal.candidate.title}</strong>
                <span className="mono">rev {proposal.revision}</span>
              </button>
            ))
          )}
        </nav>
        {selected === null ? (
          <EmptyState
            title="Select a proposal"
            body="Open a pending proposal to inspect and decide it."
          />
        ) : (
          <section className="panel proposal-detail">
            <div className="panel__header">
              <div>
                <h2>{selected.candidate.title}</h2>
                <p className="panel__meta">
                  {selected.candidate.type} · target {selected.targetId}
                </p>
              </div>
              <Badge tone={selected.status === "pending" ? "warning" : "neutral"}>
                {selected.status}
              </Badge>
            </div>
            <code className="mono">
              {selected.proposalId} · rev {selected.revision}
            </code>
            <p>{candidateText(selected.candidate)}</p>
            <CandidateDetails candidate={selected.candidate} />
            <SourceList sources={selected.sources} />
            {selected.status === "pending" ? (
              <form className="form-stack" onSubmit={(event) => void review(event)}>
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
                <label className="field">
                  <span className="field__label">Rationale</span>
                  <textarea name="rationale" rows={4} />
                </label>
                <Button type="submit" variant="primary">
                  <CheckCircle size={16} aria-hidden="true" /> Record review
                </Button>
              </form>
            ) : (
              <div className="status-panel">
                <strong>Decision recorded</strong>
                <p>This proposal is {selected.status.replaceAll("_", " ")} and is read-only.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </ScreenLayout>
  )
}
