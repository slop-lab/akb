import { Plus } from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"
import type {
  Board,
  BoardRequest,
  QueryPage,
  WorkItemDetail,
} from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Button, ErrorPanel } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { useOwnedSnapshot } from "../../hooks/useOwnedSnapshot.ts"
import { createSavedViewActions } from "./saved-view-actions.ts"
import { useWorkReferences } from "./useWorkReferences.ts"
import { CreateWorkDialog, WorkControls } from "./WorkControls.tsx"
import { WorkPeek } from "./WorkPeek.tsx"
import { WorkResults } from "./WorkResults.tsx"
import {
  applyWorkQueryDraft,
  changeWorkQueryDraft,
  createWorkQueryDraft,
  hydrateWorkQueryDraft,
  type WorkView,
} from "./work-query.ts"

export function WorkScreen({
  session,
  announce,
  initialSavedViews,
  initialProjectId = "",
  initialSpaceId: requestedSpaceId = "",
}: ScreenProps & {
  readonly initialSavedViews: boolean
  readonly initialProjectId?: string
  readonly initialSpaceId?: string
}) {
  const initialSpaceId =
    requestedSpaceId || session.bootstrap.currentSpaceId || session.bootstrap.spaces[0]?.id || ""
  const [view, setView] = useState<WorkView>("list")
  const [draft, setDraft] = useState(() => createWorkQueryDraft(initialSpaceId, initialProjectId))
  const [appliedQuery, setAppliedQuery] = useState(() =>
    applyWorkQueryDraft(createWorkQueryDraft(initialSpaceId, initialProjectId), "list"),
  )
  const [page, setPage] = useState<QueryPage | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runOwnedQuery = useOwnedSnapshot(session.api)
  const { config, projects, savedViews, loadSavedViews } = useWorkReferences({
    session,
    spaceId: draft.spaceId,
    onError: setError,
  })
  const canCreate = session.bootstrap.permissions.includes("work.create")

  const load = useCallback(async () => {
    setError(null)
    try {
      if (view === "list") {
        const result = await runOwnedQuery(() => session.api.queryWork(appliedQuery))
        setPage(result)
        setBoard(null)
        announce(`${result.completeness.matched} work items matched`)
      } else {
        const request: BoardRequest = {
          ...appliedQuery,
          workflowStateId: null,
          page: { size: Math.min(appliedQuery.page.size, 25), cursor: null },
        }
        const result = await runOwnedQuery(() => session.api.board(request))
        setBoard(result)
        setPage(null)
        announce(`${result.columns.length} board columns loaded`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Work could not be loaded.")
    }
  }, [announce, appliedQuery, runOwnedQuery, session.api, view])

  useEffect(() => {
    void load()
  }, [load])

  async function loadMore() {
    if (page?.nextCursor === null || page === null) return
    try {
      const next = await session.api.queryWork({
        ...appliedQuery,
        page: { ...appliedQuery.page, cursor: page.nextCursor },
      })
      setPage({ ...next, items: [...page.items, ...next.items] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The next page could not be loaded.")
    }
  }

  async function loadMoreBoard(stateId: string, cursor: string) {
    try {
      const next = await session.api.board({
        ...appliedQuery,
        workflowStateId: stateId,
        page: { size: 25, cursor },
      })
      const continued = next.columns.find((column) => column.state.id === stateId)
      if (continued === undefined) return
      setBoard((current) =>
        current === null
          ? next
          : {
              ...current,
              columns: current.columns.map((column) =>
                column.state.id === stateId
                  ? { ...continued, cards: [...column.cards, ...continued.cards] }
                  : column,
              ),
            },
      )
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The board column could not be continued.",
      )
    }
  }

  async function createWork(title: string) {
    const state =
      config?.workflow.states.find((candidate) => candidate.isDefault) ?? config?.workflow.states[0]
    if (state === undefined) return setError("This Space has no workflow state for new work.")
    try {
      const result = await session.api.command({
        method: "post",
        path: "/work-items",
        baseRevision: null,
        payload: {
          spaceId: draft.spaceId,
          title,
          accountableOwnerId: session.bootstrap.principal.id,
          description: "",
          type: "task",
          workflowStateId: state.id,
          projectId: draft.projectId || null,
          priority: "none",
          labelIds: [],
          startDate: null,
          dueDate: null,
        },
      })
      setCreateOpen(false)
      await load()
      setSelectedId(result.result.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Work item could not be created.")
    }
  }

  async function move(card: WorkItemDetail, stateId: string) {
    try {
      await session.api.command({
        method: "patch",
        path: `/work-items/${encodeURIComponent(card.id)}`,
        baseRevision: card.revision,
        payload: { workflowStateId: stateId },
      })
      await load()
      announce(`${card.key} moved`)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Work item move was restored because the server rejected it.",
      )
      await load()
    }
  }

  const savedViewActions = createSavedViewActions({
    session,
    query: appliedQuery,
    reload: async () => {
      await Promise.all([load(), loadSavedViews()])
    },
    announce,
    setError,
  })

  return (
    <ScreenLayout
      eyebrow={initialSavedViews ? "Saved views" : "Execution"}
      title="Work"
      description="Server-filtered list and workflow board."
      actions={
        <Button
          variant="primary"
          disabled={!canCreate || draft.spaceId.length === 0}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={16} /> Create work
        </Button>
      }
    >
      {error === null ? null : (
        <ErrorPanel
          message={error}
          actions={<Button onClick={() => void load()}>Restart query</Button>}
        />
      )}
      <WorkControls
        view={view}
        draft={draft}
        savedViews={savedViews}
        showSavedViews={initialSavedViews}
        spaces={session.bootstrap.spaces}
        projects={projects}
        config={config}
        principals={session.bootstrap.principals}
        onViewChange={(nextView) => {
          setView(nextView)
          setAppliedQuery((current) => ({
            ...current,
            page: { size: nextView === "board" ? 25 : 50, cursor: null },
          }))
        }}
        onDraftChange={(change) => setDraft((current) => changeWorkQueryDraft(current, change))}
        onApply={() => setAppliedQuery(applyWorkQueryDraft(draft, view))}
        onSaveView={(name) => void savedViewActions.save(name)}
        onOpenSavedView={(savedQuery) => {
          setDraft(hydrateWorkQueryDraft(savedQuery, draft.spaceId))
          setAppliedQuery(savedQuery)
        }}
        onRenameSavedView={(saved, name) => void savedViewActions.rename(saved, name)}
        onArchiveSavedView={(saved) => void savedViewActions.archive(saved)}
      />
      <WorkResults
        view={view}
        page={page}
        board={board}
        config={config}
        onSelect={setSelectedId}
        onLoadMore={() => void loadMore()}
        onLoadMoreBoard={(stateId, cursor) => void loadMoreBoard(stateId, cursor)}
        onMove={(card, stateId) => void move(card, stateId)}
      />
      {selectedId === null ? null : (
        <WorkPeek
          session={session}
          itemId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      )}
      <CreateWorkDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(title) => void createWork(title)}
      />
    </ScreenLayout>
  )
}
