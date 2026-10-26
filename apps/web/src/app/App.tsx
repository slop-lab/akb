import { lazy, Suspense, useState } from "react"
import type { Bootstrap } from "../../../../src/contracts/r4/index.ts"
import type { R4Api } from "../lib/api.ts"
import { Login } from "./Login.tsx"
import { parseLocation } from "./navigation.ts"

const Showcase = lazy(async () => {
  const module = await import("../components/Showcase.tsx")
  return { default: module.Showcase }
})

const Workspace = lazy(async () => {
  const module = await import("./Workspace.tsx")
  return { default: module.Workspace }
})

type Session = { readonly api: R4Api; readonly bootstrap: Bootstrap }

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const initialLocation = parseLocation(new URL(window.location.href))
  const showcase =
    import.meta.env.DEV && new URLSearchParams(window.location.search).has("showcase")
  if (showcase)
    return (
      <Suspense fallback={<p role="status">Loading showcase...</p>}>
        <Showcase />
      </Suspense>
    )
  if (session === null)
    return (
      <Login
        {...(initialLocation.workspaceId === undefined
          ? {}
          : { initialWorkspace: initialLocation.workspaceId })}
        onAuthenticated={setSession}
        onUnauthorized={() => setSession(null)}
      />
    )
  return (
    <Suspense fallback={<p role="status">Loading workspace...</p>}>
      <Workspace session={session} onLogout={() => setSession(null)} />
    </Suspense>
  )
}
