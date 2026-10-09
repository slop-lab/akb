create table workspaces (
  id text primary key,
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table principals (
  id text primary key,
  workspace_id text not null references workspaces (id),
  display_name text not null,
  kind text not null check (kind in ('human', 'agent', 'service', 'runtime')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table workspace_memberships (
  workspace_id text not null,
  principal_id text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  status text not null default 'active' check (status in ('active', 'deactivated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, principal_id),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);

create table membership_permissions (
  workspace_id text not null,
  principal_id text not null,
  permission text not null check (
    permission in ('work.read', 'work.create', 'work.update', 'work.assign')
  ),
  created_at timestamptz not null default now(),
  primary key (workspace_id, principal_id, permission),
  foreign key (workspace_id, principal_id)
    references workspace_memberships (workspace_id, principal_id) on delete cascade
);

create table principal_credentials (
  id text primary key,
  workspace_id text not null,
  principal_id text not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, principal_id) references principals (workspace_id, id)
);

create index principal_credentials_principal_idx
  on principal_credentials (workspace_id, principal_id);
