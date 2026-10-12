insert into entity_revisions
  (entity_id, revision, schema_version, canonical_snapshot, created_at, digest)
select entity.id, 1, 'workflow.r4.v1', snapshot.value, entity.created_at,
  encode(public.digest(convert_to(snapshot.value::text, 'utf8'), 'sha256'), 'hex')
from spaces space
join entities entity
  on entity.id = stable_r4_entity_id('workflow', space.workspace_id, space.id)
  and entity.workspace_id = space.workspace_id
  and entity.kind = 'workflow'
cross join lateral (select jsonb_build_object(
  'id', stable_r4_entity_id('workflow', space.workspace_id, space.id),
  'name', 'Default',
  'active', true
) value) snapshot
on conflict (entity_id, revision) do nothing;

insert into entity_revisions
  (entity_id, revision, schema_version, canonical_snapshot, created_at, digest)
select entity.id, 1, 'workflow-state.r4.v1', snapshot.value, entity.created_at,
  encode(public.digest(convert_to(snapshot.value::text, 'utf8'), 'sha256'), 'hex')
from spaces space
cross join (values
  ('backlog', 'Backlog', '#6B7280', 0),
  ('unstarted', 'Unstarted', '#94A3B8', 1),
  ('started', 'Started', '#3B82F6', 2),
  ('completed', 'Completed', '#22C55E', 3),
  ('canceled', 'Canceled', '#EF4444', 4)
) state(category, name, color, position)
join entities entity
  on entity.id = stable_r4_entity_id(
    'state', space.workspace_id, space.id || ':' || state.category
  )
  and entity.workspace_id = space.workspace_id
  and entity.kind = 'workflow_state'
cross join lateral (select jsonb_build_object(
  'id', stable_r4_entity_id('state', space.workspace_id, space.id || ':' || state.category),
  'workflowId', stable_r4_entity_id('workflow', space.workspace_id, space.id),
  'name', state.name,
  'category', state.category,
  'color', state.color,
  'position', state.position,
  'isDefault', state.category = 'unstarted',
  'active', true
) value) snapshot
on conflict (entity_id, revision) do nothing;
