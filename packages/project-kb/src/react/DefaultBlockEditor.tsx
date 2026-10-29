import type { ContentBlock, ContentDocument } from "../contracts.ts"

type BlockEditorProps = {
  readonly block: ContentBlock
  readonly path: readonly number[]
  readonly disabled: boolean
  readonly onChange: (path: readonly number[], text: string) => void
}

function BlockEditor({ block, path, disabled, onChange }: BlockEditorProps) {
  return (
    <div className="kb-block-editor">
      <label className="kb-field">
        <span className="kb-field__label">
          {block.type.replaceAll("_", " ")}
          {block.level === undefined ? "" : ` ${block.level}`}
        </span>
        <textarea
          value={block.text}
          rows={block.type === "heading" ? 1 : 3}
          disabled={disabled}
          onChange={(event) => onChange(path, event.currentTarget.value)}
        />
      </label>
      {block.children.length === 0 ? null : (
        <div className="kb-block-editor__children">
          {block.children.map((child, index) => (
            <BlockEditor
              key={child.id}
              block={child}
              path={[...path, index]}
              disabled={disabled}
              onChange={onChange}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function replaceBlockText(
  blocks: readonly ContentBlock[],
  path: readonly number[],
  text: string,
): readonly ContentBlock[] {
  const [index, ...rest] = path
  if (index === undefined) return blocks
  return blocks.map((block, currentIndex) => {
    if (currentIndex !== index) return block
    if (rest.length === 0) return { ...block, text }
    return { ...block, children: replaceBlockText(block.children, rest, text) }
  })
}

export function DefaultBlockEditor({
  document,
  disabled = false,
  onChange,
}: {
  readonly document: ContentDocument
  readonly disabled?: boolean
  readonly onChange: (document: ContentDocument) => void
}) {
  return (
    <div className="kb-default-editor">
      {document.blocks.map((block, index) => (
        <BlockEditor
          key={block.id}
          block={block}
          path={[index]}
          disabled={disabled}
          onChange={(path, text) =>
            onChange({ ...document, blocks: replaceBlockText(document.blocks, path, text) })
          }
        />
      ))}
    </div>
  )
}
