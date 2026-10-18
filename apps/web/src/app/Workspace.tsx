import {
  ArrowSquareOut,
  BookOpenText,
  Briefcase,
  CalendarCheck,
  Database,
  FolderSimple,
  Graph,
  ListChecks,
  MagnifyingGlass,
  Robot,
  SignOut,
  SlidersHorizontal,
  TerminalWindow,
} from "@phosphor-icons/react"
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react"
import { Button } from "../components/primitives.tsx"
import { KnowledgeScreen } from "../features/knowledge/KnowledgeScreen.tsx"
import { PlanningScreen } from "../features/planning/PlanningScreen.tsx"
import { ProjectsScreen } from "../features/projects/ProjectsScreen.tsx"
import { RuntimeScreen } from "../features/runtime/RuntimeScreen.tsx"
import { SearchScreen } from "../features/search/SearchScreen.tsx"
import { SpacesScreen } from "../features/spaces/SpacesScreen.tsx"
import { TransferScreen } from "../features/transfer/TransferScreen.tsx"
import { WorkScreen } from "../features/work/WorkScreen.tsx"
import type { Route, Session } from "./types.ts"

const ContentScreen = lazy(async () => {
  const module = await import("../features/content/ContentScreen.tsx")
  return { default: module.ContentScreen }
})
const AutomationScreen = lazy(async () => {
  const module = await import("../features/automation/AutomationScreen.tsx")
  return { default: module.AutomationScreen }
})

const NAVIGATION = [
  { route: "projects", label: "Projects", icon: Briefcase },
  { route: "work", label: "Work", icon: ListChecks },
  { route: "search", label: "Search", icon: MagnifyingGlass },
  { route: "planning", label: "Planning", icon: CalendarCheck },
  { route: "content", label: "Pages", icon: BookOpenText },
  { route: "runtime", label: "Runs", icon: TerminalWindow },
  { route: "knowledge", label: "Knowledge", icon: Graph },
  { route: "automation", label: "Automation", icon: Robot },
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
  const navigationId = useId()
  const navigationRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  function closeNavigation() {
    setNavOpen(false)
    if (navOpen) requestAnimationFrame(() => menuButtonRef.current?.focus())
  }

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
  useEffect(() => {
    if (!navOpen) return
    const navigation = navigationRef.current
    if (navigation === null) return
    const focusable = navigation.querySelectorAll<HTMLElement>("button, a[href]")
    focusable[0]?.focus()
    function handleNavigationKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        setNavOpen(false)
        requestAnimationFrame(() => menuButtonRef.current?.focus())
        return
      }
      if (event.key !== "Tab" || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    navigation.addEventListener("keydown", handleNavigationKeys)
    return () => navigation.removeEventListener("keydown", handleNavigationKeys)
  }, [navOpen])

  const props = { session, announce: setAnnouncement }
  return (
    <div className="shell">
      <header className="topbar" inert={navOpen || undefined}>
        <button
          ref={menuButtonRef}
          type="button"
          className="button button--quiet nav-trigger"
          aria-controls={navigationId}
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
        >
          Menu
        </button>
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
      {navOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={closeNavigation}
        />
      ) : null}
      <aside
        id={navigationId}
        ref={navigationRef}
        className={`sidebar${navOpen ? " sidebar--open" : ""}`}
        aria-label="Workspace navigation"
        {...(navOpen ? { "aria-modal": true, role: "dialog" } : {})}
      >
        <div className="sidebar__mobile-header">
          <strong>Navigate</strong>
          <Button variant="quiet" onClick={closeNavigation}>
            Close
          </Button>
        </div>
        <nav>
          {NAVIGATION.map(({ route: destination, label, icon: Icon }) => (
            <button
              type="button"
              key={destination}
              className="nav-item"
              aria-label={label}
              title={label}
              aria-current={route === destination ? "page" : undefined}
              onClick={() => {
                if (destination === "work") setWorkProjectId("")
                setRoute(destination)
                closeNavigation()
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
              title={`${space.key} · ${space.name}`}
              onClick={() => {
                setRoute("work")
                closeNavigation()
              }}
            >
              <span className="space-key space-key--full mono">{space.key}</span>
              <span className="space-key space-key--rail mono" aria-hidden="true">
                {space.key.slice(0, 1)}
              </span>
              <span>{space.name}</span>
            </button>
          ))}
        </section>
        <a className="api-status" href="/health" target="_blank" rel="noreferrer">
          <ArrowSquareOut size={14} aria-hidden="true" /> API health
        </a>
      </aside>
      <main className="work-plane" inert={navOpen || undefined}>
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
        {route === "planning" ? <PlanningScreen {...props} /> : null}
        {route === "content" ? (
          <Suspense fallback={<p role="status">Loading page...</p>}>
            <ContentScreen {...props} />
          </Suspense>
        ) : null}
        {route === "runtime" ? <RuntimeScreen {...props} /> : null}
        {route === "knowledge" ? <KnowledgeScreen {...props} /> : null}
        {route === "automation" ? (
          <Suspense fallback={<p role="status">Loading automation...</p>}>
            <AutomationScreen {...props} />
          </Suspense>
        ) : null}
        {route === "transfer" ? <TransferScreen {...props} /> : null}
      </main>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}
