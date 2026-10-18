import { useState } from "react"
import type { z } from "zod"
import {
  RuntimeActivityPageResponseSchema,
  RuntimeArtifactPageResponseSchema,
  RuntimeReceiptPageResponseSchema,
} from "../../../../../src/contracts/runtime/index.ts"
import type { Session } from "../../app/types.ts"
import { Button } from "../../components/primitives.tsx"

const MAX_VISIBLE_ITEMS = 200

type ActivityPage = z.infer<typeof RuntimeActivityPageResponseSchema>
type ReceiptPage = z.infer<typeof RuntimeReceiptPageResponseSchema>
type ArtifactPage = z.infer<typeof RuntimeArtifactPageResponseSchema>

type Props = {
  readonly session: Session
  readonly runId: string
  readonly root: string
  readonly initialActivity: ActivityPage
  readonly initialReceipts: ReceiptPage
  readonly initialArtifacts: ArtifactPage
}

export function RuntimeCollections({
  session,
  runId,
  root,
  initialActivity,
  initialReceipts,
  initialArtifacts,
}: Props) {
  const [activity, setActivity] = useState(initialActivity)
  const [receipts, setReceipts] = useState(initialReceipts)
  const [artifacts, setArtifacts] = useState(initialArtifacts)

  async function loadMoreActivity() {
    if (activity.nextAfter === null) return
    const next = await session.api.feature(
      `${root}/${encodeURIComponent(runId)}/activity?after=${encodeURIComponent(activity.nextAfter)}`,
      RuntimeActivityPageResponseSchema,
    )
    const items = [...activity.items, ...next.items].slice(0, MAX_VISIBLE_ITEMS)
    setActivity({
      items,
      nextAfter: next.nextAfter,
      hasMore: next.hasMore && items.length < MAX_VISIBLE_ITEMS,
    })
  }

  async function loadMoreReceipts() {
    if (receipts.nextAfter === null) return
    const next = await session.api.feature(
      `${root}/${encodeURIComponent(runId)}/receipts?after=${encodeURIComponent(receipts.nextAfter)}`,
      RuntimeReceiptPageResponseSchema,
    )
    const items = [...receipts.items, ...next.items].slice(0, MAX_VISIBLE_ITEMS)
    setReceipts({
      items,
      nextAfter: next.nextAfter,
      hasMore: next.hasMore && items.length < MAX_VISIBLE_ITEMS,
    })
  }

  async function loadMoreArtifacts() {
    if (artifacts.nextAfter === null) return
    const next = await session.api.feature(
      `${root}/${encodeURIComponent(runId)}/artifacts?after=${encodeURIComponent(artifacts.nextAfter)}`,
      RuntimeArtifactPageResponseSchema,
    )
    const items = [...artifacts.items, ...next.items].slice(0, MAX_VISIBLE_ITEMS)
    setArtifacts({
      items,
      nextAfter: next.nextAfter,
      hasMore: next.hasMore && items.length < MAX_VISIBLE_ITEMS,
    })
  }

  return (
    <>
      <h3>Activity</h3>
      {activity.items.length === 0 ? (
        <p className="panel__meta">No durable activity.</p>
      ) : (
        activity.items.map((item) => (
          <p key={item.id}>
            <strong>
              {item.sequence}. {item.kind}
            </strong>{" "}
            by {item.actorId}
          </p>
        ))
      )}
      {activity.hasMore ? (
        <Button onClick={() => void loadMoreActivity()}>Load more activity</Button>
      ) : null}
      <h3>Retrieval receipts</h3>
      {receipts.items.length === 0 ? (
        <p className="panel__meta">No retrieval receipts.</p>
      ) : (
        receipts.items.map((receipt) => (
          <p key={receipt.id}>
            <span className="mono">{receipt.id}</span> · {receipt.projection}
          </p>
        ))
      )}
      {receipts.hasMore ? (
        <Button onClick={() => void loadMoreReceipts()}>Load more receipts</Button>
      ) : null}
      <h3>Artifacts</h3>
      {artifacts.items.length === 0 ? (
        <p className="panel__meta">No artifacts.</p>
      ) : (
        artifacts.items.map((artifact) => (
          <p key={artifact.id}>
            <strong>{artifact.kind}</strong> · {artifact.mediaType} · {artifact.byteSize} bytes{" "}
            {artifact.complete ? "complete" : "incomplete"}
          </p>
        ))
      )}
      {artifacts.hasMore ? (
        <Button onClick={() => void loadMoreArtifacts()}>Load more artifacts</Button>
      ) : null}
    </>
  )
}
