import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import type { Sql } from "postgres"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let sql: Sql

before(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  sql = fixture.sql
  await migrateDatabase(sql)
})

after(async () => {
  await fixture.close()
})

test("knowledge migration installs normalized canonical and review storage", async () => {
  // Given
  const expected = [
    "derived_summaries",
    "knowledge_claims",
    "knowledge_decisions",
    "knowledge_evidence",
    "knowledge_experiments",
    "knowledge_objects",
    "knowledge_proposal_relations",
    "knowledge_proposal_sources",
    "knowledge_proposals",
    "knowledge_questions",
    "knowledge_review_evidence",
    "knowledge_review_policies",
    "knowledge_reviews",
    "knowledge_revision_relations",
    "knowledge_revision_sources",
  ]

  // When
  const rows = await sql<{ readonly table_name: string }[]>`select table_name
    from information_schema.tables where table_schema=current_schema()
      and table_name like 'knowledge_%' or table_schema=current_schema()
      and table_name='derived_summaries' order by table_name`

  // Then
  assert.deepEqual(
    rows.map((row) => row.table_name),
    expected,
  )
})

test("knowledge review policy registry is seeded, referenced, and immutable", async () => {
  // Given
  const policies = await sql`select policy_id,revision::integer,policy_type
    from knowledge_review_policies order by policy_id,revision`
  const foreignKeys = await sql<{ readonly count: number }[]>`select count(*)::integer count
    from pg_constraint where conrelid='knowledge_reviews'::regclass
      and confrelid='knowledge_review_policies'::regclass and contype='f'`

  // When / Then
  assert.deepEqual(
    [...policies],
    [{ policy_id: "human-review", revision: 1, policy_type: "human_approval" }],
  )
  assert.deepEqual([...foreignKeys], [{ count: 1 }])
  await assert.rejects(sql`update knowledge_review_policies set display_name='Changed'`)
})

test("knowledge entity kinds use the dedicated read permissions", async () => {
  // Given / When
  const rows = await sql<{ readonly kind: string; readonly read_permission: string }[]>`
    select kind,read_permission from entity_kind_registry
    where kind in ('knowledge_object','knowledge_proposal','knowledge_review') order by kind`

  // Then
  assert.deepEqual(
    [...rows],
    [
      { kind: "knowledge_object", read_permission: "knowledge.read" },
      { kind: "knowledge_proposal", read_permission: "review.read" },
      { kind: "knowledge_review", read_permission: "review.read" },
    ],
  )
})
