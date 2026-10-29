// @ts-check

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const directory = await mkdtemp(join(tmpdir(), "project-kb-consumer-"))

/**
 * @param {readonly string[]} args
 * @param {string} cwd
 */
function run(args, cwd) {
  const result = spawnSync("pnpm", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

try {
  const artifact = JSON.parse(
    run(
      [
        "--config.ignore-scripts=true",
        "--filter",
        "@slop-lab/akb-project-kb",
        "pack",
        "--json",
        "--pack-destination",
        directory,
      ],
      root,
    ),
  )
  assert.equal(typeof artifact?.filename, "string")
  assert.equal(
    artifact.files.some((file) => file.path.startsWith("src/")),
    false,
  )
  assert.equal(
    artifact.files.some((file) => file.path === "dist/react/styles.css"),
    true,
  )
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "@this-project/package-consumer", private: true, type: "module" }),
  )
  run(["add", "--ignore-scripts", artifact.filename], directory)
  await writeFile(
    join(directory, "consumer.mjs"),
    `
    import assert from "node:assert/strict"
    import { createServerProjectKbClient } from "@slop-lab/akb-project-kb/server"
    import { createProjectKbClient } from "@slop-lab/akb-project-kb/client"
    import { documentFromTemplate } from "@slop-lab/akb-project-kb/contracts"
    assert.equal(typeof createServerProjectKbClient, "function")
    assert.equal(typeof createProjectKbClient, "function")
    assert.equal(documentFromTemplate("map-brief").version, 1)
    console.log("Standalone packed server/client/contracts imports passed without React")
  `,
  )
  let result = spawnSync(process.execPath, [join(directory, "consumer.mjs")], {
    cwd: directory,
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  process.stdout.write(result.stdout)

  const react = JSON.parse(await readFile(join(root, "node_modules/react/package.json"), "utf8"))
  run(
    ["add", "--ignore-scripts", `react@${react.version}`, `react-dom@${react.version}`],
    directory,
  )
  await writeFile(
    join(directory, "react-consumer.mjs"),
    `
    import assert from "node:assert/strict"
    import { createElement } from "react"
    import { renderToStaticMarkup } from "react-dom/server"
    import { ProjectNotebook } from "@slop-lab/akb-project-kb/react"
    import { createProjectKbClient } from "@slop-lab/akb-project-kb/client"
    const client = createProjectKbClient({ workspaceId: "studio", transport: async () => ({}) })
    const html = renderToStaticMarkup(createElement(ProjectNotebook, {client, projectId:"album", projectName:"Album"}))
    assert.ok(html.length > 0)
    console.log("Standalone packed React import and server rendering passed")
  `,
  )
  result = spawnSync(process.execPath, [join(directory, "react-consumer.mjs")], {
    cwd: directory,
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  process.stdout.write(result.stdout)
} finally {
  await rm(directory, { recursive: true, force: true })
}
