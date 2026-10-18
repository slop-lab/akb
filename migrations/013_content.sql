insert into permission_atoms (permission) values ('content.read'), ('content.manage')
on conflict do nothing;
insert into entity_kind_registry (kind, read_permission)
values ('page', 'content.read'), ('inline_comment', 'content.read');

create table content_documents (
  id text primary key references entities (id),
  workspace_id text not null references workspaces (id),
  space_id text,
  parent_page_id text,
  title text not null check (length(trim(title)) between 1 and 500),
  current_revision bigint not null check (current_revision > 0),
  lifecycle text not null default 'active' check (lifecycle in ('active', 'archived')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, space_id) references spaces (workspace_id, id),
  foreign key (workspace_id, parent_page_id) references content_documents (workspace_id, id),
  check (parent_page_id is null or parent_page_id <> id),
  check ((lifecycle = 'archived') = (archived_at is not null))
);
create index content_documents_parent_idx
  on content_documents (workspace_id, parent_page_id, updated_at desc, id);

create table content_document_revisions (
  page_id text not null references content_documents (id),
  revision bigint not null check (revision > 0),
  title text not null,
  parent_page_id text,
  document jsonb not null check (octet_length(document::text) <= 2097152),
  actor_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  primary key (page_id, revision),
  foreign key (page_id, revision) references entity_revisions (entity_id, revision)
    deferrable initially deferred
);

create table content_blocks (
  page_id text not null references content_documents (id) on delete cascade,
  block_id text not null,
  parent_block_id text,
  position integer not null check (position >= 0),
  block_type text not null check (block_type in ('paragraph','heading','list','list_item','code',
    'quote','table','callout','entity_embed','artifact_embed')),
  plain_text text not null,
  entity_ref text,
  artifact_ref text,
  primary key (page_id, block_id),
  foreign key (page_id, parent_block_id) references content_blocks (page_id, block_id)
    deferrable initially deferred,
  unique (page_id, parent_block_id, position)
);
create index content_blocks_entity_ref_idx on content_blocks (entity_ref, page_id)
  where entity_ref is not null;

create table inline_comments (
  id text primary key references entities (id),
  workspace_id text not null references workspaces (id),
  page_id text not null references content_documents (id),
  block_id text not null,
  author_id text not null,
  body text not null check (length(trim(body)) between 1 and 20000),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  foreign key (workspace_id, author_id) references principals (workspace_id, id)
);
create index inline_comments_page_idx on inline_comments (page_id, created_at, id);

create table content_presence (
  workspace_id text not null references workspaces (id) on delete cascade,
  page_id text not null references content_documents (id) on delete cascade,
  principal_id text not null,
  block_id text,
  cursor_offset integer check (cursor_offset is null or cursor_offset >= 0),
  expires_at timestamptz not null,
  primary key (page_id, principal_id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);
create index content_presence_expiry_idx on content_presence (expires_at);

create function reject_content_page_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_page_id is not null and exists (
    with recursive ancestors(id) as (
      select new.parent_page_id
      union all
      select d.parent_page_id from content_documents d join ancestors a on d.id = a.id
      where d.parent_page_id is not null
    ) select 1 from ancestors where id = new.id
  ) then raise exception 'content page cycle'; end if;
  return new;
end $$;
create constraint trigger content_documents_no_cycle
  after insert or update of parent_page_id on content_documents deferrable initially deferred
  for each row execute function reject_content_page_cycle();

create trigger content_document_revisions_immutable
  before update or delete on content_document_revisions
  for each row execute function reject_immutable_record();
