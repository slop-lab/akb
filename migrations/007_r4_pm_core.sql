create function stable_r4_entity_id(kind text, workspace_id text, local_id text)
returns text language sql immutable strict as $$
  select kind || ':' || encode(public.digest(convert_to(length(workspace_id)::text || ':' || workspace_id || local_id, 'utf8'),'sha256'),'hex')
$$;
create table space_details (
  workspace_id text not null, space_id text not null,
  space_key text not null check (space_key ~ '^[A-Z0-9]{2,10}$'), icon text,
  description text not null default '', lead_id text,
  primary key (workspace_id, space_id), unique (workspace_id, space_key),
  foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, lead_id) references principals (workspace_id, id)
);
create table space_work_sequences (
  workspace_id text not null, space_id text not null,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  primary key (workspace_id, space_id), foreign key (workspace_id, space_id) references spaces
);
create table workflows (
  id text primary key references entities, workspace_id text not null, space_id text not null,
  name text not null, active boolean not null default true,
  transition_mode text not null default 'any_state_in_workflow' check (transition_mode = 'any_state_in_workflow'),
  revision bigint not null check (revision > 0), unique (workspace_id, space_id, id),
  foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create unique index workflows_one_active_per_space on workflows (workspace_id, space_id) where active;
create table workflow_states (
  id text primary key references entities, workflow_id text not null references workflows,
  workspace_id text not null, space_id text not null, name text not null,
  category text not null check (category in ('backlog','unstarted','started','completed','canceled')),
  color text not null, position integer not null check (position >= 0),
  is_default boolean not null default false, active boolean not null default true,
  revision bigint not null check (revision > 0), unique (workflow_id, position),
  unique (workspace_id, space_id, id),
  foreign key (workspace_id, space_id, workflow_id) references workflows (workspace_id, space_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create unique index workflow_states_one_default on workflow_states (workflow_id) where active and is_default;
create function enforce_workflow_state() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.category is distinct from new.category then
    raise exception 'state category is immutable';
  end if;
  if new.active and (select count(*) from workflow_states
    where workflow_id = new.workflow_id and active and id <> new.id) >= 20 then
    raise exception 'workflow has at most 20 active states';
  end if;
  if tg_op = 'UPDATE' and old.active and not new.active and not exists (
    select 1 from workflow_states where workflow_id = old.workflow_id and id <> old.id
      and active and category = old.category
  ) then raise exception 'workflow must retain an active state in every canonical category'; end if;
  return new;
end $$;
create trigger workflow_state_invariants before insert or update on workflow_states
  for each row execute function enforce_workflow_state();

create table projects (
  id text primary key references entities, workspace_id text not null references workspaces,
  name text not null, slug text not null, summary text not null default '', owner_id text not null,
  lead_ids text[] not null default '{}', state text not null check (state in ('planned','active','paused','completed','canceled')),
  health text not null check (health in ('on_track','at_risk','off_track')),
  priority text not null check (priority in ('none','low','medium','high','urgent')),
  start_date date, target_date date, completed_at timestamptz, archived_at timestamptz,
  revision bigint not null check (revision > 0), created_at timestamptz not null, updated_at timestamptz not null,
  unique (workspace_id, id), foreign key (workspace_id, owner_id) references principals (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create unique index projects_workspace_slug on projects (workspace_id, lower(slug));
create table project_spaces (
  project_id text not null references projects, workspace_id text not null, space_id text not null,
  primary key (project_id, space_id), foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, project_id) references projects (workspace_id, id)
);
create table work_item_pm (
  work_item_id text primary key references work_items, workspace_id text not null, space_id text not null,
  sequence bigint not null check (sequence > 0), workflow_state_id text not null,
  project_id text, description text not null default '', item_type text not null default 'Task',
  priority text not null default 'none' check (priority in ('none','low','medium','high','urgent')),
  start_date date, due_date date, completed_at timestamptz, archived_at timestamptz,
  unique (workspace_id, space_id, sequence), foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, space_id, workflow_state_id) references workflow_states (workspace_id, space_id, id)
  ,foreign key (workspace_id, project_id) references projects (workspace_id, id)
);
create table labels (
  id text primary key references entities, workspace_id text not null, space_id text not null,
  name text not null, color text not null, archived_at timestamptz,
  revision bigint not null check (revision > 0), unique (workspace_id, space_id, name),
  foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create table work_item_labels (
  work_item_id text not null references work_item_pm, label_id text not null references labels,
  primary key (work_item_id, label_id)
);
create function enforce_label_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from work_item_labels where work_item_id = new.work_item_id) >= 50
  then raise exception 'work item has at most 50 labels'; end if;
  return new;
end $$;
create trigger work_item_label_limit before insert on work_item_labels
  for each row execute function enforce_label_limit();

create table relations (
  id text primary key references entities, workspace_id text not null references workspaces,
  from_entity_id text not null references entities, relation_type text not null check (relation_type in
    ('parent_of','blocks','related_to','duplicates','implements','verifies','supports','contradicts','supersedes','generated_by')),
  to_entity_id text not null references entities, revision bigint not null check (revision > 0),
  asserted_by text, valid_from timestamptz not null, valid_to timestamptz,
  check (from_entity_id <> to_entity_id),
  check (relation_type <> 'related_to' or from_entity_id < to_entity_id),
  unique (from_entity_id, relation_type, to_entity_id),
  foreign key (workspace_id, from_entity_id) references entities (workspace_id, id),
  foreign key (workspace_id, to_entity_id) references entities (workspace_id, id)
);
create unique index relations_one_active_parent on relations (to_entity_id)
  where relation_type = 'parent_of' and valid_to is null;
create function reject_parent_cycle() returns trigger language plpgsql as $$
begin
  if new.relation_type = 'parent_of' and new.valid_to is null and exists (
    with recursive descendants(id) as (select new.to_entity_id union
      select r.to_entity_id from relations r join descendants d on r.from_entity_id = d.id
      where r.relation_type = 'parent_of' and r.valid_to is null)
    select 1 from descendants where id = new.from_entity_id
  ) then raise exception 'parent relation cycle'; end if;
  return new;
end $$;
create trigger relations_parent_cycle before insert or update on relations
  for each row execute function reject_parent_cycle();
create table threads (
  id text primary key references entities, workspace_id text not null references workspaces,
  subject_entity_id text not null references entities, revision bigint not null check (revision > 0),
  unique (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id),
  foreign key (workspace_id, subject_entity_id) references entities (workspace_id, id)
);
create table comments (
  id text primary key references entities, workspace_id text not null references workspaces,
  thread_id text not null references threads, author_id text not null,
  body text not null check (length(body) between 1 and 20000), revision bigint not null check (revision > 0),
  created_at timestamptz not null, updated_at timestamptz not null, archived_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id),
  foreign key (workspace_id, thread_id) references threads (workspace_id, id),
  foreign key (workspace_id, author_id) references principals (workspace_id, id)
);
create table saved_views (
  id text primary key references entities, workspace_id text not null references workspaces,
  owner_id text not null, name text not null,
  access text not null check (access in ('private','space','workspace')), scope_space_id text,
  definition jsonb not null, revision bigint not null check (revision > 0), archived_at timestamptz,
  foreign key (workspace_id, id) references entities (workspace_id, id),
  foreign key (workspace_id, owner_id) references principals (workspace_id, id),
  foreign key (workspace_id, scope_space_id) references spaces (workspace_id, id)
);
create table search_documents (
  entity_id text primary key references entities, workspace_id text not null references workspaces,
  kind text not null check (kind in ('project','work_item','comment')),
  source_revision bigint not null check (source_revision > 0), document tsvector not null
);
create index search_documents_fts on search_documents using gin (document);
create function reject_space_key_mutation() returns trigger language plpgsql as $$
begin
  if old.space_key is distinct from new.space_key then raise exception 'space key is immutable'; end if;
  return new;
end $$;
create trigger space_key_immutable before update on space_details
  for each row execute function reject_space_key_mutation();

create function initialize_r4_space(target_workspace text, target_space text, target_key text,
  target_actor text, include_space_entity boolean) returns void language plpgsql as $$
declare workflow_id text := stable_r4_entity_id('workflow',target_workspace,target_space);
  state record; state_id text; space_entity text := stable_space_entity_id(target_workspace,target_space);
begin
  if include_space_entity then
    insert into entities (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
      values (space_entity,target_workspace,'space',target_space,1,target_actor,clock_timestamp(),clock_timestamp());
    insert into entity_acl_policies values (space_entity,'inherit');
    insert into entity_revisions (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
      select space_entity,1,'space.r4.v1',value,target_actor,clock_timestamp(),
        encode(public.digest(convert_to(value::text,'utf8'),'sha256'),'hex')
      from (select jsonb_build_object('id',target_space,'workspaceId',target_workspace,'key',target_key) value) s;
  end if;
  insert into space_details (workspace_id,space_id,space_key) values (target_workspace,target_space,target_key);
  insert into space_work_sequences values (target_workspace,target_space,0);
  insert into entities (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values (workflow_id,target_workspace,'workflow',target_space,1,target_actor,clock_timestamp(),clock_timestamp());
  insert into entity_acl_policies values (workflow_id,'inherit');
  insert into workflows values (workflow_id,target_workspace,target_space,'Default',true,'any_state_in_workflow',1);
  insert into entity_revisions (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select workflow_id,1,'workflow.r4.v1',value,target_actor,clock_timestamp(),
      encode(public.digest(convert_to(value::text,'utf8'),'sha256'),'hex')
    from (select jsonb_build_object('id',workflow_id,'name','Default','active',true) value) w;
  for state in select * from (values ('backlog','Backlog','#6B7280',0),
    ('unstarted','Unstarted','#94A3B8',1),('started','Started','#3B82F6',2),
    ('completed','Completed','#22C55E',3),('canceled','Canceled','#EF4444',4))
    s(category,name,color,position) loop
    state_id := stable_r4_entity_id('state',target_workspace,target_space || ':' || state.category);
    insert into entities (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
      values (state_id,target_workspace,'workflow_state',target_space,1,target_actor,clock_timestamp(),clock_timestamp());
    insert into entity_acl_policies values (state_id,'inherit');
    insert into workflow_states values (state_id,workflow_id,target_workspace,target_space,state.name,
      state.category,state.color,state.position,state.category = 'unstarted',true,1);
    insert into entity_revisions (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
      select state_id,1,'workflow-state.r4.v1',value,target_actor,clock_timestamp(),
        encode(public.digest(convert_to(value::text,'utf8'),'sha256'),'hex')
      from (select jsonb_build_object('id',state_id,'workflowId',workflow_id,'name',state.name,
        'category',state.category,'color',state.color,'position',state.position,
        'isDefault',state.category = 'unstarted','active',true) value) v;
  end loop;
end $$;

create function synchronize_scoped_work_item_pm() returns trigger language plpgsql as $$
declare next_sequence bigint;
begin
  if new.space_id is null then return new; end if;
  if tg_op = 'INSERT' then
    update space_work_sequences set last_sequence = last_sequence + 1
      where workspace_id = new.workspace_id and space_id = new.space_id
      returning last_sequence into strict next_sequence;
    insert into work_item_pm
      (work_item_id,workspace_id,space_id,sequence,workflow_state_id,completed_at)
      values (new.id,new.workspace_id,new.space_id,next_sequence,
        stable_r4_entity_id('state',new.workspace_id,new.space_id || ':' || new.state),
        case when new.state = 'completed' then new.updated_at else null end);
  elsif old.state is distinct from new.state then
    update work_item_pm set
      workflow_state_id=stable_r4_entity_id('state',new.workspace_id,new.space_id || ':' || new.state),
      completed_at=case when new.state = 'completed' then new.updated_at else null end
      where work_item_id=new.id;
  end if;
  return new;
end $$;
create trigger work_items_sync_pm after insert or update of state on work_items
  for each row execute function synchronize_scoped_work_item_pm();

insert into space_details (workspace_id, space_id, space_key)
select workspace_id, id, 'S' || lpad(row_number() over (partition by workspace_id order by id)::text, 9, '0')
from spaces;
insert into space_work_sequences (workspace_id, space_id, last_sequence)
select s.workspace_id, s.id, count(w.id) from spaces s left join work_items w
  on w.workspace_id = s.workspace_id and w.space_id = s.id group by s.workspace_id, s.id;
insert into entities (id, workspace_id, kind, scope_space_id, current_revision, created_at, updated_at)
select stable_r4_entity_id('workflow',s.workspace_id,s.id), s.workspace_id, 'workflow', s.id, 1, s.created_at, s.updated_at
from spaces s;
insert into entity_acl_policies select id, 'inherit' from entities e where e.kind = 'workflow'
on conflict do nothing;
insert into workflows
select stable_r4_entity_id('workflow',s.workspace_id,s.id), s.workspace_id, s.id, 'Default', true,
  'any_state_in_workflow', 1 from spaces s;
insert into entities (id, workspace_id, kind, scope_space_id, current_revision, created_at, updated_at)
select stable_r4_entity_id('state',s.workspace_id,s.id || ':' || category), s.workspace_id,
  'workflow_state', s.id, 1, s.created_at, s.updated_at from spaces s cross join unnest(
  array['backlog','unstarted','started','completed','canceled']) category;
insert into entity_acl_policies select id, 'inherit' from entities e where e.kind = 'workflow_state';
insert into workflow_states
select stable_r4_entity_id('state',s.workspace_id,s.id || ':' || state.category),
  stable_r4_entity_id('workflow',s.workspace_id,s.id), s.workspace_id, s.id, state.name,
  state.category, state.color, state.position, state.category = 'unstarted', true, 1
from spaces s cross join (values ('backlog','Backlog','#6B7280',0),('unstarted','Unstarted','#94A3B8',1),
  ('started','Started','#3B82F6',2),('completed','Completed','#22C55E',3),
  ('canceled','Canceled','#EF4444',4)) state(category,name,color,position);
insert into work_item_pm (work_item_id, workspace_id, space_id, sequence, workflow_state_id)
select w.id, w.workspace_id, w.space_id,
  row_number() over (partition by w.workspace_id,w.space_id order by w.created_at,w.id),
  stable_r4_entity_id('state',w.workspace_id,w.space_id || ':' || w.state)
from work_items w where w.space_id is not null;
