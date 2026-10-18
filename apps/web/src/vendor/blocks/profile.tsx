import type { BlockRenderer, BlockSnapshot } from "@block-editor/model"
import { defaultBlocks, defaultProfile } from "@block-editor/prosemirror/preset"

export const blocksProfile = defaultProfile

const renderers = new Map<string, BlockRenderer>()
for (const block of defaultBlocks) {
  if (block.render !== undefined) renderers.set(block.type, block.render)
}
export const blocksRenderers: ReadonlyMap<string, BlockRenderer> = renderers

const textFrom = (block: BlockSnapshot): string =>
  block.content.flatMap((inline) => (inline.kind === "text" ? [inline.text] : [])).join("")

export const renderLockedBlock: BlockRenderer = (block) => (
  <section className="blocks-locked" aria-label={`Read-only ${block.type} block`}>
    <strong>Read-only {block.type.replaceAll("_", " ")}</strong>
    <p>{textFrom(block)}</p>
  </section>
)
