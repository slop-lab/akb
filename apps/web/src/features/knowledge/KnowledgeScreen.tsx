import { MagnifyingGlass } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { z } from "zod"
import {
  type KnowledgeObject,
  KnowledgeObjectSchema,
} from "../../../../../src/contracts/knowledge/reads.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, Field } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { workspaceFeaturePath } from "../feature-api.ts"
import { CandidateDetails, candidateText, SourceList } from "./KnowledgeDetails.tsx"
import { ProposalScreen } from "./ProposalScreen.tsx"

const SearchSchema = z.array(KnowledgeObjectSchema).readonly()

type KnowledgeScreenProps = ScreenProps & {
  readonly mode: "knowledge" | "proposals"
  readonly initialKnowledgeId?: string
  readonly initialRevision?: number
  readonly initialRevisionError?: string
  readonly initialProposalId?: string
  readonly onKnowledgeLocationChange: (knowledgeId: string, revision?: number) => void
  readonly onProposalLocationChange: (proposalId?: string) => void
}

export function KnowledgeScreen(props: KnowledgeScreenProps) {
  if (props.mode === "proposals")
    return (
      <ProposalScreen
        session={props.session}
        announce={props.announce}
        {...(props.initialProposalId === undefined
          ? {}
          : { initialProposalId: props.initialProposalId })}
        onLocationChange={props.onProposalLocationChange}
      />
    )
  return <KnowledgeCatalog {...props} />
}

function KnowledgeCatalog({
  session,
  initialKnowledgeId,
  initialRevision,
  initialRevisionError,
  onKnowledgeLocationChange,
}: KnowledgeScreenProps) {
  const [query, setQuery] = useState("")
  const [objects, setObjects] = useState<readonly KnowledgeObject[]>([])
  const [selected, setSelected] = useState<KnowledgeObject | null>(null)
  const [historicalRevision, setHistoricalRevision] = useState<number | undefined>(initialRevision)
  const [error, setError] = useState<string | null>(null)
  const root = workspaceFeaturePath(session, "knowledge", "")

  const open = useCallback(
    async (knowledgeId: string, revision?: number) => {
      try {
        setSelected(null)
        const objectPath =
          revision === undefined
            ? `${root}/objects/${encodeURIComponent(knowledgeId)}`
            : `${root}/objects/${encodeURIComponent(knowledgeId)}/revisions/${revision}`
        setSelected(await session.api.feature(objectPath, KnowledgeObjectSchema))
        setHistoricalRevision(revision)
        setError(null)
      } catch (caught) {
        setSelected(null)
        setError(caught instanceof Error ? caught.message : "Knowledge could not be opened.")
      }
    },
    [root, session],
  )

  useEffect(() => {
    if (initialRevisionError !== undefined) {
      setSelected(null)
      setError(initialRevisionError)
    } else if (initialKnowledgeId !== undefined) void open(initialKnowledgeId, initialRevision)
  }, [initialKnowledgeId, initialRevision, initialRevisionError, open])

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const path = `${root}/objects?query=${encodeURIComponent(query)}&includeSuperseded=false&limit=50`
      setObjects(await session.api.feature(path, SearchSchema))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Knowledge search failed.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Knowledge"
      title="Canonical knowledge"
      description="Search accepted knowledge and open an exact immutable revision."
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
      <div className="master-detail">
        <nav className="data-list" aria-label="Knowledge results">
          {objects.length === 0 ? (
            <EmptyState title="No knowledge loaded" body="Search by title or content." />
          ) : (
            objects.map((object) => (
              <button
                type="button"
                className="search-result"
                aria-current={selected?.id === object.id ? "page" : undefined}
                key={object.id}
                onClick={() => {
                  onKnowledgeLocationChange(object.id, object.revision)
                  void open(object.id, object.revision)
                }}
              >
                <Badge tone="success">{object.candidate.type}</Badge>
                <strong>{object.candidate.title}</strong>
                <span className="mono">rev {object.revision}</span>
              </button>
            ))
          )}
        </nav>
        {selected === null ? (
          <EmptyState title="Select knowledge" body="Open a search result or a shared deep link." />
        ) : (
          <article className="panel knowledge-detail">
            <div className="panel__header">
              <div>
                <h2>{selected.candidate.title}</h2>
                <p className="panel__meta">Accepted knowledge · {selected.candidate.type}</p>
              </div>
              <Badge tone="success">accepted</Badge>
            </div>
            <p>{candidateText(selected.candidate)}</p>
            <CandidateDetails candidate={selected.candidate} />
            <dl className="metadata-grid">
              <span>Revision</span>
              <code>{selected.revision}</code>
              <span>Reviewed</span>
              <time dateTime={selected.reviewedAt}>
                {new Date(selected.reviewedAt).toLocaleString()}
              </time>
            </dl>
            {historicalRevision === undefined ? null : (
              <p className="blocks-caption">
                This is exact immutable revision {historicalRevision}.
              </p>
            )}
            <SourceList sources={selected.sources} />
          </article>
        )}
      </div>
    </ScreenLayout>
  )
}
