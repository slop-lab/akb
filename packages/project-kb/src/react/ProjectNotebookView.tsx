import type { FormEvent, ReactNode } from "react"
import type { ContentDocument, Page, TemplateId } from "../contracts.ts"
import { PROJECT_KB_TEMPLATES, TemplateIdSchema } from "../contracts.ts"
import { DefaultBlockEditor } from "./DefaultBlockEditor.tsx"
import type { ProjectKbEditorProps } from "./types.ts"

export type ProjectNotebookBusy = "loading" | "notebook" | "create" | "open" | "save" | null

type ProjectNotebookViewProps = {
  readonly projectName: string
  readonly notebook: Page | null
  readonly pages: readonly Page[]
  readonly page: Page | null
  readonly title: string
  readonly document: ContentDocument
  readonly templateId: TemplateId
  readonly error: string | null
  readonly conflict: boolean
  readonly canReload: boolean
  readonly busy: ProjectNotebookBusy
  readonly renderEditor?: (props: ProjectKbEditorProps) => ReactNode
  readonly onCreateNotebook: () => void
  readonly onCreatePage: (event: FormEvent<HTMLFormElement>) => void
  readonly onOpenPage: (pageId: string) => void
  readonly onSavePage: () => void
  readonly onReloadLatest: () => void
  readonly onTitleChange: (title: string) => void
  readonly onDocumentChange: (document: ContentDocument) => void
  readonly onCreatePageInputChange: () => void
  readonly onTemplateChange: (templateId: TemplateId) => void
}

export function ProjectNotebookView(props: ProjectNotebookViewProps) {
  return (
    <section className="kb-project-library" aria-labelledby="kb-project-library-title">
      <header className="kb-project-library__header">
        <div>
          <p className="kb-eyebrow">Project library</p>
          <h2 id="kb-project-library-title">{props.projectName}</h2>
          <p>
            Creative briefs, experiments, decisions, and source-file references in ordinary Pages.
          </p>
        </div>
        {props.notebook === null && props.busy !== "loading" ? (
          <button
            type="button"
            className="kb-button kb-button--primary"
            onClick={props.onCreateNotebook}
            disabled={props.busy !== null}
          >
            Create library
          </button>
        ) : null}
      </header>
      {props.conflict ? (
        <div className="kb-status kb-status--danger" role="alert">
          <strong>This document changed on the server</strong>
          <p>
            Your unsaved draft is retained. Reload latest only when you are ready to replace it.
          </p>
          <button type="button" className="kb-button" onClick={props.onReloadLatest}>
            Reload latest
          </button>
        </div>
      ) : props.error === null ? null : (
        <div className="kb-status kb-status--danger" role="alert">
          {props.error}
          {props.canReload ? (
            <>
              <p>Your unsaved draft is retained.</p>
              <button type="button" className="kb-button" onClick={props.onReloadLatest}>
                Reload latest
              </button>
            </>
          ) : null}
        </div>
      )}
      {props.busy === "loading" ? <p role="status">Loading Project library...</p> : null}
      {props.notebook === null || props.busy === "loading" ? null : (
        <div className="kb-library-grid">
          <aside className="kb-library-sidebar" aria-label="Project documents">
            <form className="kb-create-form" onSubmit={props.onCreatePage}>
              <label className="kb-field">
                <span className="kb-field__label">Document title</span>
                <input
                  name="title"
                  required
                  disabled={props.busy !== null}
                  onChange={props.onCreatePageInputChange}
                />
              </label>
              <label className="kb-field">
                <span className="kb-field__label">Template</span>
                <select
                  value={props.templateId}
                  onChange={(event) =>
                    props.onTemplateChange(TemplateIdSchema.parse(event.currentTarget.value))
                  }
                  disabled={props.busy !== null}
                >
                  {PROJECT_KB_TEMPLATES.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="kb-help">
                {
                  PROJECT_KB_TEMPLATES.find((template) => template.id === props.templateId)
                    ?.description
                }
              </p>
              <button
                type="submit"
                className="kb-button kb-button--primary"
                disabled={props.busy !== null}
              >
                Create document
              </button>
            </form>
            <nav className="kb-page-list" aria-label="Documents">
              {props.pages.length === 0 ? (
                <p className="kb-empty">No documents yet.</p>
              ) : (
                props.pages.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-current={candidate.id === props.page?.id ? "page" : undefined}
                    onClick={() => props.onOpenPage(candidate.id)}
                    disabled={props.busy !== null}
                  >
                    <strong>{candidate.title}</strong>
                    <span>Revision {candidate.revision}</span>
                  </button>
                ))
              )}
            </nav>
          </aside>
          <div className="kb-document-workspace">
            {props.page === null ? (
              <div className="kb-empty">
                <strong>Select a document</strong>
                <span>Create or open a Page from this Project library.</span>
              </div>
            ) : (
              <>
                <div className="kb-document-toolbar">
                  <label className="kb-field kb-document-title">
                    <span className="kb-field__label">Title</span>
                    <input
                      value={props.title}
                      onChange={(event) => props.onTitleChange(event.currentTarget.value)}
                      disabled={props.busy !== null}
                    />
                  </label>
                  <button
                    type="button"
                    className="kb-button kb-button--primary"
                    onClick={props.onSavePage}
                    disabled={props.busy !== null}
                  >
                    Save document
                  </button>
                </div>
                <p className="kb-source-note">
                  Source files stay in your DAW, engine, or asset store. Record stable paths or URLs
                  and the decisions they support here.
                </p>
                <div
                  className="kb-editor-surface"
                  aria-busy={props.busy !== null}
                  inert={props.busy !== null || undefined}
                >
                  {props.renderEditor === undefined ? (
                    <DefaultBlockEditor
                      document={props.document}
                      disabled={props.busy !== null}
                      onChange={props.onDocumentChange}
                    />
                  ) : (
                    props.renderEditor({
                      page: props.page,
                      document: props.document,
                      onChange: props.onDocumentChange,
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
