import type { Sql } from "postgres"
import { type BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import type { FeatureCommandExecutor } from "../http/feature-command-router.ts"
import { CycleCommands } from "./cycle-commands.ts"
import { ProjectPlanningCommands } from "./project-commands.ts"
import { TemplateNotificationCommands } from "./template-notification-commands.ts"
import type { PlanningAction, PlanningCommandCall } from "./types.ts"

const CYCLE_ACTIONS: ReadonlySet<PlanningAction> = new Set([
  "cycle.create",
  "cycle.update",
  "cycle.activate",
  "cycle.rollover",
])
const PROJECT_ACTIONS: ReadonlySet<PlanningAction> = new Set([
  "milestone.create",
  "milestone.update",
  "module.create",
  "module.update",
  "work-planning.update",
  "project-update.publish",
])

export class PlanningCommandService implements FeatureCommandExecutor<PlanningAction> {
  readonly #cycles: CycleCommands
  readonly #projects: ProjectPlanningCommands
  readonly #templates: TemplateNotificationCommands

  constructor(sql: Sql) {
    const unit = new CommandUnitOfWork(sql)
    this.#cycles = new CycleCommands(unit)
    this.#projects = new ProjectPlanningCommands(unit)
    this.#templates = new TemplateNotificationCommands(unit)
  }

  execute(call: PlanningCommandCall): Promise<BatchMutationResult> {
    if (CYCLE_ACTIONS.has(call.action)) return this.#cycles.execute(call)
    if (PROJECT_ACTIONS.has(call.action)) return this.#projects.execute(call)
    return this.#templates.execute(call)
  }
}
