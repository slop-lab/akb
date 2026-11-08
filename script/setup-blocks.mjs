// @ts-check

import { execFile, spawn } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { promisify } from "node:util"

const REPOSITORY = "https://github.com/slop-lab/blocks.git"
const REVISION = "df6f800828cd58acd2af65c32e7341609601be89"
const PNPM_VERSION = "10.17.1"
const ROOT = resolve(import.meta.dirname, "..")
const DEPENDENCIES = resolve(ROOT, ".deps")
const CHECKOUT = resolve(DEPENDENCIES, "blocks")
const exec = promisify(execFile)
const args = process.argv.slice(2)
const checkOnly = args.length === 1 && args[0] === "--check"

if (args.length > 0 && !checkOnly) {
  throw new TypeError("Usage: node script/setup-blocks.mjs [--check]")
}

/**
 * @param {string} command
 * @param {readonly string[]} commandArgs
 * @param {string} [cwd]
 */
const run = (command, commandArgs, cwd = ROOT) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, GIT_MASTER: "1" },
      stdio: "inherit",
    })
    child.once("error", rejectRun)
    child.once("exit", (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} exited with code ${String(code)}`))
    })
  })

/**
 * @param {string} command
 * @param {readonly string[]} commandArgs
 * @param {string} [cwd]
 */
const output = async (command, commandArgs, cwd = ROOT) => {
  const result = await exec(command, commandArgs, {
    cwd,
    env: { ...process.env, GIT_MASTER: "1" },
  })
  return result.stdout.trim()
}

/** @param {string} path */
const exists = async (path) =>
  stat(path)
    .then(() => true)
    .catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    })

if (!checkOnly) {
  const pnpmVersion = await output("pnpm", ["--version"])
  if (pnpmVersion !== PNPM_VERSION) {
    throw new TypeError(`Expected pnpm ${PNPM_VERSION}, received ${pnpmVersion}`)
  }
}

if (!checkOnly) await mkdir(DEPENDENCIES, { recursive: true })
const checkoutExists = await exists(CHECKOUT)
const repositoryExists = await exists(resolve(CHECKOUT, ".git"))
const checkoutCreated = !repositoryExists

if (checkoutExists && !repositoryExists) {
  throw new TypeError(`Refusing to overwrite non-Git path: ${CHECKOUT}`)
}

if (!repositoryExists) {
  if (checkOnly) throw new TypeError(`Blocks checkout is missing: ${CHECKOUT}`)
  await run("git", ["clone", "--filter=blob:none", "--no-checkout", REPOSITORY, CHECKOUT])
}

const origin = await output("git", ["remote", "get-url", "origin"], CHECKOUT)
if (origin !== REPOSITORY) {
  throw new TypeError(`Unexpected Blocks origin: ${origin}`)
}

if (!checkoutCreated) {
  const dirty = await output("git", ["status", "--porcelain=v1"], CHECKOUT)
  if (dirty.length > 0) {
    throw new TypeError(`Refusing to modify dirty Blocks checkout:\n${dirty}`)
  }
}

const head = await output("git", ["rev-parse", "HEAD"], CHECKOUT).catch(() => "")
if (checkoutCreated || head !== REVISION) {
  if (checkOnly) throw new TypeError(`Unexpected Blocks revision: ${head || "unborn HEAD"}`)
  const revisionAvailable = await exec("git", ["cat-file", "-e", `${REVISION}^{commit}`], {
    cwd: CHECKOUT,
    env: { ...process.env, GIT_MASTER: "1" },
  })
    .then(() => true)
    .catch(() => false)
  if (!revisionAvailable) await run("git", ["fetch", "--depth=1", "origin", REVISION], CHECKOUT)
  await run("git", ["checkout", "--detach", REVISION], CHECKOUT)
}

if (!checkOnly) {
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], CHECKOUT)
  await run("pnpm", ["--filter", "./packages/**", "--fail-if-no-match", "run", "build"], CHECKOUT)
}

process.stdout.write(`Blocks ${checkOnly ? "checkout verified" : "ready"} at ${REVISION}\n`)
