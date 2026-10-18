import { pmToSnapshot, snapshotToPm } from "@block-editor/prosemirror"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { useEffect, useEffectEvent, useRef } from "react"
import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import { fromBlocksDocument, toBlocksDocument } from "./document-adapter.ts"
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

  useEffect(() => {
    const target = host.current
    if (target === null) return
    const state = EditorState.create({
      schema: blocksProfile.schema,
      doc: snapshotToPm(toBlocksDocument(initialValue.current), blocksProfile),
    })
    const view = new EditorView(target, {
      state,
      attributes: { class: "blocks-editor__content", "aria-label": label },
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction)
        view.updateState(next)
        if (transaction.docChanged) {
          emitChange(fromBlocksDocument(pmToSnapshot(next.doc, blocksProfile)))
        }
      },
    })
    return () => view.destroy()
  }, [label])

  return <div className="blocks-editor" ref={host} />
}
