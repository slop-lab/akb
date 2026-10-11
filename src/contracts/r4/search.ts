import { z } from "zod"

export const SEARCH_KINDS = ["project", "work_item", "comment"] as const

const canonicalText = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((value) => value.replace(/\s+/gu, " "))

const canonicalKinds = z
  .array(z.enum(SEARCH_KINDS))
  .min(1)
  .max(3)
  .transform((values) =>
    Object.freeze(
      [...new Set(values)].sort(
        (left, right) => SEARCH_KINDS.indexOf(left) - SEARCH_KINDS.indexOf(right),
      ),
    ),
  )

export const SearchRequestPagedSchema = z.strictObject({
  text: canonicalText,
  kinds: canonicalKinds,
  limit: z.number().int().min(1).max(100),
  cursor: z.string().min(1).nullable().default(null),
})

export const SearchResultSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(SEARCH_KINDS),
  title: z.string(),
  sourceRevision: z.number().int().positive(),
})

export const SearchPageSchema = z.strictObject({
  snapshot: z.strictObject({ id: z.string().uuid(), expiresAt: z.iso.datetime() }),
  results: z.array(SearchResultSchema).readonly(),
  matched: z.number().int().min(0).max(100_000),
  nextCursor: z.string().nullable(),
})

export type SearchKind = (typeof SEARCH_KINDS)[number]
export type SearchRequestPaged = z.infer<typeof SearchRequestPagedSchema>
export type SearchResult = z.infer<typeof SearchResultSchema>
export type SearchPage = z.infer<typeof SearchPageSchema>
