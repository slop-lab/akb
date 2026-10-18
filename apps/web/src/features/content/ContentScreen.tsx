import { ClockCounterClockwise, FilePlus, FloppyDisk } from "@phosphor-icons/react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import {
  type ContentDocument,
  ContentDocumentSchema,
  type Page,
  PageHistoryEntrySchema,
  PageSchema,
} from "../../../../../src/contracts/content/model.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, Field } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { ApiError } from "../../lib/api.ts"
import { BlocksEditor } from "../../vendor/blocks/index.ts"
import {
  EntityFeatureMutationSchema,
  featureCommand,
  workspaceFeaturePath,
} from "../feature-api.ts"

const PagesSchema = z.object({ pages: z.array(PageSchema).readonly() })
const PageResponseSchema = z.object({
  page: PageSchema,
  projection: z.record(z.string(), z.unknown()),
})
const HistorySchema = z.object({ revisions: z.array(PageHistoryEntrySchema).readonly() })
const EMPTY_DOCUMENT: ContentDocument = {
  version: 1,
  blocks: [{ id: "paragraph:initial", type: "paragraph", text: "", children: [] }],
}

export function ContentScreen({ session, announce }: ScreenProps) {
  const [pages, setPages] = useState<readonly Page[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState("")
  const documentRef = useRef<ContentDocument>(EMPTY_DOCUMENT)
  const [history, setHistory] = useState<readonly z.infer<typeof PageHistoryEntrySchema>[]>([])
  const [error, setError] = useState<string | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)

  const root = workspaceFeaturePath(session, "content", "/pages")
  const loadPages = useCallback(async () => {
    try {
      setPages((await session.api.feature(root, PagesSchema)).pages)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pages could not be loaded.")
    }
  }, [root, session])

  const openPage = useCallback(
    async (pageId: string) => {
      setError(null)
      try {
        const next = (
          await session.api.feature(`${root}/${encodeURIComponent(pageId)}`, PageResponseSchema)
        ).page
        setPage(next)
        setTitle(next.title)
        documentRef.current = next.document
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
        setError(caught instanceof Error ? caught.message : "Page could not be opened.")
      }
    },
    [root, session],
  )

  useEffect(() => void loadPages(), [loadPages])

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
      {error === null ? null : conflictRevision !== null ? (
        <ErrorPanel
          title="This page changed on the server"
          message={`Current server revision: ${conflictRevision}. Your unsent draft is retained. Reload latest to replace the editor with server content, or cancel to keep editing this draft.`}
          actions={
            page === null ? null : (
              <>
                <Button
                  variant="quiet"
                  onClick={() => {
                    setError(null)
                    setConflictRevision(null)
                  }}
                >
                  Cancel
                </Button>
                <Button onClick={() => void openPage(page.id)}>Reload latest</Button>
              </>
            )
          }
        />
      ) : (
        <ErrorPanel message={error} />
      )}
      <div className="master-detail">
        <nav className="data-list" aria-label="Pages">
          {pages.length === 0 ? (
            <EmptyState
              title="No pages yet"
              body="Create a page above to add it to this workspace."
            />
          ) : (
            pages.map((item) => (
              <button
                type="button"
                className="search-result"
                aria-current={page?.id === item.id ? "page" : undefined}
                key={item.id}
                onClick={() => void openPage(item.id)}
              >
                <Badge tone={item.lifecycle === "active" ? "info" : "neutral"}>
                  {item.lifecycle}
                </Badge>
                <strong title={item.title}>{item.title}</strong>
                <span className="mono">rev {item.revision}</span>
              </button>
            ))
          )}
        </nav>
        {page === null ? (
          <EmptyState title="Select a page" body="Open a visible page or create a new one." />
        ) : (
          <section className="document-workspace">
            <div className="panel__header">
              <Field
                label="Title"
                name="page-title"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
              <Button variant="primary" onClick={() => void save()}>
                <FloppyDisk size={16} aria-hidden="true" /> Save
              </Button>
            </div>
            <div className="blocks-surface">
              <BlocksEditor
                key={`${page.id}:${page.revision}`}
                label={`Edit ${page.title}`}
                value={page.document}
                onChange={(document) => {
                  documentRef.current = document
                }}
              />
            </div>
            <section className="section-stack">
              <h2>
                <ClockCounterClockwise size={20} aria-hidden="true" /> History
              </h2>
              <div className="data-list">
                {history.map((entry) => (
                  <div className="record-row" key={entry.revision}>
                    <strong>{entry.title}</strong>
                    <span className="mono">rev {entry.revision}</span>
                    <Button
                      variant="quiet"
                      disabled={entry.revision === page.revision}
                      onClick={() => void restore(entry.revision)}
                    >
                      Restore
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </section>
        )}
      </div>
    </ScreenLayout>
  )
}
