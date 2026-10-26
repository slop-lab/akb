import type { Page, PageHistoryEntry } from "../../../../../src/contracts/content/model.ts"
import { Badge, Button, EmptyState, ErrorPanel } from "../../components/primitives.tsx"

export function PageLoadError({
  error,
  conflictRevision,
  pageId,
  onCancel,
  onReload,
}: {
  readonly error: string | null
  readonly conflictRevision: number | null
  readonly pageId?: string
  readonly onCancel: () => void
  readonly onReload: (pageId: string) => void
}) {
  if (error === null) return null
  if (conflictRevision === null) return <ErrorPanel message={error} />
  return (
    <ErrorPanel
      title="This page changed on the server"
      message={`Current server revision: ${conflictRevision}. Your unsent draft is retained. Reload latest to replace the editor with server content, or cancel to keep editing this draft.`}
      actions={
        pageId === undefined ? null : (
          <>
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={() => onReload(pageId)}>Reload latest</Button>
          </>
        )
      }
    />
  )
}

export function HistoricalPageStatus({
  page,
  onOpenLatest,
}: {
  readonly page: Page
  readonly onOpenLatest: () => void
}) {
  return (
    <div className="status-panel">
      <strong>Historical revision {page.revision}</strong>
      <p>This exact revision is read-only. Open the latest revision to continue editing.</p>
      <Button onClick={onOpenLatest}>Open latest</Button>
    </div>
  )
}

export function PageList({
  pages,
  selectedId,
  onOpen,
}: {
  readonly pages: readonly Page[]
  readonly selectedId?: string
  readonly onOpen: (pageId: string) => void
}) {
  return (
    <nav className="data-list" aria-label="Pages">
      {pages.length === 0 ? (
        <EmptyState title="No pages yet" body="Create a page above to add it to this workspace." />
      ) : (
        pages.map((page) => (
          <button
            type="button"
            className="search-result"
            aria-current={selectedId === page.id ? "page" : undefined}
            key={page.id}
            onClick={() => onOpen(page.id)}
          >
            <Badge tone={page.lifecycle === "active" ? "info" : "neutral"}>{page.lifecycle}</Badge>
            <strong title={page.title}>{page.title}</strong>
            <span className="mono">rev {page.revision}</span>
          </button>
        ))
      )}
    </nav>
  )
}

export function PageHistory({
  page,
  history,
  historical,
  onView,
  onRestore,
}: {
  readonly page: Page
  readonly history: readonly PageHistoryEntry[]
  readonly historical: boolean
  readonly onView: (revision: number) => void
  readonly onRestore: (revision: number) => void
}) {
  return (
    <section className="section-stack">
      <h2>History</h2>
      <div className="data-list">
        {history.map((entry) => (
          <div className="record-row" key={entry.revision}>
            <strong>{entry.title}</strong>
            <span className="mono">rev {entry.revision}</span>
            <Button variant="quiet" onClick={() => onView(entry.revision)}>
              View
            </Button>
            <Button
              variant="quiet"
              disabled={historical || entry.revision === page.revision}
              onClick={() => onRestore(entry.revision)}
            >
              Restore
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}
