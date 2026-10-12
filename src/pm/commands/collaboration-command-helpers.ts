import { z } from "zod"
import { RelationCreatePayloadSchema } from "../../contracts/r4/command-payloads.ts"
import type { CommandCall } from "./types.ts"

const ImportRelationCreatePayloadSchema = RelationCreatePayloadSchema.extend({
  archivedAt: z.iso.datetime().nullable(),
})

export function parseRelationCreate(call: CommandCall) {
  if (call.route === "import:relation") {
    const imported = ImportRelationCreatePayloadSchema.parse(call.payload)
    return { archivedAt: imported.archivedAt, payload: imported }
  }
  return { archivedAt: null, payload: RelationCreatePayloadSchema.parse(call.payload) }
}
