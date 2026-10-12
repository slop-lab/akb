import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Project } from "../../../../src/contracts/r4/index.ts"
import type { Session } from "../app/types.ts"
import { createOwnedSnapshotRunner } from "./snapshot-owner.ts"

type Options = {
  readonly session: Session
  readonly includeArchived: boolean
  readonly search: string
  readonly selectedId?: string
  readonly onError: (message: string) => void
}

export function useProjectPages(options: Options) {
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [selected, setSelected] = useState<Project | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [matched, setMatched] = useState<number | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const queryGeneration = useRef(0)
  const selectedGeneration = useRef(0)
  const continuationCursor = useRef<string | null>(null)
  const activeRunner = useRef<ReturnType<typeof createOwnedSnapshotRunner> | null>(null)
  const pendingRunners = useRef(new Set<ReturnType<typeof createOwnedSnapshotRunner>>())

  const request = useCallback(
    (cursor: string | null) =>
      options.session.api.queryProjects({
        filter: null,
        search: options.search.trim() || null,
        sort: [{ field: "createdAt", direction: "desc" }],
        includeArchived: options.includeArchived,
        page: { size: 100, cursor },
      }),
    [options.includeArchived, options.search, options.session.api],
  )

  const load = useCallback(async () => {
    const generation = ++queryGeneration.current
    continuationCursor.current = null
    setIsLoadingMore(false)
    setProjects([])
    setNextCursor(null)
    setMatched(null)
    activeRunner.current?.dispose()
    activeRunner.current = null
    const runner = createOwnedSnapshotRunner(options.session.api)
    pendingRunners.current.add(runner)
    try {
      const page = await runner.run(() => request(null))
      if (generation !== queryGeneration.current) return
      activeRunner.current = runner
      setProjects(page.items)
      setNextCursor(page.nextCursor)
      setMatched(page.matched)
    } catch (caught) {
      if (generation !== queryGeneration.current) return
      options.onError(caught instanceof Error ? caught.message : "Projects could not be loaded.")
    } finally {
      pendingRunners.current.delete(runner)
      if (activeRunner.current !== runner) runner.dispose()
    }
  }, [options.onError, options.session.api, request])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () => () => {
      queryGeneration.current += 1
      activeRunner.current?.dispose()
      for (const runner of pendingRunners.current) runner.dispose()
    },
    [],
  )

  useEffect(() => {
    const generation = ++selectedGeneration.current
    setSelected(null)
    if (options.selectedId === undefined || options.selectedId.length === 0) {
      return
    }
    void options.session.api
      .project(options.selectedId)
      .then((project) => {
        if (generation === selectedGeneration.current) setSelected(project)
      })
      .catch((caught: unknown) => {
        if (generation !== selectedGeneration.current) return
        options.onError(
          caught instanceof Error ? caught.message : "The selected Project could not be loaded.",
        )
      })
  }, [options.onError, options.selectedId, options.session.api])

  async function loadMore(): Promise<void> {
    const cursor = nextCursor
    if (cursor === null || continuationCursor.current === cursor) return
    const generation = queryGeneration.current
    continuationCursor.current = cursor
    setIsLoadingMore(true)
    try {
      const page = await request(cursor)
      if (generation !== queryGeneration.current) return
      setProjects((current) => [...current, ...page.items])
      setNextCursor(page.nextCursor)
      setMatched(page.matched)
    } catch (caught) {
      if (generation !== queryGeneration.current) return
      options.onError(
        caught instanceof Error ? caught.message : "The next page could not be loaded.",
      )
    } finally {
      if (generation === queryGeneration.current && continuationCursor.current === cursor) {
        continuationCursor.current = null
        setIsLoadingMore(false)
      }
    }
  }

  const optionsWithSelection = useMemo(
    () =>
      selected === null || projects.some((project) => project.id === selected.id)
        ? projects
        : [selected, ...projects],
    [projects, selected],
  )
  return { projects: optionsWithSelection, nextCursor, matched, isLoadingMore, load, loadMore }
}
