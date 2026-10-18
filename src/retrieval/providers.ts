export type RetrievalProvider = {
  readonly kind: string
  readonly readPermission: string
  readonly titleFields: readonly string[]
  readonly summaryFields: readonly string[]
}

const DEFAULT_PROVIDERS = [
  {
    kind: "work_item",
    readPermission: "work.read",
    titleFields: ["title"],
    summaryFields: ["state", "priority", "description"],
  },
  {
    kind: "project",
    readPermission: "project.read",
    titleFields: ["name", "title"],
    summaryFields: ["summary", "description", "state"],
  },
  {
    kind: "space",
    readPermission: "space.read",
    titleFields: ["name"],
    summaryFields: ["visibility"],
  },
  { kind: "workflow", readPermission: "space.read", titleFields: ["name"], summaryFields: [] },
  {
    kind: "workflow_state",
    readPermission: "space.read",
    titleFields: ["name"],
    summaryFields: ["category"],
  },
  { kind: "label", readPermission: "space.read", titleFields: ["name"], summaryFields: ["color"] },
  {
    kind: "saved_view",
    readPermission: "view.read",
    titleFields: ["name"],
    summaryFields: ["scope"],
  },
  { kind: "comment", readPermission: "work.read", titleFields: ["body"], summaryFields: [] },
  { kind: "thread", readPermission: "work.read", titleFields: ["id"], summaryFields: [] },
  { kind: "relation", readPermission: "work.read", titleFields: ["type", "id"], summaryFields: [] },
] as const satisfies readonly RetrievalProvider[]

export class RetrievalProviderRegistry {
  readonly #providers: ReadonlyMap<string, RetrievalProvider>

  constructor(additional: readonly RetrievalProvider[] = []) {
    this.#providers = new Map(
      [...DEFAULT_PROVIDERS, ...additional].map((provider) => [provider.kind, provider]),
    )
  }

  get(kind: string): RetrievalProvider | undefined {
    return this.#providers.get(kind)
  }

  resolve(kinds: readonly string[]): readonly RetrievalProvider[] {
    return kinds.flatMap((kind) => {
      const provider = this.get(kind)
      return provider === undefined ? [] : [provider]
    })
  }
}
