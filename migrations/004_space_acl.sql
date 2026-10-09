create table spaces (
  workspace_id text not null references workspaces (id),
  id text not null,
  name text not null,
  visibility text not null check (visibility in ('public', 'private')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, id)
);

create table space_permissions (
  workspace_id text not null,
  space_id text not null,
  principal_id text not null,
  permission text not null check (
    permission in ('work.read', 'work.create', 'work.update', 'work.assign')
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, space_id, principal_id, permission),
  foreign key (workspace_id, space_id) references spaces (workspace_id, id) on delete cascade,
  foreign key (workspace_id, principal_id)
    references workspace_memberships (workspace_id, principal_id) on delete cascade
);

alter table work_items add column space_id text;
alter table work_item_revisions add column space_id text;
alter table domain_events add column space_id text;
alter table outbox_events add column space_id text;
alter table delivery_inbox add column space_id text;

alter table work_items add constraint work_items_space_fk
  foreign key (workspace_id, space_id) references spaces (workspace_id, id);
alter table work_item_revisions add constraint work_item_revisions_space_fk
  foreign key (workspace_id, space_id) references spaces (workspace_id, id);
alter table domain_events add constraint domain_events_space_fk
  foreign key (workspace_id, space_id) references spaces (workspace_id, id);
alter table outbox_events add constraint outbox_events_space_fk
  foreign key (workspace_id, space_id) references spaces (workspace_id, id);

create function reject_work_item_scope_mutation() returns trigger language plpgsql as $$
begin
  if old.workspace_id is distinct from new.workspace_id
    or old.space_id is distinct from new.space_id then
    raise exception 'work item scope is immutable';
  end if;
  return new;
end;
$$;

create trigger work_items_scope_immutable before update on work_items
  for each row execute function reject_work_item_scope_mutation();

create or replace function enqueue_outbox_event() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id, 73491));
  insert into outbox_events
    (event_id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id,
     subject_id, subject_revision, changed_fields)
  values
    (new.id, new.workspace_id, new.space_id, new.sequence, new.event_type, new.occurred_at,
     new.actor_id, new.subject_id, new.subject_revision, new.changed_fields);
  insert into outbox_jobs (workspace_id, destination_id, event_id, sequence)
  select d.workspace_id, d.destination_id, new.id, new.sequence
  from outbox_destinations d
  where d.workspace_id = new.workspace_id and d.active
    and new.sequence > d.start_after_sequence;
  return new;
end;
$$;
