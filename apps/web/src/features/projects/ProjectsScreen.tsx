import { Plus } from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"
import type { Project } from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, Dialog, EmptyState, ErrorPanel } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { useOwnedSnapshot } from "../../hooks/useOwnedSnapshot.ts"
import { ProjectForm } from "./ProjectForm.tsx"

export function ProjectsScreen({
  session,
  announce,
  onOpenWork,
}: ScreenProps & { readonly onOpenWork: (project: Project) => void }) {
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runOwnedQuery = useOwnedSnapshot(session.api)
  const canManage = session.bootstrap.permissions.includes("project.manage")

  const load = useCallback(async () => {
    setError(null)
    try {
      const page = await runOwnedQuery(() =>
        session.api.queryProjects({
          filter: null,
          search: null,
          sort: [{ field: "createdAt", direction: "desc" }],
          includeArchived: true,
          page: { size: 100, cursor: null },
        }),
      )
      setProjects(page.items)
      announce(`${page.matched} projects loaded`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Projects could not be loaded.")
    }
  }, [announce, runOwnedQuery, session.api])

  useEffect(() => {
    void load()
  }, [load])

  async function lifecycle(project: Project, action: "archive" | "restore") {
    try {
      await session.api.command({
        method: "post",
        path: `/projects/${encodeURIComponent(project.id)}/${action}`,
        baseRevision: project.revision,
        payload: {},
      })
      announce(`${project.name} ${action === "archive" ? "archived" : "restored"}`)
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Project could not be updated.")
    }
  }

  return (
    <ScreenLayout
      eyebrow="Portfolio"
      title="Projects"
      description="Outcomes across participating Spaces."
      actions={
        <Button
          variant="primary"
          disabled={!canManage}
          onClick={() => {
            setSelected(null)
            setFormOpen(true)
          }}
        >
          <Plus size={16} aria-hidden="true" /> Create project
        </Button>
      }
    >
      {error === null ? null : (
        <ErrorPanel message={error} actions={<Button onClick={() => void load()}>Reload</Button>} />
      )}
      {projects.length === 0 && error === null ? (
        <EmptyState
          title="No projects yet"
          body="Create the first cross-Space outcome when you are ready."
        />
      ) : (
        <div className="content-grid">
          {projects.map((project) => (
            <article className="panel" key={project.id}>
              <div className="panel__header">
                <div>
                  <p className="mono">{project.slug}</p>
                  <h3>{project.name}</h3>
                </div>
                <Badge tone={project.archivedAt === null ? "info" : "neutral"}>
                  {project.archivedAt === null ? project.state : "Archived"}
                </Badge>
              </div>
              <p>{project.summary || "No summary"}</p>
              <div className="panel__meta">
                <span>{project.owner.name}</span>
                <span>{project.priority}</span>
                <span>{project.health.replace("_", " ")}</span>
                <span>{project.targetDate ?? "No target"}</span>
              </div>
              <div className="cluster">
                <Button variant="quiet" onClick={() => onOpenWork(project)}>
                  Open work
                </Button>
                <Button
                  onClick={() => {
                    setSelected(project)
                    setFormOpen(true)
                  }}
                  disabled={!canManage}
                >
                  Edit
                </Button>
                {project.archivedAt === null ? (
                  <Button
                    variant="quiet"
                    onClick={() => void lifecycle(project, "archive")}
                    disabled={!canManage}
                  >
                    Archive
                  </Button>
                ) : (
                  <Button
                    variant="quiet"
                    onClick={() => void lifecycle(project, "restore")}
                    disabled={!canManage}
                  >
                    Restore
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        title={selected === null ? "Create project" : `Edit ${selected.name}`}
        open={formOpen}
        onClose={() => setFormOpen(false)}
      >
        <ProjectForm
          session={session}
          {...(selected === null ? {} : { project: selected })}
          onCancel={() => setFormOpen(false)}
          onError={setError}
          onSaved={() => {
            setFormOpen(false)
            void load()
          }}
        />
      </Dialog>
    </ScreenLayout>
  )
}
