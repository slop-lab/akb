import type {
  Board,
  QueryPage,
  SpaceConfig,
  WorkItemDetail,
} from "../../../../../src/contracts/r4/index.ts"
import { Badge, Button, EmptyState, SelectField } from "../../components/primitives.tsx"

type WorkResultsProps = {
  readonly view: "list" | "board"
  readonly page: QueryPage | null
  readonly board: Board | null
  readonly config: SpaceConfig | null
  readonly onSelect: (id: string) => void
  readonly onLoadMore: () => void
  readonly onLoadMoreBoard: (stateId: string, cursor: string) => void
  readonly onMove: (card: WorkItemDetail, stateId: string) => void
}

export function WorkResults({
  view,
  page,
  board,
  config,
  onSelect,
  onLoadMore,
  onLoadMoreBoard,
  onMove,
}: WorkResultsProps) {
  if (view === "list" && page !== null) {
    if (page.items.length === 0)
      return (
        <EmptyState
          title="No results for these filters"
          body="Change the server query or create work in this Space."
        />
      )
    return (
      <section aria-label="Work items">
        <div className="data-list">
          <div className="data-row data-row--header">
            <span>Key and title</span>
            <span>State</span>
            <span>Owner</span>
            <span>Due date</span>
          </div>
          {page.items.map((item) => (
            <button
              type="button"
              className="data-row"
              key={item.id}
              onClick={() => onSelect(item.id)}
            >
              <span>
                <span className="mono">{item.key}</span>
                <br />
                <strong>{item.title}</strong>
              </span>
              <span>
                <span
                  className="color-swatch"
                  style={{ backgroundColor: item.workflowState.color }}
                />{" "}
                {item.workflowState.name}
              </span>
              <span>{item.accountableOwner.name}</span>
              <span>{item.dueDate ?? "Not set"}</span>
            </button>
          ))}
        </div>
        <div className="pagination">
          <span>
            {page.items.length} loaded of {page.completeness.matched}
          </span>
          {page.nextCursor === null ? null : <Button onClick={onLoadMore}>Load more</Button>}
        </div>
      </section>
    )
  }
  if (view !== "board" || board === null) return null
  return (
    <section className="board-grid" aria-label="Work board">
      {board.columns.map((column) => (
        <section
          className="board-column"
          key={column.state.id}
          aria-labelledby={`board-column-${column.state.id}`}
        >
          <header>
            <h3 id={`board-column-${column.state.id}`}>
              <span
                className="color-swatch"
                style={{ backgroundColor: column.state.color }}
                aria-hidden="true"
              />{" "}
              {column.state.name}
            </h3>
            <span className="mono">{column.total}</span>
          </header>
          <div className="board-cards">
            {column.cards.map((card) => (
              <article className="work-card" key={card.id}>
                <div>
                  <span className="mono">{card.key}</span>
                  <Badge>{card.priority}</Badge>
                </div>
                <button type="button" className="card-title" onClick={() => onSelect(card.id)}>
                  {card.title}
                </button>
                <p>
                  {card.accountableOwner.name} · {card.project?.name ?? "No project"}
                </p>
                <SelectField
                  label="Move"
                  name={`move-${card.id}`}
                  value={card.workflowState.id}
                  onChange={(value) => onMove(card, value)}
                  options={(config?.workflow.states ?? []).map((state) => ({
                    value: state.id,
                    label: state.name,
                  }))}
                />
              </article>
            ))}
          </div>
          {column.nextCursor === null ? null : (
            <Button onClick={() => onLoadMoreBoard(column.state.id, column.nextCursor ?? "")}>
              Load more
            </Button>
          )}
        </section>
      ))}
    </section>
  )
}
