import { z } from "zod"
import { createPostgresClient, databaseUrlFromEnvironment } from "../../postgres/client.ts"
import { inspectRetention, RetentionResourceSchema } from "./service.ts"

export const RETENTION_HELP = `Usage: node app/retention.mjs dry-run --workspace-id ID --resources CSV

The command is read-only. Canonical resources are always reported as keep_forever.`

const OptionsSchema = z.strictObject({
  "workspace-id": z.string().trim().min(1),
  resources: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(RetentionResourceSchema).min(1)),
})

export async function runRetentionCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") return RETENTION_HELP
  z.literal("dry-run").parse(args[0])
  const options = OptionsSchema.parse(parseOptions(args.slice(1)))
  const sql = createPostgresClient(databaseUrlFromEnvironment(environment))
  try {
    return JSON.stringify(
      await inspectRetention(sql, {
        workspaceId: options["workspace-id"],
        resources: options.resources,
      }),
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function parseOptions(args: readonly string[]): Readonly<Record<string, string>> {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
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
  }
  return options
}
