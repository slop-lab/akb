import type { CreateWorkItem } from "./model.ts"

export function createFingerprint(command: CreateWorkItem): string {
  return JSON.stringify({
    workspaceId: command.workspaceId,
    title: command.title,
    accountableOwnerId: command.accountableOwnerId,
    actorId: command.actorId,
    ...(command.spaceId === undefined ? {} : { spaceId: command.spaceId }),
  })
}
