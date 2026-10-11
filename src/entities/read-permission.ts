import type { WorkPermission } from "../identity/types.ts"

export function entityReadPermission(kind: string): WorkPermission | null {
  switch (kind) {
    case "work_item":
    case "comment":
    case "thread":
    case "relation":
      return "work.read"
    case "project":
      return "project.read"
    case "space":
    case "workflow":
    case "workflow_state":
    case "label":
      return "space.read"
    case "saved_view":
      return "view.read"
    default:
      return null
  }
}
