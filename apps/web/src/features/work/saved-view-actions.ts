import type { HumanWorkQuery, SavedView } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"

type Options = {
  readonly session: Session
  readonly query: HumanWorkQuery
  readonly reload: () => Promise<void>
  readonly announce: (message: string) => void
  readonly setError: (message: string) => void
}

export function createSavedViewActions(options: Options) {
  async function run(
    command: Parameters<Session["api"]["command"]>[0],
    success: string,
    failure: string,
  ) {
    try {
      await options.session.api.command(command)
      await options.reload()
      options.announce(success)
    } catch (caught) {
      options.setError(caught instanceof Error ? caught.message : failure)
    }
  }

  return {
    save(name: string) {
      return run(
        {
          method: "post",
          path: "/saved-views",
          baseRevision: null,
          payload: { name, access: "private", scopeSpaceId: null, definition: options.query },
        },
        "Saved view created",
        "Saved view could not be created.",
      )
    },
    rename(saved: SavedView, name: string) {
      return run(
        {
          method: "patch",
          path: `/saved-views/${encodeURIComponent(saved.id)}`,
          baseRevision: saved.revision,
          payload: { name },
        },
        "Saved view updated",
        "Saved view could not be updated.",
      )
    },
    archive(saved: SavedView) {
      return run(
        {
          method: "post",
          path: `/saved-views/${encodeURIComponent(saved.id)}/archive`,
          baseRevision: saved.revision,
          payload: {},
        },
        "Saved view archived",
        "Saved view could not be archived.",
      )
    },
  }
}
