// @ts-check

import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import test from "node:test"
import { promisify } from "node:util"

const exec = promisify(execFile)
const ROOT = resolve(import.meta.dirname, "..")

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 */
const git = async (cwd, args) => (await exec("git", args, { cwd })).stdout.trim()

test("setup succeeds from a no-checkout clone and still refuses later dirty changes", async () => {
  // Given: a local Blocks-shaped Git source and a fake pnpm that avoids package installation.
  const root = await mkdtemp(join(tmpdir(), "akb-blocks-setup-"))
  try {
    const source = join(root, "source")
    const fixtureRoot = join(root, "consumer")
    const fixtureScript = join(fixtureRoot, "script", "setup-blocks.mjs")
    const fakeBin = join(root, "bin")
    const pnpmLog = join(root, "pnpm.log")
    await mkdir(source, { recursive: true })
    await mkdir(join(fixtureRoot, "script"), { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await git(source, ["init"])
    await git(source, ["config", "user.name", "Blocks Setup Test"])
    await git(source, ["config", "user.email", "blocks-setup@example.invalid"])
    await writeFile(join(source, "tracked.txt"), "original\n")
    await git(source, ["add", "tracked.txt"])
    await git(source, ["commit", "-m", "fixture"])
    const revision = await git(source, ["rev-parse", "HEAD"])
    const productionScript = await readFile(join(ROOT, "script", "setup-blocks.mjs"), "utf8")
    await writeFile(
      fixtureScript,
      productionScript
        .replace(
          'const REPOSITORY = "https://github.com/slop-lab/blocks.git"',
          `const REPOSITORY = ${JSON.stringify(source)}`,
        )
        .replace(
          'const REVISION = "df6f800828cd58acd2af65c32e7341609601be89"',
          `const REVISION = ${JSON.stringify(revision)}`,
        ),
    )
    const fakePnpm = join(fakeBin, "pnpm")
    await writeFile(
      fakePnpm,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_PNPM_LOG"\nif [ "$1" = "--version" ]; then\n  printf "10.17.0\\n"\nfi\nexit 0\n',
    )
    await chmod(fakePnpm, 0o755)

    // When/Then: setup rejects an unpinned pnpm before creating the dependency checkout.
    await exec(process.execPath, [fixtureScript], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        FAKE_PNPM_LOG: pnpmLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    }).then(
      () => {
        throw new TypeError("Expected pnpm version refusal")
      },
      (error) => {
        if (
          !(error instanceof Error) ||
          !("stderr" in error) ||
          typeof error.stderr !== "string" ||
          !error.stderr.includes("Expected pnpm 10.17.1, received 10.17.0")
        ) {
          throw error
        }
      },
    )
    const dependenciesCreated = await stat(join(fixtureRoot, ".deps"))
      .then(() => true)
      .catch(() => false)
    if (dependenciesCreated) throw new TypeError("Unpinned pnpm created the dependency checkout")

    await writeFile(
      fakePnpm,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_PNPM_LOG"\nif [ "$1" = "--version" ]; then\n  printf "10.17.1\\n"\nfi\nexit 0\n',
    )
    await writeFile(pnpmLog, "")

    // When: setup initializes a checkout from scratch.
    await exec(process.execPath, [fixtureScript], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        FAKE_PNPM_LOG: pnpmLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    })

    // Then: the requested revision is checked out cleanly.
    const checkout = join(fixtureRoot, ".deps", "blocks")
    const head = await git(checkout, ["rev-parse", "HEAD"])
    const clean = await git(checkout, ["status", "--porcelain=v1"])
    if (head !== revision) throw new TypeError(`Expected ${revision}, received ${head}`)
    if (clean !== "") throw new TypeError(`Expected a clean checkout, received:\n${clean}`)
    const pnpmCommands = await readFile(pnpmLog, "utf8")
    if (
      pnpmCommands !==
      "--version\ninstall --frozen-lockfile --ignore-scripts\n--filter ./packages/** --fail-if-no-match run build\n"
    ) {
      throw new TypeError(`Unexpected pnpm commands:\n${pnpmCommands}`)
    }

    // Given: a real local modification after successful setup.
    await writeFile(join(checkout, "tracked.txt"), "local change\n")

    // When/Then: rerunning setup refuses the dirty checkout without overwriting it.
    await exec(process.execPath, [fixtureScript], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        FAKE_PNPM_LOG: pnpmLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    }).then(
      () => {
        throw new TypeError("Expected dirty checkout refusal")
      },
      (error) => {
        if (
          !(error instanceof Error) ||
          !("stderr" in error) ||
          typeof error.stderr !== "string" ||
          !error.stderr.includes("Refusing to modify dirty Blocks checkout")
        ) {
          throw error
        }
      },
    )
    const retained = await readFile(join(checkout, "tracked.txt"), "utf8")
    if (retained !== "local change\n") throw new TypeError("Dirty checkout content was overwritten")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
