import { z } from "zod"

const Text = z.string().trim().min(1).max(50_000)
const OptionalText = z.string().max(50_000).default("")
const Id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^/\\]+$/)
const Base = z.strictObject({ title: z.string().trim().min(1).max(500) })

export const ClaimCandidateSchema = Base.extend({
  type: z.literal("claim"),
  statement: Text,
  status: z.enum(["proposed", "accepted", "disputed", "rejected", "superseded"]),
  confidence: z.number().min(0).max(1),
  validityScope: z.string().max(10_000).default(""),
})
export const DecisionCandidateSchema = Base.extend({
  type: z.literal("decision"),
  decision: Text,
  context: OptionalText,
  alternatives: OptionalText,
  rationale: OptionalText,
  consequences: OptionalText,
  status: z.enum(["proposed", "accepted", "superseded", "reversed"]),
  ownerId: Id,
  reviewDate: z.iso.date().nullable().default(null),
  appliesTo: z.string().max(10_000).default(""),
})
export const EvidenceCandidateSchema = Base.extend({
  type: z.literal("evidence"),
  sourceType: z.enum(["entity", "runtime_artifact", "external"]),
  sourceRef: Id,
  observation: Text,
  capturedAt: z.iso.datetime(),
  capturedBy: Id,
  reliability: z.number().min(0).max(1),
  validity: z.string().max(10_000).default(""),
})
export const QuestionCandidateSchema = Base.extend({
  type: z.literal("question"),
  question: Text,
  status: z.enum(["open", "investigating", "answered", "abandoned"]),
  ownerId: Id,
  delegates: z.array(Id).max(100).default([]),
  acceptedAnswerId: Id.nullable().default(null),
})
export const ExperimentCandidateSchema = Base.extend({
  type: z.literal("experiment"),
  hypothesis: Text,
  method: Text,
  inputs: OptionalText,
  runs: OptionalText,
  results: OptionalText,
  conclusion: OptionalText,
})
export const KnowledgeCandidateSchema = z.discriminatedUnion("type", [
  ClaimCandidateSchema,
  DecisionCandidateSchema,
  EvidenceCandidateSchema,
  QuestionCandidateSchema,
  ExperimentCandidateSchema,
])

const EntitySourceSchema = z.strictObject({
  kind: z.literal("entity"),
  entityId: Id,
  revision: z.number().int().positive(),
  role: z.enum(["supporting", "contradicting", "context"]),
})
const ArtifactSourceSchema = z.strictObject({
  kind: z.literal("runtime_artifact"),
  artifactId: Id,
  role: z.enum(["supporting", "contradicting", "context"]),
})
export const ProposalSourceSchema = z.discriminatedUnion("kind", [
  EntitySourceSchema,
  ArtifactSourceSchema,
])
export const ProposalRelationSchema = z.strictObject({
  entityId: Id,
  revision: z.number().int().positive(),
  type: z.enum(["supports", "contradicts", "answers", "supersedes", "applies_to"]),
})
export const CreateKnowledgeProposalSchema = z
  .strictObject({
    targetId: Id,
    action: z.enum(["knowledge.create", "knowledge.revise"]),
    baseRevision: z.number().int().positive().nullable(),
    candidate: KnowledgeCandidateSchema,
    sources: z.array(ProposalSourceSchema).max(100).default([]),
    relations: z.array(ProposalRelationSchema).max(100).default([]),
    profileId: Id.nullable().default(null),
    profileRevision: z.number().int().positive().nullable().default(null),
    inputRevision: z.number().int().positive().nullable().default(null),
  })
  .superRefine((value, context) => {
    const validBase =
      value.action === "knowledge.create"
        ? value.baseRevision === null
        : value.baseRevision !== null
    if (!validBase)
      context.addIssue({
        code: "custom",
        path: ["baseRevision"],
        message: "base revision does not match action",
      })
    if ((value.profileId === null) !== (value.profileRevision === null)) {
      context.addIssue({
        code: "custom",
        path: ["profileId"],
        message: "profile id and revision must be paired",
      })
    }
  })
export const BUILT_IN_KNOWLEDGE_REVIEW_POLICY = {
  id: "human-review",
  revision: 1,
} as const
export const DecideKnowledgeProposalSchema = z.strictObject({
  decision: z.enum(["accepted", "rejected", "changes_requested"]),
  rationale: z.string().max(20_000).default(""),
  policyId: z.literal(BUILT_IN_KNOWLEDGE_REVIEW_POLICY.id),
  policyRevision: z.literal(BUILT_IN_KNOWLEDGE_REVIEW_POLICY.revision),
})

export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidateSchema>
export type CreateKnowledgeProposal = z.infer<typeof CreateKnowledgeProposalSchema>
export type DecideKnowledgeProposal = z.infer<typeof DecideKnowledgeProposalSchema>
export type ProposalSource = z.infer<typeof ProposalSourceSchema>
export type ProposalRelation = z.infer<typeof ProposalRelationSchema>
