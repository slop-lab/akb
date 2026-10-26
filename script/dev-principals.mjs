import { readFile, writeFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { WORK_PERMISSIONS } from "../src/identity/types.ts"
import { createPostgresClient } from "../src/postgres/client.ts"

const root = resolve(import.meta.dirname, "..")
const output = resolve(root, "secrets/dev-principals.json")
const exists = await stat(output).then(() => true).catch((error) => {
  if (error.code === "ENOENT") return false
  throw error
})
if (exists) {
  process.stdout.write(`Preserved ${output}; use the admin CLI for credential renewal.\n`)
} else {
  const password = (await readFile(resolve(root, "secrets/postgres-password"), "utf8")).trim()
  const sql = createPostgresClient(process.env.DATABASE_URL ?? `postgres://afw:${password}@127.0.0.1:5432/afw`)
  const admin = new IdentityAdmin(sql)
  const workspaceId = "akb-dev"
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  try {
    const owner = await admin.bootstrapWorkspace({
      workspaceId, workspaceName: "AKB development", principalId: "akb-dev-owner",
      principalName: "Development author", expiresAt,
    })
    await admin.setPermissions({ workspaceId, principalId: "akb-dev-owner", permissions: [
      ...WORK_PERMISSIONS, "content.read", "content.manage", "knowledge.read", "knowledge.propose",
      "knowledge.accept", "review.read", "review.decide",
    ] })
    await admin.provisionPrincipal({ workspaceId, principalId: "akb-dev-reviewer",
      displayName: "Development reviewer", kind: "human", role: "member", permissions: [
        "work.read", "space.read", "project.read", "view.read", "history.read", "content.read",
        "knowledge.read", "knowledge.accept", "review.read", "review.decide",
      ] })
    await admin.provisionPrincipal({ workspaceId, principalId: "akb-dev-work-hub",
      displayName: "Work Hub connector", kind: "service", role: "member",
      permissions: ["content.read", "knowledge.read", "knowledge.propose"],
    })
    const reviewer = await admin.issueToken({ workspaceId, principalId: "akb-dev-reviewer", expiresAt })
    const connector = await admin.issueToken({ workspaceId, principalId: "akb-dev-work-hub", expiresAt })
    await writeFile(output, `${JSON.stringify({ workspaceId, owner, reviewer, connector }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 })
    process.stdout.write(`Created scoped development credentials at ${output}; expires ${expiresAt}.\n`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}
