create table agent_definitions (
  workspace_id text not null references workspaces(id), id text not null,
  display_name text not null, created_by text not null, created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,id), foreign key (workspace_id,created_by) references principals(workspace_id,id)
);
create table agent_definition_revisions (
  id text primary key, workspace_id text not null, definition_id text not null,
  roles jsonb not null, required_capabilities jsonb not null, manifest jsonb not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'), created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id,definition_id) references agent_definitions(workspace_id,id),
  foreign key (workspace_id,created_by) references principals(workspace_id,id),
  unique (workspace_id,id), unique (workspace_id,definition_id,digest)
);
create trigger agent_definition_revisions_immutable before update or delete on agent_definition_revisions
  for each row execute function reject_immutable_record();
create table runtime_endpoints (
  workspace_id text not null references workspaces(id), id text not null,
  protocol_version text not null check (protocol_version='runtime.v1'),
  mode text not null check (mode in ('push','pull')), supported_roles jsonb not null,
  supported_capabilities jsonb not null, max_concurrency integer not null check (max_concurrency between 1 and 100),
  heartbeat_seconds integer not null check (heartbeat_seconds between 5 and 300),
  enabled boolean not null default true, created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,id)
);
create table agent_installations (
  workspace_id text not null references workspaces(id), id text not null,
  definition_revision_id text not null,
  runtime_endpoint_id text not null, principal_id text not null, scopes jsonb not null,
  permissions jsonb not null, capabilities jsonb not null, mentionable boolean not null,
  delegatable boolean not null, enabled boolean not null default true,
  created_by text not null, created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,id), unique (workspace_id,principal_id),
  foreign key (workspace_id,runtime_endpoint_id) references runtime_endpoints(workspace_id,id),
  foreign key (workspace_id,definition_revision_id) references agent_definition_revisions(workspace_id,id),
  foreign key (workspace_id,principal_id) references principals(workspace_id,id),
  foreign key (workspace_id,created_by) references principals(workspace_id,id)
);
create table runtime_sessions (
  id text primary key, workspace_id text not null references workspaces(id), installation_id text not null,
  subject_ref text not null, directive_ref text not null, requester_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id,installation_id) references agent_installations(workspace_id,id),
  foreign key (workspace_id,requester_id) references principals(workspace_id,id)
);
create table runtime_runs (
  id text primary key, workspace_id text not null references workspaces(id), session_id text not null references runtime_sessions(id),
  installation_id text not null, parent_run_id text references runtime_runs(id), depth integer not null check (depth between 0 and 4),
  state text not null check (state in ('queued','preparing','running','awaiting_input','verifying','review_required','completed','failed','cancel_requested','canceled','stale')),
  generation bigint not null default 1 check (generation > 0), subject_ref text not null, directive_ref text not null,
  requester_id text not null, policy_snapshot jsonb not null, token_hash bytea not null,
  token_expires_at timestamptz not null, cancel_requested_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id,installation_id) references agent_installations(workspace_id,id),
  foreign key (workspace_id,requester_id) references principals(workspace_id,id)
);
create index runtime_runs_workspace_state on runtime_runs(workspace_id,state,updated_at,id);
create table runtime_leases (
  run_id text not null references runtime_runs(id), generation bigint not null,
  owner text not null, status text not null check (status in ('issued','acknowledged','expired','released')),
  issued_at timestamptz not null default clock_timestamp(), acknowledged_at timestamptz,
  expires_at timestamptz not null, heartbeat_deadline timestamptz not null, last_heartbeat_at timestamptz,
  primary key (run_id,generation)
);
create table runtime_input_snapshots (
  run_id text not null references runtime_runs(id), generation bigint not null, revision bigint not null,
  body jsonb not null, digest text not null check (digest ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default clock_timestamp(),
  primary key (run_id,generation,revision)
);
create trigger runtime_input_snapshots_immutable before update or delete on runtime_input_snapshots
  for each row execute function reject_immutable_record();
create table runtime_context_snapshots (
  id uuid primary key default gen_random_uuid(), run_id text not null references runtime_runs(id), generation bigint not null,
  authority_epoch bigint not null, query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null, created_at timestamptz not null default clock_timestamp()
);
create table runtime_context_entries (
  snapshot_id uuid not null references runtime_context_snapshots(id) on delete cascade,
  ordinal integer not null check (ordinal > 0), entity_id text not null references entities(id),
  source_revision bigint not null, kind text not null, estimated_tokens integer not null check (estimated_tokens > 0),
  primary key (snapshot_id,ordinal), unique(snapshot_id,entity_id)
);
create table runtime_idempotency (
  run_id text not null references runtime_runs(id), generation bigint not null, idempotency_key text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'), result jsonb not null,
  created_at timestamptz not null default clock_timestamp(), primary key(run_id,generation,idempotency_key)
);
create table runtime_activity (
  id uuid primary key default gen_random_uuid(), run_id text not null references runtime_runs(id), generation bigint not null,
  sequence bigint not null check (sequence > 0), kind text not null, actor_id text not null,
  durable boolean not null, body jsonb not null, references_json jsonb not null, raw_trace_refs jsonb not null,
  idempotency_key text not null, created_at timestamptz not null default clock_timestamp(),
  unique(run_id,sequence), unique(run_id,generation,idempotency_key)
);
create table runtime_plan_steps (
  run_id text not null references runtime_runs(id), step_id text not null, parent_step_id text,
  title text not null, status text not null check(status in ('proposed','ready','running','blocked','completed','failed','canceled')),
  depends_on jsonb not null, result_refs jsonb not null, revision bigint not null check(revision > 0),
  updated_at timestamptz not null default clock_timestamp(), primary key(run_id,step_id)
);
create table runtime_signals (
  id uuid primary key default gen_random_uuid(), run_id text not null references runtime_runs(id), generation bigint not null,
  kind text not null check(kind in ('stop','confirm','select','authenticate','authorize_capability','upload','review','resolve_conflict','handoff')),
  state text not null check(state in ('open','answered','canceled')), body jsonb not null, answer jsonb,
  created_at timestamptz not null default clock_timestamp(), answered_at timestamptz
);
create table runtime_artifacts (
  id text primary key, workspace_id text not null references workspaces(id), run_id text not null references runtime_runs(id),
  kind text not null, media_type text not null, retention_class text not null,
  digest text, byte_size bigint not null default 0 check(byte_size between 0 and 104857600),
  complete boolean not null default false, created_at timestamptz not null default clock_timestamp()
);
create table runtime_artifact_chunks (
  artifact_id text not null references runtime_artifacts(id), chunk_index integer not null check(chunk_index between 0 and 9999),
  bytes bytea not null check(octet_length(bytes) between 1 and 262144), digest text not null check(digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(), primary key(artifact_id,chunk_index)
);
create table runtime_raw_traces (
  id uuid primary key default gen_random_uuid(), run_id text not null references runtime_runs(id), generation bigint not null,
  artifact_id text not null references runtime_artifacts(id), created_at timestamptz not null default clock_timestamp()
);
create table retrieval_receipts (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references workspaces(id),
  principal_id text not null, run_id text references runtime_runs(id), snapshot_id uuid not null,
  query_hash text not null check(query_hash ~ '^[0-9a-f]{64}$'), projection text not null check(projection in ('ref','card','detail','raw')),
  created_at timestamptz not null default clock_timestamp(), retention_until timestamptz not null
);
create table retrieval_receipt_entries (
  receipt_id uuid not null references retrieval_receipts(id) on delete cascade, entity_id text not null references entities(id),
  source_revision bigint not null, projection text not null, block_ids jsonb not null default '[]',
  primary key(receipt_id,entity_id)
);
create trigger retrieval_receipts_immutable before update or delete on retrieval_receipts
  for each row execute function reject_immutable_record();
create trigger retrieval_receipt_entries_immutable before update or delete on retrieval_receipt_entries
  for each row execute function reject_immutable_record();

create function runtime_write_fence(target_run text, target_generation bigint, target_token_hash bytea,
  target_capability text default null, target_lease_status text default 'acknowledged')
  returns boolean language plpgsql as $$
declare allowed boolean;
begin
  select r.state in ('preparing','running','awaiting_input','verifying','review_required')
    and r.generation=target_generation and r.token_hash=target_token_hash
    and r.token_expires_at>clock_timestamp() and l.status=target_lease_status
    and l.expires_at>clock_timestamp() and l.heartbeat_deadline>clock_timestamp()
    and (target_capability is null or r.policy_snapshot->'capabilities' ? target_capability)
    and w.status='active' and i.enabled and e.enabled and p.status='active' and m.status='active'
  into allowed from runtime_runs r
  join workspaces w on w.id=r.workspace_id
  join agent_installations i on i.workspace_id=r.workspace_id and i.id=r.installation_id
  join runtime_endpoints e on e.workspace_id=i.workspace_id and e.id=i.runtime_endpoint_id
  join principals p on p.workspace_id=i.workspace_id and p.id=i.principal_id
  join workspace_memberships m on m.workspace_id=p.workspace_id and m.principal_id=p.id
  join runtime_leases l on l.run_id=r.id and l.generation=r.generation
  where r.id=target_run for update of r,l for share of w,i,e,p,m;
  return coalesce(allowed,false);
end $$;
