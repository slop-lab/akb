import { Kanban, List } from "@phosphor-icons/react"
import { useState } from "react"
import type { Bootstrap } from "../../../../../src/contracts/r4/human.ts"
import type {
  HumanWorkQuery,
  Project,
  SavedView,
  SpaceConfig,
} from "../../../../../src/contracts/r4/index.ts"
import { Button, Dialog, Field, SelectField } from "../../components/primitives.tsx"
import { WorkFilterFields } from "./WorkFilterFields.tsx"
import type { WorkQueryDraft, WorkView } from "./work-query.ts"

type WorkControlsProps = {
  readonly view: WorkView
  readonly draft: WorkQueryDraft
  readonly savedViews: readonly SavedView[]
  readonly showSavedViews: boolean
  readonly spaces: readonly { readonly id: string; readonly name: string }[]
  readonly projects: readonly Project[]
  readonly config: SpaceConfig | null
  readonly principals: Bootstrap["principals"]
  readonly onViewChange: (view: WorkView) => void
  readonly onDraftChange: (change: Partial<Omit<WorkQueryDraft, "source">>) => void
  readonly onApply: () => void
  readonly onSaveView: (name: string) => void
  readonly onOpenSavedView: (query: HumanWorkQuery) => void
  readonly onRenameSavedView: (view: SavedView, name: string) => void
  readonly onArchiveSavedView: (view: SavedView) => void
}

export function WorkControls(props: WorkControlsProps) {
  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          <button
            type="button"
            aria-pressed={props.view === "list"}
            onClick={() => props.onViewChange("list")}
          >
            <List size={16} /> List
          </button>
          <button
            type="button"
            aria-pressed={props.view === "board"}
            onClick={() => props.onViewChange("board")}
          >
            <Kanban size={16} /> Board
          </button>
        </div>
        <SelectField
          label="Space"
          name="work-space"
          value={props.draft.spaceId}
          onChange={(spaceId) => props.onDraftChange({ spaceId })}
          options={props.spaces.map((space) => ({ value: space.id, label: space.name }))}
        />
        <Field
          label="Search"
          name="work-search"
          type="search"
          value={props.draft.search}
          onChange={(event) => props.onDraftChange({ search: event.currentTarget.value })}
        />
        <SelectField
          label="Priority"
          name="work-priority"
          value={props.draft.priority}
          onChange={(priority) => props.onDraftChange({ priority })}
          options={[
            { value: "", label: "All priorities" },
            ...["none", "low", "medium", "high", "urgent"].map((value) => ({
              value,
              label: value,
            })),
          ]}
        />
        <Button onClick={props.onApply}>Apply</Button>
        <Button
          variant="quiet"
          onClick={() => {
            const name = window.prompt("Saved view name")
            if (name !== null && name.trim().length > 0) props.onSaveView(name.trim())
          }}
        >
          Save view
        </Button>
      </div>
      <WorkFilterFields
        draft={props.draft}
        projects={props.projects}
        config={props.config}
        principals={props.principals}
        onChange={props.onDraftChange}
      />
      {props.showSavedViews || props.savedViews.length > 0 ? (
        <section className="saved-strip" aria-label="Saved views">
          {props.savedViews
            .filter((saved) => saved.archivedAt === null)
            .map((saved) => (
              <div className="saved-view-card" key={saved.id}>
                <button type="button" onClick={() => props.onOpenSavedView(saved.definition)}>
                  <strong>{saved.name}</strong>
                  <span>
                    {saved.access} · {saved.owner.name}
                  </span>
                </button>
                <div className="saved-view-card__actions">
                  <Button
                    variant="quiet"
                    onClick={() => {
                      const name = window.prompt("Saved view name", saved.name)
                      if (name?.trim() && name.trim() !== saved.name)
                        props.onRenameSavedView(saved, name.trim())
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      if (window.confirm(`Archive ${saved.name}?`)) props.onArchiveSavedView(saved)
                    }}
                  >
                    Archive
                  </Button>
                </div>
              </div>
            ))}
        </section>
      ) : null}
    </>
  )
}

export function CreateWorkDialog({
  open,
  onClose,
  onCreate,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreate: (title: string) => void
}) {
  const [title, setTitle] = useState("")
  return (
    <Dialog title="Create work item" open={open} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          onCreate(title)
        }}
      >
        <Field
          label="Title"
          name="create-work-title"
          autoFocus
          required
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Create work
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
