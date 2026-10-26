import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const password = (await readFile(resolve(root, "secrets/postgres-password"), "utf8")).trim()
process.env.DATABASE_URL ??= `postgres://afw:${password}@127.0.0.1:5432/afw`
process.env.R4_CURSOR_SIGNING_KEY ??= (await readFile(resolve(root, "secrets/cursor-signing-key"), "utf8")).trim()
process.chdir(root)
await import("../app/r4-server.mjs")
