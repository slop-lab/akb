import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react"

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "quiet" | "danger"
  readonly busy?: boolean
}

export function Button({ variant = "secondary", busy = false, children, ...props }: ButtonProps) {
  return (
    <button
      className={`button button--${variant}`}
      aria-busy={busy}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string
  readonly help?: string
  readonly error?: string
}

export function Field({ label, help, error, id, ...props }: FieldProps) {
  const controlId = id ?? props.name
  const descriptionId = controlId === undefined ? undefined : `${controlId}-description`
  return (
    <label className="field" htmlFor={controlId}>
      <span className="field__label">{label}</span>
      <input
        id={controlId}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={descriptionId}
        {...props}
      />
      {help !== undefined || error !== undefined ? (
        <span id={descriptionId} className={error === undefined ? "field__help" : "field__error"}>
          {error ?? help}
        </span>
      ) : null}
    </label>
  )
}

type SelectFieldProps = {
  readonly label: string
  readonly name: string
  readonly value?: string
  readonly defaultValue?: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly onChange?: (value: string) => void
  readonly disabled?: boolean
}

export function SelectField({
  label,
  name,
  value,
  defaultValue,
  options,
  onChange,
  disabled,
}: SelectFieldProps) {
  return (
    <label className="field" htmlFor={name}>
      <span className="field__label">{label}</span>
      <select
        id={name}
        name={name}
        {...(value === undefined ? {} : { value })}
        {...(defaultValue === undefined ? {} : { defaultValue })}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Badge({
  tone = "neutral",
  children,
}: {
  readonly tone?: "neutral" | "info" | "success" | "warning" | "danger"
  readonly children: ReactNode
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string
  readonly body: string
  readonly action?: ReactNode
}) {
  return (
    <section className="empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </section>
  )
}

export function ErrorPanel({
  title = "Something went wrong",
  message,
  actions,
}: {
  readonly title?: string
  readonly message: string
  readonly actions?: ReactNode
}) {
  return (
    <section className="status-panel status-panel--danger" role="alert" tabIndex={-1}>
      <strong>{title}</strong>
      <p>{message}</p>
      {actions}
    </section>
  )
}

export function Dialog({
  title,
  open,
  children,
  onClose,
}: {
  readonly title: string
  readonly open: boolean
  readonly children: ReactNode
  readonly onClose: () => void
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || dialog === null) return
    dialog.showModal()
    return () => dialog.close()
  }, [open])
  if (!open) return null
  return (
    <div className="dialog-backdrop">
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault()
          onClose()
        }}
      >
        <header className="dialog__header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        </header>
        {children}
      </dialog>
    </div>
  )
}
