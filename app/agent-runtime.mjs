import { runAgentCli } from "../src/agent-runtime/cli.ts"
import { createWorkspaceToolBundle, describeWorkspaceTools } from "../src/agent-tools/index.ts"

const abort = new AbortController()
const cancel = () => abort.abort()
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)

const exitCode = await runAgentCli({
  arguments: process.argv.slice(2),
  environment: process.env,
  io: {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  dependencies: { createWorkspaceToolBundle, describeWorkspaceTools },
  runtime: { signal: abort.signal },
})
process.exitCode = exitCode
