import type { Sql, TransactionSql } from "postgres"
import { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { MutationResult } from "../../entities/mutation-types.ts"
import { CollaborationCommandService } from "./collaboration-commands.ts"
import { ProjectCommandService } from "./project-commands.ts"
import { SpaceCommandService } from "./space-commands.ts"
import type { CommandAction, CommandCall, CommandExecutor } from "./types.ts"
import { ViewAccessCommandService } from "./view-access-commands.ts"
import { WorkItemCommandService } from "./work-item-commands.ts"

const SPACE_ACTIONS = new Set<CommandAction>([
  "space.create",
  "space.update",
  "space.access",
  "workflow.update",
  "workflow-state.create",
  "workflow-state.update",
  "workflow-state.archive",
])
const PROJECT_ACTIONS = new Set<CommandAction>([
  "label.create",
  "label.update",
  "label.archive",
  "project.create",
  "project.update",
  "project.archive",
  "project.restore",
])
const WORK_ACTIONS = new Set<CommandAction>([
  "work-item.create",
  "work-item.update",
  "work-item.archive",
  "work-item.restore",
])
const COLLABORATION_ACTIONS = new Set<CommandAction>([
  "relation.create",
  "relation.update",
  "relation.archive",
  "comment.create",
  "comment.update",
  "comment.archive",
])

export class R4CommandService implements CommandExecutor {
  readonly #spaces: SpaceCommandService
  readonly #projects: ProjectCommandService
  readonly #workItems: WorkItemCommandService
  readonly #collaboration: CollaborationCommandService
  readonly #views: ViewAccessCommandService

  constructor(sql: Sql | TransactionSql, engine = new EntityMutationEngine(sql)) {
    this.#spaces = new SpaceCommandService(engine)
    this.#projects = new ProjectCommandService(engine)
    this.#workItems = new WorkItemCommandService(engine)
    this.#collaboration = new CollaborationCommandService(engine)
    this.#views = new ViewAccessCommandService(engine)
  }

  execute(call: CommandCall): Promise<MutationResult> {
    if (SPACE_ACTIONS.has(call.action)) return this.#spaces.execute(call)
    if (PROJECT_ACTIONS.has(call.action)) return this.#projects.execute(call)
    if (WORK_ACTIONS.has(call.action)) return this.#workItems.execute(call)
    if (COLLABORATION_ACTIONS.has(call.action)) return this.#collaboration.execute(call)
    return this.#views.execute(call)
  }
}
