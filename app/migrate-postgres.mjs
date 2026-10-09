import { createPostgresClient, databaseUrlFromEnvironment } from "../src/postgres/client.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"

const sql = createPostgresClient(databaseUrlFromEnvironment(process.env))
try {
  await migrateDatabase(sql)
} finally {
  await sql.end({ timeout: 5 })
}
