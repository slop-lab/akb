import { type FormEvent, useState } from "react"
import type { z } from "zod"
import {
  ExtensionManifestResponseSchema,
  GitHubMappingResponseSchema,
} from "../../../../../src/contracts/automation/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Button, Field } from "../../components/primitives.tsx"
import {
  EntityFeatureMutationSchema,
  featureCommand,
  workspaceFeaturePath,
} from "../feature-api.ts"

type Props = ScreenProps & { readonly onError: (error: unknown) => void }

export function AutomationIntegrations({ session, announce, onError }: Props) {
  const [outcome, setOutcome] = useState("")
  const [busy, setBusy] = useState(false)

  async function execute(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }

  async function direct<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const commandId = crypto.randomUUID()
    return session.api.feature(workspaceFeaturePath(session, "automation", path), schema, {
      method: "POST",
      body: {
        commandId,
        idempotencyKey: `web-${commandId}`,
        baseRevision: null,
        payload,
      },
    })
  }

  async function installGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const result = EntityFeatureMutationSchema.parse(
      await featureCommand(session, "automation", "/github/installations", "POST", null, {
        externalInstallationId: String(data.get("externalInstallationId")),
        repository: String(data.get("repository")),
        webhookSecret: String(data.get("webhookSecret")),
        apiBaseUrl: String(data.get("apiBaseUrl")),
        allowedHosts: String(data.get("allowedHosts"))
          .split(/\s*,\s*/)
          .filter(Boolean),
      }),
    )
    setOutcome(`Installation ${result.result.id} created`)
    announce("GitHub installation created")
  }

  async function mapGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    await direct(
      "/github/mappings",
      {
        installationId: String(data.get("installationId")),
        githubNumber: Number(data.get("githubNumber")),
        entityId: String(data.get("entityId")),
      },
      GitHubMappingResponseSchema,
    )
    setOutcome("GitHub issue mapped")
    announce("GitHub issue mapped")
  }

  async function submitManifest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const result = await direct(
      "/extensions/manifests",
      {
        id: String(data.get("id")),
        version: String(data.get("version")),
        protocolVersion: "1",
        permissions: String(data.get("permissions"))
          .split(/\s*,\s*/)
          .filter(Boolean),
        endpointUrl: String(data.get("endpointUrl")),
        eventSubscriptions: String(data.get("eventSubscriptions"))
          .split(/\s*,\s*/)
          .filter(Boolean),
        commands: String(data.get("commands"))
          .split(/\s*,\s*/)
          .filter(Boolean),
      },
      ExtensionManifestResponseSchema,
    )
    setOutcome(`Manifest ${result.id}@${result.version} submitted`)
    announce("Extension manifest submitted")
  }

  async function approveManifest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const result = EntityFeatureMutationSchema.parse(
      await featureCommand(session, "automation", "/extensions/approvals", "POST", null, {
        manifestId: String(data.get("manifestId")),
        manifestVersion: String(data.get("manifestVersion")),
        approvedPermissions: String(data.get("approvedPermissions"))
          .split(/\s*,\s*/)
          .filter(Boolean),
      }),
    )
    setOutcome(`Approval ${result.result.id} created`)
    announce("Extension approved")
  }

  return (
    <section className="section-stack">
      <div className="panel__header">
        <div>
          <h2>Integrations and extensions</h2>
          <p className="panel__meta">Register bounded external capabilities.</p>
        </div>
        {outcome === "" ? null : <span role="status">{outcome}</span>}
      </div>
      <div className="feature-columns">
        <form
          className="form-stack panel"
          onSubmit={(event) => void execute(() => installGitHub(event))}
        >
          <h3>GitHub installation</h3>
          <Field label="External installation ID" name="externalInstallationId" required />
          <Field label="Repository" name="repository" placeholder="owner/repository" required />
          <Field
            label="Webhook secret"
            name="webhookSecret"
            type="password"
            minLength={32}
            required
          />
          <Field
            label="API base URL"
            name="apiBaseUrl"
            type="url"
            defaultValue="https://api.github.com"
            required
          />
          <Field label="Allowed hosts" name="allowedHosts" defaultValue="api.github.com" required />
          <Button type="submit" busy={busy}>
            Install GitHub
          </Button>
        </form>
        <form
          className="form-stack panel"
          onSubmit={(event) => void execute(() => mapGitHub(event))}
        >
          <h3>Map GitHub issue</h3>
          <Field label="Installation ID" name="installationId" required />
          <Field label="Issue number" name="githubNumber" type="number" min="1" required />
          <Field label="Entity ID" name="entityId" required />
          <Button type="submit" busy={busy}>
            Create mapping
          </Button>
        </form>
      </div>
      <div className="feature-columns">
        <form
          className="form-stack panel"
          onSubmit={(event) => void execute(() => submitManifest(event))}
        >
          <h3>Extension manifest</h3>
          <Field label="Manifest ID" name="id" required />
          <Field label="Version" name="version" placeholder="1.0.0" required />
          <Field label="Endpoint URL" name="endpointUrl" type="url" required />
          <Field label="Permissions" name="permissions" help="Comma-separated" />
          <Field label="Event subscriptions" name="eventSubscriptions" help="Comma-separated" />
          <Field label="Commands" name="commands" help="Comma-separated" />
          <Button type="submit" busy={busy}>
            Submit manifest
          </Button>
        </form>
        <form
          className="form-stack panel"
          onSubmit={(event) => void execute(() => approveManifest(event))}
        >
          <h3>Approve extension</h3>
          <Field label="Manifest ID" name="manifestId" required />
          <Field label="Manifest version" name="manifestVersion" required />
          <Field label="Approved permissions" name="approvedPermissions" help="Comma-separated" />
          <Button type="submit" variant="primary" busy={busy}>
            Approve manifest
          </Button>
        </form>
      </div>
    </section>
  )
}
