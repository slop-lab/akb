import { useCallback, useEffect, useState } from "react"
import type { SpaceConfig } from "../../../../../src/contracts/r4/index.ts"
import type { ScreenProps } from "../../app/types.ts"
import { Badge, Button, ErrorPanel, Field, SelectField } from "../../components/primitives.tsx"
import { ScreenLayout } from "../../components/ScreenLayout.tsx"
import { LabelRow, NewStateForm, WorkflowStateRow } from "./ConfigRows.tsx"
import { CreateSpaceForm, SpaceDetailsForm } from "./SpaceForms.tsx"

export function SpacesScreen({ session, announce }: ScreenProps) {
  const [selectedId, setSelectedId] = useState(
    session.bootstrap.currentSpaceId ?? session.bootstrap.spaces[0]?.id ?? "",
  )
  const [config, setConfig] = useState<SpaceConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState("")
  const [newLabelColor, setNewLabelColor] = useState("#3c67a5")
  const [grantPrincipal, setGrantPrincipal] = useState(session.bootstrap.principal.id)
  const [grantPermissions, setGrantPermissions] = useState("work.read,work.create,work.update")
  const canManage = session.bootstrap.permissions.includes("space.manage")

  const load = useCallback(async () => {
    if (selectedId.length === 0) return
    setError(null)
    try {
      setConfig(await session.api.spaceConfig(selectedId))
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Space configuration could not be loaded.",
      )
    }
  }, [selectedId, session.api])
  useEffect(() => {
    void load()
  }, [load])

  async function createLabel() {
    if (config === null) return
    try {
      await session.api.command({
        method: "post",
        path: `/spaces/${encodeURIComponent(config.space.id)}/labels`,
        baseRevision: null,
        payload: { name: newLabel, color: newLabelColor },
      })
      setNewLabel("")
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Label could not be created.")
    }
  }

  async function grantAccess() {
    if (config === null) return
    try {
      await session.api.command({
        method: "put",
        path: `/spaces/${encodeURIComponent(config.space.id)}/access`,
        baseRevision: config.space.revision,
        payload: {
          principalId: grantPrincipal,
          permissions: grantPermissions
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        },
      })
      announce("Space access updated")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Space access could not be updated.")
    }
  }

  const feedback = { onDone: () => void load(), onError: setError }
  return (
    <ScreenLayout
      eyebrow="Administration"
      title="Spaces"
      description="Visibility, workflow, labels, and explicit private access."
    >
      {error === null ? null : (
        <ErrorPanel message={error} actions={<Button onClick={() => void load()}>Reload</Button>} />
      )}
      <div className="toolbar">
        <SelectField
          label="Space"
          name="space-picker"
          value={selectedId}
          onChange={setSelectedId}
          options={session.bootstrap.spaces.map((space) => ({
            value: space.id,
            label: `${space.key} · ${space.name}`,
          }))}
        />
        {canManage ? <Badge tone="success">Manage access</Badge> : <Badge>Read only</Badge>}
      </div>
      {config === null ? null : (
        <>
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="mono">{config.space.key}</p>
                <h2>{config.space.name}</h2>
              </div>
              <Badge>{config.space.visibility}</Badge>
            </div>
            <p>{config.space.description || "No description"}</p>
            <p className="panel__meta">Lead: {config.space.lead?.name ?? "Not set"}</p>
            <SpaceDetailsForm
              key={config.space.id}
              session={session}
              space={config.space}
              canManage={canManage}
              onError={setError}
              onSaved={() => {
                announce("Space details updated")
                void load()
              }}
            />
          </section>
          <section className="section-stack">
            <div>
              <h2>Workflow</h2>
              <p>
                {config.workflow.name} · {config.workflow.states.length} of 20 active states
              </p>
            </div>
            {config.workflow.states.map((state) => (
              <WorkflowStateRow
                key={state.id}
                session={session}
                spaceId={config.space.id}
                state={state}
                canManage={canManage}
                feedback={feedback}
              />
            ))}
            <NewStateForm
              session={session}
              config={config}
              canManage={canManage}
              feedback={feedback}
            />
          </section>
          <section className="section-stack">
            <div>
              <h2>Labels</h2>
              <p>Small swatches preserve label identity without flooding rows.</p>
            </div>
            {config.labels.map((label) => (
              <LabelRow
                key={label.id}
                session={session}
                label={label}
                canManage={canManage}
                feedback={feedback}
              />
            ))}
            <div className="inline-form">
              <Field
                label="New label"
                name="new-label"
                value={newLabel}
                onChange={(event) => setNewLabel(event.currentTarget.value)}
                disabled={!canManage}
              />
              <Field
                label="Color"
                name="new-label-color"
                value={newLabelColor}
                onChange={(event) => setNewLabelColor(event.currentTarget.value)}
                disabled={!canManage}
              />
              <Button
                variant="primary"
                disabled={!canManage || newLabel.length === 0}
                onClick={() => void createLabel()}
              >
                Add label
              </Button>
            </div>
          </section>
          <section className="section-stack">
            <div>
              <h2>Access</h2>
              <p>Private Spaces require explicit grants. The server remains final authority.</p>
            </div>
            <div className="inline-form">
              <SelectField
                label="Principal"
                name="grant-principal"
                value={grantPrincipal}
                onChange={setGrantPrincipal}
                options={session.bootstrap.principals.map((principal) => ({
                  value: principal.id,
                  label: principal.name,
                }))}
                disabled={!canManage}
              />
              <Field
                label="Permissions"
                name="grant-permissions"
                value={grantPermissions}
                onChange={(event) => setGrantPermissions(event.currentTarget.value)}
                disabled={!canManage}
              />
              <Button variant="primary" disabled={!canManage} onClick={() => void grantAccess()}>
                Update access
              </Button>
            </div>
          </section>
        </>
      )}
      <section className="section-stack">
        <h2>Create Space</h2>
        <CreateSpaceForm
          session={session}
          canManage={canManage}
          onError={setError}
          onSaved={(id) => {
            announce("Space created")
            setSelectedId(id)
          }}
        />
      </section>
    </ScreenLayout>
  )
}
