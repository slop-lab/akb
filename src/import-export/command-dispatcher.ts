import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { ImportRecord } from "../contracts/r4/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { R4CommandService } from "../pm/commands/service.ts"
import type { CommandAction, CommandCall } from "../pm/commands/types.ts"
import { orderedImportRecords, toImportCommand } from "./command-dispatcher-mapping.ts"
import {
  type ImportCommandDispatcher,
  ImportConflictError,
  ImportValidationError,
  type ValidatedBatch,
} from "./import-service.ts"
import { prepareImport } from "./import-validation.ts"

export type R4ImportBatch = ValidatedBatch
export type R4ImportDispatcher = ImportCommandDispatcher
type ReuseContext = {
  readonly principal: AuthenticatedPrincipal
  readonly spaces: ReadonlyMap<string, string>
  readonly entities: Map<string, string>
}

export function createR4ImportDispatcher(): R4ImportDispatcher {
  return { validateCommands, importCommands }
}

async function validateCommands(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  batch: R4ImportBatch,
): Promise<readonly string[]> {
  return (await prepareImport(transaction, principal, batch)).warnings
}

async function importCommands(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  batch: R4ImportBatch,
): Promise<{ readonly replayed: boolean }> {
  const existing = await transaction<
    { readonly content_digest: string; readonly state: string; readonly principal_id: string }[]
  >`
    select content_digest,state,principal_id from import_batches where workspace_id=${principal.workspaceId}
      and import_id=${batch.importId} for update`
  if (existing[0]?.state === "committed") {
    if (
      existing[0].content_digest !== batch.digest ||
      existing[0].principal_id !== principal.principalId
    ) {
      throw new ImportConflictError("import identity conflicts with content")
    }
    await requireReplayAccess(transaction, principal, batch.importId)
    return { replayed: true }
  }
  if (existing.length > 0) throw new ImportConflictError("import identity conflicts with content")

  const preparation = await prepareImport(transaction, principal, batch)
  const commands = new R4CommandService(transaction)
  const entities = new Map<string, string>()
  const spaces = new Map<string, string>()
  const archives: CommandCall[] = []
  await loadReusableSpaces(transaction, principal, batch.records, entities, spaces)
  const reuse = { principal, spaces, entities }
  const records = orderedImportRecords(batch.records)
  for (const record of records) {
    if (record.kind === "manifest") continue
    if (record.kind === "space" && spaces.has(record.externalId)) continue
    if (record.kind === "workflow_state" && (await mapReusableState(transaction, record, reuse)))
      continue
    if (record.kind === "label" && (await mapReusableLabel(transaction, record, reuse))) continue
    const call = toImportCommand(record, {
      principal,
      importId: batch.importId,
      entities,
      spaces,
      projectSlugs: preparation.projectSlugs,
      records,
    })
    const result = await commands.execute(call)
    const id = resultField(result.result, "id")
    if (record.kind === "space") {
      entities.set(record.externalId, resultField(result.result, "entityId"))
      spaces.set(record.externalId, id)
    } else entities.set(record.externalId, id)
    const archive = archiveCommand(call, record, id, result.revision)
    if (archive !== null) archives.push(archive)
  }
  for (const archive of archives) await commands.execute(archive)
  await transaction`insert into import_batches
    (import_id,workspace_id,principal_id,content_digest,byte_size,record_count,state,
     validation_expires_at,committed_at) values (${batch.importId},${principal.workspaceId},
      ${principal.principalId},${batch.digest},${batch.byteSize ?? serializedSize(batch.records)},
      ${batch.records.length},'committed',clock_timestamp()+interval '15 minutes',clock_timestamp())`
  for (const record of records) {
    if (record.kind === "manifest") continue
    const entityId = entities.get(record.externalId)
    if (entityId === undefined) throw new ImportValidationError("import mapping is incomplete")
    await transaction`insert into import_record_ids values
      (${batch.importId},${record.externalId},${entityId},${record.kind})`
  }
  return { replayed: false }
}

async function loadReusableSpaces(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  records: readonly ImportRecord[],
  entities: Map<string, string>,
  spaces: Map<string, string>,
): Promise<void> {
  for (const record of records) {
    if (record.kind !== "space") continue
    const rows = await transaction<{ readonly id: string; readonly entity_id: string }[]>`
      select d.space_id id,e.id entity_id from space_details d join entities e
        on e.workspace_id=d.workspace_id and e.scope_space_id=d.space_id and e.kind='space'
      where d.workspace_id=${principal.workspaceId} and d.space_key=${record.key}
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'space.manage')`
    const row = rows[0]
    if (row !== undefined) {
      spaces.set(record.externalId, row.id)
      entities.set(record.externalId, row.entity_id)
    }
  }
}

async function mapReusableState(
  transaction: TransactionSql,
  record: Extract<ImportRecord, { readonly kind: "workflow_state" }>,
  context: ReuseContext,
): Promise<boolean> {
  const spaceId = context.spaces.get(record.spaceId)
  if (spaceId === undefined) throw new ImportValidationError("state space is not mapped")
  const rows = await transaction<{ readonly id: string }[]>`select s.id from workflow_states s
    join workflows w on w.id=s.workflow_id and w.workspace_id=s.workspace_id and w.space_id=s.space_id
    join entities e on e.id=s.id and e.workspace_id=s.workspace_id and e.kind='workflow_state'
    where s.workspace_id=${context.principal.workspaceId} and w.workspace_id=${context.principal.workspaceId}
      and s.space_id=${spaceId} and e.scope_space_id=s.space_id and e.lifecycle='active'
      and s.name=${record.name} and s.category=${record.category}
      and s.color=${record.color ?? "#64748B"} and s.position=${record.position ?? -1}
      and s.is_default=${record.isDefault ?? false} and s.active and w.active
      and entity_access_allowed(s.workspace_id,stable_space_entity_id(s.workspace_id,s.space_id),
        ${context.principal.principalId},'space.manage')
      and entity_access_allowed(s.workspace_id,s.id,${context.principal.principalId},'space.read')`
  const row = rows[0]
  if (row === undefined) return false
  context.entities.set(record.externalId, row.id)
  return true
}

async function mapReusableLabel(
  transaction: TransactionSql,
  record: Extract<ImportRecord, { readonly kind: "label" }>,
  context: ReuseContext,
): Promise<boolean> {
  const spaceId = context.spaces.get(record.spaceId)
  if (spaceId === undefined) throw new ImportValidationError("label space is not mapped")
  const rows = await transaction<{ readonly id: string }[]>`select l.id from labels l
    join entities e on e.id=l.id and e.workspace_id=l.workspace_id and e.kind='label'
    where l.workspace_id=${context.principal.workspaceId} and l.space_id=${spaceId}
      and e.scope_space_id=l.space_id and e.lifecycle='active'
      and l.name=${record.name} and l.color=${record.color} and l.archived_at is null
      and entity_access_allowed(l.workspace_id,stable_space_entity_id(l.workspace_id,l.space_id),
        ${context.principal.principalId},'space.manage')
      and entity_access_allowed(l.workspace_id,l.id,${context.principal.principalId},'work.read')`
  const row = rows[0]
  if (row === undefined) return false
  context.entities.set(record.externalId, row.id)
  return true
}

function archiveCommand(
  create: CommandCall,
  record: Exclude<ImportRecord, { readonly kind: "manifest" }>,
  entityId: string,
  revision: number,
): CommandCall | null {
  if (!("archivedAt" in record) || record.archivedAt === null || record.archivedAt === undefined)
    return null
  const action = archiveAction(record.kind)
  if (action === null)
    throw new ImportValidationError(`${record.kind} archive cannot be preserved canonically`)
  return {
    ...create,
    action,
    commandId: `${create.commandId}:archive`,
    idempotencyKey: `${create.idempotencyKey}:archive`,
    baseRevision: revision,
    resourceId: entityId,
    payload: {},
    restoredAt: record.archivedAt,
  }
}

function archiveAction(kind: ImportRecord["kind"]): CommandAction | null {
  switch (kind) {
    case "project":
      return "project.archive"
    case "label":
      return "label.archive"
    case "work_item":
      return "work-item.archive"
    case "relation":
      return "relation.archive"
    case "comment":
      return "comment.archive"
    case "saved_view":
      return "saved-view.archive"
    case "manifest":
    case "space":
    case "workflow_state":
      return null
  }
}

async function requireReplayAccess(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  importId: string,
): Promise<void> {
  const denied = await transaction`select 1 from import_record_ids i where i.import_id=${importId}
    and not entity_access_allowed(${principal.workspaceId},i.entity_id,${principal.principalId},case
      when i.record_kind='project' then 'project.read' when i.record_kind='saved_view' then 'view.read'
      when i.record_kind in ('space','workflow_state') then 'space.read' else 'work.read' end) limit 1`
  if (denied.length > 0) throw new ImportValidationError("import replay authority denied")
}

function serializedSize(records: readonly ImportRecord[]): number {
  return Buffer.byteLength(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
}

function resultField(result: Readonly<Record<string, unknown>>, name: string): string {
  return z.string().parse(result[name])
}
