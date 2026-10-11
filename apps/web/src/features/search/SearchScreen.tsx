import { MagnifyingGlass } from "@phosphor-icons/react"
import { type FormEvent, useState } from "react"
import { z } from "zod"
import type { Project } from "../../../../../src/contracts/r4/index.ts"
import type { SearchKind, SearchResult } from "../../../../../src/contracts/r4/search.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, EmptyState, ErrorPanel, Field } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { useOwnedSnapshot } from "../../hooks/useOwnedSnapshot.ts"
import { WorkPeek } from "../work/WorkPeek.tsx"

const CommentSnapshotSchema = z.object({ subjectId: z.string() })

export function SearchScreen({ session, announce }: ScreenProps) {
  const [text, setText] = useState("")
  const [results, setResults] = useState<readonly SearchResult[]>([])
  const [kinds, setKinds] = useState<readonly SearchKind[]>(["project", "work_item", "comment"])
  const [matched, setMatched] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [submittedQuery, setSubmittedQuery] = useState<{
    readonly text: string
    readonly kinds: readonly SearchKind[]
  } | null>(null)
  const [workId, setWorkId] = useState<string | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runOwnedQuery = useOwnedSnapshot(session.api)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setResults([])
    setMatched(0)
    setNextCursor(null)
    setSubmittedQuery(null)
    try {
      const response = await runOwnedQuery(() => session.api.search(text, kinds))
      setResults(response.results)
      setMatched(response.matched)
      setNextCursor(response.nextCursor)
      setSubmittedQuery({ text, kinds })
      announce(`${response.matched} search results`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search could not be completed.")
    }
  }

  async function loadMore() {
    if (submittedQuery === null || nextCursor === null) return
    setError(null)
    try {
      const response = await session.api.search(
        submittedQuery.text,
        submittedQuery.kinds,
        nextCursor,
      )
      setResults((current) => [...current, ...response.results])
      setNextCursor(response.nextCursor)
      announce(`${response.results.length} more search results loaded`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "More results could not be loaded.")
    }
  }

  async function open(result: SearchResult) {
    try {
      if (result.kind === "project") {
        setProject(await session.api.project(result.id))
        return
      }
      if (result.kind === "work_item") {
        setWorkId(result.id)
        return
      }
      const history = await session.api.history(result.id)
      const parsed = CommentSnapshotSchema.safeParse(history[0]?.snapshot)
      if (!parsed.success) {
        setError("This comment subject is unavailable.")
        return
      }
      setWorkId(parsed.data.subjectId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This result could not be opened.")
    }
  }

  function toggleKind(kind: SearchKind) {
    setKinds((current) =>
      current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind],
    )
  }

  return (
    <ScreenLayout
      eyebrow="Workspace search"
      title="Search"
      description="Server-ranked Projects, Work items, and comments."
    >
      <form className="search-form" onSubmit={(event) => void submit(event)}>
        <Field
          label="Search text"
          name="global-search"
          autoFocus
          required
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <fieldset>
          <legend>Result kinds</legend>
          <div className="cluster">
            {(["project", "work_item", "comment"] as const).map((kind) => (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={kinds.includes(kind)}
                  onChange={() => toggleKind(kind)}
                />{" "}
                {kind.replace("_", " ")}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" variant="primary" disabled={kinds.length === 0}>
          <MagnifyingGlass size={16} /> Search
        </Button>
      </form>
      {error === null ? null : <ErrorPanel message={error} />}
      {submittedQuery === null ? null : (
        <p className="panel__meta">
          Showing {results.length} of {matched} matches
        </p>
      )}
      {results.length === 0 ? (
        <EmptyState
          title={submittedQuery === null ? "Search the Workspace" : "No matches"}
          body={
            submittedQuery === null
              ? "Results are filtered by server-authoritative visibility before matching and ranking."
              : "Try different text or result kinds."
          }
        />
      ) : (
        <div className="data-list">
          {results.map((result) => (
            <button
              type="button"
              className="search-result"
              key={`${result.kind}:${result.id}`}
              onClick={() => void open(result)}
            >
              <Badge>{result.kind.replace("_", " ")}</Badge>
              <strong>{result.title}</strong>
              <span className="mono">rev {result.sourceRevision}</span>
            </button>
          ))}
        </div>
      )}
      {nextCursor === null ? null : <Button onClick={() => void loadMore()}>Load more</Button>}
      {project === null ? null : (
        <aside className="peek" aria-label="Project detail">
          <header className="peek__header">
            <div>
              <p className="mono">{project.slug}</p>
              <h2>{project.name}</h2>
            </div>
            <Button variant="quiet" onClick={() => setProject(null)}>
              Close
            </Button>
          </header>
          <p>{project.summary}</p>
          <div className="metadata-grid">
            <span>Owner</span>
            <strong>{project.owner.name}</strong>
            <span>Lifecycle</span>
            <strong>{project.state}</strong>
            <span>Health</span>
            <strong>{project.health.replace("_", " ")}</strong>
            <span>Priority</span>
            <strong>{project.priority}</strong>
            <span>Target</span>
            <strong>{project.targetDate ?? "Not set"}</strong>
          </div>
        </aside>
      )}
      {workId === null ? null : (
        <WorkPeek
          session={session}
          itemId={workId}
          onClose={() => setWorkId(null)}
          onChanged={() => undefined}
        />
      )}
    </ScreenLayout>
  )
}
