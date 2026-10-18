import { z } from "zod"
import {
  KnowledgeCandidateSchema,
  ProposalRelationSchema,
  ProposalSourceSchema,
} from "./proposals.ts"

export const KnowledgeObjectSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.enum(["active", "archived"]),
  candidate: KnowledgeCandidateSchema,
  acceptedProposalId: z.string(),
  acceptedReviewId: z.string(),
  reviewedBy: z.string(),
  reviewedAt: z.iso.datetime(),
  sources: z.array(ProposalSourceSchema).readonly(),
  relations: z.array(ProposalRelationSchema).readonly(),
})
export const KnowledgeHistoryEntrySchema = z.strictObject({
  revision: z.number().int().positive(),
  schemaVersion: z.literal("knowledge-object.r7.v1"),
  candidate: KnowledgeCandidateSchema,
  acceptedProposalId: z.string(),
  acceptedReviewId: z.string(),
  createdAt: z.iso.datetime(),
})
export const DerivedSummarySchema = z.strictObject({
  id: z.string().uuid(),
  sourceEntityId: z.string(),
  sourceRevision: z.number().int().positive(),
  profileId: z.string(),
  profileRevision: z.number().int().positive(),
  generator: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  staleAt: z.iso.datetime().nullable(),
  fresh: z.boolean(),
})
export type KnowledgeObject = z.infer<typeof KnowledgeObjectSchema>
export type KnowledgeHistoryEntry = z.infer<typeof KnowledgeHistoryEntrySchema>
export type DerivedSummary = z.infer<typeof DerivedSummarySchema>
