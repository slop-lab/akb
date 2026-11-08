import { pmToSnapshot, snapshotToPm } from "@slop-lab/blocks-prosemirror"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import {
  fromBlocksDocument,
  toBlocksDocument,
  UnsupportedBlocksEditingError,
} from "./document-adapter.ts"
import { blocksProfile } from "./profile.tsx"

export type BlocksEditorProps = {
  readonly value: ContentDocument
  readonly onChange: (value: ContentDocument) => void
  readonly label: string
}

export function BlocksEditor({ value, onChange, label }: BlocksEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const initialValue = useRef(value)
  const emitChange = useEffectEvent(onChange)
  const [editingError, setEditingError] = useState<string | null>(null)

  useEffect(() => {
    const target = host.current
    if (target === null) return
    const state = EditorState.create({
      schema: blocksProfile.schema,
      doc: snapshotToPm(toBlocksDocument(initialValue.current), blocksProfile),
    })
    const view = new EditorView(target, {
      state,
      attributes: {
        class: "blocks-editor__content",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
      },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction)
        if (transaction.docChanged) {
          try {
            emitChange(fromBlocksDocument(pmToSnapshot(next.doc, blocksProfile)))
            setEditingError(null)
          } catch (caught) {
            if (caught instanceof UnsupportedBlocksEditingError) {
              setEditingError(caught.message)
              return
            }
            throw caught
          }
        }
        view.updateState(next)
      },
    })
    return () => view.destroy()
  }, [label])

  return (
    <div className="blocks-editor">
      <div ref={host} />
      {editingError === null ? null : (
        <p className="blocks-editor__error" role="alert">
          {editingError}
        </p>
      )}
    </div>
  )
}
