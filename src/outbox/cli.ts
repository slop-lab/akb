import { z } from "zod"
import { createPostgresClient, databaseUrlFromEnvironment } from "../postgres/client.ts"
import { WorkspaceIdSchema } from "../work-items/identifiers.ts"
import { EntityOutboxRepository } from "./entity-repository.ts"
import { OutboxRepository } from "./repository.ts"
import { runDatabaseInboxWorker } from "./worker.ts"

const HELP = `Usage: npm run outbox -- <command> [options]

Commands:
  register --workspace-id ID --destination-id ID --sink database-inbox [--stream work-item-v1|entity-v1]
  run --workspace-id ID --destination-id ID --sink database-inbox [--stream work-item-v1|entity-v1] [--drain]
  retry-dead --workspace-id ID --destination-id ID --job-id UUID [--stream work-item-v1|entity-v1]`

export const DestinationIdSchema = z
  .string()
  .min(1)
  .regex(/\S/)
  .refine((value) => Array.from(value).length <= 128)
  .transform((value) => value.trim())
const ScopeSchema = z.strictObject({
  "workspace-id": WorkspaceIdSchema,
  "destination-id": DestinationIdSchema,
})

export type OutboxCliResult = {
  readonly output: string
  readonly successful: boolean
}

export async function runOutboxCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<OutboxCliResult> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    return { output: HELP, successful: true }
  }
  const command = z.enum(["register", "run", "retry-dead"]).parse(args[0])
  const options = parseOptions(args.slice(1))
  const sql = createPostgresClient(databaseUrlFromEnvironment(environment))
  const stream = z
    .enum(["work-item-v1", "entity-v1"])
    .default("work-item-v1")
    .parse(options["stream"])
  const repository =
    stream === "work-item-v1" ? new OutboxRepository(sql) : new EntityOutboxRepository(sql)
  try {
    switch (command) {
      case "register": {
        const value = ScopeSchema.extend({
          sink: z.literal("database-inbox"),
          stream: z.enum(["work-item-v1", "entity-v1"]).optional(),
        }).parse(options)
        const scope = { workspaceId: value["workspace-id"], destinationId: value["destination-id"] }
        const cutoff = await repository.register(scope)
        return {
          output: JSON.stringify({ registered: value["destination-id"], startAfter: cutoff }),
          successful: true,
        }
      }
      case "run": {
        const value = ScopeSchema.extend({
          sink: z.literal("database-inbox"),
          stream: z.enum(["work-item-v1", "entity-v1"]).optional(),
          drain: z.literal("true").optional(),
        }).parse(options)
        const scope = { workspaceId: value["workspace-id"], destinationId: value["destination-id"] }
        const workerOptions = {
          drain: value.drain === "true",
          ...(signal === undefined ? {} : { signal }),
        }
        const summary =
          stream === "work-item-v1"
            ? await runDatabaseInboxWorker(new OutboxRepository(sql), scope, workerOptions)
            : await runDatabaseInboxWorker(new EntityOutboxRepository(sql), scope, workerOptions)
        return {
          output: JSON.stringify(summary),
          successful: summary.failed === 0 && summary.claimed === summary.delivered,
        }
      }
      case "retry-dead": {
        const value = ScopeSchema.extend({
          "job-id": z.string().uuid(),
          stream: z.enum(["work-item-v1", "entity-v1"]).optional(),
        }).parse(options)
        const scope = { workspaceId: value["workspace-id"], destinationId: value["destination-id"] }
        const retried = await repository.retryDead(scope, value["job-id"])
        return {
          output: JSON.stringify({ retried, jobId: value["job-id"] }),
          successful: retried,
        }
      }
      default:
        return assertNever(command)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function parseOptions(args: readonly string[]): Readonly<Record<string, string>> {
  const options: Record<string, string> & { drain?: string } = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === "--drain") {
      if (options.drain !== undefined) throw new TypeError("duplicate option: --drain")
      options.drain = "true"
      continue
    }
    const value = args[index + 1]
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--")
    ) {
      throw new TypeError("options must be --name value pairs")
    }
    const name = flag.slice(2)
    if (options[name] !== undefined) throw new TypeError(`duplicate option: ${flag}`)
    options[name] = value
    index += 1
  }
  return z.record(z.string(), z.string()).parse(options)
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected command: ${value}`)
}

export { HELP as OUTBOX_HELP }
