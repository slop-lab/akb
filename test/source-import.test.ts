import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("native Node imports the TypeScript server source graph", () => {
  // Given
  const command = ['import("./src/server.ts")']

  // When
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", ...command], {
    cwd: process.cwd(),
    encoding: "utf8",
  })

  // Then
  assert.equal(result.status, 0, result.stderr)
})
