import { z } from "zod"

export const UtcDateTimeSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => (value instanceof Date ? value : new Date(value)).toISOString())
