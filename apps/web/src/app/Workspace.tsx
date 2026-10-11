import {
  ArrowSquareOut,
  Briefcase,
  Database,
  FolderSimple,
  ListChecks,
  MagnifyingGlass,
  SignOut,
  SlidersHorizontal,
} from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { Button } from "../components/primitives.tsx"
import { ProjectsScreen } from "../features/projects/ProjectsScreen.tsx"
import { SearchScreen } from "../features/search/SearchScreen.tsx"
import { SpacesScreen } from "../features/spaces/SpacesScreen.tsx"
import { TransferScreen } from "../features/transfer/TransferScreen.tsx"
import { WorkScreen } from "../features/work/WorkScreen.tsx"
import type { Route, Session } from "./types.ts"

const NAVIGATION = [
  { route: "projects", label: "Projects", icon: Briefcase },
  { route: "work", label: "Work", icon: ListChecks },
  { route: "search", label: "Search", icon: MagnifyingGlass },
  { route: "spaces", label: "Spaces", icon: FolderSimple },
  { route: "saved", label: "Saved views", icon: SlidersHorizontal },
  { route: "transfer", label: "Workspace data", icon: Database },
] as const

export function Workspace({
  session,
  onLogout,
}: {
  readonly session: Session
  readonly onLogout: () => void
}) {
  const [route, setRoute] = useState<Route>("projects")
  const [announcement, setAnnouncement] = useState("")
  const [navOpen, setNavOpen] = useState(false)
  const [workProjectId, setWorkProjectId] = useState("")
  const [workSpaceId, setWorkSpaceId] = useState("")

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable) ||
        event.isComposing
      )
        return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setRoute("search")
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "b") {
        setRoute("work")
      }
    }
    window.addEventListener("keydown", shortcuts)
    return () => window.removeEventListener("keydown", shortcuts)
  }, [])

  const props = { session, announce: setAnnouncement }
  return (
    <div className="shell">
      <header className="topbar">
        <Button variant="quiet" className="nav-trigger" onClick={() => setNavOpen(true)}>
          Menu
        </Button>
        <div className="workspace-identity">
          <span className="workspace-mark" aria-hidden="true">
            A
          </span>
          <strong>{session.bootstrap.workspace.name}</strong>
        </div>
        <Button variant="quiet" onClick={onLogout}>
          <SignOut size={16} aria-hidden="true" /> Sign out
        </Button>
      </header>
      <aside
        className={`sidebar${navOpen ? " sidebar--open" : ""}`}
        aria-label="Workspace navigation"
      >
        <div className="sidebar__mobile-header">
          <strong>Navigate</strong>
          <Button variant="quiet" onClick={() => setNavOpen(false)}>
            Close
          </Button>
        </div>
        <nav>
          {NAVIGATION.map(({ route: destination, label, icon: Icon }) => (
            <button
              type="button"
              key={destination}
              className="nav-item"
              aria-current={route === destination ? "page" : undefined}
              onClick={() => {
                if (destination === "work") setWorkProjectId("")
                setRoute(destination)
                setNavOpen(false)
              }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <section className="sidebar__spaces">
          <p className="sidebar__label">Spaces</p>
          {session.bootstrap.spaces.map((space) => (
            <button
              type="button"
              key={space.id}
              className="nav-item nav-item--space"
              onClick={() => {
                setRoute("work")
                setNavOpen(false)
              }}
            >
              <span className="space-key mono">{space.key}</span>
              <span>{space.name}</span>
            </button>
          ))}
        </section>
        <a className="api-status" href="/health" target="_blank" rel="noreferrer">
          <ArrowSquareOut size={14} aria-hidden="true" /> API health
        </a>
      </aside>
      <main className="work-plane">
        {route === "projects" ? (
          <ProjectsScreen
            {...props}
            onOpenWork={(project) => {
              setWorkProjectId(project.id)
              setWorkSpaceId(project.participatingSpaceIds[0] ?? "")
              setRoute("work")
            }}
          />
        ) : null}
        {route === "spaces" ? <SpacesScreen {...props} /> : null}
        {route === "work" || route === "saved" ? (
          <WorkScreen
            {...props}
            initialSavedViews={route === "saved"}
            initialProjectId={workProjectId}
            initialSpaceId={workSpaceId}
          />
        ) : null}
        {route === "search" ? <SearchScreen {...props} /> : null}
        {route === "transfer" ? <TransferScreen {...props} /> : null}
      </main>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}
