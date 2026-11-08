import { ProjectNotebook } from "@slop-lab/akb-project-kb/react"
import "@slop-lab/akb-project-kb/styles.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Project } from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Button, EmptyState, ErrorPanel } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { BlocksEditor } from "../../vendor/blocks/index.ts"
import { ProjectSelect } from "../projects/ProjectSelect.tsx"
import { projectKbClientFor } from "./project-kb-client.ts"

type ProjectLibraryScreenProps = ScreenProps & {
  readonly projectId?: string
  readonly pageId?: string
  readonly onLocationChange: (projectId: string | undefined, pageId: string | undefined) => void
  readonly onOpenProjects: () => void
}

export function ProjectLibraryScreen({
  session,
  projectId,
  pageId,
  onLocationChange,
  onOpenProjects,
}: ProjectLibraryScreenProps) {
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projectGeneration = useRef(0)
  const client = useMemo(() => projectKbClientFor(session), [session])

  useEffect(() => {
    const generation = ++projectGeneration.current
    setProject(null)
    setError(null)
    if (projectId === undefined) return
    void session.api
      .project(projectId)
      .then((selected) => {
        if (generation === projectGeneration.current) setProject(selected)
      })
      .catch((caught: unknown) => {
        if (generation !== projectGeneration.current) return
        setError(caught instanceof Error ? caught.message : "The selected Project could not load.")
      })
    return () => {
      projectGeneration.current += 1
    }
  }, [projectId, session.api])

  const handlePageChange = useCallback(
    (nextPageId: string | undefined) => onLocationChange(projectId, nextPageId),
    [onLocationChange, projectId],
  )

  return (
    <ScreenLayout
      eyebrow="Creative workspace"
      title="Project library"
      description="Keep composition, game-map, experiment, and general Project notes together without turning source files into fake app data."
    >
      <section className="panel project-library-picker" aria-labelledby="project-library-picker">
        <div>
          <h2 id="project-library-picker">Choose a Project</h2>
          <p className="field__help">
            The selected Project and document stay in the URL so this library can be reopened.
          </p>
        </div>
        <ProjectSelect
          session={session}
          label="Project"
          name="project-library-project"
          value={projectId ?? ""}
          emptyLabel="Select a Project"
          onError={setError}
          onChange={(nextProjectId) =>
            onLocationChange(nextProjectId.length === 0 ? undefined : nextProjectId, undefined)
          }
        />
      </section>
      {error === null ? null : <ErrorPanel message={error} />}
      {projectId !== undefined && project === null && error === null ? (
        <p role="status">Loading selected Project...</p>
      ) : null}
      {projectId === undefined ? (
        <EmptyState
          title="Choose a Project"
          body="Select an existing Project above, or create one before starting its library."
          action={<Button onClick={onOpenProjects}>Create project</Button>}
        />
      ) : null}
      {project === null ? null : (
        <ProjectNotebook
          client={client}
          projectId={project.id}
          projectName={project.name}
          {...(pageId === undefined ? {} : { pageId })}
          onPageChange={handlePageChange}
          renderEditor={({ page, document, onChange }) => (
            <BlocksEditor
              key={`${page.id}:${page.revision}`}
              label={`Edit ${page.title}`}
              value={document}
              onChange={onChange}
            />
          )}
        />
      )}
    </ScreenLayout>
  )
}
