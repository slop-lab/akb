import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import { BlocksEditor, BlocksViewer, fromBlocksDocument, toBlocksDocument } from "./index.ts"

const document: ContentDocument = {
  version: 1,
  blocks: [
    { id: "heading-1", type: "heading", text: "Working brief", level: 2, children: [] },
    {
      id: "paragraph-1",
      type: "paragraph",
      text: "Write together without losing the source.",
      children: [],
    },
    {
      id: "entity-1",
      type: "entity_embed",
      text: "Referenced entity",
      entityId: "entity-42",
      children: [],
    },
  ],
}

let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const mount = (node: ReactNode): HTMLDivElement => {
  container = window.document.createElement("div")
  window.document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(node))
  return container
}

test("preserves the project document when the Blocks profile cannot edit a block", () => {
  // Given
  const upstream = toBlocksDocument(document)

  // When
  const restored = fromBlocksDocument(upstream)

  // Then
  expect(restored).toEqual(document)
})

test("renders canonical content through the real upstream Blocks viewer", () => {
  // Given / When
  const surface = mount(<BlocksViewer value={document} label="Brief preview" />)

  // Then
  expect(surface.querySelector(".static-viewer")).not.toBeNull()
  expect(surface.querySelector("h2")?.textContent).toBe("Working brief")
  expect(surface.textContent).toContain("Write together without losing the source.")
  expect(surface.textContent).toContain("Referenced entity")
})

test("mounts a real editable ProseMirror surface behind project-owned props", () => {
  // Given
  const onChange = vi.fn()

  // When
  const surface = mount(<BlocksEditor value={document} onChange={onChange} label="Brief editor" />)

  // Then
  const editor = surface.querySelector<HTMLElement>("[contenteditable='true']")
  expect(editor?.getAttribute("aria-label")).toBe("Brief editor")
  expect(editor?.classList.contains("ProseMirror")).toBe(true)
  expect(onChange).not.toHaveBeenCalled()
})
