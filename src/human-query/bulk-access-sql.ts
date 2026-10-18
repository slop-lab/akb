import type { TransactionSql } from "postgres"

function emptyFragment(sql: TransactionSql) {
  return sql``
}

type Fragment = ReturnType<typeof emptyFragment>

export function compileBulkAccessCtes(
  sql: TransactionSql,
  workspaceId: string,
  principalId: string,
): Fragment {
  return sql`
    access_requirements(root_id,entity_id,permission) as (
      select root_id,entity_id,permission from access_roots
      union
      select requirement.root_id,dependency.required_entity_id,registry.read_permission
      from access_requirements requirement
      join entity_access_dependencies dependency on dependency.entity_id=requirement.entity_id
      join entities required on required.id=dependency.required_entity_id
        and required.workspace_id=${workspaceId}
      join entity_kind_registry registry on registry.kind=required.kind
    ), allowed_access_requirements as materialized (
      select distinct requirement.root_id,requirement.entity_id,requirement.permission
      from access_requirements requirement
      join entities entity on entity.id=requirement.entity_id
        and entity.workspace_id=${workspaceId}
      join workspace_memberships membership on membership.workspace_id=entity.workspace_id
        and membership.principal_id=${principalId} and membership.status='active'
      join principals principal on principal.workspace_id=membership.workspace_id
        and principal.id=membership.principal_id and principal.status='active'
      join membership_permissions permission on permission.workspace_id=entity.workspace_id
        and permission.principal_id=membership.principal_id
        and permission.permission=requirement.permission
      join entity_acl_policies policy on policy.entity_id=entity.id
      left join entity_acl_allowances allowance on allowance.entity_id=entity.id
        and allowance.principal_id=membership.principal_id
        and allowance.permission=requirement.permission
      left join spaces space on space.workspace_id=entity.workspace_id
        and space.id=entity.scope_space_id
      left join space_permissions space_permission on space_permission.workspace_id=space.workspace_id
        and space_permission.space_id=space.id
        and space_permission.principal_id=membership.principal_id
        and space_permission.permission=requirement.permission
      where (entity.scope_space_id is null or space.visibility='public'
          or space_permission.principal_id is not null)
        and (policy.mode='inherit' or allowance.principal_id is not null)
    ), authorized_access_roots as materialized (
      select requirement.root_id
      from access_requirements requirement
      left join allowed_access_requirements allowed on allowed.root_id=requirement.root_id
        and allowed.entity_id=requirement.entity_id
        and allowed.permission=requirement.permission
      group by requirement.root_id
      having count(*)=count(allowed.entity_id)
    )`
}
