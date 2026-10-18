import type { Sql, TransactionSql } from "postgres"
import {
  ArchivePageSchema,
  CreateInlineCommentSchema,
  CreatePageSchema,
  ImportPageSchema,
  PatchPageSchema,
  RestorePageSchema,
} from "../contracts/content/requests.ts"
import { type BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import type { FeatureCommandCall, FeatureCommandExecutor } from "../http/feature-command-router.ts"
import { createInlineCommentRecord } from "./comment-mutations.ts"
import { markdownToDocument } from "./markdown.ts"
import {
  archivePageRecord,
  createPageRecord,
  patchPageRecord,
  restorePageRecord,
} from "./page-mutations.ts"
import { requireNextRevision } from "./postgres-support.ts"

export const CONTENT_ACTIONS = [
  "page.create",
  "page.patch",
  "page.restore",
  "page.archive",
  "comment.create",
  "page.import",
] as const
export type ContentAction = (typeof CONTENT_ACTIONS)[number]

export class ContentCommandService implements FeatureCommandExecutor<ContentAction> {
  readonly #commands: CommandUnitOfWork

  constructor(sql: Sql) {
    this.#commands = new CommandUnitOfWork(sql)
  }

  async execute(call: FeatureCommandCall<ContentAction>): Promise<BatchMutationResult> {
    const prepared = prepare(call)
    return this.#commands.execute(
      {
        workspaceId: call.workspaceId,
        principal: call.principal,
        commandId: call.commandId,
        idempotencyKey: call.idempotencyKey,
        action: call.action,
        route: call.route,
        payload: call.payload,
        primaryEntityId: prepared.entityId,
      },
      [
        {
          entityId: prepared.entityId,
          expectedRevision: call.baseRevision,
          permission: "content.manage",
        },
      ],
      async (transaction, targets) => ({
        primaryEntityId: prepared.entityId,
        records: [
          await prepared.mutate(transaction, requireNextRevision(targets, prepared.entityId)),
        ],
      }),
    )
  }
}

type Prepared = {
  readonly entityId: string
  readonly mutate: (transaction: TransactionSql, revision: number) => Promise<MutationRecord>
}

function prepare(call: FeatureCommandCall<ContentAction>): Prepared {
  switch (call.action) {
    case "page.create": {
      const input = CreatePageSchema.parse(call.payload)
      const entityId = input.pageId ?? `page:${call.commandId}`
      return {
        entityId,
        mutate: (transaction, revision) =>
          createPageRecord(
            { transaction, principal: call.principal, pageId: entityId, revision },
            input,
          ),
      }
    }
    case "page.import": {
      const input = ImportPageSchema.parse(call.payload)
      const entityId = input.pageId ?? `page:${call.commandId}`
      const create = {
        ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
        spaceId: input.spaceId,
        parentPageId: input.parentPageId,
        title: input.title,
        document: markdownToDocument(input.markdown),
      }
      return {
        entityId,
        mutate: (transaction, revision) =>
          createPageRecord(
            { transaction, principal: call.principal, pageId: entityId, revision },
            create,
          ),
      }
    }
    case "page.patch": {
      const entityId = requiredId(call.resourceId)
      const input = PatchPageSchema.parse(call.payload)
      return {
        entityId,
        mutate: (transaction, revision) =>
          patchPageRecord(
            { transaction, principal: call.principal, pageId: entityId, revision },
            input,
          ),
      }
    }
    case "page.restore": {
      const entityId = requiredId(call.resourceId)
      const input = RestorePageSchema.parse(call.payload)
      return {
        entityId,
        mutate: (transaction, revision) =>
          restorePageRecord(
            { transaction, principal: call.principal, pageId: entityId, revision },
            input.revision,
          ),
      }
    }
    case "page.archive": {
      ArchivePageSchema.parse(call.payload)
      const entityId = requiredId(call.resourceId)
      return {
        entityId,
        mutate: (transaction, revision) =>
          archivePageRecord({ transaction, principal: call.principal, pageId: entityId, revision }),
      }
    }
    case "comment.create": {
      const pageId = requiredId(call.parentId)
      const input = CreateInlineCommentSchema.parse(call.payload)
      const entityId = input.commentId ?? `inline-comment:${call.commandId}`
      return {
        entityId,
        mutate: (transaction, revision) =>
          createInlineCommentRecord({
            transaction,
            principal: call.principal,
            pageId,
            commentId: entityId,
            revision,
            comment: input,
          }),
      }
    }
    default:
      return assertNever(call.action)
  }
}

function requiredId(value: string | null): string {
  if (value === null) throw new CommandInvariantError("content_resource_id_required")
  return value
}

function assertNever(value: never): never {
  throw new CommandInvariantError(`content_action_unsupported:${value}`)
}
