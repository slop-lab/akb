import { type FormEvent, useEffect, useRef, useState } from "react"
import type { ContentDocument, Page, TemplateId } from "../contracts.ts"
import { type ProjectNotebookBusy, ProjectNotebookView } from "./ProjectNotebookView.tsx"
import type { ProjectNotebookProps } from "./types.ts"
import { useCommandIdentity } from "./useCommandIdentity.ts"

const EMPTY_DOCUMENT: ContentDocument = { version: 1, blocks: [] }

export function ProjectNotebook({
  client,
  projectId,
  projectName,
  pageId,
  onPageChange,
  renderEditor,
}: ProjectNotebookProps) {
  const [notebook, setNotebook] = useState<Page | null>(null)
  const [pages, setPages] = useState<readonly Page[]>([])
  const [page, setPage] = useState<Page | null>(null)
  const [title, setTitle] = useState("")
  const [document, setDocument] = useState<ContentDocument>(EMPTY_DOCUMENT)
  const [templateId, setTemplateId] = useState<TemplateId>("project-overview")
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [canReload, setCanReload] = useState(false)
  const [busy, setBusy] = useState<ProjectNotebookBusy>("loading")
  const generation = useRef(0)
  const onPageChangeRef = useRef(onPageChange)
  const notebookIdentity = useCommandIdentity()
  const createPageIdentity = useCommandIdentity()
  const savePageIdentity = useCommandIdentity()

  useEffect(() => {
    onPageChangeRef.current = onPageChange
  }, [onPageChange])

  useEffect(() => {
    const current = ++generation.current
    notebookIdentity.clear()
    createPageIdentity.clear()
    savePageIdentity.clear()
    setNotebook(null)
    setPages([])
    setPage(null)
    setTitle("")
    setDocument(EMPTY_DOCUMENT)
    setError(null)
    setConflict(false)
    setCanReload(false)
    setBusy("loading")
    void client
      .getNotebook(projectId)
      .then(async (response) => {
        if (current !== generation.current) return
        setNotebook(response.notebook)
        if (response.notebook === null) {
          setBusy(null)
          return
        }
        const nextPages = await client.listPages(response.notebook.id)
        if (current !== generation.current) return
        setPages(nextPages)
        const selectedId = pageId ?? nextPages[0]?.id
        if (
          selectedId === undefined ||
          !nextPages.some((candidate) => candidate.id === selectedId)
        ) {
          setBusy(null)
          return
        }
        const selected = await client.getPage(selectedId)
        if (current !== generation.current) return
        setPage(selected)
        setTitle(selected.title)
        setDocument(selected.document)
        setBusy(null)
        if (pageId !== selected.id) onPageChangeRef.current?.(selected.id)
      })
      .catch((caught: unknown) => {
        if (current !== generation.current) return
        setError(caught instanceof Error ? caught.message : "The Project library could not load.")
        setBusy(null)
      })
    return () => {
      generation.current += 1
    }
  }, [
    client,
    pageId,
    projectId,
    notebookIdentity.clear,
    createPageIdentity.clear,
    savePageIdentity.clear,
  ])

  async function createNotebook(): Promise<void> {
    const current = ++generation.current
    setBusy("notebook")
    setError(null)
    setConflict(false)
    setCanReload(false)
    try {
      const input = { title: `${projectName} library` }
      const created = await client.createNotebook(
        projectId,
        input,
        notebookIdentity.forPayload({ projectId, ...input }),
      )
      if (current !== generation.current) return
      notebookIdentity.clear()
      setNotebook(created)
      setPages([])
      setBusy(null)
    } catch (caught) {
      if (current !== generation.current) return
      setError(
        caught instanceof Error ? caught.message : "The Project library could not be created.",
      )
      setBusy(null)
    }
  }

  async function openPage(selectedId: string): Promise<void> {
    const current = ++generation.current
    savePageIdentity.clear()
    setBusy("open")
    setError(null)
    setConflict(false)
    setCanReload(false)
    try {
      const selected = await client.getPage(selectedId)
      if (current !== generation.current) return
      setPage(selected)
      setTitle(selected.title)
      setDocument(selected.document)
      setBusy(null)
      onPageChangeRef.current?.(selected.id)
    } catch (caught) {
      if (current !== generation.current) return
      setError(caught instanceof Error ? caught.message : "The document could not be opened.")
      setBusy(null)
    }
  }

  async function createPage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (notebook === null) return
    const form = event.currentTarget
    const nextTitle = String(new FormData(form).get("title"))
    const current = ++generation.current
    setBusy("create")
    setError(null)
    setConflict(false)
    setCanReload(false)
    try {
      const input = {
        parentPageId: notebook.id,
        title: nextTitle,
        templateId,
      }
      const created = await client.createPage(input, createPageIdentity.forPayload(input))
      const nextPages = await client.listPages(notebook.id)
      if (current !== generation.current) return
      createPageIdentity.clear()
      savePageIdentity.clear()
      setPages(nextPages)
      setPage(created)
      setTitle(created.title)
      setDocument(created.document)
      setBusy(null)
      form.reset()
      onPageChangeRef.current?.(created.id)
    } catch (caught) {
      if (current !== generation.current) return
      setError(caught instanceof Error ? caught.message : "The document could not be created.")
      setBusy(null)
    }
  }

  async function savePage(): Promise<void> {
    if (page === null || notebook === null) return
    const current = ++generation.current
    setBusy("save")
    setError(null)
    setConflict(false)
    setCanReload(false)
    try {
      const input = { id: page.id, revision: page.revision, title, document }
      const saved = await client.savePage(input, savePageIdentity.forPayload(input))
      const nextPages = await client.listPages(notebook.id)
      if (current !== generation.current) return
      savePageIdentity.clear()
      setPages(nextPages)
      setPage(saved)
      setTitle(saved.title)
      setDocument(saved.document)
      setBusy(null)
    } catch (caught) {
      if (current !== generation.current) return
      setError(caught instanceof Error ? caught.message : "The document could not be saved.")
      setConflict(isRevisionConflict(caught))
      setCanReload(true)
      setBusy(null)
    }
  }

  return (
    <ProjectNotebookView
      projectName={projectName}
      notebook={notebook}
      pages={pages}
      page={page}
      title={title}
      document={document}
      templateId={templateId}
      error={error}
      conflict={conflict}
      canReload={canReload}
      busy={busy}
      {...(renderEditor === undefined ? {} : { renderEditor })}
      onCreateNotebook={() => void createNotebook()}
      onCreatePage={(event) => void createPage(event)}
      onOpenPage={(selectedId) => void openPage(selectedId)}
      onSavePage={() => void savePage()}
      onReloadLatest={() => {
        if (page !== null) void openPage(page.id)
      }}
      onTitleChange={(nextTitle) => {
        savePageIdentity.clear()
        setTitle(nextTitle)
      }}
      onDocumentChange={(nextDocument) => {
        savePageIdentity.clear()
        setDocument(nextDocument)
      }}
      onCreatePageInputChange={createPageIdentity.clear}
      onTemplateChange={(nextTemplateId) => {
        createPageIdentity.clear()
        setTemplateId(nextTemplateId)
      }}
    />
  )
}

function isRevisionConflict(caught: unknown): boolean {
  return caught instanceof Error && "status" in caught && caught.status === 409
}
