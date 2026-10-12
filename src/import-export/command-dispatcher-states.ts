import type { TransactionSql } from "postgres"
import type { ImportRecord } from "../contracts/r4/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { CommandCall, CommandExecutor } from "../pm/commands/types.ts"
import { archiveCommand } from "./command-dispatcher-archive.ts"
import { nextStatePosition } from "./workflow-state-position.ts"

const MAX_POSITION = 2_147_483_647
const BOOTSTRAP_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const
const STABLE_STATE_ID = /^state:[0-9a-f]{64}$/

type StateRecord = Extract<ImportRecord, { readonly kind: "workflow_state" }>
type SpaceRecord = Extract<ImportRecord, { readonly kind: "space" }>
type BootstrapRow = {
  readonly category: string
  readonly id: string
  readonly position: number
  readonly revision: number
}
type BootstrapPair = { readonly record: StateRecord; readonly row: BootstrapRow }

type ReconciliationContext = {
  readonly principal: AuthenticatedPrincipal
  readonly importId: string
  readonly records: readonly ImportRecord[]
  readonly spaces: ReadonlyMap<string, string>
  readonly createdSpaces: ReadonlySet<string>
  readonly entities: Map<string, string>
}

type ReconciliationResult = {
  readonly archives: readonly CommandCall[]
  readonly reconciled: ReadonlySet<string>
}

export async function reconcileCreatedBootstrapStates(
  transaction: TransactionSql,
  commands: CommandExecutor,
  context: ReconciliationContext,
): Promise<ReconciliationResult> {
  const reconciled = new Set<string>()
  const archives: CommandCall[] = []
  for (const sourceSpaceId of context.createdSpaces) {
    const destinationSpaceId = context.spaces.get(sourceSpaceId)
    if (destinationSpaceId === undefined) continue
    const stateRecords = context.records
      .filter(isWorkflowState)
      .filter((record) => record.spaceId === sourceSpaceId)
    const spaceRecord = context.records.find(
      (record): record is SpaceRecord =>
        record.kind === "space" && record.externalId === sourceSpaceId,
    )
    const rows = await transaction<BootstrapRow[]>`select id,category,position,
      revision::integer revision from workflow_states
      where workspace_id=${context.principal.workspaceId} and space_id=${destinationSpaceId}`
    const authoritative =
      spaceRecord?.workflowStateScope !== undefined || isUnambiguousLegacyExport(stateRecords)
    const matched = authoritative ? pairBootstrapStates(stateRecords, rows) : []
    const matchedRowIds = new Set(matched.map(({ row }) => row.id))
    if (authoritative) {
      for (const row of rows) {
        if (matchedRowIds.has(row.id)) continue
        const key = `import:${context.importId}:${sourceSpaceId}:bootstrap:${row.id}:archive`
        archives.push({
          workspaceId: context.principal.workspaceId,
          principal: context.principal,
          commandId: key,
          idempotencyKey: key,
          baseRevision: row.revision,
          action: "workflow-state.archive",
          route: "import:workflow_state",
          resourceId: row.id,
          parentId: destinationSpaceId,
          payload: {},
        })
      }
    }
    const usedPositions = new Set([
      ...rows.map((row) => row.position),
      ...stateRecords.map(
        (record) => record.position ?? nextStatePosition(record, context.records),
      ),
    ])
    const revisions = new Map<string, number>()
    for (const { record, row } of matched) {
      const temporary = nextFreePosition(usedPositions)
      usedPositions.add(temporary)
      const result = await commands.execute(
        stateUpdateCall(
          context,
          record,
          destinationSpaceId,
          row.id,
          row.revision,
          {
            position: temporary,
          },
          "prepare",
        ),
      )
      revisions.set(record.externalId, result.revision)
    }
    for (const { record, row } of [...matched].sort(
      (left, right) => Number(right.record.isDefault) - Number(left.record.isDefault),
    )) {
      const revision = revisions.get(record.externalId)
      if (revision === undefined) continue
      const call = stateUpdateCall(context, record, destinationSpaceId, row.id, revision, {
        name: record.name,
        color: record.color ?? "#64748B",
        position: record.position ?? nextStatePosition(record, context.records),
        isDefault: record.isDefault ?? false,
      })
      const result = await commands.execute(call)
      context.entities.set(record.externalId, row.id)
      reconciled.add(record.externalId)
      const archive = archiveCommand(call, record, row.id, result.revision)
      if (archive !== null) archives.push(archive)
    }
  }
  return { archives, reconciled }
}

function pairBootstrapStates(
  records: readonly StateRecord[],
  rows: readonly BootstrapRow[],
): readonly BootstrapPair[] {
  const pairs: BootstrapPair[] = []
  for (const category of BOOTSTRAP_CATEGORIES) {
    const row = rows.find((candidate) => candidate.category === category)
    if (row === undefined) continue
    const exact = records.find(
      (record) => record.category === category && record.externalId === row.id,
    )
    if (exact !== undefined) {
      pairs.push({ record: exact, row })
      continue
    }
    const candidates = records.filter(
      (record) => record.category === category && STABLE_STATE_ID.test(record.externalId),
    )
    const stable = candidates.length === 1 ? candidates[0] : undefined
    if (stable !== undefined) {
      pairs.push({ record: stable, row })
      continue
    }
    const replacement = records
      .filter((record) => record.category === category)
      .sort(compareReplacementCandidates)[0]
    if (replacement !== undefined) pairs.push({ record: replacement, row })
  }
  return pairs
}

function isUnambiguousLegacyExport(records: readonly StateRecord[]): boolean {
  return (
    records.some((record) => STABLE_STATE_ID.test(record.externalId)) &&
    BOOTSTRAP_CATEGORIES.every((category) =>
      records.some((record) => record.category === category),
    ) &&
    records.every(
      (record) =>
        record.color !== undefined &&
        record.position !== undefined &&
        record.isDefault !== undefined,
    )
  )
}

function compareReplacementCandidates(left: StateRecord, right: StateRecord): number {
  return (
    Number(right.isDefault) - Number(left.isDefault) ||
    (left.position ?? MAX_POSITION) - (right.position ?? MAX_POSITION) ||
    left.externalId.localeCompare(right.externalId)
  )
}

function stateUpdateCall(
  context: ReconciliationContext,
  record: Extract<ImportRecord, { readonly kind: "workflow_state" }>,
  spaceId: string,
  entityId: string,
  revision: number,
  payload: Readonly<Record<string, unknown>>,
  suffix?: string,
): CommandCall {
  const key = `import:${context.importId}:${record.externalId}${suffix === undefined ? "" : `:${suffix}`}`
  return {
    workspaceId: context.principal.workspaceId,
    principal: context.principal,
    commandId: key,
    idempotencyKey: key,
    baseRevision: revision,
    action: "workflow-state.update",
    route: "import:workflow_state",
    resourceId: entityId,
    parentId: spaceId,
    payload,
  }
}

function nextFreePosition(used: ReadonlySet<number>): number {
  for (let position = MAX_POSITION; position >= 0; position -= 1) {
    if (!used.has(position)) return position
  }
  throw new RangeError("workflow state positions exhausted")
}

function isWorkflowState(record: ImportRecord): record is StateRecord {
  return record.kind === "workflow_state"
}
