import type { SearchPage, SearchRequestPaged } from "../contracts/r4/search.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

export interface R4SearchQuery {
  search(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    request: SearchRequestPaged,
  ): Promise<SearchPage>
}
