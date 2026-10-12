import { useCallback, useEffect, useState } from "react"
import type { SavedView, SpaceConfig } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"

type Options = {
  readonly session: Session
  readonly spaceId: string
  readonly onError: (message: string) => void
}

export function useWorkReferences({ session, spaceId, onError }: Options) {
  const [config, setConfig] = useState<SpaceConfig | null>(null)
  const [savedViews, setSavedViews] = useState<readonly SavedView[]>([])

  const loadSavedViews = useCallback(async () => {
    const response = await session.api.savedViews()
    setSavedViews(response.views)
  }, [session.api])

  useEffect(() => {
    void loadSavedViews()
  }, [loadSavedViews])

  useEffect(() => {
    if (spaceId.length === 0) {
      setConfig(null)
      return
    }
    void session.api
      .spaceConfig(spaceId)
      .then(setConfig)
      .catch((caught: unknown) =>
        onError(
          caught instanceof Error ? caught.message : "Space configuration could not be loaded.",
        ),
      )
  }, [onError, session.api, spaceId])

  return { config, savedViews, loadSavedViews }
}
