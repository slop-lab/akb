import { FilePlus, FloppyDisk } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import type { z } from "zod"
import {
  type ContentDocument,
  ContentDocumentSchema,
  type Page,
  type PageHistoryEntrySchema,
} from "../../../../../src/contracts/content/model.ts"
import { Button, EmptyState, Field } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { ApiError } from "../../lib/api.ts"
import { BlocksEditor, BlocksViewer } from "../../vendor/blocks/index.ts"
import {
  EntityFeatureMutationSchema,
  featureCommand,
  workspaceFeaturePath,
} from "../feature-api.ts"
import {
  type ContentScreenProps,
  EMPTY_DOCUMENT,
  HistorySchema,
  PageResponseSchema,
  PagesSchema,
} from "./content-schemas.ts"
import { HistoricalPageStatus, PageHistory, PageList, PageLoadError } from "./PageNavigation.tsx"

export function ContentScreen({
  session,
  announce,
  initialPageId,
  initialRevision,
  initialRevisionError,
  onLocationChange,
}: ContentScreenProps) {
  const [pages, setPages] = useState<readonly Page[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState("")
  const documentRef = useRef<ContentDocument>(EMPTY_DOCUMENT)
  const [history, setHistory] = useState<readonly z.infer<typeof PageHistoryEntrySchema>[]>([])
  const [error, setError] = useState<string | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const [viewRevision, setViewRevision] = useState<number | undefined>(initialRevision)

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
      setError(null)
      setPage(null)
      setHistory([])
      try {
        const pagePath =
          revision === undefined
            ? `${root}/${encodeURIComponent(pageId)}`
            : `${root}/${encodeURIComponent(pageId)}/revisions/${revision}`
        const next = (await session.api.feature(pagePath, PageResponseSchema)).page
        setPage(next)
        setTitle(next.title)
        documentRef.current = next.document
        setViewRevision(revision)
        setConflictRevision(null)
        setHistory(
          (
            await session.api.feature(
              `${root}/${encodeURIComponent(pageId)}/history`,
              HistorySchema,
            )
          ).revisions,
        )
      } catch (caught) {
        setPage(null)
        setHistory([])
        setError(caught instanceof Error ? caught.message : "Page could not be opened.")
      }
    },
    [root, session],
  )

  useEffect(() => {
    void loadPages()
    if (initialRevisionError !== undefined) {
      setPage(null)
      setHistory([])
      setError(initialRevisionError)
    } else if (initialPageId !== undefined) void openPage(initialPageId, initialRevision)
  }, [initialPageId, initialRevision, initialRevisionError, loadPages, openPage])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const nextTitle = String(new FormData(form).get("title"))
    try {
      const result = EntityFeatureMutationSchema.parse(
        await featureCommand(session, "content", "/pages", "POST", null, {
          spaceId: null,
          parentPageId: null,
          title: nextTitle,
          document: EMPTY_DOCUMENT,
        }),
      )
      await loadPages()
      await openPage(result.result.id)
      onLocationChange(result.result.id)
      announce(`${nextTitle} created`)
      form.reset()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Page could not be created.")
    }
  }

  async function save() {
    if (page === null) return
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
      await openPage(page.id)
      await loadPages()
      announce(`${title} saved`)
    } catch (caught) {
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
    try {
      await featureCommand(
        session,
        "content",
        `/pages/${encodeURIComponent(page.id)}/restore`,
        "POST",
        page.revision,
        { revision },
      )
      await openPage(page.id)
      announce(`Revision ${revision} restored`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Revision could not be restored.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Documents"
      title="Pages"
      description="Canonical Blocks documents with revision history and explicit conflict recovery."
    >
      <form className="inline-form" onSubmit={(event) => void create(event)}>
        <Field label="New page title" name="title" required />
        <Button type="submit" variant="primary">
          <FilePlus size={16} aria-hidden="true" /> Create page
        </Button>
      </form>
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
          <section className="document-workspace">
            <div className="panel__header">
              <Field
                label="Title"
                name="page-title"
                value={title}
                readOnly={viewRevision !== undefined}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              <Button
                variant="primary"
                disabled={viewRevision !== undefined}
                onClick={() => void save()}
              >
                <FloppyDisk size={16} aria-hidden="true" /> Save
              </Button>
            </div>
            <div className="blocks-surface">
              {viewRevision === undefined ? (
                <BlocksEditor
                  key={`${page.id}:${page.revision}`}
                  label={`Edit ${page.title}`}
                  value={page.document}
                  onChange={(document) => {
                    documentRef.current = document
                  }}
                />
              ) : (
                <BlocksViewer
                  value={page.document}
                  label={`Read ${page.title} revision ${page.revision}`}
                />
              )}
            </div>
            {viewRevision === undefined ? null : (
              <HistoricalPageStatus
                page={page}
                onOpenLatest={() => {
                  onLocationChange(page.id)
                  void openPage(page.id)
                }}
              />
            )}
            <PageHistory
              page={page}
              history={history}
              historical={viewRevision !== undefined}
              onView={(revision) => {
                onLocationChange(page.id, revision)
                void openPage(page.id, revision)
              }}
              onRestore={(revision) => void restore(revision)}
            />
          </section>
        )}
      </div>
    </ScreenLayout>
  )
}
