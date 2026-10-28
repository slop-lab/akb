import { Copy, MagnifyingGlass, Plus } from "@phosphor-icons/react"
import { z } from "zod"
import { ContentDocumentSchema } from "../../../../../src/contracts/content/model.ts"
import type {
  ContentDocumentSummary,
  ContextReadItem,
  ContextReadResponse,
} from "../../../../../src/contracts/content/workflow.ts"
import { KnowledgeCandidateSchema } from "../../../../../src/contracts/knowledge/proposals.ts"
import { Badge, Button, EmptyState, Field, SelectField } from "../../components/primitives.tsx"
import { BlocksViewer } from "../../vendor/blocks/index.ts"
import { CandidateDetails, candidateText } from "../knowledge/KnowledgeDetails.tsx"
import { proposalSourcesFromContext } from "./workflow-ui.ts"

const PageContextSnapshotSchema = z.object({
  title: z.string(),
  document: ContentDocumentSchema,
})
const KnowledgeContextSnapshotSchema = z.object({ candidate: KnowledgeCandidateSchema })

export function TaskContextSearch({
  kind,
  query,
  busy,
  onKindChange,
  onQueryChange,
  onSearch,
}: {
  readonly kind: "page" | "knowledge"
  readonly query: string
  readonly busy: boolean
  readonly onKindChange: (kind: "page" | "knowledge") => void
  readonly onQueryChange: (query: string) => void
  readonly onSearch: () => void
}) {
  return (
    <form
      className="context-search"
      onSubmit={(event) => {
        event.preventDefault()
        onSearch()
      }}
    >
      <SelectField
        label="Source kind"
        name="kind"
        value={kind}
        options={[
          { value: "page", label: "Pages" },
          { value: "knowledge", label: "Knowledge" },
        ]}
        onChange={(value) => onKindChange(value === "page" ? "page" : "knowledge")}
      />
      <Field
        label="Title search"
        name="query"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <Button type="submit" busy={busy}>
        <MagnifyingGlass size={16} aria-hidden="true" /> Search
      </Button>
    </form>
  )
}

export function DiscoveryResults({
  items,
  searched,
  onAdd,
}: {
  readonly items: readonly ContentDocumentSummary[]
  readonly searched: boolean
  readonly onAdd: (item: ContentDocumentSummary, revision: number) => void
}) {
  if (!searched) return null
  if (items.length === 0)
    return (
      <EmptyState
        title="No discovery results"
        body="Search visible Pages or Knowledge by title to pin an exact revision."
      />
    )
  return (
    <div className="data-list">
      {items.map((item) => (
        <form
          className="context-result"
          key={`${item.kind}:${item.id}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            onAdd(item, Number(new FormData(event.currentTarget).get("revision")))
          }}
        >
          <Badge tone={item.kind === "page" ? "info" : "success"}>{item.kind}</Badge>
          <div className="context-result__identity">
            <strong>{item.title}</strong>
            <span className="mono">{item.id}</span>
          </div>
          <label className="field context-revision">
            <span className="field__label">Revision</span>
            <input
              name="revision"
              type="number"
              min={1}
              defaultValue={item.revision}
              required
              aria-label={`Revision for ${item.title} (${item.id})`}
            />
          </label>
          <Button
            type="submit"
            variant="quiet"
            aria-label={`Add ${item.title} (${item.id}) to context`}
          >
            <Plus size={16} aria-hidden="true" /> Add
          </Button>
        </form>
      ))}
    </div>
  )
}

export function AgentRequest({
  value,
  onCopy,
}: {
  readonly value: string
  readonly onCopy: (value: string) => void
}) {
  return (
    <ReadonlyJsonPanel
      title="Agent request"
      description="Credential-free request JSON for the built-in authenticated agent transport."
      copyLabel="Copy JSON"
      fieldLabel="Agent request JSON"
      value={value}
      onCopy={onCopy}
    />
  )
}

export function ContextInspection({
  context,
  onCopy,
}: {
  readonly context: ContextReadResponse
  readonly onCopy: (value: string) => void
}) {
  const proposalSources = JSON.stringify(proposalSourcesFromContext(context), null, 2)
  return (
    <section className="section-stack">
      <div>
        <h3>Read-only context</h3>
        <p>
          {context.items.length} exact revisions · {context.contentBytes} of {context.maxBytes}{" "}
          bytes
        </p>
      </div>
      <div className="context-inspection">
        {context.items.map((item) => (
          <article className="context-item" key={`${item.kind}:${item.id}:${item.revision}`}>
            <p className="panel__meta">
              {item.kind} · {item.id} · rev {item.revision}
            </p>
            <ContextItemPreview item={item} />
            <details>
              <summary>Raw revision snapshot</summary>
              <pre>{JSON.stringify(item.snapshot, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
      <ReadonlyJsonPanel
        title="Proposal sources"
        description="Use these exact references when submitting a result to the human proposal inbox."
        copyLabel="Copy sources"
        fieldLabel="Proposal sources JSON"
        value={proposalSources}
        onCopy={onCopy}
      />
    </section>
  )
}

function ContextItemPreview({ item }: { readonly item: ContextReadItem }) {
  switch (item.kind) {
    case "page": {
      const page = PageContextSnapshotSchema.safeParse(item.snapshot)
      if (!page.success) return null
      return (
        <article className="context-item-preview">
          <h4>{page.data.title}</h4>
          <BlocksViewer
            value={page.data.document}
            label={`Read ${page.data.title} revision ${item.revision}`}
          />
        </article>
      )
    }
    case "knowledge": {
      const knowledge = KnowledgeContextSnapshotSchema.safeParse(item.snapshot)
      if (!knowledge.success) return null
      return (
        <article className="context-item-preview">
          <h4>{knowledge.data.candidate.title}</h4>
          <p>{candidateText(knowledge.data.candidate)}</p>
          <CandidateDetails candidate={knowledge.data.candidate} />
        </article>
      )
    }
    default:
      return assertNever(item.kind)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported context item: ${JSON.stringify(value)}`)
}

type ReadonlyJsonPanelProps = {
  readonly title: string
  readonly description: string
  readonly copyLabel: string
  readonly fieldLabel: string
  readonly value: string
  readonly onCopy: (value: string) => void
}

function ReadonlyJsonPanel({
  title,
  description,
  copyLabel,
  fieldLabel,
  value,
  onCopy,
}: ReadonlyJsonPanelProps) {
  return (
    <section className="section-stack">
      <div className="panel__header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Button variant="quiet" onClick={() => onCopy(value)}>
          <Copy size={16} aria-hidden="true" /> {copyLabel}
        </Button>
      </div>
      <textarea
        className="code-field mono"
        aria-label={fieldLabel}
        readOnly
        rows={8}
        value={value}
      />
    </section>
  )
}
