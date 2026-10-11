import { DownloadSimple, UploadSimple } from "@phosphor-icons/react"
import { type ChangeEvent, useState } from "react"
import type { ImportValidation } from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, ErrorPanel, SelectField } from "../../components/primitives.tsx"
import { createBrowserUuid } from "../../lib/browser-uuid.ts"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"

type ValidatedFile = {
  readonly name: string
  readonly bytes: Uint8Array
  readonly commandId: string
  readonly validation: ImportValidation
}

export function TransferScreen({ session, announce }: ScreenProps) {
  const [validated, setValidated] = useState<ValidatedFile | null>(null)
  const [status, setStatus] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState("workspace")
  const [includeArchived, setIncludeArchived] = useState(false)

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (file === undefined) return
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose an NDJSON file no larger than 10 MiB.")
      return
    }
    setStatus("Validating exact file bytes")
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const commandId = createBrowserUuid()
      const validation = await session.api.validateImport(bytes, commandId)
      setValidated({ name: file.name, bytes, commandId, validation })
      setStatus("Validation passed")
    } catch (caught) {
      setValidated(null)
      setStatus("")
      setError(caught instanceof Error ? caught.message : "Import validation failed.")
    }
  }

  async function commit() {
    if (validated === null) return
    setStatus("Committing validated records")
    try {
      const result = await session.api.commitImport(
        validated.bytes,
        validated.commandId,
        validated.validation.validationToken,
      )
      setStatus(
        result.replayed
          ? "Identical import replayed safely"
          : `${result.recordCount} records committed`,
      )
      setValidated(null)
      announce("Import completed")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import commit failed.")
      setStatus("")
    }
  }

  async function exportData() {
    setStatus("Preparing NDJSON export")
    setError(null)
    try {
      const scoped =
        scope === "workspace"
          ? {}
          : scope.startsWith("project:")
            ? { projectId: scope.slice(8) }
            : { spaceId: scope.slice(6) }
      const blob = await session.api.exportData({ includeArchived, ...scoped })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${session.bootstrap.workspace.id}-r4-${new Date().toISOString().slice(0, 10)}.ndjson`
      link.click()
      URL.revokeObjectURL(url)
      setStatus("Export downloaded")
      announce("Export downloaded")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.")
      setStatus("")
    }
  }

  const scopeOptions = [
    { value: "workspace", label: "Current Workspace" },
    ...session.bootstrap.spaces.map((space) => ({
      value: `space:${space.id}`,
      label: `Space: ${space.name}`,
    })),
  ]
  return (
    <ScreenLayout
      eyebrow="Workspace data"
      title="Import and export"
      description="Canonical NDJSON v1 transfer with server-owned authorization and limits."
    >
      {error === null ? null : <ErrorPanel message={error} />}
      {status.length === 0 ? null : (
        <div className="status-panel" role="status">
          {status}
        </div>
      )}
      <div className="transfer-grid">
        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Inbound</p>
              <h2>Import NDJSON</h2>
            </div>
            <UploadSimple size={20} />
          </div>
          <p>
            Select a local NDJSON v1 file. Maximum 10 MiB and 10,000 records. Credentials, grants,
            memberships, and tokens are never transferred.
          </p>
          <label className="file-picker">
            <span>Choose file</span>
            <input
              type="file"
              accept=".ndjson,application/x-ndjson"
              onChange={(event) => void choose(event)}
            />
          </label>
          {validated === null ? null : (
            <div className="import-summary">
              <Badge tone="success">Validated</Badge>
              <strong>{validated.name}</strong>
              <span>{validated.validation.recordCount} records</span>
              <span className="mono">
                Expires {new Date(validated.validation.expiresAt).toLocaleString()}
              </span>
              {validated.validation.warnings?.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <Button variant="primary" onClick={() => void commit()}>
                Commit exact bytes
              </Button>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel__header">
            <div>
              <p className="eyebrow">Outbound</p>
              <h2>Export NDJSON</h2>
            </div>
            <DownloadSimple size={20} />
          </div>
          <p>
            Exports server-authorized R4 records in dependency order. Maximum 100,000 records and
            100 MiB.
          </p>
          <SelectField
            label="Scope"
            name="export-scope"
            value={scope}
            onChange={setScope}
            options={scopeOptions}
          />
          <label>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.currentTarget.checked)}
            />{" "}
            Include archived records
          </label>
          <Button variant="primary" onClick={() => void exportData()}>
            Export
          </Button>
        </section>
      </div>
    </ScreenLayout>
  )
}
