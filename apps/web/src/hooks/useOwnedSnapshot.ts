import { useEffect, useState } from "react"
import type { R4Api } from "../lib/api.ts"
import { createOwnedSnapshotRunner } from "./snapshot-owner.ts"

export function useOwnedSnapshot(api: R4Api) {
  const [runner] = useState(() => createOwnedSnapshotRunner(api))
  useEffect(() => () => runner.dispose(), [runner])
  return runner.run
}
