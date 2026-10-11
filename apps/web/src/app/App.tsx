import { useState } from "react"
import type { Bootstrap } from "../../../../src/contracts/r4/index.ts"
import { Showcase } from "../components/Showcase.tsx"
import type { R4Api } from "../lib/api.ts"
import { Login } from "./Login.tsx"
import { Workspace } from "./Workspace.tsx"

type Session = { readonly api: R4Api; readonly bootstrap: Bootstrap }

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const showcase =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("showcase")
  if (showcase) return <Showcase />
  if (session === null)
    return <Login onAuthenticated={setSession} onUnauthorized={() => setSession(null)} />
  return <Workspace session={session} onLogout={() => setSession(null)} />
}
