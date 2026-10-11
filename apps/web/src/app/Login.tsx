import { type FormEvent, useRef, useState } from "react"
import type { Bootstrap } from "../../../../src/contracts/r4/index.ts"
import { Button, ErrorPanel, Field } from "../components/primitives.tsx"
import { ApiError, R4Api } from "../lib/api.ts"

type LoginProps = {
  readonly onAuthenticated: (session: {
    readonly api: R4Api
    readonly bootstrap: Bootstrap
  }) => void
  readonly onUnauthorized: () => void
}

export function Login({ onAuthenticated, onUnauthorized }: LoginProps) {
  const [workspace, setWorkspace] = useState("")
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorRef = useRef<HTMLDivElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const api = new R4Api(workspace.trim(), token, onUnauthorized)
    try {
      const bootstrap = await api.bootstrap()
      setToken("")
      onAuthenticated({ api, bootstrap })
    } catch (caught) {
      setToken("")
      setError(
        caught instanceof ApiError ? caught.message : "The server response could not be read.",
      )
      requestAnimationFrame(() => errorRef.current?.focus())
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={(event) => void submit(event)}>
        <header className="login-panel__heading">
          <p className="eyebrow">Agent-First Workspace</p>
          <h1>Sign in</h1>
          <p>Use a one-time or short-lived Workspace bearer token.</p>
        </header>
        {error === null ? null : (
          <div ref={errorRef} tabIndex={-1}>
            <ErrorPanel title="Sign in failed" message={error} />
          </div>
        )}
        <Field
          label="Workspace ID"
          name="workspace"
          autoComplete="organization"
          required
          value={workspace}
          onChange={(event) => setWorkspace(event.currentTarget.value)}
        />
        <Field
          label="Bearer token"
          name="token"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
        />
        <Button variant="primary" busy={busy} type="submit">
          Sign in
        </Button>
        <p className="security-note">
          Your token is kept in memory for this session. Refreshing or signing out clears it.
        </p>
      </form>
    </main>
  )
}
