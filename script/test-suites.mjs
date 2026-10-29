// @ts-check
import { globSync } from "node:fs"
import { spawnSync } from "node:child_process"

/** @typedef {{compiled?: boolean, database?: boolean, serial?: boolean, files: readonly string[]}} Suite */
/** @type {Readonly<Record<string, Suite>>} */
const suites = {
  unit: {
    compiled: true,
    files: [
      "browser-uuid",
      "input-contract",
      "outbox-unit",
      "owned-snapshot",
      "r4-contracts",
      "r4-import-workflow-validation",
      "r4-native-runtime",
      "r4-route-inventory",
      "space-id",
      "store-limits",
      "utc-datetime",
      "work-item-audit-capacity",
      "work-item-hardening",
      "work-item-patch-nonmutation",
      "work-item-store",
      "work-query",
    ],
  },
  integration: {
    compiled: true,
    files: [
      "health",
      "http-hardening",
      "openapi-contract",
      "openapi-examples",
      "openapi-operations",
      "path-segment-http",
      "request-boundary",
      "source-import",
      "store-port",
      "web-assets",
      "work-item-concurrency-http",
      "work-item-http",
      "work-item-list-restart",
    ],
  },
  features: {
    files: [
      "package-name-policy",
      "project-kb-package",
      "content-domain",
      "content-workflow",
      "runtime-contracts",
      "testsautomation-schedule",
      "testsautomation-security",
      "operations-config",
      "operations-security",
      "knowledge-work-hub-contract",
      "setup-blocks-fresh-clone.test.mjs",
      "timestamp-contract",
    ],
  },
  "features-postgres": {
    database: true,
    serial: true,
    files: [
      "project-kb-postgres",
      "content-postgres",
      "content-workflow-postgres",
      "content-workflow-permissions-postgres",
      "content-generated-page-replay-postgres",
      "postgres/postgres-document-agent-tools",
      "postgres/postgres-command-unit-of-work",
      "postgres/postgres-feature-*",
      "postgres/postgres-planning-*",
      "postgres/postgres-runtime-*",
      "postgres/postgres-retrieval-*",
      "postgres/postgres-knowledge-*",
      "testsautomation-r8-http",
      "testsautomation-analytics",
      "testsautomation-recurrence-isolation",
    ],
  },
  postgres: {
    compiled: true,
    database: true,
    serial: true,
    files: [
      "postgres/postgres-migrate",
      "postgres/postgres-r4-foundation",
      "postgres/postgres-r4-scale",
      "postgres/postgres-identity",
      "postgres/postgres-store",
      "postgres/postgres-authorized-store",
      "postgres/postgres-authorization-races",
      "postgres/postgres-http",
      "postgres/postgres-outbox",
      "postgres/postgres-outbox-atomicity",
      "postgres/postgres-outbox-locking",
      "postgres/postgres-replay",
      "postgres/postgres-space-acl",
      "postgres/postgres-space-acl-races",
      "postgres/postgres-space-http",
      "postgres/postgres-space-admin-cli",
    ],
  },
  r4: { compiled: true, database: true, serial: true, files: ["postgres/postgres-r4-*"] },
  commands: {
    compiled: true,
    database: true,
    serial: true,
    files: [
      "postgres/postgres-r4-commands",
      "postgres/postgres-r4-command-lifecycle",
      "postgres/postgres-r4-command-invariants",
      "postgres/postgres-r4-command-advanced-invariants",
      "postgres/postgres-r4-command-atomicity",
      "postgres/postgres-r4-import-dispatcher",
    ],
  },
  backup: {
    compiled: true,
    database: true,
    serial: true,
    files: [
      "backup-unit",
      "postgres/postgres-backup-catalog",
      "postgres/postgres-backup-legacy",
      "postgres/postgres-backup-profile-009",
      "postgres/postgres-backup",
      "postgres/postgres-r8-operations",
    ],
  },
}

const name = process.argv[2] ?? ""
const suite = suites[name]
if (suite === undefined || process.argv.length !== 3) {
  throw new TypeError(`Usage: node script/test-suites.mjs <${Object.keys(suites).join("|")}>`)
}
if (suite.database && !process.env.DATABASE_URL) {
  process.stderr.write("DATABASE_URL is required for this test suite.\n")
  process.exit(2)
}
const directory = suite.compiled ? "build/test" : "test"
const files = new Set()
for (const file of suite.files) {
  const pattern = `${directory}/${file.endsWith(".mjs") ? file : `${file}.test.${suite.compiled ? "js" : "ts"}`}`
  const matches = globSync(pattern)
  if (matches.length === 0) throw new TypeError(`Test pattern matched no files: ${pattern}`)
  for (const match of matches) files.add(match)
}
const result = spawnSync(
  process.execPath,
  ["--test", ...(suite.serial ? ["--test-concurrency=1"] : []), ...files],
  { stdio: "inherit" },
)
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
