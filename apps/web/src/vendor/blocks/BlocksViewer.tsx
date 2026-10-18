import { BlockViewer } from "@block-editor/model/viewer"
import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import { toBlocksDocument } from "./document-adapter.ts"
import { blocksRenderers, renderLockedBlock } from "./profile.tsx"

export type BlocksViewerProps = {
  readonly value: ContentDocument
  readonly label: string
}

export function BlocksViewer({ value, label }: BlocksViewerProps) {
  return (
    <section className="blocks-viewer" aria-label={label}>
      <BlockViewer
        content={toBlocksDocument(value)}
        renderers={blocksRenderers}
        renderUnknown={renderLockedBlock}
      />
    </section>
  )
}
