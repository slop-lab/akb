create extension if not exists pgcrypto with schema public;

create table permission_atoms (permission text primary key);
insert into permission_atoms values
  ('work.read'), ('work.create'), ('work.update'), ('work.assign'),
  ('space.read'), ('space.manage'), ('project.read'), ('project.manage'),
  ('comment.create'), ('comment.update'), ('relation.manage'),
  ('view.read'), ('view.manage'), ('history.read'), ('acl.manage');

alter table membership_permissions drop constraint membership_permissions_permission_check;
alter table space_permissions drop constraint space_permissions_permission_check;
alter table membership_permissions add foreign key (permission) references permission_atoms;
alter table space_permissions add foreign key (permission) references permission_atoms;

create table workspace_authority_epochs (
  workspace_id text primary key references workspaces (id) on delete cascade,
  epoch bigint not null default 1 check (epoch > 0)
);
insert into workspace_authority_epochs (workspace_id) select id from workspaces;

create function stable_space_entity_id(workspace_id text, space_id text)
returns text language sql immutable strict as $$
  select 'space:' || encode(public.digest(convert_to(length(workspace_id)::text || ':' || workspace_id || space_id, 'utf8'), 'sha256'), 'hex')
$$;

create table entities (
  id text primary key,
  workspace_id text not null references workspaces (id),
  kind text not null,
  scope_space_id text,
  current_revision bigint not null check (current_revision > 0),
  lifecycle text not null default 'active' check (lifecycle in ('active', 'archived', 'deleted')),
  created_by text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  archived_at timestamptz,
  deleted_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, scope_space_id) references spaces (workspace_id, id),
  foreign key (workspace_id, created_by) references principals (workspace_id, id),
  check (lifecycle <> 'archived' or archived_at is not null),
  check (lifecycle <> 'deleted' or deleted_at is not null)
);
create index entities_workspace_kind_updated_idx on entities (workspace_id, kind, updated_at, id);
create index entities_scope_idx on entities (workspace_id, scope_space_id, kind, id);

create table entity_revisions (
  entity_id text not null references entities (id),
  revision bigint not null check (revision > 0),
  schema_version text not null,
  canonical_snapshot jsonb not null,
  actor_id text,
  cause_event_id text,
  created_at timestamptz not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  primary key (entity_id, revision)
);
create table entity_acl_policies (
  entity_id text primary key references entities (id) on delete cascade,
  mode text not null default 'inherit' check (mode in ('inherit', 'restricted'))
);
create table entity_acl_allowances (
  entity_id text not null references entity_acl_policies (entity_id) on delete cascade,
  principal_id text not null,
  permission text not null references permission_atoms,
  created_at timestamptz not null default clock_timestamp(),
  primary key (entity_id, principal_id, permission)
);

insert into entities
  (id, workspace_id, kind, scope_space_id, current_revision, created_by, created_at, updated_at)
select w.id, w.workspace_id, 'work_item', w.space_id, w.revision, p.id, w.created_at, w.updated_at
from work_items w join workspaces ws on ws.id = w.workspace_id
left join principals p on p.workspace_id = w.workspace_id and p.id = (
  select d.actor_id from domain_events d where d.subject_id = w.id order by d.sequence limit 1
);
insert into entities (id, workspace_id, kind, scope_space_id, current_revision, created_at, updated_at)
select stable_space_entity_id(s.workspace_id, s.id), s.workspace_id, 'space', s.id, 1, s.created_at, s.updated_at
from spaces s;
insert into entity_acl_policies select id, 'inherit' from entities;

insert into entity_revisions
  (entity_id, revision, schema_version, canonical_snapshot, actor_id, created_at, digest)
select r.work_item_id, r.revision, 'work-item.legacy.v1', snapshot.value, p.id, r.updated_at,
  encode(public.digest(convert_to(snapshot.value::text, 'utf8'), 'sha256'), 'hex')
from work_item_revisions r join entities e on e.id = r.work_item_id
cross join lateral (select jsonb_build_object(
  'id', r.work_item_id, 'workspaceId', r.workspace_id, 'spaceId', r.space_id,
  'title', r.title, 'state', r.state, 'accountableOwnerId', r.accountable_owner_id,
  'revision', r.revision, 'createdAt', r.created_at, 'updatedAt', r.updated_at
) value) snapshot
left join domain_events d on d.subject_id = r.work_item_id and d.subject_revision = r.revision
left join principals p on p.workspace_id = r.workspace_id and p.id = d.actor_id;
insert into entity_revisions
  (entity_id, revision, schema_version, canonical_snapshot, created_at, digest)
select stable_space_entity_id(s.workspace_id, s.id), 1, 'space.legacy.v1', snapshot.value, s.created_at,
  encode(public.digest(convert_to(snapshot.value::text, 'utf8'), 'sha256'), 'hex')
from spaces s cross join lateral (select jsonb_build_object(
  'id', s.id, 'workspaceId', s.workspace_id, 'name', s.name, 'visibility', s.visibility,
  'createdAt', s.created_at, 'updatedAt', s.updated_at
) value) snapshot;

create function reject_entity_scope_mutation() returns trigger language plpgsql as $$
begin
  if old.workspace_id is distinct from new.workspace_id or old.scope_space_id is distinct from new.scope_space_id
  then raise exception 'entity scope is immutable'; end if;
  return new;
end $$;
create trigger entities_scope_immutable before update on entities
  for each row execute function reject_entity_scope_mutation();
create function reject_immutable_record() returns trigger language plpgsql as $$
begin raise exception 'canonical record is immutable'; end $$;
create trigger entity_revisions_immutable before update or delete on entity_revisions
  for each row execute function reject_immutable_record();

create function bump_workspace_authority_epoch() returns trigger language plpgsql as $$
declare workspace text := coalesce(new.workspace_id, old.workspace_id);
begin
  insert into workspace_authority_epochs values (workspace, 1)
  on conflict (workspace_id) do update set epoch = workspace_authority_epochs.epoch + 1;
  return coalesce(new, old);
end $$;
create function bump_entity_authority_epoch() returns trigger language plpgsql as $$
declare workspace text;
begin
  if tg_op = 'INSERT' and not exists (
    select 1 from entity_revisions where entity_id = new.entity_id
  ) then return new; end if;
  select workspace_id into workspace from entities where id = coalesce(new.entity_id, old.entity_id);
  update workspace_authority_epochs set epoch = epoch + 1 where workspace_id = workspace;
  return coalesce(new, old);
end $$;
create trigger membership_epoch after insert or update or delete on workspace_memberships
  for each row execute function bump_workspace_authority_epoch();
create trigger membership_permission_epoch after insert or update or delete on membership_permissions
  for each row execute function bump_workspace_authority_epoch();
create trigger space_visibility_epoch after update of visibility on spaces
  for each row execute function bump_workspace_authority_epoch();
create trigger space_permission_epoch after insert or update or delete on space_permissions
  for each row execute function bump_workspace_authority_epoch();
create trigger entity_policy_epoch after insert or update or delete on entity_acl_policies
  for each row execute function bump_entity_authority_epoch();
create trigger entity_allowance_epoch after insert or update or delete on entity_acl_allowances
  for each row execute function bump_entity_authority_epoch();

create function entity_access_allowed(target_workspace text, target_entity text,
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
