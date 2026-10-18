import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { automationWorkerConfiguration } from "../app/automation-worker-config.mjs"

test("container image pins Node 24 and runs as a non-root user", async () => {
  // Given / When
  const dockerfile = await readFile("Dockerfile", "utf8")

  // Then
  assert.match(dockerfile, /FROM node:24\.22\.0-/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /FROM postgres:17-/)
})

test("compose keeps network services loopback-only and gates startup on explicit migration", async () => {
  // Given / When
  const compose = await readFile("compose.yaml", "utf8")

  // Then
  assert.match(compose, /127\.0\.0\.1:\$\{AFW_PORT:-3001\}:3001/)
  assert.doesNotMatch(compose, /5432:5432/)
  assert.match(compose, /condition: service_completed_successfully/)
  assert.match(compose, /archive_mode=on/)
  assert.match(compose, /POSTGRES_PASSWORD_FILE/)
  assert.match(compose, /BACKUP_ENCRYPTION_KEY_FILE/)
  assert.match(compose, /automation-worker:/)
  assert.match(compose, /AUTOMATION_BATCH_LIMIT:/)
  assert.match(compose, /condition: service_completed_successfully/)
  const worker = compose.slice(
    compose.indexOf("  automation-worker:"),
    compose.indexOf("  backup:"),
  )
  assert.doesNotMatch(worker, /R4_CURSOR_SIGNING_KEY|BACKUP_ENCRYPTION_KEY|Bearer/)
  assert.match(compose, /archive_command=.*AFW_WAL_ARCHIVE_MIN_FREE_KB/)
  assert.match(compose, /mode: 0400/)
})

test("example environment contains placeholders rather than deployable secrets", async () => {
  // Given / When
  const example = await readFile(".env.example", "utf8")

  // Then
  assert.match(example, /AFW_POSTGRES_PASSWORD_FILE=/)
  assert.match(example, /AFW_BACKUP_KEY_FILE=/)
  assert.match(example, /R4_CURSOR_SIGNING_KEY_FILE=/)
  assert.match(example, /AFW_AUTOMATION_BATCH_LIMIT=/)
  assert.match(example, /AFW_WAL_ARCHIVE_MIN_FREE_KB=/)
  assert.doesNotMatch(example, /postgres:\/\/[^\n]*:[^$<{\n]+@/)
})

test("automation worker configuration rejects unbounded batch and polling values", () => {
  // Given / When / Then
  assert.deepEqual(automationWorkerConfiguration({}), { limit: 100, interval: 5000 })
  assert.throws(
    () => automationWorkerConfiguration({ AUTOMATION_BATCH_LIMIT: "101" }),
    /AUTOMATION_BATCH_LIMIT must be between 1 and 100/,
  )
  assert.throws(
    () => automationWorkerConfiguration({ AUTOMATION_POLL_MS: "0" }),
    /AUTOMATION_POLL_MS must be between 100 and 300000/,
  )
  assert.throws(
    () => automationWorkerConfiguration({ AUTOMATION_POLL_MS: "NaN" }),
    /AUTOMATION_POLL_MS must be an integer/,
  )
})
