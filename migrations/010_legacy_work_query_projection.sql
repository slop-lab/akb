alter table human_query_snapshot_items
  add column legacy_work_pm_projection jsonb;

alter table human_query_snapshot_items
  add constraint human_query_snapshot_items_legacy_work_pm_projection_check
  check (
    legacy_work_pm_projection is null
    or (
      jsonb_typeof(legacy_work_pm_projection) = 'object'
      and legacy_work_pm_projection->>'_schema' = 'legacy-work-pm-query.v1'
    ) is true
  );

delete from human_query_snapshots snapshot
where exists (
  select 1
  from human_query_snapshot_items item
  join entity_revisions revision
    on revision.entity_id = item.entity_id
    and revision.revision = item.source_revision
  where item.snapshot_id = snapshot.id
    and revision.schema_version = 'work-item.legacy.v1'
);
