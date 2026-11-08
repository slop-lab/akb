import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { z } from "zod"

const WorkspacePackageSchema = z.object({
  name: z.string(),
  private: z.boolean(),
  path: z.string(),
})

export function packageNameMatchesScope(input: {
  readonly name: string
  readonly private: boolean
}): boolean {
  return input.private
    ? /^@this-project\/[^/]+$/.test(input.name)
    : /^@slop-lab\/akb(?:-.*)?$/.test(input.name)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const output = execFileSync("pnpm", ["--recursive", "list", "--depth", "-1", "--json"], {
    encoding: "utf8",
  })
  const packages = z.array(WorkspacePackageSchema).min(1).parse(JSON.parse(output))
  const failures = packages.filter((entry) => !packageNameMatchesScope(entry))
  if (failures.length > 0) {
    for (const entry of failures) {
      process.stderr.write(
        `${entry.path}/package.json: ${entry.private ? "Private packages require @this-project/..." : "Publishable packages require @slop-lab/akb or @slop-lab/akb-*"}; received ${entry.name}.\n`,
      )
    }
    process.exitCode = 1
  }
}
