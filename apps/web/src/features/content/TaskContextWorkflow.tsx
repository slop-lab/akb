import { FilePlus } from "@phosphor-icons/react"
import { type FormEvent, useRef, useState } from "react"
import {
  ContentDocumentDiscoveryResponseSchema,
  type ContentDocumentSummary,
  type ContextReadResponse,
  ContextReadRequestSchema,
  ContextReadResponseSchema,
  DEFAULT_CONTEXT_MAX_BYTES,
  MAX_CONTEXT_MAX_BYTES,
  createContextSelectionDocument,
} from "../../../../../src/contracts/content/workflow.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Button, ErrorPanel, Field } from "../../components/primitives.tsx"
import { LatestRequest } from "../../lib/latest-request.ts"
import {
  EntityFeatureMutationSchema,
  featureCommand,
  workspaceFeaturePath,
} from "../feature-api.ts"
import { ContextSelectionTray } from "./ContextSelectionTray.tsx"
import type { ContentWorkflowDraft } from "./content-workflow-state.ts"
import {
  AgentRequest,
  ContextInspection,
  DiscoveryResults,
  TaskContextSearch,
} from "./TaskContextPresentation.tsx"
import {
  agentContextRequest,
  appendContextReference,
  copyText,
  contextWorkflowErrorMessage,
  sameContextReference,
} from "./workflow-ui.ts"

type TaskContextWorkflowProps = ScreenProps & {
  readonly onCreated: (pageId: string, title: string) => Promise<void>
  readonly draft: ContentWorkflowDraft
  readonly onDraftChange: (draft: ContentWorkflowDraft) => void
}

export function TaskContextWorkflow({
  session,
  announce,
  onCreated,
  draft,
  onDraftChange,
}: TaskContextWorkflowProps) {
  const [kind, setKind] = useState<"page" | "knowledge">("page")
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<readonly ContentDocumentSummary[]>([])
  const [searched, setSearched] = useState(false)
  const [nextAfterId, setNextAfterId] = useState<string | null>(null)
  const [loadedContext, setLoadedContext] = useState<{
    readonly key: string
    readonly value: ContextReadResponse
  } | null>(null)
  const [maxBytes, setMaxBytes] = useState(String(DEFAULT_CONTEXT_MAX_BYTES))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const discoveryRequests = useRef(new LatestRequest()).current
  const contextRequests = useRef(new LatestRequest()).current
  const root = workspaceFeaturePath(session, "content", "")
  const { references, selectionPage } = draft
  const requestKey = JSON.stringify({ references, selectionPage, maxBytes: Number(maxBytes) })
  const currentRequestKey = useRef(requestKey)
  currentRequestKey.current = requestKey
  const context = loadedContext?.key === requestKey ? loadedContext.value : null

  function resetDiscovery() {
    discoveryRequests.invalidate()
    setDiscovering(false)
    setItems([])
    setNextAfterId(null)
    setSearched(false)
    setLoadedContext(null)
    setError(null)
  }

  async function discover(afterId = "") {
    const isCurrent = discoveryRequests.start()
    setDiscovering(true)
    setError(null)
    try {
      const parameters = new URLSearchParams({ kind, query, limit: "20", afterId })
      const response = await session.api.feature(
        `${root}/documents?${parameters.toString()}`,
        ContentDocumentDiscoveryResponseSchema,
      )
      if (!isCurrent()) return
      setItems((previous) =>
        afterId.length === 0 ? response.items : [...previous, ...response.items],
      )
      setNextAfterId(response.nextAfterId)
      setSearched(true)
    } catch (caught) {
      if (!isCurrent()) return
      setError(
        caught instanceof Error ? caught.message : "Visible documents could not be searched.",
      )
    } finally {
      if (isCurrent()) setDiscovering(false)
    }
  }

  function addReference(item: ContentDocumentSummary, revision: number) {
    try {
      const nextReferences = appendContextReference(references, item, revision)
      if (nextReferences === references) return
      onDraftChange({ references: nextReferences, selectionPage: null })
      setLoadedContext(null)
      setError(null)
      announce(`${item.title} revision ${revision} pinned`)
    } catch (caught) {
      setError(contextWorkflowErrorMessage(caught, "Enter a positive revision."))
    }
  }

  async function saveSelection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const title = String(new FormData(event.currentTarget).get("title"))
    setBusy(true)
    setError(null)
    try {
      const document = createContextSelectionDocument(session.bootstrap.workspace.id, references)
      const result = EntityFeatureMutationSchema.parse(
        await featureCommand(session, "content", "/pages", "POST", null, {
          spaceId: null,
          parentPageId: null,
          title,
          document,
        }),
      )
      await onCreated(result.result.id, title)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Task context could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  async function inspect() {
    const isCurrent = contextRequests.start()
    const expectedKey = requestKey
    setBusy(true)
    setError(null)
    try {
      setLoadedContext(null)
      const request = ContextReadRequestSchema.parse({
        ...(selectionPage === null ? { references } : { selectionPage }),
        maxBytes: Number(maxBytes),
      })
      const response = await session.api.feature(`${root}/context`, ContextReadResponseSchema, {
        method: "POST",
        body: request,
      })
      if (isCurrent() && currentRequestKey.current === expectedKey)
        setLoadedContext({ key: expectedKey, value: response })
    } catch (caught) {
      if (isCurrent() && currentRequestKey.current === expectedKey)
        setError(contextWorkflowErrorMessage(caught, "Task context could not be loaded."))
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  async function copy(value: string, message: string) {
    try {
      await copyText(value)
      announce(message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Content could not be copied.")
    }
  }

  const requestBody = ContextReadRequestSchema.safeParse({
    ...(selectionPage === null ? { references } : { selectionPage }),
    maxBytes: Number(maxBytes),
  })
  return (
    <details className="filter-panel task-context">
      <summary>Task context</summary>
      <p className="panel__meta">
        Pin only explicit visible revisions. No related content is added automatically.
      </p>
      {error === null ? null : <ErrorPanel message={error} />}
      <TaskContextSearch
        kind={kind}
        query={query}
        busy={busy || discovering}
        onKindChange={(nextKind) => {
          setKind(nextKind)
          resetDiscovery()
        }}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery)
          resetDiscovery()
        }}
        onSearch={() => void discover()}
      />
      <DiscoveryResults items={items} searched={searched} onAdd={addReference} />
      {nextAfterId === null ? null : (
        <Button variant="quiet" busy={discovering} onClick={() => void discover(nextAfterId)}>
          Load more results
        </Button>
      )}
      <ContextSelectionTray
        workspaceId={session.bootstrap.workspace.id}
        references={references}
        onRemove={(reference) => {
          onDraftChange({
            references: references.filter(
              (candidate) => !sameContextReference(candidate, reference),
            ),
            selectionPage: null,
          })
          setLoadedContext(null)
        }}
        onCopy={(value, message) => void copy(value, message)}
      />
      <div className="context-actions">
        <form className="inline-form" onSubmit={(event) => void saveSelection(event)}>
          <Field label="Selection Page title" name="title" required />
          <Button type="submit" variant="primary" busy={busy} disabled={references.length === 0}>
            <FilePlus size={16} aria-hidden="true" /> Save as Page
          </Button>
        </form>
        <div className="form-columns">
          <Field
            label="Context byte limit"
            name="maxBytes"
            type="number"
            min={1}
            max={MAX_CONTEXT_MAX_BYTES}
            value={maxBytes}
            onChange={(event) => setMaxBytes(event.currentTarget.value)}
          />
          <Button onClick={() => void inspect()} busy={busy} disabled={!requestBody.success}>
            Load read-only context
          </Button>
        </div>
      </div>
      {requestBody.success ? (
        <AgentRequest
          value={agentContextRequest(session.bootstrap.workspace.id, requestBody.data)}
          onCopy={(value) => void copy(value, "Agent request copied")}
        />
      ) : null}
      {context === null ? null : (
        <ContextInspection
          context={context}
          onCopy={(value) => void copy(value, "Proposal sources copied")}
        />
      )}
    </details>
  )
}
