import { SignOut } from "@phosphor-icons/react"
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react"
import { Button } from "../components/primitives.tsx"
import {
  type ContentWorkflowDraft,
  EMPTY_CONTENT_WORKFLOW_DRAFT,
} from "../features/content/content-workflow-state.ts"
import { KnowledgeScreen } from "../features/knowledge/KnowledgeScreen.tsx"
import { PlanningScreen } from "../features/planning/PlanningScreen.tsx"
import { ProjectsScreen } from "../features/projects/ProjectsScreen.tsx"
import { RuntimeScreen } from "../features/runtime/RuntimeScreen.tsx"
import { SearchScreen } from "../features/search/SearchScreen.tsx"
import { SpacesScreen } from "../features/spaces/SpacesScreen.tsx"
import { TransferScreen } from "../features/transfer/TransferScreen.tsx"
import { WorkScreen } from "../features/work/WorkScreen.tsx"
import { type AppLocation, hrefForLocation, parseLocation, withWorkspace } from "./navigation.ts"
import type { Session } from "./types.ts"
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx"

const ContentScreen = lazy(async () => {
  const module = await import("../features/content/ContentScreen.tsx")
  return { default: module.ContentScreen }
})
const AutomationScreen = lazy(async () => {
  const module = await import("../features/automation/AutomationScreen.tsx")
  return { default: module.AutomationScreen }
})
const ProjectLibraryScreen = lazy(async () => {
  const module = await import("../features/project-kb/ProjectLibraryScreen.tsx")
  return { default: module.ProjectLibraryScreen }
})

export function Workspace({
  session,
  onLogout,
}: {
  readonly session: Session
  readonly onLogout: () => void
}) {
  const [location, setLocation] = useState<AppLocation>(() =>
    parseLocation(new URL(window.location.href)),
  )
  const [announcement, setAnnouncement] = useState("")
  const [navOpen, setNavOpen] = useState(false)
  const [workProjectId, setWorkProjectId] = useState("")
  const [workSpaceId, setWorkSpaceId] = useState("")
  const [contentWorkflowDraft, setContentWorkflowDraft] = useState<ContentWorkflowDraft>(
    EMPTY_CONTENT_WORKFLOW_DRAFT,
  )
  const navigationId = useId()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const route = location.route

  const navigate = useCallback(
    (next: AppLocation, replace = false) => {
      const scoped = withWorkspace(next, session.bootstrap.workspace.id)
      const href = hrefForLocation(scoped)
      window.history[replace ? "replaceState" : "pushState"](null, "", href)
      setLocation(scoped)
    },
    [session.bootstrap.workspace.id],
  )

  function closeNavigation() {
    setNavOpen(false)
    if (navOpen) requestAnimationFrame(() => menuButtonRef.current?.focus())
  }

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (document.querySelector("dialog[open]") !== null) return
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
        navigate({ route: "search" })
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "b") {
        navigate({ route: "work" })
      }
    }
    window.addEventListener("keydown", shortcuts)
    return () => window.removeEventListener("keydown", shortcuts)
  }, [navigate])
  useEffect(() => {
    const handlePopState = () => setLocation(parseLocation(new URL(window.location.href)))
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])
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
      <WorkspaceNavigation
        bootstrap={session.bootstrap}
        currentRoute={route}
        workspaceId={session.bootstrap.workspace.id}
        open={navOpen}
        navigationId={navigationId}
        onClose={closeNavigation}
        onNavigate={(next) => {
          if (next.route === "work") setWorkProjectId("")
          navigate(next)
          closeNavigation()
        }}
      />
      <main className="work-plane" inert={navOpen || undefined}>
        {route === "projects" ? (
          <ProjectsScreen
            {...props}
            onOpenWork={(project) => {
              setWorkProjectId(project.id)
              setWorkSpaceId(project.participatingSpaceIds[0] ?? "")
              navigate({ route: "work" })
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
        {route === "library" ? (
          <Suspense fallback={<p role="status">Loading Project library...</p>}>
            <ProjectLibraryScreen
              {...props}
              {...(location.route === "library" && location.projectId !== undefined
                ? { projectId: location.projectId }
                : {})}
              {...(location.route === "library" && location.pageId !== undefined
                ? { pageId: location.pageId }
                : {})}
              onLocationChange={(projectId, pageId) =>
                navigate({
                  route: "library",
                  ...(projectId === undefined ? {} : { projectId }),
                  ...(pageId === undefined ? {} : { pageId }),
                })
              }
              onOpenProjects={() => navigate({ route: "projects" })}
            />
          </Suspense>
        ) : null}
        {route === "content" ? (
          <Suspense fallback={<p role="status">Loading page...</p>}>
            <ContentScreen
              {...props}
              {...(location.route === "content" && location.pageId !== undefined
                ? { initialPageId: location.pageId }
                : {})}
              {...(location.route === "content" && location.revision !== undefined
                ? { initialRevision: location.revision }
                : {})}
              {...(location.route === "content" && location.revisionError !== undefined
                ? { initialRevisionError: location.revisionError }
                : {})}
              onLocationChange={(pageId, revision) =>
                navigate({
                  route: "content",
                  pageId,
                  ...(revision === undefined ? {} : { revision }),
                })
              }
              workflowDraft={contentWorkflowDraft}
              onWorkflowDraftChange={setContentWorkflowDraft}
            />
          </Suspense>
        ) : null}
        {route === "runtime" ? <RuntimeScreen {...props} /> : null}
        {route === "knowledge" || route === "proposals" ? (
          <KnowledgeScreen
            {...props}
            mode={route === "proposals" ? "proposals" : "knowledge"}
            {...(location.route === "knowledge" && location.knowledgeId !== undefined
              ? { initialKnowledgeId: location.knowledgeId }
              : {})}
            {...(location.route === "knowledge" && location.revision !== undefined
              ? { initialRevision: location.revision }
              : {})}
            {...(location.route === "knowledge" && location.revisionError !== undefined
              ? { initialRevisionError: location.revisionError }
              : {})}
            {...(location.route === "proposals" && location.proposalId !== undefined
              ? { initialProposalId: location.proposalId }
              : {})}
            onKnowledgeLocationChange={(knowledgeId, revision) =>
              navigate({
                route: "knowledge",
                knowledgeId,
                ...(revision === undefined ? {} : { revision }),
              })
            }
            onProposalLocationChange={(proposalId) =>
              navigate({ route: "proposals", ...(proposalId === undefined ? {} : { proposalId }) })
            }
          />
        ) : null}
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
