import { z } from "zod"
import type { EventId, WorkItemId, WorkspaceId } from "./identifiers.ts"
import { revision } from "./identifiers.ts"
import type {
  CreateResult,
  CreateWorkItem,
  PatchResult,
  PatchWorkItem,
  WorkItem,
  WorkItemEvent,
  WorkItemRevision,
} from "./model.ts"
import type { WorkItemList, WorkItemStore } from "./store.ts"
import { createFingerprint } from "./create-fingerprint.ts"

export const StoreLimitsSchema = z.strictObject({
  itemCapacity: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  auditRecordCapacity: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export type StoreLimits = z.infer<typeof StoreLimitsSchema>

export const DEFAULT_STORE_LIMITS = Object.freeze({
  itemCapacity: 10_000,
  auditRecordCapacity: 100_000,
} satisfies StoreLimits)

export type StoreDependencies = {
  readonly newWorkItemId: () => WorkItemId
  readonly newEventId: () => EventId
  readonly now: () => string
}

type IdempotencyRecord = {
  readonly fingerprint: string
  readonly item: WorkItem
  readonly eventId: EventId
}

type StoredWorkItem = {
  current: WorkItem
  readonly history: WorkItemRevision[]
}

export class InMemoryWorkItemStore implements WorkItemStore {
  readonly #dependencies: StoreDependencies
  readonly #limits: StoreLimits
  readonly #items = new Map<WorkItemId, StoredWorkItem>()
  readonly #events: WorkItemEvent[] = []
  readonly #idempotency = new Map<WorkspaceId, Map<string, IdempotencyRecord>>()

  constructor(dependencies: StoreDependencies, limits: StoreLimits = DEFAULT_STORE_LIMITS) {
    this.#dependencies = dependencies
    this.#limits = Object.freeze({ ...StoreLimitsSchema.parse(limits) })
  }

  create(command: CreateWorkItem): CreateResult {
    const normalizedTitle = command.title
    const fingerprint = createFingerprint(command)
    const workspaceRecords = this.#idempotency.get(command.workspaceId)
    const prior = workspaceRecords?.get(command.idempotencyKey)
    if (prior !== undefined) {
      return prior.fingerprint === fingerprint
        ? { kind: "replayed", item: prior.item, eventId: prior.eventId }
        : { kind: "idempotency_conflict", idempotencyKey: command.idempotencyKey }
    }
    if (this.#items.size >= this.#limits.itemCapacity) {
      return {
        kind: "capacity_exceeded",
        resource: "items",
        capacity: this.#limits.itemCapacity,
      }
    }
    if (this.#events.length >= this.#limits.auditRecordCapacity) {
      return {
        kind: "capacity_exceeded",
        resource: "audit_records",
        capacity: this.#limits.auditRecordCapacity,
      }
    }

    const now = this.#dependencies.now()
    const item = Object.freeze({
      id: this.#dependencies.newWorkItemId(),
      workspaceId: command.workspaceId,
      title: normalizedTitle,
      state: "unstarted",
      accountableOwnerId: command.accountableOwnerId,
      revision: revision(1),
      createdAt: now,
      updatedAt: now,
    } satisfies WorkItem)
    const event = Object.freeze({
      id: this.#dependencies.newEventId(),
      workspaceId: item.workspaceId,
      sequence: this.#events.length + 1,
      type: "work_item.created",
      time: now,
      actorId: command.actorId,
      subjectId: item.id,
      subjectRevision: item.revision,
    } satisfies WorkItemEvent)

    this.#items.set(item.id, { current: item, history: [item] })
    this.#events.push(event)
    const records = workspaceRecords ?? new Map<string, IdempotencyRecord>()
    records.set(command.idempotencyKey, { fingerprint, item, eventId: event.id })
    this.#idempotency.set(command.workspaceId, records)
    return { kind: "created", item, eventId: event.id }
  }

  patch(command: PatchWorkItem): PatchResult {
    const stored = this.#items.get(command.id)
    if (stored === undefined) return { kind: "not_found", id: command.id }
    const current = stored.current
    if (current.revision !== command.baseRevision) {
      return {
        kind: "revision_conflict",
        expected: command.baseRevision,
        actual: current.revision,
      }
    }

    const changedFields = [
      ...(command.title !== undefined && command.title !== current.title ? ["title" as const] : []),
      ...(command.state !== undefined && command.state !== current.state ? ["state" as const] : []),
    ] satisfies readonly ("title" | "state")[]
    if (changedFields.length === 0) return { kind: "unchanged", item: current }
    if (this.#events.length >= this.#limits.auditRecordCapacity) {
      return {
        kind: "capacity_exceeded",
        resource: "audit_records",
        capacity: this.#limits.auditRecordCapacity,
      }
    }
    const next = Object.freeze({
      ...current,
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.state === undefined ? {} : { state: command.state }),
      revision: revision(current.revision + 1),
      updatedAt: this.#dependencies.now(),
    } satisfies WorkItem)
    const event = Object.freeze({
      id: this.#dependencies.newEventId(),
      workspaceId: next.workspaceId,
      sequence: this.#events.length + 1,
      type: "work_item.updated",
      time: next.updatedAt,
      actorId: command.actorId,
      subjectId: next.id,
      subjectRevision: next.revision,
      changedFields: Object.freeze(changedFields),
    } satisfies WorkItemEvent)

    stored.current = next
    stored.history.push(next)
    this.#events.push(event)
    return { kind: "updated", item: next, eventId: event.id }
  }

  get(id: WorkItemId): WorkItem | undefined {
    return this.#items.get(id)?.current
  }

  list(workspaceId: WorkspaceId, limit: number): WorkItemList {
    const matched = [...this.#items.values()]
      .map((stored) => stored.current)
      .filter((item) => item.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
    return { items: Object.freeze(matched.slice(0, limit)), matched: matched.length }
  }

  history(id: WorkItemId): readonly WorkItemRevision[] {
    return Object.freeze([...(this.#items.get(id)?.history ?? [])])
  }

  events(): readonly WorkItemEvent[] {
    return Object.freeze([...this.#events])
  }
}
