create table outbox_events (
  event_id text primary key references domain_events (id),
  workspace_id text not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in ('work_item.created', 'work_item.updated')),
  occurred_at timestamptz not null,
  actor_id text not null,
  subject_id text not null,
  subject_revision bigint not null check (subject_revision > 0),
  changed_fields text[],
  unique (workspace_id, sequence),
  unique (workspace_id, event_id),
  check (
    (event_type = 'work_item.created' and changed_fields is null)
    or (event_type = 'work_item.updated' and changed_fields is not null)
  )
);

create table outbox_destinations (
  workspace_id text not null references workspaces (id),
  destination_id text not null,
  sink text not null check (sink = 'database-inbox'),
  active boolean not null default true,
  start_after_sequence bigint not null check (start_after_sequence >= 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, destination_id)
);

create table outbox_jobs (
  job_id uuid not null default gen_random_uuid() unique,
  workspace_id text not null,
  destination_id text not null,
  event_id text not null,
  sequence bigint not null check (sequence > 0),
  state text not null default 'pending' check (state in ('pending', 'leased', 'delivered', 'dead_letter')),
  lease_owner uuid,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  last_error text check (last_error is null or length(last_error) <= 500),
  delivered_at timestamptz,
  primary key (workspace_id, destination_id, event_id),
  unique (workspace_id, destination_id, sequence),
  foreign key (workspace_id, destination_id)
    references outbox_destinations (workspace_id, destination_id),
  foreign key (workspace_id, event_id) references outbox_events (workspace_id, event_id),
  check (
    (state = 'leased' and lease_owner is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_expires_at is null)
  ),
  check ((state = 'delivered') = (delivered_at is not null))
);

create index outbox_jobs_delivery_idx
  on outbox_jobs (workspace_id, destination_id, sequence) where state <> 'delivered';

create table delivery_inbox (
  destination_id text not null,
  event_id text not null,
  workspace_id text not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null,
  occurred_at timestamptz not null,
  actor_id text not null,
  subject_id text not null,
  subject_revision bigint not null,
  changed_fields text[],
  received_at timestamptz not null default clock_timestamp(),
  primary key (destination_id, event_id)
);

create function enqueue_outbox_event() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id, 73491));
  insert into outbox_events
    (event_id, workspace_id, sequence, event_type, occurred_at, actor_id,
     subject_id, subject_revision, changed_fields)
  values
    (new.id, new.workspace_id, new.sequence, new.event_type, new.occurred_at, new.actor_id,
     new.subject_id, new.subject_revision, new.changed_fields);
  insert into outbox_jobs (workspace_id, destination_id, event_id, sequence)
  select d.workspace_id, d.destination_id, new.id, new.sequence
  from outbox_destinations d
  where d.workspace_id = new.workspace_id and d.active
    and new.sequence > d.start_after_sequence;
  return new;
end;
$$;

create trigger domain_events_enqueue_outbox
after insert on domain_events for each row execute function enqueue_outbox_event();

create function reject_outbox_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'outbox events are immutable';
end;
$$;

create trigger outbox_events_immutable
before update or delete on outbox_events for each row execute function reject_outbox_event_mutation();
