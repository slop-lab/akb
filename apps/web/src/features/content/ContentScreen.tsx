import { FilePlus } from "@phosphor-icons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { z } from "zod"
import {
  type ContentDocument,
  ContentDocumentSchema,
  type Page,
  type PageHistoryEntrySchema,
} from "../../../../../src/contracts/content/model.ts"
import { Button, EmptyState } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { ApiError } from "../../lib/api.ts"
import { LatestRequest } from "../../lib/latest-request.ts"
import { featureCommand, workspaceFeaturePath } from "../feature-api.ts"
import {
  type ContentScreenProps,
  EMPTY_DOCUMENT,
  HistorySchema,
  PageResponseSchema,
  PagesSchema,
} from "./content-schemas.ts"
import { CreatePageDialog } from "./CreatePageDialog.tsx"
import { PageList, PageLoadError } from "./PageNavigation.tsx"
import { PageWorkspace } from "./PageWorkspace.tsx"
import { TaskContextWorkflow } from "./TaskContextWorkflow.tsx"
import { referencesFromSelectionPage } from "./workflow-ui.ts"

export function ContentScreen({
  session,
  announce,
  initialPageId,
  initialRevision,
  initialRevisionError,
  onLocationChange,
  workflowDraft,
  onWorkflowDraftChange,
}: ContentScreenProps) {
  const [pages, setPages] = useState<readonly Page[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState("")
  const documentRef = useRef<ContentDocument>(EMPTY_DOCUMENT)
  const [history, setHistory] = useState<readonly z.infer<typeof PageHistoryEntrySchema>[]>([])
  const [error, setError] = useState<string | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const [viewRevision, setViewRevision] = useState<number | undefined>(initialRevision)
  const [createOpen, setCreateOpen] = useState(false)
  const pageRequests = useRef(new LatestRequest()).current
  const mutationRequests = useRef(new LatestRequest()).current

  const root = workspaceFeaturePath(session, "content", "/pages")
  const loadPages = useCallback(async () => {
    try {
      setPages((await session.api.feature(root, PagesSchema)).pages)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pages could not be loaded.")
    }
  }, [root, session])

  const openPage = useCallback(
    async (pageId: string, revision?: number) => {
      mutationRequests.invalidate()
      const isCurrent = pageRequests.start()
      setError(null)
      setConflictRevision(null)
      setPage(null)
      setHistory([])
      try {
        const pagePath =
          revision === undefined
            ? `${root}/${encodeURIComponent(pageId)}`
            : `${root}/${encodeURIComponent(pageId)}/revisions/${revision}`
        const next = (await session.api.feature(pagePath, PageResponseSchema)).page
        if (!isCurrent()) return
        let selectionError: string | null = null
        try {
          const references = referencesFromSelectionPage(
            session.bootstrap.workspace.id,
            next.document,
          )
          if (references !== null)
            onWorkflowDraftChange({
              references,
              selectionPage: { id: next.id, revision: next.revision },
            })
        } catch (caught) {
          selectionError =
            caught instanceof Error ? caught.message : "The saved context selection is invalid."
        }
        setPage(next)
        setTitle(next.title)
        documentRef.current = next.document
        setViewRevision(revision)
        setConflictRevision(null)
        const nextHistory = await session.api.feature(
          `${root}/${encodeURIComponent(pageId)}/history`,
          HistorySchema,
        )
        if (!isCurrent()) return
        setHistory(nextHistory.revisions)
        setError(selectionError)
      } catch (caught) {
        if (!isCurrent()) return
        setPage(null)
        setHistory([])
        setError(caught instanceof Error ? caught.message : "Page could not be opened.")
      }
    },
    [mutationRequests, onWorkflowDraftChange, pageRequests, root, session],
  )

  useEffect(() => {
    void loadPages()
    if (initialRevisionError !== undefined) {
      pageRequests.invalidate()
      setPage(null)
      setHistory([])
      setError(initialRevisionError)
    } else if (initialPageId !== undefined) void openPage(initialPageId, initialRevision)
    return () => {
      pageRequests.invalidate()
      mutationRequests.invalidate()
    }
  }, [
    initialPageId,
    initialRevision,
    initialRevisionError,
    loadPages,
    mutationRequests,
    openPage,
    pageRequests,
  ])

  async function openCreated(pageId: string, nextTitle: string) {
    setCreateOpen(false)
    await loadPages()
    onLocationChange(pageId)
    announce(`${nextTitle} created`)
  }

  async function save() {
    if (page === null) return
    const isCurrent = mutationRequests.start()
    setError(null)
    try {
      ContentDocumentSchema.parse(documentRef.current)
      await featureCommand(
        session,
        "content",
        `/pages/${encodeURIComponent(page.id)}`,
        "PATCH",
        page.revision,
        { title, document: documentRef.current },
      )
      if (!isCurrent()) return
      await loadPages()
      if (!isCurrent()) return
      announce(`${title} saved`)
      await openPage(page.id)
    } catch (caught) {
      if (!isCurrent()) return
      const message = caught instanceof Error ? caught.message : "Page could not be saved."
      setError(message)
      if (caught instanceof ApiError && caught.code === "revision_conflict") {
        const { actual } = caught.details
        setConflictRevision(typeof actual === "number" ? actual : null)
      }
    }
  }

  async function restore(revision: number) {
    if (page === null) return
    const isCurrent = mutationRequests.start()
    try {
      await featureCommand(
        session,
        "content",
        `/pages/${encodeURIComponent(page.id)}/restore`,
        "POST",
        page.revision,
        { revision },
      )
      if (!isCurrent()) return
      announce(`Revision ${revision} restored`)
      await openPage(page.id)
    } catch (caught) {
      if (!isCurrent()) return
      setError(caught instanceof Error ? caught.message : "Revision could not be restored.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Documents"
      title="Pages"
      description="Create operational Pages, pin exact task context, and keep revision history explicit."
      actions={
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <FilePlus size={16} aria-hidden="true" /> New Page
        </Button>
      }
    >
      <CreatePageDialog
        session={session}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={openCreated}
      />
      <TaskContextWorkflow
        session={session}
        announce={announce}
        onCreated={openCreated}
        draft={workflowDraft}
        onDraftChange={onWorkflowDraftChange}
      />
      <PageLoadError
        error={error}
        conflictRevision={conflictRevision}
        {...(page === null ? {} : { pageId: page.id })}
        onCancel={() => {
          setError(null)
          setConflictRevision(null)
        }}
        onReload={(pageId) => void openPage(pageId)}
      />
      <div className="master-detail">
        <PageList
          pages={pages}
          {...(page === null ? {} : { selectedId: page.id })}
          onOpen={(pageId) => {
            onLocationChange(pageId)
            void openPage(pageId)
          }}
        />
        {page === null ? (
          <EmptyState title="Select a page" body="Open a visible page or create a new one." />
        ) : (
          <PageWorkspace
            page={page}
            title={title}
            historical={viewRevision !== undefined}
            history={history}
            onTitleChange={setTitle}
            onDocumentChange={(document) => {
              documentRef.current = document
            }}
            onSave={() => void save()}
            onOpenLatest={() => {
              onLocationChange(page.id)
              void openPage(page.id)
            }}
            onView={(revision) => {
              onLocationChange(page.id, revision)
              void openPage(page.id, revision)
            }}
            onRestore={(revision) => void restore(revision)}
          />
        )}
      </div>
    </ScreenLayout>
  )
}
