import type { Bootstrap } from "../../../../src/contracts/r4/index.ts"
import type { R4Api } from "../lib/api.ts"

export type Session = {
  readonly api: R4Api
  readonly bootstrap: Bootstrap
}

export type ScreenProps = {
  readonly session: Session
  readonly announce: (message: string) => void
}

export type Route =
  | "projects"
  | "spaces"
  | "work"
  | "saved"
  | "search"
  | "planning"
  | "content"
  | "runtime"
  | "knowledge"
  | "automation"
  | "transfer"
