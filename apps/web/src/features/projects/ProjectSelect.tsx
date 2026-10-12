import { type FormEvent, useState } from "react"
import type { Session } from "../../app/types.ts"
import { Button, Field, SelectField } from "../../components/primitives.tsx"
import { useProjectPages } from "../../hooks/useProjectPages.ts"

type Props = {
  readonly session: Session
  readonly label: string
  readonly name: string
  readonly value: string
  readonly emptyLabel: string
  readonly onChange: (value: string) => void
  readonly onError: (message: string) => void
}

export function ProjectSelect(props: Props) {
  const [draftSearch, setDraftSearch] = useState("")
  const [search, setSearch] = useState("")
  const { projects, nextCursor, isLoadingMore, loadMore } = useProjectPages({
    session: props.session,
    includeArchived: false,
    search,
    selectedId: props.value,
    onError: props.onError,
  })

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearch(draftSearch)
  }

  return (
    <div className="project-select">
      <form className="inline-form" onSubmit={applySearch}>
        <Field
          label="Search projects"
          name={`${props.name}-search`}
          type="search"
          value={draftSearch}
          onChange={(event) => setDraftSearch(event.currentTarget.value)}
        />
        <Button type="submit">Search</Button>
      </form>
      <SelectField
        label={props.label}
        name={props.name}
        value={props.value}
        onChange={props.onChange}
        options={[
          { value: "", label: props.emptyLabel },
          ...projects.map((project) => ({ value: project.id, label: project.name })),
        ]}
      />
      {nextCursor === null ? null : (
        <Button variant="quiet" busy={isLoadingMore} onClick={() => void loadMore()}>
          Load more projects
        </Button>
      )}
    </div>
  )
}
