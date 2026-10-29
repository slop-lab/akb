create function reject_project_notebook_removal() returns trigger language plpgsql as $$
begin
  raise exception 'project notebook assignment is immutable';
end $$;

create trigger project_notebooks_no_delete before delete on project_notebooks
  for each row execute function reject_project_notebook_removal();
