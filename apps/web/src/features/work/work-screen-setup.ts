import type { BoardRequest, HumanWorkQuery } from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps, Session } from "../../app/types.ts"
import { applyWorkQueryDraft, createWorkQueryDraft } from "./work-query.ts"

export type WorkScreenProps = ScreenProps & {
  readonly initialSavedViews: boolean
  readonly initialProjectId?: string
  readonly initialSpaceId?: string
}

export function initialWorkSpaceId(session: Session, requestedSpaceId: string): string {
  return (
    requestedSpaceId || session.bootstrap.currentSpaceId || session.bootstrap.spaces[0]?.id || ""
  )
}

export function initialAppliedWorkQuery(spaceId: string, projectId: string): HumanWorkQuery {
  return applyWorkQueryDraft(createWorkQueryDraft(spaceId, projectId), "list")
}

export function boardRequest(query: HumanWorkQuery): BoardRequest {
  return {
    ...query,
    workflowStateId: null,
    page: { size: Math.min(query.page.size, 25), cursor: null },
  }
}
