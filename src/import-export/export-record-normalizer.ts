import { z } from "zod"

const DatabaseRecordSchema = z.looseObject({
  kind: z.enum([
    "space",
    "workflow_state",
    "project",
    "label",
    "work_item",
    "relation",
    "comment",
    "saved_view",
  ]),
})
const DatabaseTimestampSchema = z.union([
  z.null(),
  z.iso
    .datetime({ offset: true })
    .refine((value) => Number.isFinite(Date.parse(value)))
    .transform((value) => new Date(value).toISOString()),
])

export function normalizeExportRecord(value: unknown): unknown {
  const record = DatabaseRecordSchema.parse(value)
  switch (record.kind) {
    case "space":
    case "workflow_state":
      return record
    case "project":
    case "work_item":
      return {
        ...record,
        completedAt: canonicalTimestamp(record, "completedAt"),
        archivedAt: canonicalTimestamp(record, "archivedAt"),
      }
    case "label":
    case "relation":
    case "comment":
    case "saved_view":
      return { ...record, archivedAt: canonicalTimestamp(record, "archivedAt") }
  }
}

function canonicalTimestamp(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  return DatabaseTimestampSchema.parse(record[field])
}
