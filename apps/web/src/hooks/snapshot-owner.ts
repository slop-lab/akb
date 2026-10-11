type SnapshotApi = {
  readonly releaseSnapshot: (snapshotId: string) => Promise<void>
}

type SnapshotResult = {
  readonly snapshot: { readonly id: string }
}

const pendingReleases = new WeakMap<SnapshotApi, Promise<void>>()

export function createOwnedSnapshotRunner(api: SnapshotApi) {
  let currentSnapshotId: string | null = null
  let active = true

  function queueRelease(snapshotId: string): Promise<void> {
    const previous = pendingReleases.get(api) ?? Promise.resolve()
    const pending = previous.then(async () => {
      try {
        await api.releaseSnapshot(snapshotId)
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught
      }
    })
    pendingReleases.set(api, pending)
    return pending
  }

  async function releaseCurrent(): Promise<void> {
    const snapshotId = currentSnapshotId
    currentSnapshotId = null
    if (snapshotId !== null) await queueRelease(snapshotId)
    else await (pendingReleases.get(api) ?? Promise.resolve())
  }

  return {
    async run<Result extends SnapshotResult>(request: () => Promise<Result>): Promise<Result> {
      await releaseCurrent()
      const result = await request()
      if (!active) {
        await queueRelease(result.snapshot.id)
        return result
      }
      const previous = currentSnapshotId
      currentSnapshotId = result.snapshot.id
      if (previous !== null && previous !== result.snapshot.id) await queueRelease(previous)
      return result
    },
    dispose(): void {
      active = false
      void releaseCurrent()
    },
  }
}
