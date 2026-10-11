import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const MODULE_IMPORTS = [
  "./src/postgres/r4-application.ts",
  "./src/identity/r4-admin-cli.ts",
  "./src/outbox/cli.ts",
  "./src/operations/retention/cli.ts",
  "./src/import-export/command-dispatcher.ts",
  "./src/http/request-telemetry.ts",
  "./src/http/web-assets.ts",
] as const

test("R4 production modules load in native Node TypeScript strip-only mode", () => {
  // Given
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "NODE_OPTIONS"),
  )
  const source = MODULE_IMPORTS.map((modulePath) => `await import('${modulePath}')`).join(";")

  // When
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
  })

  // Then
  assert.equal(result.status, 0, result.stderr)
})
