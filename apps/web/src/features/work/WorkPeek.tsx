import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import type {
  Comment,
  Relation,
  SpaceConfig,
  WorkItemDetail,
} from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Button, ErrorPanel } from "../../components/primitives.tsx"
import { WorkPeekContent } from "./WorkPeekContent.tsx"

type WorkPeekProps = {
  readonly session: Session
  readonly itemId: string
  readonly onClose: () => void
  readonly onChanged: () => void
}

export function WorkPeek({ session, itemId, onClose, onChanged }: WorkPeekProps) {
  const [item, setItem] = useState<WorkItemDetail | null>(null)
  const [comments, setComments] = useState<readonly Comment[]>([])
  const [relations, setRelations] = useState<readonly Relation[]>([])
  const [config, setConfig] = useState<SpaceConfig | null>(null)
  const [tab, setTab] = useState("details")
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const detail = await session.api.workItem(itemId)
      const [nextComments, nextRelations, nextConfig] = await Promise.all([
        session.api.comments(itemId).catch((caught) => {
          if (caught instanceof Error && caught.message === "This entity is unavailable.") return []
          throw caught
        }),
        session.api.relations(itemId).catch((caught) => {
          if (caught instanceof Error && caught.message === "This entity is unavailable.") return []
          throw caught
        }),
        session.api.spaceConfig(detail.space.id),
      ])
      setItem(detail)
      setComments(nextComments)
      setRelations(nextRelations)
      setConfig(nextConfig)
      requestAnimationFrame(() => headingRef.current?.focus())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Work item could not be loaded.")
    }
  }, [itemId, session.api])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [onClose])

  async function update(field: string, value: unknown) {
    if (item === null) return
    try {
      await session.api.command({
        method: "patch",
        path: `/work-items/${encodeURIComponent(item.id)}`,
        baseRevision: item.revision,
        payload: { [field]: value },
      })
      await load()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Work item could not be updated.")
    }
  }

  async function addComment(event: FormEvent) {
    event.preventDefault()
    if (item === null || draft.trim().length === 0) return
    try {
      await session.api.command({
        method: "post",
        path: `/entities/${encodeURIComponent(item.id)}/comments`,
        baseRevision: null,
        payload: { body: draft },
      })
      setDraft("")
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comment could not be posted.")
    }
  }

  async function editComment(comment: Comment, body: string) {
    if (body.trim().length === 0 || body === comment.body) return
    try {
      await session.api.command({
        method: "patch",
        path: `/comments/${encodeURIComponent(comment.id)}`,
        baseRevision: comment.revision,
        payload: { body: body.trim() },
      })
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Comment could not be updated.")
    }
  }

  async function addRelation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (item === null) return
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await session.api.command({
        method: "post",
        path: "/relations",
        baseRevision: null,
        payload: {
          fromEntityId: item.id,
          relationType: String(data.get("type")),
          toEntityId: String(data.get("target")),
        },
      })
      form.reset()
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Relation could not be created.")
    }
  }

  async function addParent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (item === null) return
    const form = event.currentTarget
    const parentId = String(new FormData(form).get("parent") ?? "").trim()
    if (parentId.length === 0) return
    try {
      await session.api.command({
        method: "post",
        path: "/relations",
        baseRevision: null,
        payload: { fromEntityId: parentId, relationType: "parent_of", toEntityId: item.id },
      })
      form.reset()
      await load()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Parent could not be added.")
    }
  }

  async function removeRelation(relation: Relation) {
    try {
      await session.api.command({
        method: "post",
        path: `/relations/${encodeURIComponent(relation.id)}/archive`,
        baseRevision: relation.revision,
        payload: {},
      })
      await load()
      onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Parent could not be removed.")
    }
  }

  async function lifecycle(action: "archive" | "restore") {
    if (item === null) return
    try {
      await session.api.command({
        method: "post",
        path: `/work-items/${encodeURIComponent(item.id)}/${action}`,
        baseRevision: item.revision,
        payload: {},
      })
      await load()
      onChanged()
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Work item lifecycle could not be updated.",
      )
    }
  }

  return (
    <aside className="peek" aria-label="Work item detail">
      <header className="peek__header">
        <div>
          <p className="mono">{item?.key ?? "Loading"}</p>
          <h2 ref={headingRef} tabIndex={-1}>
            {item?.title ?? "Work item"}
          </h2>
          <p>{item === null ? "" : `Revision ${item.revision}`}</p>
        </div>
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      </header>
      {error === null ? null : (
        <ErrorPanel
          {...(error.includes("changed") ? { title: "This item changed on the server" } : {})}
          message={error}
          actions={
            <div className="cluster">
              <Button onClick={() => void load()}>Reload latest</Button>
              <Button variant="quiet" onClick={() => setError(null)}>
                Cancel
              </Button>
            </div>
          }
        />
      )}
      <WorkPeekContent
        session={session}
        item={item}
        tab={tab}
        comments={comments}
        relations={relations}
        config={config}
        draft={draft}
        onTabChange={setTab}
        onDraftChange={setDraft}
        onUpdate={(field, value) => void update(field, value)}
        onLifecycle={(action) => void lifecycle(action)}
        onAddComment={(event) => void addComment(event)}
        onEditComment={(comment, body) => void editComment(comment, body)}
        onAddRelation={(event) => void addRelation(event)}
        onAddParent={(event) => void addParent(event)}
        onRemoveRelation={(relation) => void removeRelation(relation)}
        onError={setError}
      />
    </aside>
  )
}
