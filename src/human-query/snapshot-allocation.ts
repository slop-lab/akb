import type { TransactionSql } from "postgres"

export class QueryBudgetExceededError extends Error {
  override readonly name = "QueryBudgetExceededError"
  constructor() {
    super("query_budget_exceeded")
  }
}

export async function allocateQuerySnapshot<T>(
  transaction: TransactionSql,
  workspaceId: string,
  allocate: () => Promise<T>,
): Promise<T> {
  await transaction`select pg_advisory_xact_lock(
    hashtextextended('human-query-snapshot-budget:' || ${workspaceId},0))`
  await transaction`delete from human_query_snapshots where id in
    (select id from human_query_snapshots where workspace_id=${workspaceId}
      and expires_at<=clock_timestamp() order by expires_at limit 100)`
  try {
    return await allocate()
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "P0001" &&
      (error.message === "principal has at most eight active snapshots" ||
        error.message === "workspace snapshot row budget exceeded")
    ) {
      throw new QueryBudgetExceededError()
    }
    throw error
  }
}
