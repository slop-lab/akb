import { type FormEvent, type KeyboardEvent, useId } from "react"
import type {
  Comment,
  Relation,
  SpaceConfig,
  WorkItemDetail,
} from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Button } from "../../components/primitives.tsx"
import { RelationEditor } from "./RelationEditor.tsx"
import { WorkDetails } from "./WorkDetails.tsx"

type WorkPeekContentProps = {
  readonly session: Session
  readonly item: WorkItemDetail | null
  readonly tab: string
  readonly comments: readonly Comment[]
  readonly relations: readonly Relation[]
  readonly config: SpaceConfig | null
  readonly draft: string
  readonly onTabChange: (tab: string) => void
  readonly onDraftChange: (draft: string) => void
  readonly onUpdate: (field: string, value: unknown) => void
  readonly onLifecycle: (action: "archive" | "restore") => void
  readonly onAddComment: (event: FormEvent) => void
  readonly onEditComment: (comment: Comment, body: string) => void
  readonly onAddRelation: (event: FormEvent<HTMLFormElement>) => void
  readonly onAddParent: (event: FormEvent<HTMLFormElement>) => void
  readonly onRemoveRelation: (relation: Relation) => void
  readonly onError: (message: string) => void
}

export function WorkPeekContent(props: WorkPeekContentProps) {
  const tabsetId = useId()
  const tabs = ["details", "relations", "comments"] as const
  function selectByKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : index + offset
    if (offset === 0 && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const next = tabs[(target + tabs.length) % tabs.length]
    if (next === undefined) return
    props.onTabChange(next)
    requestAnimationFrame(() => document.getElementById(`${tabsetId}-${next}-tab`)?.focus())
  }
  return (
    <>
      <div className="tabs" role="tablist">
        {tabs.map((value, index) => (
          <button
            type="button"
            key={value}
            id={`${tabsetId}-${value}-tab`}
            role="tab"
            aria-selected={props.tab === value}
            aria-controls={`${tabsetId}-${value}-panel`}
            tabIndex={props.tab === value ? 0 : -1}
            onClick={() => props.onTabChange(value)}
            onKeyDown={(event) => selectByKeyboard(event, index)}
          >
            {value}
          </button>
        ))}
      </div>
      {props.item !== null && props.tab === "details" ? (
        <div
          id={`${tabsetId}-details-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsetId}-details-tab`}
        >
          <WorkDetails
            key={props.item.id}
            session={props.session}
            item={props.item}
            config={props.config}
            onUpdate={props.onUpdate}
            onLifecycle={props.onLifecycle}
            onError={props.onError}
          />
        </div>
      ) : null}
      {props.tab === "relations" ? (
        <div
          id={`${tabsetId}-relations-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsetId}-relations-tab`}
        >
          <RelationEditor
            itemId={props.item?.id ?? ""}
            relations={props.relations}
            onAdd={props.onAddRelation}
            onAddParent={props.onAddParent}
            onRemove={props.onRemoveRelation}
          />
        </div>
      ) : null}
      {props.tab === "comments" ? (
        <div
          id={`${tabsetId}-comments-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsetId}-comments-tab`}
        >
          <Comments
            comments={props.comments}
            draft={props.draft}
            onDraftChange={props.onDraftChange}
            onAdd={props.onAddComment}
            onEdit={props.onEditComment}
          />
        </div>
      ) : null}
    </>
  )
}

function Comments({
  comments,
  draft,
  onDraftChange,
  onAdd,
  onEdit,
}: {
  readonly comments: readonly Comment[]
  readonly draft: string
  readonly onDraftChange: (draft: string) => void
  readonly onAdd: (event: FormEvent) => void
  readonly onEdit: (comment: Comment, body: string) => void
}) {
  return (
    <section className="section-stack">
      <div className="comment-list">
        {comments.map((comment) => (
          <article key={comment.id}>
            <div className="panel__meta">
              <strong>{comment.author.name}</strong>
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString()}
              </time>
            </div>
            <p>{comment.body}</p>
            <details>
              <summary>Edit comment</summary>
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault()
                  const body = String(new FormData(event.currentTarget).get("body") ?? "")
                  onEdit(comment, body)
                }}
              >
                <label className="field">
                  <span className="field__label">Comment body</span>
                  <textarea name="body" rows={3} defaultValue={comment.body} required />
                </label>
                <Button type="submit">Save comment</Button>
              </form>
            </details>
          </article>
        ))}
      </div>
      <form className="form-stack" onSubmit={onAdd}>
        <label className="field" htmlFor="comment-draft">
          <span className="field__label">Comment</span>
          <textarea
            id="comment-draft"
            rows={4}
            value={draft}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
          />
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={() => onDraftChange("")}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Comment
          </Button>
        </div>
      </form>
    </section>
  )
}
