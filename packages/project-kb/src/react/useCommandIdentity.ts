import { useCallback, useRef } from "react"
import { type CommandIdentity, newCommandIdentity } from "../client.ts"

type PendingCommand = {
  readonly fingerprint: string | undefined
  readonly identity: CommandIdentity
}

export function useCommandIdentity() {
  const pending = useRef<PendingCommand | null>(null)
  const forPayload = useCallback((payload: unknown): CommandIdentity => {
    const fingerprint = JSON.stringify(payload)
    if (pending.current === null || pending.current.fingerprint !== fingerprint) {
      pending.current = { fingerprint, identity: newCommandIdentity() }
    }
    return pending.current.identity
  }, [])
  const clear = useCallback(() => {
    pending.current = null
  }, [])
  return { forPayload, clear }
}
