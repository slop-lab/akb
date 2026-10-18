insert into entity_kind_registry (kind, read_permission) values
  ('intake', 'automation.read'),
  ('recurrence', 'automation.read'),
  ('automation_rule', 'automation.read'),
  ('github_installation', 'automation.read'),
  ('extension_installation', 'automation.read');

create table intake_records (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  source text not null check (source in ('human','agent','integration','import')),
  source_ref text not null, submitter_id text not null, target_space_id text not null,
  title text not null check (length(trim(title)) between 1 and 500), body text not null,
  state text not null check (state in ('new','clarifying','accepted','declined','deferred','duplicate')),
  suggested_destination text, converted_work_item_id text references work_items(id),
  duplicate_of text references intake_records(id), disposition text, snooze_until timestamptz,
  revision bigint not null check (revision > 0), created_at timestamptz not null,
  updated_at timestamptz not null, unique(workspace_id,id),
  foreign key(workspace_id,id) references entities(workspace_id,id),
  foreign key(workspace_id,target_space_id) references spaces(workspace_id,id),
  foreign key(workspace_id,submitter_id) references principals(workspace_id,id),
  check ((state='accepted')=(converted_work_item_id is not null)),
  check ((state='duplicate')=(duplicate_of is not null)),
  check (state<>'declined' or length(trim(disposition))>0),
  check (state<>'clarifying' or length(trim(disposition))>0),
  check (state<>'deferred' or snooze_until is not null)
);
create index intake_records_queue_idx on intake_records(workspace_id,state,created_at,id);

create table recurrence_rules (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  template_id text not null references planning_templates(id), template_revision bigint not null,
  target_space_id text not null, schedule jsonb not null, timezone text not null,
  incomplete_policy text not null check(incomplete_policy in ('skip','create','merge')),
  title text not null, next_run_at timestamptz not null, enabled boolean not null default true,
  revision bigint not null check(revision>0), created_by text not null, created_at timestamptz not null,
  unique(workspace_id,id), foreign key(workspace_id,id) references entities(workspace_id,id),
  foreign key(workspace_id,target_space_id) references spaces(workspace_id,id),
  foreign key(workspace_id,created_by) references principals(workspace_id,id),
  foreign key(template_id,template_revision) references planning_template_revisions(template_id,revision)
);
create index recurrence_rules_due_idx on recurrence_rules(next_run_at,id) where enabled;
create table recurrence_occurrences (
  rule_id text not null references recurrence_rules(id), scheduled_for timestamptz not null,
  template_revision bigint not null, outcome text not null check(outcome in ('skipped','created','merged')),
  work_item_id text references work_items(id), created_at timestamptz not null,
  primary key(rule_id,scheduled_for), check((outcome='skipped')=(work_item_id is null))
);

create table automation_rules (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  name text not null, enabled boolean not null, trigger_spec jsonb not null,
  conditions jsonb not null, actions jsonb not null, max_runs_per_minute integer not null
    check(max_runs_per_minute between 1 and 1000), version bigint not null check(version>0),
  revision bigint not null check(revision>0), owner_id text not null, last_run_at timestamptz,
  failure_count integer not null default 0 check(failure_count>=0), created_at timestamptz not null,
  unique(workspace_id,id), foreign key(workspace_id,id) references entities(workspace_id,id),
  foreign key(workspace_id,owner_id) references principals(workspace_id,id)
);
create table automation_runs (
  id uuid primary key default gen_random_uuid(), rule_id text not null references automation_rules(id),
  event_id text not null references entity_events_v1(id), depth integer not null check(depth between 0 and 8),
  state text not null check(state in ('pending','running','succeeded','failed','dead_letter')),
  attempts integer not null default 0 check(attempts between 0 and 5), available_at timestamptz not null,
  last_error text, created_at timestamptz not null, completed_at timestamptz,
  unique(rule_id,event_id)
);
create index automation_runs_claim_idx on automation_runs(available_at,id)
  where state in ('pending','failed');
create table automation_action_jobs (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references automation_runs(id),
  ordinal integer not null check(ordinal>=0), action jsonb not null,
  state text not null check(state in ('pending','succeeded','failed','dead_letter')),
  attempts integer not null default 0 check(attempts between 0 and 5), available_at timestamptz not null,
  last_error text, completed_at timestamptz, unique(run_id,ordinal)
);
create table automation_event_checkpoints (
  workspace_id text primary key references workspaces(id), last_sequence bigint not null default 0
    check(last_sequence>=0), updated_at timestamptz not null default clock_timestamp()
);

create table github_installations (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  external_installation_id text not null, repository text not null, webhook_secret bytea not null,
  api_base_url text not null, allowed_hosts text[] not null, revision bigint not null check(revision=1),
  created_by text not null, created_at timestamptz not null, unique(workspace_id,external_installation_id),
  foreign key(workspace_id,id) references entities(workspace_id,id),
  foreign key(workspace_id,created_by) references principals(workspace_id,id)
);
create table github_mappings (
  installation_id text not null references github_installations(id), github_number bigint not null check(github_number>0),
  entity_id text not null references entities(id), primary key(installation_id,github_number),
  unique(installation_id,entity_id)
);
create table github_webhook_deliveries (
  installation_id text not null references github_installations(id), delivery_id text not null,
  event_name text not null, payload jsonb not null, received_at timestamptz not null,
  processed_at timestamptz, state text not null default 'pending'
    check(state in ('pending','processing','succeeded','failed','dead_letter')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  available_at timestamptz not null default clock_timestamp(), last_error text,
  primary key(installation_id,delivery_id)
);
create index github_webhook_deliveries_claim_idx on github_webhook_deliveries(available_at,installation_id,delivery_id)
  where state in ('pending','failed');
create table outgoing_https_requests (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references workspaces(id),
  idempotency_key text not null default gen_random_uuid()::text,
  endpoint_kind text not null check(endpoint_kind in ('github','extension','webhook')), endpoint_id text not null,
  url text not null, method text not null check(method in ('POST','PATCH')), body jsonb not null,
  headers jsonb not null default '{}', state text not null
    check(state in ('pending','delivering','succeeded','failed','dead_letter')),
  attempts integer not null default 0 check(attempts between 0 and 5), available_at timestamptz not null,
  last_error text, lease_owner uuid, lease_generation bigint not null default 0 check(lease_generation>=0),
  lease_expires_at timestamptz, created_at timestamptz not null,
  unique(workspace_id,idempotency_key),
  check((state='delivering')=(lease_owner is not null and lease_expires_at is not null))
);
create index outgoing_https_claim_idx on outgoing_https_requests(available_at,id)
  where state in ('pending','failed','delivering');

create table extension_manifests (
  manifest_id text not null, version text not null, protocol_version text not null,
  manifest jsonb not null, digest text not null check(length(digest)=64), submitted_by text not null,
  submitted_at timestamptz not null, primary key(manifest_id,version)
);
create trigger extension_manifests_immutable before update or delete on extension_manifests
  for each row execute function reject_immutable_record();
create table extension_installations (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  manifest_id text not null, manifest_version text not null, approved_permissions text[] not null,
  endpoint_url text not null, enabled boolean not null default true,
  revision bigint not null check(revision=1), approved_by text not null,
  approved_at timestamptz not null, unique(workspace_id,manifest_id),
  foreign key(manifest_id,manifest_version) references extension_manifests(manifest_id,version),
  foreign key(workspace_id,id) references entities(workspace_id,id),
  foreign key(workspace_id,approved_by) references principals(workspace_id,id)
);

create trigger recurrence_occurrences_immutable before update or delete on recurrence_occurrences
  for each row execute function reject_immutable_record();
