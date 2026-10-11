import type { ReactNode } from "react"

export function ScreenLayout({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="page-frame">
      <header className="page-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1 tabIndex={-1}>{title}</h1>
          <p>{description}</p>
        </div>
        {actions === undefined ? null : <div className="cluster">{actions}</div>}
      </header>
      {children}
    </div>
  )
}
