import { bearerAuth, createFetchTransport } from "@slop-lab/part/model/index.js"
import type { Convenience, Model } from "@slop-lab/part/reference/index.js"
import { createOpenAICompatibleAdapter } from "@slop-lab/part-plugins/providers/openai-compatible/index.js"
import { createOpenAIResponsesAdapter } from "@slop-lab/part-plugins/providers/openai-responses/index.js"
import { z } from "zod"
import type { AgentEnvironment } from "./types.ts"

const ProviderEnvironmentSchema = z.object({
  PART_PROVIDER: z.enum(["chat", "responses"]),
  PART_MODEL: z.string().min(1),
  PART_MODEL_URL: z.url().refine((value) => {
    const endpoint = new URL(value)
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname)
    return (
      (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback)) &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.hash.length === 0
    )
  }),
  PART_API_KEY: z.string().min(1),
})

export type ProviderKind = z.infer<typeof ProviderEnvironmentSchema>["PART_PROVIDER"]

export type ProviderConfiguration = {
  readonly provider: ProviderKind
  readonly model: Convenience.ConfiguredModel
}

function adapterFor(provider: ProviderKind): Model.Adapter {
  switch (provider) {
    case "chat":
      return createOpenAICompatibleAdapter()
    case "responses":
      return createOpenAIResponsesAdapter()
  }
}

export function parseProviderEnvironment(environment: AgentEnvironment): ProviderConfiguration {
  const values = ProviderEnvironmentSchema.parse({
    PART_PROVIDER: environment.PART_PROVIDER,
    PART_MODEL: environment.PART_MODEL,
    PART_MODEL_URL: environment.PART_MODEL_URL,
    PART_API_KEY: environment.PART_API_KEY,
  })
  const endpoint = new URL(values.PART_MODEL_URL)
  const adapter = adapterFor(values.PART_PROVIDER)
  return {
    provider: values.PART_PROVIDER,
    model: {
      profile: {
        id: `afw/${values.PART_PROVIDER}`,
        revision: "1",
        adapterId: adapter.id,
        transportId: "part/fetch",
        authStrategyId: "bearer",
        model: values.PART_MODEL,
        endpoint: endpoint.href,
        defaults: { stream: true },
        capabilities: { revision: "1", entries: [] },
      },
      adapter,
      transport: createFetchTransport({ allowedOrigins: [endpoint.origin] }),
      auth: bearerAuth(() => values.PART_API_KEY),
    },
  }
}
