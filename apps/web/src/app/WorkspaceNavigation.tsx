import {
  ArrowSquareOut,
  BookOpenText,
  Books,
  Briefcase,
  CalendarCheck,
  Database,
  FolderSimple,
  Graph,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Robot,
  SlidersHorizontal,
  TerminalWindow,
} from "@phosphor-icons/react"
import { useEffect, useRef } from "react"
import type { Bootstrap } from "../../../../src/contracts/r4/index.ts"
import { Button } from "../components/primitives.tsx"
import { type AppLocation, hrefForLocation } from "./navigation.ts"

const NAVIGATION = [
  { route: "projects", label: "Projects", icon: Briefcase },
  { route: "work", label: "Work", icon: ListChecks },
  { route: "search", label: "Search", icon: MagnifyingGlass },
  { route: "planning", label: "Planning", icon: CalendarCheck },
  { route: "library", label: "Project library", icon: Books },
  { route: "content", label: "Pages", icon: BookOpenText },
  { route: "runtime", label: "Runs", icon: TerminalWindow },
  { route: "knowledge", label: "Knowledge", icon: Graph },
  { route: "proposals", label: "Proposals", icon: NotePencil },
  { route: "automation", label: "Automation", icon: Robot },
  { route: "spaces", label: "Spaces", icon: FolderSimple },
  { route: "saved", label: "Saved views", icon: SlidersHorizontal },
  { route: "transfer", label: "Workspace data", icon: Database },
] as const

type WorkspaceNavigationProps = {
  readonly bootstrap: Bootstrap
  readonly currentRoute: AppLocation["route"]
  readonly workspaceId: string
  readonly open: boolean
  readonly navigationId: string
  readonly onClose: () => void
  readonly onNavigate: (location: AppLocation) => void
}

export function WorkspaceNavigation({
  bootstrap,
  currentRoute,
  workspaceId,
  open,
  navigationId,
  onClose,
  onNavigate,
}: WorkspaceNavigationProps) {
  const navigationRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!open) return
    const navigation = navigationRef.current
    if (navigation === null) return
    const focusable = navigation.querySelectorAll<HTMLElement>("button, a[href]")
    focusable[0]?.focus()
    function handleNavigationKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
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
  }, [onClose, open])

  return (
    <>
      {open ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={onClose}
        />
      ) : null}
      <aside
        id={navigationId}
        ref={navigationRef}
        className={`sidebar${open ? " sidebar--open" : ""}`}
        aria-label="Workspace navigation"
        {...(open ? { "aria-modal": true, role: "dialog" } : {})}
      >
        <div className="sidebar__mobile-header">
          <strong>Navigate</strong>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
        <nav>
          {NAVIGATION.map(({ route, label, icon: Icon }) => (
            <a
              key={route}
              className="nav-item"
              href={hrefForLocation({ route, workspaceId })}
              aria-label={label}
              title={label}
              aria-current={currentRoute === route ? "page" : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                onNavigate({ route, workspaceId })
              }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <section className="sidebar__spaces">
          <p className="sidebar__label">Spaces</p>
          {bootstrap.spaces.map((space) => (
            <button
              type="button"
              key={space.id}
              className="nav-item nav-item--space"
              title={`${space.key} · ${space.name}`}
              onClick={() => onNavigate({ route: "work" })}
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
    </>
  )
}
