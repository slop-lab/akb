insert into entity_kind_registry (kind, read_permission) values
  ('knowledge_object', 'knowledge.read'),
  ('knowledge_proposal', 'review.read'),
  ('knowledge_review', 'review.read');

create table knowledge_objects (
  id text primary key references entities(id),
  workspace_id text not null references workspaces(id),
  object_type text not null check (object_type in ('claim','decision','evidence','question','experiment')),
  title text not null check (length(trim(title)) between 1 and 500),
  lifecycle text not null default 'active' check (lifecycle in ('active','archived')),
  current_revision bigint not null check (current_revision > 0),
  accepted_proposal_id text not null,
  accepted_review_id text not null,
  reviewed_by text not null,
  reviewed_at timestamptz not null,
  search_text text not null,
  search_document tsvector generated always as
    (to_tsvector('simple', title || ' ' || search_text)) stored,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id,id),
  foreign key (workspace_id,id) references entities(workspace_id,id),
  foreign key (workspace_id,reviewed_by) references principals(workspace_id,id)
);
create index knowledge_objects_search_idx on knowledge_objects using gin(search_document);
create index knowledge_objects_recent_idx on knowledge_objects(workspace_id,updated_at desc,id);

create table knowledge_claims (
  id text primary key references knowledge_objects(id) on delete cascade,
  statement text not null check (length(trim(statement)) between 1 and 50000),
  status text not null check (status in ('proposed','accepted','disputed','rejected','superseded')),
  confidence numeric not null check (confidence between 0 and 1),
  validity_scope text not null default '' check (length(validity_scope) <= 10000),
  reviewed_by text not null,
  reviewed_at timestamptz not null
);
create table knowledge_decisions (
  id text primary key references knowledge_objects(id) on delete cascade,
  decision text not null check (length(trim(decision)) between 1 and 50000),
  context text not null default '', alternatives text not null default '', rationale text not null default '',
  consequences text not null default '',
  status text not null check (status in ('proposed','accepted','superseded','reversed')),
  owner_id text not null, review_date date, applies_to text not null default ''
);
create table knowledge_evidence (
  id text primary key references knowledge_objects(id) on delete cascade,
  source_type text not null check (source_type in ('entity','runtime_artifact','external')),
  source_ref text not null, observation text not null check (length(trim(observation)) > 0),
  captured_at timestamptz not null, captured_by text not null,
  reliability numeric not null check (reliability between 0 and 1), validity text not null default ''
);
create table knowledge_questions (
  id text primary key references knowledge_objects(id) on delete cascade,
  question text not null check (length(trim(question)) > 0),
  status text not null check (status in ('open','investigating','answered','abandoned')),
  owner_id text not null, delegates jsonb not null default '[]', accepted_answer_id text
);
create table knowledge_experiments (
  id text primary key references knowledge_objects(id) on delete cascade,
  hypothesis text not null check (length(trim(hypothesis)) > 0), method text not null,
  inputs text not null default '', runs text not null default '', results text not null default '',
  conclusion text not null default ''
);

create table knowledge_proposals (
  id text primary key references entities(id),
  workspace_id text not null references workspaces(id), target_id text not null,
  base_revision bigint, action text not null check (action in ('knowledge.create','knowledge.revise')),
  candidate_type text not null check (candidate_type in ('claim','decision','evidence','question','experiment')),
  candidate_payload jsonb not null check (octet_length(candidate_payload::text) <= 262144),
  profile_id text, profile_revision bigint, input_revision bigint,
  status text not null default 'pending' check
    (status in ('pending','accepted','rejected','changes_requested')),
  proposer_id text not null, revision bigint not null check (revision > 0),
  created_at timestamptz not null, decided_at timestamptz,
  unique (workspace_id,id),
  foreign key (workspace_id,id) references entities(workspace_id,id),
  foreign key (workspace_id,proposer_id) references principals(workspace_id,id),
  check ((profile_id is null) = (profile_revision is null)),
  check ((action='knowledge.create' and base_revision is null) or
    (action='knowledge.revise' and base_revision is not null))
);
create table knowledge_proposal_sources (
  proposal_id text not null references knowledge_proposals(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  source_kind text not null check (source_kind in ('entity','runtime_artifact')),
  source_entity_id text references entities(id), source_revision bigint,
  artifact_id text references runtime_artifacts(id), evidence_role text not null
    check (evidence_role in ('supporting','contradicting','context')),
  primary key (proposal_id,ordinal),
  check ((source_kind='entity' and source_entity_id is not null and source_revision is not null
      and artifact_id is null) or
    (source_kind='runtime_artifact' and artifact_id is not null and source_entity_id is null
      and source_revision is null))
);
create table knowledge_proposal_relations (
  proposal_id text not null references knowledge_proposals(id) on delete cascade,
  related_entity_id text not null references entities(id), related_revision bigint not null,
  relation_type text not null check (relation_type in ('supports','contradicts','answers','supersedes','applies_to')),
  primary key (proposal_id,related_entity_id,relation_type)
);

create table knowledge_review_policies (
  policy_id text not null,
  revision bigint not null check (revision > 0),
  policy_type text not null check (policy_type in ('human_approval')),
  display_name text not null check (length(trim(display_name)) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  primary key (policy_id,revision)
);
insert into knowledge_review_policies (policy_id,revision,policy_type,display_name)
  values ('human-review',1,'human_approval','Human review');

create table knowledge_reviews (
  id text primary key references entities(id), workspace_id text not null references workspaces(id),
  proposal_id text not null unique references knowledge_proposals(id), proposal_revision bigint not null,
  subject_id text not null, subject_revision bigint,
  decision text not null check (decision in ('accepted','rejected','changes_requested')),
  reviewer_id text not null, policy_id text not null, policy_revision bigint not null,
  profile_id text, profile_revision bigint, input_revision bigint,
  rationale text not null default '', created_at timestamptz not null,
  unique (workspace_id,id), foreign key (workspace_id,id) references entities(workspace_id,id),
  foreign key (workspace_id,reviewer_id) references principals(workspace_id,id),
  foreign key (policy_id,policy_revision) references knowledge_review_policies(policy_id,revision),
  check ((profile_id is null) = (profile_revision is null))
);
create table knowledge_review_evidence (
  review_id text not null references knowledge_reviews(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0), source_kind text not null,
  source_ref text not null, source_revision bigint, evidence_role text not null,
  primary key(review_id,ordinal)
);

create table knowledge_revision_sources (
  knowledge_id text not null, revision bigint not null, ordinal integer not null,
  source_kind text not null check (source_kind in ('entity','runtime_artifact')),
  source_ref text not null, source_revision bigint, evidence_role text not null,
  proposal_id text not null references knowledge_proposals(id),
  review_id text not null references knowledge_reviews(id),
  primary key(knowledge_id,revision,ordinal),
  foreign key(knowledge_id,revision) references entity_revisions(entity_id,revision)
    deferrable initially deferred
);
create table knowledge_revision_relations (
  knowledge_id text not null, revision bigint not null, related_entity_id text not null,
  related_revision bigint not null, relation_type text not null,
  proposal_id text not null references knowledge_proposals(id),
  review_id text not null references knowledge_reviews(id),
  primary key(knowledge_id,revision,related_entity_id,relation_type),
  foreign key(knowledge_id,revision) references entity_revisions(entity_id,revision)
    deferrable initially deferred
);

create table derived_summaries (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references workspaces(id),
  subject_id text not null references knowledge_objects(id), source_entity_id text not null references entities(id),
  source_revision bigint not null, profile_id text not null, profile_revision bigint not null,
  generator text not null, content text not null, token_count integer not null check (token_count >= 0),
  created_at timestamptz not null default clock_timestamp(), stale_at timestamptz,
  unique(subject_id,source_entity_id,source_revision,profile_id,profile_revision,generator)
);
create function stale_derived_summaries() returns trigger language plpgsql as $$
begin
  update derived_summaries set stale_at=coalesce(stale_at,new.created_at)
    where source_entity_id=new.entity_id and source_revision<new.revision and stale_at is null;
  return new;
end $$;
create trigger entity_revision_stale_summaries after insert on entity_revisions
  for each row execute function stale_derived_summaries();

create trigger knowledge_proposal_sources_immutable before update or delete on knowledge_proposal_sources
  for each row execute function reject_immutable_record();
create trigger knowledge_proposal_relations_immutable before update or delete on knowledge_proposal_relations
  for each row execute function reject_immutable_record();
create trigger knowledge_review_policies_immutable before update or delete on knowledge_review_policies
  for each row execute function reject_immutable_record();
create trigger knowledge_reviews_immutable before update or delete on knowledge_reviews
  for each row execute function reject_immutable_record();
create trigger knowledge_review_evidence_immutable before update or delete on knowledge_review_evidence
  for each row execute function reject_immutable_record();
create trigger knowledge_revision_sources_immutable before update or delete on knowledge_revision_sources
  for each row execute function reject_immutable_record();
create trigger knowledge_revision_relations_immutable before update or delete on knowledge_revision_relations
  for each row execute function reject_immutable_record();
