import {
  MilestoneCreateSchema,
  MilestoneUpdateSchema,
  ModuleCreateSchema,
  ModuleUpdateSchema,
  ProjectUpdateCreateSchema,
  WorkPlanningSchema,
} from "../contracts/planning/index.ts"
import type { BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import {
  addDependency,
  insertPlanningEntity,
  planningRecord,
  targetRevision,
} from "./persistence.ts"
import {
  milestoneSnapshot,
  moduleSnapshot,
  notifyProjectMembers,
  projectBatch,
  projectCommand,
  projectPlanningEntity,
  projectUpdateSnapshot,
  requiredProjectResource,
  requireProjectManage,
  stableProjectEntityId,
} from "./project-command-support.ts"
import { projectProgress } from "./queries.ts"
import type { PlanningCommandCall } from "./types.ts"
import { planningWorkRecord, validateAssignments } from "./work-assignment.ts"

export class ProjectPlanningCommands {
  readonly #unit: CommandUnitOfWork

  constructor(unit: CommandUnitOfWork) {
    this.#unit = unit
  }

  execute(call: PlanningCommandCall): Promise<BatchMutationResult> {
    switch (call.action) {
      case "milestone.create":
        return this.#createMilestone(call)
      case "milestone.update":
        return this.#updateMilestone(call)
      case "module.create":
        return this.#createModule(call)
      case "module.update":
        return this.#updateModule(call)
      case "work-planning.update":
        return this.#assignWork(call)
      case "project-update.publish":
        return this.#publishUpdate(call)
      default:
        throw new CommandInvariantError("unsupported_project_planning_action")
    }
  }

  #createMilestone(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = MilestoneCreateSchema.parse(call.payload)
    const projectId = requiredProjectResource(call.parentId)
    const id = stableProjectEntityId(call, "milestone")
    return this.#unit.execute(
      projectCommand(call, id),
      [{ entityId: id, expectedRevision: null, permission: "project.manage" }],
      async (tx, targets) => {
        await requireProjectManage(tx, call, projectId)
        await insertPlanningEntity(tx, projectPlanningEntity(call, id, "milestone"))
        await tx`insert into milestones
        (id,workspace_id,project_id,position,name,description,target_date,revision,created_at,updated_at)
        values (${id},${call.workspaceId},${projectId},${payload.position},${payload.name},
          ${payload.description},${payload.targetDate},1,clock_timestamp(),clock_timestamp())`
        await addDependency(tx, id, projectId)
        return projectBatch(
          id,
          planningRecord({
            id,
            kind: "milestone",
            revision: targetRevision(targets, id),
            snapshot: await milestoneSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #updateMilestone(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = MilestoneUpdateSchema.parse(call.payload)
    const id = requiredProjectResource(call.resourceId)
    return this.#unit.execute(
      projectCommand(call, id),
      [{ entityId: id, expectedRevision: call.baseRevision, permission: "project.manage" }],
      async (tx, targets) => {
        const revision = targetRevision(targets, id)
        await tx`update milestones set position=coalesce(${payload.position ?? null},position),
        name=coalesce(${payload.name ?? null},name),description=coalesce(${payload.description ?? null},description),
        target_date=case when ${payload.targetDate !== undefined} then ${payload.targetDate ?? null} else target_date end,
        revision=${revision},updated_at=clock_timestamp() where id=${id}`
        return projectBatch(
          id,
          planningRecord({
            id,
            kind: "milestone",
            revision,
            snapshot: await milestoneSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #createModule(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = ModuleCreateSchema.parse(call.payload)
    const projectId = requiredProjectResource(call.parentId)
    const id = stableProjectEntityId(call, "module")
    return this.#unit.execute(
      projectCommand(call, id),
      [{ entityId: id, expectedRevision: null, permission: "project.manage" }],
      async (tx, targets) => {
        await requireProjectManage(tx, call, projectId)
        await insertPlanningEntity(tx, projectPlanningEntity(call, id, "module"))
        await tx`insert into modules
        (id,workspace_id,project_id,name,description,owner_id,start_date,target_date,status,
         revision,created_at,updated_at)
        values (${id},${call.workspaceId},${projectId},${payload.name},${payload.description},
          ${payload.ownerId},${payload.startDate},${payload.targetDate},${payload.status},1,
          clock_timestamp(),clock_timestamp())`
        await addDependency(tx, id, projectId)
        return projectBatch(
          id,
          planningRecord({
            id,
            kind: "module",
            revision: targetRevision(targets, id),
            snapshot: await moduleSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #updateModule(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = ModuleUpdateSchema.parse(call.payload)
    const id = requiredProjectResource(call.resourceId)
    return this.#unit.execute(
      projectCommand(call, id),
      [{ entityId: id, expectedRevision: call.baseRevision, permission: "project.manage" }],
      async (tx, targets) => {
        const revision = targetRevision(targets, id)
        await tx`update modules set name=coalesce(${payload.name ?? null},name),
        description=coalesce(${payload.description ?? null},description),
        owner_id=case when ${payload.ownerId !== undefined} then ${payload.ownerId ?? null} else owner_id end,
        start_date=case when ${payload.startDate !== undefined} then ${payload.startDate ?? null} else start_date end,
        target_date=case when ${payload.targetDate !== undefined} then ${payload.targetDate ?? null} else target_date end,
        status=coalesce(${payload.status ?? null},status),revision=${revision},updated_at=clock_timestamp()
        where id=${id}`
        return projectBatch(
          id,
          planningRecord({ id, kind: "module", revision, snapshot: await moduleSnapshot(tx, id) }),
        )
      },
    )
  }

  #assignWork(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = WorkPlanningSchema.parse(call.payload)
    const workId = requiredProjectResource(call.resourceId)
    return this.#unit.execute(
      projectCommand(call, workId),
      [{ entityId: workId, expectedRevision: call.baseRevision, permission: "work.update" }],
      async (tx, targets) => {
        const scope = await tx<
          {
            readonly workspace_id: string
            readonly space_id: string
            readonly project_id: string | null
          }[]
        >`
        select workspace_id,space_id,project_id from work_item_pm where work_item_id=${workId}`
        const work = scope[0]
        if (work === undefined) throw new CommandInvariantError("work_item_not_found")
        await validateAssignments(tx, { call, work, assignment: payload })
        const revision = targetRevision(targets, workId)
        await tx`insert into work_item_planning
        (work_item_id,workspace_id,space_id,project_id,estimate,cycle_id,milestone_id,revision,updated_at)
        values (${workId},${work.workspace_id},${work.space_id},${work.project_id},${payload.estimate},
          ${payload.cycleId},${payload.milestoneId},${revision},clock_timestamp())
        on conflict (work_item_id) do update set estimate=excluded.estimate,cycle_id=excluded.cycle_id,
          milestone_id=excluded.milestone_id,revision=excluded.revision,updated_at=excluded.updated_at`
        await tx`delete from work_item_modules where work_item_id=${workId}`
        for (const moduleId of new Set(payload.moduleIds)) {
          await tx`insert into work_item_modules (workspace_id,work_item_id,project_id,module_id)
          values (${work.workspace_id},${workId},${requiredProjectResource(work.project_id)},${moduleId})`
        }
        return projectBatch(workId, await planningWorkRecord(tx, { call, workId, revision }))
      },
    )
  }

  #publishUpdate(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = ProjectUpdateCreateSchema.parse(call.payload)
    const projectId = requiredProjectResource(call.parentId)
    const id = stableProjectEntityId(call, "project-update")
    return this.#unit.execute(
      projectCommand(call, id),
      [{ entityId: id, expectedRevision: null, permission: "project.manage" }],
      async (tx, targets) => {
        await requireProjectManage(tx, call, projectId)
        const metrics = await projectProgress(tx, call.principal, projectId)
        await insertPlanningEntity(tx, projectPlanningEntity(call, id, "project_update"))
        await tx`insert into project_updates
        (id,workspace_id,project_id,health,body,author_id,published_at,total,completed,
         estimated,blocked,metric_mode,revision)
        values (${id},${call.workspaceId},${projectId},${payload.health},${payload.body},
          ${call.principal.principalId},clock_timestamp(),${metrics.total},${metrics.completed},
          ${metrics.mode === "estimate" ? metrics.total : 0},${metrics.blocked},${metrics.mode},1)`
        await addDependency(tx, id, projectId)
        const revision = targetRevision(targets, id)
        const record = planningRecord({
          id,
          kind: "project_update",
          revision,
          snapshot: await projectUpdateSnapshot(tx, id),
          result: { id, metrics },
          postEvent: async (eventId) =>
            notifyProjectMembers(tx, { call, projectId, sourceEntityId: id, eventId }),
        })
        return projectBatch(id, record)
      },
    )
  }
}
