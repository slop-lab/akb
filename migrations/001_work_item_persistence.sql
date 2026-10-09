create table workspace_event_sequences (
  workspace_id text primary key,
  last_sequence bigint not null check (last_sequence > 0)
);

create table work_items (
  id text primary key,
  workspace_id text not null,
  title text not null,
  state text not null check (state in ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  accountable_owner_id text not null,
  revision bigint not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index work_items_workspace_created_id_idx
  on work_items (workspace_id, created_at, id);

create table work_item_revisions (
  work_item_id text not null references work_items (id),
  workspace_id text not null,
  title text not null,
  state text not null check (state in ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  accountable_owner_id text not null,
  revision bigint not null check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (work_item_id, revision)
);

create table domain_events (
  id text primary key,
  workspace_id text not null,
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in ('work_item.created', 'work_item.updated')),
  occurred_at timestamptz not null,
  actor_id text not null,
  subject_id text not null references work_items (id),
  subject_revision bigint not null check (subject_revision > 0),
  changed_fields text[],
  unique (workspace_id, sequence),
  foreign key (subject_id, subject_revision)
    references work_item_revisions (work_item_id, revision),
  check (
    (event_type = 'work_item.created' and changed_fields is null)
    or (event_type = 'work_item.updated' and changed_fields is not null)
  )
);

create table work_item_idempotency (
  workspace_id text not null,
  idempotency_key text not null,
  fingerprint text not null,
  work_item_id text not null references work_items (id),
  event_id text not null references domain_events (id),
  primary key (workspace_id, idempotency_key)
);
