import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { HumanReadService } from "../src/human-query/read-service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture
let reads: HumanReadService

beforeEach(async () => {
  fixture = await createSearchFixture()
  reads = new HumanReadService(fixture.database.sql)
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "project.read", "history.read"],
  })
  const sql = fixture.database.sql
  await sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at) values
    ('project-a','search','project',1,'owner',now(),now()),
    ('project-b','search','project',1,'owner',now(),now()),
    ('thread','search','thread',1,'owner',now(),now()),
    ('comment','search','comment',1,'owner',now(),now()),
    ('relation','search','relation',1,'owner',now(),now())`
  await sql`insert into entity_acl_policies
    select id,'inherit' from entities where workspace_id='search'`
  await sql`insert into projects
    (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at) values
    ('project-a','search','Project A','project-a','owner','active','on_track','none',1,now(),now()),
    ('project-b','search','Project B','project-b','owner','active','on_track','none',1,now(),now())`
  await sql`insert into threads values ('thread','search','project-a',1)`
  await sql`insert into comments values
    ('comment','search','thread','owner','Fixture comment',1,now(),now(),null)`
  await sql`insert into relations
    (id,workspace_id,from_entity_id,relation_type,to_entity_id,revision,asserted_by,valid_from)
    values ('relation','search','project-a','related_to','project-b',1,'owner',now())`
  await sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select e.id,1,'history.fixture.v1',snapshot.value,'owner',now(),
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from entities e cross join lateral (select jsonb_build_object('id',e.id) value) snapshot
    where e.workspace_id='search'`
})

afterEach(async () => fixture.database.close())

test("comment and thread history remain available with subject read authority", async () => {
  const histories = await Promise.all([
    reads.history(fixture.viewer, "comment"),
    reads.history(fixture.viewer, "thread"),
    reads.history(fixture.viewer, "relation"),
  ])

  assert.deepEqual(
    histories.map((history) => history?.length),
    [1, 1, 1],
  )
})

test("comment and thread history require the subject kind's read permission", async () => {
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "history.read"],
  })

  const histories = await Promise.all([
    reads.history(fixture.viewer, "comment"),
    reads.history(fixture.viewer, "thread"),
  ])

  assert.deepEqual(histories, [undefined, undefined])
})

test("comment and thread history require the subject entity ACL", async () => {
  await fixture.database.sql`update entity_acl_policies set mode='restricted'
    where entity_id='project-a'`

  const histories = await Promise.all([
    reads.history(fixture.viewer, "comment"),
    reads.history(fixture.viewer, "thread"),
  ])

  assert.deepEqual(histories, [undefined, undefined])
})

test("comment history requires the containing thread ACL", async () => {
  await fixture.database.sql`update entity_acl_policies set mode='restricted'
    where entity_id='thread'`

  const history = await reads.history(fixture.viewer, "comment")

  assert.equal(history, undefined)
})

for (const endpoint of ["project-a", "project-b"]) {
  test(`relation history requires read authority for endpoint ${endpoint}`, async () => {
    await fixture.database.sql`update entity_acl_policies set mode='restricted'
      where entity_id=${endpoint}`

    const history = await reads.history(fixture.viewer, "relation")

    assert.equal(history, undefined)
  })
}
