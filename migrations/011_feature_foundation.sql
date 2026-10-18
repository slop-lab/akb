insert into permission_atoms (permission) values
  ('content.read'), ('content.manage'), ('run.delegate'), ('run.inspect'),
  ('knowledge.read'), ('knowledge.propose'), ('knowledge.accept'),
  ('review.read'), ('review.decide'), ('automation.read'), ('automation.manage'),
  ('admin.integrations');

create table entity_kind_registry (
  kind text primary key,
  read_permission text not null references permission_atoms (permission)
);
insert into entity_kind_registry (kind, read_permission) values
  ('work_item', 'work.read'), ('comment', 'work.read'), ('thread', 'work.read'),
  ('relation', 'work.read'), ('project', 'project.read'), ('space', 'space.read'),
  ('workflow', 'space.read'), ('workflow_state', 'space.read'), ('label', 'space.read'),
  ('saved_view', 'view.read');
alter table entities add constraint entities_kind_registered
  foreign key (kind) references entity_kind_registry (kind);

create table entity_access_dependencies (
  entity_id text not null references entities (id) on delete cascade,
  required_entity_id text not null references entities (id) on delete cascade,
  primary key (entity_id, required_entity_id),
  check (entity_id <> required_entity_id)
);
create index entity_access_dependencies_required_idx
  on entity_access_dependencies (required_entity_id, entity_id);

create function validate_entity_access_dependency() returns trigger language plpgsql as $$
declare entity_workspace text; required_workspace text;
begin
  select workspace_id into strict entity_workspace from entities where id = new.entity_id;
  select workspace_id into strict required_workspace from entities where id = new.required_entity_id;
  if entity_workspace <> required_workspace then
    raise exception 'entity access dependency must remain in one workspace';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'entity_access_dependency:' || entity_workspace, 0));
  if exists (
    with recursive required_entities(id) as (
      select new.required_entity_id
      union
      select dependency.required_entity_id
      from entity_access_dependencies dependency
      join required_entities prior on prior.id = dependency.entity_id
    )
    select 1 from required_entities where id = new.entity_id
  ) then
    raise exception 'entity access dependency cycle';
  end if;
  return new;
end $$;
create trigger entity_access_dependency_validate
  before insert or update on entity_access_dependencies
  for each row execute function validate_entity_access_dependency();
create function bump_entity_dependency_epoch() returns trigger language plpgsql as $$
declare workspace text;
begin
  select workspace_id into workspace from entities where id = coalesce(new.entity_id, old.entity_id);
  update workspace_authority_epochs set epoch = epoch + 1 where workspace_id = workspace;
  return coalesce(new, old);
end $$;
create trigger entity_access_dependency_epoch
  after insert or update or delete on entity_access_dependencies
  for each row execute function bump_entity_dependency_epoch();

create function entity_direct_access_allowed(target_workspace text, target_entity text,
  target_principal text, target_permission text) returns boolean language sql stable as $$
  select exists (
    select 1 from entities e
    join workspace_memberships m on m.workspace_id = e.workspace_id and m.principal_id = target_principal
    join principals p on p.workspace_id = m.workspace_id and p.id = m.principal_id
    where e.workspace_id = target_workspace and e.id = target_entity
      and m.status = 'active' and p.status = 'active'
      and exists (select 1 from membership_permissions g where g.workspace_id = e.workspace_id
        and g.principal_id = target_principal and g.permission = target_permission)
      and (e.scope_space_id is null or exists (select 1 from spaces s
        where s.workspace_id = e.workspace_id and s.id = e.scope_space_id
          and (s.visibility = 'public' or exists (select 1 from space_permissions sp
            where sp.workspace_id = s.workspace_id and sp.space_id = s.id
              and sp.principal_id = target_principal and sp.permission = target_permission))))
      and exists (select 1 from entity_acl_policies ap where ap.entity_id = e.id
        and (ap.mode = 'inherit' or exists (select 1 from entity_acl_allowances aa
          where aa.entity_id = e.id and aa.principal_id = target_principal
            and aa.permission = target_permission)))
  )
$$;

create or replace function entity_access_allowed(target_workspace text, target_entity text,
  target_principal text, target_permission text) returns boolean language sql stable as $$
  with recursive required_entities(id, permission) as (
    select target_entity, target_permission
    union
    select dependency.required_entity_id, registry.read_permission
    from required_entities prior
    join entity_access_dependencies dependency on dependency.entity_id = prior.id
    join entities required on required.id = dependency.required_entity_id
      and required.workspace_id = target_workspace
    join entity_kind_registry registry on registry.kind = required.kind
  )
  select exists (select 1 from required_entities where id = target_entity)
    and not exists (
      select 1 from required_entities required
      where not entity_direct_access_allowed(target_workspace, required.id,
        target_principal, required.permission)
    )
$$;

alter table entity_events_v1 add unique (workspace_id, id);
create table generic_command_events (
  workspace_id text not null,
  idempotency_key text not null,
  ordinal integer not null check (ordinal >= 0),
  event_id text not null,
  primary key (workspace_id, idempotency_key, ordinal),
  unique (workspace_id, event_id),
  foreign key (workspace_id, idempotency_key)
    references generic_command_idempotency (workspace_id, idempotency_key) on delete cascade,
  foreign key (workspace_id, event_id)
    references entity_events_v1 (workspace_id, id)
);
