// @ts-check
import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { chmod, copyFile, mkdir, open } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"

const REQUIRED_NODE = "26.12.1"
const ROOT = resolve(import.meta.dirname, "..")
const SECRETS = resolve(ROOT, "secrets")

if (process.versions.node !== REQUIRED_NODE) {
  throw new TypeError(
    `Node ${REQUIRED_NODE} is required; found ${process.versions.node}. See .node-version.`,
  )
}

const createSecret = async (name) => {
  const path = resolve(SECRETS, name)
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      await file.writeFile(`${randomBytes(32).toString("base64url")}\n`)
    } finally {
      await file.close()
    }
    process.stdout.write(`Created ${path}\n`)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      await chmod(path, 0o600)
      process.stdout.write(`Kept existing ${path}\n`)
      return
    }
    throw error
  }
}

await mkdir(SECRETS, { recursive: true, mode: 0o700 })
await chmod(SECRETS, 0o700)

try {
  await copyFile(resolve(ROOT, ".env.example"), resolve(ROOT, ".env"), constants.COPYFILE_EXCL)
  await chmod(resolve(ROOT, ".env"), 0o600)
  process.stdout.write(`Created ${resolve(ROOT, ".env")}\n`)
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    process.stdout.write(`Kept existing ${resolve(ROOT, ".env")}\n`)
  } else {
    throw error
  }
}

await createSecret("postgres-password")
await createSecret("cursor-signing-key")
await createSecret("backup-encryption-key")

process.stdout.write("Local ignored configuration is ready. No credential values were printed.\n")
