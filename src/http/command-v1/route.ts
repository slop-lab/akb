import type { ZodType } from "zod"
import type { CommandAction } from "../../pm/commands/types.ts"

export type CommandRoute = {
  readonly method: "POST" | "PATCH" | "PUT"
  readonly pattern: RegExp
  readonly action: CommandAction
  readonly payload: ZodType
  readonly create: boolean
  readonly parentCapture?: number
  readonly resourceCapture?: number
}

export function route(
  method: CommandRoute["method"],
  pattern: RegExp,
  action: CommandAction,
  payload: ZodType,
  create: boolean,
  captures: Pick<CommandRoute, "parentCapture" | "resourceCapture"> = {},
): CommandRoute {
  return { method, pattern, action, payload, create, ...captures }
}
