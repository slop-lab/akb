import type { Sql } from "postgres"
import {
  CreateKnowledgeProposalSchema,
  DecideKnowledgeProposalSchema,
} from "../../contracts/knowledge/index.ts"
import { KnowledgeCommandService } from "../../knowledge/command-service.ts"
import { createFeatureCommandRouter, featureCommandRoute } from "../feature-command-router.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"
import { createKnowledgeReadRoute } from "./read-routes.ts"

const COMMAND_ROUTES = [
  featureCommandRoute({
    method: "POST",
    pattern: /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/proposals$/,
    action: "knowledge.proposal.create",
    payload: CreateKnowledgeProposalSchema,
    create: true,
  }),
  featureCommandRoute({
    method: "POST",
    pattern: /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/proposals\/([^/]+)\/reviews$/,
    action: "knowledge.review.decide",
    payload: DecideKnowledgeProposalSchema,
    create: false,
    resourceCapture: 2,
  }),
] as const

export function createKnowledgeRoutes(sql: Sql): WorkspaceAuthenticatedRoute[] {
  return [
    createFeatureCommandRouter(sql, COMMAND_ROUTES, new KnowledgeCommandService(sql)),
    createKnowledgeReadRoute(sql),
  ]
}
