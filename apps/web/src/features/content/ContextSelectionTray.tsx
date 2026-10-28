import { Copy, LinkSimple, Trash } from "@phosphor-icons/react"
import type { ContentDocumentReference } from "../../../../../src/contracts/content/workflow.ts"
import { Badge, Button, EmptyState } from "../../components/primitives.tsx"
import { qualifiedReferenceHref } from "./workflow-ui.ts"

type ContextSelectionTrayProps = {
  readonly workspaceId: string
  readonly references: readonly ContentDocumentReference[]
  readonly onRemove: (reference: ContentDocumentReference) => void
  readonly onCopy: (value: string, message: string) => void
}

export function ContextSelectionTray({
  workspaceId,
  references,
  onRemove,
  onCopy,
}: ContextSelectionTrayProps) {
  if (references.length === 0)
    return (
      <EmptyState
        title="No pinned sources"
        body="Search visible Pages or Knowledge, then add an explicit revision."
      />
    )
  return (
    <section className="context-tray" aria-label="Pinned context sources">
      {references.map((reference) => {
        const href = qualifiedReferenceHref(workspaceId, reference)
        return (
          <article
            className="context-reference"
            key={`${reference.kind}:${reference.id}:${reference.revision}`}
          >
            <div>
              <Badge tone={reference.kind === "page" ? "info" : "success"}>{reference.kind}</Badge>
              <strong>{reference.id}</strong>
              <span className="mono">rev {reference.revision}</span>
            </div>
            <div className="cluster">
              <a className="button button--quiet" href={href} target="_blank" rel="noreferrer">
                <LinkSimple size={16} aria-hidden="true" /> Open
              </a>
              <Button variant="quiet" onClick={() => onCopy(href, "Source link copied")}>
                <Copy size={16} aria-hidden="true" /> Copy link
              </Button>
              <Button variant="quiet" onClick={() => onRemove(reference)}>
                <Trash size={16} aria-hidden="true" /> Remove
              </Button>
            </div>
          </article>
        )
      })}
    </section>
  )
}
