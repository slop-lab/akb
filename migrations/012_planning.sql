insert into entity_kind_registry (kind, read_permission) values
  ('cycle','work.read'), ('milestone','project.read'), ('module','project.read'),
  ('project_update','project.read'), ('planning_template','work.read'),
  ('template_application','work.read'), ('notification_settings','work.read');

create table cycles (
  id text primary key references entities,
  workspace_id text not null,
  space_id text not null,
  sequence bigint not null check (sequence > 0),
  name text not null check (length(name) between 1 and 200),
  start_date date not null,
  end_date date not null,
  status text not null check (status in ('upcoming','active','completed','archived')),
  goal text not null default '' check (length(goal) <= 10000),
  capacity_hint numeric check (capacity_hint is null or capacity_hint >= 0),
  rollover_policy text not null check (rollover_policy in ('automatic','reviewed')),
  revision bigint not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, space_id, sequence),
  unique (workspace_id, id),
  foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, id) references entities (workspace_id, id),
  check (start_date <= end_date)
);
create unique index cycles_one_active_per_space on cycles (workspace_id, space_id)
  where status = 'active';

create table milestones (
  id text primary key references entities,
  workspace_id text not null,
  project_id text not null,
  position integer not null check (position >= 0),
  name text not null check (length(name) between 1 and 200),
  description text not null default '' check (length(description) <= 20000),
  target_date date,
  revision bigint not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (project_id, position),
  unique (workspace_id, project_id, id),
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id)
);

create table modules (
  id text primary key references entities,
  workspace_id text not null,
  project_id text not null,
  name text not null check (length(name) between 1 and 200),
  description text not null default '' check (length(description) <= 20000),
  owner_id text,
  start_date date,
  target_date date,
  status text not null check (status in ('planned','active','completed','canceled')),
  revision bigint not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, project_id, id),
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, owner_id) references principals (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id),
  check (start_date is null or target_date is null or start_date <= target_date)
);

create table work_item_planning (
  work_item_id text primary key references work_item_pm,
  workspace_id text not null,
  space_id text not null,
  project_id text,
  estimate numeric check (estimate is null or estimate > 0),
  cycle_id text,
  milestone_id text,
  revision bigint not null check (revision > 0),
  updated_at timestamptz not null,
  unique (workspace_id, work_item_id),
  foreign key (workspace_id, space_id) references spaces,
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, cycle_id) references cycles (workspace_id, id),
  foreign key (workspace_id, project_id, milestone_id)
    references milestones (workspace_id, project_id, id)
);

create table work_item_modules (
  workspace_id text not null,
  work_item_id text not null references work_item_planning,
  project_id text not null,
  module_id text not null,
  primary key (work_item_id, module_id),
  foreign key (workspace_id, work_item_id) references work_item_planning (workspace_id, work_item_id),
  foreign key (workspace_id, project_id, module_id) references modules (workspace_id, project_id, id)
);

create function enforce_work_planning_scope() returns trigger language plpgsql as $$
declare actual_space text; actual_project text; cycle_space text;
begin
  select space_id, project_id into strict actual_space, actual_project from work_item_pm
    where work_item_id = new.work_item_id;
  if new.workspace_id is distinct from (select workspace_id from work_item_pm where work_item_id=new.work_item_id)
    or new.space_id is distinct from actual_space or new.project_id is distinct from actual_project
  then raise exception 'work planning scope mismatch'; end if;
  if new.cycle_id is not null then
    select space_id into strict cycle_space from cycles where id=new.cycle_id;
    if cycle_space is distinct from actual_space then raise exception 'cycle must belong to work space'; end if;
  end if;
  return new;
end $$;
create trigger work_planning_scope before insert or update on work_item_planning
  for each row execute function enforce_work_planning_scope();

create table cycle_scope_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  cycle_id text not null,
  work_item_id text not null,
  change_kind text not null check (change_kind in ('committed','added','removed','carried_over')),
  occurred_at timestamptz not null,
  actor_id text,
  unique (cycle_id, work_item_id, change_kind, occurred_at),
  foreign key (workspace_id, cycle_id) references cycles (workspace_id, id),
  foreign key (workspace_id, work_item_id) references work_item_planning (workspace_id, work_item_id),
  foreign key (workspace_id, actor_id) references principals (workspace_id, id)
);

create table cycle_metric_snapshots (
  cycle_id text not null references cycles,
  revision bigint not null check (revision > 0),
  captured_at timestamptz not null,
  committed_count integer not null check (committed_count >= 0),
  added_count integer not null check (added_count >= 0),
  removed_count integer not null check (removed_count >= 0),
  completed_count integer not null check (completed_count >= 0),
  committed_estimate numeric not null check (committed_estimate >= 0),
  completed_estimate numeric not null check (completed_estimate >= 0),
  carry_over_count integer not null check (carry_over_count >= 0),
  average_lead_seconds numeric,
  blocked_seconds numeric not null default 0 check (blocked_seconds >= 0),
  primary key (cycle_id, revision)
);
create trigger cycle_metric_snapshots_immutable before update or delete on cycle_metric_snapshots
  for each row execute function reject_immutable_record();

create table project_updates (
  id text primary key references entities,
  workspace_id text not null,
  project_id text not null,
  health text not null check (health in ('on_track','at_risk','off_track')),
  body text not null check (length(body) between 1 and 50000),
  author_id text not null,
  published_at timestamptz not null,
  total numeric not null check (total >= 0),
  completed numeric not null check (completed >= 0),
  estimated numeric not null check (estimated >= 0),
  blocked integer not null check (blocked >= 0),
  metric_mode text not null check (metric_mode in ('estimate','count')),
  revision bigint not null check (revision = 1),
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, author_id) references principals (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create trigger project_updates_immutable before update or delete on project_updates
  for each row execute function reject_immutable_record();

create table planning_templates (
  id text primary key references entities,
  workspace_id text not null,
  scope_space_id text,
  name text not null check (length(name) between 1 and 200),
  kind text not null check (kind in ('work','project','page','agent_task')),
  current_revision bigint not null check (current_revision > 0),
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, id),
  foreign key (workspace_id, scope_space_id) references spaces,
  foreign key (workspace_id, created_by) references principals (workspace_id, id),
  foreign key (workspace_id, id) references entities (workspace_id, id)
);
create table planning_template_revisions (
  template_id text not null references planning_templates,
  revision bigint not null check (revision > 0),
  content jsonb not null check (octet_length(content::text) <= 262144),
  actor_id text not null,
  created_at timestamptz not null,
  primary key (template_id, revision)
);
create trigger planning_template_revisions_immutable before update or delete on planning_template_revisions
  for each row execute function reject_immutable_record();
create table planning_template_applications (
  id text primary key references entities,
  workspace_id text not null,
  target_entity_id text not null references entities,
  target_kind text not null check (target_kind in ('work','project','page','agent_task')),
  template_id text not null,
  template_revision bigint not null,
  applied_at timestamptz not null,
  unique (target_entity_id),
  foreign key (workspace_id, id) references entities (workspace_id, id),
  foreign key (workspace_id, target_entity_id) references entities (workspace_id, id),
  foreign key (template_id, template_revision)
    references planning_template_revisions (template_id, revision)
);

create table notification_settings (
  id text primary key references entities,
  workspace_id text not null,
  principal_id text not null,
  revision bigint not null check (revision > 0),
  unique (workspace_id, principal_id),
  foreign key (workspace_id, id) references entities (workspace_id, id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);
create table notification_preferences (
  settings_id text not null references notification_settings on delete cascade,
  workspace_id text not null,
  principal_id text not null,
  event_type text not null,
  in_app boolean not null,
  primary key (settings_id, event_type),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);
create table notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  recipient_id text not null,
  source_event_id text not null references entity_events_v1,
  source_entity_id text not null references entities,
  deduplication_key text not null,
  payload jsonb not null check (octet_length(payload::text) <= 16384),
  sequence bigserial,
  created_at timestamptz not null default clock_timestamp(),
  read_at timestamptz,
  unique (workspace_id, recipient_id, source_event_id),
  unique (workspace_id, recipient_id, deduplication_key),
  foreign key (workspace_id, recipient_id) references principals (workspace_id, id),
  foreign key (workspace_id, source_entity_id) references entities (workspace_id, id)
);
create index notifications_inbox on notifications (workspace_id, recipient_id, sequence);
create table notification_inbox_cursors (
  workspace_id text not null,
  principal_id text not null,
  last_sequence bigint not null check (last_sequence >= 0),
  updated_at timestamptz not null,
  primary key (workspace_id, principal_id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);
