import type { ReactNode } from "react"
import type { ProjectKbClient } from "../client.ts"
import type { ContentDocument, Page } from "../contracts.ts"

export type ProjectKbEditorProps = {
  readonly page: Page
  readonly document: ContentDocument
  readonly onChange: (document: ContentDocument) => void
}

export type ProjectNotebookProps = {
  readonly client: ProjectKbClient
  readonly projectId: string
  readonly projectName: string
  readonly pageId?: string
  readonly onPageChange?: (pageId: string | undefined) => void
  readonly renderEditor?: (props: ProjectKbEditorProps) => ReactNode
}
