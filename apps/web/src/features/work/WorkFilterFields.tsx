import type { Bootstrap } from "../../../../../src/contracts/r4/human.ts"
import type { SpaceConfig } from "../../../../../src/contracts/r4/index.ts"
import type { Session } from "../../app/types.ts"
import { Field, SelectField } from "../../components/primitives.tsx"
import { ProjectSelect } from "../projects/ProjectSelect.tsx"
import type { WorkQueryDraft } from "./work-query.ts"

type Props = {
  readonly draft: WorkQueryDraft
  readonly session: Session
  readonly config: SpaceConfig | null
  readonly principals: Bootstrap["principals"]
  readonly onChange: (change: Partial<Omit<WorkQueryDraft, "source">>) => void
  readonly onError: (message: string) => void
}

const categoryOptions = ["backlog", "unstarted", "started", "completed", "canceled"] as const
const sortOptions = [
  "createdAt",
  "updatedAt",
  "title",
  "priority",
  "dueDate",
  "workflowPosition",
] as const
const directionOptions = ["asc", "desc"] as const

export function WorkFilterFields({ draft, session, config, principals, onChange, onError }: Props) {
  return (
    <details className="filter-panel">
      <summary>More filters and sort</summary>
      <div className="filter-grid">
        <ProjectSelect
          session={session}
          label="Project"
          name="work-project"
          value={draft.projectId}
          onChange={(projectId) => onChange({ projectId })}
          emptyLabel="All projects"
          onError={onError}
        />
        <SelectField
          label="Workflow state"
          name="work-state"
          value={draft.workflowStateId}
          onChange={(workflowStateId) => onChange({ workflowStateId })}
          options={[
            { value: "", label: "All states" },
            ...(config?.workflow.states ?? []).map((state) => ({
              value: state.id,
              label: state.name,
            })),
          ]}
        />
        <SelectField
          label="State category"
          name="work-state-category"
          value={draft.stateCategory}
          onChange={(stateCategory) => onChange({ stateCategory })}
          options={[
            { value: "", label: "All categories" },
            ...categoryOptions.map((value) => ({ value, label: value })),
          ]}
        />
        <SelectField
          label="Owner"
          name="work-owner"
          value={draft.accountableOwnerId}
          onChange={(accountableOwnerId) => onChange({ accountableOwnerId })}
          options={[
            { value: "", label: "All owners" },
            ...principals.map((principal) => ({ value: principal.id, label: principal.name })),
          ]}
        />
        <Field
          label="Type"
          name="work-type"
          value={draft.type}
          onChange={(event) => onChange({ type: event.currentTarget.value })}
        />
        <SelectField
          label="Label"
          name="work-label"
          value={draft.labelId}
          onChange={(labelId) => onChange({ labelId })}
          options={[
            { value: "", label: "All labels" },
            ...(config?.labels ?? []).map((label) => ({ value: label.id, label: label.name })),
          ]}
        />
        <Field
          label="Start date from"
          name="work-start-from"
          type="date"
          value={draft.startDateFrom}
          onChange={(event) => onChange({ startDateFrom: event.currentTarget.value })}
        />
        <Field
          label="Start date to"
          name="work-start-to"
          type="date"
          value={draft.startDateTo}
          onChange={(event) => onChange({ startDateTo: event.currentTarget.value })}
        />
        <Field
          label="Due date from"
          name="work-due-from"
          type="date"
          value={draft.dueDateFrom}
          onChange={(event) => onChange({ dueDateFrom: event.currentTarget.value })}
        />
        <Field
          label="Due date to"
          name="work-due-to"
          type="date"
          value={draft.dueDateTo}
          onChange={(event) => onChange({ dueDateTo: event.currentTarget.value })}
        />
        <SelectField
          label="Sort by"
          name="work-sort"
          value={draft.sortField}
          onChange={(value) => onChange({ sortField: parseSortField(value) })}
          options={sortOptions.map((value) => ({ value, label: value }))}
        />
        <SelectField
          label="Direction"
          name="work-sort-direction"
          value={draft.sortDirection}
          onChange={(value) => onChange({ sortDirection: parseSortDirection(value) })}
          options={[
            { value: directionOptions[0], label: "Ascending" },
            { value: directionOptions[1], label: "Descending" },
          ]}
        />
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.includeArchived}
          onChange={(event) => onChange({ includeArchived: event.currentTarget.checked })}
        />
        Include archived work
      </label>
    </details>
  )
}

function parseSortField(value: string): WorkQueryDraft["sortField"] {
  return sortOptions.find((candidate) => candidate === value) ?? "updatedAt"
}

function parseSortDirection(value: string): WorkQueryDraft["sortDirection"] {
  return directionOptions.find((candidate) => candidate === value) ?? "desc"
}
