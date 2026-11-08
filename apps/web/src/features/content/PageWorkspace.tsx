import { FloppyDisk } from "@phosphor-icons/react"
import type {
  ContentDocument,
  Page,
  PageHistoryEntry,
} from "../../../../../src/contracts/content/model.ts"
import { Button, Field } from "../../components/primitives.tsx"
import { BlocksEditor, BlocksViewer } from "../../vendor/blocks/index.ts"
import { HistoricalPageStatus, PageHistory } from "./PageNavigation.tsx"

type PageWorkspaceProps = {
  readonly page: Page
  readonly title: string
  readonly historical: boolean
  readonly history: readonly PageHistoryEntry[]
  readonly onTitleChange: (title: string) => void
  readonly onDocumentChange: (document: ContentDocument) => void
  readonly onSave: () => void
  readonly onOpenLatest: () => void
  readonly onView: (revision: number) => void
  readonly onRestore: (revision: number) => void
}

export function PageWorkspace({
  page,
  title,
  historical,
  history,
  onTitleChange,
  onDocumentChange,
  onSave,
  onOpenLatest,
  onView,
  onRestore,
}: PageWorkspaceProps) {
  return (
    <section className="document-workspace">
      <div className="panel__header">
        <Field
          label="Title"
          name="page-title"
          value={title}
          readOnly={historical}
          onChange={(event) => onTitleChange(event.currentTarget.value)}
        />
        <Button variant="primary" disabled={historical} onClick={onSave}>
          <FloppyDisk size={16} aria-hidden="true" /> Save
        </Button>
      </div>
      <div className="blocks-surface">
        {historical ? (
          <BlocksViewer
            value={page.document}
            label={`Read ${page.title} revision ${page.revision}`}
          />
        ) : (
          <BlocksEditor
            key={`${page.id}:${page.revision}`}
            label={`Edit ${page.title}`}
            value={page.document}
            onChange={onDocumentChange}
          />
        )}
      </div>
      {historical ? <HistoricalPageStatus page={page} onOpenLatest={onOpenLatest} /> : null}
      <PageHistory
        page={page}
        history={history}
        historical={historical}
        onView={onView}
        onRestore={onRestore}
      />
    </section>
  )
}
