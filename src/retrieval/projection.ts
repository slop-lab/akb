import type { RetrievalProjection } from "../contracts/runtime/index.ts"
import type { RetrievalProvider } from "./providers.ts"

type EntitySource = {
  readonly id: string
  readonly kind: string
  readonly revision: number
  readonly lifecycle: string
  readonly snapshot: Readonly<Record<string, unknown>>
}

export function projectEntity(
  source: EntitySource,
  provider: RetrievalProvider,
  projection: RetrievalProjection,
): Readonly<Record<string, unknown>> {
  const title = firstString(source.snapshot, provider.titleFields) ?? source.id
  const reference = {
    id: source.id,
    kind: source.kind,
    title,
    revision: source.revision,
    state: source.lifecycle,
  }
  switch (projection) {
    case "ref":
      return reference
    case "card":
      return {
        ...reference,
        summary: selectFields(source.snapshot, provider.summaryFields),
        freshness: { sourceRevision: source.revision },
        selectors: [{ projection: "detail", entityId: source.id, revision: source.revision }],
      }
    case "detail":
      return {
        ...reference,
        fields: source.snapshot,
        provenance: { entityId: source.id, sourceRevision: source.revision },
        selectors: [{ projection: "raw", entityId: source.id, revision: source.revision }],
      }
    case "raw":
      return { ...reference, canonical: source.snapshot, sourceRevision: source.revision }
    default:
      return assertNever(projection)
  }
}

export function estimatedTokens(value: Readonly<Record<string, unknown>>): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4))
}

function firstString(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const candidate = value[field]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

function selectFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    fields.flatMap((field) => (field in value ? [[field, value[field]]] : [])),
  )
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported projection: ${String(value)}`)
}
