create table entity_event_sequences (
  workspace_id text primary key references workspaces (id),
  last_sequence bigint not null check (last_sequence > 0)
);
create table entity_events_v1 (
  id text primary key, workspace_id text not null references workspaces (id),
  sequence bigint not null check (sequence > 0),
  event_type text not null check (event_type in ('entity.created', 'entity.updated',
    'entity.archived', 'entity.restored', 'acl.changed', 'relation.created',
    'relation.updated', 'relation.archived', 'comment.created', 'comment.updated')),
  subject_kind text not null, subject_id text not null references entities (id),
  subject_revision bigint not null check (subject_revision > 0), occurred_at timestamptz not null,
  actor_id text, payload_schema integer not null default 1 check (payload_schema = 1),
  data jsonb not null check (octet_length(data::text) <= 16384),
  unique (workspace_id, sequence),
  foreign key (subject_id, subject_revision) references entity_revisions (entity_id, revision)
);
create table entity_outbox_events_v1 (
  event_id text primary key references entity_events_v1 (id), workspace_id text not null,
  sequence bigint not null, payload jsonb not null,
  unique (workspace_id, sequence), unique (workspace_id, event_id)
);
create table entity_outbox_destinations_v1 (
  workspace_id text not null references workspaces (id), destination_id text not null,
  sink text not null check (sink = 'database-inbox'), active boolean not null default true,
  start_after_sequence bigint not null check (start_after_sequence >= 0),
  created_at timestamptz not null default clock_timestamp(), primary key (workspace_id, destination_id)
);
create table entity_outbox_jobs_v1 (
  job_id uuid not null default gen_random_uuid() unique, workspace_id text not null,
  destination_id text not null, event_id text not null, sequence bigint not null check (sequence > 0),
  state text not null default 'pending' check (state in ('pending','leased','delivered','dead_letter')),
  lease_owner uuid, lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz, attempts integer not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default clock_timestamp(), last_error text,
  delivered_at timestamptz, primary key (workspace_id, destination_id, event_id),
  unique (workspace_id, destination_id, sequence),
  foreign key (workspace_id, destination_id) references entity_outbox_destinations_v1,
  foreign key (workspace_id, event_id) references entity_outbox_events_v1 (workspace_id, event_id),
  check ((state = 'leased') = (lease_owner is not null and lease_expires_at is not null)),
  check ((state = 'delivered') = (delivered_at is not null))
);
create index entity_outbox_jobs_v1_delivery_idx on entity_outbox_jobs_v1
  (workspace_id, destination_id, sequence) where state <> 'delivered';
create table delivery_inbox_v1 (
  destination_id text not null, event_id text not null, workspace_id text not null,
  sequence bigint not null, payload jsonb not null,
  received_at timestamptz not null default clock_timestamp(), primary key (destination_id, event_id)
);
create table generic_command_idempotency (
  workspace_id text not null references workspaces (id), idempotency_key text not null,
  command_id text not null, principal_id text not null, action text not null, route text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  event_id text references entity_events_v1 (id), subject_id text references entities (id),
  result_revision bigint, result jsonb not null, created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, idempotency_key), unique (workspace_id, command_id)
);

insert into entity_event_sequences
select d.workspace_id, max(d.sequence) from domain_events d join workspaces w on w.id = d.workspace_id
group by d.workspace_id;
insert into entity_events_v1
  (id, workspace_id, sequence, event_type, subject_kind, subject_id, subject_revision,
   occurred_at, actor_id, data)
select d.id, d.workspace_id, d.sequence,
  case d.event_type when 'work_item.created' then 'entity.created' else 'entity.updated' end,
  'work_item', d.subject_id, d.subject_revision, d.occurred_at, p.id,
  jsonb_build_object('kind','work_item','changedFields',coalesce(d.changed_fields,array[]::text[]))
from domain_events d join entities e on e.id = d.subject_id
left join principals p on p.workspace_id = d.workspace_id and p.id = d.actor_id;

create function enqueue_entity_event_v1() returns trigger language plpgsql as $$
begin
  insert into entity_outbox_events_v1 values (new.id, new.workspace_id, new.sequence, to_jsonb(new));
  insert into entity_outbox_jobs_v1 (workspace_id, destination_id, event_id, sequence)
  select d.workspace_id, d.destination_id, new.id, new.sequence from entity_outbox_destinations_v1 d
  where d.workspace_id = new.workspace_id and d.active and new.sequence > d.start_after_sequence;
  return new;
end $$;
create trigger entity_events_v1_enqueue after insert on entity_events_v1
  for each row execute function enqueue_entity_event_v1();

create function mirror_legacy_work_item_event() returns trigger language plpgsql as $$
declare generic_sequence bigint; snapshot jsonb; resolved_actor text;
begin
  if not exists (select 1 from workspaces where id = new.workspace_id) then return new; end if;
  if exists (select 1 from entity_events_v1 where id = new.id) then return new; end if;
  select to_jsonb(r) into strict snapshot from work_item_revisions r
    where r.work_item_id = new.subject_id and r.revision = new.subject_revision;
  select id into resolved_actor from principals where workspace_id = new.workspace_id and id = new.actor_id;
  insert into entities
    (id, workspace_id, kind, scope_space_id, current_revision, created_by, created_at, updated_at)
  select w.id, w.workspace_id, 'work_item', w.space_id, w.revision, resolved_actor, w.created_at, w.updated_at
  from work_items w where w.id = new.subject_id
  on conflict (id) do update set current_revision = excluded.current_revision,
    updated_at = excluded.updated_at;
  insert into entity_acl_policies values (new.subject_id, 'inherit') on conflict do nothing;
  insert into entity_revisions
    (entity_id, revision, schema_version, canonical_snapshot, actor_id, cause_event_id, created_at, digest)
  values (new.subject_id, new.subject_revision, 'work-item.legacy.v1', snapshot, resolved_actor,
    new.id, new.occurred_at,
    encode(public.digest(convert_to(snapshot::text,'utf8'),'sha256'),'hex'))
  on conflict (entity_id, revision) do nothing;
  insert into entity_event_sequences values (new.workspace_id, 1)
  on conflict (workspace_id) do update set last_sequence = entity_event_sequences.last_sequence + 1
  returning last_sequence into generic_sequence;
  insert into entity_events_v1
    (id, workspace_id, sequence, event_type, subject_kind, subject_id, subject_revision,
     occurred_at, actor_id, data)
  values (new.id, new.workspace_id, generic_sequence,
    case new.event_type when 'work_item.created' then 'entity.created' else 'entity.updated' end,
    'work_item', new.subject_id, new.subject_revision, new.occurred_at, resolved_actor,
    jsonb_build_object('kind','work_item','changedFields',coalesce(new.changed_fields,array[]::text[])));
  return new;
end $$;
create trigger domain_events_mirror_entity_v1 after insert on domain_events
  for each row execute function mirror_legacy_work_item_event();
create trigger entity_events_v1_immutable before update or delete on entity_events_v1
  for each row execute function reject_immutable_record();
create trigger entity_outbox_events_v1_immutable before update or delete on entity_outbox_events_v1
  for each row execute function reject_immutable_record();
