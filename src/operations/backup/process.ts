import { spawn } from "node:child_process"
import type { FileHandle } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import { parsePostgresDatabaseUrl } from "../../postgres/database-url.ts"
import { POSTGRES_MAJOR } from "./constants.ts"
import { backupError } from "./errors.ts"

const ToolVersionSchema = z.string().regex(/\b(\d+)\.(?:\d+)(?:\.\d+)?\b/)
const TOOL_TIMEOUT_MS = 10 * 60 * 1_000
const STDERR_LIMIT = 2_048

export type ToolConnection = {
  readonly args: readonly string[]
  readonly environment: NodeJS.ProcessEnv
  readonly secrets: readonly string[]
  readonly databaseName: string
}

export function toolConnection(rawUrl: string): ToolConnection {
  let parsed: ReturnType<typeof parsePostgresDatabaseUrl>
  try {
    parsed = parsePostgresDatabaseUrl(rawUrl)
  } catch (error) {
    throw backupError("invalid_database_url", "database URL is invalid", error)
  }
  return {
    args: [`--dbname=${parsed.toolUrl}`],
    environment: {
      PGPASSWORD: parsed.password,
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "agent-first-workspace-backup",
    },
    secrets: [rawUrl, parsed.password].filter((value) => value.length > 0),
    databaseName: parsed.databaseName,
  }
}

export function redactDiagnostic(value: string, secrets: readonly string[]): string {
  let sanitized = value
  for (const secret of secrets) sanitized = sanitized.replaceAll(secret, "[redacted]")
  sanitized = sanitized.replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-url]")
  return sanitized.slice(0, STDERR_LIMIT)
}

export async function requireToolMajor(path: string, expected = POSTGRES_MAJOR): Promise<void> {
  const result = await runTool({ path, args: ["--version"], environment: {}, secrets: [] })
  const match = ToolVersionSchema.safeParse(result.stdout)
  const major = match.success ? Number(match.data.match(/\d+/)?.[0]) : Number.NaN
  if (major !== expected) {
    throw backupError(
      "tool_version_mismatch",
      `${basename(path)} major version must be ${expected}`,
    )
  }
}

export type RunToolInput = {
  readonly path: string
  readonly args: readonly string[]
  readonly environment: NodeJS.ProcessEnv
  readonly secrets: readonly string[]
  readonly stdoutFile?: FileHandle
  readonly stdinFile?: FileHandle
  readonly timeoutMs?: number
}

export async function runTool(input: RunToolInput): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^PG/i.test(name)),
    )
    const child = spawn(input.path, [...input.args], {
      shell: false,
      env: { ...inheritedEnvironment, ...input.environment },
      stdio: [input.stdinFile?.fd ?? "ignore", input.stdoutFile?.fd ?? "pipe", "pipe"],
    })
    const stderr: Buffer[] = []
    const stdout: Buffer[] = []
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < STDERR_LIMIT) stderr.push(chunk)
    })
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    const timeout = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs ?? TOOL_TIMEOUT_MS)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(backupError("tool_failed", "PostgreSQL tool could not start", error))
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") })
        return
      }
      const diagnostic = redactDiagnostic(Buffer.concat(stderr).toString("utf8"), input.secrets)
      reject(
        backupError(
          "tool_failed",
          `PostgreSQL tool failed (${code ?? signal ?? "unknown"}): ${diagnostic}`,
        ),
      )
    })
  })
}
