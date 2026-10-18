import { z } from "zod"

const boundedId = z.string().trim().min(1).max(200)

export const AgentDefinitionIdSchema = boundedId.brand("AgentDefinitionId")
export const AgentRevisionIdSchema = boundedId.brand("AgentRevisionId")
export const InstallationIdSchema = boundedId.brand("InstallationId")
export const RuntimeEndpointIdSchema = boundedId.brand("RuntimeEndpointId")
export const SessionIdSchema = boundedId.brand("SessionId")
export const RunIdSchema = boundedId.brand("RunId")
export const ArtifactIdSchema = boundedId.brand("ArtifactId")
export const ReceiptIdSchema = z.uuid().brand("ReceiptId")

export type AgentDefinitionId = z.infer<typeof AgentDefinitionIdSchema>
export type AgentRevisionId = z.infer<typeof AgentRevisionIdSchema>
export type InstallationId = z.infer<typeof InstallationIdSchema>
export type RuntimeEndpointId = z.infer<typeof RuntimeEndpointIdSchema>
export type SessionId = z.infer<typeof SessionIdSchema>
export type RunId = z.infer<typeof RunIdSchema>
