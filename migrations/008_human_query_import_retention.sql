create table human_query_snapshots (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references workspaces,
  principal_id text not null, credential_id text not null references principal_credentials,
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  sort_hash text not null check (sort_hash ~ '^[0-9a-f]{64}$'),
  authority_hash text not null check (authority_hash ~ '^[0-9a-f]{64}$'),
  matched integer not null check (matched between 0 and 100000),
  expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, principal_id) references workspace_memberships,
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index human_query_snapshots_principal on human_query_snapshots
  (workspace_id, principal_id, expires_at);
create table human_query_snapshot_items (
  snapshot_id uuid not null references human_query_snapshots on delete cascade,
  ordinal integer not null check (ordinal between 1 and 100000),
  entity_id text not null references entities, source_revision bigint not null check (source_revision > 0),
  group_key text, primary key (snapshot_id, ordinal), unique (snapshot_id, entity_id)
);
create function enforce_snapshot_budgets() returns trigger language plpgsql as $$
begin
  if (select count(*) from human_query_snapshots where workspace_id = new.workspace_id
    and principal_id = new.principal_id and expires_at > clock_timestamp()) >= 8 then
    raise exception 'principal has at most eight active snapshots';
  end if;
  if (select coalesce(sum(matched),0) from human_query_snapshots where workspace_id = new.workspace_id
    and expires_at > clock_timestamp()) + new.matched > 250000 then
    raise exception 'workspace snapshot row budget exceeded';
  end if;
  return new;
end $$;
create trigger human_query_snapshot_budgets before insert on human_query_snapshots
  for each row execute function enforce_snapshot_budgets();
create table import_batches (
  import_id uuid primary key, workspace_id text not null references workspaces, principal_id text not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size between 1 and 10485760),
  record_count integer not null check (record_count between 1 and 10000),
  state text not null check (state in ('validated','committed')),
  validation_expires_at timestamptz not null, committed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), unique (workspace_id, import_id),
  foreign key (workspace_id, principal_id) references workspace_memberships,
  check ((state = 'committed') = (committed_at is not null))
);
create table import_record_ids (
  import_id uuid not null references import_batches on delete cascade, external_id text not null,
  entity_id text not null references entities, record_kind text not null,
  primary key (import_id, external_id), unique (import_id, entity_id)
);
create table retention_policies (
  resource text primary key, mode text not null check (mode in ('keep_forever','purge_after')),
  retention_interval interval, check ((mode = 'keep_forever') = (retention_interval is null))
);
insert into retention_policies values
  ('entities','keep_forever',null),('entity_revisions','keep_forever',null),
  ('entity_events','keep_forever',null),('comments','keep_forever',null),
  ('query_snapshots','purge_after',interval '1 day'),
  ('import_bookkeeping','purge_after',interval '30 days');
