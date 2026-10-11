import { z } from "zod"

const semanticId = z.string().trim().min(1).max(200)

export const CommandIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/)
  .brand("CommandId")
export const R4EntityIdSchema = semanticId.brand("R4EntityId")
export const R4WorkspaceIdSchema = semanticId.brand("R4WorkspaceId")
export const R4PrincipalIdSchema = semanticId.brand("R4PrincipalId")
export const R4RevisionSchema = z.number().int().positive().brand("R4Revision")
export const R4TimestampSchema = z.iso.datetime()
export const R4DateSchema = z.iso.date()

export type CommandId = z.infer<typeof CommandIdSchema>
export type R4EntityId = z.infer<typeof R4EntityIdSchema>
export type R4WorkspaceId = z.infer<typeof R4WorkspaceIdSchema>
export type R4PrincipalId = z.infer<typeof R4PrincipalIdSchema>
export type R4Revision = z.infer<typeof R4RevisionSchema>
