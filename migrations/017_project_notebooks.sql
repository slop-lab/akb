create table project_notebooks (
  workspace_id text not null,
  project_id text primary key,
  page_id text not null unique,
  unique (workspace_id, project_id),
  unique (workspace_id, page_id),
  foreign key (workspace_id, project_id) references projects (workspace_id, id),
  foreign key (workspace_id, page_id) references content_documents (workspace_id, id)
);

create function reject_project_notebook_reassignment() returns trigger language plpgsql as $$
begin
  if old.workspace_id is distinct from new.workspace_id
    or old.project_id is distinct from new.project_id
    or old.page_id is distinct from new.page_id then
    raise exception 'project notebook assignment is immutable';
  end if;
  return new;
end $$;
create trigger project_notebooks_immutable before update on project_notebooks
  for each row execute function reject_project_notebook_reassignment();

create function require_project_notebook_root() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from content_documents page
    where page.workspace_id = new.workspace_id and page.id = new.page_id
      and page.parent_page_id is null
  ) then raise exception 'project notebook page must be a root page'; end if;
  return new;
end $$;
create trigger project_notebooks_root before insert on project_notebooks
  for each row execute function require_project_notebook_root();

create function preserve_project_notebook_root() returns trigger language plpgsql as $$
begin
  if new.parent_page_id is not null and exists (
    select 1 from project_notebooks notebook
    where notebook.workspace_id = new.workspace_id and notebook.page_id = new.id
  ) then raise exception 'project notebook root must remain a root page'; end if;
  return new;
end $$;
create trigger content_documents_project_notebook_root
  before update of parent_page_id on content_documents
  for each row execute function preserve_project_notebook_root();
